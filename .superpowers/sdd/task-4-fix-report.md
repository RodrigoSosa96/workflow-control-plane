# Task 4 Fix Report: Herdr Public CLI Protocol

## Status
Done

## Commit
`fix(workflow): match Herdr public CLI protocol`

## RED evidence
- Ran: `node --test test/workflow-herdr.test.js`
- Result: 9 failures.
- Verified failures:
  - argv mismatches because unsupported `--json` flags were appended to JSON-default `workspace`, `tab`, `pane`, and `agent` commands
  - live `{ id, result }` worktree and agent fixtures failed normalization with missing IDs
  - `runInPane` returned the raw envelope instead of the unwrapped `result`

## GREEN evidence
### Herdr adapter
- Ran: `node --test test/workflow-herdr.test.js`
- Result: 13/13 tests passed.

### Focused verification
- Ran: `node --test test/workflow-herdr.test.js test/workflow-process.test.js`
- Result: 20/20 tests passed.

### Full suite
- Ran: `npm test`
- Result: 117/117 tests passed.

## Implemented
- `src/workflow/herdr.js`
  - unwraps live Herdr `{ id, result }` envelopes and legacy `{ ok: true, result }`
  - preserves explicit API error envelope handling for `{ id, error }`
  - removes unsupported `--json` from JSON-default `workspace`, `tab`, `pane`, and `agent` wrappers
  - keeps `--json` on supported commands such as `status` and `worktree create/open`
- `test/workflow-herdr.test.js`
  - live-shaped fixtures for workspace, tab, pane, agent, and worktree responses
  - argv-contract tests for Herdr 0.7.4 public CLI behavior
  - regression coverage for unwrapping live success/error envelopes

## Self-review
- Reviewed `src/workflow/herdr.js` and `test/workflow-herdr.test.js` after GREEN.
- Ran: `git diff --check`
- Result: pending fresh verification after commit.

## Concerns
- None blocking.
