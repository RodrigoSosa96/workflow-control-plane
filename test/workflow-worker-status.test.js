import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowError } from "../src/workflow/errors.js";
import { applyTelemetryEvent, createTelemetrySnapshot, normalizeTelemetryEvent } from "../src/workflow/telemetry.js";
import { workerStatusCommand } from "../src/workflow/commands.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";

function snapshot() {
  return {
    ...applyTelemetryEvent(createTelemetrySnapshot({
      runId: RUN_ID,
      workerId: WORKER_ID,
      harness: "pi",
      profileName: "pi-worker",
      startedAt: "2026-07-23T00:00:00.000Z",
    }), normalizeTelemetryEvent({ type: "lifecycle", harness: "pi", phase: "running" })),
    identity: { sessionPath: "/private/session.jsonl", sessionId: "opaque", pid: 1234 },
    rawEvents: [{ prompt: "DO-NOT-LEAK" }],
  };
}

test("returns only redacted worker telemetry snapshots", async () => {
  const result = await workerStatusCommand({ runId: RUN_ID }, {
    telemetry: { async read() { return [snapshot()]; } },
  });

  assert.equal(result.command, "worker-status");
  assert.equal(result.workers[0].phase, "running");
  assert.equal(result.workers[0].identity, undefined);
  assert.equal(result.workers[0].rawEvents, undefined);
  assert.equal(JSON.stringify(result).includes("DO-NOT-LEAK"), false);
  assert.equal(JSON.stringify(result).includes("/private/session.jsonl"), false);
});

test("returns an empty list when a run has no telemetry and fails closed on malformed telemetry", async () => {
  const empty = await workerStatusCommand({ runId: RUN_ID }, {
    telemetry: { async read() { return []; } },
  });
  assert.deepEqual(empty.workers, []);

  await assert.rejects(
    () => workerStatusCommand({ runId: RUN_ID }, {
      telemetry: { async read() { throw new WorkflowError("telemetry", "Malformed telemetry snapshot at /private/DO-NOT-LEAK"); } },
    }),
    (error) => {
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /telemetry|manual/i);
      assert.doesNotMatch(error.message, /DO-NOT-LEAK|\/private/);
      return true;
    },
  );
});
