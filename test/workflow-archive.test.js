import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as realFs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { archiveCommand, ARCHIVE_DISPLAY_LIMITS, ARCHIVE_EXIT_CODES } from "../src/workflow/commands.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { createProcessRunner } from "../src/workflow/process.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { LIVE_RUN_STATES, RUN_STATES } from "../src/workflow/run-state.js";

// --- archiveCommand (roadmap item 2.5) ---------------------------------------
//
// The same discipline verify (2.3) and merge (2.4) established: a REAL run store over a temp state
// root, with the registry, the git adapter, the Herdr adapter and the process inspector injected.
// A stubbed store hides exactly the defects that matter -- the run lock is one of this command's
// three gates, and it is a real directory on a real filesystem.
//
// Two tests use REAL git against real temp repositories, because the safety core of this command
// cannot be proven against a double: that an untracked-only worktree is refused by git itself and
// survives intact, and that a successful removal leaves the branch and its commits alone.

const execFileAsync = promisify(execFile);

async function gitExec(cwd, args) {
  return await execFileAsync("git", args, { cwd });
}

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-archive-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function fixedClock(timestamp) {
  return { now: () => timestamp };
}

function archiveLoadRegistry(projects) {
  return async () => ({ projects });
}

async function newStore(t) {
  const stateRoot = await tempStateRoot(t);
  return createRunStore({ stateRoot, clock: fixedClock("2026-08-07T00:00:00.000Z") });
}

// A run is always created `planned`; every other state is reached through the real state machine
// rather than by writing run.json by hand, so a test can never assert against a record shape the
// store would refuse to produce.
const STATE_PATHS = Object.freeze({
  [RUN_STATES.PLANNED]: [],
  [RUN_STATES.LAUNCHING]: ["launching"],
  [RUN_STATES.RUNNING]: ["launching", "running"],
  [RUN_STATES.IDLE_AWAITING_HANDOFF]: ["launching", "running", "idle-awaiting-handoff"],
  [RUN_STATES.NEEDS_INPUT]: ["launching", "running", "needs-input"],
  [RUN_STATES.BLOCKED]: ["launching", "running", "blocked"],
  [RUN_STATES.MANUAL_HANDOFF_REQUIRED]: ["launching", "running", "manual-handoff-required"],
  [RUN_STATES.RESULT_STALE]: ["launching", "running", "result-stale"],
  [RUN_STATES.COMPLETED]: ["launching", "running", "completed"],
  [RUN_STATES.FAILED]: ["launching", "failed"],
  [RUN_STATES.INTERRUPTED]: ["launching", "interrupted"],
});

async function advanceTo(store, runId, state) {
  for (const next of STATE_PATHS[state]) {
    await store.update(runId, () => ({ state: next }));
  }
  return await store.read(runId);
}

// The git double, scripted by path, mirroring test/workflow-merge.test.js's `scriptedGit`:
//
//   { "/wt/backend": { branch: "feature/x", sha: "aaa", dirtyPaths: [...], missing: true } }
//   { "/base/backend": { unmerged: { "feature/x": 3 } } }
//
// `removeWorktree` records the ENTIRE argument object it was handed, so a test can assert that no
// `force` key ever reaches it -- and it honours one if it ever did, which is what makes negative
// control 1 (a forcing implementation) fail the dirty test instead of silently passing.
function scriptedGit(script = {}) {
  const calls = [];
  const entryFor = (cwd) => script[cwd] ?? {};

  return {
    calls,
    script,
    removals: () => calls.filter((call) => call.method === "removeWorktree"),
    git: {
      async resolveHead({ cwd }) {
        calls.push({ method: "resolveHead", cwd });
        const entry = entryFor(cwd);
        if (entry.missing) throw new WorkflowError("PROCESS", `spawn git ENOENT (${cwd})`, { exitCode: 12 });
        if (entry.headError) throw new WorkflowError("PROCESS", entry.headError, { exitCode: 12 });
        return { branch: entry.branch ?? null, sha: entry.sha ?? "0".repeat(40) };
      },
      async checkoutState({ cwd }) {
        calls.push({ method: "checkoutState", cwd });
        const entry = entryFor(cwd);
        if (entry.missing) throw new WorkflowError("PROCESS", `spawn git ENOENT (${cwd})`, { exitCode: 12 });
        if (entry.headError) throw new WorkflowError("PROCESS", entry.headError, { exitCode: 12 });
        const merging = Object.hasOwn(entry, "merging") ? entry.merging : false;
        if (entry.dirty === null) {
          return { branch: entry.branch ?? null, dirty: null, entries: [], merging, statusError: entry.statusError ?? "git status failed" };
        }
        const entries = [
          ...(entry.dirtyPaths ?? []).map((path) => ({ x: " ", y: "M", path })),
          ...(entry.untrackedPaths ?? []).map((path) => ({ x: "?", y: "?", path })),
        ];
        return { branch: entry.branch ?? null, dirty: entries.length > 0, entries, merging };
      },
      async pendingOperation({ cwd, timeoutMs }) {
        calls.push({ method: "pendingOperation", cwd, timeoutMs });
        const entry = entryFor(cwd);
        if (entry.missing) throw new WorkflowError("PROCESS", `spawn git ENOENT (${cwd})`, { exitCode: 12 });
        return entry.pending ?? { status: "none" };
      },
      async isCommitReachable({ cwd, sha, timeoutMs }) {
        calls.push({ method: "isCommitReachable", cwd, sha, timeoutMs });
        // The real adapter answers `true` only on positive proof; a double that defaulted to true
        // would let the caller's fail-closed branch go untested forever.
        const entry = entryFor(cwd);
        return Array.isArray(entry.reachable) ? entry.reachable.includes(sha) : false;
      },
      async countCommitsNotIn({ cwd, base, branch, timeoutMs }) {
        calls.push({ method: "countCommitsNotIn", cwd, base, branch, timeoutMs });
        const entry = entryFor(cwd);
        if (!entry.unmerged) return null;
        const value = entry.unmerged[`${base}..${branch}`];
        return value === undefined ? null : value;
      },
      async removeWorktree(args) {
        calls.push({ method: "removeWorktree", ...args, args });
        const entry = entryFor(args.path);
        const argv = ["git", "worktree", "remove", ...(args.force ? ["--force"] : []), args.path];
        // Models real git 2.43, measured in Task 1: a dirty worktree exits 128 with this exact
        // clause -- UNLESS the caller forced, which is the whole point of the assertion below.
        if (entry.removeThrows) throw new WorkflowError("PROCESS", entry.removeThrows, { exitCode: 12 });
        if (entry.removeFails) {
          return { ok: false, code: entry.removeCode ?? 128, stdout: "", stderr: entry.removeFails, argv, reason: entry.removeReason ?? "failed" };
        }
        const isDirty = (entry.dirtyPaths ?? []).length > 0 || (entry.untrackedPaths ?? []).length > 0;
        if (isDirty && !args.force) {
          return {
            ok: false,
            code: 128,
            stdout: "",
            stderr: `fatal: '${args.path}' contains modified or untracked files, use --force to delete it`,
            argv,
            reason: "dirty",
          };
        }
        script[args.path] = { ...entry, removed: true };
        return { ok: true, code: 0, stdout: "", stderr: "", argv };
      },
    },
  };
}

function scriptedHerdr({ agents = [], listAgentsThrows = null, closeTab = { closed: true } } = {}) {
  const calls = [];
  return {
    calls,
    herdr: {
      async listAgents() {
        calls.push({ method: "listAgents" });
        if (listAgentsThrows) throw new WorkflowError("PROCESS", listAgentsThrows, { exitCode: 12 });
        return { agents };
      },
      async closeTab(args) {
        calls.push({ method: "closeTab", ...args });
        return typeof closeTab === "function" ? closeTab(args) : closeTab;
      },
    },
  };
}

// Owner-marker probes for the three ownership verdicts item 1.1 defined. `null` is inspectExact's
// positive proof of absence; a throw is its ambiguity signal.
const OWNER_ALIVE = async () => ({ pid: "4242", startedAt: "2026-08-07T00:00:00Z" });
const OWNER_GONE = async () => null;
const OWNER_UNPROVABLE = async () => {
  throw new Error("ps failed");
};

// The lock double also SPIES on removeLock, because "archive must not remove the lock itself" is a
// gate property no other assertion covers: an earlier round asserted `typeof store.removeLock ===
// "function"`, which is true of every store and says nothing about whether archive called it.
function withLockHeld(store, marker, extra = {}) {
  const removeLockCalls = [];
  return {
    ...store,
    removeLockCalls,
    async inspectLock() {
      return { activePath: "/state/lock/active", markerPath: "/state/lock/active/owner-1.json", marker, ageMs: 1000, stale: false, markerAmbiguous: false, ...extra };
    },
    async removeLock(runId, options) {
      removeLockCalls.push({ runId, options });
      return await store.removeLock(runId, options);
    },
  };
}

