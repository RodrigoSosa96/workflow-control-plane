import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWorkerTransport, createFakeWorkerTransport } from "../src/workflow/worker-transport.js";

const identity = Object.freeze({ kind: "herdr", paneId: "pane-1", processId: "pid-1" });

test("requires each worker transport operation", () => {
  for (const missing of ["start", "observeExact", "deliverFollowUp", "requestGracefulClose"]) {
    const transport = {
      start: async () => {},
      observeExact: async () => {},
      deliverFollowUp: async () => {},
      requestGracefulClose: async () => {},
    };
    delete transport[missing];
    assert.throws(() => assertWorkerTransport(transport), new RegExp(missing));
  }
});

test("fake transport preserves exact identities and records no process side effects", async () => {
  const transport = createFakeWorkerTransport({
    observations: [{ state: "idle", identity, details: { source: "fixture" } }],
  });

  assert.deepEqual(await transport.start({ identity, assignmentDigest: `sha256:${"a".repeat(64)}` }), { identity });
  assert.deepEqual(await transport.observeExact(identity), {
    state: "idle",
    identity,
    details: { source: "fixture" },
  });
  assert.deepEqual(await transport.deliverFollowUp(identity, "Apply the reviewed correction."), { delivered: true, identity });
  assert.deepEqual(await transport.requestGracefulClose(identity), { requested: true, identity });
  assert.deepEqual(transport.calls.map((call) => call.method), ["start", "observeExact", "deliverFollowUp", "requestGracefulClose"]);
});

test("rejects unsafe prompts and terminal-derived observations", async () => {
  const transport = createFakeWorkerTransport();

  await assert.rejects(() => transport.deliverFollowUp(identity, ""), /prompt/i);
  await assert.rejects(() => transport.deliverFollowUp(identity, `x\0${"x"}`), /prompt/i);
  await assert.rejects(() => transport.deliverFollowUp(identity, "x".repeat(70 * 1024)), /prompt/i);
  assert.throws(
    () => createFakeWorkerTransport({ observations: [{ state: "idle", identity, details: { terminal: "do not trust this" } }] }),
    /terminal|observation/i,
  );
  assert.throws(
    () => createFakeWorkerTransport({ observations: [{ state: "unknown", identity }] }),
    /state|observation/i,
  );
});
