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
- Default live delegation inspection assumes `ps` plus `/proc/<pid>/cwd`; non-Linux runtimes should inject `inspectDelegationProcess` / `spawnDelegationChild` seams.

## Review fix follow-up — live transport, redaction, exit mapping, single observation

### RED command
```bash
node --test test/workflow-delegation-commands.test.js test/workflow-cli.test.js
```

### RED result
Failed as expected before the fix:
- `main wires the live Pi delegation transport only for live reconcile and approved remediation` returned exit `1` because the CLI never constructed/injected `PiDelegationTransport`.
- `maps conflict and preflight workflow errors to stable categories` returned exit `3` for `delegation-service` failures because they fell through to `CONFIG`.
- `delegation reconcile preserves process identity...` still exposed transport `cwd` / observation details and performed an extra observation.
- `delegation reconcile reuses the service observation snapshot exactly once` returned a second `idle` observation instead of the original `mismatch` snapshot.

### GREEN implementation summary
Implemented follow-up fixes in:
- `bin/workflow.js`
- `src/workflow/commands.js`
- `src/workflow/delegation-services.js`
- `test/workflow-cli.test.js`
- `test/workflow-delegation-commands.test.js`
- `test/workflow-delegation-services.test.js`

Key outcomes:
- live CLI wiring now constructs and injects `PiDelegationTransport` only for `delegation reconcile` and approved `delegation remediate`
- transport construction uses safe `stateRoot` / control-plane context and injected spawn/inspect seams only
- public reconcile identity/observation output now redacts `cwd`, `observedCwd`, and transport detail fields
- delegation service failures now map to stable `PREFLIGHT` CLI exits instead of `CONFIG`
- reconcile now returns the same observation snapshot used to compute next actions

### GREEN commands
```bash
node --test test/workflow-delegation-commands.test.js test/workflow-cli.test.js test/workflow-delegation-services.test.js test/workflow-format.test.js
npm test
git diff --check
```

### GREEN result
Passed.
