# Provable Owner Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manual mutex recovery the launcher specs promise into two guided commands that remove a run lock or a reservation project gate only when its owner is *proven dead*, replacing elapsed time as the basis for removal.

**Architecture:** One new module (`src/workflow/ownership.js`) owns two things: reading this process's own start time (cached, through the same `ps` path the existing observer uses) and classifying an owner marker plus a process observation into a verdict. Both mutexes write `{pid, startedAt}` into their existing markers at version 2; both new commands read the marker, observe the pid through the existing `inspectExactProcessByPid`, and act only on an `owner-gone` verdict under explicit confirmation. Nothing else about the no-cleanup policy changes.

**Design source:** `docs/superpowers/specs/2026-07-30-provable-owner-recovery-design.md` (Approved).

**Tech Stack:** Node.js ESM, zero runtime dependencies, Node test runner (`node --test`), existing `process-observation.js` / `run-store.js` / `delegation-reservations.js` / `commands.js` / `bin/workflow.js` seams.

## Global Constraints

- **Removal requires proof of death.** Only the `owner-gone` verdict may remove a mutex. `owner-alive` and `unprovable` always refuse. Elapsed time is reported, never acted on.
- **Pid reuse must not authorize removal.** A live process whose `startedAt` differs from the marker's proves the *original* owner is gone; a live process whose `startedAt` matches proves it is alive. Both cases must be distinguished explicitly, never collapsed to "is the pid alive".
- **Ambiguity fails closed.** If `inspectExactProcessByPid` throws, or the marker is unreadable, malformed, or has no `pid`, the verdict is `unprovable` and nothing is removed.
- **No behavior change on the happy path.** Acquisition and release must not become slower or newly fallible. If reading this process's own start time fails, acquisition still succeeds with a marker lacking `pid`/`startedAt` (degrading that mutex to today's `unprovable` behavior).
- **Read-only by default.** Without `--yes` both commands mutate nothing — no marker write, no directory removal, no run-state write. Prove it with a call-recording fs in tests, not by inspection.
- **Scope.** Removing a mutex directory only unblocks future writes. Never touch run state, worktrees, Herdr tabs/panes, sessions, processes, or reservation leases.
- **Backward compatibility.** Version 1 markers already on disk must still be readable and must classify as `unprovable` with a reason that says so. No migration, no rewriting existing markers.
- Zero new dependencies. Existing injection seams (`fs`, `clock`, `runner`, `randomUUID`) stay injectable; new code follows the same pattern.
- Every task ends with its covering tests passing and the full suite green (`npm test`).

## File Structure

- Create: `src/workflow/ownership.js` — own-start-time reader and the marker/observation classifier.
- Create: `test/workflow-ownership.test.js` — unit tests for both.
- Modify: `src/workflow/run-store.js` — write version-2 lock owner markers; expose a lock-inspection read and a proven-dead removal.
- Modify: `src/workflow/delegation-reservations.js` — write version-2 gate owner markers; expose gate inspection and proven-dead clear.
- Modify: `src/workflow/commands.js` — `unlockCommand`, `delegationGateClearCommand`, and the reconcile lock verdict.
- Modify: `bin/workflow.js` — parse/dispatch both commands, HELP entries, live process-inspection wiring.
- Modify: `test/workflow-run-store.test.js`, `test/workflow-delegation-reservations.test.js`, `test/workflow-commands.test.js`, `test/workflow-cli.test.js`, `test/workflow-reconcile.test.js` — behavior tests per task.
- Modify: `README.md` — document both commands under recovery.

---

### Task 1: Ownership module — own start time and the verdict classifier

**Files:**
- Create: `src/workflow/ownership.js`
- Test: `test/workflow-ownership.test.js`

**Interfaces:**

Consumes `inspectExactProcessByPid` from `./process-observation.js` (signature: `(pid, { runProcess, readCwd }) => Promise<{pid, startedAt, cwd, active} | null>`; returns `null` only on positive proof of absence, throws on ambiguity).

Produces exactly these exports:

```js
// Marker fields both mutexes embed. Returns { pid, startedAt } or null when the
// process's own start time cannot be read (acquisition must still proceed).
export async function readOwnProcessOwnership({ inspectProcess, pid = String(process.pid) } = {})

// Memoizing wrapper. A lock is taken on nearly every write, so the live path must
// run `ps` once per process, not once per acquisition. Memoize the settled result
// (including null) and never re-invoke inspectProcess. This is the ONLY place
// memoization lives — the stores must not each keep their own cache.
export function createOwnOwnershipReader({ inspectProcess, pid = String(process.pid) } = {})

// Pure. marker is the parsed owner-marker object (any version); observation is
// the inspectExactProcessByPid result, `null` for proven-missing, or the symbol
// OBSERVATION_FAILED when inspection threw.
export const OBSERVATION_FAILED = Symbol("observation-failed");
export function classifyOwnership(marker, observation)
```

