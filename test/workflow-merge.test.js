import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as realFs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { mergeCommand, MERGE_EXIT_CODES } from "../src/workflow/commands.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { createProcessRunner } from "../src/workflow/process.js";
import { createRunStore } from "../src/workflow/run-store.js";

// --- mergeCommand (roadmap item 2.4) ----------------------------------------
//
// Same discipline verifyCommand's tests established: a REAL run store over a temp state root (a
// stubbed store hides exactly the defects that matter), with the registry and the git adapter
// injected. The git double below is scripted per-path so a test can make exactly one repository
// dirty, or one merge-tree conflict, while every other cell stays clean.
//
// Four tests deliberately use REAL git against real temp repositories, because the two properties
// this command exists for cannot be proven against a double: that the source branch comes from
// the worktree rather than the record, and that a real merge advances the real base branch while
// leaving the run worktree untouched.

const execFileAsync = promisify(execFile);

async function gitExec(cwd, args) {
  return await execFileAsync("git", args, { cwd });
}

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-merge-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function fixedClock(timestamp) {
  return { now: () => timestamp };
}

function mergeLoadRegistry(projects) {
  return async () => ({ projects });
}

// The real argv builder, reached without a runner: `mergeArgv` runs nothing, so this is the same
// expression production uses. Writing the literal here instead would let a test agree with itself
// while disagreeing with what actually runs -- the exact drift the digest exists to prevent.
const argvBuilder = createGitAdapter({ runner: {} });

function expectedMergeArgv(source) {
  return argvBuilder.mergeArgv({ source });
}

// A test double for task 1's git adapter, scripted by path. Every method answers from
// `script[path]`, so a test names only the cell it cares about:
//
//   { "/base/backend": { branch: "dev", dirty: false, sha: "b1", preview: {...}, merge: {...} } }
//   { "/wt/backend":   { branch: "feature/actual", sha: "s1", committedAt: "..." } }
//
// `mergeArgv` is NOT reimplemented -- it delegates to the real adapter, so a test can never
// approve an argv the production adapter would not produce.
function scriptedGit(script = {}) {
  const calls = [];
  const entryFor = (cwd) => script[cwd] ?? {};

  return {
    calls,
    git: {
      async resolveHead({ cwd }) {
        calls.push({ method: "resolveHead", cwd });
        const entry = entryFor(cwd);
        if (entry.headError) throw new WorkflowError("PROCESS", entry.headError, { exitCode: 12 });
        return { branch: entry.branch ?? null, sha: entry.sha ?? "0".repeat(40) };
      },
      async checkoutState({ cwd }) {
        calls.push({ method: "checkoutState", cwd });
        const entry = entryFor(cwd);
        if (entry.headError) throw new WorkflowError("PROCESS", entry.headError, { exitCode: 12 });
        // `merging` is part of the adapter's contract (git.js's checkoutState), so the double
        // answers it like the real thing does: an explicit `false` unless a test scripts
        // otherwise. Leaving it `undefined` would let these tests pass against a commands.js that
        // fails OPEN on an unanswerable MERGE_HEAD probe, which is the exact bug this models.
        const merging = Object.hasOwn(entry, "merging") ? entry.merging : false;
        if (entry.dirty === null) {
          return { branch: entry.branch ?? null, dirty: null, entries: [], merging, statusError: entry.statusError ?? "git status failed" };
        }
        const entries = (entry.dirtyPaths ?? []).map((path) => ({ x: " ", y: "M", path }));
        return { branch: entry.branch ?? null, dirty: Boolean(entry.dirty) || entries.length > 0, entries, merging };
      },
      // Models the ref namespace of ONE checkout. `refsFrom` is the ordinary linked-worktree
      // topology -- base checkout and run worktree share a ref store, so the branch resolves to
      // exactly what the worktree's HEAD is at. `refs` overrides it, which is how a test builds
      // the separate-clone case where the base checkout's own `feature/x` points somewhere else.
      async resolveRef({ cwd, ref }) {
        calls.push({ method: "resolveRef", cwd, ref });
        const entry = entryFor(cwd);
        if (entry.resolveRefError) throw new WorkflowError("PROCESS", entry.resolveRefError, { exitCode: 12 });
        if (entry.refs && Object.hasOwn(entry.refs, ref)) return entry.refs[ref] ?? null;
        const shared = entry.refsFrom ? entryFor(entry.refsFrom) : null;
        return shared && shared.branch === ref ? shared.sha ?? null : null;
      },
      async previewMerge({ cwd, base, source, timeoutMs }) {
        calls.push({ method: "previewMerge", cwd, base, source, timeoutMs });
        return entryFor(cwd).preview ?? { status: "clean", tree: "t".repeat(40), conflicts: [] };
      },
      mergeArgv({ source }) {
        return argvBuilder.mergeArgv({ source });
      },
      async mergeBranch({ cwd, source, timeoutMs }) {
        calls.push({ method: "mergeBranch", cwd, source, timeoutMs });
        const scripted = entryFor(cwd).merge ?? {};
        const argv = argvBuilder.mergeArgv({ source });
        // Production's adapter is documented never to throw. This models an adapter that breaks
        // that contract, so the "never discard a report of merges that already happened"
        // property can be tested rather than assumed.
        if (scripted.throws) throw new WorkflowError("PROCESS", scripted.throws, { exitCode: 12 });
        if (scripted.ok === false) {
          return {
            ok: false,
            code: scripted.code ?? 1,
            stdout: scripted.stdout ?? "",
            stderr: scripted.stderr ?? "",
            argv,
            ...(scripted.error ? { error: scripted.error } : {}),
          };
        }
        return { ok: true, code: 0, stdout: scripted.stdout ?? "Merge made by the 'ort' strategy.\n", stderr: "", argv };
      },
      async commitTimestamp({ cwd }) {
        calls.push({ method: "commitTimestamp", cwd });
        return entryFor(cwd).committedAt ?? null;
      },
    },
  };
}

// The happy three-repository group project every "shape" test starts from: three worktrees on
// their own branches, three clean base checkouts on `dev`, nothing conflicting.
function groupFixture(overrides = {}) {
  const script = {
    "/wt/backend": { branch: "feature/actual", sha: "aaaa111", committedAt: "2026-08-01T10:00:00+00:00" },
    "/wt/panel": { branch: "feature/actual", sha: "bbbb222", committedAt: "2026-08-01T10:00:00+00:00" },
    "/wt/webapp": { branch: "feature/actual", sha: "cccc333", committedAt: "2026-08-01T10:00:00+00:00" },
    // `refsFrom` pairs each base checkout with its linked worktree, so the source branch resolves
    // in the base checkout to exactly the sha the worktree's HEAD is at -- the ordinary topology.
    "/base/backend": { branch: "dev", dirty: false, sha: "base111", refsFrom: "/wt/backend" },
    "/base/panel": { branch: "dev", dirty: false, sha: "base222", refsFrom: "/wt/panel" },
    "/base/webapp": { branch: "dev", dirty: false, sha: "base333", refsFrom: "/wt/webapp" },
  };
  for (const [path, entry] of Object.entries(overrides)) {
    script[path] = { ...script[path], ...entry };
  }
  return script;
}

