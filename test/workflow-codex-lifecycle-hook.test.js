import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runCodexLifecycleHook, main } from "../hooks/codex-lifecycle.mjs";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { publicTelemetrySnapshot } from "../src/workflow/telemetry.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

const RUN_ID = "44444444-4444-4444-8444-444444444444";

// Builds a real run store + lifecycle + telemetry over a tmp state root and drives the run
// to LAUNCHING, mirroring a freshly launched interactive Codex worker. Env carries the harness
// so the hook is active. Codex fires the same lifecycle hook events as Claude (see
// hooks/claude-lifecycle.mjs), so this mirrors test/workflow-claude-lifecycle-hook.test.js with
// harness "codex".
async function realFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-codex-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({ stateRoot: join(root, "state"), randomUUID: () => RUN_ID });
  await store.create({ harness: "codex", profileName: "codex-worker", generation: 1 });
  await store.update(RUN_ID, () => ({ state: RUN_STATES.LAUNCHING }));
  const lifecycle = createLifecycle({ store });
  const telemetry = createTelemetryStore({ store });
  const env = { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_HARNESS: "codex" };
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
function fakeTelemetry() {
  return { async record() {} };
}

// The parent launch drives LAUNCHING then RUNNING before the first prompt hook fires (same as
// Claude's interactive lane), so the hook must key off persisted markers, not run state.
async function runningFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-codex-lifecycle-running-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({ stateRoot: join(root, "state"), randomUUID: () => RUN_ID });
  await store.create({ harness: "codex", profileName: "codex-worker", generation: 1 });
  await store.update(RUN_ID, () => ({ state: RUN_STATES.LAUNCHING }));
  await store.update(RUN_ID, () => ({ state: RUN_STATES.RUNNING }));
  const lifecycle = createLifecycle({ store });
  const telemetry = createTelemetryStore({ store });
  const env = { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_HARNESS: "codex" };
  return { root, store, lifecycle, telemetry, env };
}

test("codex: first UserPromptSubmit calls onPrompt with the current generation, source user", async () => {
  const rec = []; rec.stopAction = "none";
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "codex" },
    store: fakeStore({ id: "r1", state: "launching", generation: 1 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 1, source: "user" }]);
});

test("codex: a subsequent user UserPromptSubmit (started once) increments the generation", async () => {
  const rec = [];
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "codex" },
    store: fakeStore({ id: "r1", state: "running", generation: 2, codexStartedOnce: true }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 3, source: "user" }]);
});

test("codex: first UserPromptSubmit keeps generation 1 even when state is already running", async () => {
  const rec = [];
  const store = await (async () => {
    // state running, no markers (parent pre-set running)
    return fakeStore({ id: "r1", state: "running", generation: 1 });
  })();
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "codex" }, store, lifecycle: fakeLifecycle(rec), telemetry: fakeTelemetry() });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 1, source: "user" }]);
});

test("codex: a UserPromptSubmit while pendingContinuation is set reuses the generation; source continuation", async () => {
  const rec = [];
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "codex" },
    store: fakeStore({ id: "r1", state: "idle-awaiting-handoff", generation: 2, codexStartedOnce: true, codexPendingContinuation: true }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 2, source: "continuation" }]);
});

test("codex: Stop with action continue emits a block decision on stdout", async () => {
  const rec = []; rec.stopAction = "continue";
  const out = await runCodexLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "codex" },
    store: fakeStore({ id: "r1", state: "running", generation: 1 }), lifecycle: fakeLifecycle(rec), hasValidHandoff: async () => false });
  assert.equal(rec[0][0], "onStop");
  assert.match(out ?? "", /"decision":"block"/);
});

test("codex: a store/lifecycle error is swallowed (never throws)", async () => {
  await runCodexLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "codex" },
    store: { async read() { throw new Error("boom"); }, async update() {} }, lifecycle: fakeLifecycle([]) });
  // no throw = pass
});

test("codex: no-op unless WORKFLOW_HARNESS === codex", async () => {
  const rec = [];
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" }, store: fakeStore({ id: "r1", state: "running", generation: 1 }), lifecycle: fakeLifecycle(rec), telemetry: fakeTelemetry() });
  assert.equal(rec.length, 0);
});

test("codex: no-op when WORKFLOW_RUN_ID is absent", async () => {
  const rec = [];
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_HARNESS: "codex" }, store: fakeStore({}), lifecycle: fakeLifecycle(rec) });
  assert.equal(rec.length, 0);
});

