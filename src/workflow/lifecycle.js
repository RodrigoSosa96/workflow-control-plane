import { RUN_STATES } from "./run-state.js";
import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("lifecycle", message, { details });
}

export function createLifecycle({ store, clock = () => new Date().toISOString() }) {
  if (!store || typeof store.read !== "function" || typeof store.update !== "function") {
    fail("lifecycle requires a run store");
  }

  async function onPrompt({ runId, generation, source }) {
    const current = await store.read(runId);
    if (!current) fail(`Run ${runId} not found`, { runId });
    const isFollowUp = source === "user" && current.state !== RUN_STATES.LAUNCHING && generation > current.generation;
    return store.update(runId, () => ({
      state: RUN_STATES.RUNNING,
      generation,
      stopAttempts: 0,
      updatedAt: clock(),
      ...(isFollowUp ? { previousGeneration: current.generation } : {}),
    }));
  }

  return { onPrompt };
}
