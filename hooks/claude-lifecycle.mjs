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
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

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
  hasValidHandoff,
} = {}) {
  try {
    const runId = env.WORKFLOW_RUN_ID;
    if (!runId || env.WORKFLOW_HARNESS !== "claude") return undefined;

    const validHandoff = hasValidHandoff ?? (async (generation) => handoffExists(store, runId, generation));

    if (event === "SessionStart") {
      const current = await store.read(runId);
      await lifecycle.onPrompt({ runId, generation: current.generation, source: "user" });
      return undefined;
    }

    if (event === "UserPromptSubmit") {
      const current = await store.read(runId);
      // The first UserPromptSubmit of a run confirms the launch generation; a later one
      // (state already past "launching") is a follow-up that increments it.
      const isFirst = current.state === RUN_STATES.LAUNCHING;
      const generation = isFirst ? current.generation : current.generation + 1;
      await lifecycle.onPrompt({ runId, generation, source: "user" });
      return undefined;
    }

    if (event === "Stop") {
      const current = await store.read(runId);
      const { action } = await lifecycle.onStop({
        runId,
        generation: current.generation,
        hasValidHandoff: await validHandoff(current.generation),
      });
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
    const output = await runClaudeLifecycleHook({ event, stdinJson, env, store, lifecycle });
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
