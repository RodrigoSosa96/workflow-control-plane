const TERMINAL_STATES = new Set(["completed", "blocked", "failed"]);
const noticeCache = new WeakMap();

function fail(message) {
  throw new TypeError(message);
}

function ensureDelegations(delegations) {
  if (!delegations || typeof delegations.list !== "function" || typeof delegations.consumeResult !== "function") {
    fail("delegations must provide list() and consumeResult()");
  }
  return delegations;
}

function ensureString(value, name) {
  if (typeof value !== "string" || !value) fail(`${name} must be a non-empty string`);
  return value;
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

function resultPayload(record) {
  return {
    runId: record.parentRunId,
    delegationId: record.id,
    role: record.role,
    generation: record.generation,
    state: record.state,
    summary: record.result.summary,
    verification: structuredClone(record.result.verification ?? []),
    concerns: structuredClone(record.result.concerns ?? []),
    nextAction: record.result.nextAction,
  };
}

function noticePayload(record, reason) {
  return {
    runId: record.parentRunId,
    delegationId: record.id,
    role: record.role,
    generation: record.generation,
    state: record.state,
    reason,
  };
}

function currentTerminalResult(record, originSessionId) {
  if (!record || typeof record !== "object") return false;
  if (record.originSessionId !== originSessionId) return false;
  if (!TERMINAL_STATES.has(record.state)) return false;
  if (!record.result || !TERMINAL_STATES.has(record.result.status)) return false;
  if (record.result.generation !== record.generation) return false;
  if (record.result.consumedBySessionId || record.result.consumedAt) return false;
  return true;
}

function noticeKey(record, reason) {
  return `${record.parentRunId}:${record.id}:${record.generation}:${reason}`;
}

function shouldNotice(record, originSessionId) {
  if (!record || typeof record !== "object" || record.originSessionId !== originSessionId) return null;
  if (record.startFailure?.reason) return `manual review required: ${record.startFailure.reason}`;
  if (record.result && record.result.generation !== record.generation) return "stale result requires manual review";
  return null;
}

export function createDelegationWatcher({
  delegations,
  originSessionId,
  onResult,
  onNotice = async () => {},
  onError = () => {},
  intervalMs = 5_000,
  clock,
} = {}) {
  const store = ensureDelegations(delegations);
  const sessionId = ensureString(originSessionId, "originSessionId");
  const deliverResult = ensureFunction(onResult, "onResult");
  const deliverNotice = ensureFunction(onNotice, "onNotice");
  const reportError = ensureFunction(onError, "onError");
  const scheduler = ensureClock(clock);
  if (!Number.isInteger(intervalMs) || intervalMs < 1) fail("intervalMs must be a positive integer");

  let running = false;
  let timer = null;
  let inFlight = null;
  const seenNotices = noticeCache.get(store) ?? new Set();
  noticeCache.set(store, seenNotices);

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
    const records = await store.list({ originSessionId: sessionId });
    for (const record of Array.isArray(records) ? records : []) {
      // Per-record containment: one failing record must not block delivery for
      // the rest of the origin session's delegations.
      try {
        if (currentTerminalResult(record, sessionId)) {
          // Deliver before consuming. A failed delivery leaves the record
          // unconsumed so the next poll retries it (at-least-once), instead of
          // permanently consuming a result the origin session never saw.
          await deliverResult(resultPayload(record));
          await store.consumeResult({
            runId: record.parentRunId,
            delegationId: record.id,
            originSessionId: sessionId,
          });
          continue;
        }

        const reason = shouldNotice(record, sessionId);
        if (!reason) continue;
        const key = noticeKey(record, reason);
        if (seenNotices.has(key)) continue;
        seenNotices.add(key);
        await deliverNotice(noticePayload(record, reason));
      } catch (error) {
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