const GROUP_PROJECT = {
  sharyco: {
    label: "Sharyco",
    repository: "group",
    // The group's META-repository. Merging here would be the wrong repository entirely -- one of
    // the refusal tests below asserts it is never reached.
    path: "/base/meta",
    repositories: {
      backend: { path: "/base/backend", base_branch: "dev" },
      panel: { path: "/base/panel", base_branch: "dev" },
      webapp: { path: "/base/webapp", base_branch: "dev" },
    },
  },
};

const GROUP_REPOSITORIES = [
  { id: "backend", path: "/wt/backend", branch: "feature/recorded" },
  { id: "panel", path: "/wt/panel", branch: "feature/recorded" },
  { id: "webapp", path: "/wt/webapp", branch: "feature/recorded" },
];

async function groupRun(store, repositories = GROUP_REPOSITORIES, extra = {}) {
  return await store.create({
    projectAlias: "sharyco",
    primaryTicket: "S-1",
    repositories,
    ...extra,
  });
}

function withAppendSpy(store) {
  const appendEventCalls = [];
  return {
    ...store,
    appendEventCalls,
    async appendEvent(runId, event) {
      appendEventCalls.push({ runId, event });
      return store.appendEvent(runId, event);
    },
  };
}

async function newStore(t) {
  const stateRoot = await tempStateRoot(t);
  return createRunStore({ stateRoot, clock: fixedClock("2026-08-06T00:00:00.000Z") });
}

// --- the real-data finding: the source branch comes from the worktree -------
//
// Real run 0b2612a8 records `feature/1216110941098331/registro-impl`; that ref does not exist and
// the worktree is on `feature/registro-impl`. Two of the eight real runs on this machine are in
// that shape. A record-driven implementation would try to merge a nonexistent ref -- so this test
// uses REAL git, where a wrong branch name cannot possibly succeed by accident.

async function realRepositoryPair(t, { baseBranch = "dev", sourceBranch = "feature/actual" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "workflow-merge-git-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));

  const basePath = join(root, "base");
  await realFs.mkdir(basePath);
  await gitExec(root, ["init", `--initial-branch=${baseBranch}`, basePath]);
  await gitExec(basePath, ["config", "user.name", "Workflow Tests"]);
  await gitExec(basePath, ["config", "user.email", "workflow@example.test"]);
  await realFs.writeFile(join(basePath, "README.md"), "base\n");
  await gitExec(basePath, ["add", "README.md"]);
  await gitExec(basePath, ["commit", "-m", "initial"]);

  const worktreePath = join(root, "work");
  await gitExec(basePath, ["worktree", "add", "-b", sourceBranch, worktreePath, baseBranch]);
  await realFs.writeFile(join(worktreePath, "feature.txt"), "work\n");
  await gitExec(worktreePath, ["add", "feature.txt"]);
  await gitExec(worktreePath, ["commit", "-m", "feature work"]);

  return { root, basePath, worktreePath };
}

async function worktreeSnapshot(cwd) {
  const head = await gitExec(cwd, ["rev-parse", "HEAD"]);
  const branch = await gitExec(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await gitExec(cwd, ["status", "--porcelain"]);
  const files = await gitExec(cwd, ["ls-files", "-s"]);
  return { head: head.stdout, branch: branch.stdout, status: status.stdout, files: files.stdout };
}

function realGit() {
  return createGitAdapter({ runner: createProcessRunner() });
}

test("a run whose recorded branch no longer exists previews and merges the worktree's actual branch, and names the mismatch", async (t) => {
  const store = await newStore(t);
  const { basePath, worktreePath } = await realRepositoryPair(t);
  const run = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    // Exactly the shape of real run 0b2612a8: a branch that was never created under this name.
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/1216110941098331/registro-impl" }],
  });
  const loadRegistry = mergeLoadRegistry({
    acme: { repository: "monorepo", path: basePath, base_branch: "dev" },
  });
  const deps = { store, loadRegistry, git: realGit() };

  const command = await mergeCommand({ runId: run.id }, deps);
  const [repository] = command.preview.repositories;

  assert.equal(command.preview.refused, false);
  assert.equal(repository.recordedBranch, "feature/1216110941098331/registro-impl");
  assert.equal(repository.sourceBranch, "feature/actual", "the source must come from the worktree, not the record");
  assert.equal(repository.branchMismatch, true);
  assert.deepEqual(repository.argv, expectedMergeArgv("feature/actual"));
  assert.deepEqual(command.preview.conflicts, []);

  const beforeWorktree = await worktreeSnapshot(worktreePath);
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "merged");
  assert.equal(report.exitCode, MERGE_EXIT_CODES.merged);
  assert.deepEqual(report.merged.map((entry) => entry.sourceBranch), ["feature/actual"]);

  // Real git: dev now contains the feature commit, through a real --no-ff merge commit.
  const log = await gitExec(basePath, ["log", "--oneline", "dev"]);
  assert.match(log.stdout, /feature work/);
  const parents = await gitExec(basePath, ["rev-list", "--parents", "-n", "1", "dev"]);
  assert.equal(parents.stdout.trim().split(/\s+/).length, 3, "--no-ff must produce a two-parent merge commit");

  // And the run's own worktree is untouched: same branch, same HEAD, same status, same index.
  assert.deepEqual(await worktreeSnapshot(worktreePath), beforeWorktree);
});

test("a real conflicting pair is predicted by the preview, blocks execution, and leaves the base branch exactly where it was", async (t) => {
  const store = await newStore(t);
  const { basePath, worktreePath } = await realRepositoryPair(t);
  // Both sides edit the same file: a guaranteed content conflict.
  await realFs.writeFile(join(basePath, "README.md"), "base side\n");
  await gitExec(basePath, ["commit", "-am", "base edit"]);
  await realFs.writeFile(join(worktreePath, "README.md"), "work side\n");
  await gitExec(worktreePath, ["commit", "-am", "work edit"]);

  const run = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-2",
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/actual" }],
  });
  const loadRegistry = mergeLoadRegistry({ acme: { repository: "monorepo", path: basePath, base_branch: "dev" } });

  const before = await gitExec(basePath, ["rev-parse", "dev"]);
  const command = await mergeCommand({ runId: run.id }, { store, loadRegistry, git: realGit() });

  assert.equal(command.preview.refused, false, "a predicted conflict is shown, not refused as a preview");
  assert.equal(command.preview.mergeable, false);
  assert.equal(command.preview.exitCode, MERGE_EXIT_CODES.conflicted);
  assert.equal(command.preview.repositories[0].conflictStatus, "conflicted");
  assert.deepEqual(command.preview.repositories[0].conflicts, ["README.md"]);
  assert.equal(command.preview.conflicts.length, 1);

  await assert.rejects(
    () => command.execute({ approvalDigest: command.preview.approvalDigest }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "CONFLICT");
      assert.equal(error.exitCode, MERGE_EXIT_CODES.conflicted);
      return true;
    },
  );

  const after = await gitExec(basePath, ["rev-parse", "dev"]);
  assert.equal(after.stdout, before.stdout, "a blocked merge must move nothing");
});

