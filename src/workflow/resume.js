import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

export async function planResume({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  if (!run) throw new WorkflowError("resume", `Run ${runId} not found`, { details: { runId } });
  const identity = run.transportIdentity;
  if (!identity) throw new WorkflowError("resume", "Run has no exact session identity to resume", { details: { runId } });
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
