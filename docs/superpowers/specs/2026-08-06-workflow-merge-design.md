# `workflow merge` Design

**Date:** 2026-08-06
**Status:** Proposed
**Roadmap item:** 2.4. Follows 2.3 (`workflow verify`), which produces evidence and gates nothing.

## Problem

The arc ends without governance.

`workflow launch` puts an approved envelope around starting a worker: a dry-run preview, an
approval digest, an exact shell-free argv. `workflow verify` (2.3) made "the checks pass"
provable rather than believed. And then the operator opens a terminal, `cd`s into a base
checkout, and types `git merge` by hand — the one step that actually changes what the project
*is*, performed entirely outside everything the previous eighteen items built.

Nothing today previews that merge, predicts its conflicts, records that it happened, or ties
approval to what was actually about to be merged.

## Two inherited premises, corrected before anything was designed on them

This item's brief carried two claims that did not survive being checked. Both are recorded here
because both would have shaped the design wrongly, and this roadmap has a standing lesson about
exactly that (see `ROADMAP.md`, "Verificá toda premisa heredada contra el código").

**"`src/workflow/git.js` is entirely read-only" — false.** `createWorktree` (`git.js:250-274`)
runs `git worktree add path branch` or `git worktree add -b branch path base`, and it is reached
from production at `execute.js:986`, inside `executeStart`. The second form **creates a branch**.
So the control plane has been writing to real operator repositories since the launch lane
existed.

**"2.4 is the first thing in the arc that mutates the git state of real operator repositories" —
false as stated, true in the sense that matters.** The honest version is about *what kind* of
write: `git worktree add` is purely additive and isolated — a new directory, a new ref, nothing
existing is touched, and any other checkout of that repository is unaffected. `git merge` into
`base_branch` **advances a shared branch that the operator's own checkout is sitting on**, and
that is a categorically different act. The distinction, not the false absolute, is what justifies
putting a digest in front of it.

## Decision

```
workflow merge <run-id> --dry-run [--format compact|json]
workflow merge <run-id> --yes --approval-digest <digest> [--format compact|json]
```

`--dry-run` previews an exact, shell-free `git merge` argv per repository the run recorded,
together with the conflicts that merge would produce, computed without touching any working
tree, index, or ref. Execution requires `--yes` **and** the digest that preview printed, exactly
as `launch` does.

### It merges. It does not rebase. (Open decision 1, resolved)

The brief left "merge, rebase, or both" open. **Merge only**, for three reasons in descending
order of weight:

1. **Only merge can honor the item's own contract.** The roadmap asks for a preview of
   "conflictos". `git merge-tree --write-tree` (git ≥ 2.38; measured against git 2.43 here)
   performs the *real* merge machinery — three-way content merge, rename detection,
   directory/file conflicts, recursive ancestor consolidation — and reports the exact conflicted
   paths **without reading or writing the working tree or the index**. There is no equivalent for
   rebase: predicting a rebase means replaying every commit, which requires real state — a scratch
   worktree and a real `git rebase` you then abort. A preview that cannot actually predict is not
   a preview, and this is the one place where the difference is not academic.
2. **Rebase rewrites the run's own artifact.** The item requires the worktree preserved
   post-merge. A rebase rewrites the feature branch's history in place — the branch that run
   worktree is checked out on, and that may already be pushed. Preserving the directory while
   rewriting the history it points at preserves the wrong half.
3. **Merge mutates less.** One new commit and one ref advanced, versus N commits rewritten plus
   a moved branch.

A future `--rebase` is not forbidden by anything here; it is simply not designable to the same
standard today, and shipping it at a lower standard than the merge path would make the
governance uneven in the one command whose entire purpose is governance.

### It runs in the base checkout, not the run worktree (Open decision 1, part two)

The goal is to advance `base_branch`. `base_branch` is checked out in the **base checkout** — the
project's own `path`, or `repositories.<id>.path` for a group project. The run's worktree is
checked out on the feature branch; merging *into* it would advance the feature branch and leave
`base_branch` exactly where it was, which is not the ask. Git also forbids checking out a branch
that is already checked out in another worktree, so "switch the run worktree to `dev`" is not
available even in principle.