`classifyOwnership` returns a frozen object:

```js
{ verdict: "owner-alive" | "owner-gone" | "unprovable", reason: "<bounded sentence>", pid: "<string>|null", startedAt: "<iso>|null", removable: boolean }
```

`removable` is `true` if and only if `verdict === "owner-gone"`.

**Verdict table (implement exactly):**

| marker | observation | verdict | reason mentions |
|---|---|---|---|
| has `pid` and `startedAt` | object, `startedAt` equals marker's | `owner-alive` | that the owner process is still running |
| has `pid` and `startedAt` | object, `startedAt` differs | `owner-gone` | that the pid was recycled |
| has `pid` and `startedAt` | `null` | `owner-gone` | that the process is proven gone |
| has `pid` and `startedAt` | `OBSERVATION_FAILED` | `unprovable` | that liveness could not be verified |
| missing `pid` or `startedAt` (e.g. version 1) | anything | `unprovable` | that the marker predates provable ownership |
| not an object / null | anything | `unprovable` | that the marker is unreadable |

`readOwnProcessOwnership` calls `inspectProcess(pid)`; on a returned object it yields `{ pid, startedAt }`; on `null` or a throw it yields `null` (never throws).

**Steps:**
- [ ] Write `test/workflow-ownership.test.js` covering every row of the verdict table, plus: `removable` is true only for `owner-gone`; reasons are bounded (≤200 chars) single-line strings; the returned object is frozen; `readOwnProcessOwnership` returns `{pid, startedAt}` on success and `null` on both `null` and a throwing inspector, and never throws; `createOwnOwnershipReader` invokes `inspectProcess` exactly once across many calls, including when the first call returned `null` or threw, and returns the same value each time.
- [ ] Implement `src/workflow/ownership.js` to satisfy them.
- [ ] Run `node --test test/workflow-ownership.test.js`, then `npm test`.
- [ ] Commit.

---

### Task 2: Version-2 run lock owner markers

**Files:**
- Modify: `src/workflow/run-store.js`
- Test: `test/workflow-run-store.test.js`

**Interfaces:**

`createRunStore` gains one optional injected dependency, defaulting so nothing breaks:

```js
createRunStore({ stateRoot, fs, clock, randomUUID, onListProblem, sleep, readOwnOwnership = async () => null })
```

The lock owner marker written during `acquireLock` becomes:

```js
{ version: 2, token, runId: "<the run id being locked>", ...(ownership ? { pid: ownership.pid, startedAt: ownership.startedAt } : {}) }
```

`readOwnOwnership()` is awaited during acquisition and a throw from it is swallowed as `null`. The store does **not** memoize: `createOwnOwnershipReader` (Task 1) already guarantees one `ps` per process, and a second cache here would be the same logic in two places.

Add one export used by Task 4 — it must not acquire the lock it inspects:

```js
// Returns null when no active lock exists. Never mutates.
store.inspectLock(runId) => Promise<null | { activePath, markerPath, marker, ageMs, stale }>
// Removes the active lock ONLY when allowed by a caller-supplied predicate that
// receives the marker. Re-verifies dev/ino identity and the marker's byte
// content between check and removal; refuses if either changed.
store.removeLock(runId, { allow }) => Promise<{ removed: true, markerPath, activePath } | { removed: false, reason }>
```

`removeLock` reuses the existing `dev`/`ino` verification that `releaseLock` performs, and refuses with a reason rather than throwing when the marker changed, is absent, or `allow(marker)` returns false.

**Steps:**
- [ ] Add tests to `test/workflow-run-store.test.js`: an acquired lock's marker is version 2 and carries `pid`, `startedAt`, `runId` at mode `0600`; a `readOwnOwnership` that throws still permits acquisition and yields a marker without `pid`/`startedAt`; `inspectLock` returns `null` with no lock and the marker plus `stale` flag with one, mutating nothing; `removeLock` removes only when `allow` returns true, refuses (with a reason, no throw) when the marker changed between inspection and removal, and after a successful removal the run accepts `update`/`appendEvent` again.
- [ ] Implement in `src/workflow/run-store.js`.
- [ ] Run `node --test test/workflow-run-store.test.js`, then `npm test`.
- [ ] Commit.

