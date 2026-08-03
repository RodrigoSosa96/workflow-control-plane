# Time-Budgeted Mutex Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both mutexes' bounded retry actually deliver the guarantee they already claim — that a live collision is absorbed rather than reported to the operator as residue — on machines slower than the developer's.

**No spec, deliberately.** `ROADMAP.md`'s rule for this shape: direct fixes need tests, not prior design. The diagnosis below is verified.

## The verified diagnosis

CI run 2 (`b146e3d`) failed one test: `beginRemediation races claim atomically so only one follow-up child launches` (`test/workflow-delegation-services.test.js:428`). It had **passed** in run 1 (`ok 309`), and this branch's predecessor was test-only — same production code both runs.

**It is not a flaky test. It caught a real defect,** and the test says so itself:

```js
  // The loser is refused by the claim guard (or by the record having already
  // moved past a remediable state once the winner finished) — never by gate or
  // lock contention, which bounded retries absorb.
  assert.match(rejected.reason.message, /already claimed|allowed state/i);
```

In CI the loser's message was `Reservation project gate is active; manual inspection required` — gate contention. The asserted property did not hold. `acquireGate`'s own comment makes the same promise: *"Concurrent holders are millisecond-scale, so a bounded retry absorbs a live collision instead of telling the operator to inspect a gate that is about to clear."*

**Why it breaks on a slower machine.** Both mutexes use the identical budget:

- `delegation-reservations.js`'s `acquireGate`: `maxAttempts = 3`, `sleep(25 + random*75)`
- `run-store.js`'s `acquireLockWithRetry`: `maxAttempts = 3`, `sleep(25 + random*75)`

Three attempts means two sleeps — a total tolerance of roughly **50–200 ms**. If the holder's read-modify-write plus fsync takes longer than that, the retry gives up and reports residue. On a two-core runner with two Node processes contending on the same small file, it does.

**The flaw is the unit.** The guarantee is a *time* property ("absorb a live collision"), but the budget is counted in *attempts*, which is machine-speed-dependent. That is precisely why it passes locally — I measured 15/15 unloaded and 12/12 with 36 CPU-burning workers — and fails on a slower runner.

**It is also the fifth copy of the same logic in this repo**, after the `ps` argv (1.1b, 1.1c), the delegation invariants (1.4), the mutex-removal choreography (1.4), and the lifecycle protocol (1.2).

## Global Constraints

- **The manual-inspection error must survive for genuine residue.** This changes *how long* the system waits before declaring residue, never *whether* it declares it. Crash residue still ends in the same operator-facing error.
- **Preserve the run lock's fresh-vs-stale discrimination.** `acquireLockWithRetry` retries only when `error?.details?.stale === false`; a stale lock must still fail fast into the `workflow unlock` recovery flow. Do not make a stale lock wait out the budget.
- One definition of the retry, used by both mutexes.
- Zero new dependencies. Baseline: **940 tests, 940 pass, 0 skips**, under both `npm test` and `npm run test:ci-like`.

## File Structure

- Create: `src/workflow/bounded-retry.js` — the shared time-budgeted retry.
- Modify: `src/workflow/run-store.js`, `src/workflow/delegation-reservations.js` — consume it.
- Create/Modify: tests for the helper and for both mutexes.
- Modify: `ROADMAP.md`.

---

### Task 1: One time-budgeted retry, shared by both mutexes

**Files:**
- Create: `src/workflow/bounded-retry.js`
- Modify: `src/workflow/run-store.js` (`acquireLockWithRetry`), `src/workflow/delegation-reservations.js` (`acquireGate`)
- Test: a new test file for the helper, plus the existing mutex test files

**Interfaces:** a helper that retries an operation until a **total elapsed time budget** is exhausted, rather than a fixed attempt count:

