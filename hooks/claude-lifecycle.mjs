#!/usr/bin/env node
// Claude analog of .pi/extensions/workflow-worker-lifecycle.ts: drives the neutral
// run-state machine (src/workflow/lifecycle.js) from Claude Code's own lifecycle hooks
// instead of Pi's extension events. Claude has no non-interactive JSON event stream
// comparable to Pi's --mode json, so this is wired in via a `--settings` hooks entry
// per event (see buildClaudeWorkerSettings in src/workflow/harnesses.js) and invoked
// once per event as `node hooks/claude-lifecycle.mjs <event>` with the hook payload on
// stdin.
//
// UserPromptSubmit is the single work-start driver (the analog of Pi's agent_start).
// SessionStart is deliberately NOT wired (see CLAUDE_WORKER_HOOKS): it fires before the
// first real prompt.
//
// The actual event handling (marker persistence, generation bookkeeping, telemetry phase
// recording, error swallowing) lives in the harness-agnostic core at
// hooks/lib/lifecycle-hook-core.mjs, shared with hooks/codex-lifecycle.mjs (Codex fires the
// same lifecycle hook events as Claude). This file is a thin harness="claude" wrapper plus
// the CLI entrypoint that reads the event/stdin/env and wires up the real store, lifecycle,
// and telemetry.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { createSubprocessOwnOwnershipReader } from "../src/workflow/ownership.js";
import { runLifecycleHook, continuationPrompt, handoffExists } from "./lib/lifecycle-hook-core.mjs";

export { continuationPrompt, handoffExists };

// Thin wrapper: the exact behavior of runClaudeLifecycleHook now lives in the shared core.
export async function runClaudeLifecycleHook(args = {}) {
  return runLifecycleHook({ ...args, harness: "claude" });
}

// One reader per process: acquireLock calls readOwnOwnership() on every lock it takes (every
// prompt, every stop), and createOwnOwnershipReader's memoization only pays for one `ps` spawn
// when every caller shares the SAME reader instance. Module scope (not inside main()) is what
// guarantees that -- this hook process only ever runs one event, but a fresh reader per call
// would still defeat the memoization's purpose the moment main() ran more than once.
const defaultReadOwnOwnership = createSubprocessOwnOwnershipReader();

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

// dependencies is the minimal DI seam bin/workflow.js's own main(argv, dependencies) already
// established for this codebase: every piece defaults to the real thing, so `main()` with no
// arguments is the normal entrypoint call, while tests can override individual pieces (notably
// createRunStore, to observe what it was constructed with) without spawning a subprocess.
export async function main({
  env = process.env,
  readStdin = readStdinJson,
  createRunStore: createRunStoreImpl = createRunStore,
  readOwnOwnership = defaultReadOwnOwnership,
} = {}) {
  try {
    const event = process.argv[2];
    const stdinJson = await readStdin();
    const store = createRunStoreImpl({ stateRoot: env.WORKFLOW_STATE_ROOT, readOwnOwnership });
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
