# Provable Owner Recovery Design

**Date:** 2026-07-30
**Status:** Draft — awaiting approval
**Roadmap item:** 1.1 (review finding D7). Unblocks 2.5 (`workflow archive`).

## Problem

The no-cleanup recovery policy is applied consistently and correctly: crash residue is reported, never removed. What is missing is the blessed counterpart. Three mutexes fail closed with a message telling the operator that "manual inspection is required", and no command implements that inspection:

- **Run lock** (`src/workflow/run-store.js`): a lock held by a crashed process is classified stale after 5 minutes (`STALE_LOCK_MS`) but only reported. Every subsequent `update`, `appendEvent`, and `writeAssignment` for that run throws until the operator hand-removes a hidden `0700` directory whose owner-marker layout is documented nowhere outside the source.
- **Reservation project gate** (`src/workflow/delegation-reservations.js`): its owner marker is `{version, ownerToken}` with no liveness data at all, so a crash leaves a gate that cannot even be *classified* as stale. Every `reserve` and `release` for that project fails until the directory is removed by hand.
- **Successful runs** accumulate worktrees, Herdr tabs, and state directories forever, because success has no lifecycle end (item 2.5).

Staleness is currently inferred from elapsed time. Time is the wrong signal: a five-minute-old lock may belong to a live worker mid-turn, and a two-second-old lock may belong to a process that died instantly. The operator is asked to make that judgment with no evidence.

## Decision

Record **provable ownership** in each mutex marker, and remove a mutex only when its owner is *proven dead*. Elapsed time becomes a display detail, never the basis for removal.

The proof mechanism already exists in this repo and does not need to be invented. `inspectExactProcessByPid` (`src/workflow/process-observation.js`) returns `{pid, startedAt, cwd, active}` for a live process, or `null` **only on positive proof of absence** (`ps` exiting 1 with empty output, or `ENOENT`/`ESRCH` reading `/proc/<pid>/cwd`); anything ambiguous throws. The delegation transport already relies on it for pid-reuse-safe worker identity.

