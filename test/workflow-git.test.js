import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { createProcessRunner, OUTPUT_LIMIT } from "../src/workflow/process.js";
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

// Measured on this machine against git 2.43 with two files conflicting in content:
//   git merge-tree --write-tree --name-only -z main feature
// exit 1, 282 bytes. The tree OID comes first, then one field per conflicted path,
// then an EMPTY field, then git's informational records — which this adapter ignores.
const MERGE_TREE_CONFLICTED_STDOUT = [
  "106dbfca1358dd5c1ffee228f3b0cba541e45ddd",
  "a.txt",
  "b.txt",
  "",
  "1",
  "a.txt",
  "Auto-merging",
  "Auto-merging a.txt\n",
  "1",
  "a.txt",
  "CONFLICT (contents)",
  "CONFLICT (content): Merge conflict in a.txt\n",
  "1",
  "b.txt",
  "Auto-merging",
  "Auto-merging b.txt\n",
  "1",
  "b.txt",
  "CONFLICT (contents)",
  "CONFLICT (content): Merge conflict in b.txt\n",
  "",
].join("\0");

// Same command, same git, a mergeable pair: exit 0, the tree OID and nothing else.
const MERGE_TREE_CLEAN_STDOUT = "ef908b10469726996ef0f1c1166b58e01e181cdc\0";

// process.js caps every captured stream at 12,000 characters.
const PROCESS_OUTPUT_LIMIT = 12000;

