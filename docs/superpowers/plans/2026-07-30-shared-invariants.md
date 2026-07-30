# Shared Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of four duplicated invariants exactly one definition, so the layered defense-in-depth the two-lane spec calls for becomes the same predicate evaluated at several points rather than several approximations of it.

**Architecture:** Two new modules split by subject — `src/workflow/delegation-invariants.js` (the delegation lane's authorization rules) and `src/workflow/mutex-removal.js` (the safe-removal algorithm both mutexes share). `ownership.js` keeps meaning "what an owner marker means" and gains nothing.

**Design source:** [`../specs/2026-07-30-shared-invariants-design.md`](../specs/2026-07-30-shared-invariants-design.md) (Approved). Read its "An honest scoping note" section: this item is drift prevention, **not** closing a live hole, and the plan is ordered accordingly.

**Tech Stack:** Node.js ESM, zero runtime dependencies, Node test runner.

## Global Constraints

- **Move, do not redesign.** Except for the two deliberate strengthenings named in tasks 2 and 3, no call site's behavior, error message, or control flow may change. Both stores' and the delegation lane's existing tests are the regression net.
- **Each layer keeps its own error convention.** The store's validators throw `WorkflowError`; the policy gate returns a rejection object. Shared code exposes a predicate and, where needed, an asserting wrapper — it must never force one convention on a caller that needs the other.
- **Deliberate strengthenings need failing-against-old-code tests.** "We consolidated" must not hide "we quietly changed an authorization check".
- If a consolidation turns out to be a bad fit once the code is read, **report that with specifics rather than forcing it**. A wrong shared abstraction is worse than two honest copies.
- Zero new dependencies; existing injection seams stay injectable.
- Every task ends with its covering tests passing and `npm test` green.

## File Structure

- Create: `src/workflow/delegation-invariants.js`, `test/workflow-delegation-invariants.test.js`
- Create: `src/workflow/mutex-removal.js`, `test/workflow-mutex-removal.test.js`
- Modify: `src/workflow/delegation-reservations.js`, `delegation-handoff.js`, `coordinator-policy.js`, `delegation-services.js`, `delegation-store.js`, `pi-delegation-transport.js`, `run-store.js`
- Modify: the covering test files for each, plus `ROADMAP.md` at the end.

---

### Task 1: Reservation resources and match — one definition

**Files:** create `src/workflow/delegation-invariants.js` + `test/workflow-delegation-invariants.test.js`; modify `src/workflow/delegation-reservations.js`, `src/workflow/delegation-handoff.js`.

**Interfaces:**

```js
// The resources a delegation of this role/mode/checkout consumes. The single
// source for both lease creation and every later verification.
export function reservationResourceList({ role, mode, checkoutDigest })

// Does this reservation authorize this delegation record? Compares state,
// delegationId, role, mode, checkoutDigest, and every required resource.
export function reservationMatchesDelegation(record, reservation)

// sha256 hex of a string, as the reservation and marker digests use it.
export function checkoutDigestFor(cwd)
```

`reservationResourceList` returns exactly what `delegation-reservations.js`'s `resourceList` returns today: `["totalInternal"]`, plus `"foreground"` when mode is foreground, plus `"readOnlyBackground"` for a read-only background role, plus `"writersTotal"` and `` `checkout:${checkoutDigest}` `` for a writer.

**Do not** move `resourceList`'s policy validation (the background-writer check) into the shared function — that is a policy decision belonging to lease creation, not to the resource list. `delegation-reservations.js` keeps it and calls the shared list for the resources themselves.

**Steps:**
- [ ] Write tests for all three exports covering every role/mode combination, including that a writer's list contains the checkout resource and a read-only background role's does not.
- [ ] Implement, then migrate `delegation-reservations.js` and `delegation-handoff.js` onto it, deleting their local copies.
- [ ] Confirm both files' existing tests pass **unmodified**.
- [ ] `npm test`, commit.

---

### Task 2: The coordinator policy adopts the strict predicate — a deliberate behavior change

**Files:** modify `src/workflow/coordinator-policy.js`; tests in its covering file (`test/workflow-delegation-services.test.js` exercises `validateSubagentRequestPolicy`; check for a dedicated file first).

**What changes:** `reservationResources` and `reservationAllows` are deleted; the policy gate calls `reservationMatchesDelegation`. It thereby gains two checks it lacks today: the `checkout:<digest>` resource requirement, and the comparison of the reservation's `checkoutDigest` against the delegation's cwd (it currently only checks that *some* `checkout:`-prefixed resource exists). It also gains the `role`/`mode` comparison.

The gate's inputs are a `request`/`prepared` pair, not a delegation record, so build the record-shaped argument from `prepared` — do not weaken the shared predicate to accept a second shape.

**This is the one place the plan deliberately changes an authorization outcome.** It must be visible, not incidental.

**Steps:**
- [ ] Write a test proving a reservation whose `checkoutDigest` belongs to a **different** checkout is now refused. Verify it **fails against the current code** and say so in your report — that failure is the evidence the gate really was weaker.
- [ ] Write a test proving a reservation with a mismatched `role` or `mode` is refused.
- [ ] Confirm every currently-passing policy test still passes, or, where one encoded the weaker behavior, update it and call that out explicitly in your report.
- [ ] Implement.
- [ ] `npm test`, commit.

---

### Task 3: Transport identity shape — one strict definition

**Files:** modify `src/workflow/delegation-invariants.js`, `delegation-store.js`, `delegation-services.js`, `delegation-handoff.js`, `pi-delegation-transport.js`.

**Interfaces:**

```js
// Validates the exact key set and returns the normalized identity, or throws
// via the caller-supplied fail function. The strictest of today's four variants.
export function validateDelegationTransportIdentity(value, runId, delegationId, fail)
```

Take `delegation-store.js`'s version as the definition: exact keys `{kind, runId, delegationId, sessionPath, cwd, pid, processStartedAt}`, `kind === "pi-delegation"`, bounded strings, absolute paths where required, and the runId/delegationId cross-check.

Callers that were looser become stricter. `delegation-handoff.js`'s `assertTransportIdentity` checks only `kind`/`runId`/`delegationId`; `pi-delegation-transport.js`'s takes a different argument shape — read both before deciding how each migrates.

**Steps:**
- [ ] Per migrated call site, a test showing a malformed identity that the looser copy accepted is now rejected.
- [ ] Implement, deleting all four local copies.
- [ ] If any call site genuinely needs the weaker check, **stop and report it** rather than keeping a second definition.
- [ ] `npm test`, commit.

---

### Task 4: Claim token comparison — one definition

**Files:** modify `src/workflow/delegation-invariants.js`, `delegation-store.js`, `delegation-handoff.js`.

**Interfaces:**

```js
// True when the presented token matches the stored digest. Constant-shape
// comparison; callers decide what to do on false.
export function claimTokenMatchesDigest(presentedToken, storedDigest)
```

The rule today is `` `sha256:${sha256hex(token.toLowerCase())}` === storedDigest ``, expressed in `delegation-store.js` (five sites: `recordResult`'s remediation branch plus three remediation-launch guards) and `delegation-handoff.js` (one). Keep each caller's surrounding validation (`validateClaimToken`'s UUID-shape check stays where it is) and each caller's failure message.

**Steps:**
- [ ] Tests: matching token, non-matching token, absent digest, absent token, case-insensitivity of the presented token.
- [ ] Implement and migrate all six sites.
- [ ] Confirm the delegation store's and handoff's existing tests pass unmodified.
- [ ] `npm test`, commit.

---

### Task 5: The mutex removal choreography — one algorithm

**Files:** create `src/workflow/mutex-removal.js` + `test/workflow-mutex-removal.test.js`; modify `src/workflow/run-store.js`, `src/workflow/delegation-reservations.js`.

**This is the highest-risk task in the plan.** It touches the code path that decides whether a mutex may be removed. Read `removeLock` (`run-store.js:702`) and `clearGate` (`delegation-reservations.js:304`) side by side first; they are the same twelve-step algorithm with different nouns:

1. reject a non-function `allow`
2. inspect; refuse if the target or its marker is absent (with the ambiguity-specific reason where the store has one)
3. `await allow(marker)`; refuse if not permitted
4. inspect again; refuse if it disappeared
5. refuse if the directory identity changed since step 2
6. refuse if the marker path or bytes changed
7. refuse if the directory holds entries besides the marker (this is the evidence-preservation guard `dc55ba4` added to both files)
8. `unlink` the marker; refuse on `ENOENT`/`ENOTDIR`
9. `stat` the directory again; refuse on `ENOENT`/`ENOTDIR`
10. refuse if the identity changed since step 4
11. `rmdir`; throw on anomalies (this is the one step that throws rather than refusing)
12. return success

**Interfaces:**

```js
// Runs the shared removal choreography. `inspect` returns the store's internal
// shape ({ activePath|activeGate, markerPath, markerText, marker, entries,
// activeStat, markerAmbiguous? }) or null. `noun` supplies the word used in
// refusal reasons ("active lock" / "active gate"). `onRemoved` builds the
// store's own success shape. `onRmdirError` lets each store keep its existing
// throw (they differ deliberately: one uses a shared error constructor, the
// other this file's fail()).
export async function removeOwnedMutex({ inspect, allow, fs, noun, onRemoved, onRmdirError })
```

Refusal reason strings must come out **byte-identical** to today's at every branch, since tests assert them. If a reason differs between the two stores in a way `noun` cannot express, report it rather than unifying the wording.

**Steps:**
- [ ] Read both functions fully and confirm the twelve steps match. If they diverge in a way this interface cannot express, stop and report.
- [ ] Write `test/workflow-mutex-removal.test.js` driving the shared function through every refusal branch and the success path with an injected fs.
- [ ] Migrate `removeLock`, then `clearGate`.
- [ ] Confirm `test/workflow-run-store.test.js` and `test/workflow-delegation-reservations.test.js` pass **completely unmodified**. Any change to either is a signal the extraction altered behavior — investigate rather than updating the test.
- [ ] Verify the two identity checks and the stray-entry guard are still load-bearing by deleting each in turn and confirming exactly its own test fails.
- [ ] `npm test`, commit.

---

### Task 6: Close out

**Files:** `ROADMAP.md`.

**Steps:**
- [ ] Grep-prove one definition per invariant remains, and record the result in your report.
- [ ] Mark item **1.4** `- [x]` with its commit range; add a progress-table row; repoint "próximo paso" at the coordinator-extension ownership gap recorded in "Pendientes conocidos" (the highest-value remaining item), with **1.3** after it.
- [ ] `npm test`, commit.
