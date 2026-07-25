import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowWorkerLifecycleExtension, handoffExists } from "../.pi/extensions/workflow-worker-lifecycle.ts";

function fakePi() {
  return {
    handlers: {},
    sent: [],
    on(name, fn) { this.handlers[name] = fn; },
    sendUserMessage(msg, opts) { this.sent.push({ msg, opts }); },
  };
}

function makeExt({ life, run, hasValidHandoff = async () => false }) {
  const store = { async read() { return { id: "r1", ...run }; } };
  return createWorkflowWorkerLifecycleExtension({
    env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "pi", WORKFLOW_STATE_ROOT: "/x" },
    lifecycle: life, store, hasValidHandoff,
  });
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

test("session_shutdown ends the session (no generation, per the real onSessionEnd contract)", async () => {
  const ended = [];
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "none" }), onSessionEnd: async (a) => ended.push(a) };
  const pi = fakePi();
  makeExt({ life, run: { generation: 2, state: "running" } })(pi);
  await pi.handlers.session_shutdown({ reason: "quit" }, {});
  assert.deepEqual(ended.at(-1), { runId: "r1" });
});

test("handoffExists is true when the run is completed at the given generation", async () => {
  const store = { async read() { return { state: "completed", generation: 1 }; } };
  assert.equal(await handoffExists(store, "r1", 1), true);
});

test("handoffExists is false when the run is not completed", async () => {
  const store = { async read() { return { state: "running", generation: 1 }; } };
  assert.equal(await handoffExists(store, "r1", 1), false);
});

test("handoffExists is false when the generation does not match", async () => {
  const store = { async read() { return { state: "completed", generation: 2 }; } };
  assert.equal(await handoffExists(store, "r1", 1), false);
});

test("handoffExists is false when the store returns no run", async () => {
  const store = { async read() { return null; } };
  assert.equal(await handoffExists(store, "r1", 1), false);
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
