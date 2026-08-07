# `workflow archive` Design

**Date:** 2026-08-07
**Status:** Proposed
**Roadmap item:** 2.5. Depends on 1.1 (provable owner recovery). Follows 2.4 (`workflow merge`).

## Problem

Nothing ever gets cleaned up, on purpose, and the bill has come due.

The launcher's no-cleanup policy is a real invariant with a real justification: a failed or partial
launch preserves its worktree, its Herdr tab, and its run directory so an operator can inspect
what happened. Today that policy has exactly one documented exception — `workflow unlock` and
`workflow delegation gate-clear`, each removing one piece of crash residue, only against a mutex
owner **proven dead**.

The cost is measurable on this machine right now: **8 worktree directories across 4 workspaces**,
plus two `prunable` worktree registrations git still carries for directories that no longer
exist. `workflow runs --format json` is already measured to collapse at 12–14 runs, and item 2.1
recorded that there is no cleanup until this one.

## Decision

```
workflow archive <run-id> --dry-run [--format compact|json]
workflow archive <run-id> --yes --approval-digest <digest> [--format compact|json]
```

`--dry-run` previews exactly what would be removed and — more importantly — **what would be lost**.
Execution requires the digest that preview printed.

### It removes the worktrees and the tab. It preserves the state directory, the branch, and every commit.

- **Removed:** each `run.repositories[]` worktree, via `git worktree remove` **without `--force`**,
  and the Herdr tab.
- **Preserved:** the run directory (`run.json`, `events.jsonl`, `assignment.md`, results) — the
  roadmap requires this, and it is what keeps `workflow result` answerable forever. The **branch**
  and all its commits survive untouched: `git worktree remove` never deletes a ref, so archiving
  can orphan a directory but never a commit.

### Three things measured against the real machine, each of which changed the design

**1. The recorded `tabId` is not a fact — every one on this machine is already stale.**

All eight real runs record a `tabId` (`w2M:t1`, `w2J:t1`, `w2T:t1`, …). Herdr is running right now
with exactly three workspaces: `wD`, `w1V`, `w2W`. **Not one recorded workspace prefix still
exists.** The Herdr server has been restarted since those runs launched, and tabs did not survive
it.

So the roadmap's framing — "removes worktree and tab" — weights the two equally, and measurement
says they are not equal. **The worktree is the durable residue; the tab is usually already gone.**
Tab closure is therefore best-effort and idempotent: `herdr tab close` on a missing tab returns
`{"error":{"code":"tab_not_found"}}` **with exit code 0**, which the adapter's `parseJsonResult`
already turns into a `WorkflowError` carrying that code. `tab_not_found` means *already archived*,
not *failed*, and it must never block worktree removal.

`workspaceId` is not recorded at all. It is derivable from the tab id's prefix, but that is an
undocumented format assumption buying nothing given the ids are stale — so this command closes the
tab it recorded and does not attempt to close a workspace.

**2. Worktree creation is split across two mechanisms, so removal cannot assume one.**

An **ordinary** (monorepo) run's worktree is created by Herdr (`herdr worktree create`, via
`herdr.ensureNativeWorktree`, `execute.js:379`). A **group** run gets its meta worktree the same
way, but each **child** worktree comes from `git.createWorktree` — `git worktree add -b` —
(`execute.js:986`, inside `executeGroupStart`).

Item 2.4's close-out cited that second call site, and it was correct but partial in a way that
matters here: it reads as though `git worktree add` were the creation path, when it is the
group-child creation path only. Recorded here rather than left to be re-derived.

Removal uses `git worktree remove` for every entry in `run.repositories[]`, which is what that
array actually contains — the per-repository checkouts — for both project shapes.

**3. `git worktree remove` refuses a dirty worktree, and 3 of 8 real worktrees are dirty.**

Measured, git 2.43: a clean worktree removes (exit 0); a worktree with modified **or untracked**
files refuses (exit 128, `contains modified or untracked files, use --force to delete it`); a
worktree whose directory has already vanished removes cleanly, deregistering it; a path that was
never a worktree exits 128.

**This command never passes `--force`.** Uncommitted work is the one thing in a worktree that
exists nowhere else, and an archive command that destroys it silently is worse than no archive
command. A dirty worktree is a refusal naming the files.

### Unmerged work is the real risk, and 7 of 8 real worktrees have it

Measured against the real base checkouts: **seven of the eight worktrees hold commits not in their
`base_branch`.** Only one is fully merged.

