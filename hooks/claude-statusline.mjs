#!/usr/bin/env node
// Claude analog of .pi/extensions/workflow-worker-observability.ts: renders the
// workflow observability widget as Claude Code's statusLine instead of Pi's UI
// widget. Claude's statusLine hook is invoked once per render with a JSON payload
// on stdin (session_id, model, cwd, ...) and must print a single line to stdout.
//
// Reuses the observability extension's measurement handling: usage measurements
// are `{ availability, value }` objects, so `.value` must be read explicitly —
// printing the object itself yields "[object Object]". This module never throws:
// any bad/missing input degrades to a minimal safe line so the statusLine hook
// never breaks the Claude worker's UI.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStore } from "../src/workflow/run-store.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { publicTelemetrySnapshot } from "../src/workflow/telemetry.js";

function shortId(runId) {
  return typeof runId === "string" && runId.length > 0 ? runId.slice(0, 8) : "unknown";
}

// Mirrors buildObservabilityLines' `reported` helper: a measurement is only
// surfaced when it was actually reported and its `.value` is a number.
function reportedValue(measurement) {
  return measurement && measurement.availability === "reported" && typeof measurement.value === "number"
    ? measurement.value
    : undefined;
}

function buildObservabilitySegment(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const parts = [];
  if (snapshot.usage && typeof snapshot.usage === "object") {
    const inputTokens = reportedValue(snapshot.usage.input);
    const outputTokens = reportedValue(snapshot.usage.output);
    const cost = reportedValue(snapshot.usage.cost);
    const tokenParts = [];
    if (inputTokens !== undefined) tokenParts.push(`in=${inputTokens}`);
    if (outputTokens !== undefined) tokenParts.push(`out=${outputTokens}`);
    if (tokenParts.length) parts.push(`tokens ${tokenParts.join(" ")}`);
    if (cost !== undefined) parts.push(`cost $${cost}`);
  }
  if (snapshot.tools && typeof snapshot.tools === "object" && snapshot.tools.lastName) {
    parts.push(`tool ${snapshot.tools.lastName}`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

// Pure, testable core: builds the single-line statusLine string. Wrapped so any
// unexpected shape (bad env, bad stdinJson, bad snapshot) never throws — worst
// case it returns a minimal "Workflow <id>" line.
export function renderClaudeStatusLine({ env, stdinJson, snapshot } = {}) {
  try {
    const safeEnv = env && typeof env === "object" ? env : {};
    const runId = typeof safeEnv.WORKFLOW_RUN_ID === "string" ? safeEnv.WORKFLOW_RUN_ID : undefined;
    const id = shortId(runId);

    // The model comes from the statusLine stdin payload, not the telemetry snapshot, so it is
    // resolved before the thin-snapshot early return — a valid model must surface even when the
    // snapshot has not been written yet (worst case: "Workflow <id> | starting | <model>").
    const safeStdin = stdinJson && typeof stdinJson === "object" ? stdinJson : {};
    const model = safeStdin.model && typeof safeStdin.model === "object"
      ? safeStdin.model.display_name ?? safeStdin.model.id
      : undefined;
    const modelSegment = typeof model === "string" && model ? model : undefined;

    if (!snapshot || typeof snapshot !== "object") {
      const segments = [`Workflow ${id}`, "starting"];
      if (modelSegment) segments.push(modelSegment);
      return segments.join(" | ");
    }

    const phase = typeof snapshot.phase === "string" && snapshot.phase ? snapshot.phase : "starting";
    const harness = typeof safeEnv.WORKFLOW_HARNESS === "string" && safeEnv.WORKFLOW_HARNESS
      ? safeEnv.WORKFLOW_HARNESS
      : "claude";

    const segments = [`Workflow ${id}`, phase, harness];
    if (modelSegment) segments.push(modelSegment);

    const observability = buildObservabilitySegment(snapshot);
    if (observability) segments.push(observability);

    return segments.join(" | ");
  } catch {
    return "Workflow unknown | starting";
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

async function loadSnapshot({ env, store }) {
  const runId = env.WORKFLOW_RUN_ID;
  if (!runId) return null;
  try {
    const telemetry = createTelemetryStore({ store });
    const snapshots = await telemetry.read({ runId });
    const raw = snapshots[0] ?? null;
    return raw ? publicTelemetrySnapshot(raw) : null;
  } catch {
    return null;
  }
}

async function main() {
  let line = "Workflow unknown | starting";
  try {
    const env = process.env;
    const stdinJson = await readStdinJson();
    const store = createRunStore({ stateRoot: env.WORKFLOW_STATE_ROOT });
    const snapshot = await loadSnapshot({ env, store });
    line = renderClaudeStatusLine({ env, stdinJson, snapshot });
  } catch {
    // Swallow: the statusLine hook must always print something and exit 0.
  }
  process.stdout.write(`${line}\n`);
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
