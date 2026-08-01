import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowWorkerLifecycleExtension } from "../.pi/extensions/workflow-worker-lifecycle.ts";
import { continuationPrompt } from "../hooks/lib/lifecycle-hook-core.mjs";

function fakePi() {
  return {
    handlers: {},
    sent: [],
    on(name, fn) { this.handlers[name] = fn; },
    sendUserMessage(msg, opts) { this.sent.push({ msg, opts }); },
  };
}

// A stateful fake store: unlike a flat `{ ...run }` literal, `update` actually merges its patch
// back into the held state, so a marker written by one call (piStartedOnce,
// piPendingContinuation) is visible to `read()` on the NEXT call -- mirroring the real store's
// patch-merge update() (src/workflow/run-store.js's updatedRun). This is now load-bearing: the
// shared core (hooks/lib/lifecycle-hook-core.mjs) discriminates first-start / continuation /
// follow-up from markers persisted ON THE RUN RECORD, not from closure variables the way the old
// extension did -- a store that silently dropped updates would make every call look like the
// first one.
function makeStatefulStore(run) {
  let state = { id: "r1", ...run };
  return {
    async read() { return { ...state }; },
    async update(_id, fn) {
      const patch = await fn(state);
      state = { ...state, ...patch };
      return { ...state };
    },
  };
}

function makeExt({ life, run, hasValidHandoff = async () => false }) {
  const store = makeStatefulStore(run);
  const ext = createWorkflowWorkerLifecycleExtension({
    env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "pi", WORKFLOW_STATE_ROOT: "/x" },
    lifecycle: life, store, hasValidHandoff,
  });
  // Exposed so tests can assert on persisted markers directly (see the piStartedOnce test
  // below) without threading a second store through every call site.
  return Object.assign(ext, { store });
}

test("extension stays inert without required Pi env", () => {
  const pi = fakePi();
  createWorkflowWorkerLifecycleExtension({ env: {} })(pi);
  assert.deepEqual(Object.keys(pi.handlers), []);
});

test("extension stays inert when harness is not pi", () => {
  const pi = fakePi();
  createWorkflowWorkerLifecycleExtension({
    env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude", WORKFLOW_STATE_ROOT: "/x" },
  })(pi);
  assert.deepEqual(Object.keys(pi.handlers), []);
});

// The marker, not a closure variable, is now the discriminator (see
// hooks/lib/lifecycle-hook-core.mjs's UserPromptSubmit branch: `current[startedOnceField]`).
test("the first agent_start persists piStartedOnce on the run record", async () => {
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "none" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  const ext = makeExt({ life, run: { generation: 1, state: "running" } });
  ext(pi);
  assert.equal((await ext.store.read()).piStartedOnce, undefined);
  await pi.handlers.agent_start({}, {});
  assert.equal((await ext.store.read()).piStartedOnce, true);
});

test("agent_settled without a handoff queues at most two continuations then falls back", async () => {
  const stop = ["continue", "continue", "manual"]; let i = 0;
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: stop[i++] }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await pi.handlers.agent_settled({}, {});
  await pi.handlers.agent_settled({}, {});
  await pi.handlers.agent_settled({}, {});
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[0].opts.deliverAs, "followUp");
});

test("a queued continuation is tagged source=continuation and reuses the generation", async () => {
  const calls = [];
  const life = { onPrompt: async (a) => calls.push(a), onStop: async () => ({ action: "continue" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await pi.handlers.agent_start({}, {});
  assert.deepEqual(calls.at(-1), { runId: "r1", generation: 1, source: "user" });
  await pi.handlers.agent_settled({}, {});   // queues a continuation → sets pendingContinuation
  await pi.handlers.agent_start({}, {});     // the continuation's own agent_start
  assert.deepEqual(calls.at(-1), { runId: "r1", generation: 1, source: "continuation" });
});

test("a user follow-up after the first cycle increments the generation", async () => {
  const calls = [];
  const life = { onPrompt: async (a) => calls.push(a), onStop: async () => ({ action: "none" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "completed" }, hasValidHandoff: async () => true })(pi);
  await pi.handlers.agent_start({}, {});     // first start → confirms gen 1
  assert.equal(calls.at(-1).generation, 1);
  await pi.handlers.agent_start({}, {});     // user follow-up → gen 2
  assert.deepEqual(calls.at(-1), { runId: "r1", generation: 2, source: "user" });
});

// The continuation is rendered via pi.sendUserMessage carrying the core's own prompt text --
// never JSON. Task 1 made the core return a harness-neutral { continuation: { prompt } };
// Claude/Codex render that into their own {"decision":"block",...} wire format in their own hook
// files, but Pi has no such wire format, so its adapter just delivers the prompt as a follow-up.
test("agent_settled renders the continuation via pi.sendUserMessage with the core's prompt, not JSON", async () => {
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "continue" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 3, state: "running" } })(pi);
  await pi.handlers.agent_settled({}, {});
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].msg, continuationPrompt("r1", 3));
  assert.deepEqual(pi.sent[0].opts, { deliverAs: "followUp", triggerTurn: true });
  assert.throws(() => JSON.parse(pi.sent[0].msg), /Unexpected token|not valid JSON/i);
});

