import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runClaudeLifecycleHook, main } from "../hooks/claude-lifecycle.mjs";
import { renderClaudeStatusLine } from "../hooks/claude-statusline.mjs";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { publicTelemetrySnapshot } from "../src/workflow/telemetry.js";
import { RUN_STATES } from "../src/workflow/run-state.js";
import { createSubprocessOwnOwnershipReader, classifyOwnership } from "../src/workflow/ownership.js";
import { inspectExactProcessByPid, psStatusArgv } from "../src/workflow/process-observation.js";
import { createProcessRunner } from "../src/workflow/process.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";

// Builds a real run store + lifecycle + telemetry over a tmp state root and drives the run
// to LAUNCHING, mirroring a freshly launched interactive Claude worker (as the reviewer did
// empirically). Env carries the harness so the hook is active.
async function realFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-claude-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({ stateRoot: join(root, "state"), randomUUID: () => RUN_ID });
  await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await store.update(RUN_ID, () => ({ state: RUN_STATES.LAUNCHING }));
  const lifecycle = createLifecycle({ store });
  const telemetry = createTelemetryStore({ store });
  const env = { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_HARNESS: "claude" };
  return { root, store, lifecycle, telemetry, env };
}

function fakeStore(run) {
  const calls = [];
  return { calls, async read() { return run; }, async update(id, fn) { calls.push(await fn(run)); return run; } };
}
function fakeLifecycle(rec) {
  return {
    async onPrompt(a) { rec.push(["onPrompt", a]); },
    async onStop(a) { rec.push(["onStop", a]); return { action: rec.stopAction ?? "none" }; },
    async onSessionEnd(a) { rec.push(["onSessionEnd", a]); },
  };
}

test("first UserPromptSubmit calls onPrompt with the current generation, source user", async () => {
  const rec = []; rec.stopAction = "none";
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "launching", generation: 1 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 1, source: "user" }]);
});

test("a subsequent user UserPromptSubmit (started once) increments the generation", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 2, claudeStartedOnce: true }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 3, source: "user" }]);
});

test("a first UserPromptSubmit from RUNNING (no markers) does not bump; source user", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 1 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 1, source: "user" }]);
});

test("a UserPromptSubmit while pendingContinuation is set reuses the generation; source continuation", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "idle-awaiting-handoff", generation: 2, claudeStartedOnce: true, claudePendingContinuation: true }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 2, source: "continuation" }]);
});

test("Stop with action continue emits a block decision on stdout", async () => {
  const rec = []; rec.stopAction = "continue";
  const out = await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 1 }), lifecycle: fakeLifecycle(rec), hasValidHandoff: async () => false });
  assert.equal(rec[0][0], "onStop");
  assert.match(out ?? "", /"decision":"block"/);
});

test("a store/lifecycle error is swallowed (never throws)", async () => {
  await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: { async read() { throw new Error("boom"); }, async update() {} }, lifecycle: fakeLifecycle([]) });
  // no throw = pass
});

test("no-op when WORKFLOW_RUN_ID / harness is absent", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: {}, store: fakeStore({}), lifecycle: fakeLifecycle(rec) });
  assert.equal(rec.length, 0);
});

// FINDING 1: against the real lifecycle + store, the sequence must be
// launching → UserPromptSubmit → running/generation 1 → UserPromptSubmit → running/generation 2.
// SessionStart is never wired, so the first real prompt confirms generation 1 (not 2).
test("the real lifecycle sequence keeps generation aligned to the prompt (no off-by-one)", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);

  const launched = await store.read(RUN_ID);
  assert.equal(launched.state, RUN_STATES.LAUNCHING);
  assert.equal(launched.generation ?? 1, 1);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterFirst = await store.read(RUN_ID);
  assert.equal(afterFirst.state, RUN_STATES.RUNNING);
  assert.equal(afterFirst.generation, 1);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterSecond = await store.read(RUN_ID);
  assert.equal(afterSecond.state, RUN_STATES.RUNNING);
  assert.equal(afterSecond.generation, 2);
});

// FIX #3: the parent launch now moves the run to RUNNING *before* the first UserPromptSubmit
// hook fires, which defeats the old state === "launching" first-prompt check. The hook must
// key off persisted markers on the run (claudeStartedOnce / claudePendingContinuation), not the
// run state, so the first prompt keeps generation 1 instead of inflating to 2.
async function runningFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-claude-lifecycle-running-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({ stateRoot: join(root, "state"), randomUUID: () => RUN_ID });
  await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  // The parent launch drives LAUNCHING then RUNNING before the first prompt hook fires.
  await store.update(RUN_ID, () => ({ state: RUN_STATES.LAUNCHING }));
  await store.update(RUN_ID, () => ({ state: RUN_STATES.RUNNING }));
  const lifecycle = createLifecycle({ store });
  const telemetry = createTelemetryStore({ store });
  const env = { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_HARNESS: "claude" };
  return { root, store, lifecycle, telemetry, env };
}

