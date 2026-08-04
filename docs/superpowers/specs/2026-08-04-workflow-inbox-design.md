# `workflow inbox` Design

**Date:** 2026-08-04
**Status:** Proposed
**Roadmap item:** 2.2.

## Problem

A worker sitting at a permission prompt is invisible to the control plane.

Item 2.1 shipped `workflow runs`, which reads run records. But a worker waiting for the operator to approve a tool call has not written anything: its run record still says `running`, its last `updatedAt` is from whenever it last did work, and nothing distinguishes it from a worker that is busy thinking. The operator finds out by looking at panes.

### `workflow runs --state blocked` does not answer this

It looks like it should, and it does not. `RUN_STATES.BLOCKED` is written in exactly one place — `handoff.js:16`, mapping a worker's **self-reported** `blocked` status out of its handoff JSON. That is a worker that finished a turn and said "I am blocked on something". A worker *at a prompt right now* has written no handoff at all.

So the two are disjoint: `runs --state blocked` reports workers that told us they were stuck; `inbox` reports workers that are stuck waiting on us.

### Herdr does know, and this premise checked out

The roadmap claims "Herdr ya conoce el estado blocked por pane". Verified against the installed Herdr: `herdr agent wait --until` documents the vocabulary as **`idle, working, blocked, done, unknown`**, and `herdr agent list` returns `agent_status` per pane. `reconcile.js` already reads it (`agentStatus()`, `:186`), and notably its `STOPPED_AGENT_STATUSES` does not include `blocked` — so it already treats a blocked agent as a live writer, which is correct.

## Decision

`workflow inbox` asks Herdr for live agent status and reports the runs whose agent is `blocked`, aggregated across projects.

```
workflow inbox [project] [--format compact|json]
```

### It is anchored on runs, not on agents

The obvious implementation — list Herdr agents, filter to `blocked` — is wrong. `herdr agent list` on this machine returns every agent on the box, including interactive sessions that have nothing to do with the control plane. An inbox that reports those is noise, and worse, it reports work the operator did not launch through this tool and cannot act on with it.

So the command starts from `store.list()`, exactly as `runs` does, and looks up the live agent for each run it owns. A blocked agent with no run behind it is not this command's business.

### Correlation uses `transportIdentity.paneId`, and the reason is a bug this design found

The run record carries a top-level `paneId`, written "only when the launch created the selected agent". It would be the obvious correlation key. **It goes stale on resume.**

`executeResume` persists `{ transportIdentity: identity, resumeClaim: null }` (`resume.js:177`) and nothing else. `relaunchSession` returns an identity carrying the *new* pane (`commands.js:1584`), so `run.transportIdentity.paneId` is the live pane while the top-level `run.paneId` still names the dead one. Any resumed run correlated on the top-level field looks up a pane that no longer exists.

For most commands that is a latent nuisance. For an inbox it is the worst possible failure: it reports **nothing** for a resumed run, and "nothing" from an inbox means "nothing needs you". A silent false negative on the one command whose entire job is to not miss things.

So correlation reads `transportIdentity.paneId` first and falls back to the top-level `paneId` only when there is no transport identity. The stale top-level field is recorded as a known defect — it is not this item's to fix, but it is now written down.

### An agent it cannot resolve is reported, not dropped

If a run is non-terminal and the control plane cannot determine its agent status — no pane id, Herdr unreachable, the pane gone — the command says so rather than omitting the run. An inbox that quietly drops what it could not check is worse than one that admits uncertainty, for the same reason the false negative above matters.

Herdr being unavailable entirely is reported once, not once per run, and does not fail the command.

### It reuses the status vocabulary rather than restating it

`reconcile.js` already has `agentStatus()`, `paneId()` and the harness/status sets, module-private. This repo has collapsed six duplications in recent memory and is sensitive to a seventh, so those move to a shared module and both callers import them. `reconcile`'s behaviour must not change.

## Goals

- One command answers "which of my workers is waiting on me", across projects.
- A resumed run is not silently missed.
- A run whose status could not be determined is visible as such.
- No agent that is not a workflow run appears.
- One definition of Herdr's agent-status vocabulary.

## Non-goals

- Answering the prompt. This is read-only; acting on a blocked worker is `herdr agent send-keys` or attaching, and belongs to the operator.
- Watching or polling. One invocation, one snapshot.
- `events.jsonl`. The roadmap names it as a source, but the live pane state answers the question directly and the event log only records transitions the control plane already wrote. It would add a second, weaker source for the same fact.
- Fixing the stale top-level `paneId`. Recorded, not fixed here.
- Item 4.4's positive pane↔run correlation via `herdr pane report-agent` metadata. That would make this correlation exact rather than inferential; until then the transport identity is the best available key.

## Architecture

```text
workflow inbox ──> store.list()  ──> runs the control plane owns
                        │
                        ├─ drop terminal runs (nothing to wait on)
                        ├─ herdr.listAgents()  ← once, not per run
                        │        │
                        │        └─ index by pane id
                        ├─ correlate: transportIdentity.paneId ?? paneId
                        v
     ┌──────────────────┴──────────────────┐
  blocked                            unresolved
  (agent_status === "blocked")       (no pane id / no match / herdr down)
     └──────────────────┬──────────────────┘
                        v
        { command: "inbox", blocked, unresolved, herdrAvailable, exitCode: 0 }
```

`listAgents()` is called once and indexed, not per run — the board may hold dozens of runs and Herdr is a subprocess.

## Error Handling

- Herdr unreachable or `listAgents` throwing: `herdrAvailable: false`, every non-terminal run lands in `unresolved` with that reason, exit 0. The command reports what it could not determine rather than pretending the inbox is empty.
- A run with no pane id at all (a `start`-created run, which is never resumable and may never have had one) is `unresolved` with that reason — not an error.
- An unreadable run directory is skipped by `list()` and surfaced the same way `runs` surfaces it.
- Exit code is 0 in every case, including a non-empty inbox. It is a report; a blocked worker is information, not a failure.

## Verification Strategy

1. A run whose agent reports `blocked` appears in `blocked`.
2. A run whose agent reports `working` or `idle` does not.
3. **A resumed run correlates through `transportIdentity.paneId`, not the stale top-level `paneId`** — the test seeds a run whose two pane ids differ and asserts the live one wins. This is the property the design exists around.
4. A blocked agent with no corresponding run does not appear at all.
5. A non-terminal run with no resolvable agent appears in `unresolved` with a reason.
6. Herdr being unavailable puts every non-terminal run in `unresolved`, reports it once, and exits 0.
7. Terminal runs never appear, blocked or not.
8. `--project` narrows; no filter aggregates across projects.
9. `listAgents()` is called exactly once regardless of run count.
10. `reconcile`'s behaviour is unchanged after the vocabulary move — its existing tests pass untouched.
11. The shared vocabulary has one definition, proven by grep.
12. `npm test` and `npm run test:ci-like` green, zero skips.

## Acceptance Criteria

- An operator can see which workers are waiting on them without looking at panes.
- A resumed run is not silently missed — the failure mode this design was built around.
- What could not be determined is stated, never omitted.
- Herdr's agent-status vocabulary has one definition in this repo.
- The stale top-level `paneId` is recorded as a known defect with its evidence.