// --- the preview matrix ------------------------------------------------------

test("a three-repository run previews three exact argvs, in the order the run records them", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture());

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, false);
  assert.deepEqual(command.preview.repositories.map((entry) => entry.repositoryId), ["backend", "panel", "webapp"]);
  assert.deepEqual(
    command.preview.repositories.map((entry) => entry.argv),
    [expectedMergeArgv("feature/actual"), expectedMergeArgv("feature/actual"), expectedMergeArgv("feature/actual")],
  );
  assert.deepEqual(
    command.preview.repositories.map((entry) => entry.basePath),
    ["/base/backend", "/base/panel", "/base/webapp"],
  );
  assert.deepEqual(command.preview.repositories.map((entry) => entry.baseBranch), ["dev", "dev", "dev"]);
  assert.deepEqual(command.preview.conflicts, []);
  assert.equal(command.preview.mergeable, true);
  assert.equal(command.preview.exitCode, MERGE_EXIT_CODES.merged);
  assert.match(command.preview.approvalDigest, /^sha256:[0-9a-f]{64}$/);

  // The conflict oracle ran against every repository before anything executed, and it was bounded.
  const previews = fixture.calls.filter((call) => call.method === "previewMerge");
  assert.deepEqual(previews.map((call) => call.cwd), ["/base/backend", "/base/panel", "/base/webapp"]);
  assert.deepEqual(previews.map((call) => call.source), ["aaaa111", "bbbb222", "cccc333"]);
  assert.deepEqual(previews.map((call) => call.base), ["dev", "dev", "dev"]);
  for (const call of previews) {
    assert.equal(typeof call.timeoutMs, "number", "the conflict oracle must be bounded");
    assert.ok(call.timeoutMs > 0);
  }
  assert.deepEqual(fixture.calls.filter((call) => call.method === "mergeBranch"), [], "a preview must run no merge");
});

test("a predicted conflict blocks execution and names the conflicted files", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/panel": {
      preview: { status: "conflicted", tree: "t".repeat(40), conflicts: ["src/a.ts", "src/b.ts"] },
    },
  }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.mergeable, false);
  assert.equal(command.preview.conflicts.length, 1);
  assert.equal(command.preview.conflicts[0].repositoryId, "panel");
  assert.match(command.preview.conflicts[0].reason, /src\/a\.ts/);
  assert.deepEqual(command.preview.repositories[1].conflicts, ["src/a.ts", "src/b.ts"]);

  await assert.rejects(
    () => command.execute({ approvalDigest: command.preview.approvalDigest }),
    (error) => error instanceof WorkflowError && error.category === "CONFLICT",
  );
  assert.deepEqual(fixture.calls.filter((call) => call.method === "mergeBranch"), []);
});

test("a truncated conflict list is carried into the preview and into the digest", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const truncated = {
    "/base/backend": {
      preview: {
        status: "conflicted",
        tree: "t".repeat(40),
        conflicts: ["src/a.ts", "src/b.ts"],
        truncated: true,
        reason: "git merge-tree output exceeded the 12000-character capture limit; 2 conflicted paths shown, the rest are not listed",
      },
    },
  };
  const complete = {
    "/base/backend": {
      preview: { status: "conflicted", tree: "t".repeat(40), conflicts: ["src/a.ts", "src/b.ts"] },
    },
  };

  const truncatedPreview = (await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: scriptedGit(groupFixture(truncated)).git },
  )).preview;
  const completePreview = (await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: scriptedGit(groupFixture(complete)).git },
  )).preview;

  assert.equal(truncatedPreview.repositories[0].conflictsTruncated, true);
  assert.match(truncatedPreview.repositories[0].conflictReason, /capture limit/);
  assert.equal(completePreview.repositories[0].conflictsTruncated, false);
  assert.notEqual(
    truncatedPreview.approvalDigest,
    completePreview.approvalDigest,
    "approving \"these 2 conflicts\" when the list is a prefix of the truth is a different approval",
  );
});

test("a dirty base checkout is a conflict, and names the files that make it dirty", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/webapp": { dirty: true, dirtyPaths: ["src/app.ts", "notes.md"] },
  }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.mergeable, false);
  assert.equal(command.preview.repositories[2].baseDirty, true);
  assert.deepEqual(command.preview.repositories[2].baseDirtyPaths, ["src/app.ts", "notes.md"]);
  assert.equal(command.preview.conflicts.length, 1);
  assert.equal(command.preview.conflicts[0].repositoryId, "webapp");
  assert.match(command.preview.conflicts[0].reason, /uncommitted/i);
});

test("a base checkout whose status cannot be read is a conflict, never clean", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/panel": { dirty: null, statusError: "git failed with exit code 128" },
  }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.repositories[1].baseDirty, null);
  assert.equal(command.preview.mergeable, false);
  assert.equal(command.preview.conflicts.length, 1);
  assert.equal(command.preview.conflicts[0].repositoryId, "panel");
  assert.match(command.preview.conflicts[0].reason, /could not be read/i);
  assert.match(command.preview.conflicts[0].reason, /exit code 128/);

  await assert.rejects(
    () => command.execute({ approvalDigest: command.preview.approvalDigest }),
    (error) => error instanceof WorkflowError && error.category === "CONFLICT",
  );
  assert.deepEqual(fixture.calls.filter((call) => call.method === "mergeBranch"), []);
});

test("a base checkout that is not on its base_branch is a conflict", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/backend": { branch: "hotfix/urgent" },
  }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.repositories[0].baseCheckedOutBranch, "hotfix/urgent");
  assert.equal(command.preview.repositories[0].baseBranchCheckedOut, false);
  assert.equal(command.preview.mergeable, false);
  assert.match(command.preview.conflicts[0].reason, /hotfix\/urgent/);
  assert.match(command.preview.conflicts[0].reason, /dev/);
});

