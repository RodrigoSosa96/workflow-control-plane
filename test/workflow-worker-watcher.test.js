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
