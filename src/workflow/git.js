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

// The one worktree-removal argv, written once, for the same reason mergeArgvFor exists: the
// reported argv and the argv that runs are the same expression, so they cannot drift. There is
// deliberately no flag here and no parameter that could add one -- see removeWorktree.
function removeWorktreeArgvFor(path) {
  return ["git", "worktree", "remove", path];
}

// Everything before the path, for the one case where there is no usable path to run with. Reported
// rather than a runnable argv, because nothing ran.
function removeWorktreeArgvPrefix() {
  return removeWorktreeArgvFor(null).slice(0, -1);
}

// git 2.43's own refusals, measured on this machine. Only the stable clause is matched: the
// sentence quotes the path, which varies. Matching the clause rather than the exit code is
// required, because 128 also covers "is not a working tree" -- a completely different situation
// with a completely different remedy. A message this does NOT recognize (a future rewording, a
// localized git) degrades to the generic `failed`, which still refuses; it can never degrade to
// `ok`, and it can never make this pass a flag.
//
// Both patterns are anchored on the CLOSING quote of the path git echoes back, because the path is
// attacker-adjacent text sitting inside the same sentence. Measured: a directory literally named
// `contains modified or untracked files`, which was never a worktree, produces
// `fatal: '<path>' is not a working tree` -- and an unanchored dirty pattern matches the path's own
// name, reporting `dirty` for a path git does not even know about. `not-a-worktree` is additionally
// anchored to the END of the message and tested FIRST, because it is the more specific of the two:
// the dirty refusal always ends in `to delete it`, so it can never satisfy the end anchor, while a
// spoofing path can still satisfy the dirty one. Not unspoofable -- a path containing a quote
// followed by the clause verbatim would still match -- but substantially harder, and the residual
// misclassification is between two refusals, never into `ok`.
const WORKTREE_DIRTY = /' contains modified or untracked files/;
const WORKTREE_NOT_A_WORKTREE = /' is not a working tree\s*$/;

// `git rev-list --count` prints a bare count and nothing else. Anything that is not a run of
// digits is not an answer -- same rule as OBJECT_ID and ISO_TIMESTAMP.
const COUNT = /^\d+$/;

