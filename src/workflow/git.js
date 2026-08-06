import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WorkflowError } from "./errors.js";

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

// `git merge-tree --write-tree --name-only -z <base> <source>` (measured on git 2.43) writes
// the merged tree OID first, then one field per conflicted path, then an EMPTY field, then
// git's informational records. Only the OID and the paths are contractual enough to depend on;
// the informational section's shape is volatile and nothing here needs it.
function parseMergeTree(output) {
  const fields = String(output).split("\0");
  const tree = trimLine(fields[0] ?? "");
  const conflicts = [];

  for (let index = 1; index < fields.length; index += 1) {
    if (fields[index] === "") break;
    conflicts.push(fields[index]);
  }

  return { tree, conflicts };
}

// `rev-parse --abbrev-ref HEAD` answers the literal string "HEAD" on a detached HEAD, which is
// not a branch name and must never be compared against one.
function normalizeHeadBranch(value) {
  if (!value || value === "HEAD") return null;
  return value;
}

function reasonFrom(error) {
  return String(error?.message ?? error).slice(0, 256);
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
    async checkoutState({ cwd }) {
      const branchResult = await runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
      const branch = normalizeHeadBranch(trimLine(branchResult.stdout));

      try {
        const statusResult = await runner.run("git", ["status", "--porcelain=v1", "-z"], { cwd });
        const entries = parseStatus(statusResult.stdout);
        return { branch, dirty: entries.length > 0, entries };
      } catch (error) {
        return { branch, dirty: null, entries: [], statusError: reasonFrom(error) };
      }
    },

    // The non-mutating conflict oracle: real merge machinery, no ref, no index, no working tree.
    // Never throws — the caller is gathering evidence, and "unknown" is the fail-closed answer.
    async previewMerge({ cwd, base, source }) {
      const args = ["merge-tree", "--write-tree", "--name-only", "-z", base, source];
      let result;

      try {
        result = await runner.run("git", args, { cwd, allowFailure: true });
      } catch (error) {
        return {
          status: "unknown",
          conflicts: [],
          reason: `git merge-tree could not run: ${reasonFrom(error)}`,
        };
      }

      const { tree, conflicts } = parseMergeTree(result.stdout);

      if (tree && result.code === 0) {
        return { status: "clean", tree, conflicts: [] };
      }
      if (tree && result.code === 1) {
        return { status: "conflicted", tree, conflicts };
      }

      // Measured on git 2.43: a source ref git cannot merge exits 1 with EMPTY stdout, which is
      // indistinguishable from a conflict by exit code alone. No tree means no prediction.
      const detail = trimLine(result.stderr) || trimLine(result.stdout);
      const missingTree = tree ? "" : " without producing a merge tree";
      return {
        status: "unknown",
        conflicts: [],
        reason: `git merge-tree exited with code ${result.code}${missingTree}${detail ? `: ${detail}` : ""}`.slice(0, 512),
      };
    },

    // The one writer. `--no-ff` so the integration is always its own revertible commit and the
    // preview's prediction cannot depend on ancestry at execution time; `--no-edit` so git never
    // opens an editor there is no terminal for; `GIT_TERMINAL_PROMPT=0` so a credential prompt
    // cannot hang it. `argv` is reported from the same array that runs — it is what the approval
    // digest approves, so the two can never drift.
    async mergeBranch({ cwd, source, timeoutMs }) {
      const command = "git";
      const args = ["merge", "--no-ff", "--no-edit", source];
      const argv = [command, ...args];

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
