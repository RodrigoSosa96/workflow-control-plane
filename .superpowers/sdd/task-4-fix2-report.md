# Task 4 Fix Report 2: Herdr Integration Status Text Parsing

## Status
Done

## Commit
`fix(workflow): parse Herdr integration status`

## RED evidence
- Ran: `node --test test/workflow-herdr.test.js`
- Result: 3 failures.
- Verified failures:
  - plain-text `integration status` lines were incorrectly routed through JSON parsing
  - empty integration output returned `null` instead of `[]`
  - malformed nonempty lines did not produce a clear line-level `HERDR` parsing error

## GREEN evidence
### Herdr adapter
- Ran: `node --test test/workflow-herdr.test.js`
- Result: 16/16 tests passed.

### Focused verification
- Ran: `node --test test/workflow-herdr.test.js test/workflow-process.test.js`
- Result: 23/23 tests passed.

### Full suite
- Ran: `npm test`
- Result: 120/120 tests passed.

## Implemented
- `src/workflow/herdr.js`
  - added a dedicated plain-text parser for `integrationStatus()`
  - returns stable structured entries `{ name, status, version?, path? }`
  - allows empty output as `[]`
  - rejects malformed nonempty lines with `WorkflowError("HERDR", ...)`
  - keeps `integrationStatus()` out of `parseJsonResult`
- `test/workflow-herdr.test.js`
  - live-shaped plain-text fixtures for `integration status`
  - empty-output regression coverage
  - malformed-line rejection coverage

## Self-review
- Reviewed `src/workflow/herdr.js`, `test/workflow-herdr.test.js`, and report updates after GREEN.
- Ran: `git diff --check`
- Result: pending fresh verification after commit.

## Concerns
- None blocking.