The `startedAt` value it returns *is* the boot-stable start token this item needs (oh-my-pi's `isolation-ownership.ts` derives the same signal from `/proc/<pid>/stat` field 22). Reusing it keeps one liveness primitive in the codebase instead of two.

## Goals

- Make the manual recovery the specs already promise a real, guided command.
- Never remove a mutex whose owner is live, ambiguous, or unverifiable.
- Survive pid reuse: a recycled pid must never be mistaken for the original owner.
- Preserve no-cleanup as the default: nothing is removed without an explicit, confirmed operator command, and every removal is reported.
- Leave the happy path untouched: acquisition and release must not get slower or newly fallible.

## Non-goals

- Automatic cleanup, release, or process kill on any lane. Unchanged.
- Removing a worktree, Herdr tab, or run state directory. That is item 2.5 (`workflow archive`), which this item unblocks.
- Time-based expiry of any mutex. Stale-by-age stays a *report*, never an action.
- Retrofitting ownership into already-existing markers on disk (see Compatibility).

## Architecture

```text
launch / lock acquisition / gate acquisition
  |
  | write owner marker { version, token, pid, startedAt, runId }
  v
crash
  |
  v
workflow unlock <run-id>            workflow delegation gate-clear <project>
  |                                   |
  | read marker                       | read marker
  | inspectExactProcessByPid(pid) ----+
  v
  ├─ live process, startedAt matches  -> refuse: owner is alive
  ├─ live process, startedAt differs  -> remove: pid was recycled, owner is gone
  ├─ proven missing (null)            -> remove (confirmed)
  └─ ambiguous / marker has no pid    -> refuse: cannot prove, report only
```

### Owner marker shape

Both markers gain the same three fields. The run lock marker (`<run-dir>/run.lock/active/owner-<token>.json`) becomes:

```json
{ "version": 2, "token": "<pid>-<counter>-<uuid>", "pid": "12345", "startedAt": "2026-07-30T10:00:00.000Z", "runId": "<uuid>" }
```

The reservation gate marker (`<project>/gate/active/owner.json`) becomes:

```json
{ "version": 2, "ownerToken": "<uuid>", "pid": "12345", "startedAt": "2026-07-30T10:00:00.000Z" }
```

`pid` is `String(process.pid)`. `startedAt` is this process's own start time, read once per process and cached, through the same `ps`/`/proc` path `inspectExactProcessByPid` uses — so the value written by the owner and the value observed by the recovering command are produced by one code path and are directly comparable.

`token`/`ownerToken` keep their current meaning and remain the authority for *release* by the owner. The new fields authorize *removal by someone else*, which is a strictly separate operation.

### Ownership classification

One shared classifier, so both commands and any future caller (2.5, reconcile) agree:

| Marker state | Observation | Verdict |
|---|---|---|
| has `pid` + `startedAt` | live, `startedAt` equal | `owner-alive` — refuse |
| has `pid` + `startedAt` | live, `startedAt` differs | `owner-gone` — pid recycled, removable |
| has `pid` + `startedAt` | proven missing (`null`) | `owner-gone` — removable |
| has `pid` + `startedAt` | inspection threw | `unprovable` — refuse |
| version 1 / no `pid` | not attempted | `unprovable` — refuse, explain why |
| unreadable / malformed | not attempted | `unprovable` — refuse |

Only `owner-gone` permits removal, and only under explicit confirmation.

### Commands

```bash
workflow unlock <run-id> [--format compact|json]        # read-only report
workflow unlock <run-id> --yes                          # remove a proven-dead lock
workflow delegation gate-clear <project> [--yes]         # same, for the reservation gate
```

Both are read-only without `--yes`: they report the marker, the observation, the verdict, and the exact next action. With `--yes` they remove the mutex directory **only** on an `owner-gone` verdict, and report precisely what was removed. Every other verdict exits non-zero with the reason. Neither command touches run state, worktrees, sessions, processes, or leases — removing a mutex only unblocks future writes.

`workflow reconcile` gains the same verdict in its output for a run whose lock is held, so the operator learns about a recoverable lock where they already look, without a new habit.

## Compatibility

Markers already on disk are version 1 and carry no `pid`. They classify as `unprovable` and are refused with an explicit reason ("this lock predates provable ownership; inspect and remove it manually"), which is exactly today's behavior plus an explanation. No migration, and no weakening: an unprovable marker is never removed by tooling.

Acquisition writes version 2 from this change forward. Readers accept both versions; `validateRunRecord`-style strictness is not extended to markers, because a marker that cannot be parsed must degrade to `unprovable` rather than break the lock path.

## Error Handling

- Reading this process's own `startedAt` failing must not break acquisition: the marker is written without `pid`/`startedAt` (degrading that lock to `unprovable`, i.e. today's behavior) rather than failing a launch or a lifecycle write.
- `inspectExactProcessByPid` throwing (ambiguous `ps`, permissions) yields `unprovable`; it never yields removable.
- A removal that partially fails (marker unlinked, directory not removed) reports exactly what was removed and what remains, and exits non-zero.
- A concurrent legitimate acquisition between classification and removal must not be clobbered: removal re-reads the marker under the same `dev`/`ino` identity check `releaseLock` already uses, and refuses if the marker changed.

## Verification Strategy

Unit tests must prove:

1. acquisition writes `pid`, `startedAt`, and `runId` into both markers, at `0600`, and the happy-path acquire/release cycle is unchanged;
2. a live owner is refused, with no removal attempted;
3. a **recycled pid** (live process, different `startedAt`) is classified `owner-gone` — the property a pid-only check would get wrong;
4. a proven-missing owner is classified `owner-gone` and removed only with `--yes`;
5. an ambiguous inspection and a version-1 marker are both refused as `unprovable`, with distinct reasons;
6. the read-only form performs no filesystem mutation (call-recording fs);
7. a marker that changes between classification and removal aborts the removal;
8. after a successful `unlock`, the previously wedged run accepts `update`/`appendEvent` again — the actual point of the command;
9. `reconcile` surfaces the verdict without mutating anything;
10. a failure to read this process's own start time still permits acquisition;
11. the full suite stays green.

## Acceptance Criteria

- A crashed run is recoverable with one confirmed command, and the command refuses whenever the owner might still be alive.
- A recycled pid never authorizes a removal.
- Nothing is removed without `--yes`, and every removal is reported.
- The no-cleanup policy is unchanged for worktrees, tabs, run directories, leases, and processes.
- `docs/superpowers/specs/2026-07-17-workflow-launcher-design.md`'s promise of manual inspection commands is satisfied for both mutexes.

## Follow-ups this unblocks

- **2.5 `workflow archive`**: the same classifier proves a run's worker dead before a confirmed teardown of its worktree and tab.
- **1.4**: the classifier is the first natural resident of a shared invariants module, alongside the reservation-resource and claim-token predicates that currently live in two places each.
