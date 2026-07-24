import assert from "node:assert/strict";
import { test } from "node:test";
import { closeWorker } from "../src/workflow/close.js";

function deps({ state }) {
  const identity = { kind: "pi-session", sessionId: "s1" };
  const calls = [];
  return {
    calls,
    store: { async read() { return { id: "r1", transportIdentity: identity }; } },
    transport: {
      start() {}, deliverFollowUp() {},
      async observeExact() { return { state, identity }; },
      async requestGracefulClose(id) { calls.push(id); return { closed: true }; },
    },
  };
}

test("closes only an idle worker; refuses a working or unconfirmed one", async () => {
  const idle = deps({ state: "idle" });
  assert.equal((await closeWorker({ ...idle, runId: "r1" })).closed, true);
  assert.equal(idle.calls.length, 1);

  const working = deps({ state: "active" });
  const r = await closeWorker({ ...working, runId: "r1" });
  assert.equal(r.closed, false);
  assert.equal(working.calls.length, 0);

  const unknown = deps({ state: "unknown" });
  assert.equal((await closeWorker({ ...unknown, runId: "r1" })).closed, false);
});