Measured against the real registry and the real repositories on this machine: all three
`sharyco` base checkouts are on `dev`, which is their configured `base_branch`. That is the
happy case, and the preview asserts it rather than assuming it.

### Verify evidence enters the digest. It does not gate. (Open decision 2, resolved)

The 2.3 spec deferred this explicitly: "produce evidencia y no gatea nada. El ítem 2.4 es donde
la evidencia podría convertirse en una precondición."

Both horns of the brief's dilemma are real. Gating makes the evidence matter; not gating keeps
the command usable for a project with no `verify` commands configured. **Neither is the design.**
A hard gate needs an escape hatch (`--force`) the moment a project has no verify commands or an
operator has a legitimate reason to integrate a red branch — and an escape hatch on the one
governed step is a governance hole with a flag on it.

Instead: **the latest verification evidence is read into the preview and folded into the approval
digest payload.** The preview names it — present or absent, passed or failed, when it ran, and
whether the source branch has moved since it ran. Approving a merge therefore means approving the
merge *of these commits, with this verification status*. Rerun `workflow verify`, or push another
commit, and the digest changes; the previous approval is refused as stale by the machinery that
already exists.

This makes evidence load-bearing without inventing a policy field the registry does not have, and
without adding a flag whose only purpose is to be bypassed. **The honest limit, stated plainly:**
an operator who has never run `workflow verify` gets `verification: none` in their preview and in
their digest, and can approve that. The control plane surfaces; the operator decides. What it
will not do is let the operator approve one thing and merge another.

The run's own `state` is treated identically — surfaced, digested, never gated. Real data is why:
of the eight runs on this machine, five are `completed`, one `failed`, two
`manual-handoff-required`. A worker that stopped for a human is not thereby carrying unmergeable
work.

### The source branch is read from the worktree, never trusted from the record

This is the finding that most changed the design, and it came from real data rather than from any
test.

Run `0b2612a8` (a real, `completed`, three-repository `sharyco` run) records
`repositories[].branch` as `feature/1216110941098331/registro-impl`. **That ref does not exist.**
The worktree at the recorded path is on `feature/registro-impl`, at a commit `dev` does not yet
contain. Two of the eight real runs record branches that are gone or renamed.

So `repositories[].branch` is a **launch-time intention**, not a fact about where the work is.
A merge driven from it would fail on a nonexistent ref in the best case and integrate a stale
branch in the worst. The source is therefore resolved from the worktree itself — its current
`HEAD` branch and commit sha — and the recorded branch is compared against it. A mismatch is
**named prominently in the preview and included in the digest**, not silently substituted and not
treated as a blocking conflict: blocking it would make this command unusable against every real
completed multi-repository run that exists today, and the record's disagreement with the worktree
is information the operator should approve knowingly rather than a reason to refuse.

The digest binds the resolved **commit shas** — source and base — not just branch names. Anything
that moves between preview and execution changes the digest.

### What makes a preview refuse

The preview classifies each repository, and **any conflict blocks execution for the whole run**:

- **The base checkout is dirty, or its status cannot be read.** Merging into a dirty tree either
  aborts halfway or commits while leaving unrelated modifications entangled with the merge. This
  is item 0.14's lesson applied to a heavier operation: unknown status is a conflict, never
  clean. Measured: two of the three real `sharyco` base checkouts are dirty right now, so this
  precondition bites immediately and correctly.
- **The base checkout is not on `base_branch`.** `git merge` merges into whatever is checked out.
- **A predicted merge conflict**, from `merge-tree`.
- **`merge-tree` itself failing** — a git too old to have `--write-tree`, an unreadable object
  store. Fail closed: "conflicts unknown" is a refusal, never "no conflicts".
- The run worktree is gone, its `HEAD` is unresolvable, or the resolved commit is not reachable
  from the base checkout's object store.
- The project, or the repository entry, is absent from the current registry, or has no
  `base_branch`.