test("a merge-tree that could not answer is a conflict, not an empty conflict list", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/webapp": {
      preview: { status: "unknown", conflicts: [], reason: "git merge-tree exited with code 129 without producing a merge tree" },
    },
  }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.repositories[2].conflictStatus, "unknown");
  assert.equal(command.preview.mergeable, false);
  assert.equal(command.preview.conflicts[0].repositoryId, "webapp");
  assert.match(command.preview.conflicts[0].reason, /could not be predicted/i);
  assert.match(command.preview.conflicts[0].reason, /code 129/);
});

// --- refusals: each its own reason, appending nothing ------------------------

test("a run with no repositories[] recorded is refused, and appends nothing", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await store.create({ projectAlias: "sharyco", primaryTicket: "S-1" });
  const fixture = scriptedGit(groupFixture());

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.command, "merge");
  assert.equal(command.preview.refused, true);
  assert.equal(command.preview.approvalDigest, null);
  assert.equal(command.preview.exitCode, MERGE_EXIT_CODES.refused);
  assert.match(command.preview.reason, /no repositories/i);
  assert.deepEqual(command.preview.repositories, []);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a run whose project is absent from the registry is refused, and appends nothing", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture());

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry({ other: {} }), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /unknown workflow project: sharyco/i);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a repository entry with no usable path is refused, across every shape a run record can carry", async (t) => {
  const store = withAppendSpy(await newStore(t));

  const shapes = {
    "path missing": { id: "backend" },
    "path null": { id: "backend", path: null },
    "path empty string": { id: "backend", path: "" },
    "entry is a bare string": "backend",
    "entry is an empty object": {},
  };

  for (const [label, repository] of Object.entries(shapes)) {
    const run = await store.create({ projectAlias: "sharyco", primaryTicket: `S-${label}`, repositories: [repository] });
    const fixture = scriptedGit(groupFixture());

    const command = await mergeCommand(
      { runId: run.id },
      { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
    );

    assert.equal(command.preview.refused, true, label);
    assert.equal(command.preview.approvalDigest, null, label);
    assert.equal(command.preview.exitCode, MERGE_EXIT_CODES.refused, label);
    assert.match(command.preview.reason, /no worktree path recorded/i, label);
    assert.deepEqual(fixture.calls, [], `${label}: nothing may be read from git`);
  }
  assert.deepEqual(store.appendEventCalls, []);
});

test("a repository entry with a relative path is refused rather than resolved against the control plane's own directory", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await store.create({
    projectAlias: "sharyco",
    primaryTicket: "S-relative",
    repositories: [{ id: "backend", path: "src", branch: "feature/actual" }],
  });
  const fixture = scriptedGit(groupFixture());

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /relative worktree path/i);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a group repository that is no longer in the registry is refused, never merged into the group's meta-repository", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [
    { id: "backend", path: "/wt/backend", branch: "feature/recorded" },
    { id: "renamed-away", path: "/wt/renamed", branch: "feature/recorded" },
  ]);
  const fixture = scriptedGit(groupFixture({ "/wt/renamed": { branch: "feature/actual", sha: "dddd444", refsFrom: "/wt/renamed" } }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /renamed-away/);
  assert.match(command.preview.reason, /meta-repository/i);
  assert.equal(
    fixture.calls.some((call) => call.cwd === "/base/meta"),
    false,
    "the group's meta-repository must never be touched",
  );
  assert.deepEqual(store.appendEventCalls, []);
});

test("a project with no base_branch for a repository is refused", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const fixture = scriptedGit(groupFixture());

  const command = await mergeCommand(
    { runId: run.id },
    {
      store,
      loadRegistry: mergeLoadRegistry({
        sharyco: { repository: "group", path: "/base/meta", repositories: { backend: { path: "/base/backend" } } },
      }),
      git: fixture.git,
    },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /base_branch/);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a run worktree whose HEAD cannot be resolved is refused", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const fixture = scriptedGit(groupFixture({
    "/wt/backend": { headError: "fatal: not a git repository: /wt/backend" },
  }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /HEAD could not be resolved/i);
  assert.match(command.preview.reason, /not a git repository/);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a run worktree on a detached HEAD is refused: there is no source branch to merge", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const fixture = scriptedGit(groupFixture({ "/wt/backend": { branch: null, sha: "aaaa111" } }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /detached HEAD/i);
  assert.deepEqual(store.appendEventCalls, []);
});

// Important 1 (branch review): proving the source OBJECT is present in the base checkout is a
// different question from proving the branch NAME resolves there to that same object -- and the
// name is what `git merge` is handed. Both halves are refusals.
test("a source branch the base checkout does not have is refused", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const fixture = scriptedGit(groupFixture({ "/base/backend": { refs: { "feature/actual": null } } }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /does not resolve to a commit/i);
  assert.match(command.preview.reason, /feature\/actual/);
  assert.deepEqual(fixture.calls.filter((call) => call.method === "previewMerge"), []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a source branch that resolves in the base checkout to a different commit than the worktree's is refused", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  // The separate-clone case: the base checkout has the object (an earlier fetch) but its own
  // feature/actual still points at an older commit. Merging the NAME would merge that older one.
  const fixture = scriptedGit(groupFixture({ "/base/backend": { refs: { "feature/actual": "older11" } } }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /resolves to older11/);
  assert.match(command.preview.reason, /is at aaaa111/);
  assert.match(command.preview.reason, /previewing one commit and merging another/);
  assert.deepEqual(fixture.calls.filter((call) => call.method === "previewMerge"), []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a base checkout that cannot be read is refused", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const fixture = scriptedGit(groupFixture({
    "/base/backend": { headError: "fatal: cannot change to '/base/backend': No such file or directory" },
  }));

  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /base checkout/i);
  assert.match(command.preview.reason, /No such file or directory/);
  assert.deepEqual(store.appendEventCalls, []);
});

test("an ordinary monorepo project merges into the project's own path and base_branch", async (t) => {
  const store = await newStore(t);
  const run = await store.create({
    projectAlias: "ocr",
    primaryTicket: "O-1",
    // launch.js gives a monorepo run the id "primary", which is deliberately NOT a registry key.
    repositories: [{ id: "primary", path: "/wt/ocr", branch: "feature/recorded" }],
  });
  const fixture = scriptedGit({
    "/wt/ocr": { branch: "feature/actual", sha: "ffff555" },
    "/repo/ocr": { branch: "main", dirty: false, sha: "base555", refsFrom: "/wt/ocr" },
  });

  const command = await mergeCommand(
    { runId: run.id },
    {
      store,
      loadRegistry: mergeLoadRegistry({ ocr: { repository: "monorepo", path: "/repo/ocr", base_branch: "main" } }),
      git: fixture.git,
    },
  );

  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.repositories[0].basePath, "/repo/ocr");
  assert.equal(command.preview.repositories[0].baseBranch, "main");
  assert.equal(command.preview.mergeable, true);
});

// --- the digest --------------------------------------------------------------

