# Coordinator Extension Ownership Design

**Date:** 2026-07-31
**Status:** Proposed
**Roadmap item:** 1.1c. Third and last instalment of item 1.1 ([`2026-07-30-provable-owner-recovery-design.md`](2026-07-30-provable-owner-recovery-design.md)), after 1.1b ([`2026-07-30-hook-owned-lock-ownership-design.md`](2026-07-30-hook-owned-lock-ownership-design.md)).

## Problem

Item 1.1 made owner markers carry `{pid, startedAt}` so `workflow unlock` and `workflow delegation gate-clear` can prove a mutex's owner dead before removing it. Item 1.1b extended that to every process that builds its own run store *outside* the CLI — the lifecycle hooks and the two Pi worker extensions.

One process was left out, and it is the one that holds a mutex longest: the coordinator extension, `.pi/extensions/workflow-coordinator/index.ts`. It builds both mutex-taking stores with no ownership reader:

| Site | What it builds | Reader today |
|---|---|---|
| `:501` | run store (`createRunStoreImpl({ stateRoot, onListProblem })`) | none → `createRunStore`'s own `async () => null` |
| `:511` | reservation store (`createReservationStoreImpl({ stateRoot, canonicalPath })`) | none → `createDelegationReservationStore`'s own `async () => null` |
| `:537-551` | `createLaunchCommand` deps — neither `store` nor `readOwnOwnership` | none → `launchCommand` (`commands.js:1778`) falls back to `createRunStore({ stateRoot, readOwnOwnership: undefined })` |

Both mutexes are reachable from this file in production. The run lock is taken by every `store.update` the delegation store and the delegation services perform, and by the whole launch path. The reservation gate is taken through `workflow_execute_delegation` → `delegation-services.executeApproved` → `reservations.reserve` → `acquireGate`.

The third row is the one that matters most. `launchCommand`'s fallback deliberately does **not** go through `storeForCommand` — that bypass was final-review finding 1 of item 1.1, fixed there by threading `deps.readOwnOwnership`. The coordinator never passes one, so the fix does not reach it. And `launch` holds the run lock across worktree creation, the Herdr calls, and agent startup: the longest hold in the system, and therefore the one most likely to be interrupted. Residue from an interrupted coordinator launch classifies `unprovable` and `workflow unlock` refuses it — permanently.

This is not a regression. It is pre-existing scope that neither 1.1 nor 1.1b covered, the same relationship 1.1b had with what 1.1 left open.

### The fourth `ps` copy, in the same file

