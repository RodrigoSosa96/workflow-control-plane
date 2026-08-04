# `workflow verify` Design

**Date:** 2026-08-04
**Status:** Proposed
**Roadmap item:** 2.3. Depends on 0.11, which wired `project.verify` from the registry into the assignment.

## Problem

`verification: passed` is something the worker says about itself.

A worker's handoff carries `verification: [{command, status, summary}]` (`handoff.js:272-285`), and nothing re-runs any of it. The control plane records the claim and presents it as fact. That is trust, not evidence — and the whole arc of this roadmap has been replacing self-report with proof: item 1.1 made owner death provable instead of assumed, 1.6 made hook wiring executed instead of inspected. This is the same move for the thing that actually decides whether work is done.

Two smaller gaps come with it. The verify commands are **not recorded on the run** — checked against a real record, there is no `verify`-shaped field anywhere — so nothing today can even say which commands the worker was supposed to run. And `workflow result`'s compact view does not render `verification` at all (`format.js` has no reference to it), so even the self-report is only visible in JSON.

## Decision

`workflow verify <run-id>` re-runs the project's verify commands inside the exact worktree the run recorded, and writes structured pass/fail evidence into the run's event log.

```
workflow verify <run-id> [--format compact|json]
```

### It runs through a real shell, and this is the one place that is true

`project.verify` entries are shell strings — `pnpm typecheck`, `pnpm ci:verify`. Every other spawn in this repo passes `shell: false`, deliberately: the approval digest means something precisely because a launch argv is auditable and shell-free.

This command runs them through `/bin/sh -c`, with a timeout and bounded capture. That is a documented, single-site departure, and the reasoning is that these strings are categorically different from a launch argv: **they are the operator's own, they already lived in the operator's own config, they come from no worker, and they enter no digest.** Splitting them on whitespace instead would keep the posture and silently mis-run the first command that ever contains `&&`, a pipe, quoting or an env prefix — failing in the one direction a verification tool must never fail.

### Once per repository, not once per run

`verify` is defined per project, but a project can be several repositories: Acme is three checkouts under one worktree root. Each command runs once per entry in `run.repositories[]`, with that entry's `path` as cwd, and the evidence records which repository it came from.

Running only the first would report `passed` with two repositories unexamined — precisely the false green this item exists to remove. Running at the shared worktree root would fail for a reason that has nothing to do with the code, since that root is not itself a checkout.

### The commands come from the current registry, and that is deliberate

They are not on the run record, so there is no snapshot to reproduce — but even if there were, the current registry is the right source, and it is worth saying why, because item 1.3 reached the opposite conclusion two items ago.

1.3 was about a **security envelope**: a resumed worker must run under the permissions that were approved, so re-resolving from a registry that may have changed is exactly the bug. Verification is the other way round. If the project has tightened its checks since the run launched, you want the tighter ones — verifying against a stale standard would certify work as passing checks the project no longer considers sufficient. Evidence should reflect today's bar.

A run whose project no longer exists in the registry, or which has no `verify` commands, is refused with that reason rather than silently reporting nothing to run.

### It is evidence, and it is labelled as such

The event carries the command, the repository, the exit status, a bounded head of the output, the duration, and when it ran. `workflow result` then shows **both** the worker's self-reported `verification` and the recorded evidence, labelled distinctly and never merged. The point is not to replace the claim — it is to let an operator see the claim and the proof side by side, including when they disagree. A design that overwrote the self-report would destroy the more interesting half of the signal.

### No confirmation gate

It runs read-only-in-intent commands the operator wrote in their own registry, for a project they own. It escalates nothing and takes no worker input. Like `status`, `result` and `reconcile`, it runs directly; the cost is time, and the timeout bounds that — including when the operator does not wait out the timeout: `verify-runner.js` traps SIGINT/SIGTERM for exactly as long as its own command is running and kills that command's whole process group before letting the CLI exit, so an interrupted `workflow verify` bounds the same way a timed-out one does, rather than leaving the check running unbounded in the background. (A branch re-review found this untrue for one release — the timeout fix that made a backgrounded grandchild killable, by giving the spawned shell its own process group, incidentally took it out of the CLI's own group too, so a terminal's Ctrl-C no longer reached it. Fixed by the trap described above; see the branch's fix report.)

## Goals

- "Verification passed" can be checked rather than believed.
- A multi-repository run is verified in every repository, not one.
- The evidence and the self-report are both visible, and distinguishable.
- A run that cannot be verified says why, rather than reporting an empty pass.

## Non-goals

- Changing what a worker reports, or the handoff schema.
- Gating anything on the result. `workflow merge` (2.4) is where evidence could become a precondition; this item only produces it.
- Recording the verify commands on the run record — the current registry is the intended source, per the reasoning above.
- Running anything not in `project.verify`. No inferred test commands, no fallbacks.
- Fixing that the compact `result` view never rendered `verification`; this item adds rendering for both, which incidentally closes it.

## Architecture

```text
workflow verify <run-id>
      │
      ├─ read run ──> projectAlias, repositories[]
      ├─ registry ──> project.verify[]          (refuse if absent/empty)
      ├─ for each repository × each command:
      │      /bin/sh -c "<command>"  cwd=<repository.path>
      │        └─ timeout, bounded stdout/stderr capture
      v
   appendEvent(runId, { type: "verification", … })   ← the evidence
      │
      v
  { command: "verify", results: [...], passed, exitCode }

workflow result ──> self-reported verification  ─┐
                    recorded evidence            ─┴─ shown separately, labelled
```

A repository whose path no longer exists is a refusal for that repository, recorded as such — not a silent skip and not a pass.

## Error Handling

- A run with no `repositories[]`, a project missing from the registry, or a project with no `verify` commands: refused with the specific reason. Nothing is appended to the event log for a run that was never verified.
- A repository path that no longer exists: recorded as an error result for that repository; the others still run.
- A command that times out: recorded as a failure with that reason, not as a pass, and the remaining commands still run.
- Output is bounded per command before it reaches the event log; the event log is append-only and shared with the watchers, so an unbounded test log must not land in it.
- The command's own exit code reflects whether every result passed. A verification failure is a legitimate outcome the operator asked about, so it is reported cleanly rather than as a crash.

## Verification Strategy

1. Each `project.verify` command runs once per repository, with that repository's path as cwd — asserted for a multi-repository run, which is the case a single-repo test cannot cover.
2. A passing command records a pass; a failing command records a failure with its exit status.
3. A shell construct that whitespace-splitting would break (`a && b`) runs correctly — the property the shell decision exists for.
4. Output is bounded before reaching the event log.
5. A timeout records a failure and does not abort the remaining commands.
6. A missing repository path records an error for that repository while the others still run.
7. A run with no repositories, an unknown project, or a project with no verify commands is refused with its specific reason, and appends nothing.
8. The evidence lands in the run's event log in a form `workflow result` can read back.
9. `workflow result` shows the self-reported verification and the recorded evidence separately and labelled, including when they disagree.
10. Exit code reflects pass/fail, and a verification failure is not reported as a crash.
11. `npm test` and `npm run test:ci-like` green, zero skips.

## Acceptance Criteria

- An operator can prove, rather than trust, that a run's checks pass.
- A three-repository run reports which repository failed.
- A verify command containing shell syntax runs as written.
- The claim and the proof are both on screen, and a disagreement between them is visible.