test("the digest changes when the source sha, the base sha, the base checkout's cleanliness, or its checked-out branch changes", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const deps = (overrides) => ({
    store,
    loadRegistry: mergeLoadRegistry(GROUP_PROJECT),
    git: scriptedGit(groupFixture(overrides)).git,
  });
  const digest = async (overrides) => (await mergeCommand({ runId: run.id }, deps(overrides))).preview.approvalDigest;

  const baseline = await digest({});
  assert.equal(await digest({}), baseline, "the digest must be stable for unchanged inputs");

  assert.notEqual(await digest({ "/wt/panel": { sha: "moved99" } }), baseline, "a new source commit must change the digest");
  assert.notEqual(await digest({ "/base/panel": { sha: "advanced99" } }), baseline, "a moved base branch must change the digest");
  assert.notEqual(await digest({ "/base/panel": { dirty: true, dirtyPaths: ["x.ts"] } }), baseline, "a dirty base checkout must change the digest");
  assert.notEqual(await digest({ "/base/panel": { branch: "hotfix" } }), baseline, "a different checked-out branch must change the digest");
  assert.notEqual(await digest({ "/wt/panel": { branch: "feature/other" } }), baseline, "a different source branch must change the digest");
});

test("the digest changes when the run's verification evidence changes, and verification gates nothing", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const deps = {
    store,
    loadRegistry: mergeLoadRegistry(GROUP_PROJECT),
    git: scriptedGit(groupFixture()).git,
  };

  const none = (await mergeCommand({ runId: run.id }, deps)).preview;
  assert.equal(none.verification.status, "none");
  assert.equal(none.verification.verifiedAt, null);
  assert.equal(none.verification.staleRelativeToSource, null);
  assert.equal(none.mergeable, true, "no verification evidence must not block a merge");

  await store.appendEvent(run.id, { type: "verification", passed: false, exitCode: 1, results: [] });
  const failing = (await mergeCommand({ runId: run.id }, deps)).preview;
  assert.equal(failing.verification.status, "recorded");
  assert.equal(failing.verification.passed, false);
  assert.equal(failing.verification.exitCode, 1);
  assert.notEqual(failing.approvalDigest, none.approvalDigest, "verification evidence must enter the digest");
  assert.equal(failing.mergeable, true, "failing verification is surfaced, never gated");

  await store.appendEvent(run.id, { type: "verification", passed: true, exitCode: 0, results: [] });
  const passing = (await mergeCommand({ runId: run.id }, deps)).preview;
  assert.equal(passing.verification.passed, true);
  assert.notEqual(passing.approvalDigest, failing.approvalDigest, "rerunning verify must change the digest");
});

test("verification evidence older than the source commit is named as stale, and still gates nothing", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  await store.appendEvent(run.id, { type: "verification", passed: true, exitCode: 0, results: [] });
  const verifiedAt = JSON.parse(
    (await realFs.readFile(join(run.directory, "events.jsonl"), "utf8")).trim().split("\n").pop(),
  ).timestamp;

  const olderThanEvidence = new Date(Date.parse(verifiedAt) - 60_000).toISOString();
  const newerThanEvidence = new Date(Date.parse(verifiedAt) + 60_000).toISOString();
  const previewWith = async (committedAt) => (await mergeCommand(
    { runId: run.id },
    {
      store,
      loadRegistry: mergeLoadRegistry(GROUP_PROJECT),
      git: scriptedGit(groupFixture({ "/wt/backend": { committedAt } })).git,
    },
  )).preview;

  const fresh = await previewWith(olderThanEvidence);
  assert.equal(fresh.verification.staleRelativeToSource, false);

  const stale = await previewWith(newerThanEvidence);
  assert.equal(stale.verification.staleRelativeToSource, true);
  assert.equal(stale.mergeable, true, "stale evidence is surfaced, never gated");
  assert.notEqual(stale.approvalDigest, fresh.approvalDigest);

  const unknown = await previewWith(null);
  assert.equal(unknown.verification.staleRelativeToSource, null, "an unreadable commit date is unknown, never \"not stale\"");
});

test("executing with a stale digest is refused and names the current digest; executing with none is refused too", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const fixture = scriptedGit(groupFixture());
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );
  const approved = command.preview.approvalDigest;

  // The world moves: the source branch gained a commit between preview and execution.
  const movedFixture = scriptedGit(groupFixture({ "/wt/backend": { sha: "moved99" } }));
  const moved = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: movedFixture.git },
  );

  await assert.rejects(
    () => moved.execute({ approvalDigest: approved }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.equal(error.exitCode, MERGE_EXIT_CODES.refused);
      assert.match(error.message, /stale approval digest/i);
      assert.match(error.message, new RegExp(moved.preview.approvalDigest));
      return true;
    },
  );

  for (const supplied of [undefined, "", "not-a-digest", `${approved}x`]) {
    await assert.rejects(
      () => command.execute({ approvalDigest: supplied }),
      (error) => error instanceof WorkflowError && error.category === "PREFLIGHT",
      `supplying ${JSON.stringify(supplied)} must be refused`,
    );
  }

  assert.deepEqual(movedFixture.calls.filter((call) => call.method === "mergeBranch"), []);
  assert.deepEqual(fixture.calls.filter((call) => call.method === "mergeBranch"), []);
  assert.deepEqual(store.appendEventCalls, []);
});

// --- execution ---------------------------------------------------------------

test("a group merge runs sequentially and reports merged, failed, and never-attempted repositories separately", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/panel": { merge: { ok: false, code: 128, stderr: "error: Your local changes would be overwritten\n" } },
  }));
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.command, "merge");
  assert.equal(report.status, "partial");
  assert.equal(report.passed, false);
  assert.equal(report.exitCode, MERGE_EXIT_CODES.partial);
  assert.deepEqual(report.merged.map((entry) => entry.repositoryId), ["backend"]);
  assert.deepEqual(report.failed.map((entry) => entry.repositoryId), ["panel"]);
  assert.match(report.failed[0].reason, /local changes would be overwritten/);
  assert.deepEqual(report.skipped.map((entry) => entry.repositoryId), ["webapp"]);
  assert.match(report.skipped[0].reason, /never attempted/i);

  // Sequential, stopping at the first failure: webapp was never merged.
  assert.deepEqual(
    fixture.calls.filter((call) => call.method === "mergeBranch").map((call) => call.cwd),
    ["/base/backend", "/base/panel"],
  );

  // The evidence records the partial outcome rather than a success.
  assert.equal(store.appendEventCalls.length, 1);
  assert.equal(store.appendEventCalls[0].event.type, "merge");
  assert.equal(store.appendEventCalls[0].event.status, "partial");
  assert.equal(store.appendEventCalls[0].event.passed, false);
});