async function snapshotRepository(cwd) {
  const refs = await gitExec(cwd, ["rev-parse", "--all"]);
  const status = await gitExec(cwd, ["status", "--porcelain"]);
  const index = await gitExec(cwd, ["ls-files", "-s"]);
  return {
    refs: refs.stdout,
    status: status.stdout,
    index: index.stdout,
  };
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

test("resolveHead reads the branch and sha the checkout is actually on", async () => {
  const fixture = fixtureRunner({
    "git rev-parse --abbrev-ref HEAD": async () => ({ code: 0, stdout: "feature/registro-impl\n", stderr: "" }),
    "git rev-parse HEAD": async () => ({ code: 0, stdout: "0123456789012345678901234567890123456789\n", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const head = await git.resolveHead({ cwd: "/repo/.worktrees/task" });

  assert.deepEqual(head, {
    branch: "feature/registro-impl",
    sha: "0123456789012345678901234567890123456789",
  });
  assert.deepEqual(fixture.calls[0].args, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(fixture.calls[0].options.cwd, "/repo/.worktrees/task");
  assert.deepEqual(fixture.calls[1].args, ["rev-parse", "HEAD"]);
});

test("resolveHead reports a detached HEAD as a null branch", async () => {
  const fixture = fixtureRunner({
    "git rev-parse --abbrev-ref HEAD": async () => ({ code: 0, stdout: "HEAD\n", stderr: "" }),
    "git rev-parse HEAD": async () => ({ code: 0, stdout: "abcdefabcdefabcdefabcdefabcdefabcdefabcd\n", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const head = await git.resolveHead({ cwd: "/repo" });

  assert.equal(head.branch, null);
  assert.equal(head.sha, "abcdefabcdefabcdefabcdefabcdefabcdefabcd");
});

test("checkoutState reports the branch and a dirty working tree", async () => {
  const fixture = fixtureRunner({
    "git rev-parse --abbrev-ref HEAD": async () => ({ code: 0, stdout: "dev\n", stderr: "" }),
    "git status --porcelain=v1 -z": async () => ({
      code: 0,
      stdout: " M src/app.ts\0?? notes.md\0",
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const state = await git.checkoutState({ cwd: "/repo" });

  assert.equal(state.branch, "dev");
  assert.equal(state.dirty, true);
  assert.equal(state.statusError, undefined);
  assert.deepEqual(state.entries.map((entry) => entry.path), ["src/app.ts", "notes.md"]);
});

test("checkoutState reports a clean checkout as not dirty", async () => {
  const fixture = fixtureRunner({
    "git rev-parse --abbrev-ref HEAD": async () => ({ code: 0, stdout: "dev\n", stderr: "" }),
    "git status --porcelain=v1 -z": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const state = await git.checkoutState({ cwd: "/repo" });

  // `merging: null` here, not `false`: this fixture scripts no MERGE_HEAD probe, and an
  // unanswerable probe must degrade to "cannot say" rather than to "not merging".
  assert.deepEqual(state, { branch: "dev", dirty: false, entries: [], merging: null });
});

test("checkoutState reports dirty: null with a reason when git status cannot be read", async () => {
  const fixture = fixtureRunner({
    "git rev-parse --abbrev-ref HEAD": async () => ({ code: 0, stdout: "dev\n", stderr: "" }),
    "git status --porcelain=v1 -z": async () => {
      throw new WorkflowError("PROCESS", "git failed with exit code 128", { exitCode: 12 });
    },
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const state = await git.checkoutState({ cwd: "/repo" });

  assert.equal(state.branch, "dev");
  assert.equal(state.dirty, null, "an unreadable status must never be reported as clean");
  assert.match(state.statusError, /exit code 128/);
  assert.deepEqual(state.entries, []);
});

test("previewMerge maps exit 0 to a clean merge", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 0,
      stdout: MERGE_TREE_CLEAN_STDOUT,
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.deepEqual(preview, {
    status: "clean",
    tree: "ef908b10469726996ef0f1c1166b58e01e181cdc",
    conflicts: [],
  });
  assert.deepEqual(fixture.calls[0].args, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "-z",
    "dev",
    "feature/task",
  ]);
  assert.equal(fixture.calls[0].options.cwd, "/base");
  assert.equal(fixture.calls[0].options.allowFailure, true);
});

test("previewMerge parses conflicted paths from real merge-tree output and ignores the info section", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 1,
      stdout: MERGE_TREE_CONFLICTED_STDOUT,
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.deepEqual(preview, {
    status: "conflicted",
    tree: "106dbfca1358dd5c1ffee228f3b0cba541e45ddd",
    conflicts: ["a.txt", "b.txt"],
  });
});

test("previewMerge reports unknown with a reason when merge-tree exits above 1", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 129,
      stdout: "",
      stderr: "error: unknown option `write-tree'\n",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.status, "unknown", "a merge-tree that could not run is never clean");
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.reason, /129/);
  assert.match(preview.reason, /unknown option/);
});

test("previewMerge reports unknown when merge-tree exits 1 without producing a tree", async () => {
  // Measured on git 2.43: an unmergeable argument exits 1 with EMPTY stdout, which is
  // indistinguishable from "conflicted" by exit code alone. Fail closed.
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/gone": async () => ({
      code: 1,
      stdout: "",
      stderr: "merge-tree: feature/gone - not something we can merge\n",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/gone" });

  assert.equal(preview.status, "unknown");
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.reason, /not something we can merge/);
});

test("previewMerge reports unknown instead of throwing when merge-tree cannot be spawned", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => {
      throw new WorkflowError("PROCESS", "Failed to start git: spawn git ENOENT", { exitCode: 12 });
    },
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.status, "unknown");
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.reason, /ENOENT/);
});

test("mergeBranch runs exactly the approved argv with no terminal prompt", async () => {
  const fixture = fixtureRunner({
    "git merge --no-ff --no-edit feature/task": async () => ({
      code: 0,
      stdout: "Merge made by the 'ort' strategy.\n",
      stderr: "",
    }),
  });
  const git = createGitAdapter({
    runner: fixture.runner,
    env: { PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "1" },
  });

  const result = await git.mergeBranch({ cwd: "/base", source: "feature/task", timeoutMs: 60000 });

  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "Merge made by the 'ort' strategy.\n");
  assert.equal(result.stderr, "");
  assert.deepEqual(result.argv, ["git", "merge", "--no-ff", "--no-edit", "feature/task"]);
  assert.deepEqual(fixture.calls[0].args, ["merge", "--no-ff", "--no-edit", "feature/task"]);
  assert.deepEqual(result.argv, [fixture.calls[0].command, ...fixture.calls[0].args]);
  assert.deepEqual(fixture.calls[0].options.env, { PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0" });
  assert.equal(fixture.calls[0].options.cwd, "/base");
  assert.equal(fixture.calls[0].options.timeoutMs, 60000);
  assert.equal(fixture.calls[0].options.allowFailure, true);
});

test("mergeBranch inherits the process environment without mutating it", async () => {
  const fixture = fixtureRunner({
    "git merge --no-ff --no-edit feature/task": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  await git.mergeBranch({ cwd: "/base", source: "feature/task" });

  const passed = fixture.calls[0].options.env;
  assert.equal(passed.GIT_TERMINAL_PROMPT, "0");
  assert.equal(passed.PATH, process.env.PATH);
  assert.notEqual(passed, process.env);
  assert.equal(process.env.GIT_TERMINAL_PROMPT, undefined);
});

test("mergeBranch reports a failed merge as ok: false rather than throwing", async () => {
  const fixture = fixtureRunner({
    "git merge --no-ff --no-edit feature/task": async () => ({
      code: 1,
      stdout: "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n",
      stderr: "Automatic merge failed; fix conflicts and then commit the result.\n",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.mergeBranch({ cwd: "/base", source: "feature/task" });

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Automatic merge failed/);
  assert.deepEqual(result.argv, ["git", "merge", "--no-ff", "--no-edit", "feature/task"]);
});

test("mergeBranch reports a spawn failure as ok: false rather than throwing", async () => {
  const fixture = fixtureRunner({
    "git merge --no-ff --no-edit feature/task": async () => {
      throw new WorkflowError("PROCESS", "git timed out after 100ms", {
        exitCode: 12,
        details: { reason: "timeout", stdout: "", stderr: "" },
      });
    },
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.mergeBranch({ cwd: "/base", source: "feature/task", timeoutMs: 100 });

  assert.equal(result.ok, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /timed out/);
  assert.deepEqual(result.argv, ["git", "merge", "--no-ff", "--no-edit", "feature/task"]);
});

test("resolveHead and checkoutState read a real repository, detached HEAD included", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  const head = await git.resolveHead({ cwd: repoPath });
  assert.equal(head.branch, "main");
  assert.match(head.sha, /^[0-9a-f]{40}$/);

  const clean = await git.checkoutState({ cwd: repoPath });
  assert.deepEqual(clean, { branch: "main", dirty: false, entries: [], merging: false });

  await writeFile(join(repoPath, "README.md"), "changed\n");
  const dirty = await git.checkoutState({ cwd: repoPath });
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.statusError, undefined);
  assert.ok(dirty.entries.some((entry) => entry.path === "README.md"));

  await gitExec(repoPath, ["checkout", "--detach"]);
  const detached = await git.resolveHead({ cwd: repoPath });
  assert.equal(detached.branch, null, "a literal HEAD from rev-parse is not a branch name");
  assert.equal(detached.sha, head.sha);
  assert.equal((await git.checkoutState({ cwd: repoPath })).branch, null);
});

test("previewMerge predicts a real conflict and mutates no ref, index, or working-tree file", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  await writeFile(join(repoPath, "a.txt"), "one\n");
  await writeFile(join(repoPath, "b.txt"), "x\n");
  await gitExec(repoPath, ["add", "a.txt", "b.txt"]);
  await gitExec(repoPath, ["commit", "-m", "files"]);
  await gitExec(repoPath, ["checkout", "-b", "feature/task"]);
  await writeFile(join(repoPath, "a.txt"), "feature\n");
  await writeFile(join(repoPath, "b.txt"), "fb\n");
  await gitExec(repoPath, ["commit", "-am", "feature edit"]);
  await gitExec(repoPath, ["checkout", "main"]);
  await writeFile(join(repoPath, "a.txt"), "main\n");
  await writeFile(join(repoPath, "b.txt"), "mb\n");
  await gitExec(repoPath, ["commit", "-am", "main edit"]);

  const git = createGitAdapter({ runner: createProcessRunner() });
  const before = await snapshotRepository(repoPath);
  const beforeFile = await readFile(join(repoPath, "a.txt"), "utf8");

  const preview = await git.previewMerge({ cwd: repoPath, base: "main", source: "feature/task" });

  assert.equal(preview.status, "conflicted");
  assert.deepEqual(preview.conflicts, ["a.txt", "b.txt"]);
  assert.match(preview.tree, /^[0-9a-f]{40}$/);

  const after = await snapshotRepository(repoPath);
  const afterFile = await readFile(join(repoPath, "a.txt"), "utf8");

  assert.deepEqual(after, before, "previewMerge must touch no ref, no index, and no working tree");
  assert.equal(afterFile, beforeFile);
  assert.equal(afterFile, "main\n");
  assert.equal((await git.resolveHead({ cwd: repoPath })).branch, "main");
});

test("previewMerge reports a real mergeable pair as clean", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  await gitExec(repoPath, ["checkout", "-b", "feature/task"]);
  await writeFile(join(repoPath, "feature.txt"), "feature only\n");
  await gitExec(repoPath, ["add", "feature.txt"]);
  await gitExec(repoPath, ["commit", "-m", "feature file"]);
  await gitExec(repoPath, ["checkout", "main"]);
  await writeFile(join(repoPath, "main.txt"), "main only\n");
  await gitExec(repoPath, ["add", "main.txt"]);
  await gitExec(repoPath, ["commit", "-m", "main file"]);

  const git = createGitAdapter({ runner: createProcessRunner() });
  const preview = await git.previewMerge({ cwd: repoPath, base: "main", source: "feature/task" });

  assert.equal(preview.status, "clean");
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.tree, /^[0-9a-f]{40}$/);
});

test("previewMerge reports unknown for a source ref that does not exist in a real repository", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  const preview = await git.previewMerge({ cwd: repoPath, base: "main", source: "feature/gone" });

  assert.equal(preview.status, "unknown");
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.reason);
});

test("mergeArgv exposes the argv the operator approves before any merge runs", async () => {
  const fixture = fixtureRunner({
    "git merge --no-ff --no-edit feature/task": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const previewed = git.mergeArgv({ source: "feature/task" });
  assert.deepEqual(previewed, ["git", "merge", "--no-ff", "--no-edit", "feature/task"]);
  assert.equal(fixture.calls.length, 0, "obtaining the argv must not run anything");

  const result = await git.mergeBranch({ cwd: "/base", source: "feature/task" });

  // The digested string and the executed string come from one expression, and the test compares
  // the preview against what the runner was actually handed rather than against a second literal.
  assert.deepEqual(previewed, [fixture.calls[0].command, ...fixture.calls[0].args]);
  assert.deepEqual(result.argv, previewed);
});

test("mergeArgv is the only source of the merge argv, for any branch name", async () => {
  const fixture = fixtureRunner({
    "git merge --no-ff --no-edit release/2026-08-06": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const previewed = git.mergeArgv({ source: "release/2026-08-06" });
  await git.mergeBranch({ cwd: "/base", source: "release/2026-08-06" });

  assert.deepEqual(previewed, [fixture.calls[0].command, ...fixture.calls[0].args]);
});

test("previewMerge refuses a merge-tree that reported no tree at all", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({ code: 0 }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.status, "unknown", "an absent stdout is never a clean merge");
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.reason);
});

test("previewMerge refuses a first field that is not a tree object id", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 0,
      stdout: "not-an-object-id\0",
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.status, "unknown");
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.reason);
});

test("previewMerge accepts a sha256 repository's 64-character tree id", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 0,
      stdout: `${"a1b2c3d4".repeat(8)}\0`,
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.status, "clean");
  assert.equal(preview.tree, "a1b2c3d4".repeat(8));
});

test("previewMerge says so when the conflict list was cut off by the output limit", async () => {
  // Built the way process.js would really deliver it: a genuine merge-tree payload whose path
  // section is longer than the 12,000-character cap, sliced at exactly the cap.
  const paths = Array.from(
    { length: 900 },
    (_, index) => `src/very/long/path/segment/file-${String(index).padStart(4, "0")}.ts`,
  );
  const complete = [
    "106dbfca1358dd5c1ffee228f3b0cba541e45ddd",
    ...paths,
    "",
    "1",
    paths[0],
    "CONFLICT (contents)",
    "CONFLICT (content): Merge conflict\n",
    "",
  ].join("\0");
  assert.ok(complete.length > PROCESS_OUTPUT_LIMIT, "the fixture must actually exceed the cap");
  const capped = complete.slice(0, PROCESS_OUTPUT_LIMIT);

  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 1,
      stdout: capped,
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.status, "conflicted");
  assert.equal(preview.truncated, true, "the caller must be able to tell the list is a prefix");
  assert.ok(preview.reason, "a truncated list has to carry its own reason");
  assert.ok(preview.conflicts.length > 0);
  assert.ok(preview.conflicts.length < paths.length, "a truncated list is shorter than the truth");
  // The decisive assertion: no half-truncated path is ever reported as a conflicted file.
  const known = new Set(paths);
  assert.deepEqual(preview.conflicts.filter((path) => !known.has(path)), []);
});

test("previewMerge marks a complete conflict list as not truncated", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 1,
      stdout: MERGE_TREE_CONFLICTED_STDOUT,
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.truncated, undefined);
  assert.deepEqual(preview.conflicts, ["a.txt", "b.txt"]);
});

test("previewMerge is bounded and a timeout lands on unknown", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => {
      throw new WorkflowError("PROCESS", "git timed out after 250ms", {
        exitCode: 12,
        details: { reason: "timeout", stdout: "", stderr: "" },
      });
    },
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({
    cwd: "/base",
    base: "dev",
    source: "feature/task",
    timeoutMs: 250,
  });

  assert.equal(fixture.calls[0].options.timeoutMs, 250, "the read must be bounded like the write");
  assert.equal(preview.status, "unknown");
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.reason, /timed out/);
});

test("mergeBranch performs a real --no-ff merge and leaves a merge commit", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  await gitExec(repoPath, ["checkout", "-b", "feature/task"]);
  await writeFile(join(repoPath, "feature.txt"), "feature only\n");
  await gitExec(repoPath, ["add", "feature.txt"]);
  await gitExec(repoPath, ["commit", "-m", "feature file"]);
  await gitExec(repoPath, ["checkout", "main"]);

  const git = createGitAdapter({ runner: createProcessRunner() });
  const result = await git.mergeBranch({ cwd: repoPath, source: "feature/task", timeoutMs: 60000 });

  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.code, 0);
  assert.deepEqual(result.argv, ["git", "merge", "--no-ff", "--no-edit", "feature/task"]);

  const parents = (await gitExec(repoPath, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(" ");
  assert.equal(parents.length, 3, "--no-ff must produce a merge commit even when a fast-forward was available");
  assert.equal(await readFile(join(repoPath, "feature.txt"), "utf8"), "feature only\n");
  assert.equal((await git.checkoutState({ cwd: repoPath })).dirty, false);
});

// Roadmap item 2.4, task 3, step 5: a `git merge` that fails at commit time leaves the checkout
// mid-merge, and `dirty: true` alone described that state only as "there are uncommitted paths" --
// which reads as `git add`/`git stash` when the correct move is `git merge --abort`. Real git, a
// real rejecting hook, and a real stopped merge, because the whole point is what git leaves behind.
test("checkoutState distinguishes a checkout stuck mid-merge from an ordinarily dirty one", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  await gitExec(repoPath, ["checkout", "-b", "feature/work"]);
  await writeFile(join(repoPath, "feature.txt"), "feature\n");
  await gitExec(repoPath, ["add", "feature.txt"]);
  await gitExec(repoPath, ["commit", "-m", "feature work"]);
  await gitExec(repoPath, ["checkout", "main"]);

  const beforeMerge = await git.checkoutState({ cwd: repoPath });
  assert.equal(beforeMerge.dirty, false);
  assert.equal(beforeMerge.merging, false, "a clean checkout is not mid-merge");

  // A hook that rejects at commit time -- the exact shape found running the real CLI.
  const hookPath = join(repoPath, ".git", "hooks", "pre-merge-commit");
  await writeFile(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(() => gitExec(repoPath, ["merge", "--no-ff", "--no-edit", "feature/work"]));

  const afterFailedMerge = await git.checkoutState({ cwd: repoPath });
  assert.equal(afterFailedMerge.merging, true, "MERGE_HEAD is present; this checkout is mid-merge");
  assert.equal(afterFailedMerge.dirty, true);
  assert.equal(afterFailedMerge.branch, "main");

  await gitExec(repoPath, ["merge", "--abort"]);
  const afterAbort = await git.checkoutState({ cwd: repoPath });
  assert.equal(afterAbort.merging, false, "the abort is what actually resolves it");
  assert.equal(afterAbort.dirty, false);
});

// Node reports a missing `cwd` and a missing executable identically, as `spawn <cmd> ENOENT`. The
// real CLI printed "Failed to start git: spawn git ENOENT" for a run whose worktree had been
// deleted, sending the operator to check their git installation.
test("a spawn into a directory that does not exist names the directory, not the binary", async (t) => {
  const { root } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });
  const missing = join(root, "worktree-that-was-removed");

  await assert.rejects(
    () => git.resolveHead({ cwd: missing }),
    (error) => {
      assert.match(error.message, /working directory does not exist/);
      assert.ok(error.message.includes(missing), error.message);
      assert.doesNotMatch(error.message, /spawn git ENOENT/, "the old message sent operators to check their git install");
      return true;
    },
  );

  // The binary case still reports the binary: the fix must not swallow a genuinely missing command.
  const runner = createProcessRunner();
  await assert.rejects(
    () => runner.run("definitely-not-a-real-binary-xyz", [], { cwd: root }),
    /Failed to start definitely-not-a-real-binary-xyz: spawn definitely-not-a-real-binary-xyz ENOENT/,
  );
});

