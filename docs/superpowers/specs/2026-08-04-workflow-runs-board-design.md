# `workflow runs` Board Design

**Date:** 2026-08-04
**Status:** Proposed
**Roadmap item:** 2.1, the first item of Fase 2.

## Problem

There is no way to ask the control plane what is going on.

Every read-only command it has takes a single run id or a single project+task: `result <run-id>`, `reconcile --run <run-id>`, `worker status <run-id>`, `status <project> <task>`. To answer "what is running right now", an operator has to already know the run ids — which means reading the state root by hand.

The roadmap names the three questions this should answer: **what is running, what needs input, and what completed without being merged.** None of them is answerable today.

`store.list()` already does the hard part — it walks the state root, skips crash residue with a bounded warning instead of throwing (item 0.3), and filters by project. Nothing exposes it.

## Decision

A read-only `workflow runs` command over `store.list()`, with a compact table for humans and full records for machines.

**Correction:** "full records for machines" did not hold up at board scale — see the correction paragraph under "The compact view drops the worktree" below for the measurement and the fix (a documented projection, not full records).

```
workflow runs [--project <alias>] [--state <state>] [--all] [--format compact|json]
```

### It shows live work by default

Runs accumulate forever — there is no cleanup, and `workflow archive` is item 2.5. There are 8 today and the number only grows. A board that lists everything becomes a log, and the questions it exists to answer are all about *now*.

So the default view is the states that are still actionable, and `completed` / `failed` / `interrupted` need `--all` or an explicit `--state`.

That does mean the third question — "what completed without being merged" — is one flag away rather than in the default view. That is the right trade **today**, and the reason is worth writing down: the control plane has no knowledge of merging at all, so it cannot distinguish "completed and merged" from "completed and forgotten". Every completed run looks identical to it. Item **2.4** (`workflow merge`) is what would make that distinction real, and that is the moment to revisit whether completed-but-unmerged belongs in the default view. Defaulting to hide it now is more honest than showing a column the control plane cannot fill.

`planned` counts as live: a run that never launched is either about to or is residue, and both want attention.

### The compact view drops the worktree, and the reason is not just width

The roadmap lists "worktree" as a column. **There is no worktree field.** Verified against a real record: the paths live inside `repositories[]` as `{id, path, branch}`, and a multi-repo project has one entry per repository — the Acme run I inspected carries three, all under one Herdr worktree root, sharing a branch name. So "the worktree" is not a value the record holds; it is either a shared parent directory that is nowhere stored, or N paths.

A table column cannot honestly render that. The compact view therefore carries short id, state, project, ticket, harness and a relative `updatedAt`; `--format json` carries the whole record including `repositories`, which is what a tool consuming this actually wants. An operator who needs the paths runs `workflow result <run-id>`.

**Correction (recorded after running this command against the developer's real 8 runs, item 2.1's own implementation task 3):** "`--format json` carries the whole record" is wrong, and was found wrong by measurement, not inspection. A run record is large — `stateHistory`, `telemetry`, `launchOperations`, `launchArgv`, `request`, digests, `delegations` — and runs accumulate forever (there is no cleanup until item 2.5). Against the real state root: `runs --all` (8 records) serialized to **53,791 characters** against `formatWorkflowResult`'s one shared `OUTPUT_LIMIT` (12,000 characters, `src/workflow/format.js`). Worse, `boundedJson`'s overflow fallback — designed for single-record commands — keeps only `{command, runId?, status?, truncated, truncationMarker}`; a `runs` result has neither `runId` nor `status`, so the fallback degraded to **zero run data**, not a truncated subset. The default (live-set) view fared little better: 2 records serialized to 11,895 characters, 105 bytes under the same limit — one more live run away from the identical failure.

"Machines get complete records" was the wrong call at board scale: a board is a summary, and every field of every run was never the right shape for "what is running". The fix is a **documented projection**, not a bigger budget or a pagination/limit flag: `valueForJson` (`src/workflow/format.js`) maps each run through `runProjection` before serializing, keeping exactly `id`, `directory`, `state`, `projectAlias`, `primaryTicket`, `harness`, `updatedAt`, and `repositories` — the two fields that make a run addressable (`id` for `workflow result <id>`; `directory`, which the compact table also never renders), the board's own five compact columns unabbreviated, and `repositories`, which is precisely the field this section's own reasoning says the table cannot honestly render and JSON exists to carry. Everything else — the ~44-field full record documented in `docs/run-record-fields.md` — stays out; `workflow result <run-id>` is the tool already sized for that.

