import assert from "node:assert/strict";
import { test } from "node:test";
import { MUTEX_RETRY_BUDGET_MS, retryWithinBudget } from "../src/workflow/bounded-retry.js";

// A fake wall clock driven entirely by the injected `sleep`: `now()` starts at 0 and only
// advances when `sleep(ms)` is awaited, exactly like retryWithinBudget's own contract expects.
// No test in this file waits in real time.
function fakeTimers(start = 0) {
  let value = start;
  const sleeps = [];
  return {
    now: () => value,
    sleep: async (ms) => {
      sleeps.push(ms);
      value += ms;
    },
    sleeps,
  };
}

function eexist(message = "still held") {
  return Object.assign(new Error(message), { code: "EEXIST" });
}

test("MUTEX_RETRY_BUDGET_MS is the two-second budget recommended for absorbing a live mkdir collision", () => {
  assert.equal(MUTEX_RETRY_BUDGET_MS, 2000);
});

test("retryWithinBudget returns the attempt's result on the first try without sleeping", async () => {
  const { now, sleep, sleeps } = fakeTimers();
  let calls = 0;

  const result = await retryWithinBudget(
    async () => {
      calls += 1;
      return "ok";
    },
    { shouldRetry: () => true, budgetMs: MUTEX_RETRY_BUDGET_MS, now, sleep },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.equal(sleeps.length, 0);
});

test("retryWithinBudget retries while shouldRetry holds and returns once the attempt succeeds partway", async () => {
  const { now, sleep, sleeps } = fakeTimers();
  let calls = 0;

  const result = await retryWithinBudget(
    async () => {
      calls += 1;
      if (calls < 3) throw eexist(`held on attempt ${calls}`);
      return "recovered";
    },
    { shouldRetry: (error) => error.code === "EEXIST", budgetMs: MUTEX_RETRY_BUDGET_MS, now, sleep },
  );

  assert.equal(result, "recovered");
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) {
    assert.ok(ms >= 25 && ms < 100, `backoff must be jittered 25-100ms, got ${ms}`);
  }
});

test("retryWithinBudget rethrows the last error once the time budget is spent", async () => {
  const { now, sleep, sleeps } = fakeTimers();
  const errors = [];
  let calls = 0;

  await assert.rejects(
    () => retryWithinBudget(
      async () => {
        calls += 1;
        const error = eexist(`held on attempt ${calls}`);
        errors.push(error);
        throw error;
      },
      { shouldRetry: (error) => error.code === "EEXIST", budgetMs: 10, now, sleep },
    ),
    (error) => error === errors.at(-1),
  );

  // budgetMs: 10 is spent by a single jittered sleep (>= 25ms), so the loop gets exactly one
  // retry (two attempts total) before giving up.
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1);
});

test("retryWithinBudget never retries an error shouldRetry rejects, and never sleeps", async () => {
  const { now, sleep, sleeps } = fakeTimers();
  const fatal = new Error("not retryable");
  let calls = 0;

  await assert.rejects(
    () => retryWithinBudget(
      async () => {
        calls += 1;
        throw fatal;
      },
      { shouldRetry: () => false, budgetMs: MUTEX_RETRY_BUDGET_MS, now, sleep },
    ),
    (error) => error === fatal,
  );

  assert.equal(calls, 1);
  assert.equal(sleeps.length, 0);
});

// The property that matters: the old budget was ~3 attempts / ~50-200ms of jitter, machine-speed
// dependent. This pins that a holder which only clears after longer than that old tolerance is
// still absorbed, because the new budget is wall time, not attempt count.
test("retryWithinBudget absorbs a holder that clears only after longer than the old ~200ms tolerance", async () => {
  const { now, sleep, sleeps } = fakeTimers();
  let calls = 0;

  const result = await retryWithinBudget(
    async () => {
      calls += 1;
      if (now() < 300) throw eexist("still held");
      return "acquired";
    },
    { shouldRetry: (error) => error.code === "EEXIST", budgetMs: MUTEX_RETRY_BUDGET_MS, now, sleep },
  );

  assert.equal(result, "acquired");
  assert.ok(calls > 1, "expected at least one retry before the holder cleared");
  const totalSleptMs = sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(totalSleptMs > 200, `expected the absorbed collision to span more than the old ~200ms tolerance, got ${totalSleptMs}ms`);
  assert.ok(totalSleptMs < MUTEX_RETRY_BUDGET_MS, "expected the fix to still land comfortably within the 2s budget");
});