function withAppendSpy(store) {
  const appendEventCalls = [];
  return {
    ...store,
    appendEventCalls,
    async appendEvent(runId, event) {
      appendEventCalls.push({ runId, event });
      return await store.appendEvent(runId, event);
    },
  };
}

// --- fixtures ---------------------------------------------------------------

const GROUP_PROJECT = {
  sharyco: {
    label: "Sharyco",
    repository: "group",
    // The group's META-repository. Measuring an unmerged count here would measure the wrong
    // repository entirely -- one of the refusal tests below asserts it is never reached.
    path: "/base/meta",
    base_branch: "main",
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

function groupFixture(overrides = {}) {
  const script = {
    "/wt/backend": { branch: "feature/actual", sha: "aaaa111" },
    "/wt/panel": { branch: "feature/actual", sha: "bbbb222" },
    "/wt/webapp": { branch: "feature/actual", sha: "cccc333" },
    "/base/backend": { unmerged: { "dev..feature/actual": 0 } },
    "/base/panel": { unmerged: { "dev..feature/actual": 0 } },
    "/base/webapp": { unmerged: { "dev..feature/actual": 0 } },
  };
  for (const [path, entry] of Object.entries(overrides)) {
    script[path] = { ...script[path], ...entry };
  }
  return script;
}

async function groupRun(store, { repositories = GROUP_REPOSITORIES, state = RUN_STATES.COMPLETED, ...extra } = {}) {
  const run = await store.create({ projectAlias: "sharyco", primaryTicket: "S-1", repositories, tabId: "w2M:t1", ...extra });
  return await advanceTo(store, run.id, state);
}

// The single-repository ordinary project, which is the shape every real monorepo run has.
const ACME_PROJECT = { acme: { label: "Acme", repository: "monorepo", path: "/base/acme", base_branch: "dev" } };

function acmeFixture(overrides = {}) {
  const script = {
    "/wt/acme": { branch: "feature/actual", sha: "aaaa111" },
    "/base/acme": { unmerged: { "dev..feature/actual": 0 } },
  };
  for (const [path, entry] of Object.entries(overrides)) {
    script[path] = { ...script[path], ...entry };
  }
  return script;
}

async function acmeRun(store, { state = RUN_STATES.COMPLETED, path = "/wt/acme", ...extra } = {}) {
  const run = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [{ id: "primary", path, branch: "feature/recorded" }],
    tabId: "w2M:t1",
    ...extra,
  });
  return await advanceTo(store, run.id, state);
}

// A worktree path that exists on disk, so the preview's presence probe can tell "vanished" from
// "unreadable". Every scripted-git test needs one, because absence is proven with fs.stat.
function presentFs(paths) {
  const present = new Set(paths);
  return {
    async stat(path) {
      if (present.has(path)) return { isDirectory: () => true };
      const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
      error.code = "ENOENT";
      throw error;
    },
  };
}

function archiveDeps(store, { git, herdr, project = ACME_PROJECT, inspectProcess = OWNER_GONE, present = [] } = {}) {
  return {
    store,
    loadRegistry: archiveLoadRegistry(project),
    git,
    herdr: herdr ?? scriptedHerdr().herdr,
    inspectProcess,
    fs: presentFs(present),
    now: () => "2026-08-07T12:00:00.000Z",
  };
}

function assertNothingHappened(fixture, herdrFixture) {
  assert.deepEqual(fixture.removals(), [], "a refusal must remove nothing");
  assert.deepEqual(
    (herdrFixture?.calls ?? []).filter((call) => call.method === "closeTab"),
    [],
    "a refusal must close no tab",
  );
}

// --- the safety core --------------------------------------------------------

test("a dirty worktree refuses the whole run and removes nothing, including from the other repositories", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/wt/panel": { dirtyPaths: ["src/edited.ts"], untrackedPaths: [".env.local"] },
  }));
  const herdr = scriptedHerdr();

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: herdr.herdr,
    project: GROUP_PROJECT,
    present: ["/wt/backend", "/wt/panel", "/wt/webapp"],
  }));

  assert.equal(command.preview.refused, true);
  assert.equal(command.preview.removable, false);
  assert.equal(command.preview.approvalDigest, null, "a refused preview offers nothing to approve");
  assert.equal(command.preview.exitCode, ARCHIVE_EXIT_CODES.refused);
  assert.match(command.preview.reason, /panel/);
  assert.match(command.preview.reason, /src\/edited\.ts/, "the refusal must name the files");
  assert.match(command.preview.reason, /\.env\.local/);
  assertNothingHappened(fixture, herdr);

  // The whole run refuses: the two CLEAN repositories are not archived either.
  await assert.rejects(
    () => command.execute({ approvalDigest: "sha256:" + "a".repeat(64) }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.exitCode, ARCHIVE_EXIT_CODES.refused);
      return true;
    },
  );
  assertNothingHappened(fixture, herdr);
  assert.deepEqual(store.appendEventCalls, [], "a refusal appends nothing");
  assert.equal((await store.read(run.id)).archivedAt, undefined, "a refusal marks nothing");
});

test("removeWorktree is never handed a force option, on any path this command can take", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture());

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    project: GROUP_PROJECT,
    present: ["/wt/backend", "/wt/panel", "/wt/webapp"],
  }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "archived");
  assert.equal(fixture.removals().length, 3);
  for (const call of fixture.removals()) {
    assert.equal(Object.hasOwn(call.args, "force"), false, "no force key may reach the adapter");
    assert.deepEqual(Object.keys(call.args).sort(), ["cwd", "path", "timeoutMs"]);
    assert.equal(typeof call.timeoutMs, "number");
    assert.ok(call.timeoutMs > 0, "an irreversible removal must be bounded");
  }
});

test("an untracked-only worktree refuses, and its remedy is named as cleaning rather than committing", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/wt/acme": { untrackedPaths: ["node_modules/index.js", ".env.local"] } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /untracked/i);
  assert.doesNotMatch(command.preview.reason, /2 uncommitted/, "untracked files are not uncommitted edits");
  assert.match(command.preview.reason, /node_modules\/index\.js/);
  assert.ok(
    command.preview.nextActions.some((action) => /git -C \/wt\/acme clean/.test(action)),
    `the untracked remedy must be named: ${JSON.stringify(command.preview.nextActions)}`,
  );
  assertNothingHappened(fixture);
});

test("a worktree with modified tracked files names committing or stashing, not cleaning", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/wt/acme": { dirtyPaths: ["src/a.ts"] } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /src\/a\.ts/);
  assert.ok(command.preview.nextActions.some((action) => /git -C \/wt\/acme status/.test(action)));
  assert.ok(
    !command.preview.nextActions.some((action) => /clean/.test(action)),
    "cleaning would destroy tracked edits",
  );
});

test("a worktree whose status cannot be read refuses rather than being treated as clean", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/wt/acme": { dirty: null, statusError: "index.lock exists" } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /could not be read/i);
  assert.match(command.preview.reason, /index\.lock exists/);
  assertNothingHappened(fixture);
});

test("a worktree reported dirty with no enumerable paths still refuses, with a legible reason", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  // An adapter that answers the flag without the list, or a status entry with no path at all.
  const git = {
    ...fixture.git,
    async checkoutState() {
      return { branch: "feature/actual", dirty: true, entries: [{ x: " ", y: "M" }], merging: false };
    },
  };

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /did not enumerate/);
  assert.doesNotMatch(command.preview.reason, /has \./, "the reason must not read like a truncation bug");
  assertNothingHappened(fixture);
});

test("a worktree stopped inside any unfinished operation refuses, naming that operation's own remedy", async (t) => {
  const operations = [
    ["rebase", "git rebase --abort"],
    ["am", "git am --abort"],
    ["merge", "git merge --abort"],
    ["cherry-pick", "git cherry-pick --abort"],
    ["revert", "git revert --abort"],
    ["bisect", "git bisect reset"],
  ];
  for (const [operation, remedy] of operations) {
    const store = await newStore(t);
    const run = await acmeRun(store);
    const fixture = scriptedGit(acmeFixture({
      "/wt/acme": { pending: { status: "in-progress", operation, path: `/wt/acme/.git/${operation}`, remedy } },
    }));

    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

    assert.equal(command.preview.refused, true, `${operation} must refuse`);
    assert.match(command.preview.reason, new RegExp(operation.replace("-", "\\-")), operation);
    assert.ok(
      command.preview.nextActions.some((action) => action === `git -C /wt/acme ${remedy.replace(/^git /, "")}`),
      `${operation} must name its own remedy, not the merge one: ${JSON.stringify(command.preview.nextActions)}`,
    );
    assertNothingHappened(fixture);
  }
});