```js
// Retries `attempt` while `shouldRetry(error)` holds, until `budgetMs` of wall time has
// elapsed since the first try. Sleeps with jitter between tries. Rethrows the last error
// when the budget is spent. `now` and `sleep` are injectable so tests never wait in real time.
export async function retryWithinBudget(attempt, { shouldRetry, budgetMs, now, sleep })
```

Pick the budget with headroom over a slow read-modify-write plus fsync — the current tolerance is ~50–200 ms, which is demonstrably too thin. **Two seconds** is the recommended value: three to four orders of magnitude above a fast local write, still imperceptible to an operator, and it only ever elapses in full when the gate genuinely holds residue, which today already ends in an error. Put the number and its reasoning in one named constant, not scattered.

Both call sites keep their current *semantics* exactly:

- `acquireGate` retries on `EEXIST` and fails with `Reservation project gate is active; manual inspection required` when the budget is spent.
- `acquireLockWithRetry` retries **only** when `error?.details?.stale === false`, and rethrows immediately otherwise.

**Steps:**

- [ ] **Step 1: Write the helper's tests first** — with injected `now`/`sleep` so nothing waits in real time. Cover: succeeds on the first try without sleeping; retries while `shouldRetry` holds and succeeds partway; rethrows the last error once the budget is spent; never retries an error `shouldRetry` rejects; and — the property that matters — **absorbs a holder that takes longer than the old ~200 ms tolerance**.
- [ ] **Step 2: Implement the helper.**
- [ ] **Step 3: Migrate `acquireGate`**, then run `node --test test/workflow-delegation-reservations.test.js`. Its existing tests must pass **untouched**; if one needed changing, stop and report which and why.
- [ ] **Step 4: Migrate `acquireLockWithRetry`**, then run `node --test test/workflow-run-store.test.js`. Same rule. Pay attention to the stale discrimination — there should already be a test pinning that a stale lock is not retried; confirm it still passes and say so.
- [ ] **Step 5: Prove the fix against the failure that motivated it.** Add a test in which the gate's holder is slow enough that the **old** budget would have given up, and assert `reserve()` still succeeds. Inject `sleep`/timing rather than really waiting. Then verify it is load-bearing: temporarily restore the 3-attempt budget, confirm the new test fails, restore.
- [ ] **Step 6: Prove there is one definition** — `grep -rn "maxAttempts" src/` should show no attempt-count retry budget left in either mutex. Paste the output into the commit message.
- [ ] **Step 7: Run `npm test` and `npm run test:ci-like`.** Both green, zero skips.
- [ ] **Step 8: Commit.**

```bash
git commit -m "fix: mutex retries budget wall time, not attempts, so a live collision is absorbed on slow hosts"
```

---

### Task 2: Record it

**Files:**
- Modify: `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Add a progress-log entry**, Spanish, matching the voice. State: CI run 2 failed one test that had passed in run 1 on identical production code; that it was **not** flakiness but a real defect the test's own assertion named ("never by gate or lock contention, which bounded retries absorb"); that both mutexes budgeted retries in attempts while the guarantee they promise is about time, making it machine-speed-dependent; that the fix is one shared time-budgeted retry; and that the manual-inspection error is unchanged for genuine residue.
- [ ] **Step 2: Note that this closes the contention concern item 1.2 recorded** — that entry says a lost marker write under lock contention can silently skip a generation increment. A wider retry budget reduces that exposure without eliminating it; say exactly that, do not claim it is closed.
- [ ] **Step 3: Run `npm test`**, then commit.

---

## Verification

- Both mutexes retry on a wall-time budget with one shared definition.
- A holder slower than the old tolerance is absorbed, proven by a test shown to fail against the old budget.
- Genuine residue still reaches the manual-inspection error; a stale run lock still fails fast.
- Existing mutex tests pass untouched.
- `npm test` and `npm run test:ci-like` both green at zero skips.

The real verification is CI: push and confirm the run is green. That is the thing this branch exists for and it cannot be checked locally.
