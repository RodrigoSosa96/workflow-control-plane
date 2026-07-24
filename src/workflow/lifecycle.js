import { RUN_STATES } from "./run-state.js";
import { WorkflowError } from "./errors.js";

const PROMPT_SOURCES = new Set(["user", "continuation"]);

function fail(message, details) {
  throw new WorkflowError("lifecycle", message, { details });
}

function assertValidSource(source) {
  if (!PROMPT_SOURCES.has(source)) {
    fail("onPrompt source must be \"user\" or \"continuation\"", { source });
  }
}

function assertValidGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail("onPrompt generation must be a positive integer", { generation });
  }
}

export function createLifecycle({ store, clock = () => new Date().toISOString() }) {
  if (!store || typeof store.read !== "function" || typeof store.update !== "function") {
    fail("lifecycle requires a run store");
  }

  async function onPrompt({ runId, generation, source }) {
    assertValidSource(source);
    assertValidGeneration(generation);

    const existing = await store.read(runId);
    if (!existing) fail(`Run ${runId} not found`, { runId });

    return store.update(runId, (current) => {
      const isFollowUp = source === "user" && current.state !== RUN_STATES.LAUNCHING && generation > current.generation;
      return {
        state: RUN_STATES.RUNNING,
        generation: isFollowUp ? generation : current.generation,
        updatedAt: clock(),
        ...(isFollowUp ? { stopAttempts: 0, previousGeneration: current.generation } : {}),
      };
    });
  }

  return { onPrompt };
}