// --- I1: the capture boundary, not just the over-cap case ------------------------------------
//
// `process.js` caps a captured stream at exactly OUTPUT_LIMIT characters. parseMergeTree used to
// decide "the list is complete" purely by finding an empty field after the path section -- but when
// the cut lands exactly on the NUL terminating a path, `split("\0")` produces a trailing "" that is
// indistinguishable from git's real end-of-paths marker. The list was then reported as COMPLETE,
// with no `truncated` flag, and commands.js bound that prefix into the approval digest as the whole
// truth. Exactly the "a shortened list must never read as complete" property the whole chain exists
// to guarantee.
function cappedMergeTreeStdout({ paths, pad = 8 }) {
  // OID(40) + NUL(1) + `paths` nine-character paths (9 + NUL each) + one `pad`-character path + NUL.
  let output = `${"a".repeat(40)}\0`;
  for (let index = 0; index < paths; index += 1) output += `p${String(index).padStart(8, "0")}\0`;
  output += `${"q".repeat(pad)}\0`;
  return output;
}

test("a merge-tree conflict list cut exactly on a path separator is reported as truncated, not as complete", async () => {
  const stdout = cappedMergeTreeStdout({ paths: 1195 });
  assert.equal(stdout.length, OUTPUT_LIMIT, "this fixture must sit exactly on the capture boundary");
  assert.equal(stdout.split("\0").at(-1), "", "and its last field must look exactly like git's own terminator");

  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({ code: 1, stdout, stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });

  assert.equal(preview.status, "conflicted");
  assert.equal(preview.truncated, true, "a stream cut at the cap is a prefix of the truth, whatever its last field looks like");
  assert.equal(preview.conflicts.length, 1196, "every path that WAS captured survives; none is a fragment here");
  assert.match(preview.reason, /exceeded the 12000-character capture limit/);
});

