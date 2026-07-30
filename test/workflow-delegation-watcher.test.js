import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegationWatcher } from "../src/workflow/delegation-watcher.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN_SESSION_ID = "pi-origin-1";
const OTHER_SESSION_ID = "pi-origin-2";

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    now() {
      return now;
    },
    setTimeout(callback, delay) {
      const handle = {
        id: nextId++,
        dueAt: now + delay,
        callback,
        unrefCalled: false,
        unref() {
          handle.unrefCalled = true;
        },
      };
      timers.set(handle.id, handle);
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle?.id);
    },
    async tick(ms) {
      now += ms;
      const ready = [...timers.values()].filter((entry) => entry.dueAt <= now).sort((left, right) => left.dueAt - right.dueAt);
      for (const entry of ready) {
        timers.delete(entry.id);
        await entry.callback();
      }
    },
    pending() {
      return [...timers.values()];
    },
  };
}

function delegationRecord(overrides = {}) {
  return {
    id: DELEGATION_ID,
    parentRunId: RUN_ID,
    role: "code-reviewer",
    mode: "background",
    originSessionId: ORIGIN_SESSION_ID,
    generation: 1,
    state: "completed",
    startFailure: null,
    result: {
      status: "completed",
      generation: 1,
      summary: "Reviewed scope",
      verification: [{ command: "git diff --check", status: "passed" }],
      concerns: [],
      nextAction: "Await coordinator",
    },
    ...overrides,
  };
}

function createDelegations(records) {
  const calls = [];
  const state = records.map((record) => structuredClone(record));

  return {
    async list({ originSessionId }) {
      calls.push({ method: "list", originSessionId });
      return state.map((record) => structuredClone(record));
    },
    async consumeResult({ runId, delegationId, originSessionId }) {
      calls.push({ method: "consumeResult", runId, delegationId, originSessionId });
      const record = state.find((entry) => entry.parentRunId === runId && entry.id === delegationId);
      if (!record) throw new Error("missing record");
      if (record.originSessionId !== originSessionId) throw new Error("wrong origin session");
      if (record.result?.consumedBySessionId) throw new Error("already consumed");
      record.result = {
        ...record.result,
        consumedBySessionId: originSessionId,
        consumedAt: "2025-01-01T00:00:00.000Z",
      };
      return structuredClone(record);
    },
    get calls() {
      return calls;
    },
    get records() {
      return state;
    },
  };
}

test("watcher starts polling only after start, keeps one in-flight poll, consumes terminal results once, and clears timers on shutdown", async () => {
  const clock = createClock();
  const delegations = createDelegations([delegationRecord()]);
  const deliveries = [];
  let releaseList;
  let deferred = true;
  const waitingDelegations = {
    async list({ originSessionId }) {
      delegations.calls.push({ method: "list", originSessionId });
      if (!deferred) return delegations.records.map((record) => structuredClone(record));
      return await new Promise((resolve) => {
        releaseList = () => {
          deferred = false;
          resolve(delegations.records.map((record) => structuredClone(record)));
        };
      });
    },
    consumeResult: delegations.consumeResult,
    get calls() {
      return delegations.calls;
    },
  };

  const watcher = createDelegationWatcher({
    delegations: waitingDelegations,
    originSessionId: ORIGIN_SESSION_ID,
    intervalMs: 25,
    clock,
    async onResult(result) {
      deliveries.push(result);
    },
  });

  await clock.tick(100);
  assert.equal(waitingDelegations.calls.length, 0);

  watcher.start();
  assert.equal(clock.pending().length, 1);
  assert.equal(clock.pending()[0].unrefCalled, true);
  await clock.tick(25);
  const firstPoll = watcher.poll();
  const secondPoll = watcher.poll();
  assert.equal(firstPoll, secondPoll);
  releaseList();
  await firstPoll;
  await secondPoll;

  await watcher.poll();
  await watcher.poll();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].delegationId, DELEGATION_ID);
  assert.deepEqual(Object.keys(deliveries[0]).sort(), [
    "concerns",
    "delegationId",
    "generation",
    "nextAction",
    "role",
    "runId",
    "state",
    "summary",
    "verification",
  ]);
  assert.equal(waitingDelegations.calls.filter((call) => call.method === "consumeResult").length, 1);

  watcher.stop();
  assert.equal(clock.pending().length, 0);
});

test("watcher never injects wrong-origin or already-consumed results, and a later session must explicitly adopt them", async () => {
  const wrongOrigin = createDelegations([
    delegationRecord({ originSessionId: OTHER_SESSION_ID }),
    delegationRecord({ id: "33333333-3333-4333-8333-333333333333", result: { ...delegationRecord().result, consumedBySessionId: ORIGIN_SESSION_ID } }),
  ]);
  const deliveries = [];
  const watcher = createDelegationWatcher({
    delegations: wrongOrigin,
    originSessionId: ORIGIN_SESSION_ID,
    clock: createClock(),
    async onResult(result) {
      deliveries.push(result);
    },
  });

  await watcher.poll();
  assert.deepEqual(deliveries, []);
  assert.equal(wrongOrigin.calls.some((call) => call.method === "consumeResult"), false);

  const laterSession = createDelegations([delegationRecord({ originSessionId: OTHER_SESSION_ID })]);
  const adoptedDeliveries = [];
  const laterWatcher = createDelegationWatcher({
    delegations: laterSession,
    originSessionId: ORIGIN_SESSION_ID,
    clock: createClock(),
    async onResult(result) {
      adoptedDeliveries.push(result);
    },
  });

  await laterWatcher.poll();
  assert.deepEqual(adoptedDeliveries, []);
});