Conflicts are computed for **every** repository before anything executes — `merge-tree` mutates
nothing, so a complete prediction is free. That is what makes a half-merged group project
unlikely.

### It is not atomic across repositories, and it says so

A group project is several independent git repositories; there is no cross-repository
transaction, and pretending otherwise would be the false green this roadmap keeps removing.
Execution runs repository by repository, **stops at the first failure**, and reports exactly which
repositories merged and which were never attempted. A real merge can still fail where
`merge-tree` predicted success — a `pre-merge-commit` hook, a read-only filesystem — so the
report is written to be honest about partial completion rather than to avoid admitting it.

### Everything else it deliberately does not do

- **No push.** Publishing to a remote is an outward-facing act with its own approval question.
  The roadmap does not ask for it, and local integration is a complete unit of work.
- **No cleanup.** The worktree, its branch, and the Herdr tab all survive untouched — this
  command never so much as writes in the run worktree. Item **2.5** owns removal.
- **No `--force`, no `--continue`, no conflict resolution.** A predicted conflict is reported and
  refused; resolving it is the operator's work in their own checkout.
- **No new registry field.** `base_branch` already exists per project (`registry.js:278`) and per
  repository (`registry.js:294`). No merge-strategy field is invented.

### `shell: false` holds

The merge argv goes through `createProcessRunner` (`process.js`, `shell: false`) like every other
git invocation in this repo, and lives in `git.js` beside them so the whole git surface stays in
one auditable module. `verify-runner.js` remains the single documented shell departure; this item
adds nothing to it. That is not incidental — **the argv is what the digest approves**, so it has
to be exactly what runs, with no shell between the two.

`GIT_TERMINAL_PROMPT=0` is set so a credential prompt cannot hang a non-interactive merge, and the
merge is bounded by a timeout. `--no-edit` keeps git from opening an editor there is no terminal
for.

### `--no-ff`, always

The merge argv is `git merge --no-ff --no-edit <source-branch>`, deterministically, even when a
fast-forward is available (it is, for the real `registro-impl` run — `dev` is an ancestor).

A fast-forward leaves no record that this control plane integrated anything; the merge commit is
the audit trail, and it makes the integration revertible as one unit. It also makes the preview
exact: with fast-forward allowed, the shape of the outcome depends on ancestry at execution time,
and the whole point of the digest is that the operator approved this outcome and no other.

## Goals

- The last ungoverned step of the arc gets the same preview → digest → execute treatment as the
  first one.
- An operator sees the exact argv and the exact conflicts before anything runs.
- Approval is bound to the commits, the checkout state, and the verification status that were
  true at preview time.
- A partially completed group merge is reported as partial.

## Non-goals

- Rebase, push, cleanup, conflict resolution, merge queues (item **4.3** names a merge queue as
  its own work, to be designed alongside fan-out).
- Gating on verification evidence or on run state.
- Changing what `workflow verify` records, or the handoff schema.

## Architecture

```text
workflow merge <run-id> --dry-run
      │
      ├─ read run ─────────> projectAlias, repositories[] (id, path, recorded branch)
      ├─ registry ─────────> base checkout path + base_branch per repository
      ├─ run event log ────> latest `verification` evidence   (surfaced, digested, never gated)
      │
      ├─ per repository, all of it read-only:
      │     git -C <worktree>  rev-parse --abbrev-ref HEAD     → actual source branch
      │     git -C <worktree>  rev-parse HEAD                  → actual source sha
      │     git -C <base>      rev-parse --abbrev-ref HEAD     → is it on base_branch?
      │     git -C <base>      status --porcelain=v1 -z        → is it clean?  (unknown ⇒ conflict)
      │     git -C <base>      rev-parse --verify <sha>^{commit}
      │     git -C <base>      merge-tree --write-tree --name-only -z <base_branch> <sha>
      │                          exit 0 ⇒ clean · exit 1 ⇒ conflicted paths · else ⇒ unknown
      v
   preview { repositories[], conflicts[], verification, approvalDigest }
      │
      │   ── operator reads it, passes the digest back ──
      v
workflow merge <run-id> --yes --approval-digest <digest>
      │
      ├─ recompute the preview; digest mismatch ⇒ stale ⇒ refuse   (launch.js's own pattern)
      ├─ per repository, sequentially, stopping at the first failure:
      │     git -C <base> merge --no-ff --no-edit <source-branch>   ← shell:false, the approved argv
      v
   appendEvent(runId, { type: "merge", … })      ← evidence; a failure to persist degrades, never discards
      │
      v
   { command: "merge", merged[], skipped[], passed, exitCode }
```

