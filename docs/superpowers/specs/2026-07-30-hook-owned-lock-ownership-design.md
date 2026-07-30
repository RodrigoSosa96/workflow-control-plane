# Hook-Owned Lock Ownership Design

**Date:** 2026-07-30
**Status:** Approved (2026-07-30)
**Roadmap item:** 1.1b. Completes item 1.1 ([`2026-07-30-provable-owner-recovery-design.md`](2026-07-30-provable-owner-recovery-design.md)).

## Problem

Item 1.1 made owner markers carry `{pid, startedAt}` so `workflow unlock` can prove a lock's owner dead before removing it. That works for every lock the `workflow` CLI acquires, because `bin/workflow.js` constructs one ownership reader per process and threads it into every store.

It does **not** work for locks acquired by any *other* process, and those are the most frequent ones. Six sites build their own run store with no reader; five of them actually acquire the lock:

| Site | Acquires the lock? |
|---|---|
| `hooks/claude-lifecycle.mjs:54` | yes — `lifecycle-hook-core.mjs:61` calls `store.update` |
| `hooks/codex-lifecycle.mjs:49` | yes — same core |
| `hooks/claude-statusline.mjs:123` | **no** — its read path (`main` → `loadSnapshot` → `readSnapshot` → `store.read`) never calls `withLock`; `readOwnOwnership` is only invoked from inside `acquireLock` |
| `.pi/extensions/workflow-worker-lifecycle.ts:17` | yes — same lifecycle calls, in-process |
| `.pi/extensions/workflow-worker-observability.ts:66` | yes — telemetry writes |
| `scripts/smoke-workflow-fixture.js:171` | test-only |

**Correction (recorded during implementation, task 3 of the plan):** this table originally listed `hooks/claude-statusline.mjs:123` as acquiring the lock. It does not — investigated end-to-end and proven never to reach `withLock`, with a regression test guarding the finding (`test/workflow-claude-statusline-hook.test.js`, "the statusline hook's telemetry read path never acquires the run lock, so no readOwnOwnership wiring is needed there"). Five sites needed wiring, not six; the "Decision" and "Verification Strategy" sections below were already written in terms of five and did not need correcting.

Lifecycle hooks fire on **every prompt and every stop of every worker**, so they take the run lock far more often than the CLI does. A crash while one holds it leaves residue whose marker has no `pid`/`startedAt`, and `workflow unlock` refuses it as `unprovable` — permanently. The command that exists to recover wedged locks cannot recover the ones most likely to wedge.

This is the same defect class the 1.1 final review caught in `launchCommand`; it was found by verifying the scoped re-review's side note rather than accepting it.

## Decision

Each of those processes reads **its own** identity and threads it into its store, using a shared helper so the reader is constructed one way everywhere.

### Why the process's own identity, and not the worker's

The roadmap originally suggested the hook inherit `{pid, startedAt}` from the worker through the `WORKFLOW_*` env that `runEnv` already injects, on the reasoning that it costs no subprocess. **That is wrong, and worse than the status quo.**

The process that holds the lock is the hook, not the worker. Recording the worker's identity would make residue left by a dead hook classify `owner-alive` — the worker really is alive — so `unlock` would refuse it. That is a false negative that blocks recovery permanently. Today the same residue classifies `unprovable`: it also refuses, but honestly, and a future fix can improve it.

Recording the hook's own identity gives the correct verdict by construction. A hook is ephemeral: by the time an operator runs `unlock`, the hook that wedged the lock is almost always gone, so the marker classifies `owner-gone` → removable. If a hook somehow still holds the lock and is alive, it classifies `owner-alive` and refuses — also correct.

### Why the cost objection does not hold

The concern recorded at 1.1's merge was that reading the own start time means spawning `ps` inside a fire-and-forget hook. Measured on this machine:

- `node -e ''` startup: **~22 ms**
- `ps -p <pid> -o lstart= -o state=`: **~7 ms**

A hook already *is* a fresh `node` process, so this is roughly a third more on a subprocess that already exists, once per hook invocation — not a new category of cost. The in-process Pi extensions pay it once per session, not per event, because the reader memoizes.

What must be preserved is the ordering 1.1's task-2 review established: the read happens **before** the mutex is acquired, never while it is held.

### `/proc/self/stat` was considered and rejected

