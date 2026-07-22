# Task 1 Report — Compose the Foundation into an Approved Delegation Service

## Status
- DONE

## RED evidence
Command:
```bash
node --test test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js
```
Observed failure before implementation:
- `ERR_MODULE_NOT_FOUND` for `src/workflow/delegation-services.js`
- `delegation budget contains unsupported field maxTurns` in `test/workflow-delegation-store.test.js`

## GREEN evidence
Focused verification:
```bash
node --test test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js
```
- Passed: 12/12

Required focused suite:
```bash
node --test test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js test/workflow-delegation-reservations.test.js test/workflow-coordinator-policy.test.js
```
- Passed: 19/19

Full verification:
```bash
npm test
```
- Passed: 336/336

Formatting check:
```bash
git diff --check
```
- Clean

## Tests added/updated
- `test/workflow-delegation-services.test.js`
  - preview purity and immutable approval data
  - stale approval rejection before mutation
  - one-time approved execution with prepared-request validation
  - changed-task rejection without echoing task text
  - retained reservation on start failure
  - bounded reconciliation output without terminal-derived content
  - two-turn remediation cap
  - remediation follow-up failure preserves incremented generation
- `test/workflow-delegation-store.test.js`
  - 4-field budget persistence
  - exact transport identity persistence
  - consume/adopt terminal result lifecycle
  - wrong-session and duplicate consumption rejection
  - start-failure persistence without losing brief

## Changed files
- `src/workflow/delegation-services.js`
- `src/workflow/delegation-store.js`
- `test/workflow-delegation-services.test.js`
- `test/workflow-delegation-store.test.js`

## Implementation summary
- Added a pure delegation service factory with:
  - `createPreview`
  - `executeApproved`
  - `reconcile`
  - `beginRemediation`
- Bound approval digests to canonical sorted JSON over the required stable payload.
- Recomputed previews at execution time and rejected stale/mutated approvals.
- Composed prepare/claim/reserve/start/record-identity flow without starting real agents.
- Extended delegation store with:
  - `recordTransportIdentity`
  - `recordStartFailure`
  - `consumeResult`
  - `adoptResult`
- Expanded delegation budgets to exact persisted numeric limits:
  - `maxRuntimeMs`
  - `concurrency`
  - `maxTurns`
  - `maxToolCalls`

## Self-review
- Verified no `pi-subagents`, package installs, spawned Pi/Herdr/model processes, transcript reads, global Pi state, or automatic release/cleanup/kill behavior were introduced.
- Kept start-failure handling fail-closed and reservation-retaining.
- Kept remediation/result APIs bounded and free of prompt/task leakage in tested error paths.
- Limited scope to the Task 1 orchestration seam and delegation-store lifecycle extensions only.

## Commit
- `221f68a` — `feat(workflow): orchestrate approved Pi delegations`

## Concerns
- None.

## Follow-up Fix — Exact Remediation Identity Persistence

### Fix scope
- Persisted the fresh follow-up pid/start-time identity returned by remediation relaunches before `beginRemediation()` returns.
- Extended delegation-store identity recording only as needed with bounded next-generation replacement rules for the same run/delegation/session/cwd.
- Tightened stale-identity handling so later reconciliation/remediation uses the persisted replacement identity.

### RED evidence
Command:
```bash
node --test test/workflow-delegation-store.test.js test/workflow-delegation-services.test.js test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js
```
Observed failure after adding the new tests:
- Failed: 3/26
- `beginRemediation persists replacement identities...` still returned the stale stored identity.
- `recordTransportIdentity` still rejected any bounded next-generation replacement.
- `deliverFollowUp` still accepted a stale caller identity after the old process was missing.

### GREEN evidence
Focused verification:
```bash
node --test test/workflow-delegation-store.test.js test/workflow-delegation-services.test.js test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js
```
- Passed: 26/26

Full verification:
```bash
npm test
```
- Passed: 354/354

Formatting check:
```bash
git diff --check
```
- Clean

### Commands and results
- `node --test test/workflow-delegation-store.test.js test/workflow-delegation-services.test.js test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js` → RED, 3 new exact-identity tests failed before implementation; GREEN, 26/26 passed after the fix.
- `npm test` → GREEN, 354/354 passed.
- `git diff --check` → clean.

### Files
- `src/workflow/delegation-services.js`
- `src/workflow/delegation-store.js`
- `src/workflow/pi-delegation-transport.js`
- `test/workflow-delegation-services.test.js`
- `test/workflow-delegation-store.test.js`
- `test/workflow-pi-delegation-transport.test.js`
- `.superpowers/sdd/task-1-report.md`

### Commit
- `fix(workflow): persist remediation delegation identities`

### Self-review
- Verified successful remediation relaunches now persist the returned exact identity before the service returns success.
- Verified replacement is limited to the next current generation of the same run/delegation/session/cwd and cannot be replayed with stale prior identity.
- Verified later reconciliation/remediation uses the replacement identity and stale caller identities are rejected at the transport boundary even when the old process is missing.
- Preserved Task 1 safety constraints: no real Pi/Herdr/model process, no shell, no global/package state, no terminal/transcript result, no automatic release/cleanup/kill, and no worktree/nesting/background-writer enablement changes.

## Follow-up Fix — Remediation Observation Gate

### Fix scope
- Added TDD coverage for `beginRemediation()` missing, mismatch, and unsafe `active` observations.
- Gated `beginRemediation()` on `transport.observeExact(record.transportIdentity)` and rejected every non-`idle` observation before generation increment or `deliverFollowUp`.
- Kept scope limited to the Important review finding; no process, cleanup, transcript, or release behavior changed.

### RED evidence
Command:
```bash
node --test test/workflow-delegation-services.test.js
```
Observed failure after adding the new tests:
- Failed: 3/11
- `Missing expected rejection` for missing, mismatch, and unsafe observation remediation cases.

### GREEN evidence
Focused verification:
```bash
node --test test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js test/workflow-delegation-reservations.test.js test/workflow-coordinator-policy.test.js
```
- Passed: 22/22

Full verification:
```bash
npm test
```
- Passed: 339/339

Formatting check:
```bash
git diff --check
```
- Clean

### Commands and results
- `node --test test/workflow-delegation-services.test.js` → RED, 3 new remediation-gate tests failed before implementation.
- `node --test test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js test/workflow-delegation-reservations.test.js test/workflow-coordinator-policy.test.js` → GREEN, 22/22 passed.
- `npm test` → GREEN, 339/339 passed.
- `git diff --check` → clean.

### Files
- `src/workflow/delegation-services.js`
- `test/workflow-delegation-services.test.js`
- `.superpowers/sdd/task-1-report.md`

### Commit
- `34eabb3` — `fix(workflow): gate delegation remediation on observation`

### Self-review
- Verified `beginRemediation()` now performs its own exact-identity observation gate, so callers cannot bypass safety by skipping `reconcile()`.
- Verified missing, mismatch, and unsafe non-idle observations leave delegation generation unchanged and do not call `deliverFollowUp`.
- Preserved Task 1 safety constraints: no Pi/Herdr/model process changes, no terminal/transcript truth, no automatic release/cleanup/kill, no `pi-subagents`, and no scope expansion.
