import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WorkflowError } from "./errors.js";
import { OUTPUT_LIMIT } from "./process.js";

function trimLine(value) {
  return value.trim();
}

function parseNullSeparatedRecords(output, parseRecord) {
  const values = output.split("\0");
  const records = [];
  let current = null;

  for (const value of values) {
    if (!value) {
      if (current) {
        records.push(current);
        current = null;
      }
      continue;
    }

    current ??= {};
    parseRecord(current, value);
  }

  if (current) records.push(current);
  return records;
}

function parseWorktreeList(output) {
  return parseNullSeparatedRecords(output, (record, value) => {
    if (value === "bare") {
      record.bare = true;
      return;
    }
    if (value === "detached") {
      record.detached = true;
      return;
    }
    if (value.startsWith("locked")) {
      record.locked = value.slice("locked".length).trim() || true;
      return;
    }
    if (value.startsWith("prunable")) {
      record.prunable = value.slice("prunable".length).trim() || true;
      return;
    }

    const separator = value.indexOf(" ");
    const key = separator === -1 ? value : value.slice(0, separator);
    const data = separator === -1 ? "" : value.slice(separator + 1);

    if (key === "worktree") record.path = data;
    if (key === "HEAD") record.head = data;
    if (key === "branch") record.branch = data;
  });
}

function parseStatus(output) {
  const values = output.split("\0").filter(Boolean);
  const entries = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const x = value[0] ?? " ";
    const y = value[1] ?? " ";
    const firstPath = value.slice(3);

    if (x === "R" || x === "C") {
      const fromPath = values[index + 1] ?? firstPath;
      entries.push({ x, y, path: firstPath, fromPath });
      index += 1;
      continue;
    }

    entries.push({ x, y, path: firstPath });
  }

  return entries;
}

// sha1 (40) or sha256 (64) hex. An answer that is not an object id is not an answer. Used both
// for `merge-tree`'s tree and for `resolveRef`'s commit -- one shape, one constant.
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// The one merge argv, written once. Both the approval digest and the child process read it from
// here, so the string an operator approves cannot drift from the string that runs.
function mergeArgvFor(source) {
  return ["git", "merge", "--no-ff", "--no-edit", source];
}

// `git merge-tree --write-tree --name-only -z <base> <source>` (measured on git 2.43) writes
// the merged tree OID first, then one field per conflicted path, then an EMPTY field, then
// git's informational records. Only the OID and the paths are contractual enough to depend on;
// the informational section's shape is volatile and nothing here needs it.
function parseMergeTree(output) {
  // Never String(): String(undefined) is the truthy "undefined", which would pass for a tree in
  // the one function whose entire mandate is to fail closed.
  const text = typeof output === "string" ? output : "";
  const fields = text.split("\0");
  const tree = trimLine(fields[0] ?? "");
  const conflicts = [];
  let terminatorIndex = -1;

  for (let index = 1; index < fields.length; index += 1) {
    if (fields[index] === "") {
      terminatorIndex = index;
      break;
    }
    conflicts.push(fields[index]);
  }

  // process.js caps a captured stream at exactly OUTPUT_LIMIT characters, and that cut can land in
  // one of two places. If it lands mid-path, the last collected field is half a path and there is
  // no empty field at all -- that is the case below, and dropping the fragment is the fix.
  if (terminatorIndex < 0) conflicts.pop();

  // But if the cut lands exactly on the NUL that terminates a path, `split("\0")` produces a
  // trailing "" that is INDISTINGUISHABLE from git's real end-of-paths marker -- so this function
  // used to report a 1,196-path prefix of a 1,696-path conflict list as COMPLETE, with no
  // `truncated` flag, and the digest then bound that prefix as the whole truth. That is precisely
  // the "a shortened list must never read as complete" property the entire conflictsTruncated
  // chain exists to guarantee. (Measured repro: OID(40) + NUL + 1195 nine-character paths + one
  // eight-character path = exactly 12,000 characters.)
  //
  // The length of the captured stream is what actually settles it: at or above the cap, the stream
  // was cut, whatever the last field happens to look like. An empty field with data AFTER it is
  // still a genuine terminator even in a capped stream -- that is the ordinary clean-merge shape,
  // where the marker arrives immediately after the tree OID and git's informational section is
  // what got cut -- so capping alone must not turn a clean merge into an unknown one.
  const capped = text.length >= OUTPUT_LIMIT;
  const terminated = terminatorIndex >= 0 && (terminatorIndex < fields.length - 1 || !capped);

  return { tree: OBJECT_ID.test(tree) ? tree : "", conflicts, complete: terminated };
}

