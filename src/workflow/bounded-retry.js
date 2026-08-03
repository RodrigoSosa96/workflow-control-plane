// One time-budgeted retry, shared by both mkdir-based mutexes in this repo: the run lock
// (run-store.js's acquireLockWithRetry) and the delegation reservation gate
// (delegation-reservations.js's acquireGate). Both hold a mutex only for a single
// read-modify-write, so a genuinely live collision between two processes is millisecond-scale
// and should be absorbed rather than reported to the operator as crash residue.
//
// The budget used to be counted in attempts (three tries, ~50-200ms of jitter total). That unit
// is machine-speed-dependent: on a slower host or a loaded CI runner, the same three attempts
// cover less and less wall time until they no longer even span a live collision, and a contender
// that would have succeeded on a fast machine instead reports the mutex as wedged. Measured
// locally: 15/15 passes unloaded, 12/12 with 36 CPU-burning workers, and it still failed on a
// two-core CI runner. Budgeting wall time instead makes the guarantee machine-speed-independent.
//
// MUTEX_RETRY_BUDGET_MS is three to four orders of magnitude above a fast local mkdir + fsync,
// and still imperceptible to an operator -- it is only ever spent in full when the gate genuinely
// holds residue, which already ends in the manual-inspection error today. Keeping the number here
// as one named constant (rather than scattered across both call sites) is what lets both mutexes
// share one definition of "how long is a live collision allowed to take".
export const MUTEX_RETRY_BUDGET_MS = 2000;

const JITTER_BASE_MS = 25;
const JITTER_SPREAD_MS = 75;

function jitteredBackoffMs() {
  return JITTER_BASE_MS + Math.floor(Math.random() * JITTER_SPREAD_MS);
}

// Retries `attempt` while `shouldRetry(error)` holds, until `budgetMs` of wall time has
// elapsed since the first try. Sleeps with jitter between tries. Rethrows the last error
// when the budget is spent. `now` and `sleep` are injectable so tests never wait in real time.
export async function retryWithinBudget(attempt, { shouldRetry, budgetMs, now, sleep }) {
  const startedAt = now();
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      if (now() - startedAt >= budgetMs) throw error;
      await sleep(jitteredBackoffMs());
    }
  }
}