test("a first-repository failure reports a failed merge with nothing merged", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/backend": { merge: { ok: false, code: 1, stderr: "", error: "git merge timed out after 300000ms" } },
  }));
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "failed");
  assert.equal(report.exitCode, MERGE_EXIT_CODES.failed);
  assert.deepEqual(report.merged, []);
  assert.equal(report.failed.length, 1);
  // A timeout produces no stderr; the failure must still be named.
  assert.match(report.failed[0].reason, /timed out/);
  assert.deepEqual(report.skipped.map((entry) => entry.repositoryId), ["panel", "webapp"]);
});

test("the argv that runs is byte-identical to the argv the preview advertised", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture());
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );
  const previewed = command.preview.repositories.map((entry) => entry.argv);

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.deepEqual(report.merged.map((entry) => entry.argv), previewed);
  assert.deepEqual(
    fixture.calls.filter((call) => call.method === "mergeBranch").map((call) => expectedMergeArgv(call.source)),
    previewed,
  );
  for (const call of fixture.calls.filter((entry) => entry.method === "mergeBranch")) {
    assert.equal(typeof call.timeoutMs, "number", "the merge must be bounded");
  }
});

test("the merge lands in the run's event log in the shape workflow result can read back", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: scriptedGit(groupFixture()).git },
  );

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  const lines = (await realFs.readFile(join(run.directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const [event] = lines;
  assert.equal(event.type, "merge");
  assert.equal(event.runId, run.id);
  assert.equal(typeof event.id, "string");
  assert.equal(typeof event.timestamp, "string");
  assert.equal(event.status, "merged");
  assert.equal(event.passed, true);
  assert.equal(event.approvalDigest, report.approvalDigest);
  assert.deepEqual(event.merged.map((entry) => entry.repositoryId), ["backend"]);
  assert.equal(report.evidenceError, undefined);
});

test("a held run lock does not discard a merge that really happened; the report comes back with an evidenceError", async (t) => {
  const stateRoot = await tempStateRoot(t);
  let elapsedMs = 0;
  const store = createRunStore({
    stateRoot,
    clock: fixedClock("2026-08-06T00:00:00.000Z"),
    retryNow: () => elapsedMs,
    sleep: async (ms) => {
      elapsedMs += ms;
    },
  });
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const fixture = scriptedGit(groupFixture());
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  // Another in-flight command already holds the run lock.
  await realFs.mkdir(join(stateRoot, run.id, "run.lock", "active"), { recursive: true, mode: 0o700 });

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  // The merges are not undoable by rerunning, so the report of what really happened survives.
  assert.equal(report.status, "merged");
  assert.equal(report.exitCode, MERGE_EXIT_CODES.merged);
  assert.deepEqual(report.merged.map((entry) => entry.repositoryId), ["backend"]);
  assert.match(report.evidenceError, /evidence could not be persisted/i);
  assert.equal(fixture.calls.filter((call) => call.method === "mergeBranch").length, 1);
  await assert.rejects(() => realFs.readFile(join(run.directory, "events.jsonl"), "utf8"), { code: "ENOENT" });
});

// Important 1 (branch review), against REAL git in the exact topology the refusal exists for:
// a separate clone, not a linked worktree. The base checkout HAS the source object (it fetched
// it) so the old object-presence guard passes -- and its own branch of that name still points at
// an older commit, so `git merge feature/actual` would merge something other than the sha the
// preview predicted and the digest bound.
test("a base checkout holding the source object but a stale branch of that name is refused, even though the object is present", async (t) => {
  const store = await newStore(t);
  const root = await mkdtemp(join(tmpdir(), "workflow-merge-clone-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));

  const basePath = join(root, "base");
  await realFs.mkdir(basePath);
  await gitExec(root, ["init", "--initial-branch=dev", basePath]);
  await gitExec(basePath, ["config", "user.name", "Workflow Tests"]);
  await gitExec(basePath, ["config", "user.email", "workflow@example.test"]);
  await realFs.writeFile(join(basePath, "README.md"), "base\n");
  await gitExec(basePath, ["add", "README.md"]);
  await gitExec(basePath, ["commit", "-m", "initial"]);

  // A SEPARATE CLONE, not a linked worktree: its refs are its own.
  const clonePath = join(root, "clone");
  await gitExec(root, ["clone", basePath, clonePath]);
  await gitExec(clonePath, ["config", "user.name", "Workflow Tests"]);
  await gitExec(clonePath, ["config", "user.email", "workflow@example.test"]);
  await gitExec(clonePath, ["checkout", "-b", "feature/actual"]);
  await realFs.writeFile(join(clonePath, "feature.txt"), "work\n");
  await gitExec(clonePath, ["add", "feature.txt"]);
  await gitExec(clonePath, ["commit", "-m", "feature work"]);
  const cloneSha = (await gitExec(clonePath, ["rev-parse", "HEAD"])).stdout.trim();

  // The base checkout has a local branch of the same name at the OLD commit, and has fetched the
  // clone's objects -- so the new commit is present without the branch pointing at it.
  await gitExec(basePath, ["branch", "feature/actual", "dev"]);
  await gitExec(basePath, ["fetch", clonePath, "feature/actual"]);
  const baseBranchSha = (await gitExec(basePath, ["rev-parse", "feature/actual"])).stdout.trim();
  assert.notEqual(baseBranchSha, cloneSha, "the fixture must actually disagree");

  const git = realGit();
  // The load-bearing part: object presence alone -- the previous guard -- says this is fine.
  assert.equal(
    await git.refExists({ cwd: basePath, ref: cloneSha, kind: "commit" }),
    true,
    "the object IS present; object presence alone cannot catch this",
  );

  const run = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-3",
    repositories: [{ id: "primary", path: clonePath, branch: "feature/actual" }],
  });
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry({ acme: { repository: "monorepo", path: basePath, base_branch: "dev" } }), git },
  );

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, new RegExp(`resolves to ${baseBranchSha}`));
  assert.match(command.preview.reason, new RegExp(`is at ${cloneSha}`));
  assert.match(command.preview.reason, /previewing one commit and merging another/);

  const before = (await gitExec(basePath, ["rev-parse", "dev"])).stdout;
  await assert.rejects(
    () => command.execute({ approvalDigest: `sha256:${"0".repeat(64)}` }),
    (error) => error instanceof WorkflowError && error.exitCode === MERGE_EXIT_CODES.refused,
  );
  assert.equal((await gitExec(basePath, ["rev-parse", "dev"])).stdout, before);
});

