# Cotas de spawn y fail-closed: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two invariants this repository already claims actually hold — every spawn is bounded
by a real wall clock, and every unknown refuses — by closing eight recorded pendientes.

**Design source:** [`../specs/2026-08-09-bounded-spawns-design.md`](../specs/2026-08-09-bounded-spawns-design.md).
Read its B1 section before Task 1: the fix is one `verify-runner.js` already validated, **and it is
the fix that broke Ctrl-C when 2.3 shipped it**.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **`shell: false` everywhere.** `src/workflow/verify-runner.js` stays the repo's single documented
  shell departure; this batch adds nothing to it and does not modify it.
- **Zero new dependencies.**
- **`process.js`'s public contract does not change**: the `WorkflowError` shape (`reason: "timeout"`,
  the same `exitCode`), the 12,000-character output cap, and `allowFailure`'s behaviour all stay.
  This is a bounding correction, not a runner redesign.
- **Fail closed on unknown**, everywhere this batch touches.
- **Measure, do not compute.** B1 and B8 are both measurement tasks; a number that is not measured
  does not go in.
- Baseline: **1335 tests, 1335 pass, 0 skips** under `npm run test:ci-like`. Plain `npm test` fails 7
  unrelated tests on this machine (the shell exports `WORKFLOW_PROJECTS_FILE`); use `test:ci-like`,
  or prefix focused runs with a bare `WORKFLOW_PROJECTS_FILE= `.

## Reference: verified facts

Checked against the code today, not inherited from the pendientes list:

- `src/workflow/process.js:138-141` — the timeout is `child.kill("SIGTERM")` on the direct child;
  there is no `detached`, no process-group signal, and no SIGKILL escalation. The promise settles on
  `close` (`:98`).
- Measured (2.5 task-1 review): `sh -c 'sleep 30'` with `timeoutMs: 500` rejects at **30,002 ms**
  with the message still reading `timed out after 500ms`; a backgrounding script **resolves** at 30 s.
- `src/workflow/verify-runner.js` already implements the target shape — `detached: true`,
  `killChild` signalling `-child.pid`, SIGKILL escalation after a grace window, and
  `installInterruptTrap` per spawned child. **Read it; it also documents why each piece exists.**
- `inspectRepositoryForMerge` (`commands.js:2033`) calls `git.checkoutState({ cwd: basePath })` with
  **no** `timeoutMs`, and uses `baseState.merging` — not `pendingOperation`, which
  `inspectRepositoryForArchive` (`commands.js:2841`) does use (`:2930`).
