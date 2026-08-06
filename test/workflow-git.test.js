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
