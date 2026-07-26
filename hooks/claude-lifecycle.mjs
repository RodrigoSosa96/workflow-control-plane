#!/usr/bin/env node
// Claude analog of .pi/extensions/workflow-worker-lifecycle.ts: drives the neutral
// run-state machine (src/workflow/lifecycle.js) from Claude Code's own lifecycle hooks
// instead of Pi's extension events. Claude has no non-interactive JSON event stream
// comparable to Pi's --mode json, so this is wired in via a `--settings` hooks entry
// per event (see buildClaudeWorkerSettings in src/workflow/harnesses.js) and invoked
// once per event as `node hooks/claude-lifecycle.mjs <event>` with the hook payload on
// stdin.
//
// Unlike the Pi extension, Claude does not fire UserPromptSubmit for a Stop-hook block
// continuation (confirmed in the Task 7 probe), so there is no "continuation" source and
// no local pendingContinuation flag to track it: the launching-vs-running state check in
// lifecycle.js's onPrompt (via current.state here) is the only follow-up discriminator
// needed.
//
// UserPromptSubmit is the single work-start driver (the analog of Pi's agent_start).
// SessionStart is deliberately NOT wired (see CLAUDE_WORKER_HOOKS): it fires before the
// first real prompt and would otherwise consume the LAUNCHING→RUNNING transition, making
// the first UserPromptSubmit look like a follow-up and pushing every generation off-by-one.
//
// The hook also records the run's telemetry phase (running on a prompt; settled / running /
// manual-recovery on stop, per the onStop action) so the statusLine widget reflects real
// state instead of staying on "starting". Cost/token telemetry from the transcript is a
// documented follow-up and is not parsed here.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

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
// error must never break the Claude worker (same contract as the rest of this hook).
async function recordPhase(telemetry, runId, phase) {
  if (!telemetry) return;
  try {
    await telemetry.record({ runId, workerId: runId, event: { type: "lifecycle", harness: "claude", phase } });
  } catch {
    // Swallow: a telemetry-record failure must never break the Claude worker.
  }
}

export function continuationPrompt(runId, generation) {
  return `Before ending this turn, create the workflow handoff for run ${runId}, generation ${generation}.`;
}

export async function handoffExists(store, runId, generation) {
  const run = await store.read(runId);
  return Boolean(run && run.state === RUN_STATES.COMPLETED && run.generation === generation);
}

// Pure, testable core: every branch is wrapped so a thrown error (bad stdin, a store
// hiccup, a lifecycle error) is swallowed rather than propagated — a hook must never
// break the worker it's attached to.
export async function runClaudeLifecycleHook({
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
    if (!runId || env.WORKFLOW_HARNESS !== "claude") return undefined;

    const validHandoff = hasValidHandoff ?? (async (generation) => handoffExists(store, runId, generation));

    // SessionStart is deliberately unhandled: it is no longer wired (see CLAUDE_WORKER_HOOKS),
    // and if it ever fired it must be a no-op so it cannot consume the LAUNCHING→RUNNING
    // transition and push every generation off-by-one. UserPromptSubmit is the sole work-start.
    if (event === "UserPromptSubmit") {
      const current = await store.read(runId);
      // The first UserPromptSubmit of a run confirms the launch generation; a later one
      // (state already past "launching") is a follow-up that increments it.
      const isFirst = current.state === RUN_STATES.LAUNCHING;
      const generation = isFirst ? current.generation : current.generation + 1;
      await lifecycle.onPrompt({ runId, generation, source: "user" });
      await recordPhase(telemetry, runId, "running");
      return undefined;
    }

    if (event === "Stop") {
      const current = await store.read(runId);
      const { action } = await lifecycle.onStop({
        runId,
        generation: current.generation,
        hasValidHandoff: await validHandoff(current.generation),
      });
      await recordPhase(telemetry, runId, stopPhaseForAction(action));
      if (action === "continue") {
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
    // Swallow: a lifecycle bookkeeping error must never break the Claude worker.
    return undefined;
  }
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  try {
    const event = process.argv[2];
    const env = process.env;
    const stdinJson = await readStdinJson();
    const store = createRunStore({ stateRoot: env.WORKFLOW_STATE_ROOT });
    const lifecycle = createLifecycle({ store });
    let telemetry;
    try {
      telemetry = createTelemetryStore({ store });
    } catch {
      // Swallow: a telemetry-store construction failure must never break the worker; the
      // lifecycle bookkeeping still runs without it.
      telemetry = undefined;
    }
    const output = await runClaudeLifecycleHook({ event, stdinJson, env, store, lifecycle, telemetry });
    if (typeof output === "string" && output.length > 0) {
      process.stdout.write(output);
    }
  } catch {
    // Swallow: a hook must never fail the Claude worker's turn.
  }
  process.exitCode = 0;
}

let invokedPath;
try {
  invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined;
} catch {
  invokedPath = undefined;
}
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
