import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("resume", message, { details });
}

export async function planResume({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  const identity = run.transportIdentity;
  if (!identity) fail("Run has no exact session identity to resume", { runId });
  const observation = await transport.observeExact(identity);
  switch (observation.state) {
    case "active":
    case "idle":
      return { action: "focus", identity };
    case "missing":
      return { action: "relaunch", identity };
    default:
      return { action: "refuse", identity, reason: observation.state };
  }
}