test("an unknown in-progress-operation state refuses, because unknown is never idle", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({
    "/wt/acme": { pending: { status: "unknown", reason: "EACCES: permission denied" } },
  }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /unfinished git operation/);
  assert.match(command.preview.reason, /EACCES/);
  assertNothingHappened(fixture);
});

// --- gate 1: run state ------------------------------------------------------

test("a run in any live state refuses, naming the state, before any worktree is inspected", async (t) => {
  for (const state of LIVE_RUN_STATES) {
    const store = withAppendSpy(await newStore(t));
    const run = await acmeRun(store, { state });
    const fixture = scriptedGit(acmeFixture());
    const herdr = scriptedHerdr();

    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
      git: fixture.git,
      herdr: herdr.herdr,
      present: ["/wt/acme"],
    }));

    assert.equal(command.preview.refused, true, `${state} must refuse`);
    assert.match(command.preview.reason, new RegExp(state.replace(/[-]/g, "\\-")), `the refusal must name ${state}`);
    assert.equal(command.preview.runState, state);
    assert.deepEqual(fixture.calls, [], "the state gate runs before any git call");
    assertNothingHappened(fixture, herdr);
    assert.deepEqual(store.appendEventCalls, []);
  }
});

test("each of completed, failed and interrupted archives", async (t) => {
  for (const state of [RUN_STATES.COMPLETED, RUN_STATES.FAILED, RUN_STATES.INTERRUPTED]) {
    const store = await newStore(t);
    const run = await acmeRun(store, { state });
    const fixture = scriptedGit(acmeFixture());

    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));
    assert.equal(command.preview.refused, false, `${state} must be archivable`);

    const report = await command.execute({ approvalDigest: command.preview.approvalDigest });
    assert.equal(report.status, "archived", `${state} must archive`);
  }
});

// --- gate 2: the run lock ---------------------------------------------------

test("a lock whose owner is alive refuses and names workflow unlock, and archive removes no lock", async (t) => {
  const base = await newStore(t);
  const run = await acmeRun(base, {});
  const store = withAppendSpy(withLockHeld(base, { version: 2, pid: 4242, startedAt: "2026-08-07T00:00:00Z" }));
  const fixture = scriptedGit(acmeFixture());

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    inspectProcess: OWNER_ALIVE,
    present: ["/wt/acme"],
  }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /lock/i);
  assert.ok(
    command.preview.nextActions.some((action) => action === `workflow unlock ${run.id} --yes`),
    `the refusal must name workflow unlock: ${JSON.stringify(command.preview.nextActions)}`,
  );
  assert.deepEqual(store.removeLockCalls, [], "archive must never remove a lock, refused or not");
  assert.deepEqual(fixture.calls, [], "the lock gate runs before any git call");
  assertNothingHappened(fixture);
});

test("an unprovable ownership verdict refuses; elapsed time alone authorizes nothing", async (t) => {
  const base = await newStore(t);
  const run = await acmeRun(base, {});
  const fixture = scriptedGit(acmeFixture());

  // Three independent routes to `unprovable`: inspection threw, the marker predates provable
  // ownership, and the marker is not a readable object at all. A very old, very stale lock is
  // used for the first, so "it has been sitting there for hours" cannot be mistaken for proof.
  const cases = [
    { marker: { version: 2, pid: 4242, startedAt: "2026-08-01T00:00:00Z" }, inspectProcess: OWNER_UNPROVABLE, extra: { ageMs: 6 * 60 * 60 * 1000, stale: true } },
    { marker: { version: 1 }, inspectProcess: OWNER_GONE, extra: {} },
    { marker: null, inspectProcess: OWNER_GONE, extra: { markerAmbiguous: true } },
  ];

  for (const { marker, inspectProcess, extra } of cases) {
    const store = withAppendSpy(withLockHeld(base, marker, extra));
    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
      git: fixture.git,
      inspectProcess,
      present: ["/wt/acme"],
    }));

    assert.equal(command.preview.refused, true, `marker ${JSON.stringify(marker)} must refuse`);
    assert.match(command.preview.reason, /lock/i);
    assert.equal(command.preview.lock.ownership.verdict, "unprovable");
    assert.deepEqual(store.removeLockCalls, [], "an unprovable verdict must not lead to a removal either");
    assertNothingHappened(fixture);
  }
});

test("a lock whose owner is proven gone does not block the archive, and a SUCCESSFUL archive still never removes it", async (t) => {
  const base = await newStore(t);
  const run = await acmeRun(base, {});
  const store = withLockHeld(base, { version: 2, pid: 4242, startedAt: "2026-08-07T00:00:00Z" });
  const fixture = scriptedGit(acmeFixture());

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    inspectProcess: OWNER_GONE,
    present: ["/wt/acme"],
  }));

  assert.equal(command.preview.refused, false, "a proven-dead owner is exactly what item 1.1 makes recoverable");
  assert.equal(command.preview.lock.held, true);
  assert.equal(command.preview.lock.ownership.removable, true);
  // Archive does not remove the lock -- that stays `workflow unlock`'s job -- but the persistence
  // step below still has to take it, so the way out is named up front.
  assert.ok(
    command.preview.nextActions.some((action) => action === `workflow unlock ${run.id} --yes`),
    `a held lock must still name the command that clears it: ${JSON.stringify(command.preview.nextActions)}`,
  );

  // The gate property, asserted across the path that actually removes things: a run whose lock is
  // provably recoverable is the ONE case where an implementation might be tempted to clear it on
  // the way past, and it must not.
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });
  assert.equal(report.status, "archived");
  assert.deepEqual(fixture.removals().map((call) => call.path), ["/wt/acme"]);
  assert.deepEqual(store.removeLockCalls, [], "a successful archive must still leave the lock alone");
  // There used to be an `assert.notEqual(await store.inspectLock(run.id), null)` here. It passed
  // unconditionally: `withLockHeld` overrides `inspectLock` to return a fabricated lock on every
  // call, so it asserted a property of the test double rather than of archive. The real property --
  // "archive never removes the lock" -- is the removeLockCalls assertion above, which IS
  // mutation-checked (M1). Removed rather than reworded, because there is no non-vacuous version:
  // the lock in this fixture only ever existed inside the double.
});

test("a store that cannot answer whether a lock is held refuses rather than assuming none", async (t) => {
  const base = await newStore(t);
  const run = await acmeRun(base, {});
  const fixture = scriptedGit(acmeFixture());

  const withoutInspect = { ...base };
  delete withoutInspect.inspectLock;
  const throwing = { ...base, async inspectLock() { throw new Error("EACCES: permission denied"); } };

  for (const store of [withoutInspect, throwing]) {
    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
      git: fixture.git,
      present: ["/wt/acme"],
    }));
    assert.equal(command.preview.refused, true);
    assert.match(command.preview.reason, /lock/i);
    assertNothingHappened(fixture);
  }
});

// --- gate 3: the agent ------------------------------------------------------

test("a run whose agent still resolves live in Herdr refuses", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await acmeRun(store, { paneId: "w2W:p3" });
  const fixture = scriptedGit(acmeFixture());
  const herdr = scriptedHerdr({ agents: [{ pane_id: "w2W:p3", agent_status: "idle" }] });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: herdr.herdr,
    present: ["/wt/acme"],
  }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /agent/i);
  assert.match(command.preview.reason, /w2W:p3/);
  assert.deepEqual(fixture.calls, [], "the agent gate runs before any git call");
  assertNothingHappened(fixture, herdr);
  assert.deepEqual(store.appendEventCalls, []);
});

test("the agent is correlated by transportIdentity.paneId first, the order workflow inbox established", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store, {
    // executeResume leaves the top-level paneId naming the pane Herdr already closed.
    paneId: "w2W:stale",
    transportIdentity: { kind: "pi-session", sessionId: "s2", paneId: "w2W:live", harness: "pi" },
  });
  const fixture = scriptedGit(acmeFixture());
  const herdr = scriptedHerdr({ agents: [{ pane_id: "w2W:live", agent_status: "working" }] });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: herdr.herdr,
    present: ["/wt/acme"],
  }));

  assert.equal(command.preview.refused, true, "reading run.paneId first would have missed the live agent");
  assert.match(command.preview.reason, /w2W:live/);
});

