import { isAbsolute, join, resolve } from "node:path";
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

function fail(category, message, details, exitCode) {
  throw new WorkflowError(category, message, { details, exitCode });
}

export function createGitAdapter({ runner }) {
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
  };
}