// Important 2 (branch review): the property the whole digest design rests on. ONE mutable script
// and ONE command instance -- the world moves after the preview was taken, and `execute` must
// notice because it re-reads, not because a second preview was constructed for it.
test("execute re-reads the world: the same command instance refuses once the repositories move under it", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store, [GROUP_REPOSITORIES[0]]);
  const script = groupFixture();
  const fixture = scriptedGit(script);
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );
  const approved = command.preview.approvalDigest;

  // The worktree gains a commit between preview and approval. Nothing else changes, and no second
  // mergeCommand is built -- an execute that trusted its construction-time preview would merge.
  script["/wt/backend"] = { ...script["/wt/backend"], sha: "moved99" };

  await assert.rejects(
    () => command.execute({ approvalDigest: approved }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /stale approval digest/i);
      assert.notEqual(error.details.expected, approved);
      return true;
    },
  );
  assert.deepEqual(fixture.calls.filter((call) => call.method === "mergeBranch"), []);
  assert.deepEqual(store.appendEventCalls, []);

  // And the freshly computed digest is the one that works, against the world as it now is.
  const report = await command.execute({ approvalDigest: (await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  )).preview.approvalDigest });
  assert.equal(report.status, "merged");
  assert.equal(report.merged[0].sourceSha, "moved99");
});

// Minor (branch review): the "never discard a report of merges that already happened" property
// must not depend on another module keeping its never-throws contract.
test("a git adapter that breaks its contract and throws mid-sequence still reports the merge that already happened", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/base/panel": { merge: { throws: "git merge could not be spawned: EAGAIN" } },
  }));
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "partial");
  assert.equal(report.exitCode, MERGE_EXIT_CODES.partial);
  assert.deepEqual(report.merged.map((entry) => entry.repositoryId), ["backend"]);
  assert.deepEqual(report.failed.map((entry) => entry.repositoryId), ["panel"]);
  assert.match(report.failed[0].reason, /EAGAIN/);
  assert.deepEqual(report.skipped.map((entry) => entry.repositoryId), ["webapp"]);
  assert.equal(store.appendEventCalls.length, 1, "the partial outcome is still recorded");
});

// Minor (branch review): a refusal names what to go do, rather than leaving the renderer to
// invent one. Run-record problems point at reconcile, registry problems at doctor, and every
// refusal ends with the dry-run to come back to.
test("every refusal carries a concrete next action", async (t) => {
  const store = await newStore(t);
  const fixture = () => scriptedGit(groupFixture()).git;
  const previewFor = async (repositories, projects, ticket) => {
    const run = await store.create({ projectAlias: "sharyco", primaryTicket: ticket, ...(repositories ? { repositories } : {}) });
    return (await mergeCommand({ runId: run.id }, { store, loadRegistry: mergeLoadRegistry(projects), git: fixture() })).preview;
  };

  const noRepositories = await previewFor(null, GROUP_PROJECT, "N-1");
  assert.equal(noRepositories.refused, true);
  assert.deepEqual(noRepositories.nextActions, [
    `workflow reconcile --run ${noRepositories.runId}`,
    `workflow merge ${noRepositories.runId} --dry-run`,
  ]);

  const unknownProject = await previewFor(GROUP_REPOSITORIES, { other: {} }, "N-2");
  assert.deepEqual(unknownProject.nextActions, [
    "workflow doctor sharyco",
    `workflow merge ${unknownProject.runId} --dry-run`,
  ]);

  const noPath = await previewFor([{ id: "backend" }], GROUP_PROJECT, "N-3");
  assert.deepEqual(noPath.nextActions[0], `workflow reconcile --run ${noPath.runId}`);

  const noBaseBranch = await previewFor(
    [GROUP_REPOSITORIES[0]],
    { sharyco: { repository: "group", path: "/base/meta", repositories: { backend: { path: "/base/backend" } } } },
    "N-4",
  );
  assert.deepEqual(noBaseBranch.nextActions[0], "workflow doctor sharyco");

  // A conflicted (not refused) preview keeps its own single action; a mergeable one offers the
  // approval command with the digest already in it.
  const conflicted = (await mergeCommand(
    { runId: (await store.create({ projectAlias: "sharyco", primaryTicket: "N-5", repositories: [GROUP_REPOSITORIES[0]] })).id },
    {
      store,
      loadRegistry: mergeLoadRegistry(GROUP_PROJECT),
      git: scriptedGit(groupFixture({ "/base/backend": { dirty: true, dirtyPaths: ["x.ts"] } })).git,
    },
  )).preview;
  assert.deepEqual(conflicted.nextActions, [`workflow merge ${conflicted.runId} --dry-run`]);
});

// --- git.commitTimestamp -----------------------------------------------------
//
// Added to git.js by this task rather than task 1: `verification.staleRelativeToSource` cannot be
// answered without the source commit's own date, and no other adapter method carries one. Its
// tests live here, beside its only consumer, rather than in task 1's file.

test("commitTimestamp reads a real commit's committer date and answers null for a ref that is not there", async (t) => {
  const { basePath } = await realRepositoryPair(t);
  const git = realGit();

  const head = (await gitExec(basePath, ["rev-parse", "HEAD"])).stdout.trim();
  const timestamp = await git.commitTimestamp({ cwd: basePath, ref: head });
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
  assert.ok(Number.isFinite(Date.parse(timestamp)));

  assert.equal(await git.commitTimestamp({ cwd: basePath, ref: "refs/heads/nope" }), null);
});

test("commitTimestamp answers null rather than throwing when git cannot answer", async () => {
  const nonzero = createGitAdapter({
    runner: { async run() { return { code: 128, stdout: "", stderr: "fatal: bad object" }; } },
  });
  assert.equal(await nonzero.commitTimestamp({ cwd: "/repo", ref: "deadbeef" }), null);

  const throwing = createGitAdapter({
    runner: { async run() { throw new WorkflowError("PROCESS", "git timed out after 100ms", { exitCode: 12 }); } },
  });
  assert.equal(await throwing.commitTimestamp({ cwd: "/repo", ref: "deadbeef" }), null);

  // A value that is not a timestamp is not an answer -- the same fail-closed direction as
  // previewMerge's tree-oid validation.
  const garbage = createGitAdapter({
    runner: { async run() { return { code: 0, stdout: "not-a-date\n", stderr: "" }; } },
  });
  assert.equal(await garbage.commitTimestamp({ cwd: "/repo", ref: "deadbeef" }), null);

  const absent = createGitAdapter({ runner: { async run() { return { code: 0 }; } } });
  assert.equal(await absent.commitTimestamp({ cwd: "/repo", ref: "deadbeef" }), null);
});

test("executing a refused preview merges nothing and appends nothing", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await store.create({ projectAlias: "sharyco", primaryTicket: "S-refused" });
  const fixture = scriptedGit(groupFixture());
  const command = await mergeCommand(
    { runId: run.id },
    { store, loadRegistry: mergeLoadRegistry(GROUP_PROJECT), git: fixture.git },
  );

  await assert.rejects(
    () => command.execute({ approvalDigest: "sha256:" + "0".repeat(64) }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.exitCode, MERGE_EXIT_CODES.refused);
      assert.match(error.message, /no repositories/i);
      return true;
    },
  );
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(store.appendEventCalls, []);
});