test("first prompt from RUNNING with no markers keeps generation 1 (no inflation) and sets the marker", async (t) => {
  const { store, lifecycle, telemetry, env } = await runningFixture(t);
  const launched = await store.read(RUN_ID);
  assert.equal(launched.state, RUN_STATES.RUNNING);
  assert.equal(launched.generation, 1);
  assert.equal(launched.claudeStartedOnce, undefined);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterFirst = await store.read(RUN_ID);
  assert.equal(afterFirst.generation, 1);
  assert.equal(afterFirst.claudeStartedOnce, true);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterSecond = await store.read(RUN_ID);
  assert.equal(afterSecond.generation, 2);
});

test("Stop with a continue action sets claudePendingContinuation; the continuation prompt reuses the generation and clears it", async (t) => {
  const { store, lifecycle, telemetry, env } = await runningFixture(t);
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });

  const out = await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env, store, lifecycle, telemetry, hasValidHandoff: async () => false });
  assert.match(out ?? "", /"decision":"block"/);
  const afterStop = await store.read(RUN_ID);
  assert.equal(afterStop.claudePendingContinuation, true);
  const genBeforeContinuation = afterStop.generation;

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterContinuation = await store.read(RUN_ID);
  assert.equal(afterContinuation.generation, genBeforeContinuation);
  assert.equal(afterContinuation.claudePendingContinuation, false);
});

test("SessionStart is a no-op (unwired) and never advances state or generation", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);
  await runClaudeLifecycleHook({ event: "SessionStart", stdinJson: {}, env, store, lifecycle, telemetry });
  const after = await store.read(RUN_ID);
  assert.equal(after.state, RUN_STATES.LAUNCHING);
  assert.equal(after.generation ?? 1, 1);
});

// FINDING 2: after a prompt, the run's telemetry snapshot has a real phase and the statusLine
// renders that phase (not "starting"), proving the interactive lane now produces telemetry.
test("onPrompt records a telemetry phase the statusLine renders (not 'starting')", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });

  const [raw] = await telemetry.read({ runId: RUN_ID });
  assert.ok(raw, "telemetry snapshot should exist after a prompt");
  const snapshot = publicTelemetrySnapshot(raw);
  assert.equal(snapshot.phase, "running");

  const line = renderClaudeStatusLine({ env, stdinJson: { model: { display_name: "Sonnet" } }, snapshot });
  assert.match(line, /running/);
  assert.doesNotMatch(line, /starting/);
  assert.match(line, /Sonnet/);
});

// FINDING 2: onStop projects the lifecycle action onto a telemetry phase.
test("onStop records 'settled' when the run completes with a valid handoff", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env, store, lifecycle, telemetry, hasValidHandoff: async () => true });

  const [raw] = await telemetry.read({ runId: RUN_ID });
  assert.equal(publicTelemetrySnapshot(raw).phase, "settled");
});

// --- Task 3: readOwnOwnership threaded into main()'s store construction ------------------

// Load-bearing: with the readOwnOwnership argument dropped from main()'s createRunStoreImpl
// call (verified by temporarily reverting that one argument), capturedArgs.readOwnOwnership is
// undefined and this assertion fails. Confirmed by hand during implementation; see the task
// report for the before/after run.
test("main constructs the run store with a readOwnOwnership function", async () => {
  let capturedArgs = null;
  const fakeCreateRunStore = (args) => {
    capturedArgs = args;
    return { async read() { return null; }, async update() { return null; } };
  };
  // No WORKFLOW_RUN_ID: runClaudeLifecycleHook returns undefined immediately after the store is
  // constructed, so this fake store's read/update are never actually invoked -- only their
  // presence (required by createLifecycle's own constructor check) matters here.
  await main({ env: {}, readStdin: async () => ({}), createRunStore: fakeCreateRunStore });
  assert.ok(capturedArgs, "createRunStore should have been called");
  assert.equal(typeof capturedArgs.readOwnOwnership, "function");
});

// Wraps a real run store's update() so the owner marker can be read straight off disk WHILE the
// lock is still held -- mirroring test/workflow-cli.test.js's "main wires unlock..." test, since
// releaseLock deletes the marker the instant the callback returns and there is no other window
// to observe it.
function observingStore(realStore, onObserve) {
  return {
    ...realStore,
    async update(runId, originalUpdater) {
      return realStore.update(runId, async (run) => {
        const patch = await originalUpdater(run);
        const activePath = join(run.directory, "run.lock", "active");
        const [markerName] = await fs.readdir(activePath);
        const markerPath = join(activePath, markerName);
        const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
        const { mode } = await fs.stat(markerPath);
        onObserve({ marker, mode: mode & 0o777 });
        return patch;
      });
    },
  };
}

