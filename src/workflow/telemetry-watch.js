import { WorkflowError } from "./errors.js";
import { publicTelemetrySnapshot } from "./telemetry.js";

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  throw new WorkflowError("telemetry", message);
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) fail("Invalid telemetry run ID");
  return runId.toLowerCase();
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function publicSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) fail("Telemetry store returned invalid snapshots");
  return snapshots
    .map((snapshot) => publicTelemetrySnapshot(snapshot))
    .sort((left, right) => left.workerId.localeCompare(right.workerId));
}

export function createWorkerWatch({ runId, telemetry, intervalMs = 1000, sleep = defaultSleep, signal } = {}) {
  const id = assertRunId(runId);
  if (!telemetry || typeof telemetry.read !== "function") fail("Worker watch requires a telemetry store");
  if (!Number.isInteger(intervalMs) || intervalMs < 1) fail("Worker watch interval must be a positive integer");
  if (typeof sleep !== "function") fail("Worker watch sleep must be a function");

  return (async function* watch() {
    let previous = null;
    while (!signal?.aborted) {
      const snapshots = publicSnapshots(await telemetry.read({ runId: id }));
      const fingerprint = JSON.stringify(snapshots);
      if (fingerprint !== previous) {
        previous = fingerprint;
        yield snapshots;
      }
      if (signal?.aborted) return;
      await sleep(intervalMs, signal);
    }
  }());
}
