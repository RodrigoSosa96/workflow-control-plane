import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPiDelegationTransport } from "../src/workflow/pi-delegation-transport.js";
import { createPiSessionTransport } from "../src/workflow/pi-session-transport.js";
import { assertWorkerTransport, createFakeWorkerTransport } from "../src/workflow/worker-transport.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

test("pi delegation transport satisfies the worker transport contract", () => {
  const transport = createPiDelegationTransport({
    spawnChild: async () => ({ pid: "123", startedAt: "2025-01-01T00:00:00.000Z" }),
    inspectProcess: async () => null,
    stateRoot: "/state/workflow",
    controlPlaneBin: "/control/bin/workflow",
    childExtensionPath: join(projectRoot, ".pi", "extensions", "workflow-delegation-child.ts"),
    agentDirectory: join(projectRoot, ".pi", "agents"),
  });

  assert.equal(assertWorkerTransport(transport), transport);
});

test("pi session transport satisfies the worker transport contract", () => {
  const transport = createPiSessionTransport({
    herdr: {
      async listAgents() { return { agents: [] }; },
      async agentSendKeys() { return { sent: true }; },
    },
  });

  assert.equal(assertWorkerTransport(transport), transport);
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
  const unknown = createFakeWorkerTransport({ observations: [{ state: "unknown", identity }] });
  assert.deepEqual(await unknown.observeExact(identity), { state: "unknown", identity });
  assert.throws(
    () => createFakeWorkerTransport({ observations: [{ state: "unexpected", identity }] }),
    /state|observation/i,
  );
});