`runPsForPid` (`:386-409`) hand-rolls `["-p", String(pid), "-o", "lstart=", "-o", "state="]` — the fourth copy of an argv that 1.1b consolidated to one source (`process-observation.js`'s `psStatusArgv`). It feeds `inspectCoordinatorPid`, which is both sides of the child identity comparison `pi-delegation-transport.js` performs: the transport records `{pid, startedAt, cwd}` at spawn (`:353`, `:416`) and compares them in `observeExact` (`:367`).

It never feeds an owner marker, so it cannot produce the "live owner killed" error class this line of work exists to prevent. It is self-consistent today because both sides use the same local literal. The hazard is drift: it calls the *shared* `parsePsProcessStatus`, so a future change to `psStatusArgv` that also touches the parser would leave the coordinator emitting old-format output into a new parser, and the failure would be silent — inspection throws, children degrade to `spawned-but-unverified` or to an identity mismatch.

Reading it for this spec turned up that the duplication is not only the argv. `runPsForPid` duplicates the spawn choreography too, and diverges from `ownership.js`'s `spawnPsStatus` at one point with a consequence: it discards stderr (`stdio: ["ignore", "pipe", "ignore"]`). `inspectExactProcessByPid` proves a pid absent only when the exit code is 1 **and** stdout **and** stderr are all empty (`process-observation.js:48-50`); with stderr permanently `undefined`, the coordinator's copy treats "`ps` exited 1 while complaining on stderr" as proven-absent, where every other caller treats it as ambiguous. A false `missing` from `observeExact` is exactly the precondition `deliverFollowUp` requires before relaunching a delegation (`pi-delegation-transport.js`), so the divergence points at a second writer in a checkout that already has one. The window is narrow — the argv is fixed, so it takes a broken `ps` or a broken procfs — but it is the wrong direction to be wrong in.

## Decision

The coordinator does what the hooks and worker extensions already do: build one memoized own-ownership reader at module scope and thread it into everything that takes a mutex. It stops carrying its own `ps` spawn and uses the shared one.

Nothing about classification, `unlock`, `gate-clear`, or the delegation transport's identity contract changes. This only makes more markers classifiable, and removes a copy.

### Why the process's own identity

Unchanged from 1.1b, and it is the reasoning that makes this correct rather than merely more populated: the process holding the mutex is the coordinator, so the coordinator records **its own** `{pid, startedAt}`. Recording the launched worker's identity instead would make residue left by a dead coordinator classify `owner-alive` — the worker really is alive — and `unlock` would refuse it forever. Today that residue classifies `unprovable`: also refused, but honestly.

### Cost: one `ps` per session, not per event

The coordinator runs in-process for a whole Pi session. `createSubprocessOwnOwnershipReader` memoizes the settled result — including a `null` — so the reader spawns `ps` at most **once per Pi session**, on the first lock that session takes, not once per tool call, delegation, or launch. Constructing the reader at module scope costs nothing: it spawns nothing until called.

This is the same cost note `workflow-worker-lifecycle.ts:9-15` already records for its own module-scope reader, and it is a strictly better ratio than the subprocess hooks, which pay ~7 ms per invocation.

### Sharing the run store with `launchCommand`

The coordinator passes both `store` and `readOwnOwnership` into the launch deps, mirroring `bin/workflow.js:483-484`. Passing the reader alone would fix today's defect; passing the store as well means the reader cannot be lost again by a future change to `launchCommand`'s internal fallback, and it hands launch the store whose `onListProblem` is already wired to the coordinator's bounded `noteDiagnostic` — so a launch that trips over crash residue while listing reports it instead of dropping it.

### Sharing the `ps` spawn, not just its argv

`spawnPsStatus` becomes an export of `ownership.js` and `runPsForPid` is deleted; `inspectCoordinatorPid` passes the shared helper as `runProcess`. This closes the argv copy the roadmap names and the stderr divergence found above, and leaves one definition of how this repo asks the OS about a pid.

Two deliberate non-changes:

- `readCwd` stays the coordinator's `fs.readlink`. `createSubprocessOwnOwnershipReader` uses `realpath`, and swapping the coordinator to it would change the `cwd` string the transport compares against a recorded identity. Identity comparison is not what this item is fixing.
- `spawnPsStatus` stays in `ownership.js` rather than moving next to `psStatusArgv` in `process-observation.js`. That module is a pure parse module with no `node:child_process` dependency, and several tests rely on it staying cheap to import. The argv and the parse live together, which is what keeps write shape and read shape aligned; the spawn is one caller of both.

Behaviour differences from the deletion, both benign: the shared helper rejects when `ps` dies by signal (the copy resolved `{code: null}`, which `inspectExactProcessByPid` then rejected as ambiguous anyway — both paths end at the same caller-side `catch`), and it captures stderr, which is the fix.

### `cwdFallback`

`inspectCoordinatorPid` takes a `cwdFallback` and forwards it to `inspectExactProcessByPid`, which destructures it as `cwdFallback: _cwdFallback` and discards it (`process-observation.js:59`). It is dead at both call sites (`:439`, `:453`). It is removed — no behaviour change, and it stops advertising a fallback that does not exist.

## Goals

- Every mutex the coordinator extension takes — run lock and reservation gate — carries ownership evidence, so `workflow unlock` and `workflow delegation gate-clear` can recover it.
- A launch interrupted mid-flight leaves residue an operator can recover with one confirmed command.
- One definition of the `ps` invocation *and* of the spawn around it; no fourth copy.
- The read still never happens inside a mutex's critical section.
- A failure to read own identity still permits acquisition, exactly as today.

## Non-goals

- Changing classification rules, `unlock`, `gate-clear`, or `reconcile` output.
- Changing the delegation transport's identity contract, or what `observeExact` compares.
- Item 1.2's lifecycle unification, or any other coordinator behaviour.
- Making the coordinator report ownership to the operator.

## Architecture

```text
extension module load
  |
  | createSubprocessOwnOwnershipReader()   ← module scope, memoized, spawns nothing yet
  v
createWorkflowCoordinatorRuntime({ readOwnOwnership = defaultReadOwnOwnership })
  |
  +-- run store          (:501)  ← readOwnOwnership
  +-- reservation store  (:511)  ← readOwnOwnership
  +-- createLaunchCommand(:537)  ← store + readOwnOwnership  (mirrors bin/workflow.js)
  |
  | first mutex this session takes: reader runs `ps` once, BEFORE mkdir
  v
owner marker { version: 2, token, runId|projectAlias, pid, startedAt }
  |
  | coordinator crashes mid-launch, holding the run lock
  v
workflow unlock <run-id>  →  owner-gone  →  removable
```

`readOwnOwnership` joins the existing injectable seams on `createWorkflowCoordinatorRuntime`, defaulting to the module-scope reader, so tests never spawn a real `ps`.

`ownership.js` exports `spawnPsStatus` unchanged; the coordinator imports it and drops its own copy:

```js
async function inspectCoordinatorPid(pid) {
  return await inspectExactProcessByPid(pid, {
    runProcess: spawnPsStatus,
    readCwd: async (path) => await fs.readlink(path),
  });
}
```

## Error Handling

Unchanged from 1.1b, and load-bearing here because this reader sits on the path of an interactive coordinator session:

- Any failure reading own identity resolves `null`; the marker omits `pid`/`startedAt` and acquisition proceeds. Never empty strings.
- The reader never throws into the extension. Both `acquireLock` and `acquireGate` already wrap the call in `try/catch`, and the reader is total on top of that.
- The failure is memoized, so a host without a usable `ps` costs one attempt per session, not one per lock.
- Removing the coordinator's `ps` copy must not turn a `ps` failure into a delegation failure: the shared helper's rejection is caught by the same `catch` blocks that already degrade to `spawned-but-unverified` / `state: "unknown"`.

## Verification Strategy

1. `createWorkflowCoordinatorRuntime` constructs the run store with a `readOwnOwnership` function; the test fails when the argument is removed.
2. Same for the reservation store.
3. `createLaunchCommand` passes both `store` and `readOwnOwnership` into the launch deps; the test fails when either is removed.
4. The default reader is the module-scope one, and it is the **same** function object at all three sites — one reader per process, not three.
5. The reader is not invoked during runtime construction: building a coordinator runtime spawns no `ps`.
6. A reservation gate acquired through a store built the way the coordinator builds it, with the real subprocess reader, carries `pid`/`startedAt` at `0600`, and `classifyOwnership` returns a non-`unprovable` verdict for that marker.
7. **`acquireGate` reads before it acquires:** an injected reader records whether the active gate directory exists at the moment it runs, and asserts it does not — the reservation-gate twin of the run-lock ordering test at `test/workflow-hook-ownership.test.js:109`. This property is what wiring a real reader into the gate's only non-CLI caller makes worth pinning; the assertion itself is at store level, which is where it can be made to fail on regression rather than merely inspected.
8. `inspectCoordinatorPid` runs the shared `spawnPsStatus`: after this change `psStatusArgv` (`process-observation.js:13`) is the only place in the repo where the argv appears, proven by grep, not by inspection.
9. The transport's identity round-trip still holds against the real `ps`: a process inspected through `inspectCoordinatorPid` reports the `startedAt` the transport recorded for it.
10. `cwdFallback` removal changes nothing: the existing coordinator and transport tests pass untouched.
11. `npm test` green — baseline 888 tests, 887 pass, 1 pre-existing skip.

## Acceptance Criteria

- A run lock wedged by a coordinator killed mid-launch is recoverable with one confirmed `workflow unlock`, where today it is refused forever.
- A reservation gate wedged by a killed coordinator is recoverable with one confirmed `workflow delegation gate-clear`.
- No site hand-rolls the `ps` argv: `psStatusArgv` is its only definition, and the direct-spawn form around it is only `spawnPsStatus`. (`bin/workflow.js:513` stays as it is — it runs the same shared argv through the CLI's process runner, which is a different transport, not a second copy.)
- A coordinator whose host cannot report its own start time still launches and still delegates, at the cost of one `ps` attempt per session.
- The gate's read-before-mutex ordering is enforced by a failing-on-regression test, not by inspection.