test("BOTH the transport pane and the top-level pane are checked, not just the correlated one", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store, {
    paneId: "w2W:original",
    transportIdentity: { kind: "pi-session", sessionId: "s2", paneId: "w2W:relaunched", harness: "pi" },
  });
  const fixture = scriptedGit(acmeFixture());
  // Correlation resolves to the transport pane, which has no agent -- but the ORIGINAL pane still
  // hosts a live one. Checking only the correlated pane would archive a run someone is working in.
  const herdr = scriptedHerdr({ agents: [{ pane_id: "w2W:original", agent_status: "working" }] });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: herdr.herdr,
    present: ["/wt/acme"],
  }));

  assert.equal(command.preview.refused, true, "a live agent on the stale pane is still a live agent");
  assert.match(command.preview.reason, /w2W:original/);
  assertNothingHappened(fixture, herdr);

  // With neither pane hosting an agent, both are named as having been checked.
  const quiet = scriptedHerdr({ agents: [] });
  const allowed = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: quiet.herdr,
    present: ["/wt/acme"],
  }));
  assert.equal(allowed.preview.refused, false);
  assert.deepEqual(allowed.preview.agent.checkedPaneIds, ["w2W:relaunched", "w2W:original"]);
  assert.equal(allowed.preview.agent.paneId, "w2W:relaunched", "the reported pane stays the correlated one");
});

test("a Herdr that cannot answer refuses; a Herdr that answers and knows the pane not is proof of absence", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store, { paneId: "w2W:p3" });
  const fixture = scriptedGit(acmeFixture());

  const unavailable = scriptedHerdr({ listAgentsThrows: "herdr: connection refused" });
  const refused = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: unavailable.herdr,
    present: ["/wt/acme"],
  }));
  assert.equal(refused.preview.refused, true);
  assert.match(refused.preview.reason, /Herdr/);
  assertNothingHappened(fixture, unavailable);

  const answered = scriptedHerdr({ agents: [{ pane_id: "w2W:someone-else", agent_status: "working" }] });
  const allowed = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: answered.herdr,
    present: ["/wt/acme"],
  }));
  assert.equal(allowed.preview.refused, false);
  assert.equal(allowed.preview.agent.paneId, "w2W:p3");
  assert.equal(allowed.preview.agent.resolved, false);
});

test("a run that never recorded a pane needs no Herdr answer and is archivable", async (t) => {
  const store = await newStore(t);
  // The real shape of run 273432a7: `failed`, with neither tabId nor paneId -- it died before
  // agent creation.
  const run = await acmeRun(store, { state: RUN_STATES.FAILED, tabId: null });
  const fixture = scriptedGit(acmeFixture());
  const herdr = scriptedHerdr({ listAgentsThrows: "herdr: connection refused" });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: herdr.herdr,
    present: ["/wt/acme"],
  }));

  assert.equal(command.preview.refused, false, "a run with no agent has no agent to prove gone");
  assert.equal(command.preview.agent.paneId, null);

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });
  assert.equal(report.status, "archived");
  assert.deepEqual(herdr.calls.filter((call) => call.method === "closeTab"), [], "no recorded tab is not a tab failure");
  assert.equal(report.tab.closed, false);
  assert.equal(report.tab.reason, "no-tab-recorded");
});

// --- the losses -------------------------------------------------------------

test("unmerged commits are counted, surfaced, digested, and do not refuse", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/base/acme": { unmerged: { "dev..feature/actual": 3 } } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, false, "unmerged work warns; it never refuses");
  assert.equal(command.preview.removable, true);
  assert.equal(command.preview.repositories[0].unmergedCommits, 3);
  assert.deepEqual(
    command.preview.losses.map((loss) => ({ kind: loss.kind, count: loss.count })),
    [{ kind: "unmerged-commits", count: 3 }],
  );
  // The count is read in the BASE checkout, which is the only place both refs resolve.
  const counts = fixture.calls.filter((call) => call.method === "countCommitsNotIn");
  assert.deepEqual(counts.map((call) => ({ cwd: call.cwd, base: call.base, branch: call.branch })), [
    { cwd: "/base/acme", base: "dev", branch: "feature/actual" },
  ]);
  assert.ok(counts.every((call) => typeof call.timeoutMs === "number" && call.timeoutMs > 0));

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });
  assert.equal(report.status, "archived");
  const [event] = store.appendEventCalls.map((call) => call.event);
  assert.equal(event.type, "archive");
  assert.equal(event.repositories[0].unmergedCommits, 3, "the loss outlives the worktree in the event log");
});

test("an unmeasurable unmerged count is unknown, never zero, and digests differently from zero", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);

  const unknown = scriptedGit(acmeFixture({ "/base/acme": { unmerged: {} } }));
  const unknownCommand = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: unknown.git, present: ["/wt/acme"] }));
  assert.equal(unknownCommand.preview.repositories[0].unmergedCommits, null);
  assert.deepEqual(unknownCommand.preview.losses.map((loss) => loss.kind), ["unmerged-commits-unknown"]);

  const merged = scriptedGit(acmeFixture());
  const mergedCommand = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: merged.git, present: ["/wt/acme"] }));
  assert.equal(mergedCommand.preview.repositories[0].unmergedCommits, 0);
  assert.deepEqual(mergedCommand.preview.losses, [], "fully merged is nothing to warn about");

  assert.notEqual(
    unknownCommand.preview.approvalDigest,
    mergedCommand.preview.approvalDigest,
    "unknown must never digest as 0",
  );
});

test("a vanished worktree archives cleanly, and its unmeasurable loss is reported as unknown", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/wt/acme": { missing: true } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: [] }));

  assert.equal(command.preview.refused, false, "a vanished directory is the residue this command reclaims");
  assert.equal(command.preview.repositories[0].present, false);
  assert.equal(command.preview.repositories[0].dirty, false);
  assert.equal(command.preview.repositories[0].branch, null);
  assert.equal(command.preview.repositories[0].unmergedCommits, null);
  assert.deepEqual(command.preview.losses.map((loss) => loss.kind), ["unmerged-commits-unknown"]);
  assert.deepEqual(
    fixture.calls.filter((call) => call.method === "checkoutState"),
    [],
    "a directory that is not there cannot be inspected",
  );

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });
  assert.equal(report.status, "archived");
  assert.deepEqual(fixture.removals().map((call) => call.path), ["/wt/acme"], "git still deregisters it");
});

// --- the detached-HEAD split: reachability decides ---------------------------
//
// The design's acceptance criterion is unconditional: "Archiving a run never destroys a commit."
// A detached HEAD is two different situations under that criterion, and only reachability tells
// them apart -- so the rule is keyed on reachability rather than on detachment.

test("a detached HEAD whose commit some ref contains is a warning, not a refusal", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({
    "/wt/acme": { branch: null, sha: "aaaa111" },
    "/base/acme": { reachable: ["aaaa111"] },
  }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, false, "the commit survives on a ref; nothing is destroyed");
  assert.equal(command.preview.repositories[0].branch, null);
  assert.equal(command.preview.repositories[0].headReachable, true);
  assert.ok(command.preview.losses.some((loss) => loss.kind === "detached-head"));
  // Reachability is asked in the BASE checkout, which is where the ref store lives.
  assert.deepEqual(
    fixture.calls.filter((call) => call.method === "isCommitReachable").map((call) => ({ cwd: call.cwd, sha: call.sha })),
    [{ cwd: "/base/acme", sha: "aaaa111" }],
  );
  assert.deepEqual(fixture.calls.filter((call) => call.method === "countCommitsNotIn"), [], "there is no branch to measure against");
});

test("a detached HEAD no ref contains refuses, and names giving those commits a branch", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/wt/acme": { branch: null, sha: "0rphan1" }, "/base/acme": { reachable: [] } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /detached HEAD/);
  assert.match(command.preview.reason, /never destroy/);
  assert.ok(command.preview.nextActions.some((action) => action === "git -C /wt/acme switch -c <branch-name>"));
  assert.equal(command.preview.approvalDigest, null);
  assertNothingHappened(fixture);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a detached HEAD whose reachability cannot be determined refuses, and an unresolvable sha does too", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);

  // An adapter that breaks its never-throws contract, and a HEAD with no resolvable sha. Both are
  // "could not find out", and both must take the refusing branch rather than the warning one.
  const base = scriptedGit(acmeFixture({ "/wt/acme": { branch: null, sha: "0rphan1" } }));
  const throwing = {
    ...base.git,
    async isCommitReachable() {
      throw new WorkflowError("PROCESS", "spawn git EAGAIN", { exitCode: 12 });
    },
  };
  const thrown = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: throwing, present: ["/wt/acme"] }));
  assert.equal(thrown.preview.refused, true);
  assert.match(thrown.preview.reason, /detached HEAD/);

  const noSha = scriptedGit(acmeFixture({ "/wt/acme": { branch: null, sha: "" } }));
  const unresolvable = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: noSha.git, present: ["/wt/acme"] }));
  assert.equal(unresolvable.preview.refused, true);
  assert.match(unresolvable.preview.reason, /unresolvable commit/);
  assert.deepEqual(
    noSha.calls.filter((call) => call.method === "isCommitReachable"),
    [],
    "there is no sha to ask about",
  );
});

