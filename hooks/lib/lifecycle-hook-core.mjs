// Shared core for harness lifecycle hooks. Extracted from hooks/claude-lifecycle.mjs, which
// carries the full design rationale for why this exists at all: unlike Pi's in-process
// extension (.pi/extensions/workflow-worker-lifecycle.ts), a harness like Claude or Codex has
// no non-interactive JSON event stream comparable to Pi's --mode json, so the lifecycle is
// driven instead by the harness's own lifecycle hooks — invoked as a stateless subprocess once
// per event, with the hook payload on stdin.
//
// Because the hook is a stateless subprocess, it cannot hold Pi's in-memory `startedOnce` /
// `pendingContinuation` flags. It persists the equivalent markers on the RUN RECORD
// (`${harness}StartedOnce` / `${harness}PendingContinuation`) and reads them back each
// invocation. Those markers — NOT the run state — are the first-prompt / continuation
// discriminators: the parent launch moves the run to RUNNING before the first
// UserPromptSubmit fires, so a state === "launching" check would misclassify the first prompt
// as a follow-up and inflate every generation by one. A Stop-hook block continuation, if it
// triggers its own UserPromptSubmit, is recognized via the pending-continuation marker so it
// reuses the generation instead of bumping it.
//
// The hook also records the run's telemetry phase (running on a prompt; settled / running /
// manual-recovery on stop, per the onStop action) so the statusLine widget reflects real state
// instead of staying on "starting".
//
// This module is parameterized by `harness` so each harness's own thin hook file
// (hooks/claude-lifecycle.mjs, hooks/codex-lifecycle.mjs, ...) delegates here as
// `runLifecycleHook({ harness: "claude" | "codex", ... })`. A run is single-harness, so the
// marker fields never collide even though they share the run record — no per-harness rename is
// needed beyond the `${harness}` prefix already baked into the field names below.
import { RUN_STATES } from "../../src/workflow/run-state.js";

// Maps a lifecycle.onStop action to a telemetry phase. The telemetry phase vocabulary is
// fixed (see TELEMETRY_PHASES), so the neutral run states are projected onto the closest
// phase: a continuation keeps the worker "running", a completed run is "settled", and an
// exhausted-attempts run is "manual-recovery".
function stopPhaseForAction(action) {
  if (action === "manual") return "manual-recovery";
  if (action === "continue") return "running";
  return "settled";
}

// Records a lifecycle telemetry phase so the statusLine widget reflects real state instead of
// staying on "starting". Wrapped so a telemetry-store failure is swallowed — a bookkeeping
// error must never break the worker. The event's harness must match the run's own harness (the
// telemetry store validates this), which is exactly the `harness` this hook was invoked for.
async function recordPhase(telemetry, harness, runId, phase) {
  if (!telemetry) return;
  try {
    await telemetry.record({ runId, workerId: runId, event: { type: "lifecycle", harness, phase } });
  } catch {
    // Swallow: a telemetry-record failure must never break the worker.
  }
}

// Persists a stateless field-merge marker on the run record (the subprocess analog of Pi's
// in-memory startedOnce/pendingContinuation flags). Wrapped so a throw is swallowed — a marker
// write must never break the worker.
async function persistMarker(store, runId, patch) {
  try {
    await store.update(runId, () => ({ ...patch }));
  } catch {
    // Swallow: a marker write must never break the worker.
  }
}

export function continuationPrompt(runId, generation) {
  return `Before ending this turn, create the workflow handoff for run ${runId}, generation ${generation}.`;
}

export async function handoffExists(store, runId, generation) {
  const run = await store.read(runId);
  return Boolean(run && run.state === RUN_STATES.COMPLETED && run.generation === generation);
}

// Pure, testable core: every branch is wrapped so a thrown error (bad stdin, a store hiccup, a
// lifecycle error) is swallowed rather than propagated — a hook must never break the worker
// it's attached to.
export async function runLifecycleHook({
  harness,
  event,
  stdinJson,
  env = {},
  store,
  lifecycle,
  telemetry,
  hasValidHandoff,
} = {}) {
  try {
    const runId = env.WORKFLOW_RUN_ID;
    if (!runId || env.WORKFLOW_HARNESS !== harness) return undefined;

    const startedOnceField = `${harness}StartedOnce`;
    const pendingContinuationField = `${harness}PendingContinuation`;

    const validHandoff = hasValidHandoff ?? (async (generation) => handoffExists(store, runId, generation));

    // SessionStart is deliberately unhandled: it must be a no-op so it cannot consume the
    // LAUNCHING→RUNNING transition and push every generation off-by-one. UserPromptSubmit is
    // the sole work-start.
    if (event === "UserPromptSubmit") {
      const current = await store.read(runId);
      // Discriminate from persisted markers, not run state (the parent moves the run to RUNNING
      // before this first fires): the first prompt confirms the launch generation, a continuation
      // reuses it, and any other user prompt is a follow-up that increments it.
      let source;
      let generation;
      if (!current[startedOnceField]) {
        source = "user";
        generation = current.generation;
        await persistMarker(store, runId, { [startedOnceField]: true });
      } else if (current[pendingContinuationField]) {
        source = "continuation";
        generation = current.generation;
        await persistMarker(store, runId, { [pendingContinuationField]: false });
      } else {
        source = "user";
        generation = current.generation + 1;
      }
      await lifecycle.onPrompt({ runId, generation, source });
      await recordPhase(telemetry, harness, runId, "running");
      return undefined;
    }

    if (event === "Stop") {
      const current = await store.read(runId);
      const { action } = await lifecycle.onStop({
        runId,
        generation: current.generation,
        hasValidHandoff: await validHandoff(current.generation),
      });
      await recordPhase(telemetry, harness, runId, stopPhaseForAction(action));
      if (action === "continue") {
        // Mark the continuation BEFORE returning the block decision, so the UserPromptSubmit it
        // may trigger is recognized as a continuation (reuses the generation) rather than a
        // user follow-up (which would bump it).
        await persistMarker(store, runId, { [pendingContinuationField]: true });
        return JSON.stringify({ decision: "block", reason: continuationPrompt(runId, current.generation) });
      }
      return undefined;
    }

    if (event === "SessionEnd") {
      await lifecycle.onSessionEnd({ runId });
      return undefined;
    }

    return undefined;
  } catch {
    // Swallow: a lifecycle bookkeeping error must never break the worker.
    return undefined;
  }
}
