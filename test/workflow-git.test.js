import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { createProcessRunner } from "../src/workflow/process.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { WorkflowError } from "../src/workflow/errors.js";

const execFileAsync = promisify(execFile);

async function gitExec(cwd, args) {
  return await execFileAsync("git", args, { cwd });
}

async function createDisposableRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-git-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const repoPath = join(root, "repo");
  await mkdir(repoPath);
  await gitExec(root, ["init", "--initial-branch=main", repoPath]);
  await gitExec(repoPath, ["config", "user.name", "Workflow Tests"]);
  await gitExec(repoPath, ["config", "user.email", "workflow@example.test"]);
  await writeFile(join(repoPath, "README.md"), "hello\n");
  await gitExec(repoPath, ["add", "README.md"]);
  await gitExec(repoPath, ["commit", "-m", "initial"]);

  return { root, repoPath };
}

function fixtureRunner(handlers) {
  const calls = [];
  return {
    calls,
    runner: {
      async run(command, args, options) {
        calls.push({ command, args, options });
        const key = `${command} ${args.join(" ")}`;
        const handler = handlers[key];
        if (!handler) {
          throw new Error(`Unexpected command: ${key}`);
        }
        return await handler({ command, args, options });
      },
    },
  };
}

test("rejects worktree creation unless reconciliation is missing", async () => {
  const { runner } = fixtureRunner({});
  const git = createGitAdapter({ runner });

  await assert.rejects(
    git.createWorktree({
      cwd: "/repo",
      path: "/repo/.worktrees/task",
      branch: "feature/task",
      base: "main",
      reconciliation: { status: "compatible" },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "CONFLICT");
      assert.match(error.message, /missing/i);
      return true;
    },
  );
});