- `git.pendingOperation` exists at `git.js:746` and covers `rebase-merge`, `rebase-apply`,
  `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, each with its own remedy.
- `commands.js:2519` — `nothingIntegrated` is `merged.length > 0 && merged.every((entry) => entry.integrated === false)`.
- `herdr.js:629` — `closeTab({ tabId, timeoutMs = TAB_CLOSE_TIMEOUT_MS } = {})`: a **default
  parameter**, so only `undefined` falls back; `null`/`0`/`NaN`/`-5`/`"10000"` pass through and are
  then dropped by `run()`'s finite check.
- `herdr.js:618-628` already documents `process.js`'s weak bound as a known limitation — B1 is what
  makes that comment upgradeable.

## File Structure

- Modify: `src/workflow/process.js` (B1), `src/workflow/git.js` (B3), `src/workflow/herdr.js` (B4),
  `src/workflow/commands.js` (B2, B3, B5, B6, B7), `src/workflow/format.js` + `README.md` (B8).
- Modify the corresponding test files.
- Modify: `ROADMAP.md`.

---

### Task 1: B1 — `process.js`'s timeout bounds the wall clock

**Files:** `src/workflow/process.js`; test `test/workflow-process.test.js`

This is the whole risk of the batch. Everything else is small.

**Steps:**

- [ ] **Step 1: Reproduce the defect first, and record the numbers.** With the *current* code, run
      `sh -c 'sleep 30'` and a script that backgrounds a child and exits, both with `timeoutMs: 500`.
      Record the real elapsed times. You are about to change behaviour; measure what it is now.
- [ ] **Step 2: Write the failing tests.** The bound (both shapes reject near the deadline, not at
      30 s); no orphan survives (check with `ps`); a command that *ignores* SIGTERM is still bounded
      by `timeoutMs + killGraceMs`; **Ctrl-C**: an interrupt delivered to this process kills the
      child's group before exiting; the trap is not registered when no child is alive and does not
      accumulate across sequential or concurrent spawns; and the unchanged contract — `reason:
      "timeout"`, the same `exitCode`, the output cap, `allowFailure`.
- [ ] **Step 3: Run and verify they fail.**
- [ ] **Step 4: Implement**, following `verify-runner.js`'s shape. Two deliberate differences to get
      right and to comment: this runner settles without waiting for every pipe to close (that is the
      defect), and it is the **shared** runner, so the interrupt trap must be per-child with
      guaranteed teardown.
- [ ] **Step 5: Re-measure both shapes** and put the before/after numbers in the report. Confirm with
      `ps` that nothing survives.
- [ ] **Step 6: Negative control** — remove the group signal (keep `child.kill`), confirm the bound
      tests fail and only those; restore. Then remove the interrupt trap and confirm the Ctrl-C test
      fails. Record both.
- [ ] **Step 7:** Run `test/workflow-process.test.js`, then `npm run test:ci-like`. **The whole suite
      matters here**: this runner is used by every git and Herdr call in the repo.
- [ ] **Step 8: Commit.**

```bash
git commit -m "fix: the shared runner's timeout bounds the wall clock instead of only signalling"
```

---

### Task 2: B2, B3, B4 — the missing bounds

**Files:** `src/workflow/git.js`, `src/workflow/herdr.js`, `src/workflow/commands.js`; corresponding tests

- **B3:** add `timeoutMs` to `checkoutState` and `resolveHead` in the adapter and pass it through to
  `runner.run`; supply it from `inspectRepositoryForMerge` and `inspectRepositoryForArchive`.
- **B2:** supply it to the post-merge `resolveHead` read-back in the merge execution path.
- **B4:** in `closeTab`, an explicitly-passed unusable `timeoutMs` falls back to
  `TAB_CLOSE_TIMEOUT_MS` instead of disabling the bound. Do not change the other Herdr methods.

**Steps:**

- [ ] **Step 1: Write the failing tests** — assert `timeoutMs` reaches the recorded `runner.run` call
      in each of the four sites; and `closeTab` with `null`/`0`/`NaN`/`-5`/`"10000"` uses the default
      while a usable value is still honoured.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Focused files, then `npm run test:ci-like`.
- [ ] **Step 5: Commit.**

```bash
git commit -m "fix: bound the git and Herdr reads that were still unbounded"
```

---

### Task 3: B5, B6, B7 — the three remaining fail-opens

**Files:** `src/workflow/commands.js`; test `test/workflow-merge.test.js`

- **B5:** wrap `git.mergeArgv` in `inspectRepositoryForMerge` so a throwing adapter becomes a refusal.
- **B6:** `nothingIntegrated` must additionally require that no entry has `integrated === null`.
- **B7:** merge uses `git.pendingOperation` in place of `checkoutState`'s `merging`, refusing with
  that operation's own remedy — the same treatment archive already has.

**Steps:**

- [ ] **Step 1: Write the failing tests.** B6 first — a `null` read mixed with a genuine no-op must
      not report `merged`. Then B7 against **real git**: a base checkout stopped mid-rebase, and one
      mid-cherry-pick, each refusing with its own remedy named. Then B5's throwing adapter.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.** For B7, reuse archive's wiring rather than writing a second one; if the
      shape is genuinely shared, extract it — but do not refactor archive's behaviour.
- [ ] **Step 4: Negative control on B6** — restore `every(... === false)`, confirm only that test
      fails, restore. Record it.
- [ ] **Step 5:** Focused files, then `npm run test:ci-like`.
- [ ] **Step 6: Commit.**

```bash
git commit -m "fix: a failed read, a throwing adapter and an in-progress git operation all refuse in merge"
```

---

### Task 4: B8 and the close-out

**Files:** `src/workflow/format.js`, `README.md`, `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Re-measure** archive's overflow tier boundaries and byte counts against the fixture
      the table names, after C1/I1's added fields. Correct the table, the `README.md` "about sixteen
      repositories" figure, and any test that pins a boundary. Every number must come from a run you
      did.
- [ ] **Step 2: Update `ROADMAP.md`'s "Pendientes conocidos"** — strike the eight entries this batch
      closes, each pointing at what closed it. Do **not** silently delete them; this document's
      convention is to record what happened.
- [ ] **Step 3: Add a short narrative entry** for the batch: the measured before/after for B1, the
      Ctrl-C trap and why it was needed (2.3's regression), and that merge never received 2.5's
      in-progress detection until now.
- [ ] **Step 4: Add a progress-table row.**
- [ ] **Step 5:** Run `npm run test:ci-like`, then commit.

---

## Verification

The spec's nine Verification Strategy items map to these tasks: 1-3 → Task 1; 4 → Task 2; 5-7 →
Task 3; 8 → Task 4; 9 → every task.

After Task 4: review the branch adversarially, **and re-review after fixing, not only before** —
item 2.3's timeout fix opened the next hole, item 2.4's README fix introduced a fresh false claim
twice, and item 2.5's Critical fix shipped un-wired on two paths. This task touches the same
timeout machinery that produced the first of those. Then merge, push, and confirm CI is green.