test("watcher survives reload races without losing results and reports stale/manual states as notices instead of completion deliveries", async () => {
  const clock = createClock();
  const delegations = createDelegations([
    delegationRecord(),
    delegationRecord({
      id: "33333333-3333-4333-8333-333333333333",
      state: "failed",
      result: { ...delegationRecord().result, generation: 0 },
      startFailure: { reason: "Delegation transport start failed", failedAt: "2025-01-01T00:00:00.000Z" },
    }),
  ]);
  const deliveries = [];
  const notices = [];

  const firstWatcher = createDelegationWatcher({
    delegations,
    originSessionId: ORIGIN_SESSION_ID,
    clock,
    async onResult(result) {
      deliveries.push({ watcher: "first", result });
    },
    async onNotice(notice) {
      notices.push(notice);
    },
  });
  firstWatcher.start();
  await firstWatcher.poll();
  firstWatcher.stop();

  const secondWatcher = createDelegationWatcher({
    delegations,
    originSessionId: ORIGIN_SESSION_ID,
    clock,
    async onResult(result) {
      deliveries.push({ watcher: "second", result });
    },
    async onNotice(notice) {
      notices.push(notice);
    },
  });
  await secondWatcher.poll();

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].watcher, "first");
  assert.equal(notices.length, 1);
  assert.match(notices[0].reason, /stale|manual/i);
});

test("watcher retries a result whose delivery failed instead of consuming it", async () => {
  const clock = createClock();
  const delegations = createDelegations([delegationRecord()]);
  const deliveries = [];
  const errors = [];
  let failuresRemaining = 1;
  const watcher = createDelegationWatcher({
    delegations,
    originSessionId: ORIGIN_SESSION_ID,
    clock,
    async onResult(result) {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("delivery failed");
      }
      deliveries.push(result);
    },
    onError: (error) => errors.push(error),
  });

  await watcher.poll();
  // The failed delivery must not consume the record: it stays available for retry.
  assert.equal(deliveries.length, 0);
  assert.equal(delegations.calls.filter((call) => call.method === "consumeResult").length, 0);
  assert.equal(errors.length, 1);

  await watcher.poll();
  assert.equal(deliveries.length, 1);
  assert.equal(delegations.calls.filter((call) => call.method === "consumeResult").length, 1);
});

test("watcher reports scheduled poll failures and keeps polling", async () => {
  const clock = createClock();
  const errors = [];
  const delegations = {
    async list() {
      throw new Error("store unavailable");
    },
    async consumeResult() {
      throw new Error("unreachable");
    },
  };
  const watcher = createDelegationWatcher({
    delegations,
    originSessionId: ORIGIN_SESSION_ID,
    clock,
    onResult: async () => {},
    onError: (error) => errors.push(error),
  });
  watcher.start();
  await clock.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(watcher.isRunning(), true);
  // The loop rescheduled itself despite the failure.
  assert.equal(clock.pending().length, 1);
  watcher.stop();
});

test("a result whose consume keeps failing is delivered once, not on every poll", async () => {
  // Delivery precedes consume so a failed delivery retries, but a persistently
  // failing consume (a stale run lock is crash residue the design never clears)
  // must not re-deliver the same result every 5 seconds forever.
  const clock = createClock();
  const records = [delegationRecord()];
  const deliveries = [];
  const errors = [];
  let consumeAttempts = 0;
  const delegations = {
    async list() {
      return structuredClone(records);
    },
    async consumeResult() {
      consumeAttempts += 1;
      throw new Error("Run is locked by an active lock");
    },
  };
  const watcher = createDelegationWatcher({
    delegations,
    originSessionId: ORIGIN_SESSION_ID,
    clock,
    async onResult(result) {
      deliveries.push(result);
    },
    onError: (error) => errors.push(error),
  });

  for (let poll = 0; poll < 5; poll += 1) await watcher.poll();

  assert.equal(deliveries.length, 1);
  assert.equal(consumeAttempts, 5);
  assert.equal(errors.length, 5);
});

test("a notice whose delivery fails is retried instead of being permanently suppressed", async () => {
  const clock = createClock();
  const records = [delegationRecord({
    state: "failed",
    result: { ...delegationRecord().result, generation: 0 },
    startFailure: { reason: "Delegation transport start failed", failedAt: "2025-01-01T00:00:00.000Z" },
  })];
  const notices = [];
  const errors = [];
  let failNext = true;
  const watcher = createDelegationWatcher({
    delegations: {
      async list() {
        return structuredClone(records);
      },
      async consumeResult() {
        assert.fail("a start failure has no consumable result");
      },
    },
    originSessionId: ORIGIN_SESSION_ID,
    clock,
    onResult: async () => {},
    async onNotice(notice) {
      if (failNext) {
        failNext = false;
        throw new Error("extension host hiccup");
      }
      notices.push(notice);
    },
    onError: (error) => errors.push(error),
  });

  await watcher.poll();
  assert.deepEqual(notices, []);
  assert.equal(errors.length, 1);

  await watcher.poll();
  assert.equal(notices.length, 1);

  // Delivered once it succeeded; not repeated afterwards.
  await watcher.poll();
  assert.equal(notices.length, 1);
});