`git worktree remove` does not delete the branch, so those commits survive — nothing is destroyed.
But "archive" means done, and removing the directory that made the work visible, while its branch
quietly holds unmerged commits, is how work gets forgotten rather than lost. So the preview
reports, per repository, **how many commits are not in `base_branch`**, and that count enters the
digest.

It is surfaced and digested; it does **not** refuse. This is the same shape 2.4 settled for verify
evidence, for the same reason: a hard gate would need a `--force` the moment an operator has a
legitimate reason to archive an unmerged run (abandoned work, an experiment, a run superseded by a
relaunch), and an escape hatch on the destructive step is a governance hole with a flag on it.
Approving an archive means approving it *with these commits unmerged*.

The honest asymmetry, stated plainly: **uncommitted changes refuse; unmerged commits only warn.**
That is deliberate, and the line is recoverability — uncommitted work has no other copy, unmerged
commits are still on a branch in the repository.

### "Terminal" is a policy decision, and it reuses the one this repo already made

Item 2.1 established that **no run state is terminal in the state machine**: `completed`, `failed`
and `interrupted` all transition back to `running` via resume (`run-state.js`'s `ALLOWED`). So
"only terminal runs" cannot be read off the state machine.

Rather than invent a second classification, this command archives exactly the complement of
`LIVE_RUN_STATES` — `completed`, `failed`, `interrupted` — the set 2.1 already defined and
documented as a presentation decision requiring a new state to be classified deliberately. A run in
any live state is refused, naming its state.

### The owner must be proven gone, never inferred from elapsed time

This is what 2.5 depends on 1.1 for. Two independent liveness questions, both answered before
anything is removed:

- **The run lock.** If it is held, `classifyMarkerOwnership` (`commands.js:2793`) decides via
  `inspectExactProcessByPid`, which returns `null` *only* on positive proof of absence and throws
  on ambiguity. A lock whose owner is alive, or whose ownership is `unprovable`, refuses. Archive
  does **not** remove the lock — that stays `workflow unlock`'s job, and the refusal names it.
- **The agent.** A run whose agent still resolves live in Herdr is refused. `workflow inbox`
  established the correlation to reuse (`transportIdentity.paneId` first, falling back to the
  top-level `paneId`, because `executeResume` leaves the latter stale — the defect recorded under
  2.2 and closed properly only by item 4.4).

Ambiguity refuses in both cases. This is item 0.14's rule applied to the most destructive command
in the CLI.

### It is digest-gated, and that differs from `unlock` on purpose

`unlock` and `delegation gate-clear` — the existing no-cleanup exceptions — take only `--yes`.
This one takes a digest, and the difference is the risk class, not the family:

**`unlock` removes proven-dead evidence.** A marker whose owner is provably gone has no value;
removing it destroys nothing. **`archive` removes a working tree** that may hold the only copy of
uncommitted work, and whose dirty and unmerged status can change between preview and approval. The
digest binds what would be removed *and what would be lost* — the resolved worktree paths, each
one's dirty status and file count, each one's unmerged-commit count, the branch, the run state, and
the tab id. Anything material moves, the approval goes stale.

That also makes 2.4 and 2.5 symmetric: the two halves of finishing a run, both preview → digest →
execute.

### It marks the run archived, which is what relieves 2.1's measured ceiling

Execution stamps the run record and appends an `archive` event. This is the point of preserving the
state directory rather than deleting it, and it is what lets `workflow runs` exclude archived runs
— the relief item 2.1 explicitly named when it recorded that `--format json` collapses at 12–14
runs with no cleanup available.

## Goals

- An operator can reclaim worktrees without hand-deleting directories the control plane created.
- Nothing that exists only inside a worktree is ever destroyed without an explicit, digest-bound
  approval that named it.
- A run that is still live, still locked by a living owner, or still driving an agent cannot be
  archived at all.
- The run's evidence outlives its worktree.

## Non-goals

- Deleting run directories, branches, commits, or anything under the project's base checkout.
- Removing the run lock (that is `workflow unlock`) or a reservation gate (`delegation gate-clear`).
- `--force`, in any form.
- Bulk or automatic archiving. One run, named explicitly, per invocation. No lane archives anything
  on its own — the no-cleanup policy still holds everywhere except this command and the two mutex
  recoveries.
- Closing the Herdr workspace, or pruning `prunable` registrations belonging to other runs.

## Architecture

```text
workflow archive <run-id> --dry-run
      │
      ├─ read run ───────> state, repositories[], tabId, transportIdentity
      ├─ state check ────> not in LIVE_RUN_STATES, else refuse naming the state
      ├─ lock check ─────> inspectLock + classifyMarkerOwnership (1.1)
      │                     owner alive or unprovable ⇒ refuse, naming `workflow unlock`
      ├─ agent check ────> herdr.listAgents() correlated by transportIdentity.paneId
      │                     agent resolves live ⇒ refuse
      │
      ├─ per repository, read-only:
      │     git -C <worktree> status --porcelain=v1 -z     → dirty? which files?
      │     git -C <worktree> rev-parse --abbrev-ref HEAD  → branch
      │     git -C <base>     rev-list --count <base_branch>..<branch>  → unmerged commits
      v
   preview { repositories[], removable, losses[], approvalDigest }
      │
      │   ── operator reads what would be lost, passes the digest back ──
      v
workflow archive <run-id> --yes --approval-digest <digest>
      │
      ├─ recompute the preview; digest mismatch ⇒ stale ⇒ refuse
      ├─ per repository: git worktree remove <path>        ← never --force
      ├─ herdr tab close <tabId>                           ← best-effort; tab_not_found = already gone
      ├─ store.update: mark archived
      v
   appendEvent(runId, { type: "archive", … })
      │
      v
   { command: "archive", removed[], kept[], exitCode }
```

## Error Handling

- Every refusal carries its own reason and removes nothing, exactly as `verifyRefusal` and
  `mergeRefusal` established. A refusal must never be a partial archive.
- A dirty worktree refuses **for that repository and for the whole run** — a group project is
  archived whole or not at all, because a half-archived group leaves the operator with residue that
  is harder to reason about than the original.
- A worktree whose directory has already vanished is **not** an error: `git worktree remove`
  deregisters it cleanly, which is exactly the residue this command exists to reclaim.
- A repository path that is missing, `null`, `""`, a bare string entry, or an empty object refuses —
  the five shapes item 2.3's C1 finding enumerated.
- `herdr tab close` failing for any reason other than `tab_not_found` is recorded on the response,
  never thrown, and never rolls back a completed worktree removal. Removal is not undoable; the
  report must be honest about a partially-completed archive rather than pretend atomicity.
- `store.update`/`appendEvent` failing after removals have run degrades to an error field on the
  response, never a throw — item 2.3's I4 finding, and it matters more here for the same reason it
  mattered more in 2.4: the removals cannot be undone by re-running.
- Output is bounded against the shared 12,000-character limit, and the JSON projection is
  **measured** against a realistic three-repository archive, not estimated. Items 2.1, 2.3 and 2.4
  each shipped a collapse that only measurement caught.

## Verification Strategy

1. A clean, fully merged, single-repository run in `completed` previews one removal and archives it;
   the worktree is gone, the branch and its commits still exist, and the run directory is intact.
2. **A dirty worktree refuses, naming the files, and removes nothing** — including nothing from the
   other repositories of the same run. This is the safety core; it needs a test that fails against
   an implementation that passes `--force`.
3. Unmerged commits are counted, surfaced, and digested — and do **not** refuse. A test asserts an
   unmerged run is still archivable, and that its count is in the digest.
4. A run in each live state refuses, naming the state.
5. A run whose lock is held by a living owner refuses and names `workflow unlock`; an `unprovable`
   ownership verdict also refuses. Elapsed time alone never authorizes anything.
6. A run whose agent still resolves live in Herdr refuses.
7. A vanished worktree directory archives cleanly rather than erroring.
8. `tab_not_found` is treated as already-archived; any other Herdr failure is reported without
   rolling back or throwing. **This is the measured-real case: every real run's tab id is stale.**
9. The digest changes when any of dirty status, unmerged count, worktree path, branch, run state, or
   tab id changes; a stale digest is refused; `--yes` without a digest is a usage error.
10. A three-repository group run archives all three, and a failure partway is reported as partial
    with what was removed and what was kept.
11. The run record is marked archived and an `archive` event is appended; a persistence failure
    degrades rather than discarding the report of removals that really happened.
12. `npm run test:ci-like` green, zero skips.

## Acceptance Criteria

- An operator can reclaim the 8 worktrees on this machine without `rm -rf`, and cannot do it to the
  3 that are dirty without first dealing with the changes.
- The preview says what would be **lost**, not just what would be removed.
- Archiving a run never destroys a commit.
- A run still being worked on cannot be archived by any combination of flags.

## An honest note about what this does not reclaim

Archiving removes the worktrees this run recorded. It does not prune `prunable` registrations left
by *other* runs — this machine has two — and it does not touch the shared worktree root directory
that remains after its children are gone. Both are residue this command could plausibly own; both
are deliberately out of scope, because pruning registrations the current run does not own is how a
cleanup command starts deleting things nobody asked it to.
