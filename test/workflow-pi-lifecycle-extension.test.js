import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowWorkerLifecycleExtension } from "../.pi/extensions/workflow-worker-lifecycle.ts";

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

test("session_shutdown ends the session at the current generation", async () => {
  const ended = [];
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "none" }), onSessionEnd: async (a) => ended.push(a) };
  const pi = fakePi();
  makeExt({ life, run: { generation: 2, state: "running" } })(pi);
  await pi.handlers.session_shutdown({ reason: "quit" }, {});
  assert.deepEqual(ended.at(-1), { runId: "r1", generation: 2 });
});