test("reachability lost between preview and execute refuses at the recompute, and removes nothing", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({
    "/wt/acme": { branch: null, sha: "aaaa111" },
    "/base/acme": { reachable: ["aaaa111"], unmerged: {} },
  }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));
  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.repositories[0].headReachable, true);
  const digest = command.preview.approvalDigest;

  // The operator deletes the branch that was containing it -- the commit is now referenced by
  // nothing but this worktree's own HEAD.
  fixture.script["/base/acme"] = { ...fixture.script["/base/acme"], reachable: [] };

  // This is what actually protects, and it is the recompute rather than the digest comparison:
  // execute rebuilds the whole preview first, so a world that became irrecoverable is refused
  // before the approved digest is even looked at. `headReachable` is also bound into the digest so
  // the approval record names the fact that was checked, but the refusal below is the guard.
  await assert.rejects(
    () => command.execute({ approvalDigest: digest }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.equal(error.exitCode, ARCHIVE_EXIT_CODES.refused);
      assert.match(error.message, /detached HEAD/);
      return true;
    },
  );
  assert.deepEqual(fixture.removals(), []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a worktree on a branch is not asked about reachability at all", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.repositories[0].headReachable, null, "the branch ref IS the answer");
  assert.deepEqual(fixture.calls.filter((call) => call.method === "isCommitReachable"), []);
});

test("real git: an interrupted rebase leaves a clean, detached, unreachable worktree — and archive refuses it", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const { basePath, worktreePath } = await realRun(t);

  // The measured path from "clean archive" to "destroyed commit", built with real git:
  // dev advances, then an interactive rebase stops at a `break` after re-applying one commit.
  await realFs.writeFile(join(basePath, "base.txt"), "base advances\n");
  await gitExec(basePath, ["add", "base.txt"]);
  await gitExec(basePath, ["commit", "-m", "base advance"]);
  await realFs.writeFile(join(worktreePath, "second.txt"), "w2\n");
  await gitExec(worktreePath, ["add", "second.txt"]);
  await gitExec(worktreePath, ["commit", "-m", "w2"]);
  await execFileAsync("git", ["rebase", "-i", "dev"], {
    cwd: worktreePath,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: 'sed -i "2i break"' },
  });

  // Everything the OLD gates looked at says "archivable".
  const status = await gitExec(worktreePath, ["status", "--porcelain"]);
  assert.equal(status.stdout, "", "the tree really is clean");
  const branch = await gitExec(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(branch.stdout.trim(), "HEAD", "and really is detached");
  const detachedSha = (await gitExec(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  const containing = await gitExec(basePath, ["for-each-ref", "--count=1", "--contains", detachedSha]);
  assert.equal(containing.stdout.trim(), "", "and its commit really is referenced by no ref");

  const created = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/actual" }],
    tabId: "w2M:t1",
  });
  const run = await advanceTo(store, created.id, RUN_STATES.COMPLETED);

  const command = await archiveCommand({ runId: run.id }, {
    store,
    loadRegistry: archiveLoadRegistry({ acme: { label: "Acme", repository: "monorepo", path: basePath, base_branch: "dev" } }),
    git: realGit(),
    herdr: scriptedHerdr().herdr,
    inspectProcess: OWNER_GONE,
  });

  assert.equal(command.preview.refused, true, "this is the case that would have destroyed a commit");
  // The rebase is caught first, which is the more actionable fact and the right remedy.
  assert.match(command.preview.reason, /middle of a rebase/);
  assert.ok(command.preview.nextActions.some((action) => /git -C .* rebase --abort/.test(action)));
  assert.equal(command.preview.approvalDigest, null);

  // Nothing removed, and the commit is still there.
  await realFs.access(worktreePath);
  assert.equal((await gitExec(worktreePath, ["cat-file", "-t", detachedSha])).stdout.trim(), "commit");
  assert.deepEqual(store.appendEventCalls, []);
});

test("real git: a detached HEAD with no unfinished operation and no containing ref still refuses", async (t) => {
  const store = await newStore(t);
  const { basePath, worktreePath } = await realRun(t);

  // The same danger without the rebase: an operator detached and committed. No `rebase-merge`, a
  // clean tree -- only reachability can tell this apart from a harmless detached checkout.
  await gitExec(worktreePath, ["checkout", "--detach"]);
  await realFs.writeFile(join(worktreePath, "orphan.txt"), "only copy\n");
  await gitExec(worktreePath, ["add", "orphan.txt"]);
  await gitExec(worktreePath, ["commit", "-m", "orphaned work"]);
  const orphan = (await gitExec(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

  const created = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/actual" }],
  });
  const run = await advanceTo(store, created.id, RUN_STATES.COMPLETED);
  const deps = {
    store,
    loadRegistry: archiveLoadRegistry({ acme: { label: "Acme", repository: "monorepo", path: basePath, base_branch: "dev" } }),
    git: realGit(),
    herdr: scriptedHerdr().herdr,
    inspectProcess: OWNER_GONE,
  };

  const refused = await archiveCommand({ runId: run.id }, deps);
  assert.equal(refused.preview.refused, true);
  assert.match(refused.preview.reason, /detached HEAD/);
  assert.match(refused.preview.reason, new RegExp(orphan));
  await realFs.access(join(worktreePath, "orphan.txt"));

  // Give those commits a ref -- the remedy the refusal names -- and the same run archives.
  await gitExec(worktreePath, ["branch", "rescued", orphan]);
  const allowed = await archiveCommand({ runId: run.id }, deps);
  assert.equal(allowed.preview.refused, false, "a ref now contains it, so nothing would be destroyed");
  assert.equal(allowed.preview.repositories[0].headReachable, true);
  assert.ok(allowed.preview.losses.some((loss) => loss.kind === "detached-head"));

  const report = await allowed.execute({ approvalDigest: allowed.preview.approvalDigest });
  assert.equal(report.status, "archived");
  assert.equal((await gitExec(basePath, ["rev-parse", "rescued"])).stdout.trim(), orphan, "the rescued commit survives");
});

// --- the base-checkout mapping ----------------------------------------------

test("a group repository missing from the registry refuses, never measured against the group's meta-repository", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store, {
    repositories: [{ id: "gone", path: "/wt/gone", branch: "feature/recorded" }],
  });
  const fixture = scriptedGit({ "/wt/gone": { branch: "feature/actual", sha: "aaa" }, "/base/meta": { unmerged: { "main..feature/actual": 7 } } });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    project: GROUP_PROJECT,
    present: ["/wt/gone"],
  }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /meta-repository/i);
  assert.deepEqual(
    fixture.calls.filter((call) => call.cwd === "/base/meta"),
    [],
    "the group's meta-repository must never be measured",
  );
  assertNothingHappened(fixture);
});

test("an ordinary project's single entry uses project.path and project.base_branch, never a registry key lookup", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/base/acme": { unmerged: { "dev..feature/actual": 1 } } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.repositories[0].basePath, "/base/acme");
  assert.equal(command.preview.repositories[0].baseBranch, "dev");
  assert.equal(command.preview.repositories[0].unmergedCommits, 1);
});

test("a project with no base_branch still archives, with an unknown loss rather than a false zero", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    project: { acme: { label: "Acme", repository: "monorepo", path: "/base/acme" } },
    present: ["/wt/acme"],
  }));

  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.repositories[0].unmergedCommits, null);
  assert.deepEqual(command.preview.losses.map((loss) => loss.kind), ["unmerged-commits-unknown"]);
  assert.deepEqual(fixture.calls.filter((call) => call.method === "countCommitsNotIn"), []);
});

// --- the run-record shapes item 2.3's C1 finding enumerated ------------------

test("the five no-path repository entry shapes each refuse", async (t) => {
  const shapes = [
    { label: "field missing", entry: { id: "primary", branch: "feature/x" } },
    { label: "path: null", entry: { id: "primary", path: null } },
    { label: "path: \"\"", entry: { id: "primary", path: "" } },
    { label: "bare string entry", entry: "primary" },
    { label: "empty object", entry: {} },
  ];

  for (const { label, entry } of shapes) {
    const store = withAppendSpy(await newStore(t));
    const created = await store.create({ projectAlias: "acme", primaryTicket: "A-1", repositories: [entry], tabId: "w2M:t1" });
    const run = await advanceTo(store, created.id, RUN_STATES.COMPLETED);
    const fixture = scriptedGit(acmeFixture());

    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

    assert.equal(command.preview.refused, true, `${label} must refuse`);
    assert.match(command.preview.reason, /no worktree path recorded/i, label);
    assertNothingHappened(fixture);
    assert.deepEqual(store.appendEventCalls, []);
  }
});

