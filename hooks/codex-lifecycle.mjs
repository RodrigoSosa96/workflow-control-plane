#!/usr/bin/env node
// Codex analog of hooks/claude-lifecycle.mjs. Codex fires the same lifecycle hook events as
// Claude (UserPromptSubmit, Stop, SessionEnd), so this hook is full parity: it drives the same
// neutral run-state machine (src/workflow/lifecycle.js) via the shared, harness-agnostic core
// at hooks/lib/lifecycle-hook-core.mjs, invoked once per event as
// `node hooks/codex-lifecycle.mjs <event>` with the hook payload on stdin. Unlike Claude's
// per-run --settings file, Codex has no per-invocation hook flag: this script is wired into
// the GLOBAL ~/.codex/hooks.json by ensureCodexWorkerHooks/mergeCodexWorkerHooks (see
// src/workflow/codex-hooks.js), which additively merges one command entry per event. codexArgv
// in src/workflow/harnesses.js only adds --dangerously-bypass-hook-trust so the interactive
// worker skips the resulting per-invocation trust prompt.
//
// See hooks/claude-lifecycle.mjs and hooks/lib/lifecycle-hook-core.mjs for the full design
// rationale (stateless-subprocess markers, telemetry phase recording, error swallowing). This
// file is a thin harness="codex" wrapper plus the CLI entrypoint that reads the
// event/stdin/env and wires up the real store, lifecycle, and telemetry.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { runLifecycleHook } from "./lib/lifecycle-hook-core.mjs";

// Thin wrapper: the actual behavior lives in the shared core, parameterized harness="codex".
export async function runCodexLifecycleHook(args = {}) {
  return runLifecycleHook({ ...args, harness: "codex" });
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
    const output = await runCodexLifecycleHook({ event, stdinJson, env, store, lifecycle, telemetry });
    if (typeof output === "string" && output.length > 0) {
      process.stdout.write(output);
    }
  } catch {
    // Swallow: a hook must never fail the Codex worker's turn.
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