// This is the actual point of the task: before this wiring, every lock a hook acquired produced
// a marker with no pid/startedAt at all, so `workflow unlock` could never classify it as
// anything but "unprovable" -- forever. This proves that is no longer true for a lock acquired
// through the shared lifecycle-hook core.
test("a lock acquired through the shared lifecycle-hook core produces a marker with pid/startedAt at mode 0600, and classifyOwnership is not unprovable", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-claude-lifecycle-ownership-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const OWNER_RUN_ID = "55555555-5555-4555-8555-555555555555";

  const realStore = createRunStore({
    stateRoot: join(root, "state"),
    randomUUID: () => OWNER_RUN_ID,
    readOwnOwnership: createSubprocessOwnOwnershipReader(),
  });
  await realStore.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await realStore.update(OWNER_RUN_ID, () => ({ state: RUN_STATES.LAUNCHING }));

  let observed = null;
  const store = observingStore(realStore, (result) => { observed = result; });
  const lifecycle = createLifecycle({ store });
  const env = { WORKFLOW_RUN_ID: OWNER_RUN_ID, WORKFLOW_HARNESS: "claude" };

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle });

  assert.ok(observed, "the owner marker should have been observed while the lock was held");
  // The marker's file mode is set by acquireLock unconditionally (see run-store.js), regardless
  // of whether the reader could observe this process's own identity, so this check does not
  // depend on ps/proc availability and is not behind the skip guard below.
  assert.equal(observed.mode, 0o600);

  // createSubprocessOwnOwnershipReader resolves null (never throws) when this host's `ps -o
  // lstart=` or /proc/<pid>/cwd cannot be read (see src/workflow/ownership.js), in which case
  // acquireLock still succeeds but the marker simply omits pid/startedAt (proven by the next
  // test). Review finding 2 (Task 3 review round 1): skip rather than hard-fail in that case,
  // mirroring test/workflow-hook-ownership.test.js's t.skip convention for this exact host
  // dependency -- a failure here would misreport "the wiring is broken" when it actually means
  // "this host cannot report its own process identity."
  if (typeof observed.marker.pid !== "string" || !observed.marker.startedAt) {
    t.skip(
      `this host could not report this process's own identity via ps/proc (marker=${JSON.stringify(observed.marker)}) `
      + "-- the provable-ownership property this test exists to prove could not be checked here",
    );
    return;
  }

  // Independently observe the same live process the same way `workflow unlock` does, so
  // classifyOwnership sees a real (not fabricated) observation.
  const runner = createProcessRunner();
  const observation = await inspectExactProcessByPid(observed.marker.pid, {
    async runProcess(pid) {
      return runner.run("ps", psStatusArgv(pid), { allowFailure: true });
    },
    readCwd: realpath,
  });
  const verdict = classifyOwnership(observed.marker, observation);
  // Review finding 3 (Task 3 review round 1): assert the exact verdict that matters, not just
  // "not unprovable" -- notEqual(verdict, "unprovable") would also pass for "owner-gone", i.e. a
  // live owner misclassified as dead. The lock is held by this live process at this point, so
  // the only correct verdict is "owner-alive".
  assert.equal(verdict.verdict, "owner-alive");
});

// The other half of the same property: when the reader cannot observe this process at all (a
// killed `ps`, a sandboxed environment), acquisition must still succeed and the marker must
// simply omit the fields rather than writing them as empty/undefined -- "pid" in marker, not
// marker.pid === undefined, because a writer that wrote the key explicitly with value undefined
// would also pass the weaker check.
test("a reader whose spawn fails still permits lock acquisition, with the marker's pid/startedAt keys absent", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-claude-lifecycle-ownership-failed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const OWNER_RUN_ID = "66666666-6666-4666-8666-666666666666";

  const failingReader = createSubprocessOwnOwnershipReader({
    spawnProcess: async () => { throw new Error("spawn failed"); },
  });
  const realStore = createRunStore({
    stateRoot: join(root, "state"),
    randomUUID: () => OWNER_RUN_ID,
    readOwnOwnership: failingReader,
  });
  await realStore.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await realStore.update(OWNER_RUN_ID, () => ({ state: RUN_STATES.LAUNCHING }));

  let observed = null;
  const store = observingStore(realStore, (result) => { observed = result; });
  const lifecycle = createLifecycle({ store });
  const env = { WORKFLOW_RUN_ID: OWNER_RUN_ID, WORKFLOW_HARNESS: "claude" };

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle });

  assert.ok(observed, "the owner marker should have been observed while the lock was held");
  assert.equal("pid" in observed.marker, false);
  assert.equal("startedAt" in observed.marker, false);
});
