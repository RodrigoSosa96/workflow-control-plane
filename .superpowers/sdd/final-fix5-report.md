# final-fix5 report

## RED
- Added regressions for unknown process inspection during remediation gating.
- Added transport/service/store/handoff regressions for spawned-but-unverified follow-up launches.
- Added regressions for post-spawn persistence failure retaining a non-retryable manual-recovery claim.
- Confirmed failures in focused workflow delegation/CLI transport test runs before the fix.

## GREEN
- Process inspection now fails closed: only proven PID absence maps to `missing`; inspection/proc/read/permission failures map to `unknown`.
- Exact-session remediation blocks on `unknown` observation and never resumes/spawns from ambiguous runtime inspection.
- Transport follow-up spawn now returns a distinct `spawned-but-unverified` outcome instead of looking like a pre-spawn failure.
- Remediation claim rollback remains limited to proven no-spawn delivery failure.
- Spawned-but-unverified and post-spawn persistence failures now persist `manual-recovery` remediation state, block retries, and reject generation-2 handoff acceptance.
- No automatic cleanup/kill/release behavior was introduced.

## Files
- `.pi/extensions/workflow-coordinator/index.ts`
- `src/workflow/delegation-services.js`
- `src/workflow/delegation-store.js`
- `src/workflow/pi-delegation-transport.js`
- `src/workflow/process-observation.js`
- `src/workflow/worker-transport.js`
- `test/workflow-cli.test.js`
- `test/workflow-delegation-handoff.test.js`
- `test/workflow-delegation-services.test.js`
- `test/workflow-delegation-store.test.js`
- `test/workflow-pi-delegation-transport.test.js`
- `test/workflow-worker-transport.test.js`

## Verification
- `node --test test/workflow-worker-transport.test.js test/workflow-pi-delegation-transport.test.js test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js test/workflow-delegation-handoff.test.js test/workflow-cli.test.js test/workflow-pi-extensions.test.js`
- `npm test`
- `npm pack --dry-run`
- `git diff --check`

## Self-review
- Verified only explicit PID absence permits follow-up; ambiguous inspection now stays blocked.
- Verified spawned-but-unverified remediation launches keep a non-retryable manual-recovery claim and do not allow a second spawn.
- Verified generation-2 handoff is rejected for unverified/manual-recovery children and for post-spawn persistence failures.
- Verified rollback still restores the prior terminal result/generation only on proven no-spawn follow-up failure.