test("reuses an existing local branch when creating a worktree", async () => {
  const fixture = fixtureRunner({
    "git show-ref --verify --quiet refs/heads/feature/task": async () => ({ code: 0, stdout: "", stderr: "" }),
    "git worktree add /repo/.worktrees/task feature/task": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.createWorktree({
    cwd: "/repo",
    path: "/repo/.worktrees/task",
    branch: "feature/task",
    base: "main",
    reconciliation: { status: "missing" },
  });

  assert.equal(fixture.calls[0].options.cwd, "/repo");
  assert.deepEqual(fixture.calls[0].args, ["show-ref", "--verify", "--quiet", "refs/heads/feature/task"]);
  assert.deepEqual(fixture.calls[1].args, ["worktree", "add", "/repo/.worktrees/task", "feature/task"]);
  assert.deepEqual(result, { path: "/repo/.worktrees/task", branch: "feature/task", createdBranch: false });
});

test("creates a new branch from the requested base when the branch does not exist", async () => {
  const fixture = fixtureRunner({
    "git show-ref --verify --quiet refs/heads/feature/task": async () => ({ code: 1, stdout: "", stderr: "" }),
    "git rev-parse --verify --quiet main^{commit}": async () => ({ code: 0, stdout: "abc123\n", stderr: "" }),
    "git worktree add -b feature/task /repo/.worktrees/task main": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.createWorktree({
    cwd: "/repo",
    path: "/repo/.worktrees/task",
    branch: "feature/task",
    base: "main",
    reconciliation: { status: "missing" },
  });

  assert.deepEqual(fixture.calls[1].args, ["rev-parse", "--verify", "--quiet", "main^{commit}"]);
  assert.deepEqual(fixture.calls[2].args, ["worktree", "add", "-b", "feature/task", "/repo/.worktrees/task", "main"]);
  assert.deepEqual(result, { path: "/repo/.worktrees/task", branch: "feature/task", createdBranch: true });
});

test("refuses worktree creation when the requested base does not exist", async () => {
  const fixture = fixtureRunner({
    "git show-ref --verify --quiet refs/heads/feature/task": async () => ({ code: 1, stdout: "", stderr: "" }),
    "git rev-parse --verify --quiet missing-base^{commit}": async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  await assert.rejects(
    git.createWorktree({
      cwd: "/repo",
      path: "/repo/.worktrees/task",
      branch: "feature/task",
      base: "missing-base",
      reconciliation: { status: "missing" },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /missing-base/);
      return true;
    },
  );

  assert.equal(fixture.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "add"), false);
});

test("inspects a main checkout and a linked worktree", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const linkedPath = join(resolve(repoPath, ".."), "feature-task");
  await gitExec(repoPath, ["branch", "feature/task"]);
  await gitExec(repoPath, ["worktree", "add", linkedPath, "feature/task"]);

  const git = createGitAdapter({ runner: createProcessRunner() });
  const mainInfo = await git.inspectRepository({ cwd: repoPath });
  const linkedInfo = await git.inspectRepository({ cwd: linkedPath });

  assert.equal(mainInfo.kind, "checkout");
  assert.equal(linkedInfo.kind, "linked-worktree");
  assert.equal(mainInfo.rootPath, repoPath);
  assert.equal(linkedInfo.rootPath, linkedPath);
  assert.ok(mainInfo.commonDirPath.endsWith(".git"));
  assert.ok(linkedInfo.commonDirPath.endsWith(join("repo", ".git")));
});

test("lists worktrees with branch and path occupancy", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const linkedPath = join(resolve(repoPath, ".."), "feature-task");
  await gitExec(repoPath, ["branch", "feature/task"]);
  await gitExec(repoPath, ["worktree", "add", linkedPath, "feature/task"]);

  const git = createGitAdapter({ runner: createProcessRunner() });
  const worktrees = await git.listWorktrees({ cwd: repoPath });

  assert.equal(worktrees.length, 2);
  assert.deepEqual(worktrees.map((entry) => entry.path).sort(), [linkedPath, repoPath].sort());
  assert.deepEqual(worktrees.map((entry) => entry.branch).sort(), ["refs/heads/feature/task", "refs/heads/main"]);
});

test("checks whether local refs exist", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  assert.equal(await git.refExists({ cwd: repoPath, ref: "main", kind: "branch" }), true);
  assert.equal(await git.refExists({ cwd: repoPath, ref: "feature/task", kind: "branch" }), false);
  assert.equal(await git.refExists({ cwd: repoPath, ref: "HEAD", kind: "commit" }), true);
});

test("parses rename porcelain entries with new path and old fromPath", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  await gitExec(repoPath, ["mv", "README.md", "docs.md"]);
  const dirty = await git.status({ cwd: repoPath });

  assert.equal(dirty.dirty, true);
  assert.equal(dirty.entries.length, 1);
  assert.equal(dirty.entries[0].x, "R");
  assert.equal(dirty.entries[0].path, "docs.md");
  assert.equal(dirty.entries[0].fromPath, "README.md");
});

test("reports whether repository status is dirty", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  const clean = await git.status({ cwd: repoPath });
  assert.equal(clean.dirty, false);
  assert.deepEqual(clean.entries, []);

  await writeFile(join(repoPath, "README.md"), "changed\n");
  const dirty = await git.status({ cwd: repoPath });

  assert.equal(dirty.dirty, true);
  assert.equal(dirty.entries.length, 1);
  assert.match(dirty.entries[0].path, /README.md$/);
});

test("creates a child worktree in a disposable repository", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const childPath = join(resolve(repoPath, ".."), "feature-task");
  const git = createGitAdapter({ runner: createProcessRunner() });

  const result = await git.createWorktree({
    cwd: repoPath,
    path: childPath,
    branch: "feature/task",
    base: "main",
    reconciliation: { status: "missing" },
  });

  const branch = (await gitExec(childPath, ["branch", "--show-current"])).stdout.trim();
  const readme = await readFile(join(childPath, "README.md"), "utf8");

  assert.deepEqual(result, { path: childPath, branch: "feature/task", createdBranch: true });
  assert.equal(branch, "feature/task");
  assert.equal(readme, "hello\n");
});