test("a merge-tree stream under the cap that simply ends in a separator is still complete", async () => {
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({
      code: 1,
      stdout: `${"a".repeat(40)}\0src/one.ts\0src/two.ts\0`,
      stderr: "",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });
  assert.equal(preview.status, "conflicted");
  assert.equal(preview.truncated, undefined, "under the cap, a trailing separator is git's own terminator");
  assert.deepEqual(preview.conflicts, ["src/one.ts", "src/two.ts"]);
});

test("a clean merge whose informational tail was capped stays clean rather than becoming unknown", async () => {
  // The path section terminates immediately after the tree OID; it is git's volatile informational
  // section that got cut. Capping alone must not turn a known-clean merge into an unknown one.
  const stdout = `${"a".repeat(40)}\0\0${"x".repeat(OUTPUT_LIMIT)}`.slice(0, OUTPUT_LIMIT);
  const fixture = fixtureRunner({
    "git merge-tree --write-tree --name-only -z dev feature/task": async () => ({ code: 0, stdout, stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const preview = await git.previewMerge({ cwd: "/base", base: "dev", source: "feature/task" });
  assert.equal(preview.status, "clean");
  assert.deepEqual(preview.conflicts, []);
});

// --- M6: the merge probe must fail closed on an unreadable MERGE_HEAD -------------------------
//
// Measured on git 2.43: `rev-parse --verify --quiet MERGE_HEAD` exits 1 with EMPTY stderr for an
// absent MERGE_HEAD, a corrupt one, AND one this process cannot read -- and prints the identical
// `fatal: Needed a single revision` for all three when --quiet is dropped. The exit code cannot
// answer the question, so the file is read instead: ENOENT is the only proof of "not merging".
test("a corrupt MERGE_HEAD reports an unknown merge state rather than 'not merging'", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  assert.equal((await git.checkoutState({ cwd: repoPath })).merging, false, "absent MERGE_HEAD is the only proof of not-merging");

  await writeFile(join(repoPath, ".git", "MERGE_HEAD"), "not-a-sha\n");
  assert.equal(
    (await git.checkoutState({ cwd: repoPath })).merging,
    null,
    "a MERGE_HEAD git cannot resolve must degrade to 'cannot say', which the caller treats as a conflict",
  );

  // The exit-code probe this replaced cannot tell that case from an absent ref: both exit 1.
  const probe = await createProcessRunner().run("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: repoPath, allowFailure: true });
  assert.equal(probe.code, 1, "identical to the absent case -- which is why the exit code cannot be the answer");
  assert.equal(probe.stderr.trim(), "");

  await writeFile(join(repoPath, ".git", "MERGE_HEAD"), `${await gitExec(repoPath, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim())}\n`);
  assert.equal((await git.checkoutState({ cwd: repoPath })).merging, true);
});

// --- 2.5: removing a worktree without ever forcing -------------------------------------------
//
// Every stderr fixture below is git 2.43's real output, measured on this machine, not invented.
// The quoted path varies, so only the stable clause is asserted on.
const WORKTREE_DIRTY_STDERR = (path) =>
  `fatal: '${path}' contains modified or untracked files, use --force to delete it\n`;
const WORKTREE_MISSING_STDERR = (path) => `fatal: '${path}' is not a working tree\n`;

test("removeWorktree removes a clean worktree and reports the argv that actually ran", async () => {
  const fixture = fixtureRunner({
    "git worktree remove /repo/.worktrees/task": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({
    cwd: "/repo/main",
    path: "/repo/.worktrees/task",
    timeoutMs: 60000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.reason, undefined, "a success carries no reason");
  assert.deepEqual(result.argv, ["git", "worktree", "remove", "/repo/.worktrees/task"]);
  assert.deepEqual(result.argv, [fixture.calls[0].command, ...fixture.calls[0].args],
    "the reported argv must be the argv that ran, not a second literal that can drift from it");
  assert.equal(fixture.calls[0].options.cwd, "/repo/main");
  assert.equal(fixture.calls[0].options.timeoutMs, 60000);
  assert.equal(fixture.calls[0].options.allowFailure, true);
});

test("removeWorktree classifies git's modified-or-untracked refusal as dirty", async () => {
  const path = "/repo/.worktrees/task";
  const fixture = fixtureRunner({
    [`git worktree remove ${path}`]: async () => ({
      code: 128,
      stdout: "",
      stderr: WORKTREE_DIRTY_STDERR(path),
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({ cwd: "/repo/main", path });

  assert.equal(result.ok, false);
  assert.equal(result.code, 128);
  assert.equal(result.reason, "dirty", "this is the refusal the whole command exists to respect");
  assert.match(result.stderr, /contains modified or untracked files/);
  assert.ok(!result.argv.includes("--force"));
});

test("removeWorktree does not read `dirty` off the exit code, which 'not a working tree' shares", async () => {
  const path = "/repo/.worktrees/never-was";
  const fixture = fixtureRunner({
    [`git worktree remove ${path}`]: async () => ({
      code: 128,
      stdout: "",
      stderr: WORKTREE_MISSING_STDERR(path),
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({ cwd: "/repo/main", path });

  assert.equal(result.ok, false);
  assert.equal(result.code, 128, "the same 128 the dirty refusal uses");
  assert.equal(result.reason, "not-a-worktree", "which is why the code alone cannot classify it");
});

test("removeWorktree reports a worktree whose directory already vanished as removed", async () => {
  // Measured: git deregisters it and exits 0. This is exactly the residue archive exists to reclaim,
  // so it must not read as an error.
  const fixture = fixtureRunner({
    "git worktree remove /repo/.worktrees/gone": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({ cwd: "/repo/main", path: "/repo/.worktrees/gone" });

  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test("removeWorktree reports an unrecognized failure without claiming to know it is dirty", async () => {
  const fixture = fixtureRunner({
    "git worktree remove /repo/.worktrees/task": async () => ({
      code: 1,
      stdout: "",
      stderr: "fatal: could not lock config file\n",
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({ cwd: "/repo/main", path: "/repo/.worktrees/task" });

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.reason, "failed", "unknown fails closed to a generic refusal, never to dirty and never to ok");
});

test("removeWorktree reports a spawn failure or timeout as ok: false rather than throwing", async () => {
  const fixture = fixtureRunner({
    "git worktree remove /repo/.worktrees/task": async () => {
      throw new WorkflowError("PROCESS", "git timed out after 100ms", {
        exitCode: 12,
        details: { reason: "timeout", stdout: "", stderr: "" },
      });
    },
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({ cwd: "/repo/main", path: "/repo/.worktrees/task", timeoutMs: 100 });

  assert.equal(result.ok, false);
  assert.notEqual(result.code, 0, "a removal that could not run must never look like one that succeeded");
  assert.equal(result.reason, "failed");
  assert.match(result.error, /timed out/);
  assert.deepEqual(result.argv, ["git", "worktree", "remove", "/repo/.worktrees/task"]);
});

// The constraint with no exception. `--force` must be unreachable by construction, including via
// the one input a caller controls: the path itself.
test("--force appears in no argv removeWorktree can produce, for any path", async () => {
  const paths = [
    "/repo/.worktrees/task",
    "/repo/.worktrees/--force",
    "/repo/.worktrees/name with spaces",
    "--force",
    "-f",
    "",
    null,
    undefined,
    42,
  ];

  for (const path of paths) {
    const fixture = fixtureRunner({
      [`git worktree remove ${path}`]: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const git = createGitAdapter({ runner: fixture.runner });
    const result = await git.removeWorktree({ cwd: "/repo/main", path });

    assert.ok(!result.argv.includes("--force"), `argv leaked --force for path ${JSON.stringify(path)}`);
    assert.ok(!result.argv.includes("-f"), `argv leaked -f for path ${JSON.stringify(path)}`);
    for (const call of fixture.calls) {
      assert.ok(!call.args.includes("--force"), `ran --force for path ${JSON.stringify(path)}`);
      assert.ok(!call.args.includes("-f"), `ran -f for path ${JSON.stringify(path)}`);
    }
  }
});

test("removeWorktree refuses a path git would parse as an option, before anything spawns", async () => {
  for (const path of ["--force", "-f", "--", "", null, undefined, 42]) {
    const fixture = fixtureRunner({});
    const git = createGitAdapter({ runner: fixture.runner });

    const result = await git.removeWorktree({ cwd: "/repo/main", path });

    assert.equal(result.ok, false, `accepted ${JSON.stringify(path)} as a worktree path`);
    assert.equal(result.reason, "unsafe-path");
    assert.deepEqual(fixture.calls, [], "nothing may spawn for a path git would read as a flag");
  }
});

test("removeWorktree accepts an ordinary relative path and a path that merely contains a dash", async () => {
  const fixture = fixtureRunner({
    "git worktree remove .worktrees/my-task": async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({ cwd: "/repo/main", path: ".worktrees/my-task" });

  assert.equal(result.ok, true, "the guard is about a LEADING dash, not about dashes");
});

test("countCommitsNotIn counts what the base branch does not have", async () => {
  const fixture = fixtureRunner({
    "git rev-list --count main..feature/task --": async () => ({ code: 0, stdout: "7\n", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const count = await git.countCommitsNotIn({
    cwd: "/repo/main",
    base: "main",
    branch: "feature/task",
    timeoutMs: 30000,
  });

  assert.equal(count, 7);
  assert.deepEqual(fixture.calls[0].args, ["rev-list", "--count", "main..feature/task", "--"],
    "the trailing -- keeps a ref that looks like a filename from being read as a pathspec");
  assert.equal(fixture.calls[0].options.cwd, "/repo/main");
  assert.equal(fixture.calls[0].options.timeoutMs, 30000);
  assert.equal(fixture.calls[0].options.allowFailure, true);
});

test("countCommitsNotIn reports a fully merged branch as 0", async () => {
  const fixture = fixtureRunner({
    "git rev-list --count main..feature/task --": async () => ({ code: 0, stdout: "0\n", stderr: "" }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  assert.equal(await git.countCommitsNotIn({ cwd: "/repo/main", base: "main", branch: "feature/task" }), 0);
});

// The load-bearing distinction: 0 means "fully merged, nothing to warn about". A repository that
// could not be read must never render as that.
test("countCommitsNotIn answers null, never 0, when the count cannot be determined", async () => {
  const unreadable = [
    { code: 128, stdout: "", stderr: "fatal: bad revision 'main..feature/task'\n" },
    { code: 1, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "\n", stderr: "" },
    { code: 0, stdout: "not a number\n", stderr: "" },
    { code: 0, stdout: "-3\n", stderr: "" },
    { code: 0, stdout: "3.5\n", stderr: "" },
    { code: 0, stdout: "12 34\n", stderr: "" },
    { code: 0, stdout: `${"9".repeat(30)}\n`, stderr: "" },
  ];

  for (const outcome of unreadable) {
    const fixture = fixtureRunner({
      "git rev-list --count main..feature/task --": async () => outcome,
    });
    const git = createGitAdapter({ runner: fixture.runner });
    const count = await git.countCommitsNotIn({ cwd: "/repo/main", base: "main", branch: "feature/task" });

    assert.equal(count, null, `expected null for ${JSON.stringify(outcome)}`);
    assert.notEqual(count, 0, "0 would claim the branch is fully merged");
  }
});

test("countCommitsNotIn answers null instead of throwing when rev-list cannot be spawned", async () => {
  const fixture = fixtureRunner({
    "git rev-list --count main..feature/task --": async () => {
      throw new WorkflowError("PROCESS", "Failed to start git: working directory does not exist: /gone", { exitCode: 12 });
    },
  });
  const git = createGitAdapter({ runner: fixture.runner });

  assert.equal(await git.countCommitsNotIn({ cwd: "/gone", base: "main", branch: "feature/task" }), null);
});

// --- 2.5, step 4: against real git, because what git leaves behind is the whole question --------
//
// Three linked worktrees in one repository: one clean, one with ONLY untracked files, one whose
// directory has been deleted. The untracked-only case is the one that matters -- it is the shape a
// worker leaves behind (node_modules, .env.local, logs) and the one an implementer is most likely
// to assume is safe to remove.
test("removeWorktree against real git: clean removes, untracked-only refuses, vanished deregisters", async (t) => {
  const { root, repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  const cleanPath = join(root, "wt-clean");
  const untrackedPath = join(root, "wt-untracked");
  const vanishedPath = join(root, "wt-vanished");

  await gitExec(repoPath, ["worktree", "add", "-b", "feature/clean", cleanPath, "main"]);
  await gitExec(repoPath, ["worktree", "add", "-b", "feature/untracked", untrackedPath, "main"]);
  await gitExec(repoPath, ["worktree", "add", "-b", "feature/vanished", vanishedPath, "main"]);

  // Real committed work on the branch whose worktree is about to be removed, so "the branch and its
  // commits survive" has something to actually prove.
  await writeFile(join(cleanPath, "work.txt"), "committed work\n");
  await gitExec(cleanPath, ["add", "work.txt"]);
  await gitExec(cleanPath, ["commit", "-m", "work that must outlive its worktree"]);
  const workSha = (await gitExec(cleanPath, ["rev-parse", "HEAD"])).stdout.trim();

  // Untracked ONLY: not one tracked file differs.
  await mkdir(join(untrackedPath, "node_modules"));
  await writeFile(join(untrackedPath, "node_modules", "index.js"), "module.exports = {};\n");
  await writeFile(join(untrackedPath, ".env.local"), "TOKEN=secret\n");
  assert.equal(
    (await gitExec(untrackedPath, ["status", "--porcelain", "--untracked-files=no"])).stdout,
    "",
    "this fixture must be untracked-only; a modified tracked file would be testing a different case",
  );

  await rm(vanishedPath, { recursive: true, force: true });

  const clean = await git.removeWorktree({ cwd: repoPath, path: cleanPath, timeoutMs: 60000 });
  assert.equal(clean.ok, true, clean.stderr);
  assert.equal(clean.code, 0);
  assert.equal(clean.reason, undefined);
  assert.deepEqual(clean.argv, ["git", "worktree", "remove", cleanPath]);
  assert.equal(existsSync(cleanPath), false, "the directory is what archiving reclaims");

  // Archiving a run must never destroy a commit.
  assert.equal((await gitExec(repoPath, ["rev-parse", "feature/clean"])).stdout.trim(), workSha,
    "git worktree remove deletes no ref");
  assert.equal((await gitExec(repoPath, ["cat-file", "-t", workSha])).stdout.trim(), "commit");
  assert.match((await gitExec(repoPath, ["log", "-1", "--format=%s", "feature/clean"])).stdout,
    /work that must outlive its worktree/);
  assert.equal((await gitExec(repoPath, ["show", `${workSha}:work.txt`])).stdout, "committed work\n",
    "the content survives too, not just the ref");

  const untracked = await git.removeWorktree({ cwd: repoPath, path: untrackedPath, timeoutMs: 60000 });
  assert.equal(untracked.ok, false, "untracked files are still work with no other copy; git refuses and so must this");
  assert.equal(untracked.code, 128);
  assert.equal(untracked.reason, "dirty");
  assert.match(untracked.stderr, /contains modified or untracked files/);
  assert.ok(!untracked.argv.includes("--force"), "the refusal is the point; an implementation that forces fails here");
  assert.equal(existsSync(join(untrackedPath, ".env.local")), true, "a refusal destroys nothing");
  assert.equal(existsSync(join(untrackedPath, "node_modules", "index.js")), true);

  const vanished = await git.removeWorktree({ cwd: repoPath, path: vanishedPath, timeoutMs: 60000 });
  assert.equal(vanished.ok, true, vanished.stderr);
  assert.equal(vanished.code, 0);
  assert.equal(vanished.reason, undefined, "a directory that is already gone is residue to reclaim, not an error");

  const registered = (await gitExec(repoPath, ["worktree", "list", "--porcelain"])).stdout;
  assert.ok(!registered.includes(cleanPath), "the removed worktree is deregistered");
  assert.ok(!registered.includes(vanishedPath), "and so is the vanished one");
  assert.ok(registered.includes(untrackedPath), "the refused one stays registered, exactly as it was");
});

test("removeWorktree against real git: a path that was never a worktree is not a dirty one", async (t) => {
  const { root, repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });
  const plainPath = join(root, "never-a-worktree");
  await mkdir(plainPath);

  const result = await git.removeWorktree({ cwd: repoPath, path: plainPath, timeoutMs: 60000 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 128);
  assert.equal(result.reason, "not-a-worktree");
  assert.match(result.stderr, /is not a working tree/);
  assert.equal(existsSync(plainPath), true, "a path git does not own is not deleted by a failed removal");
});

test("countCommitsNotIn against real git counts, reaches 0 on a merge, and answers null for a ref that is gone", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });

  await gitExec(repoPath, ["checkout", "-b", "feature/task"]);
  for (const name of ["one", "two", "three"]) {
    await writeFile(join(repoPath, `${name}.txt`), `${name}\n`);
    await gitExec(repoPath, ["add", `${name}.txt`]);
    await gitExec(repoPath, ["commit", "-m", name]);
  }
  await gitExec(repoPath, ["checkout", "main"]);

  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "main", branch: "feature/task", timeoutMs: 30000 }), 3);
  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "feature/task", branch: "main" }), 0,
    "the base has nothing the branch lacks");

  await gitExec(repoPath, ["merge", "--no-ff", "--no-edit", "feature/task"]);
  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "main", branch: "feature/task" }), 0,
    "0 is the answer that means fully merged");

  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "main", branch: "feature/does-not-exist" }), null,
    "an unreadable range is unknown, and unknown is not 0");
  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "no-such-base", branch: "main" }), null);
});

// --- Review round 1: the INPUT axis, which the first round's tests never varied ----------------
//
// The output-axis tests above vary what git says back. They cannot catch the failure that matters
// most here, because on this axis git does not fail: an option-shaped or empty ref exits 0 with
// clean digit output, and the caller is handed a `0` -- "fully merged, nothing to warn about" --
// for a range that was never measured.
test("countCommitsNotIn refuses a ref git would parse as an option, before anything spawns", async () => {
  // Measured, git 2.43: each of these exits 0 and prints "0" against a branch genuinely ahead.
  const optionShaped = ["--branches=*", "--glob=*", "--remotes=*", "--all", "-f", "--"];

  for (const hostile of optionShaped) {
    for (const [base, branch] of [[hostile, "feature/task"], ["main", hostile]]) {
      const fixture = fixtureRunner({});
      const git = createGitAdapter({ runner: fixture.runner });

      const count = await git.countCommitsNotIn({ cwd: "/repo/main", base, branch });

      assert.equal(count, null, `accepted ${JSON.stringify({ base, branch })}`);
      assert.notEqual(count, 0, "0 would be a measurement that never happened");
      assert.deepEqual(fixture.calls, [], "nothing may spawn for a ref git would read as a flag");
    }
  }
});

// An empty side of a range silently substitutes HEAD, so git measures a DIFFERENT range and
// reports its count as the answer -- exit 0, clean digits, no error anywhere.
test("countCommitsNotIn refuses an absent or non-string ref rather than letting git substitute HEAD", async () => {
  for (const missing of ["", null, undefined, 42, {}, []]) {
    for (const [base, branch] of [[missing, "feature/task"], ["main", missing]]) {
      const fixture = fixtureRunner({});
      const git = createGitAdapter({ runner: fixture.runner });

      const count = await git.countCommitsNotIn({ cwd: "/repo/main", base, branch });

      assert.equal(count, null, `accepted ${JSON.stringify({ base, branch })}`);
      assert.deepEqual(fixture.calls, []);
    }
  }
});

// --- Review round 1: the never-throws contract, probed rather than assumed --------------------
test("the git primitives never throw, whatever the runner or the caller does", async () => {
  const runners = {
    "resolves undefined": { async run() { return undefined; } },
    "resolves an empty object": { async run() { return {}; } },
    "resolves a string": { async run() { return "not a result"; } },
    "resolves null": { async run() { return null; } },
    "throws a plain Error": { async run() { throw new Error("boom"); } },
    "throws a non-Error": { async run() { throw "boom"; } },
  };

  for (const [label, runner] of Object.entries(runners)) {
    const git = createGitAdapter({ runner });

    const removal = await git.removeWorktree({ cwd: "/repo/main", path: "/repo/.worktrees/task" });
    assert.equal(removal.ok, false, `${label}: a runner that says nothing must never read as a removal`);
    assert.ok(Number.isInteger(removal.code) && removal.code !== 0, `${label}: code must be a nonzero integer, got ${removal.code}`);
    assert.equal(typeof removal.stdout, "string", `${label}: stdout must be a string`);
    assert.equal(typeof removal.stderr, "string", `${label}: stderr must be a string`);
    assert.deepEqual(removal.argv, ["git", "worktree", "remove", "/repo/.worktrees/task"]);
    assert.notEqual(removal.reason, "dirty", `${label}: an unreadable result is not a diagnosis`);

    assert.equal(
      await git.countCommitsNotIn({ cwd: "/repo/main", base: "main", branch: "feature/task" }),
      null,
      `${label}: an unreadable count is null, never 0`,
    );
  }
});

test("the git primitives never throw when called with no arguments at all", async () => {
  const git = createGitAdapter({ runner: fixtureRunner({}).runner });

  const removal = await git.removeWorktree();
  assert.equal(removal.ok, false);
  assert.equal(removal.reason, "unsafe-path");
  assert.equal(typeof removal.stderr, "string");

  assert.equal(await git.countCommitsNotIn(), null);
});

// --- Review round 1: a path whose own name spoofs git's dirty clause --------------------------
//
// Measured: a directory literally named `contains modified or untracked files`, which was never a
// worktree, makes git print `fatal: '<path>' is not a working tree` -- and an unanchored pattern
// finds the dirty clause inside the path git echoed back.
test("removeWorktree is not fooled by a path whose own name contains git's dirty clause", async () => {
  const path = "/repo/.worktrees/contains modified or untracked files";
  const fixture = fixtureRunner({
    [`git worktree remove ${path}`]: async () => ({
      code: 128,
      stdout: "",
      stderr: `fatal: '${path}' is not a working tree\n`,
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  const result = await git.removeWorktree({ cwd: "/repo/main", path });

  assert.equal(result.reason, "not-a-worktree",
    "the clause belongs to the path, not to git's verdict; reporting 'dirty' would send Task 2 to the wrong remedy");
});

test("removeWorktree still classifies the real dirty refusal when the path is ordinary", async () => {
  // The anchor must not be so tight that the genuine message stops matching.
  const path = "/repo/.worktrees/task";
  const fixture = fixtureRunner({
    [`git worktree remove ${path}`]: async () => ({
      code: 128,
      stdout: "",
      stderr: `fatal: '${path}' contains modified or untracked files, use --force to delete it\n`,
    }),
  });
  const git = createGitAdapter({ runner: fixture.runner });

  assert.equal((await git.removeWorktree({ cwd: "/repo/main", path })).reason, "dirty");
});

// --- Review round 1, against real git ----------------------------------------------------------
test("countCommitsNotIn against real git: the guarded refs are the ones git answers 0 for", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const runner = createProcessRunner();
  const git = createGitAdapter({ runner });

  await gitExec(repoPath, ["checkout", "-b", "feature/task"]);
  for (const name of ["one", "two"]) {
    await writeFile(join(repoPath, `${name}.txt`), `${name}\n`);
    await gitExec(repoPath, ["add", `${name}.txt`]);
    await gitExec(repoPath, ["commit", "-m", name]);
  }
  await gitExec(repoPath, ["checkout", "main"]);

  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "main", branch: "feature/task" }), 2,
    "the truth this branch is worth");

  // What real git does with the hostile refs, proving the guard is not defending against a
  // hypothetical: each is a silent 0, not an error.
  for (const range of ["--branches=*..feature/task", "--glob=*..feature/task", "..main", "main.."]) {
    const raw = await runner.run("git", ["rev-list", "--count", range, "--"], { cwd: repoPath, allowFailure: true });
    assert.equal(raw.code, 0, `${range} was expected to be a SILENT failure`);
    assert.equal(raw.stdout.trim(), "0", `${range} was expected to answer a bare 0`);
  }

  // And what this adapter does with the same inputs: null, every time.
  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "--branches=*", branch: "feature/task" }), null);
  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "--glob=*", branch: "feature/task" }), null);
  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "", branch: "main" }), null);
  assert.equal(await git.countCommitsNotIn({ cwd: repoPath, base: "main", branch: "" }), null);
});

test("removeWorktree against real git is not fooled by a directory named like git's dirty clause", async (t) => {
  const { root, repoPath } = await createDisposableRepo(t);
  const git = createGitAdapter({ runner: createProcessRunner() });
  const spoofPath = join(root, "contains modified or untracked files");
  await mkdir(spoofPath);

  const result = await git.removeWorktree({ cwd: repoPath, path: spoofPath, timeoutMs: 60000 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 128);
  assert.match(result.stderr, /is not a working tree/);
  assert.equal(result.reason, "not-a-worktree", "real git, real spoofing path name, right verdict");
  assert.equal(existsSync(spoofPath), true);
});