test("a null entry beside a valid one refuses, rather than being silently skipped", async (t) => {
  // The sixth shape, beyond the five above: `list()` filters null/undefined out of an array, so a
  // `repositories: [valid, null]` record used to archive the valid one and never mention its
  // malformed sibling -- the one entry shape that did NOT fail closed.
  for (const malformed of [null, undefined]) {
    const store = withAppendSpy(await newStore(t));
    const created = await store.create({
      projectAlias: "acme",
      primaryTicket: "A-1",
      repositories: [{ id: "primary", path: "/wt/acme", branch: "feature/recorded" }, malformed],
      tabId: "w2M:t1",
    });
    const run = await advanceTo(store, created.id, RUN_STATES.COMPLETED);
    const fixture = scriptedGit(acmeFixture());

    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

    assert.equal(command.preview.refused, true, `a ${String(malformed)} entry must refuse`);
    assert.match(command.preview.reason, /no worktree path recorded/i);
    assert.match(command.preview.reason, /at index 1/, "the refusal must say WHICH entry");
    assertNothingHappened(fixture);
    assert.deepEqual(store.appendEventCalls, []);
  }
});

test("a relative worktree path refuses rather than resolving against the control plane's own directory", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store, { path: ".worktrees/acme" });
  const fixture = scriptedGit(acmeFixture());

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: [".worktrees/acme"] }));

  assert.equal(command.preview.refused, true);
  assert.match(command.preview.reason, /relative/i);
  assertNothingHappened(fixture);
});

test("a run with no repositories, and an unknown project, each refuse", async (t) => {
  const store = await newStore(t);
  const empty = await store.create({ projectAlias: "acme", primaryTicket: "A-1", repositories: [] });
  await advanceTo(store, empty.id, RUN_STATES.COMPLETED);
  const fixture = scriptedGit(acmeFixture());

  const noRepositories = await archiveCommand({ runId: empty.id }, archiveDeps(store, { git: fixture.git }));
  assert.equal(noRepositories.preview.refused, true);
  assert.match(noRepositories.preview.reason, /no repositories/i);

  const run = await acmeRun(store);
  const unknownProject = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    project: {},
    present: ["/wt/acme"],
  }));
  assert.equal(unknownProject.preview.refused, true);
  assert.match(unknownProject.preview.reason, /Unknown workflow project/);
  assertNothingHappened(fixture);
});

// --- the digest -------------------------------------------------------------

test("the digest changes when any material field moves", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);

  async function digestFor({ script = acmeFixture(), project = ACME_PROJECT, present = ["/wt/acme"], runId = run.id } = {}) {
    const fixture = scriptedGit(script);
    const command = await archiveCommand({ runId }, archiveDeps(store, { git: fixture.git, project, present }));
    assert.equal(command.preview.refused, false);
    return command.preview.approvalDigest;
  }

  const baseline = await digestFor();
  assert.match(baseline, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await digestFor(), baseline, "the same world must digest the same");

  const variations = {
    "the worktree branch": { script: acmeFixture({ "/wt/acme": { branch: "feature/other" } }) },
    "the worktree HEAD": { script: acmeFixture({ "/wt/acme": { sha: "bbbb222" } }) },
    "the unmerged count": { script: acmeFixture({ "/base/acme": { unmerged: { "dev..feature/actual": 2 } } }) },
    "the base branch": { project: { acme: { label: "Acme", repository: "monorepo", path: "/base/acme", base_branch: "main" } } },
    "the base checkout path": { project: { acme: { label: "Acme", repository: "monorepo", path: "/base/other", base_branch: "dev" } } },
    "the worktree's presence": { script: acmeFixture({ "/wt/acme": { missing: true } }), present: [] },
    // Detaching a worktree onto a still-contained commit moves `branch`, `headSha` and
    // `headReachable` together. Named for exactly that -- the three co-vary and no non-refused
    // preview can move `headReachable` on its own; see the honesty test below.
    "going from a branch to a contained detached HEAD": {
      script: acmeFixture({ "/wt/acme": { branch: null, sha: "aaaa111" }, "/base/acme": { reachable: ["aaaa111"], unmerged: {} } }),
    },
  };
  for (const [label, options] of Object.entries(variations)) {
    assert.notEqual(await digestFor(options), baseline, `${label} must change the digest`);
  }

  // The worktree PATH, the run STATE and the TAB ID all live on the record, so each needs its own
  // run rather than a scripted variation.
  const otherPath = await acmeRun(store, { path: "/wt/other" });
  const otherPathDigest = await digestFor({
    runId: otherPath.id,
    script: { "/wt/other": { branch: "feature/actual", sha: "aaaa111" }, "/base/acme": { unmerged: { "dev..feature/actual": 0 } } },
    present: ["/wt/other"],
  });
  assert.notEqual(otherPathDigest, baseline, "the worktree path must change the digest");

  const otherTab = await acmeRun(store, { tabId: "w2J:t9" });
  assert.notEqual(await digestFor({ runId: otherTab.id }), baseline, "the tab id must change the digest");

  const failed = await acmeRun(store, { state: RUN_STATES.FAILED });
  assert.notEqual(await digestFor({ runId: failed.id }), baseline, "the run state must change the digest");
});

test("the refusal caps what it names, says how much it is not naming, and caps nextActions with it", async (t) => {
  const store = await newStore(t);
  const repositories = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, path: `/wt/r${i}`, branch: "feature/recorded" }));
  const created = await store.create({ projectAlias: "sharyco", primaryTicket: "S-1", repositories, tabId: "w2M:t1" });
  const run = await advanceTo(store, created.id, RUN_STATES.COMPLETED);

  const script = {};
  for (let i = 0; i < 8; i += 1) {
    // 12 untracked paths each: over ARCHIVE_DISPLAY_LIMITS.reasonPaths, in 8 repositories, which is
    // over ARCHIVE_DISPLAY_LIMITS.reasonRepositories. Both caps are exercised at once.
    script[`/wt/r${i}`] = { branch: "feature/actual", sha: `sha${i}`, untrackedPaths: Array.from({ length: 12 }, (_, j) => `build/artifact-${j}.log`) };
    script[`/base/r${i}`] = {};
  }
  const fixture = scriptedGit(script);
  const project = {
    sharyco: {
      label: "Sharyco", repository: "group", path: "/base/meta",
      repositories: Object.fromEntries(repositories.map((entry) => [entry.id, { path: `/base/${entry.id}`, base_branch: "dev" }])),
    },
  };

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    project,
    present: repositories.map((entry) => entry.path),
  }));

  assert.equal(command.preview.refused, true);
  const { reasonPaths, reasonRepositories } = ARCHIVE_DISPLAY_LIMITS;

  // Exactly `reasonRepositories` worktrees named, and the rest counted rather than dropped.
  const namedWorktrees = [...command.preview.reason.matchAll(/\/wt\/r\d/g)].map((match) => match[0]);
  assert.equal(new Set(namedWorktrees).size, reasonRepositories, `expected ${reasonRepositories} worktrees named`);
  assert.match(command.preview.reason, new RegExp(`\\(\\+${8 - reasonRepositories} more repositories\\)`));

  // Exactly `reasonPaths` paths per named worktree, and the remainder counted.
  assert.match(command.preview.reason, new RegExp(`\\(\\+${12 - reasonPaths} more\\)`));
  const namedPaths = [...command.preview.reason.matchAll(/build\/artifact-\d+\.log/g)];
  assert.equal(namedPaths.length, reasonPaths * reasonRepositories);

  // The regression this test exists for: nextActions used to grow with the FULL list while the
  // reason stayed capped, so eight dirty repositories produced a bounded sentence beside an
  // unbounded array. Both are now capped by the same slice.
  const actionWorktrees = new Set([...command.preview.nextActions.join("\n").matchAll(/\/wt\/r\d/g)].map((match) => match[0]));
  assert.equal(actionWorktrees.size, reasonRepositories, `nextActions must be capped too: ${JSON.stringify(command.preview.nextActions)}`);
  assert.deepEqual(new Set(namedWorktrees), actionWorktrees, "the reason and the actions must name the SAME repositories");
});