test("fingerprints clean and dirty worktrees without file contents", async (t) => {
  const git = createGitAdapter({ runner: createProcessRunner() });

  const cleanRepo = await createDisposableRepo(t);
  const clean = await git.fingerprint({ cwd: cleanRepo.repoPath });
  const cleanAgain = await git.fingerprint({ cwd: cleanRepo.repoPath });

  assert.equal(clean.digest, cleanAgain.digest);
  assert.match(clean.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(clean.head, /^[0-9a-f]{40}$/);
  assert.equal(clean.branch, "main");
  assert.equal(clean.dirty, false);
  assert.deepEqual(clean.entries, []);

  await writeFile(join(cleanRepo.repoPath, "README.md"), "changed\n");
  const trackedEdit = await git.fingerprint({ cwd: cleanRepo.repoPath });
  assert.notEqual(trackedEdit.digest, clean.digest);
  assert.equal(JSON.stringify(trackedEdit).includes("changed\\n"), false);
  assert.ok(trackedEdit.entries.some((entry) => entry.path === "README.md" && entry.y === "M"));

  const stagedRepo = await createDisposableRepo(t);
  const stagedClean = await git.fingerprint({ cwd: stagedRepo.repoPath });
  await writeFile(join(stagedRepo.repoPath, "README.md"), "staged only\n");
  await gitExec(stagedRepo.repoPath, ["add", "README.md"]);
  const stagedEdit = await git.fingerprint({ cwd: stagedRepo.repoPath });
  assert.notEqual(stagedEdit.digest, stagedClean.digest);
  assert.equal(JSON.stringify(stagedEdit).includes("staged only\\n"), false);
  assert.ok(stagedEdit.entries.some((entry) => entry.path === "README.md" && entry.x === "M"));

  const renameRepo = await createDisposableRepo(t);
  const renameClean = await git.fingerprint({ cwd: renameRepo.repoPath });
  await gitExec(renameRepo.repoPath, ["mv", "README.md", "docs.md"]);
  const renamed = await git.fingerprint({ cwd: renameRepo.repoPath });
  assert.notEqual(renamed.digest, renameClean.digest);
  assert.ok(renamed.entries.some((entry) => entry.x === "R" && entry.path === "docs.md" && entry.fromPath === "README.md"));

  const untrackedRepo = await createDisposableRepo(t);
  await writeFile(join(untrackedRepo.repoPath, ".env.local"), "SECRET_TOKEN=short\n");
  const untracked = await git.fingerprint({ cwd: untrackedRepo.repoPath });
  await writeFile(join(untrackedRepo.repoPath, ".env.local"), "SECRET_TOKEN=longer-value\n");
  const untrackedMetadataChanged = await git.fingerprint({ cwd: untrackedRepo.repoPath });
  assert.notEqual(untrackedMetadataChanged.digest, untracked.digest);
  assert.ok(untrackedMetadataChanged.entries.some((entry) => entry.path === ".env.local" && entry.x === "?"));
  assert.equal(JSON.stringify(untrackedMetadataChanged).includes("SECRET_TOKEN"), false);
});

test("fingerprint rejects porcelain paths outside the worktree", async () => {
  const fixture = fixtureRunner({
    "git rev-parse --show-toplevel": async () => ({ code: 0, stdout: "/repo\n", stderr: "" }),
    "git rev-parse HEAD": async () => ({ code: 0, stdout: "0123456789012345678901234567890123456789\n", stderr: "" }),
    "git branch --show-current": async () => ({ code: 0, stdout: "main\n", stderr: "" }),
    "git status --porcelain=v1 -z": async () => ({ code: 0, stdout: " M ../secret.txt\0", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  await assert.rejects(
    () => git.fingerprint({ cwd: "/repo" }),
    /path|worktree|traversal/i,
  );
});
