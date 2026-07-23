import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTelemetryEvent, createTelemetrySnapshot, normalizeTelemetryEvent } from "../src/workflow/telemetry.js";
import { createWorkerWatch } from "../src/workflow/telemetry-watch.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";

function worker(phase) {
  return applyTelemetryEvent(createTelemetrySnapshot({
    runId: RUN_ID,
    workerId: WORKER_ID,
    harness: "pi",
    profileName: "pi-worker",
    startedAt: "2026-07-23T00:00:00.000Z",
  }), normalizeTelemetryEvent({
    type: "lifecycle",
    harness: "pi",
    phase,
    at: phase === "running" ? "2026-07-23T00:00:01.000Z" : "2026-07-23T00:00:00.000Z",
  }));
}

test("emits initial and changed redacted snapshots while suppressing duplicates", async () => {
  const reads = [[worker("starting")], [worker("starting")], [worker("running")]];
  let sleepCalls = 0;
  const telemetry = {
    async read() {
      return reads.shift() ?? [worker("running")];
    },
  };
  const watch = createWorkerWatch({
    runId: RUN_ID,
    telemetry,
    intervalMs: 1,
    sleep: async () => { sleepCalls += 1; },
  });

  assert.equal((await watch.next()).value[0].phase, "starting");
  assert.equal((await watch.next()).value[0].phase, "running");
  await watch.return();
  assert.equal(sleepCalls, 2);
});

test("stops on abort and never invokes telemetry write methods", async () => {
  const controller = new AbortController();
  let reads = 0;
  const telemetry = {
    async read() {
      reads += 1;
      return [worker("starting")];
    },
    async record() {
      throw new Error("watch must not write");
    },
  };
  const watch = createWorkerWatch({
    runId: RUN_ID,
    telemetry,
    intervalMs: 1,
    signal: controller.signal,
    sleep: async () => { controller.abort(); },
  });

  assert.equal((await watch.next()).value[0].phase, "starting");
  assert.deepEqual(await watch.next(), { value: undefined, done: true });
  assert.equal(reads, 1);
});