Deriving the start time from `/proc/self/stat` field 22 would avoid the subprocess. It is rejected because the classifier compares `startedAt` for **exact string equality**, and the value written must match what `inspectExactProcessByPid` later reads back via `ps -o lstart=`. Reconstructing that string from ticks-since-boot requires boot time and clock-tick resolution and must round to the same second `ps` reports; a mismatch produces a false `owner-gone` on a **live** owner, which is the one error class this design must never make. One code path writes and reads the value, or the comparison is not trustworthy.

## Goals

- Locks acquired by lifecycle hooks and Pi worker extensions carry ownership evidence, so `workflow unlock` can recover them.
- One helper builds the reader everywhere, so no site can drift into a different `ps` invocation than the one the classifier reads back.
- The read never happens inside a mutex's critical section.
- A failure to read own identity still permits acquisition — degrading to today's behavior, never breaking a worker.

## Non-goals

- Changing what `unlock` does, or any classification rule. This only makes more markers classifiable.
- Making hooks report anything to the operator, or adding any new hook output.
- Ownership for processes outside this repo's control.
- Removing the `ps` dependency (see the rejected alternative).

## Architecture

```text
hook / extension process starts
  |
  | createSubprocessOwnOwnershipReader()   ← one shared helper, memoized
  v
createRunStore({ stateRoot, readOwnOwnership })
  |
  | first lock acquisition: reader runs `ps` once, BEFORE mkdir
  v
owner marker { version: 2, token, runId, pid, startedAt }
  |
  | hook process exits (or crashes holding the lock)
  v
workflow unlock <run-id>  →  owner-gone  →  removable
```

`src/workflow/ownership.js` gains one export that packages what every subprocess needs, so no caller hand-rolls the `ps` argv:

```js
// Builds the standard memoized own-ownership reader for a process that has no
// injected runner (hooks, Pi extensions, scripts). Uses the same ps invocation
// inspectExactProcessByPid reads back, so written and observed startedAt are
// produced by one code path. Never throws: on any failure the reader resolves
// null and acquisition proceeds with the keys omitted.
export function createSubprocessOwnOwnershipReader({ spawnProcess, readCwd } = {})
```

Its defaults do the real work (`node:child_process` + `node:fs/promises.realpath`) so a caller writes `createSubprocessOwnOwnershipReader()`, while tests inject both seams. It returns the same memoized function shape `createOwnOwnershipReader` already returns, so the stores need no change at all.

## Error Handling

- Any failure reading own identity (`ps` missing, non-zero exit, unparseable output, `/proc` unreadable) resolves `null`. The marker omits `pid`/`startedAt` and acquisition proceeds — exactly today's behavior for these sites.
- The reader must never throw into a hook: the lifecycle hooks swallow errors by design, and a throw here would be indistinguishable from the bookkeeping failures that already get logged to `hooks-debug.log`.
- The reader is memoized including the failure case, so a broken environment costs one `ps` attempt per process, not one per lock.

## Verification Strategy

1. `createSubprocessOwnOwnershipReader()` with injected seams returns `{pid, startedAt}` for a live process and memoizes across calls, invoking the spawn exactly once.
2. It resolves `null` — never throws — for: a spawn that fails, a non-zero exit, empty or unparseable output, and a `readCwd` that rejects.
3. Its `startedAt` is byte-identical to what `inspectExactProcessByPid` reports for the same pid, proven against the real `ps` in one integration test. This is the property the whole design rests on; assert equality, not merely format.
4. Each of the five production sites constructs its store with a reader: assert per site, and confirm each test fails when the argument is removed.
5. A lock acquired by the shared lifecycle hook core carries `pid`/`startedAt` at `0600`, and `classifyOwnership` returns a non-`unprovable` verdict for that marker.
6. A reader whose spawn fails still permits acquisition, writing a marker with the keys **omitted** (never empty strings).
7. The read happens before the mutex is acquired: assert the spawn is observed before the active-lock directory exists.
8. Hook behavior is otherwise unchanged: the existing lifecycle-hook tests pass untouched.
9. `npm test` green.

## Acceptance Criteria

- A run lock wedged by a killed lifecycle hook is recoverable with one confirmed `workflow unlock`, where today it is refused forever.
- No site hand-rolls a `ps` invocation; all of them share the helper.
- A hook whose environment cannot report its own start time still works, and still never breaks its worker.
- The `startedAt` a hook writes and the one `unlock` reads back are produced by the same code path, proven by an equality test against the real `ps`.