// Is this checkout sitting inside an unfinished merge? Deliberately NOT
// `rev-parse --verify --quiet MERGE_HEAD`, which cannot answer the question: measured on git 2.43,
// an ABSENT MERGE_HEAD, a corrupt one, and one this process cannot read all exit 1 with empty
// stderr -- and all three print the identical `fatal: Needed a single revision` when --quiet is
// dropped. So an exit-code probe reports "not merging" for a checkout whose merge state it simply
// could not read, which is the opposite of what this adapter promises.
//
// Reading the file is what distinguishes them, and ENOENT is the only answer that PROVES "not
// merging". Everything else -- unreadable, permission denied, contents that are not an object id
// -- is `null`, "cannot say", which callers must treat as a conflict. The path comes from git
// rather than being assembled here because a linked worktree's `.git` is a file, not a directory,
// and its MERGE_HEAD lives under the worktree's own admin directory. One git call, same as the
// probe it replaces.
async function readMergeState({ runner, fs, cwd }) {
  let path;
  try {
    const result = await runner.run("git", ["rev-parse", "--git-path", "MERGE_HEAD"], { cwd });
    path = trimLine(result.stdout);
  } catch {
    return null;
  }
  if (!path) return null;

  let contents;
  try {
    contents = await fs.readFile(isAbsolute(path) ? path : resolve(cwd, path), "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? false : null;
  }
  // An octopus merge records one parent per line; the first is enough to prove a merge is running.
  return OBJECT_ID.test(trimLine(String(contents).split("\n")[0] ?? "")) ? true : null;
}

// `git log -1 --format=%cI` emits a strict ISO-8601 committer date. Validated rather than trusted
// for the same reason OBJECT_ID is: a value that is not a timestamp is not an answer, and the one
// caller compares it against verification evidence to decide whether that evidence is stale.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// `rev-parse --abbrev-ref HEAD` answers the literal string "HEAD" on a detached HEAD, which is
// not a branch name and must never be compared against one.
function normalizeHeadBranch(value) {
  if (!value || value === "HEAD") return null;
  return value;
}

function reasonFrom(error) {
  return String(error?.message ?? error).slice(0, 256);
}

// A captured stream is a string in every ordinary path, but `previewMerge` must survive a runner
// that answers without one — it is the function that may never throw.
function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fail(category, message, details, exitCode) {
  throw new WorkflowError(category, message, { details, exitCode });
}

function failGit(message, details) {
  fail("GIT", message, details, 12);
}

function sortStatusEntries(left, right) {
  return `${left.path}\0${left.fromPath ?? ""}\0${left.x}${left.y}`
    .localeCompare(`${right.path}\0${right.fromPath ?? ""}\0${right.x}${right.y}`);
}

function assertSafeGitPath(rootPath, path) {
  if (typeof path !== "string" || !path) {
    failGit("Unsafe Git status path");
  }
  if (path.includes("\0") || path.includes("\\") || isAbsolute(path)) {
    failGit("Unsafe Git status path");
  }

  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    failGit("Unsafe Git status path traversal");
  }

  const resolvedPath = resolve(rootPath, path);
  const child = relative(rootPath, resolvedPath);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    failGit("Git status path escapes the worktree");
  }
  return resolvedPath;
}

function fileType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isBlockDevice()) return "block-device";
  return "other";
}

