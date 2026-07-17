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
  - read-only wrappers for status, integration, workspace, tab, pane, and agent inspection
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
- The Task 4 contract and tests expect JSON-capable `herdr workspace/tab/pane/agent/integration` commands. The locally installed Herdr help for 0.7.4 does not advertise `--json` on several of those subcommands, so live CLI compatibility still needs validation in a later integration task.
