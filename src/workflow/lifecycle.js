import { RUN_STATES, canTransition } from "./run-state.js";
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
    //
    // This runs inside the Pi extension's fire-and-forget pi.on(...) handlers, where a
    // throw is an unhandled rejection on a normal path — so every branch that would
    // change state is guarded with canTransition and downgraded to a no-op (with the
    // action the caller would otherwise expect) rather than letting transitionRun throw.
    let action = "none";
    const run = await store.update(runId, (current) => {
      if (generation !== current.generation) {
        action = "none";
        return {};
      }
      if (hasValidHandoff) {
        action = "none";
        if (!canTransition(current.state, RUN_STATES.COMPLETED)) return {};
        return { state: RUN_STATES.COMPLETED, updatedAt: clock() };
      }
      const attempts = (current.stopAttempts ?? 0) + 1;
      if (attempts > MAX_STOP_ATTEMPTS) {
        action = "manual";
        if (!canTransition(current.state, RUN_STATES.MANUAL_HANDOFF_REQUIRED)) return {};
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

    // Same pattern: whether the transition is legal is decided from the updater's
    // lock-protected `current`, not the outer fail-fast read. canTransition is the
    // authoritative check here (it also covers already-terminal states, since none of
    // them allow a transition to interrupted).
    return store.update(runId, (current) => {
      if (!canTransition(current.state, RUN_STATES.INTERRUPTED)) return {};
      return { state: RUN_STATES.INTERRUPTED, updatedAt: clock() };
    });
  }

  return { onPrompt, onStop, onSessionEnd };
}