// Roadmap item 2.4, task 3, step 5 and its review. A merge that fails at commit time leaves the
// base checkout mid-merge. The preview already refused (the dirty check is fail-closed and caught
// it), but it described the checkout only as "has 1 uncommitted path(s)" -- whose natural reading
// is `git add`/`git stash`, the wrong move -- and its ONLY next action was the dry-run that had
// just printed it, a loop with no exit. Real git throughout, because what is being asserted is
// what git actually leaves behind.
test("a base checkout left mid-merge is named as mid-merge, and its next action is the abort rather than the dry-run that just printed it", async (t) => {
  const store = await newStore(t);
  const { basePath, worktreePath } = await realRepositoryPair(t);
  const run = await store.create({
    projectAlias: "solo",
    primaryTicket: "A-1",
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/actual" }],
  });
  const deps = {
    store,
    loadRegistry: mergeLoadRegistry({ solo: { path: basePath, base_branch: "dev" } }),
    git: realGit(),
  };

  const clean = await mergeCommand({ runId: run.id }, deps);
  assert.equal(clean.preview.mergeable, true);
  assert.equal(clean.preview.repositories[0].baseMerging, false);

  // A hook that rejects at commit time: merge-tree predicts clean, the real merge stops mid-way.
  await realFs.writeFile(join(basePath, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const report = await clean.execute({ approvalDigest: clean.preview.approvalDigest });
  assert.equal(report.status, "failed");
  assert.equal(report.failed.length, 1);

  const blocked = (await mergeCommand({ runId: run.id }, deps)).preview;
  assert.equal(blocked.mergeable, false);
  assert.equal(blocked.repositories[0].baseMerging, true, "MERGE_HEAD is present in the base checkout");

  const reason = blocked.conflicts.map((conflict) => conflict.reason).join("\n");
  assert.match(reason, /in the middle of a merge \(MERGE_HEAD is present\)/);
  assert.match(reason, /merge --abort/);
  assert.match(reason, /staging or stashing those paths is not the fix/);

  // The loop-with-no-exit: the abort must come first, and the dry-run must not be the only action.
  assert.deepEqual(blocked.nextActions, [
    `git -C ${basePath} merge --abort`,
    `workflow merge ${run.id} --dry-run`,
  ]);

  // And the abort really is what clears it.
  await gitExec(basePath, ["merge", "--abort"]);
  const recovered = (await mergeCommand({ runId: run.id }, deps)).preview;
  assert.equal(recovered.repositories[0].baseMerging, false);
  assert.equal(recovered.mergeable, true);
});

test("a mid-merge base checkout changes the approval digest, so an approval taken before it cannot execute", async (t) => {
  const store = await newStore(t);
  const { basePath, worktreePath } = await realRepositoryPair(t);
  const run = await store.create({
    projectAlias: "solo",
    primaryTicket: "A-2",
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/actual" }],
  });
  const deps = {
    store,
    loadRegistry: mergeLoadRegistry({ solo: { path: basePath, base_branch: "dev" } }),
    git: realGit(),
  };

  const before = (await mergeCommand({ runId: run.id }, deps)).preview.approvalDigest;
  await gitExec(basePath, ["merge", "--no-commit", "--no-ff", "feature/actual"]);
  const after = (await mergeCommand({ runId: run.id }, deps)).preview;

  assert.equal(after.repositories[0].baseMerging, true);
  assert.notEqual(after.approvalDigest, before, "baseMerging blocks execution, so the digest must bind it");
});

// Fix round 2. `merging` is tri-state and git.js's checkoutState documents an unanswerable
// MERGE_HEAD probe as "cannot say" rather than "not merging" -- but commands.js was treating
// `null` exactly like `false`, so it neither blocked nor appeared anywhere. That is item 0.14's
// rule (an unreadable state is a conflict, never clean) applied to `dirty` right beside it and not
// to this. The residual window is narrow -- a `--no-commit` merge that staged nothing, plus a probe
// that failed while `git status` still worked -- but the direction is the binding constraint.
test("a base checkout whose in-progress-merge state cannot be read is a conflict, never clean", async (t) => {
  const store = await newStore(t);
  const script = groupFixture();
  // Clean in every other respect: on base_branch, no uncommitted paths, merge-tree says clean.
  script["/base/panel"] = { ...script["/base/panel"], merging: null };
  const fixture = scriptedGit(script);
  const run = await groupRun(store);

  const { preview } = await mergeCommand({ runId: run.id }, {
    store,
    loadRegistry: mergeLoadRegistry(GROUP_PROJECT),
    git: fixture.git,
  });

  assert.equal(preview.refused, false);
  assert.equal(preview.mergeable, false, "an unknown merge state must block; it must never fall through as clean");
  assert.equal(preview.exitCode, MERGE_EXIT_CODES.conflicted);
  assert.equal(preview.repositories[1].baseMerging, null);

  const conflict = preview.conflicts.find((entry) => entry.repositoryId === "panel");
  assert.ok(conflict, `panel must contribute a conflict: ${JSON.stringify(preview.conflicts)}`);
  assert.match(conflict.reason, /could not be checked for an in-progress merge \(MERGE_HEAD is unreadable\)/);
  assert.match(conflict.reason, /an unknown merge state is a conflict, never clean/);

  // And it really blocks: execute refuses rather than merging into a checkout it could not read.
  const command = await mergeCommand({ runId: run.id }, {
    store,
    loadRegistry: mergeLoadRegistry(GROUP_PROJECT),
    git: fixture.git,
  });
  await assert.rejects(
    () => command.execute({ approvalDigest: command.preview.approvalDigest }),
    (error) => {
      assert.equal(error.category, "CONFLICT");
      return true;
    },
  );
  assert.equal(fixture.calls.filter((call) => call.method === "mergeBranch").length, 0, "nothing may merge");
});

test("an unknown in-progress-merge state still names the uncommitted paths it did manage to read", async (t) => {
  const store = await newStore(t);
  const script = groupFixture();
  script["/base/panel"] = { ...script["/base/panel"], merging: null, dirty: true, dirtyPaths: ["src/a.ts", "src/b.ts"] };
  const fixture = scriptedGit(script);
  const run = await groupRun(store);

  const { preview } = await mergeCommand({ runId: run.id }, {
    store,
    loadRegistry: mergeLoadRegistry(GROUP_PROJECT),
    git: fixture.git,
  });

  const conflict = preview.conflicts.find((entry) => entry.repositoryId === "panel");
  assert.match(conflict.reason, /MERGE_HEAD is unreadable/);
  assert.match(conflict.reason, /with 2 uncommitted path\(s\): src\/a\.ts, src\/b\.ts/);
});