// This test exists to keep an honest boundary honest, rather than to protect a behaviour. Fix
// round 1 added `headReachable` to the digest; a mutation check then showed that REMOVING it again
// fails no test. That is not a missing test — it is a true fact about the field, and the reason is
// asserted here so a later reader does not "restore coverage" for a property that does not exist.
test("headReachable cannot vary independently of branch and headSha, so the digest is not what guards it", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);

  async function previewWith(script) {
    const fixture = scriptedGit(script);
    const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));
    return command.preview;
  }

  // The only two values a NON-refused preview can carry, and the fact that ties them to `branch`.
  const onBranch = await previewWith(acmeFixture());
  const detachedReachable = await previewWith(acmeFixture({
    "/wt/acme": { branch: null, sha: "aaaa111" },
    "/base/acme": { reachable: ["aaaa111"], unmerged: {} },
  }));

  assert.equal(onBranch.repositories[0].headReachable, null);
  assert.equal(detachedReachable.repositories[0].headReachable, true);

  // `headReachable` is a FUNCTION of `branch`: null exactly when a branch is checked out, non-null
  // exactly when one is not. So it cannot move without `branch` moving, and there is no pair of
  // archivable worlds differing only in it. (Deliberately not asserting headSha differs too -- it
  // need not, and the fixtures above share one; claiming otherwise would be the same
  // assert-more-than-you-test defect this round exists to remove.)
  assert.equal(onBranch.repositories[0].branch !== null, onBranch.repositories[0].headReachable === null);
  assert.equal(detachedReachable.repositories[0].branch === null, detachedReachable.repositories[0].headReachable !== null);
  assert.notEqual(onBranch.repositories[0].branch, detachedReachable.repositories[0].branch);
  assert.notEqual(onBranch.approvalDigest, detachedReachable.approvalDigest);

  const refusedUnreachable = await previewWith(acmeFixture({
    "/wt/acme": { branch: null, sha: "0rphan1" },
    "/base/acme": { reachable: [], unmerged: {} },
  }));
  assert.equal(refusedUnreachable.refused, true, "the third value refuses; it is never a digested world");
  assert.equal(refusedUnreachable.approvalDigest, null);
});

test("no display cap can reach the digest, because a capped field never appears beside one", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  // The two caps that ship are both inside a REFUSAL's reason text, and a refusal carries
  // `approvalDigest: null` -- so there is no path on which a truncated value is bound. This asserts
  // the structural property that makes that true, rather than asserting a cap that cannot fire:
  // a repository that would have anything to truncate refuses instead of being projected.
  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.repositories[0].dirty, false);
  assert.equal(command.preview.repositories[0].dirtyCount, 0);
  assert.equal(Object.hasOwn(command.preview.repositories[0], "dirtyPaths"), false, "an unreachable field must not be shipped");
  assert.equal(Object.hasOwn(command.preview.repositories[0], "dirtyPathsTruncated"), false);
  assert.deepEqual(Object.keys(ARCHIVE_DISPLAY_LIMITS).sort(), ["reasonPaths", "reasonRepositories"]);

  const dirty = scriptedGit(acmeFixture({ "/wt/acme": { untrackedPaths: ["a", "b"] } }));
  const refused = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: dirty.git, present: ["/wt/acme"] }));
  assert.equal(refused.preview.approvalDigest, null, "the only shape with truncatable text has nothing to approve");
  assert.deepEqual(refused.preview.repositories, []);
});

test("a stale digest is refused and names the fresh one, and nothing is removed", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));
  const stale = command.preview.approvalDigest;

  // A new commit lands in the worktree between preview and approval.
  fixture.script["/wt/acme"] = { ...fixture.script["/wt/acme"], sha: "ffff999" };

  await assert.rejects(
    () => command.execute({ approvalDigest: stale }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.equal(error.exitCode, ARCHIVE_EXIT_CODES.refused);
      assert.match(error.message, /Stale approval digest/);
      assert.match(error.message, /sha256:[0-9a-f]{64}/);
      assert.notEqual(error.details.expected, stale);
      return true;
    },
  );
  assert.deepEqual(fixture.removals(), []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("a missing or malformed approval digest is refused before anything is recomputed", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  for (const approvalDigest of [undefined, "", "not-a-digest", "sha256:zz", 42]) {
    await assert.rejects(
      () => command.execute({ approvalDigest }),
      (error) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.exitCode, ARCHIVE_EXIT_CODES.refused);
        return true;
      },
      `${JSON.stringify(approvalDigest)} must be refused`,
    );
  }
  assert.deepEqual(fixture.removals(), []);
});

// --- execution --------------------------------------------------------------

test("a three-repository group archives all three, in the order the run records them", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture());
  const herdr = scriptedHerdr();

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    herdr: herdr.herdr,
    project: GROUP_PROJECT,
    present: ["/wt/backend", "/wt/panel", "/wt/webapp"],
  }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "archived");
  assert.equal(report.exitCode, ARCHIVE_EXIT_CODES.archived);
  assert.deepEqual(report.removed.map((entry) => entry.worktreePath), ["/wt/backend", "/wt/panel", "/wt/webapp"]);
  assert.deepEqual(report.kept, []);
  assert.deepEqual(fixture.removals().map((call) => call.path), ["/wt/backend", "/wt/panel", "/wt/webapp"]);
  assert.deepEqual(herdr.calls.filter((call) => call.method === "closeTab").map((call) => call.tabId), ["w2M:t1"]);
  assert.equal(report.tab.closed, true);
});

test("a failure partway is reported as partial, with what was removed and what was kept", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({
    "/wt/panel": { removeFails: "fatal: '/wt/panel' is not a working tree", removeReason: "not-a-worktree" },
    // Both repositories hold unmerged work, so the report has a loss for one that WAS removed and
    // one that was not -- the distinction this test pins.
    "/base/backend": { unmerged: { "dev..feature/actual": 2 } },
    "/base/panel": { unmerged: { "dev..feature/actual": 4 } },
  }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    project: GROUP_PROJECT,
    present: ["/wt/backend", "/wt/panel", "/wt/webapp"],
  }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "partial");
  assert.equal(report.exitCode, ARCHIVE_EXIT_CODES.partial);
  assert.deepEqual(report.removed.map((entry) => entry.worktreePath), ["/wt/backend", "/wt/webapp"]);
  assert.deepEqual(report.kept.map((entry) => entry.worktreePath), ["/wt/panel"]);
  assert.equal(report.kept[0].reason, "not-a-worktree");
  assert.match(report.kept[0].detail, /is not a working tree/);
  // A loss belonging to a worktree that is STILL ON DISK must not be reported as having happened.
  const panelLoss = report.losses.find((loss) => loss.worktreePath === "/wt/panel");
  const backendLoss = report.losses.find((loss) => loss.worktreePath === "/wt/backend");
  assert.equal(panelLoss.removed, false);
  assert.match(panelLoss.detail, /NOT removed and is still on disk/);
  assert.equal(backendLoss.removed, true);
  assert.doesNotMatch(backendLoss.detail, /still on disk/);
  // A partial archive must NOT mark the record archived: residue is still on disk, and the board
  // hiding the run would hide the residue with it.
  assert.equal((await store.read(run.id)).archivedAt, undefined);
  const [event] = store.appendEventCalls.map((call) => call.event);
  assert.equal(event.status, "partial", "a partial archive still leaves evidence of what happened");
});

test("every removal failing is failed, not partial, and marks nothing", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/wt/acme": { removeFails: "fatal: could not remove", removeReason: "failed" } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "failed");
  assert.equal(report.exitCode, ARCHIVE_EXIT_CODES.failed);
  assert.deepEqual(report.removed, []);
  assert.equal(report.kept.length, 1);
  assert.equal((await store.read(run.id)).archivedAt, undefined);
});

test("an adapter that breaks its never-throws contract is reported, not allowed to discard the removals already made", async (t) => {
  const store = await newStore(t);
  const run = await groupRun(store);
  const fixture = scriptedGit(groupFixture({ "/wt/panel": { removeThrows: "spawn git EAGAIN" } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, {
    git: fixture.git,
    project: GROUP_PROJECT,
    present: ["/wt/backend", "/wt/panel", "/wt/webapp"],
  }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "partial");
  assert.deepEqual(report.removed.map((entry) => entry.worktreePath), ["/wt/backend", "/wt/webapp"]);
  assert.equal(report.kept.length, 1);
  assert.match(report.kept[0].detail, /EAGAIN/);
});

test("a removal that git refuses as dirty between preview and execute keeps the worktree and never forces", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));

  // The digest binds the preview, but a file can still be written in the window between the
  // recompute and the removal itself. git is the last line of defence and it must hold.
  const digest = command.preview.approvalDigest;
  fixture.script["/wt/acme"] = {
    ...fixture.script["/wt/acme"],
    removeFails: "fatal: '/wt/acme' contains modified or untracked files, use --force to delete it",
    removeReason: "dirty",
  };

  const report = await command.execute({ approvalDigest: digest });
  assert.equal(report.status, "failed");
  assert.equal(report.kept[0].reason, "dirty");
  assert.equal(fixture.removals().every((call) => !call.args.force), true);
});

