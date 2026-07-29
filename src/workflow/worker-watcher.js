import { readEvents } from "./events-bus.js";

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "blocked", "needs_input", "manual_handoff_required", "interrupted"]);

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

export function createWorkerWatcher({
  stateRoot,
  originSessionId,
  onEvent,
  intervalMs = 5_000,
  clock,
  fs,
  initialByte = 0,
} = {}) {
  if (!stateRoot || typeof stateRoot !== "string") fail("stateRoot must be a non-empty string");
  const deliverEvent = ensureFunction(onEvent, "onEvent");
  const scheduler = ensureClock(clock);
  if (!Number.isInteger(intervalMs) || intervalMs < 1) fail("intervalMs must be a positive integer");
  if (!Number.isInteger(initialByte) || initialByte < 0) fail("initialByte must be a non-negative integer");

  let running = false;
  let timer = null;
  let inFlight = null;
  let nextByte = initialByte;
  const seenRunIds = new Set();
  const sessionId = originSessionId ?? null;

  function schedule() {
    if (!running || timer) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      Promise.resolve(poll()).finally(() => {
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
      // Avoid duplicate notifications for the same run.
      if (seenRunIds.has(event.runId)) continue;
      seenRunIds.add(event.runId);
      await deliverEvent(eventPayload(event));
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