---

### Task 3: Version-2 reservation gate owner markers

**Files:**
- Modify: `src/workflow/delegation-reservations.js`
- Test: `test/workflow-delegation-reservations.test.js`

**Interfaces:**

`createDelegationReservationStore` gains the same optional dependency with the same default and the same no-local-cache rule as Task 2:

```js
createDelegationReservationStore({ stateRoot, fs, clock, randomUUID, canonicalPath, sleep, readOwnOwnership = async () => null })
```

The gate marker written by `acquireGate` becomes:

```js
{ version: 2, ownerToken, ...(ownership ? { pid: ownership.pid, startedAt: ownership.startedAt } : {}) }
```

`releaseGate` currently requires `marker.version === 1`; it must accept version 1 **and** 2 while still comparing `ownerToken`. Add two exports mirroring Task 2, neither of which may acquire the gate they inspect:

```js
reservations.inspectGate({ projectAlias }) => Promise<null | { activeGate, markerPath, marker }>
reservations.clearGate({ projectAlias, allow }) => Promise<{ cleared: true, activeGate } | { cleared: false, reason }>
```

`clearGate` re-reads the marker immediately before removal and refuses if it changed.

**Steps:**
- [ ] Add tests to `test/workflow-delegation-reservations.test.js`: a gate marker written during a reserve is version 2 with `pid`/`startedAt`; `releaseGate` still succeeds (reserve/release round-trips) with a version-2 marker; a store whose `readOwnOwnership` throws still reserves, writing a marker without `pid`/`startedAt`; `inspectGate` returns `null` for an untouched project and the marker while a gate is held, mutating nothing; `clearGate` clears only when `allow` returns true, refuses with a reason when the marker changed, and after clearing a wedged gate `reserve` works again.
- [ ] Implement in `src/workflow/delegation-reservations.js`.
- [ ] Run `node --test test/workflow-delegation-reservations.test.js`, then `npm test`.
- [ ] Commit.

---

### Task 4: `workflow unlock <run-id>`

**Files:**
- Modify: `src/workflow/commands.js`
- Modify: `bin/workflow.js`
- Test: `test/workflow-commands.test.js`, `test/workflow-cli.test.js`

**Interfaces:**

```js
export async function unlockCommand(options = {}, deps = {}) // options: { runId, confirmed, registryPath, ... }
```

Uses `deps.store.inspectLock`, `deps.inspectProcess` (same shape `bin/workflow.js` already builds for delegations: `(pid) => Promise<observation|null>`, throwing on ambiguity), `classifyOwnership`, and `deps.store.removeLock`.

Returns:

```js
{
  command: "unlock",
  runId,
  lock: null | { ageMs, stale, markerVersion },
  ownership: { verdict, reason, pid, startedAt, removable },
  action: "no-lock" | "needs-confirmation" | "removed" | "refused",
  removed: null | { markerPath, activePath },
  cleanup: "none",
  nextActions: [...],
  exitCode: 0 | 11,
}
```

