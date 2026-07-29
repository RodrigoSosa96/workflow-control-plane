import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { appendEvent } from "./events-bus.js";

/**
 * Best-effort, non-blocking notification for workflow run events.
 *
 * The launcher looks for an executable script at:
 *   - $WORKFLOW_HANDOFF_NOTIFIER, if set, otherwise
 *   - $HOME/.config/workflows/handoff-notifier
 *
 * If the script does not exist or is not executable, the script step is a no-op.
 * The script receives the run context as environment variables and runs detached
 * from the worker, so it can never block the handoff or lifecycle hook. Any
 * output or failure from the script is swallowed.
 *
 * In addition, every notification appends a structured event to the workflow
 * event bus ($WORKFLOW_STATE_ROOT/events.jsonl). A coordinator-side watcher can
 * consume these events and surface them to the user without injecting messages
 * automatically into an agent session.
 */

export function resolveNotifierPath(env = process.env) {
  const explicit = env.WORKFLOW_HANDOFF_NOTIFIER;
  if (explicit) {
    if (typeof explicit !== "string" || explicit.length === 0) return null;
    return explicit;
  }
  const home = env.HOME ?? homedir();
  if (!home) return null;
  return `${home}/.config/workflows/handoff-notifier`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function stateRootFromRun(run, env) {
  return run?.stateRoot ?? env?.WORKFLOW_STATE_ROOT ?? null;
}

function baseEvent(run, result, notificationType, action = null) {
  const event = {
    type: notificationType,
    at: new Date().toISOString(),
    runId: run?.id ?? "",
    generation: Number.isSafeInteger(run?.generation) ? run.generation : null,
    originSessionId: run?.originSessionId ?? null,
    harness: run?.harness ?? "",
    runState: run?.state ?? "",
    runStatus: run?.resultStatus ?? "",
    runDir: run?.directory ?? "",
    resultStatus: result?.status ?? run?.resultStatus ?? "",
    resultSummary: result?.summary ?? "",
    resultPath: run?.resultPath ?? "",
  };
  if (isNonEmptyString(action)) {
    event.action = action;
  }
  return event;
}

async function appendBusEvent(stateRoot, event) {
  if (!isNonEmptyString(stateRoot)) return;
  try {
    await appendEvent({ stateRoot, event });
  } catch {
    // The event bus is best-effort; a write failure must not break the handoff.
  }
}

async function runScript({ env, context, run, result, notificationType, action, spawnFn = spawn }) {
  const path = resolveNotifierPath(env);
  if (!path) return { notified: false };
  if (!isAbsolute(path)) return { notified: false, reason: "notifier path must be absolute" };
  try {
    await access(path, constants.X_OK);
  } catch {
    return { notified: false, reason: "notifier not found or not executable" };
  }

  const childEnv = {
    ...process.env,
    WORKFLOW_NOTIFICATION_TYPE: notificationType,
    WORKFLOW_RUN_CONTEXT: context,
    WORKFLOW_RUN_ID: run?.id ?? "",
    WORKFLOW_RUN_STATE: run?.state ?? "",
    WORKFLOW_RUN_STATUS: run?.resultStatus ?? "",
    WORKFLOW_RUN_DIR: run?.directory ?? "",
    WORKFLOW_RESULT_PATH: run?.resultPath ?? "",
    WORKFLOW_RESULT_STATUS: result?.status ?? run?.resultStatus ?? "",
    WORKFLOW_RESULT_SUMMARY: result?.summary ?? "",
    WORKFLOW_HARNESS: run?.harness ?? "",
    ...(isNonEmptyString(action) ? { WORKFLOW_RUN_ACTION: action } : {}),
  };

  const child = spawnFn(path, [], {
    detached: true,
    stdio: "ignore",
    env: childEnv,
  });
  child.unref();
  return { notified: true, path };
}

async function dispatch({ stateRoot, env, context, run, result, notificationType, action, spawnFn }) {
  const event = baseEvent(run, result, notificationType, action);
  await appendBusEvent(stateRoot, event);
  const scriptResult = await runScript({ env, context, run, result, notificationType, action, spawnFn });
  return { event, ...scriptResult };
}

export async function notifyHandoff({ run, result, env = process.env, spawnFn = spawn } = {}) {
  const stateRoot = stateRootFromRun(run, env);
  return dispatch({ stateRoot, env, context: "handoff", run, result, notificationType: "handoff", spawnFn });
}

export async function notifyRun({ store, runId, env = process.env, spawnFn = spawn } = {}) {
  if (!store || typeof store.read !== "function") return { notified: false, reason: "store not available" };
  const run = await store.read(runId);
  if (!run) return { notified: false, reason: "run not found" };
  const stateRoot = stateRootFromRun(run, env);
  return dispatch({ stateRoot, env, context: "lifecycle", run, result: null, notificationType: "run", spawnFn });
}

export async function notifyStop({ run, store, runId, action, env = process.env, spawnFn = spawn } = {}) {
  const current = store && typeof store.read === "function" && isNonEmptyString(runId)
    ? await store.read(runId)
    : run;
  if (!current) return { notified: false, reason: "run not found" };
  const stateRoot = stateRootFromRun(current, env);
  return dispatch({ stateRoot, env, context: "stop", run: current, result: null, notificationType: "stop", action, spawnFn });
}