// One side of the range `countCommitsNotIn` hands to git. Validated BEFORE spawning, because on
// this axis git's failures are silent successes rather than errors. Measured, git 2.43, against a
// branch genuinely 2 commits ahead of main:
//
//   rev-list --count 'main..feature/task'            exit 0, "2"   <- the truth
//   rev-list --count '--branches=*..feature/task'    exit 0, "0"
//   rev-list --count '--glob=*..feature/task'        exit 0, "0"
//   rev-list --count '--remotes=*..feature/task'     exit 0, "0"
//   rev-list --count '..main'                        exit 0, "0"
//   rev-list --count 'main..'                        exit 0, "0"
//
// An option taking a `=`-value is matched on its PREFIX, so a `..` inside the token does not stop
// git parsing the whole thing as an option; and an EMPTY side of a range silently substitutes
// HEAD, so a missing ref measures a different range and reports that count as the answer. All of
// them exit 0 with clean digit output, so validating the OUTPUT cannot catch any of it -- the
// caller is handed `0`, "fully merged, nothing to warn about", for a measurement that never
// happened. That is precisely the false green the null-versus-zero rule exists to prevent, and it
// is reachable from the same absent/empty/non-string record shapes item 2.3's C1 finding proved
// reachable. Same guard, same reasoning, as removeWorktree's path.
function isUsableRev(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("-");
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
async function readMergeState({ runner, fs, cwd, timeoutMs }) {
  let path;
  try {
    const result = await runner.run("git", ["rev-parse", "--git-path", "MERGE_HEAD"], { cwd, timeoutMs });
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

// The unfinished operations git can leave a worktree sitting inside, in the order git's own
// `wt_status_get_state` resolves them, each with the remedy that actually applies to it.
//
// Item 2.4 recorded "MERGE_HEAD only" as a deferred gap. It stopped being deferrable when it turned
// out to be half of a path from "clean archive" to "destroyed commit": measured on this machine,
// git 2.43, an interrupted `git rebase -i` leaves `rebase-merge/` present, MERGE_HEAD ABSENT, HEAD
// DETACHED and the tree CLEAN -- so a MERGE_HEAD-only probe and a dirty check both see nothing
// while the worktree holds rebased commits no ref references.
//
// The probe is EXISTENCE, deliberately weaker than readMergeState's content parsing: a marker whose
// bytes are unreadable still means an operation is in progress, and every caller of this fails
// closed. `rebase-apply/applying` is git's own discriminator between `git am` and a rebase using the
// apply backend; the remedies differ, so the two are not collapsed.
const PENDING_OPERATIONS = Object.freeze([
  { entry: "rebase-merge", operation: "rebase", remedy: "git rebase --abort" },
  { entry: "rebase-apply/applying", operation: "am", remedy: "git am --abort" },
  { entry: "rebase-apply", operation: "rebase", remedy: "git rebase --abort" },
  { entry: "MERGE_HEAD", operation: "merge", remedy: "git merge --abort" },
  { entry: "CHERRY_PICK_HEAD", operation: "cherry-pick", remedy: "git cherry-pick --abort" },
  { entry: "REVERT_HEAD", operation: "revert", remedy: "git revert --abort" },
  { entry: "BISECT_LOG", operation: "bisect", remedy: "git bisect reset" },
]);

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
    async resolveHead({ cwd, timeoutMs }) {
      const branchResult = await runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs });
      const shaResult = await runner.run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs });

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
    async checkoutState({ cwd, timeoutMs }) {
      const branchResult = await runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs });
      const branch = normalizeHeadBranch(trimLine(branchResult.stdout));

      const merging = await readMergeState({ runner, fs, cwd, timeoutMs });

      try {
        const statusResult = await runner.run("git", ["status", "--porcelain=v1", "-z"], { cwd, timeoutMs });
        const entries = parseStatus(statusResult.stdout);
        return { branch, dirty: entries.length > 0, entries, merging };
      } catch (error) {
        return { branch, dirty: null, entries: [], merging, statusError: reasonFrom(error) };
      }
    },

    // The content `git status --porcelain=v1` does not know exists, and `git worktree remove`
    // deletes without saying a word.
    //
    // Measured, git 2.43, and this is the whole reason this method exists: `git worktree remove`
    // WITHOUT `--force` refuses a worktree holding modified or untracked files -- and silently
    // deletes ignored ones, exit 0, no output. `--porcelain=v1` excludes ignored entries by
    // definition, so every probe built on it reports such a worktree as clean. On the machine this
    // was written against, a real run's worktree held a 615-byte `.env` that existed in no ref, no
    // other checkout and no backup, while the base checkout's `.env` was a different 1,853-byte
    // file. Archiving would have destroyed it and reported success.
    //
    // `--ignored=matching` rather than the default `traditional`, and the difference is load-bearing
    // for output size: `matching` reports entries that match an ignore PATTERN, so `node_modules/`
    // collapses to one directory entry instead of enumerating tens of thousands of files, while a
    // `*.log` pattern still lists each file it matches. Measured on a fixture with
    // `build`/`*.log`/`.env`/`coverage/` ignored:
    //
    //   !! .env                  <- file
    //   !! a.log                 <- file
    //   !! build/                <- directory (trailing slash, even though .gitignore said `build`)
    //   !! deep/nested/c.log     <- file, nested
    //
    // The trailing slash is git's own file/directory discriminator and is what lets a caller tell
    // regenerable noise (`node_modules/`, `dist/`) from an only-copy secret (`.env`). A path that is
    // a file can never end in `/`, so it is a total discrimination, not a heuristic.
    //
    // Never throws. `status: "unknown"` is the fail-closed answer, and a caller must treat it as
    // "there may be ignored content I cannot name" -- never as "there is none", which is the exact
    // false green this method was added to remove.
    async ignoredEntries({ cwd, timeoutMs }) {
      let result;
      try {
        result = await runner.run("git", ["status", "--porcelain=v1", "--ignored=matching", "-z"], { cwd, timeoutMs, allowFailure: true });
      } catch (error) {
        return { status: "unknown", files: [], directories: [], reason: reasonFrom(error) };
      }
      if (!result || result.code !== 0) {
        return { status: "unknown", files: [], directories: [], reason: `git status --ignored exited with code ${result?.code ?? "unknown"}${result?.stderr ? `: ${trimText(result.stderr)}` : ""}` };
      }

      const files = [];
      const directories = [];
      // Reusing parseStatus rather than re-splitting: `!!` entries share the porcelain-v1 record
      // shape, so rename/copy's two-value encoding is handled the same way here as anywhere else.
      for (const entry of parseStatus(result.stdout ?? "")) {
        if (entry.x !== "!" || entry.y !== "!") continue;
        const path = typeof entry.path === "string" ? entry.path : "";
        if (!path) continue;
        if (path.endsWith("/")) directories.push(path);
        else files.push(path);
      }
      return { status: "read", files, directories };
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

    // Does any ref in this repository contain `sha`? The question behind the design's unconditional
    // acceptance criterion, "archiving a run never destroys a commit".
    //
    // A worktree on a BRANCH needs no such check -- the branch ref is the answer. A worktree on a
    // DETACHED HEAD has exactly two things referencing its commits, its own HEAD and its own
    // per-worktree reflog, and `git worktree remove` deletes both. If some ref also contains the
    // commit, nothing is lost; if none does, removing the worktree makes it unreachable from that
    // moment and any later `git gc`/`git worktree prune` collects it.
    //
    // Measured on git 2.43, run in the BASE checkout (linked worktrees share its ref store):
    //   for-each-ref --count=1 --contains <commit on a branch>   exit 0, "<sha> commit\trefs/heads/feat"
    //   for-each-ref --count=1 --contains <orphaned commit>      exit 0, EMPTY  <- the real answer
    //   for-each-ref --count=1 --contains 000…000                exit 129, "error: no such commit"
    //   for-each-ref --count=1 --contains --format=%00           exit 129 (git consumes the flag as
    //                                                            the VALUE, so it cannot inject one)
    //
    // Returns `true` ONLY on positive proof of reachability. Every other outcome -- a nonzero exit,
    // a spawn failure, an unusable sha, a runner that answers nothing -- is `false`, because the
    // caller's response to `false` is to refuse. "I could not tell" and "nothing references it" are
    // the same action here, and the safe one. It does not consult the reflog, so a commit reachable
    // only from there also reads as unreachable: fail-closed in the direction that refuses.
    async isCommitReachable({ cwd, sha, timeoutMs } = {}) {
      // Stricter than isUsableRev on purpose: this is always a resolved HEAD sha from resolveHead,
      // never a user-supplied name, so anything that is not an object id is a caller bug and must
      // not be turned into a question git might answer affirmatively about something else.
      if (typeof sha !== "string" || !OBJECT_ID.test(sha)) return false;

      try {
        const result = await runner.run("git", ["for-each-ref", "--count=1", "--contains", sha], { cwd, timeoutMs, allowFailure: true });
        if (!result || result.code !== 0) return false;
        return trimText(result.stdout).length > 0;
      } catch {
        return false;
      }
    },

    // Is this worktree sitting inside an unfinished git operation of ANY kind? A superset of
    // checkoutState's `merging`, which probes MERGE_HEAD alone and therefore cannot see a rebase, a
    // cherry-pick, a revert, an `am` or a bisect -- see PENDING_OPERATIONS for the measurement that
    // made this necessary rather than merely tidier.
    //
    // Three outcomes, never a tri-state boolean: `{status:"none"}` (proven idle),
    // `{status:"in-progress", operation, path, remedy}`, and `{status:"unknown", reason}`. Callers
    // must treat `unknown` exactly like `in-progress`; separating them exists so the operator is
    // told which it was, not so one can be waved through.
    //
    // The admin directory comes from git rather than being assembled here: a linked worktree's
    // `.git` is a FILE, and its per-worktree state lives under `.git/worktrees/<name>/`, which is
    // exactly what `rev-parse --absolute-git-dir` returns from inside it (measured).
    async pendingOperation({ cwd, timeoutMs } = {}) {
      let gitDir;
      try {
        const result = await runner.run("git", ["rev-parse", "--absolute-git-dir"], { cwd, timeoutMs, allowFailure: true });
        if (!result || result.code !== 0) return { status: "unknown", reason: `the git admin directory could not be resolved${result?.stderr ? `: ${trimText(result.stderr)}` : ""}` };
        gitDir = trimLine(result.stdout);
      } catch (error) {
        return { status: "unknown", reason: reasonFrom(error) };
      }
      if (!gitDir) return { status: "unknown", reason: "git reported no admin directory" };

      for (const { entry, operation, remedy } of PENDING_OPERATIONS) {
        const path = resolve(gitDir, entry);
        try {
          await fs.stat(path);
          return { status: "in-progress", operation, path, remedy };
        } catch (error) {
          // ENOENT/ENOTDIR is the ONLY answer that proves this marker is absent. Anything else --
          // EACCES on the admin directory of a wedged run, most plausibly -- is unknown, and
          // unknown must never read as "no operation in progress".
          if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
            return { status: "unknown", reason: `${entry} could not be checked: ${reasonFrom(error)}` };
          }
        }
      }
      return { status: "none" };
    },

    // How many commits are on `branch` that `base` does not have -- what archiving this run would
    // quietly leave behind on a branch nobody is looking at any more. Read-only and never throws.
    //
    // `null` is "could not be determined", and keeping it distinct from `0` is the whole point:
    // `0` means "fully merged, nothing to warn about", so an unreadable repository, a ref that no
    // longer exists, or a spawn that failed must never render as that. BOTH axes are validated,
    // because both can produce a wrong `0`: the input (see isUsableRev, where git answers 0 with
    // exit 0 for a ref it never measured) and the output (a value that is not a count is not an
    // answer).
    //
    // The parameter object defaults and the single enclosing `try` are the never-throws contract,
    // not incidental placement: EVERY read of the runner's result sits inside it, so a runner that
    // resolves a non-object degrades to `null` like every other unknown rather than escaping as a
    // TypeError. The caller runs this while gathering evidence for an irreversible operation.
    async countCommitsNotIn({ cwd, base, branch, timeoutMs } = {}) {
      if (!isUsableRev(base) || !isUsableRev(branch)) return null;

      try {
        // The trailing `--` tells git the range is a revision and not a pathspec. It does NOT fix
        // the option-shaped ref above -- options are parsed before the separator is reached, and
        // `--branches=*..x --` still exits 0 with "0", which is why isUsableRev has to exist -- but
        // it does turn `ambiguous argument 'README.md..main'` into a plain bad-revision refusal.
        const result = await runner.run("git", ["rev-list", "--count", `${base}..${branch}`, "--"], { cwd, timeoutMs, allowFailure: true });
        if (!result || result.code !== 0) return null;

        const value = trimText(result.stdout);
        if (!COUNT.test(value)) return null;

        const count = Number.parseInt(value, 10);
        return Number.isSafeInteger(count) ? count : null;
      } catch {
        return null;
      }
    },

    // The one destructive operation in the archive path, and it NEVER forces.
    //
    // There is no `force` parameter -- not one defaulted to false, absent -- because an
    // unused-but-present option is exactly how the constraint erodes. Uncommitted and untracked
    // work in a worktree is the one thing in this system that exists nowhere else, and git's
    // refusal to delete it is a feature this adapter forwards rather than overrides. A dirty
    // worktree is a refusal the caller reports, never a `--force` away.
    //
    // Never throws: a group run archives several worktrees, and the removals already performed
    // still have to be reported. `reason` is absent on success and is one of `dirty`,
    // `not-a-worktree`, `unsafe-path` or `failed` otherwise -- `failed` being the fail-closed
    // landing spot for anything unrecognized. `argv` comes from the same expression that runs.
    //
    // The parameter object default is part of that contract: a call with no arguments at all must
    // return a refusal, not a destructuring TypeError, because this runs where a throw could
    // discard the report of removals that already happened.
    async removeWorktree({ cwd, path, timeoutMs } = {}) {
      // git parses a leading `-` as an option, so a path shaped like one is the single input
      // through which `--force` could reach this argv at all. Refused before anything spawns:
      // that is what makes the flag unreachable by construction rather than by convention. An
      // absent or non-string path lands here too -- the caller has no worktree to name.
      if (typeof path !== "string" || !path || path.startsWith("-")) {
        return {
          ok: false,
          code: 1,
          stdout: "",
          stderr: `Refusing to remove a worktree at an unsafe path: ${JSON.stringify(path)}`,
          argv: removeWorktreeArgvPrefix(),
          reason: "unsafe-path",
        };
      }

      const argv = removeWorktreeArgvFor(path);
      const [command, ...args] = argv;

      try {
        const result = await runner.run(command, args, { cwd, timeoutMs, allowFailure: true });

        // Every field is normalized to the documented shape rather than forwarded as-is, so a
        // runner that answers with a partial object cannot produce a result the interface does not
        // admit -- and, more importantly, a missing exit code fails CLOSED to 1 rather than being
        // compared loosely against 0 and reading as a successful removal.
        const code = Number.isInteger(result?.code) ? result.code : 1;
        const stdout = typeof result?.stdout === "string" ? result.stdout : "";
        const stderr = typeof result?.stderr === "string" ? result.stderr : "";

        // Measured on git 2.43: a worktree whose directory has already been deleted exits 0 and is
        // deregistered. That is residue this command exists to reclaim, not an error.
        if (code === 0) {
          return { ok: true, code, stdout, stderr, argv };
        }

        // Order matters: the end-anchored `not-a-worktree` message is the more specific of the two
        // and cannot be produced by a dirty refusal, so testing it first resolves the one case a
        // hostile path name can make ambiguous. See WORKTREE_DIRTY.
        let reason = "failed";
        if (WORKTREE_NOT_A_WORKTREE.test(stderr)) reason = "not-a-worktree";
        else if (WORKTREE_DIRTY.test(stderr)) reason = "dirty";

        return { ok: false, code, stdout, stderr, argv, reason };
      } catch (error) {
        // A timeout, a signal, or a failed spawn. Nothing is known about whether the removal
        // happened, so this is `failed` -- never `dirty`, and never `ok`.
        const details = error?.details ?? {};
        const message = reasonFrom(error);
        const stderr = typeof details.stderr === "string" ? details.stderr : "";

        return {
          ok: false,
          code: Number.isInteger(details.code) && details.code !== 0 ? details.code : 1,
          stdout: typeof details.stdout === "string" ? details.stdout : "",
          stderr: stderr || message,
          argv,
          reason: "failed",
          error: message,
        };
      }
    },
  };
}