Rules: no active lock → `action: "no-lock"`, exit 0. Verdict not removable → `action: "refused"`, exit **11** (the repo's conflict code), nothing removed, regardless of `confirmed`. Removable without `confirmed` → `action: "needs-confirmation"`, exit 0, nothing removed. Removable with `confirmed` → call `removeLock` with `allow` re-checking the same verdict on the re-read marker; on `{removed: false}` report `action: "refused"` with the reason and exit 11.

Wrap `deps.inspectProcess` so a throw becomes `OBSERVATION_FAILED` rather than propagating — an ambiguous observation is a verdict, not a command failure.

CLI: `workflow unlock <run-id> [--format compact|json] [--yes]`, one positional (path-safe UUID syntax check, mirroring `resume`), `yes` the only allowed option, plus a HELP line.

**Steps:**
- [ ] Add tests to `test/workflow-commands.test.js` with fakes: no-lock; alive owner refused with exit 11 even with `confirmed: true`; unprovable (version-1 marker) refused with its distinct reason; recycled pid → removable; proven-missing → `needs-confirmation` without `confirmed` and `removed` with it; a `removeLock` returning `{removed: false}` surfaces as refused/11; the unconfirmed path records zero mutating store calls.
- [ ] Add a CLI test to `test/workflow-cli.test.js`: argument shape (missing/extra positional, rejected unknown option, bad UUID) and that `--yes` reaches the command as `confirmed: true`.
- [ ] Implement `unlockCommand` and the CLI wiring.
- [ ] Run the two test files, then `npm test`.
- [ ] Commit.

---

### Task 5: `workflow delegation gate-clear <project>`

**Files:**
- Modify: `src/workflow/commands.js`
- Modify: `bin/workflow.js`
- Test: `test/workflow-delegation-commands.test.js`, `test/workflow-cli.test.js`

**Interfaces:**

```js
export async function delegationGateClearCommand(options = {}, deps = {}) // options: { projectAlias, confirmed, registryPath, ... }
```

Same verdict flow and the same exit codes as Task 4, over `reservations.inspectGate` / `reservations.clearGate`. **Extract, do not restate:** Task 4's flow (wrap the inspector so a throw becomes `OBSERVATION_FAILED`, classify, map verdict + `confirmed` to an action and an exit code) must be factored into one internal helper in `commands.js` that both commands call, parameterized by the inspect/remove pair and the no-X action label. Two hand-written copies of the same predicate is exactly review finding D17, which this roadmap phase exists to stop repeating. Returns the analogous shape with `command: "delegation-gate-clear"`, `projectAlias`, `gate: null | { markerVersion }`, `action: "no-gate" | "needs-confirmation" | "cleared" | "refused"`, `cleanup: "none"`.

Resolve the project through the registry so an unknown alias fails as a preflight error before any filesystem access. Do **not** reuse `loadDelegationContext` — it requires a run id and a delegation id, and this command has neither.

CLI: `workflow delegation gate-clear <project> [--format compact|json] [--yes]` — one positional, `yes` the only allowed option, plus a HELP line.

**Steps:**
- [ ] Add tests to `test/workflow-delegation-commands.test.js` with fakes: no gate; alive owner refused with exit 11; unprovable refused; proven-missing gated on confirmation then cleared; unknown project alias is a preflight failure that touches no filesystem; the unconfirmed path performs no mutation.
- [ ] Add the CLI argument-shape test to `test/workflow-cli.test.js`.
- [ ] Implement the command and the CLI wiring.
- [ ] Run the two test files, then `npm test`.
- [ ] Commit.

---

### Task 6: Surface the verdict in reconcile, and document both commands

**Files:**
- Modify: `src/workflow/commands.js`
- Modify: `README.md`
- Test: `test/workflow-reconcile.test.js` or `test/workflow-commands.test.js` (whichever already covers `reconcileCommand`)

**Interfaces:**

`reconcileCommand`'s result gains, only when the run's lock is currently held:

```js
lock: { ageMs, stale, ownership: { verdict, reason, pid, startedAt, removable } }
```

and, when `removable` is true, `"workflow unlock <run-id> --yes"` is appended to its existing `nextActions`. When no lock is held the field is absent and `nextActions` is unchanged. `reconcile` stays strictly read-only: reuse `inspectLock` plus the wrapped inspector, never `removeLock`.

If the run store injected into `reconcileCommand` predates `inspectLock` (no such method), skip the field silently rather than failing — reconcile must never break because of a diagnostic.

**Steps:**
- [ ] Add tests: a run with a held lock whose owner is proven gone reports the verdict and suggests `workflow unlock`; a run with a live owner reports the verdict and does **not** suggest unlock; a run with no lock has no `lock` field and unchanged `nextActions`; reconcile performs no mutation; a store without `inspectLock` still reconciles.
- [ ] Implement.
- [ ] Document both commands in `README.md` under the launcher recovery material: what they prove before removing, that they never touch worktrees/tabs/state/leases, that version-1 markers are refused as unprovable, and the exit codes.
- [ ] Run the covering test file, then `npm test`.
- [ ] Commit.

---

## Verification

Per the spec's Verification Strategy, the finished branch must demonstrate:

1. both markers carry `pid`/`startedAt`/(`runId`) at version 2, mode `0600`, happy path unchanged;
2. a live owner is refused with no removal attempted;
3. a recycled pid classifies as `owner-gone` — the case a pid-only check gets wrong;
4. a proven-missing owner is removed only with `--yes`;
5. ambiguous inspection and version-1 markers are both refused as `unprovable`, with distinct reasons;
6. the read-only forms perform no filesystem mutation;
7. a marker that changes between classification and removal aborts the removal;
8. a previously wedged run accepts writes again after `unlock`, and a wedged project reserves again after `gate-clear`;
9. reconcile surfaces the verdict without mutating;
10. failure to read this process's own start time still permits acquisition;
11. `npm test` green.
