import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("close", message, { details });
}

export async function closeWorker({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  const identity = run.transportIdentity;
  if (!identity) return { closed: false, reason: "no-identity" };
  const observation = await transport.observeExact(identity);
  if (observation.state !== "idle") {
    return { closed: false, reason: observation.state === "active" ? "working" : "identity-unconfirmed" };
  }
  await transport.requestGracefulClose(identity);
  return { closed: true };
}
