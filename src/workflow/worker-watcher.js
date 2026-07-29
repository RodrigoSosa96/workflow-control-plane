import { readEvents } from "./events-bus.js";

// Run states use hyphenated names (see run-state.js RUN_STATES).
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "blocked", "needs-input", "manual-handoff-required", "interrupted"]);

function fail(message) {
  throw new TypeError(message);
}

function ensureFunction(value, name) {
  if (typeof value !== "function") fail(`${name} must be a function`);
  return value;
}

function ensureClock(clock) {
  const effective = clock ?? globalThis;
  if (typeof effective.setTimeout !== "function" || typeof effective.clearTimeout !== "function") {
    fail("clock must provide setTimeout() and clearTimeout()");
  }
  return effective;
}

function isTerminalEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.type === "handoff") return true;
  if (event.type === "run") return TERMINAL_RUN_STATES.has(event.runState);
  if (event.type === "stop") {
    return event.action !== "continue" && event.action !== "none";
  }
  return false;
}

function eventPayload(event) {
  return {
    type: event.type,
    at: event.at,
    runId: event.runId,
    generation: event.generation ?? null,
    originSessionId: event.originSessionId ?? null,
    harness: event.harness ?? null,
    runState: event.runState ?? null,
    runStatus: event.runStatus ?? null,
    resultStatus: event.resultStatus ?? null,
    resultSummary: event.resultSummary ?? null,
    resultPath: event.resultPath ?? null,
    action: event.action ?? null,
  };
}

// One notification per run generation: a resumed run that reaches a second
// terminal state in a later generation notifies again, while a handoff and a
// lifecycle event for the same completion collapse into one notification.
// Events written before generations were stamped share a single legacy key.
function dedupeKey(event) {
  return `${event.runId}:${event.generation ?? "legacy"}`;
}

export function createWorkerWatcher({
  stateRoot,
  originSessionId,
  onEvent,
  onError = () => {},
  intervalMs = 5_000,
  clock,
  fs,
  initialByte = 0,
} = {}) {
  if (!stateRoot || typeof stateRoot !== "string") fail("stateRoot must be a non-empty string");
  const deliverEvent = ensureFunction(onEvent, "onEvent");
  const reportError = ensureFunction(onError, "onError");
  const scheduler = ensureClock(clock);
  if (!Number.isInteger(intervalMs) || intervalMs < 1) fail("intervalMs must be a positive integer");
  if (!Number.isInteger(initialByte) || initialByte < 0) fail("initialByte must be a non-negative integer");

  let running = false;
  let timer = null;
  let inFlight = null;
  let nextByte = initialByte;
  const seenKeys = new Set();
  const sessionId = originSessionId ?? null;

  function noteError(error) {
    try {
      reportError(error);
    } catch {
      // Error reporting is best-effort; it must never break the watcher.
    }
  }

  function schedule() {
    if (!running || timer) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      // A poll failure must not become an unhandled rejection (it would tear
      // down the extension host) and must not stop the polling loop.
      Promise.resolve(poll())
        .catch(noteError)
        .finally(() => {
          schedule();
        });
    }, intervalMs);
    if (typeof timer?.unref === "function") timer.unref();
  }

  function stop() {
    running = false;
    if (timer) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }

  function start() {
    if (running) return;
    running = true;
    schedule();
  }

  async function runPoll() {
    const { events, nextByte: newNextByte } = await readEvents({ stateRoot, fromByte: nextByte, fs });
    nextByte = newNextByte;
    for (const event of events) {
      if (!isTerminalEvent(event)) continue;
      // Only surface events for this session when an origin session is known.
      // Events with no origin session are still surfaced but marked as unclaimed.
      if (sessionId && event.originSessionId && event.originSessionId !== sessionId) {
        continue;
      }
      const key = dedupeKey(event);
      if (seenKeys.has(key)) continue;
      try {
        await deliverEvent(eventPayload(event));
        // Mark seen only after a successful delivery so a later terminal event
        // for the same generation still gets a chance if this delivery failed.
        seenKeys.add(key);
      } catch (error) {
        // The cursor already advanced past this batch; a delivery failure is
        // reported and the remaining events still get delivered.
        noteError(error);
      }
    }
  }

  function poll() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await runPoll();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return Object.freeze({
    start,
    stop,
    poll,
    isRunning() {
      return running;
    },
  });
}
