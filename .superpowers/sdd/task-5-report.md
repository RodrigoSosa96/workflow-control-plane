# Task 5 Report — Expose Safe Delegation Commands and Reconciliation

## Status
Completed in the isolated worktree.

## RED evidence
Added failing coverage first for the new delegation CLI family and command handlers.

### RED command
```bash
node --test test/workflow-delegation-commands.test.js test/workflow-cli.test.js
```

### RED result
Failed as expected before implementation:
- `test/workflow-delegation-commands.test.js` could not import `delegationReconcileCommand` / related exports.
- `test/workflow-cli.test.js` failed help, parsing, exit-code, and remediation lifecycle expectations because delegation result/reconcile/remediate were not wired.

## GREEN implementation summary
Implemented:
- `workflow delegation result <run-id> <delegation-id>`
- `workflow delegation reconcile <run-id> <delegation-id>`
- `workflow delegation remediate <run-id> <delegation-id> --prompt-file <path> [--dry-run] [--approval-digest <digest>] [--yes]`
- bounded compact formatting for delegation command output
- CLI help and parsing updates
- service/store-backed reconciliation/remediation command handling
- stable delegation result exit codes for `pending` and `result-stale`

## Files changed
- `bin/workflow.js`
- `src/workflow/commands.js`
- `src/workflow/format.js`
- `test/workflow-cli.test.js`
- `test/workflow-delegation-commands.test.js`

## Focused verification
```bash
node --test test/workflow-delegation-commands.test.js test/workflow-cli.test.js test/workflow-format.test.js
```
Passed.

## Full verification
```bash
npm test
git diff --check
```
Passed.

## Test coverage added
- delegation help and parsing
- path-safe ID validation
- rejection of unsupported flags (`--last`, `--continue`, raw prompt/output/role/mode/cwd overrides, duplicates)
- stable exit codes for delegation result
- read-only delegation reconcile behavior
- remediation dry-run / `--yes` / approval-digest lifecycle
- bounded result/reconcile payloads
- ownership, observation, reservation-retention, stale result, explicit adoption, and remediation-cap cases
- compact formatter redaction of sensitive delegation details

## Self-review
- Kept delegation mutators gated behind `--yes` plus preview approval digest.
- Kept remediation preview read-only; service construction is delayed until approved execution.
- Preserved separate fields for ownership, identity, observation, reservation, and remediation state in delegation reconcile output.
- Avoided exposing run directories, session paths, reservation owner tokens, transcripts, stdout/stderr, or prompt bodies in compact delegation output.

## Commit
Planned commit message:
```bash
git commit -m "feat(workflow): reconcile governed Pi delegations"
```

## Concerns
- Live delegation reconcile/remediate still expects a transport dependency to be supplied by the caller/runtime wiring; this task wired the CLI surface and injectable command path safely, but did not add a new real Pi process transport bootstrap beyond the existing interfaces.
