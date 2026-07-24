import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

function fakeStore(initial) {
  let run = { id: "r1", state: RUN_STATES.LAUNCHING, generation: 1, stateHistory: [], updatedAt: "t0", ...initial };
  return {
    async read() { return { ...run }; },
    async update(_id, updater) { run = { ...run, ...updater({ ...run }) }; return { ...run }; },
    _get: () => run,
  };
}

test("first prompt confirms generation 1 and moves to running", async () => {
  const store = fakeStore();
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const run = await lifecycle.onPrompt({ runId: "r1", generation: 1, source: "user" });
  assert.equal(run.state, RUN_STATES.RUNNING);
  assert.equal(run.generation, 1);
});

test("a user follow-up increments generation, returns to running, resets stop attempts", async () => {
  const store = fakeStore({ state: RUN_STATES.COMPLETED, generation: 1, stopAttempts: 2 });
  const lifecycle = createLifecycle({ store, clock: () => "t2" });
  const run = await lifecycle.onPrompt({ runId: "r1", generation: 2, source: "user" });
  assert.equal(run.state, RUN_STATES.RUNNING);
  assert.equal(run.generation, 2);
  assert.equal(run.stopAttempts, 0);
  assert.equal(run.previousGeneration, 1);
});

test("a queued continuation does NOT increment the generation", async () => {
  const store = fakeStore({ state: RUN_STATES.IDLE_AWAITING_HANDOFF, generation: 1, stopAttempts: 3 });
  const lifecycle = createLifecycle({ store, clock: () => "t3" });
  const run = await lifecycle.onPrompt({ runId: "r1", generation: 2, source: "continuation" });
  assert.equal(run.generation, 1);
  assert.equal(run.stopAttempts, 3);
  assert.equal(run.previousGeneration, undefined);
});

test("a stale user call with a lower generation does NOT regress the generation", async () => {
  const store = fakeStore({ state: RUN_STATES.IDLE_AWAITING_HANDOFF, generation: 5, stopAttempts: 1 });
  const lifecycle = createLifecycle({ store, clock: () => "t4" });
  const run = await lifecycle.onPrompt({ runId: "r1", generation: 3, source: "user" });
  assert.equal(run.generation, 5);
  assert.equal(run.stopAttempts, 1);
  assert.equal(run.previousGeneration, undefined);
});

test("rejects an unknown prompt source", async () => {
  const store = fakeStore();
  const lifecycle = createLifecycle({ store, clock: () => "t5" });
  await assert.rejects(
    () => lifecycle.onPrompt({ runId: "r1", generation: 1, source: "system" }),
    (error) => error instanceof WorkflowError && error.category === "lifecycle",
  );
});

test("rejects a non-positive-integer generation", async () => {
  const store = fakeStore();
  const lifecycle = createLifecycle({ store, clock: () => "t6" });
  await assert.rejects(
    () => lifecycle.onPrompt({ runId: "r1", generation: 0, source: "user" }),
    (error) => error instanceof WorkflowError && error.category === "lifecycle",
  );
  await assert.rejects(
    () => lifecycle.onPrompt({ runId: "r1", generation: 1.5, source: "user" }),
    (error) => error instanceof WorkflowError && error.category === "lifecycle",
  );
});

test("stop with a valid handoff completes without continuation", async () => {
  const store = fakeStore({ state: RUN_STATES.RUNNING, generation: 1, stopAttempts: 0 });
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const { run, action } = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: true });
  assert.equal(action, "none");
  assert.equal(run.state, RUN_STATES.COMPLETED);
});

test("stop without a handoff queues up to two continuations then requires manual handoff", async () => {
  const store = fakeStore({ state: RUN_STATES.RUNNING, generation: 1, stopAttempts: 0 });
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const first = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(first.action, "continue");
  assert.equal(first.run.stopAttempts, 1);
  const second = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(second.action, "continue");
  assert.equal(second.run.stopAttempts, 2);
  const third = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(third.action, "manual");
  assert.equal(third.run.state, RUN_STATES.MANUAL_HANDOFF_REQUIRED);
});

test("stop with a stale generation is treated as missing (no state change)", async () => {
  const store = fakeStore({ state: RUN_STATES.RUNNING, generation: 2, stopAttempts: 0 });
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const { action, run } = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(action, "none");
  assert.equal(run.generation, 2);
});

test("session end from a non-terminal state interrupts; terminal states are preserved", async () => {
  const running = fakeStore({ state: RUN_STATES.RUNNING, generation: 1 });
  assert.equal((await createLifecycle({ store: running, clock: () => "t" }).onSessionEnd({ runId: "r1" })).state, RUN_STATES.INTERRUPTED);
  const done = fakeStore({ state: RUN_STATES.COMPLETED, generation: 1 });
  assert.equal((await createLifecycle({ store: done, clock: () => "t" }).onSessionEnd({ runId: "r1" })).state, RUN_STATES.COMPLETED);
});