Measured after the fix, against the same real state root: `runs --all` (8 records) → **7,593 characters** (63% of the 12,000-character budget); the default view (2 records) → **1,344 characters**. Both projections completed with zero truncation and full run data present. This is not unlimited headroom — each projected run costs roughly 600–950 characters depending on repository-list length and path depth, so a sustained run count in the high teens to twenties would revisit the same all-or-nothing collapse without item 2.5's cleanup (or a further, separate fix) — but it is a measured, substantial improvement over "zero run data at 8 records," and comfortable for the counts this board is used against today.

### Skipped records are named, not swallowed

Item 0.3 made `list()` skip an unreadable run directory and report it through `onListProblem` rather than poisoning the listing. The board is the first thing that will meet those in the wild, and the whole point of 0.3 was that they stay visible.

The compact view reports them under the table — a count and the ids. The JSON carries them as a separate field. Neither hides them, and neither lets one piece of crash residue empty the board.

### It sorts by most recently updated

`list()` sorts by `createdAt` ascending, which is right for a store primitive and wrong for a board: the thing that just changed is the thing you want on top. The command sorts its own output and **does not change `list()`**, whose order other callers may depend on.

### It always exits 0

It is a report, not a check. Skipped records are information, not failure. Nothing about a board's contents should break a script that runs it.

## Goals

- One command answers what is running and what needs input, across every project, without knowing any run id.
- Crash residue is visible and cannot empty the board.
- Machines get complete records; humans get a table that fits a terminal. **Correction:** not complete records — a documented projection; see the correction under "The compact view drops the worktree" above.
- `store.list()` is unchanged.

## Non-goals

- Any mutation. This is read-only; `--yes` and approval digests have no place here.
- Merge awareness — item 2.4 owns that, and until it exists "completed without merging" is not something the control plane can know.
- `workflow inbox` (item 2.2), which is a different question (blocked on permission prompts) with a different source (Herdr pane state and the event log).
- Watching or refreshing. One invocation, one snapshot.
- Changing `list()`'s filters, sort, or skip behaviour.

## Architecture

```text
workflow runs ──> runsCommand(options, deps)
                       │
                       ├─ store.list({ projectAlias? })   ← unchanged
                       │     └─ onListProblem ──> skipped[]
                       ├─ filter by state (default: live set; --state; --all)
                       ├─ sort by updatedAt, descending
                       v
                  { command: "runs", runs: [...], skipped: [...], exitCode: 0 }
                       │
      compact ─────────┴───────── json
   formatRuns(table + footer)   full records
```

**Correction:** the `json` branch does not emit full records — it emits `runProjection`'s documented projection of each run. See the correction under "The compact view drops the worktree" above.

The live set is every state except `completed`, `failed` and `interrupted`. It is defined in one place next to `RUN_STATES` so a new state has to be classified deliberately rather than defaulting into or out of the board.

`--state` is validated against the known states and refuses an unknown one with a usage error naming the valid values — the same courtesy every other argument in this CLI gets.

## Error Handling

- An absent or empty state root yields an empty board, not an error: `list()` already returns `[]` for a missing root, and a fresh machine has nothing to report.
- An unreadable run is skipped by `list()` and surfaced; it never fails the command.
- An unknown `--state` is a usage error (exit 64), consistent with the CLI's other argument validation.
- A state root that cannot be resolved at all is the existing `stateRootForCommand` failure, unchanged.

## Verification Strategy

1. Lists runs across multiple projects from one state root, with no project filter.
2. `--project` narrows to that project; a project with no runs yields an empty board, not an error.
3. The default view excludes `completed`, `failed` and `interrupted`, and includes `planned`, `running`, `needs-input`, `blocked`, `idle-awaiting-handoff`, `manual-handoff-required` and `result-stale`.
4. `--all` includes the excluded three.
5. `--state completed` shows exactly those, overriding the default — this is the path that answers the roadmap's third question.
6. An unknown `--state` is a usage error naming the valid states.
7. Runs are ordered by `updatedAt`, most recent first, and `list()`'s own order is untouched.
8. An unreadable run directory appears in the skipped list, is named in the compact footer and in the JSON, and does not prevent the readable runs from being listed.
9. The compact table stays within a sensible terminal width for realistic ids, tickets and project names, and carries no worktree path.
10. `--format json` carries the full records, including `repositories`. **Correction:** superseded — `--format json` carries `runProjection`'s documented projection, which does still include `repositories` (that part of the criterion holds); see the correction under "The compact view drops the worktree" above.
11. Exit code is 0 with runs, with no runs, and with skipped records.
12. `npm test` and `npm run test:ci-like` green, zero skips.

## Acceptance Criteria

- An operator with no run ids in hand can answer "what is running" and "what needs input" in one command, across all projects.
- Crash residue is named, and one piece of it cannot empty the board.
- "What completed without merging" is reachable with one flag, and the roadmap records why it is not the default until item 2.4 exists.
- `store.list()` is byte-for-byte unchanged.
