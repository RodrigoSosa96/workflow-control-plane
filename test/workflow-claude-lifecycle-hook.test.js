import assert from "node:assert/strict";
import { test } from "node:test";
import { runClaudeLifecycleHook } from "../hooks/claude-lifecycle.mjs";

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

test("a subsequent UserPromptSubmit (running) increments the generation", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 2 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 3, source: "user" }]);
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
