import { assertWorkerTransport } from "./worker-transport.js";

export async function closeWorker({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  const identity = run.transportIdentity;
  if (!identity) return { closed: false, reason: "no-identity" };
  const observation = await transport.observeExact(identity);
  if (observation.state !== "idle") {
    return { closed: false, reason: observation.state === "active" ? "working" : "identity-unconfirmed" };
  }
  const result = await transport.requestGracefulClose(identity);
  return result?.requested === true
    ? { closed: true }
    : { closed: false, reason: "close-not-confirmed" };
}
