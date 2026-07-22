# Task 4 Report — Add the Child and Coordinator Pi Extensions

## Status
Completed in the isolated worktree and committed.

## Commit
- `feat(workflow): deliver governed Pi delegation results`

## Scope delivered
Implemented the Task 4 files only:
- `.pi/extensions/workflow-delegation-child.ts`
- `.pi/extensions/workflow-coordinator/index.ts`
- `src/workflow/delegation-watcher.js`
- `test/workflow-delegation-watcher.test.js`
- `test/workflow-pi-extensions.test.js`
- `test/workflow-coordinator-policy.test.js`

## RED evidence
Added the new extension and watcher tests first, then ran the focused RED command before implementation.

Command:
```bash
node --test test/workflow-pi-extensions.test.js test/workflow-delegation-watcher.test.js test/workflow-coordinator-policy.test.js
```

Observed failure before implementation:
- `ERR_MODULE_NOT_FOUND` for `src/workflow/delegation-watcher.js`
- `ERR_MODULE_NOT_FOUND` for `.pi/extensions/workflow-delegation-child.ts`

This matched the task brief expectation that the run should fail because the extension and watcher files did not yet exist.

## Implementation summary
### Child extension
- Registered exactly one tool: `workflow_delegation_handoff`.
- Used a strict schema with `status` enum values `completed|blocked|failed`.
- Kept the factory inert; no timers, watcher startup, or process work happens before session events.
- Validated only the allowlisted `WORKFLOW_*` environment.
- Recorded bounded lifecycle facts on:
  - `session_start`
  - `before_agent_start`
  - `agent_settled`
  - `session_shutdown`
- Avoided storing raw prompt text; only prompt byte count is recorded.
- Routed terminal submission through an injected/default fixed handoff adapter and returned `terminate: true` only after successful submission.

### Delegation watcher
- Added `createDelegationWatcher({ delegations, originSessionId, onResult, onNotice, intervalMs, clock })`.
- Starts only when explicitly started by the coordinator session.
- Maintains one in-flight poll.
- Lists by exact origin session, filters terminal current-generation unconsumed results, then atomically consumes before delivery.
- Delivers only bounded payload fields:
  - `runId`
  - `delegationId`
  - `role`
  - `generation`
  - `state`
  - `summary`
  - `verification`
  - `concerns`
  - `nextAction`
- Emits one-time notices for stale/manual states without converting them into completion deliveries.
- Stops idempotently and clears its timer.

### Coordinator extension
- Registered exactly these tools:
  - `workflow_prepare_delegation`
  - `workflow_execute_delegation`
  - `workflow_delegation_result`
  - `workflow_adopt_delegation_result`
  - `workflow_remediate_delegation`
- Added a `tool_call` guard for `subagent` using `validateSubagentRequestPolicy` without rewriting input.
- Enforced UI confirmation for mutating tools.
- Used strict additional-properties-closed schemas for extension tools.
- Stored approved previews in memory and executed only approved in-memory digests.
- Started the session-owned watcher in `session_start` and stopped it in `session_shutdown`.
- Injected consumed results with:
  - `deliverAs: "followUp"`
  - `triggerTurn: ctx.isIdle()`
- Kept adoption explicit; no implicit cross-session delivery path was added.

## Tests added/updated
### Added
- `test/workflow-pi-extensions.test.js`
  - child extension lifecycle and handoff behavior
  - coordinator registration, watcher wiring, confirmation flow, and subagent guard behavior
- `test/workflow-delegation-watcher.test.js`
  - one in-flight poll
  - exact-once consumption
  - wrong-origin suppression
  - reload race handling
  - timer cleanup
  - stale/manual notices

### Updated
- `test/workflow-coordinator-policy.test.js`
  - added assertion that validation never rewrites the incoming subagent request

## Verification run
Focused:
```bash
node --test test/workflow-pi-extensions.test.js test/workflow-delegation-watcher.test.js test/workflow-coordinator-policy.test.js
```
Passed.

Full:
```bash
npm test
```
Passed (`361` tests passing).

Diff hygiene:
```bash
git diff --cached --check
git diff --check
```
Passed.

## Self-review notes
- The live coordinator runtime is wired to local Workflow modules and a real Pi delegation transport path, but process observation is still conservative: the live `/proc` inspection reports existence and cwd identity, not rich idle/settled state. The fake-based remediation coverage for this task passes, but richer live idleness detection may still be desirable in later lifecycle work.
- No `pi -e`, model, child launch canary, Herdr launch, package install, project trust mutation, fleet UI, watchdog UI, or global Pi state changes were introduced.
- The implementation keeps child submission, watcher ownership, and origin-session adoption bounded to the task’s safety constraints.

## Files changed
- `.pi/extensions/workflow-delegation-child.ts`
- `.pi/extensions/workflow-coordinator/index.ts`
- `src/workflow/delegation-watcher.js`
- `test/workflow-pi-extensions.test.js`
- `test/workflow-delegation-watcher.test.js`
- `test/workflow-coordinator-policy.test.js`

## Follow-up fix RED/GREEN evidence
### RED
Command:
```bash
node --test test/workflow-pi-extensions.test.js test/workflow-delegation-watcher.test.js test/workflow-coordinator-policy.test.js
```
Observed failures before the fix:
- `workflow_adopt_delegation_result` still filtered lookup to the adopter session, so later-session explicit adoption failed.
- `workflow_remediate_delegation` accepted invalid `insideFrozenBrief` values past the extension boundary.
- `workflow_delegation_result` exposed unsanitized raw result metadata in `details`.

### GREEN
Focused:
```bash
node --test test/workflow-pi-extensions.test.js test/workflow-delegation-watcher.test.js test/workflow-coordinator-policy.test.js
```
Passed (`11/11`).

Full:
```bash
npm test
```
Passed (`362/362`).

Diff hygiene:
```bash
git diff --check
```
Passed.
