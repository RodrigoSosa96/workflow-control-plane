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

const MAX_STOP_ATTEMPTS = 2;

const TERMINAL_RUN_STATES = new Set([
  RUN_STATES.COMPLETED,
  RUN_STATES.FAILED,
  RUN_STATES.MANUAL_HANDOFF_REQUIRED,
  RUN_STATES.RESULT_STALE,
]);

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

  async function onStop({ runId, generation, hasValidHandoff }) {
    const existing = await store.read(runId);
    if (!existing) fail(`Run ${runId} not found`, { runId });

    // The decision (stale generation? valid handoff? attempts exhausted?) is made
    // inside the store.update updater, from its lock-protected `current` argument —
    // not from the outer `existing` read above, which is fail-fast-only. This mirrors
    // the onPrompt fix from the Task 2 review: computing decisions from a separate,
    // unlocked outer read is a read/decide/update race against concurrent stop/prompt
    // calls for the same run.
    let action = "none";
    const run = await store.update(runId, (current) => {
      if (generation !== current.generation) {
        action = "none";
        return {};
      }
      if (hasValidHandoff) {
        action = "none";
        return { state: RUN_STATES.COMPLETED, updatedAt: clock() };
      }
      const attempts = (current.stopAttempts ?? 0) + 1;
      if (attempts > MAX_STOP_ATTEMPTS) {
        action = "manual";
        return { state: RUN_STATES.MANUAL_HANDOFF_REQUIRED, updatedAt: clock() };
      }
      action = "continue";
      return {
        state: current.state === RUN_STATES.RUNNING ? RUN_STATES.IDLE_AWAITING_HANDOFF : current.state,
        stopAttempts: attempts,
        updatedAt: clock(),
      };
    });
    return { run, action };
  }

  async function onSessionEnd({ runId }) {
    const existing = await store.read(runId);
    if (!existing) fail(`Run ${runId} not found`, { runId });

    // Same pattern: whether the run is already terminal is decided from the
    // updater's lock-protected `current`, not the outer fail-fast read.
    return store.update(runId, (current) => {
      if (TERMINAL_RUN_STATES.has(current.state)) return {};
      return { state: RUN_STATES.INTERRUPTED, updatedAt: clock() };
    });
  }

  return { onPrompt, onStop, onSessionEnd };
}