// The real lifecycle sequence keeps generation aligned to the prompt (no off-by-one), mirroring
// the Claude hook's contract.
test("codex: the real lifecycle sequence keeps generation aligned to the prompt (no off-by-one)", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);

  const launched = await store.read(RUN_ID);
  assert.equal(launched.state, RUN_STATES.LAUNCHING);
  assert.equal(launched.generation ?? 1, 1);

  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterFirst = await store.read(RUN_ID);
  assert.equal(afterFirst.state, RUN_STATES.RUNNING);
  assert.equal(afterFirst.generation, 1);

  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterSecond = await store.read(RUN_ID);
  assert.equal(afterSecond.state, RUN_STATES.RUNNING);
  assert.equal(afterSecond.generation, 2);
});

test("codex: first prompt from RUNNING with no markers keeps generation 1 (no inflation) and sets the marker", async (t) => {
  const { store, lifecycle, telemetry, env } = await runningFixture(t);
  const launched = await store.read(RUN_ID);
  assert.equal(launched.state, RUN_STATES.RUNNING);
  assert.equal(launched.generation, 1);
  assert.equal(launched.codexStartedOnce, undefined);

  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterFirst = await store.read(RUN_ID);
  assert.equal(afterFirst.generation, 1);
  assert.equal(afterFirst.codexStartedOnce, true);

  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterSecond = await store.read(RUN_ID);
  assert.equal(afterSecond.generation, 2);
});

test("codex: Stop with a continue action sets codexPendingContinuation; the continuation prompt reuses the generation and clears it", async (t) => {
  const { store, lifecycle, telemetry, env } = await runningFixture(t);
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });

  const out = await runCodexLifecycleHook({ event: "Stop", stdinJson: {}, env, store, lifecycle, telemetry, hasValidHandoff: async () => false });
  assert.match(out ?? "", /"decision":"block"/);
  const afterStop = await store.read(RUN_ID);
  assert.equal(afterStop.codexPendingContinuation, true);
  const genBeforeContinuation = afterStop.generation;

  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterContinuation = await store.read(RUN_ID);
  assert.equal(afterContinuation.generation, genBeforeContinuation);
  assert.equal(afterContinuation.codexPendingContinuation, false);
});

test("codex: SessionStart is a no-op (unwired) and never advances state or generation", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);
  await runCodexLifecycleHook({ event: "SessionStart", stdinJson: {}, env, store, lifecycle, telemetry });
  const after = await store.read(RUN_ID);
  assert.equal(after.state, RUN_STATES.LAUNCHING);
  assert.equal(after.generation ?? 1, 1);
});

test("codex: onPrompt records a telemetry phase of 'running'", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);

  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });

  const [raw] = await telemetry.read({ runId: RUN_ID });
  assert.ok(raw, "telemetry snapshot should exist after a prompt");
  const snapshot = publicTelemetrySnapshot(raw);
  assert.equal(snapshot.phase, "running");
  assert.equal(snapshot.harness, "codex");
});

test("codex: onStop records 'settled' when the run completes with a valid handoff", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  await runCodexLifecycleHook({ event: "Stop", stdinJson: {}, env, store, lifecycle, telemetry, hasValidHandoff: async () => true });

  const [raw] = await telemetry.read({ runId: RUN_ID });
  assert.equal(publicTelemetrySnapshot(raw).phase, "settled");
});

// --- Task 3: readOwnOwnership threaded into main()'s store construction ------------------

// Load-bearing: with the readOwnOwnership argument dropped from main()'s createRunStoreImpl
// call (verified by temporarily reverting that one argument), capturedArgs.readOwnOwnership is
// undefined and this assertion fails. Confirmed by hand during implementation; see the task
// report for the before/after run. The marker-carries-provable-ownership property itself (and
// the failed-reader / absent-keys property) are proven once, through the shared core, in
// test/workflow-claude-lifecycle-hook.test.js -- Codex drives the exact same
// hooks/lib/lifecycle-hook-core.mjs code path, so this file only needs its own site's wiring
// assertion, not a duplicate of those two.
test("codex: main constructs the run store with a readOwnOwnership function", async () => {
  let capturedArgs = null;
  const fakeCreateRunStore = (args) => {
    capturedArgs = args;
    return { async read() { return null; }, async update() { return null; } };
  };
  await main({ env: {}, readStdin: async () => ({}), createRunStore: fakeCreateRunStore });
  assert.ok(capturedArgs, "createRunStore should have been called");
  assert.equal(typeof capturedArgs.readOwnOwnership, "function");
});
