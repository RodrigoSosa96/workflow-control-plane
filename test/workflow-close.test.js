import assert from "node:assert/strict";
import { test } from "node:test";
import { closeWorker } from "../src/workflow/close.js";

function deps({ state, transportIdentity } = {}) {
  const identity = transportIdentity === undefined
    ? { kind: "pi-session", sessionId: "s1" }
    : transportIdentity;
  const calls = [];
  const observeCalls = [];
  return {
    calls,
    observeCalls,
    store: { async read() { return { id: "r1", transportIdentity: identity }; } },
    transport: {
      start() {}, deliverFollowUp() {},
      async observeExact(id) { observeCalls.push(id); return { state, identity }; },
      async requestGracefulClose(id) { calls.push(id); return { closed: true }; },
    },
  };
}

test("idle worker: closes and reports no reason", async () => {
  const idle = deps({ state: "idle" });
  const result = await closeWorker({ ...idle, runId: "r1" });
  assert.deepEqual(result, { closed: true });
  assert.equal(idle.calls.length, 1);
});

test("active worker: refuses with reason 'working' and never requests close", async () => {
  const working = deps({ state: "active" });
  const result = await closeWorker({ ...working, runId: "r1" });
  assert.deepEqual(result, { closed: false, reason: "working" });
  assert.equal(working.calls.length, 0);
});

test("unknown state: refuses with reason 'identity-unconfirmed' and never requests close", async () => {
  const unknown = deps({ state: "unknown" });
  const result = await closeWorker({ ...unknown, runId: "r1" });
  assert.deepEqual(result, { closed: false, reason: "identity-unconfirmed" });
  assert.equal(unknown.calls.length, 0);
});

test("mismatch state: refuses with reason 'identity-unconfirmed' and never requests close", async () => {
  const mismatch = deps({ state: "mismatch" });
  const result = await closeWorker({ ...mismatch, runId: "r1" });
  assert.deepEqual(result, { closed: false, reason: "identity-unconfirmed" });
  assert.equal(mismatch.calls.length, 0);
});

test("missing state: refuses with reason 'identity-unconfirmed' and never requests close", async () => {
  const missing = deps({ state: "missing" });
  const result = await closeWorker({ ...missing, runId: "r1" });
  assert.deepEqual(result, { closed: false, reason: "identity-unconfirmed" });
  assert.equal(missing.calls.length, 0);
});

test("no transportIdentity: refuses with reason 'no-identity' without observing or closing", async () => {
  const noIdentity = deps({ transportIdentity: null });
  const result = await closeWorker({ ...noIdentity, runId: "r1" });
  assert.deepEqual(result, { closed: false, reason: "no-identity" });
  assert.equal(noIdentity.observeCalls.length, 0);
  assert.equal(noIdentity.calls.length, 0);
});
