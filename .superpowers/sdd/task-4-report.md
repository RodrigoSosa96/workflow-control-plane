# Task 4 Report: Herdr JSON Adapter

## Status
Done

## Commit
`feat(workflow): add Herdr orchestration adapter`

## RED evidence
- Ran: `node --test test/workflow-herdr.test.js`
- Result: failed with `ERR_MODULE_NOT_FOUND` for `src/workflow/herdr.js` before implementation.

## GREEN evidence
### Herdr adapter
- Ran: `node --test test/workflow-herdr.test.js`
- Result: 12/12 tests passed.

### Selected Task 4 verification
- Ran: `node --test test/workflow-herdr.test.js test/workflow-process.test.js`
- Result: 19/19 tests passed.

### Full suite
- Ran: `npm test`
- Result: 116/116 tests passed.

## Implemented
- `src/workflow/herdr.js`
  - `createHerdrAdapter({ runner, binary? })`
  - JSON parsing/unwrapping with `WorkflowError` handling for API envelopes and malformed output
  - read-only wrappers for status, workspace, tab, pane, and agent inspection plus dedicated integration-status parsing
  - native worktree ensure flow for `missing`, `closed`, and already-open reconciliation states
  - ID-threading helpers for worktree, tab, pane, and agent creation results
- `test/workflow-herdr.test.js`
  - fixture-runner coverage for JSON success/error parsing
  - native worktree `created`, `opened`, and `already_open` responses
  - explicit argv/focus handling for tab, pane, runtime-command, and agent-start wrappers

## Self-review
- Reviewed `src/workflow/herdr.js` and `test/workflow-herdr.test.js` after GREEN.
- Ran: `git diff --check`
- Result: clean.

## Concerns
- None blocking.

## Review fix evidence
### Critical 1: unsupported `--json` flags on JSON-default commands
- Added failing argv-contract tests for `workspace list/get`, `tab list/create/rename`, `pane list/split/rename`, and `agent list` using the public Herdr 0.7.4 CLI shapes.
- RED: `node --test test/workflow-herdr.test.js`
- RED result: 9 failures, including explicit argv mismatches because the adapter appended unsupported `--json` flags.
- Fix: removed `--json` from the affected wrappers while keeping it on documented worktree create/open and status.
- GREEN: `node --test test/workflow-herdr.test.js`
- GREEN result: 13/13 passed.

### Critical 2: live `{ id, result }` and `{ id, error }` envelopes
- Added failing live-envelope tests for status, workspace/tab/pane/agent list/get/create/split/start, and worktree create/open/already-open fixtures shaped like captured Herdr 0.7.4 responses.
- RED: `node --test test/workflow-herdr.test.js`
- RED result: worktree and agent normalization failed with missing IDs, and `runInPane` returned the raw `{ id, result }` envelope instead of the unwrapped result.
- Fix: changed the adapter to unwrap any explicit `result` envelope while preserving explicit API `error` handling and legacy `{ ok: true, result }` compatibility.
- GREEN: `node --test test/workflow-herdr.test.js`
- GREEN result: 13/13 passed.

### Focused verification
- Ran: `node --test test/workflow-herdr.test.js test/workflow-process.test.js`
- Result: 20/20 tests passed.

### Full suite
- Ran: `npm test`
- Result: 117/117 tests passed.

### Critical 3: plain-text `herdr integration status`
- Added failing live-shaped text tests for `integration status` using public 0.7.4 output lines such as `pi: current (v5) (/path)` and `copilot: not installed (/path)`.
- RED: `node --test test/workflow-herdr.test.js`
- RED result: 3 failures because `integrationStatus()` still routed through JSON parsing, returned `null` for empty output instead of `[]`, and did not surface malformed-line diagnostics.
- Fix: implemented a dedicated plain-text parser for `integrationStatus()` that returns stable entries `{ name, status, version?, path? }`, allows empty output as `[]`, and rejects malformed nonempty lines with a clear `HERDR` error.
- GREEN: `node --test test/workflow-herdr.test.js`
- GREEN result: 16/16 passed.

### Focused verification (final)
- Ran: `node --test test/workflow-herdr.test.js test/workflow-process.test.js`
- Result: 23/23 tests passed.

### Full suite (final)
- Ran: `npm test`
- Result: 120/120 tests passed.
