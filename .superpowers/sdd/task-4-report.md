# Task 4 Report: Exact-session resume planning

## Summary

Implemented `src/workflow/resume.js`, exporting `planResume({ store, transport, runId })`.
It reads the run from the store, requires the run's exact `transportIdentity`, asks the
worker transport to `observeExact(identity)`, and maps the observation `state` to a
resume decision:

- `active` / `idle` → `{ action: "focus", identity }`
- `missing` → `{ action: "relaunch", identity }`
- `mismatch` / `unknown` (or any other unrecognized state) → `{ action: "refuse", identity, reason: observation.state }`

Failure modes (run not found; run has no `transportIdentity`) throw `WorkflowError("resume", ...)`
with a `details.runId` payload, per the project's existing error convention.

Implementation and test are exactly as specified in the task brief
(`/home/you/projects/personal/workflows/.worktrees/pi-interactive-lifecycle/.superpowers/sdd/task-4-brief.md`),
transcribed verbatim, no deviations.

Note: this replaces stale content that was previously in this report file, left over from an
earlier/different task-numbering scheme (that older content described "Add the Child and
Coordinator Pi Extensions", unrelated to this task). This file now reports only on the
exact-session resume planning work described above.

## Files changed

- Created: `src/workflow/resume.js`
- Created: `test/workflow-resume.test.js`

Both committed in `b20809c feat(resume): plan exact-session resume over the worker transport`.

Also noted (not touched by this task): `.superpowers/sdd/task-3-report.md` had pre-existing
unstaged modifications in the worktree at the start of this task, unrelated to Task 4. I did
not touch, stage, or commit that file; it remains modified-but-uncommitted in the working
tree exactly as I found it.

## TDD evidence

### RED — module does not exist yet

Command: `node --test test/workflow-resume.test.js`

```
node:internal/modules/esm/resolve:274
    throw new ERR_MODULE_NOT_FOUND(
          ^
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../pi-interactive-lifecycle/src/workflow/resume.js' imported from
'.../pi-interactive-lifecycle/test/workflow-resume.test.js'
...
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Confirmed failure is the expected "planResume is not defined" class of failure (module
resolution fails because `resume.js` did not exist), matching the brief's Step 2 expectation.

### GREEN — after implementing `planResume`

Command: `node --test test/workflow-resume.test.js`

```
✔ a live session is resumed by focus; a dead one relaunches; a mismatch refuses (0.910994ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

### Full suite — before commit

Command: `npm test`

```
ℹ tests 504
ℹ pass 503
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
```

(The 1 skipped test is pre-existing and unrelated to this change — not introduced by this task.)

## Self-review

- **Verbatim brief compliance**: both the test file and `resume.js` were transcribed
  exactly as given in the brief. No additional tests were added, per the task instruction
  to use the brief's code/tests verbatim rather than inventing extra coverage.
- **No `--last`/`--continue` guessing**: `resume.js` never references any process-launch
  flags at all; it only reads `run.transportIdentity` and calls `transport.observeExact(identity)`.
  There is no fallback path that would resume "the most recent" or "the continued" session —
  a run with no exact identity is refused (via thrown `WorkflowError`) rather than guessed.
- **No terminal scraping**: the module reads only `observation.state`; it never reads
  `observation.details` or any terminal/pane/transcript field. This is consistent with
  `worker-transport.js`'s `FORBIDDEN_DETAIL_KEYS` contract, which this module doesn't need
  to touch at all.
- **Transport contract enforcement**: `assertWorkerTransport(transport)` is called first,
  so a transport missing any of `start`/`observeExact`/`deliverFollowUp`/`requestGracefulClose`
  fails fast with a `TypeError` before any store or transport I/O happens.
- **Fail-closed default**: the `switch` only special-cases `active`/`idle`/`missing`; every
  other value (including states outside the transport's own `OBSERVATION_STATES` enum, should
  a bug ever produce one) falls into `refuse` rather than being treated as resumable. This
  matches the "never guess, refuse on doubt" intent of the task.
- **Error category**: `"resume"` was not previously used as a `WorkflowError` category
  anywhere in `src/workflow/`; checked via grep across `src/workflow/*.js` and confirmed no
  collision or inconsistent existing usage. Follows the same lowercase-slug convention as
  `"lifecycle"`, `"telemetry"`, etc.
- **Not wired up yet**: `resume.js` has no callers in this codebase yet (no CLI command,
  no `commands.js` entry point references it). That matches the brief, which scopes Task 4
  to the planning function alone; wiring into a command is presumably a later task. Flagging
  this only so the caller is aware `planResume` is currently reachable only via its own test.
- **Untested paths (by design, per brief)**: the brief's Step 1 test only exercises
  `idle → focus`, `missing → relaunch`, `mismatch → refuse`. Not separately exercised by a
  dedicated assertion (though covered by the same code paths / switch arms as what is tested):
  `active → focus`, `unknown → refuse`, run-not-found throw, and missing-`transportIdentity`
  throw. I did not add tests for these since the task explicitly directs verbatim use of the
  brief's test cases; flagging in case the parent wants a follow-up task for that extra
  coverage.

## Concerns

None blocking. The two minor notes above (module not yet wired into any command; a few
switch/error branches not directly covered by a dedicated assertion) are informational only
and consistent with this task's scope as written in the brief.

## Review-fix addendum: dead-code guard removed, `fail()` helper added, fail-closed test added

A task review of the above implementation found two issues, both addressed here:

1. **Dead-code guard (Important).** `planResume` had `const run = await store.read(runId); if (!run) throw new WorkflowError("resume", ...)`. Against the real run store (`src/workflow/run-store.js`), `read()` never returns a falsy value on a missing run — it calls `failStore("Run not found: ...")`, which throws `WorkflowError("run-store", ...)` first. The `if (!run)` branch was therefore unreachable dead code, and it did not match the convention used by `src/workflow/lifecycle.js` and `src/workflow/handoff.js`, which let the store throw and add no `if (!run)` re-check.

   **Fix:** removed the `if (!run)` guard. `const run = await store.read(runId);` now relies on the store to throw on a missing run (category `"run-store"`), matching the codebase convention. No re-check or try/catch was added around `store.read`.

2. **Inline `WorkflowError` vs the codebase's `fail()` helper (Minor).** Other `src/workflow/*.js` modules (`lifecycle.js`, `handoff.js`, `run-store.js`) define a local `fail(message, details)` that pins the module's error category once, instead of inlining `new WorkflowError(category, ...)` at each call site. `resume.js` inlined `new WorkflowError("resume", ...)` twice.

   **Fix:** added `function fail(message, details) { throw new WorkflowError("resume", message, { details }); }` and switched the missing-`transportIdentity` throw to use it: `if (!identity) fail("Run has no exact session identity to resume", { runId });`. (The other inline throw — the now-removed `if (!run)` guard — no longer exists, so there is only one `fail()` call site in the module.)

`planResume({ store, transport, runId })`'s signature, the `assertWorkerTransport(transport)`-first ordering, and the `active/idle → focus`, `missing → relaunch`, `mismatch/unknown → refuse` mapping are all unchanged.

### Final `src/workflow/resume.js`

```js
import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("resume", message, { details });
}

export async function planResume({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  const identity = run.transportIdentity;
  if (!identity) fail("Run has no exact session identity to resume", { runId });
  const observation = await transport.observeExact(identity);
  switch (observation.state) {
    case "active":
    case "idle":
      return { action: "focus", identity };
    case "missing":
      return { action: "relaunch", identity };
    default:
      return { action: "refuse", identity, reason: observation.state };
  }
}
```

### New test coverage

Added to `test/workflow-resume.test.js` (import of `WorkflowError` added alongside):

```js
test("a run with no transportIdentity is refused with a resume-category WorkflowError", async () => {
  const run = { id: "r1", harness: "pi" };
  const promise = planResume({ ...deps({ observation: { state: "idle" }, run }), runId: "r1" });
  await assert.rejects(promise, (err) => err instanceof WorkflowError && err.category === "resume");
});
```

This exercises a run that exists (the fake store's `read()` returns it) but has no `transportIdentity`, asserting `planResume` rejects with a `WorkflowError` whose `category === "resume"`. The pre-existing three-state test (focus/relaunch/refuse) was left unchanged and still passes.

### TDD evidence for the review fix

**Test added first, run against the pre-fix code** (`resume.js` still had the inline `new WorkflowError("resume", ...)` throws and the dead `if (!run)` guard):

Command: `node --test test/workflow-resume.test.js`

```
✔ a live session is resumed by focus; a dead one relaunches; a mismatch refuses (0.863602ms)
✔ a run with no transportIdentity is refused with a resume-category WorkflowError (4.224206ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

The new test passed immediately rather than failing red, because the pre-fix code's inline throw already used category `"resume"` for the missing-`transportIdentity` case — the dead-code guard and the missing `fail()` helper were both structural/convention issues, not behavioral bugs the new test could observe as a red failure. This matches the task brief's allowance: "watch it fail (or confirm it passes only after the `fail()` wiring is correct)". The test's real purpose — locking in fail-closed behavior on the `transportIdentity` path — is satisfied regardless.

**After removing the dead `if (!run)` guard and adding/wiring the `fail()` helper:**

Command: `node --test test/workflow-resume.test.js`

```
✔ a live session is resumed by focus; a dead one relaunches; a mismatch refuses (0.979818ms)
✔ a run with no transportIdentity is refused with a resume-category WorkflowError (1.186732ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

**Full suite:**

Command: `npm test`

```
ℹ tests 505
ℹ pass 504
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
```

(505 tests total, up from 504 in the prior full-suite run, reflecting the one new test added here. The 1 skipped test is the same pre-existing, unrelated skip noted in the original report above.)

### Files changed in this addendum

- Modified: `src/workflow/resume.js` (removed dead `if (!run)` guard; added local `fail()` helper; missing-`transportIdentity` throw now goes through `fail()`)
- Modified: `test/workflow-resume.test.js` (added `WorkflowError` import and the missing-`transportIdentity` fail-closed test)
- Modified: `.superpowers/sdd/task-4-report.md` (this addendum)

### Self-review

- Did not add an `if (!run)` re-check or wrap `store.read` in try/catch — the store is left to throw, per the constraint.
- Did not touch `planResume`'s signature, the `assertWorkerTransport(transport)`-first ordering, or the focus/relaunch/refuse mapping.
- Did not touch `.superpowers/sdd/task-3-report.md`, which had pre-existing unstaged modifications in this worktree unrelated to this task (same situation noted, and left alone, in the original report above).
- Error category for a not-found run is now `"run-store"` (from the store), not `"resume"` — this is called out explicitly in the review's instructions as acceptable, and is exercised indirectly by the run-store's own test suite (`test/workflow-run-store.test.js`), not duplicated here.
