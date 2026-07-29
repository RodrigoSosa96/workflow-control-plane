import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendEvent } from "../src/workflow/events-bus.js";
import { createWorkerWatcher } from "../src/workflow/worker-watcher.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "workflow-worker-watcher-"));
}

function makeClock() {
  const timers = [];
  return {
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    fire() {
      for (const timer of timers) {
        if (!timer.cleared) timer.fn();
      }
    },
  };
}

test("worker watcher delivers terminal handoff events", async () => {
  const dir = await tempDir();
  const events = [];
  const clock = makeClock();
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: (event) => events.push(event),
    intervalMs: 1000,
    clock,
  });
  watcher.start();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1", runState: "completed" } });
  clock.fire();
  await watcher.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, "r1");
  watcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher filters by origin session", async () => {
  const dir = await tempDir();
  const events = [];
  const clock = makeClock();
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    originSessionId: "session-a",
    onEvent: (event) => events.push(event),
    intervalMs: 1000,
    clock,
  });
  watcher.start();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1", runState: "completed", originSessionId: "session-a" } });
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r2", runState: "completed", originSessionId: "session-b" } });
  clock.fire();
  await watcher.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, "r1");
  watcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher ignores non-terminal events", async () => {
  const dir = await tempDir();
  const events = [];
  const clock = makeClock();
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: (event) => events.push(event),
    intervalMs: 1000,
    clock,
  });
  watcher.start();
  await appendEvent({ stateRoot: dir, event: { type: "run", runId: "r1", runState: "running" } });
  clock.fire();
  await watcher.poll();
  assert.equal(events.length, 0);
  watcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher respects initialByte", async () => {
  const dir = await tempDir();
  const events = [];
  const clock = makeClock();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "old", runState: "completed" } });
  const { nextByte } = await (await import("../src/workflow/events-bus.js")).readEvents({ stateRoot: dir, fromByte: 0 });
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: (event) => events.push(event),
    intervalMs: 1000,
    clock,
    initialByte: nextByte,
  });
  watcher.start();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "new", runState: "completed" } });
  clock.fire();
  await watcher.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, "new");
  watcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher deduplicates by runId", async () => {
  const dir = await tempDir();
  const events = [];
  const clock = makeClock();
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: (event) => events.push(event),
    intervalMs: 1000,
    clock,
  });
  watcher.start();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1", runState: "completed" } });
  await appendEvent({ stateRoot: dir, event: { type: "run", runId: "r1", runState: "completed" } });
  clock.fire();
  await watcher.poll();
  assert.equal(events.length, 1);
  watcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher recognizes hyphenated terminal run states", async () => {
  const dir = await tempDir();
  const events = [];
  const clock = makeClock();
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: (event) => events.push(event),
    intervalMs: 1000,
    clock,
  });
  // Run states are hyphenated (run-state.js); these must notify.
  await appendEvent({ stateRoot: dir, event: { type: "run", runId: "r1", runState: "needs-input" } });
  await appendEvent({ stateRoot: dir, event: { type: "run", runId: "r2", runState: "manual-handoff-required" } });
  await watcher.poll();
  assert.deepEqual(events.map((event) => event.runId), ["r1", "r2"]);
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher re-notifies later generations and collapses events within one generation", async () => {
  const dir = await tempDir();
  const events = [];
  const clock = makeClock();
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: (event) => events.push(event),
    intervalMs: 1000,
    clock,
  });
  // Stopped in generation 1, resumed, completed in generation 2: both notify.
  await appendEvent({ stateRoot: dir, event: { type: "run", runId: "r1", generation: 1, runState: "needs-input" } });
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1", generation: 2, runState: "completed" } });
  // The lifecycle event for the same completion collapses into the handoff notification.
  await appendEvent({ stateRoot: dir, event: { type: "run", runId: "r1", generation: 2, runState: "completed" } });
  await watcher.poll();
  assert.equal(events.length, 2);
  assert.equal(events[0].generation, 1);
  assert.equal(events[1].type, "handoff");
  assert.equal(events[1].generation, 2);
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher reports scheduled poll errors and keeps polling", async () => {
  const dir = await tempDir();
  const errors = [];
  const clock = makeClock();
  const failingFs = {
    async stat() {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
  };
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: () => {},
    onError: (error) => errors.push(error),
    intervalMs: 1000,
    clock,
    fs: failingFs,
  });
  watcher.start();
  clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(watcher.isRunning(), true);
  // Direct callers still observe the rejection.
  await assert.rejects(() => watcher.poll(), /permission denied/);
  watcher.stop();
  await rm(dir, { recursive: true, force: true });
});

test("worker watcher contains a delivery failure and still delivers remaining events", async () => {
  const dir = await tempDir();
  const delivered = [];
  const errors = [];
  const clock = makeClock();
  const watcher = createWorkerWatcher({
    stateRoot: dir,
    onEvent: (event) => {
      if (event.runId === "r-bad") throw new Error("delivery failed");
      delivered.push(event.runId);
    },
    onError: (error) => errors.push(error),
    intervalMs: 1000,
    clock,
  });
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r-bad", runState: "completed" } });
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r-good", runState: "completed" } });
  await watcher.poll();
  assert.deepEqual(delivered, ["r-good"]);
  assert.equal(errors.length, 1);
  await rm(dir, { recursive: true, force: true });
});