test("session_shutdown ends the session (no generation, per the real onSessionEnd contract)", async () => {
  const ended = [];
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "none" }), onSessionEnd: async (a) => ended.push(a) };
  const pi = fakePi();
  makeExt({ life, run: { generation: 2, state: "running" } })(pi);
  await pi.handlers.session_shutdown({ reason: "quit" }, {});
  assert.deepEqual(ended.at(-1), { runId: "r1" });
});

// Fix 2 (whole-branch review): each pi.on(...) handler runs fire-and-forget inside
// Pi, so a throw would be an unhandled rejection on a normal path. Defense in depth
// alongside Fix 1's canTransition guard: a lifecycle bookkeeping error must never
// crash the worker.
test("agent_start swallows a lifecycle throw instead of rejecting", async () => {
  const life = { onPrompt: async () => { throw new Error("boom"); }, onStop: async () => ({ action: "none" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await assert.doesNotReject(() => pi.handlers.agent_start({}, {}));
});

test("agent_settled swallows a lifecycle throw instead of rejecting", async () => {
  const life = { onPrompt: async () => {}, onStop: async () => { throw new Error("boom"); }, onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await assert.doesNotReject(() => pi.handlers.agent_settled({}, {}));
});

test("agent_settled swallows a rejecting sendUserMessage instead of throwing", async () => {
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "continue" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  pi.sendUserMessage = async () => { throw new Error("send failed"); };
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await assert.doesNotReject(() => pi.handlers.agent_settled({}, {}));
});

test("session_shutdown swallows a lifecycle throw instead of rejecting", async () => {
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "none" }), onSessionEnd: async () => { throw new Error("boom"); } };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await assert.doesNotReject(() => pi.handlers.session_shutdown({ reason: "quit" }, {}));
});

// --- Task 4: readOwnOwnership threaded into the fallback store construction ------------------
//
// This extension already had an injected-store seam (store: injectedStore); these tests add none
// of their own -- they thread a fake createRunStore through it instead, mirroring the exact
// pattern hooks/claude-lifecycle.mjs's "main constructs the run store with a readOwnOwnership
// function" test uses, so the fallback construction becomes observable without spawning a real
// `ps`.

// Load-bearing: verified by temporarily reverting the fallback's createRunStoreImpl call back to
// `createRunStoreImpl({ stateRoot: env.WORKFLOW_STATE_ROOT })` (dropping readOwnOwnership),
// re-running this test, and observing it fail with `capturedArgs.readOwnOwnership` equal to
// `undefined` rather than a function; then restoring the argument and confirming the suite is
// green again. See the task-4 report for the before/after run.
test("the fallback store construction receives a readOwnOwnership function", () => {
  let capturedArgs = null;
  const fakeCreateRunStore = (args) => {
    capturedArgs = args;
    return { async read() { return null; }, async update() { return null; } };
  };
  createWorkflowWorkerLifecycleExtension({
    env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "pi", WORKFLOW_STATE_ROOT: "/x" },
    createRunStore: fakeCreateRunStore,
  });
  assert.ok(capturedArgs, "createRunStore should have been called");
  assert.equal(typeof capturedArgs.readOwnOwnership, "function");
});

// This matters because every other test in this file injects a store (via makeExt); if wiring
// readOwnOwnership into the fallback had instead made an injected store go through
// createRunStoreImpl too, the whole suite would start spawning a real `ps` per test.
test("an injected store bypasses the fallback entirely: no createRunStore call, no reader used", () => {
  let fallbackCalled = false;
  const fakeCreateRunStore = () => {
    fallbackCalled = true;
    return { async read() { return null; }, async update() { return null; } };
  };
  const store = {
    async read() { return { id: "r1", generation: 1, state: "running" }; },
    async update() { return null; },
  };
  createWorkflowWorkerLifecycleExtension({
    env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "pi", WORKFLOW_STATE_ROOT: "/x" },
    store,
    createRunStore: fakeCreateRunStore,
  });
  assert.equal(fallbackCalled, false);
});