// --- the tab ----------------------------------------------------------------

test("tab_not_found means already archived, never a failure", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  const herdr = scriptedHerdr({ closeTab: { closed: false, reason: "not-found" } });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, herdr: herdr.herdr, present: ["/wt/acme"] }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "archived");
  assert.equal(report.exitCode, ARCHIVE_EXIT_CODES.archived);
  assert.equal(report.tab.closed, false);
  assert.equal(report.tab.reason, "not-found");
  assert.equal(report.tab.alreadyGone, true);
  assert.equal(typeof (await store.read(run.id)).archivedAt, "string");
});

test("any other tab failure is recorded without rolling back or throwing", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  const herdr = scriptedHerdr({ closeTab: { closed: false, reason: "herdr: connection refused" } });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, herdr: herdr.herdr, present: ["/wt/acme"] }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "archived", "the worktree is the durable residue; the tab is best-effort");
  assert.equal(report.tab.closed, false);
  assert.equal(report.tab.alreadyGone, false);
  assert.match(report.tab.reason, /connection refused/);
  assert.deepEqual(fixture.removals().map((call) => call.path), ["/wt/acme"]);
});

test("a closeTab that throws is caught after the removals it cannot undo", async (t) => {
  const store = await newStore(t);
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture());
  const herdr = scriptedHerdr({
    closeTab: () => {
      throw new WorkflowError("PROCESS", "herdr exploded", { exitCode: 12 });
    },
  });

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, herdr: herdr.herdr, present: ["/wt/acme"] }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "archived");
  assert.equal(report.tab.closed, false);
  assert.match(report.tab.reason, /exploded/);
});

// --- persistence ------------------------------------------------------------

test("the record is marked archived and an archive event is appended", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const run = await acmeRun(store);
  const fixture = scriptedGit(acmeFixture({ "/base/acme": { unmerged: { "dev..feature/actual": 2 } } }));

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));
  const digest = command.preview.approvalDigest;
  const report = await command.execute({ approvalDigest: digest });

  const after = await store.read(run.id);
  assert.equal(after.archivedAt, "2026-08-07T12:00:00.000Z");
  assert.equal(after.state, RUN_STATES.COMPLETED, "archiving is not a state transition");
  assert.equal(report.archivedAt, after.archivedAt);

  assert.equal(store.appendEventCalls.length, 1);
  const { event } = store.appendEventCalls[0];
  assert.equal(event.type, "archive");
  assert.equal(event.approvalDigest, digest);
  assert.equal(event.status, "archived");
  assert.deepEqual(event.removed.map((entry) => entry.worktreePath), ["/wt/acme"]);
  assert.deepEqual(event.repositories, [{
    repositoryId: "primary",
    worktreePath: "/wt/acme",
    branch: "feature/actual",
    headSha: "aaaa111",
    basePath: "/base/acme",
    baseBranch: "dev",
    unmergedCommits: 2,
  }]);
  // appendEvent stamps these itself; passing them would be a second, competing source.
  for (const key of ["version", "id", "runId", "timestamp"]) {
    assert.equal(Object.hasOwn(event, key), false, `${key} must be stamped by the store`);
  }

  // The run directory survives -- that is what keeps `workflow result` answerable forever.
  assert.equal(typeof after.directory, "string");
  await realFs.access(join(after.directory, "run.json"));
});

test("a persistence failure degrades to an error field without discarding the report of real removals", async (t) => {
  const base = await newStore(t);
  const run = await acmeRun(base, {});
  const store = {
    ...base,
    async update() {
      throw new WorkflowError("STORE", "run lock is held by another command", { exitCode: 11 });
    },
    async appendEvent() {
      throw new WorkflowError("STORE", "run lock is held by another command", { exitCode: 11 });
    },
  };
  const fixture = scriptedGit(acmeFixture());

  const command = await archiveCommand({ runId: run.id }, archiveDeps(store, { git: fixture.git, present: ["/wt/acme"] }));
  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });

  assert.equal(report.status, "archived", "the removals really happened and must still be reported");
  assert.deepEqual(report.removed.map((entry) => entry.worktreePath), ["/wt/acme"]);
  assert.match(report.recordError, /could not be marked archived/);
  assert.match(report.evidenceError, /could not be persisted/);
  assert.deepEqual(fixture.removals().map((call) => call.path), ["/wt/acme"]);
});

// --- real git ---------------------------------------------------------------

async function realRun(t, { dirty = null, baseBranch = "dev", sourceBranch = "feature/actual" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "workflow-archive-git-"));
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
  const sha = (await gitExec(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

  if (dirty === "untracked") {
    await realFs.writeFile(join(worktreePath, ".env.local"), "SECRET=1\n");
  }
  if (dirty === "modified") {
    await realFs.writeFile(join(worktreePath, "feature.txt"), "edited, never committed\n");
  }

  return { root, basePath, worktreePath, sha };
}

function realGit() {
  return createGitAdapter({ runner: createProcessRunner() });
}

test("real git: a clean run archives, and the branch, its commits and the run directory all survive", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const { basePath, worktreePath, sha } = await realRun(t);
  const created = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/actual" }],
    tabId: "w2M:t1",
  });
  const run = await advanceTo(store, created.id, RUN_STATES.COMPLETED);
  const herdr = scriptedHerdr({ closeTab: { closed: false, reason: "not-found" } });

  const command = await archiveCommand({ runId: run.id }, {
    store,
    loadRegistry: archiveLoadRegistry({ acme: { label: "Acme", repository: "monorepo", path: basePath, base_branch: "dev" } }),
    git: realGit(),
    herdr: herdr.herdr,
    inspectProcess: OWNER_GONE,
    now: () => "2026-08-07T12:00:00.000Z",
  });

  assert.equal(command.preview.refused, false);
  assert.equal(command.preview.repositories[0].branch, "feature/actual");
  assert.equal(command.preview.repositories[0].dirty, false);
  assert.equal(command.preview.repositories[0].unmergedCommits, 1, "one commit is not in dev");
  assert.deepEqual(command.preview.losses.map((loss) => loss.kind), ["unmerged-commits"]);

  const report = await command.execute({ approvalDigest: command.preview.approvalDigest });
  assert.equal(report.status, "archived");

  // The directory is gone and git has deregistered it.
  await assert.rejects(() => realFs.access(worktreePath));
  const list = await gitExec(basePath, ["worktree", "list", "--porcelain"]);
  assert.doesNotMatch(list.stdout, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // The branch and its commits survive untouched -- this is the acceptance criterion.
  const branchSha = await gitExec(basePath, ["rev-parse", "feature/actual"]);
  assert.equal(branchSha.stdout.trim(), sha);
  const type = await gitExec(basePath, ["cat-file", "-t", sha]);
  assert.equal(type.stdout.trim(), "commit");
  const content = await gitExec(basePath, ["show", `${sha}:feature.txt`]);
  assert.equal(content.stdout, "work\n");

  // And the run's own evidence outlives its worktree.
  const after = await store.read(run.id);
  assert.equal(after.archivedAt, "2026-08-07T12:00:00.000Z");
  await realFs.access(join(after.directory, "run.json"));
  await realFs.access(join(after.directory, "events.jsonl"));
});

test("real git: an untracked-only worktree refuses, and every one of its files is still there", async (t) => {
  const store = withAppendSpy(await newStore(t));
  const { basePath, worktreePath } = await realRun(t, { dirty: "untracked" });
  const created = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/actual" }],
    tabId: "w2M:t1",
  });
  const run = await advanceTo(store, created.id, RUN_STATES.COMPLETED);

  // The fixture really is untracked-only: no tracked file is modified.
  const tracked = await gitExec(worktreePath, ["status", "--porcelain", "--untracked-files=no"]);
  assert.equal(tracked.stdout, "", "the fixture must be untracked-only, not accidentally modified");

  const command = await archiveCommand({ runId: run.id }, {
    store,
    loadRegistry: archiveLoadRegistry({ acme: { label: "Acme", repository: "monorepo", path: basePath, base_branch: "dev" } }),
    git: realGit(),
    herdr: scriptedHerdr().herdr,
    inspectProcess: OWNER_GONE,
  });

  assert.equal(command.preview.refused, true, "untracked files are work with no other copy");
  assert.match(command.preview.reason, /\.env\.local/);
  assert.equal(command.preview.approvalDigest, null);

  // Nothing was destroyed, and the worktree is still registered.
  await realFs.access(join(worktreePath, ".env.local"));
  await realFs.access(join(worktreePath, "feature.txt"));
  const list = await gitExec(basePath, ["worktree", "list", "--porcelain"]);
  assert.match(list.stdout, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(store.appendEventCalls, []);
});
