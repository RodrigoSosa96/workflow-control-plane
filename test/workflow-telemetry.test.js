import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTelemetryEvent,
  createTelemetrySnapshot,
  normalizeTelemetryEvent,
  publicTelemetrySnapshot,
} from "../src/workflow/telemetry.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";
const STARTED_AT = "2026-07-23T00:00:00.000Z";

function snapshot() {
  return createTelemetrySnapshot({
    runId: RUN_ID,
    workerId: WORKER_ID,
    harness: "pi",
    profileName: "pi-worker",
    startedAt: STARTED_AT,
  });
}

test("normalizes bounded provider measurements and redacts private identity", () => {
  const normalized = normalizeTelemetryEvent({
    type: "usage",
    harness: "pi",
    tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 },
    cost: 0.01,
    context: 15,
    at: "2026-07-23T00:00:01.000Z",
  });
  const next = applyTelemetryEvent(snapshot(), normalized);

  assert.equal(next.usage.input.value, 10);
  assert.equal(next.usage.output.value, 2);
  assert.equal(next.usage.cacheRead.value, 3);
  assert.equal(next.usage.cacheWrite.value, 0);
  assert.equal(next.usage.cost.availability, "reported");
  assert.equal(next.usage.context.value, 15);

  const publicSnapshot = publicTelemetrySnapshot({
    ...next,
    identity: { sessionPath: "/private/session.json", pid: 1234 },
    rawEvents: [{ prompt: "DO-NOT-LEAK" }],
  });
  assert.equal(publicSnapshot.identity, undefined);
  assert.equal(publicSnapshot.rawEvents, undefined);
  assert.equal(JSON.stringify(publicSnapshot).includes("DO-NOT-LEAK"), false);
  assert.equal(JSON.stringify(publicSnapshot).includes("/private/session.json"), false);
});

test("starts optional telemetry as not-reported and never decreases reported counters", () => {
  const first = applyTelemetryEvent(snapshot(), normalizeTelemetryEvent({
    type: "usage",
    harness: "pi",
    tokens: { input: 10 },
  }));
  const next = applyTelemetryEvent(first, normalizeTelemetryEvent({
    type: "usage",
    harness: "pi",
    tokens: { input: 4, output: 3 },
  }));

  assert.deepEqual(snapshot().usage.output, { availability: "not-reported", value: null });
  assert.equal(next.usage.input.value, 10);
  assert.equal(next.usage.output.value, 3);
  assert.equal(next.usage.cost.availability, "not-reported");
});

test("preserves provider-reported model and thinking metadata", () => {
  const next = applyTelemetryEvent(snapshot(), normalizeTelemetryEvent({
    type: "model",
    harness: "pi",
    model: "gpt-5",
    thinking: true,
  }));

  assert.equal(next.model, "gpt-5");
  assert.deepEqual(next.thinking, { availability: "reported", value: true });
  assert.deepEqual(publicTelemetrySnapshot(next).thinking, { availability: "reported", value: true });

  const level = applyTelemetryEvent(snapshot(), normalizeTelemetryEvent({
    type: "model",
    harness: "pi",
    model: "gpt-5",
    thinking: "high",
  }));
  assert.deepEqual(publicTelemetrySnapshot(level).thinking, { availability: "reported", value: "high" });
});

test("rejects unbounded or transcript-bearing telemetry input without echoing it", () => {
  const secret = "DO-NOT-LEAK-PROMPT";
  for (const input of [
    { type: "tool", harness: "pi", tool: { command: "cat .env" } },
    { type: "lifecycle", harness: "pi", phase: "running", prompt: secret },
    { type: "usage", harness: "pi", tokens: { input: -1 } },
    { type: "model", harness: "pi", model: "x".repeat(129) },
    { type: "usage", harness: "pi", tokens: { input: 1, transcript: secret } },
  ]) {
    assert.throws(
      () => normalizeTelemetryEvent(input),
      (error) => {
        assert.match(error.message, /unsupported|telemetry|token|model/i);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  }
});

test("keeps unknown telemetry fail-closed for later lifecycle updates", () => {
  const unknown = applyTelemetryEvent(snapshot(), normalizeTelemetryEvent({
    type: "lifecycle",
    harness: "pi",
    phase: "unknown",
  }));
  const later = applyTelemetryEvent(unknown, normalizeTelemetryEvent({
    type: "lifecycle",
    harness: "pi",
    phase: "running",
  }));

  assert.equal(unknown.phase, "unknown");
  assert.equal(later.phase, "unknown");
  assert.equal(later.observability, "unknown");
});
