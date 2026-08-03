# Run Record Version and Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `run.json`'s `version` mean something on read, and leave one document that answers what a run record contains and who writes each field — checked by the suite, so it cannot go stale.

**Architecture:** One exported `SUPPORTED_RUN_VERSION` and one assertion on the read path; `read`/`update` refuse an unsupported version, `list` skips it with a warning. Separately, a field inventory in `docs/` that a test verifies against real records.

**Design source:** [`../specs/2026-08-03-run-record-version-and-inventory-design.md`](../specs/2026-08-03-run-record-version-and-inventory-design.md). Read its "The second half is the one that decays" section before Task 2 — an unchecked inventory closes the ticket without closing the problem.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **No migrator.** There is exactly one version and nothing to migrate. Build the check and name where a future migrator goes; do not build scaffolding for it.
- **Preserve the strictness split.** `read()`/`update()` refuse; `list()` skips with a bounded warning through the existing `onListProblem` channel. Item 0.3 established that deliberately so one bad record cannot brick a listing.
- **The version stays unforgeable.** `initialRun` and `updatedRun` already strip a caller-supplied `version` (`src/workflow/run-store.js:788`, `:817`); that must remain true.
- **Check after parse, before shape validation.** A record from the future should be refused on its version, not on whatever shape mismatch its new fields happen to trigger — the second message sends an operator chasing the wrong thing.
- Existing run-store tests pass untouched; if one needs changing, stop and report which and why.
- Zero new dependencies. Baseline: **947 tests, 947 pass, 0 skips**, under both `npm test` and `npm run test:ci-like`.

## Reference: what the code does today

- `initialRun` (`src/workflow/run-store.js:801`) stamps `version: 1`; both it and `updatedRun` strip an incoming `version`.
- `readRunInternal` (`:~880`) reads the file and calls `parseRunJson`, which validates shape and never consults the version.
- `list()` skips entries it cannot read, reporting through `onListProblem` (item 0.3).
- The precedent named by the roadmap is `registry.js:565-568`: explicit per-version dispatch, refusing by name and saying what it received.
- Verified: all 8 records in the real state root carry `version: 1`.

## File Structure

- Modify: `src/workflow/run-store.js` — the constant, the assertion, the wiring.
- Modify: `test/workflow-run-store.test.js`.
- Create: `docs/run-record-fields.md` — the inventory.
- Create: `test/workflow-run-record-inventory.test.js` — the check that keeps it honest.
- Modify: `ROADMAP.md`.

---

### Task 1: The version check

**Files:**
- Modify: `src/workflow/run-store.js`
- Test: `test/workflow-run-store.test.js`

**Interfaces:**

```js
// One exported constant, so a future bump has exactly one place to change and callers can
// assert against it rather than a literal.
export const SUPPORTED_RUN_VERSION = 1;
```

The assertion runs inside the read path after `JSON.parse` succeeds and before shape validation. Its message must name **both** the version found and the version supported, and say what to do — the same courtesy `registry.js:568` extends (`Registry must use version 2 or 3 (received ...)`).

Where a future migrator goes belongs in a comment at the assertion, in one sentence: when a version 2 exists, this is the dispatch point, mirroring `registry.js:565-568`. Do not build the dispatch now.

**Steps:**

- [ ] **Step 1: Write the failing tests** — `read()` accepts version 1; refuses version 2 with a message naming both versions; refuses an absent version, a non-integer version, and version 0. `update()` refuses the same, so a future record cannot be mutated by an older control plane. Build the fixtures by writing `run.json` directly to a temp state root, since the store will not produce a bad version for you.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement** the constant and the assertion.
- [ ] **Step 4: Add the `list()` test** — a state root with one future-version record and two good ones returns the two, reports the skip through `onListProblem`, and does not throw. This is the property that keeps item 2.1's cross-project board usable.
- [ ] **Step 5: Confirm the version is still unforgeable** — `create()` with `version: 99` in the input still produces `version: 1`, and `update()` with `version: 99` in the patch leaves it at 1. There may already be a test for this; if so, confirm it passes untouched and say so rather than duplicating it.
- [ ] **Step 6: Run `node --test test/workflow-run-store.test.js`, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "fix: refuse a run record whose version this control plane does not support"
```

---

### Task 2: The inventory, and the check that keeps it honest

**Files:**
- Create: `docs/run-record-fields.md`
- Create: `test/workflow-run-record-inventory.test.js`

**Interfaces:** a document listing every field a run record carries — field name, the module that writes it, when it appears, what it means — and a test that fails when a field exists in a real record but not in the document.

**This is the half that decays if you only write prose.** A real record carries 45 keys today; this session alone added three (`agentProfile` from item 1.3, `piStartedOnce` and `piPendingContinuation` from item 1.2), each from a different module and none written down. The check is what converts "document your field" from something a reviewer must remember into something the suite asks for.

**Be honest about the check's reach.** It cannot see a field written only on a lane the test does not exercise. So: build a record through the store's own operations plus whatever representative lanes you can drive cheaply, assert every key it carries is documented, and have the document mark fields it lists that the test cannot produce with their writer. Say plainly in both the doc and the test what the check does and does not cover — an overstated guarantee is worse than a modest one.

Derive the field list from the code, not from a single sample record: read `runInput` (`src/workflow/launch.js`), `initialRun` (`src/workflow/run-store.js`), the lifecycle hook core's markers, `resume.js`, the telemetry store and the delegation store. A field you cannot attribute to a writer is itself a finding — report it rather than inventing an explanation.

**Steps:**

- [ ] **Step 1: Derive the inventory from the writers**, not from one record. List each field with its writer.
- [ ] **Step 2: Write `docs/run-record-fields.md`.** Group by writer. State the check's reach and its limits at the top.
- [ ] **Step 3: Write the test** — build a record through real operations, assert every key is documented.
- [ ] **Step 4: Prove it is load-bearing** — add an undocumented field to a record the test builds, confirm the test fails, remove it. Record the failing output.
- [ ] **Step 5: Report any field you could not attribute** to a writer.
- [ ] **Step 6: Run the file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "docs: one checked inventory of run record fields and their writers"
```

---

### Task 3: Close out Fase 1

**Files:**
- Modify: `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Mark 1.5 done** with its commit range, and note that **Fase 1 is complete** — this is its last item.
- [ ] **Step 2: Add a progress-table row** — date, item, range, suite count, and what changed: the version is checked on read with the strictness split preserved, and the field inventory is checked by the suite rather than written once.
- [ ] **Step 3: Record the deliberate omissions** — no migrator until there is something to migrate (and where it goes), and the event records' own `version: 1` has the same latent issue and is the natural follow-up.
- [ ] **Step 4: Repoint the next step to Fase 2**, whose first item is 2.1 (`workflow runs`) and which the roadmap argues is where the ecosystem is weakest. Note that 2.1 depends on 0.3, which is done.
- [ ] **Step 5: Run `npm test`**, then commit.

---

## Verification

The spec's ten Verification Strategy items map to these tasks: 1-4, 6 → Task 1; 5 → Task 1 step 4; 7-8 → Task 2; 9-10 → every task.

After Task 3, review the branch, merge, push, and confirm CI is green.
