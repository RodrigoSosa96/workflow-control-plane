# Task 3 Report — Exact Private-Session Pi Transport

## RED
- Added `test/workflow-pi-delegation-transport.test.js` and updated `test/workflow-worker-transport.test.js` to require the new transport module.
- Ran:
  - `node --test test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js`
- Result: **FAIL** as expected with `ERR_MODULE_NOT_FOUND` for `src/workflow/pi-delegation-transport.js`.

## GREEN
- Implemented `src/workflow/pi-delegation-transport.js`.
- Transport behavior implemented:
  - argv-only Pi launch construction
  - explicit private `--session` and `--session-dir`
  - fixed safe flags: `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-approve`
  - explicit fixed child extension path
  - managed role allowlist loaded through the existing role loader
  - allowlisted Workflow env only
  - exact process identity recording
  - exact `observeExact` matching for `pid`, `startedAt`, and `cwd`
  - remediation follow-up relaunch with the same session path and incremented generation
  - manual-only graceful close response
- Explicitly avoided `createProcessRunner`, shells, global Pi state, transcript/terminal result handling, and any kill/signal cleanup.

## Tests
### Focused RED
- `node --test test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js`
- Result: expected failure before implementation.

### Focused GREEN
- `node --test test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js`
- Result: **PASS**

### Task-focused verification
- `node --test test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js test/workflow-delegation-services.test.js`
- Result: **PASS**

### Full verification
- `npm test`
- Result: **PASS** (`352` tests passed)

### Diff check
- `git diff --check`
- Result: **PASS**

## Commit
- `2bb20e1` — `feat(workflow): launch governed Pi delegation sessions`

## Files
- Created: `src/workflow/pi-delegation-transport.js`
- Created: `test/workflow-pi-delegation-transport.test.js`
- Modified: `test/workflow-worker-transport.test.js`
- Created: `.superpowers/sdd/task-3-report.md`

## Self-review
- Verified launches use arrays and never shell strings.
- Verified the transport builds only the six allowlisted env variables.
- Verified the transport rejects unsafe bootstrap text, path escapes, unmanaged tool mismatches, and injected env fields before spawn.
- Verified `observeExact` uses bounded structured process facts only.
- Verified `requestGracefulClose` is manual-only and non-destructive.
- Verified no real Pi/Herdr/model execution occurs in tests.

## Concerns
- None.

## Follow-up Fix — Latest Exact Identity Enforcement

### Fix scope
- Tightened `deliverFollowUp()` so relaunch requires the caller identity to equal the latest cached exact pid/start-time/cwd/session identity.
- Completed the Task 1 integration by persisting follow-up replacement identities into the delegation store before remediation returns success.
- Added regression coverage for bounded next-generation replacement, stale transport callers, and later service observation/remediation using the replacement identity.

### RED evidence
Command:
```bash
node --test test/workflow-delegation-store.test.js test/workflow-delegation-services.test.js test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js
```
Observed failure after adding the new tests:
- Failed: 3/26
- `deliverFollowUp` still relaunched from a stale caller identity after the old process was missing.
- Task 1 service/store still kept the stale identity instead of the replacement returned by follow-up relaunch.

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
- `.superpowers/sdd/task-3-report.md`

### Commit
- `fix(workflow): persist remediation delegation identities`

### Self-review
- Verified stale caller identities are now rejected before relaunch unless they exactly match the latest cached transport identity.
- Verified successful follow-up relaunches return and persist the new exact identity, and later service reconciliation/remediation uses that replacement.
- Verified the fix preserves Task 3 safety constraints: argv-only launches, no shell, no real Pi/Herdr/model process, no transcript/terminal-derived truth, no global/package state, and no automatic close/cleanup/kill behavior.
