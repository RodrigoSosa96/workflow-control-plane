import assert from "node:assert/strict";
import { test } from "node:test";
import { closeCommand, resumeCommand } from "../src/workflow/commands.js";
import { WorkflowError } from "../src/workflow/errors.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function transportIdentity() {
  return { kind: "pi-session", sessionId: "s1" };
}

function storeFor(run) {
  const calls = [];
  return {
    calls,
    async read(runId) {
      calls.push(runId);
      return structuredClone(run);
    },
    async update() {
      assert.fail("resume/close commands must stay read-only");
    },
  };
}

function transportFor(observation) {
  const calls = [];
  return {
    calls,
    async start() {
      assert.fail("resume/close commands must not start a worker");
    },
    async observeExact(identity) {
      calls.push({ method: "observeExact", identity: structuredClone(identity) });
      return structuredClone(observation ?? { state: "idle", identity });
    },
    async deliverFollowUp() {
      assert.fail("resume/close commands must not deliver follow-ups");
    },
    async requestGracefulClose(identity) {
      calls.push({ method: "requestGracefulClose", identity: structuredClone(identity) });
      return { requested: true };
    },
  };
}

test("resumeCommand returns the planResume result for an exact session over the injected transport", async () => {
  const identity = transportIdentity();
  const store = storeFor({ id: RUN_ID, transportIdentity: identity });
  const transport = transportFor({ state: "idle", identity });

  const result = await resumeCommand({ runId: RUN_ID }, { store, transport });

  assert.deepEqual(result, {
    command: "resume",
    runId: RUN_ID,
    action: "focus",
    identity,
  });
  assert.deepEqual(store.calls, [RUN_ID]);
  assert.deepEqual(transport.calls.map((call) => call.method), ["observeExact"]);
});

test("resumeCommand surfaces the resume-category error for a run with no transport identity", async () => {
  const store = storeFor({ id: RUN_ID });
  const transport = transportFor({ state: "idle" });

  await assert.rejects(
    () => resumeCommand({ runId: RUN_ID }, { store, transport }),
    (error) => error instanceof WorkflowError && error.category === "resume",
  );
  assert.deepEqual(transport.calls, []);
});

test("resumeCommand requires a worker transport dependency", async () => {
  const store = storeFor({ id: RUN_ID, transportIdentity: transportIdentity() });

  await assert.rejects(
    () => resumeCommand({ runId: RUN_ID }, { store }),
    (error) => error instanceof WorkflowError
      && error.category === "PREFLIGHT"
      && error.exitCode === 10
      && /resume requires a worker transport/i.test(error.message),
  );
  assert.deepEqual(store.calls, []);
});

test("closeCommand closes an idle worker and requests a graceful close", async () => {
  const identity = transportIdentity();
  const store = storeFor({ id: RUN_ID, transportIdentity: identity });
  const transport = transportFor({ state: "idle", identity });

  const result = await closeCommand({ runId: RUN_ID }, { store, transport });

  assert.deepEqual(result, { command: "close", runId: RUN_ID, closed: true });
  assert.deepEqual(transport.calls.map((call) => call.method), ["observeExact", "requestGracefulClose"]);
});

test("closeCommand refuses an active worker with reason 'working' and never requests a close", async () => {
  const identity = transportIdentity();
  const store = storeFor({ id: RUN_ID, transportIdentity: identity });
  const transport = transportFor({ state: "active", identity });

  const result = await closeCommand({ runId: RUN_ID }, { store, transport });

  assert.deepEqual(result, { command: "close", runId: RUN_ID, closed: false, reason: "working" });
  assert.deepEqual(transport.calls.map((call) => call.method), ["observeExact"]);
});

test("closeCommand requires a worker transport dependency", async () => {
  const store = storeFor({ id: RUN_ID, transportIdentity: transportIdentity() });

  await assert.rejects(
    () => closeCommand({ runId: RUN_ID }, { store }),
    (error) => error instanceof WorkflowError
      && error.category === "PREFLIGHT"
      && error.exitCode === 10
      && /close requires a worker transport/i.test(error.message),
  );
  assert.deepEqual(store.calls, []);
});
