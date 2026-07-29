import { appendFile as defaultAppendFile } from "node:fs/promises";
import { join } from "node:path";

// Every lifecycle hook, extension handler, telemetry recorder, and notifier
// swallows its errors on purpose: a bookkeeping failure must never break the
// worker it is attached to. The cost was that a harness upgrade changing hook
// payloads degraded invisibly — generations stopped advancing, runs stuck in
// RUNNING, statuslines frozen — with nothing anywhere recording why.
//
// This is the diagnostic channel for those catch blocks: a bounded, append-only
// log inside the run directory (never stdout/stderr, which the harness parses).
// It is itself best-effort — a logging failure is swallowed too.
const LOG_FILE = "hooks-debug.log";
const MAX_MESSAGE_LENGTH = 512;
// Roughly a few hundred entries; enough to see a pattern, small enough that a
// stuck hook firing every turn cannot fill a disk.
const MAX_LOG_BYTES = 256 * 1024;

function boundedMessage(value) {
  const text = value instanceof Error
    ? `${value.name}: ${value.message}`
    : String(value ?? "unknown");
  return text.replace(/[\r\n]+/g, " ").slice(0, MAX_MESSAGE_LENGTH);
}

export function hookDebugLogPath(runDirectory) {
  return join(runDirectory, LOG_FILE);
}

export async function recordHookDebug({
  runDirectory,
  harness,
  event,
  scope,
  error,
  at = new Date().toISOString(),
  appendFile = defaultAppendFile,
  stat = null,
} = {}) {
  if (typeof runDirectory !== "string" || !runDirectory) return false;
  try {
    const path = hookDebugLogPath(runDirectory);
    if (typeof stat === "function") {
      try {
        const stats = await stat(path);
        if (stats?.size >= MAX_LOG_BYTES) return false;
      } catch {
        // Missing file: nothing to bound yet.
      }
    }
    const line = JSON.stringify({
      at,
      harness: harness ?? null,
      event: event ?? null,
      scope: scope ?? null,
      error: boundedMessage(error),
    });
    await appendFile(path, `${line}\n`, { mode: 0o600 });
    return true;
  } catch {
    // The diagnostic channel must never become a failure mode of its own.
    return false;
  }
}