## Error Handling

- Every refusal carries its own reason and appends nothing — a merge that never happened must
  leave no evidence, exactly as `verifyRefusal` established for 2.3.
- `--yes` without `--approval-digest` is a usage error, mirroring `launch`.
- A stale digest is refused with the fresh one named, mirroring `staleApprovalDigest`.
- `merge-tree` exiting above 1, or failing to run at all, is "conflicts unknown" — a refusal, in
  the fail-closed direction 0.14's `safeStatus` established.
- A real merge failing mid-run leaves the repositories that already merged merged. The report
  names them, names the one that failed with git's own stderr, and names the ones never
  attempted. The exit code is nonzero.
- `appendEvent` failing after the merges have run is recorded as `evidenceError` on the response,
  never thrown — item 2.3's I4 finding, and it matters more here: the merges are not undoable by
  re-running the command.
- Output is bounded before it reaches the event log and before it reaches the operator, against
  the same shared 12,000-character limit. The JSON projection is **measured** against a realistic
  multi-repository preview, not estimated — items 2.1 and 2.3 both shipped a collapse that only
  measurement caught.

## Verification Strategy

1. A clean, fast-forwardable, single-repository run previews one exact argv and no conflicts.
2. A real merge conflict is predicted by the preview, named per file, and blocks execution —
   without the working tree, index, or any ref having been touched (asserted, not assumed).
3. A dirty base checkout is a conflict; a base checkout whose `git status` cannot be read is also
   a conflict, never clean.
4. A base checkout not on `base_branch` is a conflict.
5. **The source branch comes from the worktree, not the record**: a run whose recorded branch no
   longer exists still previews correctly against the worktree's actual branch, and the mismatch
   is named in the preview and changes the digest. This is the real-data finding; it needs a test
   that fails against a record-driven implementation.
6. A three-repository run previews and merges all three, in order, and a failure in the second is
   attributed to it with the third reported as never attempted.
7. The digest changes when the source sha, the base sha, the base checkout's cleanliness, the
   checked-out branch, or the verification evidence changes. Each of these gets its own assertion.
8. Executing with a stale digest is refused; executing with no digest is a usage error.
9. Verification evidence appears in the preview whether present, absent, failing, or older than
   the source commit — and gates nothing in any of those cases.
10. The merge argv is shell-free and is byte-identical between the preview and what is executed.
11. The run worktree is untouched after a successful merge: same branch, same HEAD, same status.
12. Evidence lands in the run's event log; a persistence failure degrades to `evidenceError`
    without discarding the report of merges that really happened.
13. Exit codes: `0` merged, nonzero for failure, `10` for a refusal.
14. JSON output for a realistic three-repository preview is measured against the 12,000-character
    limit rather than assumed to fit.
15. `npm test` and `npm run test:ci-like` green, zero skips.

## Acceptance Criteria

- An operator can see the exact `git merge` argv, and the exact files that would conflict, before
  anything is mutated.
- Approving a merge and then having anything material change means the approval is refused.
- A group project's partial merge is reported as partial, never as success.
- The run's worktree, branch, and evidence survive the merge intact.
- A run whose recorded branch is stale — the common case in real data — merges the work that
  actually exists, and says that is what it is doing.

## An honest note about "dry-run"

`git merge-tree --write-tree` writes loose objects into the repository's object database. It
touches no ref, no index, and no working tree, and the objects are unreferenced and collectible
by the ordinary `git gc`. Calling it a dry-run is accurate about everything an operator can
observe, and it is not accurate about literally zero bytes written. Said here rather than
discovered later.