async function pathMetadata(fs, path) {
  try {
    const stats = await fs.lstat(path);
    return {
      exists: true,
      type: fileType(stats),
      size: stats.size,
      mode: stats.mode & 0o7777,
      mtimeMs: Math.round(stats.mtimeMs),
      ctimeMs: Math.round(stats.ctimeMs),
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { exists: false };
    }
    failGit("Unable to read Git status metadata", { code: error?.code ?? "FS_ERROR" });
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function digestFor(value) {
  const hash = createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
  return `sha256:${hash}`;
}

export function createGitAdapter({ runner, fs = defaultFs, env = process.env }) {
  return {
    async inspectRepository({ cwd }) {
      const root = await runner.run("git", ["rev-parse", "--show-toplevel"], { cwd });
      const commonDir = await runner.run("git", ["rev-parse", "--git-common-dir"], { cwd });
      const rootPath = trimLine(root.stdout);
      const rawCommonDir = trimLine(commonDir.stdout);
      const commonDirPath = isAbsolute(rawCommonDir)
        ? rawCommonDir
        : resolve(cwd, rawCommonDir);

      return {
        kind: commonDirPath === join(rootPath, ".git") ? "checkout" : "linked-worktree",
        rootPath,
        commonDirPath,
      };
    },

    async listWorktrees({ cwd }) {
      const result = await runner.run("git", ["worktree", "list", "--porcelain", "-z"], { cwd });
      return parseWorktreeList(result.stdout);
    },

    async refExists({ cwd, ref, kind = "commit" }) {
      if (kind === "branch") {
        const result = await runner.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`], {
          cwd,
          allowFailure: true,
        });
        return result.code === 0;
      }

      const result = await runner.run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd,
        allowFailure: true,
      });
      return result.code === 0;
    },

    async status({ cwd }) {
      const result = await runner.run("git", ["status", "--porcelain=v1", "-z"], { cwd });
      const entries = parseStatus(result.stdout);
      return {
        dirty: entries.length > 0,
        entries,
      };
    },

    async fingerprint({ cwd }) {
      const root = await runner.run("git", ["rev-parse", "--show-toplevel"], { cwd });
      const headResult = await runner.run("git", ["rev-parse", "HEAD"], { cwd });
      const branchResult = await runner.run("git", ["branch", "--show-current"], { cwd });
      const statusResult = await runner.run("git", ["status", "--porcelain=v1", "-z"], { cwd });
      const rootPath = trimLine(root.stdout);
      const head = trimLine(headResult.stdout);
      const branch = trimLine(branchResult.stdout) || null;
      const statusEntries = parseStatus(statusResult.stdout).sort(sortStatusEntries);
      const entries = [];

      for (const entry of statusEntries) {
        const normalized = {
          x: entry.x,
          y: entry.y,
          path: entry.path,
          metadata: await pathMetadata(fs, assertSafeGitPath(rootPath, entry.path)),
        };
        if (entry.fromPath !== undefined) {
          normalized.fromPath = entry.fromPath;
          normalized.fromMetadata = await pathMetadata(fs, assertSafeGitPath(rootPath, entry.fromPath));
        }
        entries.push(normalized);
      }

      const fingerprint = {
        head,
        branch,
        dirty: entries.length > 0,
        entries,
      };

      return {
        ...fingerprint,
        digest: digestFor(fingerprint),
      };
    },

    async createWorktree({ cwd, path, branch, base, reconciliation }) {
      if (reconciliation?.status !== "missing") {
        fail("CONFLICT", "createWorktree requires a missing reconciliation result", {
          cwd,
          path,
          branch,
          base,
          reconciliation,
        }, 11);
      }

      const branchExists = await this.refExists({ cwd, ref: branch, kind: "branch" });
      if (branchExists) {
        await runner.run("git", ["worktree", "add", path, branch], { cwd });
        return { path, branch, createdBranch: false };
      }

      const baseExists = await this.refExists({ cwd, ref: base, kind: "commit" });
      if (!baseExists) {
        fail("PREFLIGHT", `Base ref ${base} does not exist`, { cwd, path, branch, base }, 10);
      }

      await runner.run("git", ["worktree", "add", "-b", branch, path, base], { cwd });
      return { path, branch, createdBranch: true };
    },

    // Where the work actually is. Read from the checkout, never derived from a run record: a
    // recorded branch is a launch-time intention and two of the eight real runs on this machine
    // name a ref that no longer exists.
    async resolveHead({ cwd }) {
      const branchResult = await runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
      const shaResult = await runner.run("git", ["rev-parse", "HEAD"], { cwd });

      return {
        branch: normalizeHeadBranch(trimLine(branchResult.stdout)),
        sha: trimLine(shaResult.stdout),
      };
    },

    // Is this checkout safe to merge into right now? `dirty: null` means the status could not be
    // read; the caller must treat that as a conflict and never as clean — same direction as
    // reconcile.js's `safeStatus`, applied to a heavier operation.
    //
    // `merging` is a SEPARATE fact from `dirty`, and it exists because "dirty" alone was
    // under-specified in exactly the case it matters most. Found running the real CLI (roadmap item
    // 2.4, task 3, step 5): a `git merge` that fails at commit time — a rejecting
    // `pre-merge-commit` hook, and equally a real conflict `merge-tree` did not predict — leaves
    // the base checkout mid-merge, with MERGE_HEAD present and the merged content staged. The next
    // preview correctly refused, but described that checkout only as "has 1 uncommitted path(s)",
    // whose natural reading is `git add`/`git stash` — the wrong move. The right one is
    // `git merge --abort`, and a caller cannot say so without being able to tell the two states
    // apart. `true`/`false`/`null` for unknown, never throwing: an unanswerable probe degrades
    // to "cannot say" rather than to "not merging" — see readMergeState for why that required
    // reading the file rather than asking `rev-parse`.
    async checkoutState({ cwd }) {
      const branchResult = await runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
      const branch = normalizeHeadBranch(trimLine(branchResult.stdout));

      const merging = await readMergeState({ runner, fs, cwd });

      try {
        const statusResult = await runner.run("git", ["status", "--porcelain=v1", "-z"], { cwd });
        const entries = parseStatus(statusResult.stdout);
        return { branch, dirty: entries.length > 0, entries, merging };
      } catch (error) {
        return { branch, dirty: null, entries: [], merging, statusError: reasonFrom(error) };
      }
    },

    // What a ref name resolves to IN THIS CHECKOUT's own ref namespace. `refExists` answers only
    // whether an OBJECT is present, which is a different question: `git merge <branch>` resolves
    // the NAME here, so a caller that previewed a sha has to prove the name it is about to hand
    // git resolves to that same sha. Never throws; an absent, ambiguous, or non-commit ref
    // answers null, which the caller must treat as a refusal rather than as a match.
    async resolveRef({ cwd, ref, timeoutMs }) {
      let result;
      try {
        result = await runner.run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, timeoutMs, allowFailure: true });
      } catch {
        return null;
      }
      if (result.code !== 0) return null;
      const value = trimText(result.stdout);
      return OBJECT_ID.test(value) ? value : null;
    },

    // When a commit came to exist, so a caller can say whether verification evidence predates the
    // work it claims to cover. Read-only and never throws: an unreadable, missing, or unparseable
    // date answers `null`, which the caller must report as "unknown" rather than as "not stale" --
    // the same fail-closed direction as `checkoutState`'s `dirty: null`.
    async commitTimestamp({ cwd, ref, timeoutMs }) {
      let result;
      try {
        result = await runner.run("git", ["log", "-1", "--format=%cI", ref], { cwd, timeoutMs, allowFailure: true });
      } catch {
        return null;
      }
      if (result.code !== 0) return null;
      const value = trimText(result.stdout);
      return ISO_TIMESTAMP.test(value) ? value : null;
    },

    // The non-mutating conflict oracle: real merge machinery, no ref, no index, no working tree.
    // Never throws — the caller is gathering evidence, and "unknown" is the fail-closed answer.
    // Bounded like the writer is: this read runs against every repository before anything
    // executes, so it is the one that can hang a preview.
    async previewMerge({ cwd, base, source, timeoutMs }) {
      const args = ["merge-tree", "--write-tree", "--name-only", "-z", base, source];
      let result;

      try {
        result = await runner.run("git", args, { cwd, timeoutMs, allowFailure: true });
      } catch (error) {
        return {
          status: "unknown",
          conflicts: [],
          reason: `git merge-tree could not run: ${reasonFrom(error)}`,
        };
      }

      const { tree, conflicts, complete } = parseMergeTree(result.stdout);

      if (tree && result.code === 0 && complete) {
        return { status: "clean", tree, conflicts: [] };
      }
      if (tree && result.code === 1) {
        // The status is known — this merge conflicts. Only the list may be short, and saying
        // "unknown" here would throw away a fact the operator needs.
        if (!complete) {
          return {
            status: "conflicted",
            tree,
            conflicts,
            truncated: true,
            reason: `git merge-tree output exceeded the ${OUTPUT_LIMIT}-character capture limit; ${conflicts.length} conflicted paths shown, the rest are not listed`,
          };
        }
        return { status: "conflicted", tree, conflicts };
      }

      // Measured on git 2.43: a source ref git cannot merge exits 1 with EMPTY stdout, which is
      // indistinguishable from a conflict by exit code alone. No tree means no prediction.
      const detail = trimText(result.stderr) || trimText(result.stdout);
      const missingTree = tree ? "" : " without producing a merge tree";
      return {
        status: "unknown",
        conflicts: [],
        reason: `git merge-tree exited with code ${result.code}${missingTree}${detail ? `: ${detail}` : ""}`.slice(0, 512),
      };
    },

    // The argv an operator approves, available without running anything. Task 2 puts this in the
    // approval digest; `mergeBranch` executes this same expression.
    mergeArgv({ source }) {
      return mergeArgvFor(source);
    },

    // The one writer. `--no-ff` so the integration is always its own revertible commit and the
    // preview's prediction cannot depend on ancestry at execution time; `--no-edit` so git never
    // opens an editor there is no terminal for; `GIT_TERMINAL_PROMPT=0` so a credential prompt
    // cannot hang it. `argv` is reported from the same array that runs — it is what the approval
    // digest approves, so the two can never drift.
    async mergeBranch({ cwd, source, timeoutMs }) {
      const argv = this.mergeArgv({ source });
      const [command, ...args] = argv;

      try {
        const result = await runner.run(command, args, {
          cwd,
          env: { ...env, GIT_TERMINAL_PROMPT: "0" },
          timeoutMs,
          allowFailure: true,
        });

        return {
          ok: result.code === 0,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          argv,
        };
      } catch (error) {
        // A timeout, a signal, or a failed spawn. The merges already performed in a group run
        // still have to be reported, so this is a result and not a throw.
        const details = error?.details ?? {};
        const message = reasonFrom(error);
        const stderr = typeof details.stderr === "string" ? details.stderr : "";

        return {
          ok: false,
          code: Number.isInteger(details.code) && details.code !== 0 ? details.code : 1,
          stdout: typeof details.stdout === "string" ? details.stdout : "",
          stderr: stderr || message,
          argv,
          error: message,
        };
      }
    },
  };
}
