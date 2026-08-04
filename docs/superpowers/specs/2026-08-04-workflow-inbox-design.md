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

**Correction (branch review, M9):** "only when there is no transport identity" overstates how narrow the fallback is. `correlationPaneId` (`commands.js`) reads `run.transportIdentity?.paneId ?? run.paneId ?? null` — that falls back to the top-level `paneId` whenever `transportIdentity.paneId` is nullish, which includes a `transportIdentity` object that exists but whose own `paneId` is itself absent, not only a wholly missing `transportIdentity`. The code is the safer behaviour (it still recovers a usable pane id in that extra case rather than reporting nothing), so this is a wording fix, not a code fix.

### An agent it cannot resolve is reported, not dropped

If a run is non-terminal and the control plane cannot determine its agent status — no pane id, Herdr unreachable, the pane gone — the command says so rather than omitting the run. An inbox that quietly drops what it could not check is worse than one that admits uncertainty, for the same reason the false negative above matters.

Herdr being unavailable entirely is reported once, not once per run, and does not fail the command.

**Correction (recorded after running this command against the developer's real state root, the implementation task's own verification step):** "the command says so" was too coarse. Run against the real state root, the command reported:

```
Unresolved: 2
  <run-id>  No live Herdr agent found for pane <pane>
  <run-id>  No live Herdr agent found for pane <pane>
```

Both runs were in state `manual-handoff-required`, verified against `herdr agent list`. The statement was factually true and told the operator the wrong thing. A run in `manual-handoff-required` or `needs-input` has, by definition, a worker that already exited and left the next move to the operator (`manual-handoff-required` is written at `lifecycle.js:77` precisely when the worker gives up; `needs-input` is a worker's own handoff saying the same, `handoff.js:17`). Its pane being gone is not a surprise the control plane failed to explain — it is that state doing exactly what it means. Reporting it identically to a `running` run's vanished pane collapsed two different facts into one diagnostic sentence: "an infrastructure problem with a pane" instead of "this run is waiting on you, go look at it."

The fix needed more than a reworded string in the renderer: the renderer had no way to tell the two cases apart, because the entry it receives never carried the run's own `state`. `inboxEntry` (`commands.js`) now includes `state`; a third bucket, `waiting`, holds any non-terminal run in `manual-handoff-required` or `needs-input` whose agent could not be confirmed live, regardless of which of the three causes (Herdr down / no pane recorded / no live match) produced that uncertainty. Its reason names the state and the one command that answers it — `Waiting on you (manual-handoff-required): run \`workflow result <run-id>\`` — and deliberately does not restate the vanished-pane detail, which was the misleading part. `unresolved` keeps its original meaning, narrowed to what it should always have meant: an *active* run (`running`, `launching`, `idle-awaiting-handoff`) whose agent could not be confirmed, which really is a diagnostic, because an active run's worker is supposed to still be there. See this doc's Architecture section below, and its Verification Strategy and Acceptance Criteria sections, for the corrected shape.

**Correction (branch review, findings C1/I3/I4):** two things above were still wrong, both definitional, not implementation slips.

First, "whose agent could not be confirmed live" as the condition for landing in `waiting` was itself the C1 bug's root cause, restated here as if it were correct: `waiting` was keyed on *uncertainty about the agent*, when what actually makes a run wait on a human is *its own state*. A `manual-handoff-required`/`needs-input` run whose agent resolves fine — alive, idle, in its pane, the ordinary shape right after a "manual" hook action lets the harness Stop proceed (`hooks/lib/lifecycle-hook-core.mjs:133-157`) — still needs the operator exactly as much as one whose agent could not be found. The implementation this correction describes silently dropped that run entirely (no bucket, `formatInbox`'s "Nothing waiting on you" printed over it). The fix: `waiting` holds any non-terminal run in `manual-handoff-required`, `needs-input`, or (added below) `blocked`, unconditionally on its own `state` — whether or not its agent resolved, and whatever its agent status is.

Second, `blocked` — the self-reported run state written from a worker's own handoff (`handoff.js:16`, distinct from the Herdr `agent_status` the `blocked` *bucket* is named for) — belongs in this same set. It is a worker that told us it is stuck, waiting on the operator as unambiguously as `manual-handoff-required` is, by this document's own Problem section. Before this correction it fell into `unresolved` with the misleading vanished-pane sentence whenever its agent had exited — exactly the failure this whole correction paragraph exists to prevent, just for a different state.

So `unresolved`'s corrected scope is: an *active* run (`running`, `launching`, `idle-awaiting-handoff`, and `result-stale` — see the Verification Strategy correction below for why `result-stale` stays here rather than moving to `waiting`) whose agent could not be confirmed. `waiting`'s corrected scope is: a run in `manual-handoff-required`, `needs-input`, or `blocked`, full stop — agent resolution is not part of the test. See `AWAITS_OPERATOR_STATES`'s own comment in `commands.js` for the shipped rule.

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

**Correction:** this diagram is stale — see the correction paragraph under "An agent it cannot resolve is reported, not dropped" above for what the real-data run found and why. The shipped shape is three buckets, not two:

```text
workflow inbox ──> store.list()  ──> runs the control plane owns
                        │
                        ├─ drop terminal runs (nothing to wait on)
                        ├─ herdr.listAgents()  ← once, not per run
                        │        │
                        │        └─ index by pane id
                        ├─ correlate: transportIdentity.paneId ?? paneId
                        v
     ┌──────────────────┼───────────────────────────┐
  blocked             waiting                   unresolved
  (agent_status ===   (state is manual-handoff-  (an ACTIVE run's --
   "blocked")          required/needs-input,      running/launching/
                        agent not confirmed        idle-awaiting-handoff --
                        live -- expected, the      agent not confirmed
                        worker already exited)     live -- unexpected)
     └──────────────────┼───────────────────────────┘
                        v
  { command: "inbox", blocked, waiting, unresolved, herdrAvailable, exitCode: 0 }
```

`blocked` and `waiting` are both "this needs you"; `unresolved` is still "the control plane does not know." What moved a run from the old `unresolved` into the new `waiting` is its own `state` — which the entry did not carry before this correction (`inboxEntry`, `commands.js`, now includes `state`) — not a new source of truth about the run.

**Correction (branch review, findings C1/I3/I4):** the `waiting` box's own label above is still wrong, in the same way the prose it was drawn from was wrong (see the correction under "An agent it cannot resolve is reported, not dropped" above). "agent not confirmed live" is not part of the test `waiting` actually applies — a run in `manual-handoff-required`, `needs-input`, or `blocked` (self-reported, added by I3) lands in `waiting` regardless of whether its agent resolved and regardless of what its agent status is. The arrows into `blocked`/`waiting`/`unresolved` are not mutually exclusive branches of "could the agent be confirmed" the way the box positions suggest; `waiting`'s test runs first and is decided entirely by `run.state`, before agent resolution is attempted at all. See `AWAITS_OPERATOR_STATES` and the loop in `inboxCommand` (`commands.js`) for the shipped control flow.

`listAgents()` is called once and indexed, not per run — the board may hold dozens of runs and Herdr is a subprocess.

## Error Handling

- Herdr unreachable or `listAgents` throwing: `herdrAvailable: false`, every non-terminal run lands in `unresolved` with that reason, exit 0. The command reports what it could not determine rather than pretending the inbox is empty. **Correction:** superseded for `manual-handoff-required`/`needs-input` runs — see the correction under "An agent it cannot resolve is reported, not dropped" above. Those land in `waiting`, not `unresolved`, even when the cause is Herdr being unreachable; the rest of this criterion (reported once, exit 0) holds for both buckets. **Correction (branch review, I3):** `blocked` (self-reported) joined `manual-handoff-required`/`needs-input` in this narrowing — see `AWAITS_OPERATOR_STATES` in `commands.js`.
- A run with no pane id at all (a `start`-created run, which is never resumable and may never have had one) is `unresolved` with that reason — not an error. **Correction:** same narrowing as above — a `manual-handoff-required`/`needs-input` run with no pane id lands in `waiting`; an active run with no pane id stays `unresolved`, and keeps its own distinct reason there (never conflated with "no live agent found for pane X"). **Correction (branch review, I3):** same addition of self-reported `blocked` as the line above.
- An unreadable run directory is skipped by `list()` and surfaced the same way `runs` surfaces it.
- Exit code is 0 in every case, including a non-empty inbox. It is a report; a blocked worker is information, not a failure.

## Verification Strategy

1. A run whose agent reports `blocked` appears in `blocked`.
2. A run whose agent reports `working` or `idle` does not.

   **Correction (branch review, C2 — added, not in the original list):** a run whose agent reports `unknown` (Herdr's own documented "could not determine" value), whose agent has no `agent_status` field at all, or whose agent reports a status outside `HERDR_AGENT_STATUSES` entirely (a value this command's vocabulary does not recognize, e.g. a future Herdr rename of `blocked`) appears in `unresolved` with a reason naming which of the three it was — not silently dropped. Before this branch review, the comparison in `commands.js` was a bare `agentStatus(agent) === "blocked"` literal that did nothing on any other outcome, and `HERDR_AGENT_STATUSES` (`agent-status.js`) — the vocabulary this item's own task created — had no production consumer at all, referenced only by its own test.
3. **A resumed run correlates through `transportIdentity.paneId`, not the stale top-level `paneId`** — the test seeds a run whose two pane ids differ and asserts the live one wins. This is the property the design exists around.
4. A blocked agent with no corresponding run does not appear at all.
5. A non-terminal run with no resolvable agent appears in `unresolved` with a reason. **Correction:** narrowed — this holds for a run in an *active* state (`running`, `launching`, `idle-awaiting-handoff`). A run in `manual-handoff-required` or `needs-input` with no resolvable agent instead appears in `waiting`, naming the state and `workflow result <run-id>`. See the correction under "An agent it cannot resolve is reported, not dropped" above.

   **Correction (branch review, C1 — said plainly):** the item-5 correction directly above is itself the incomplete rule that produced the C1 defect. It tests `waiting` only for "a run with no resolvable agent" — i.e. only inside the branches where agent resolution had already failed. It never states, and the shipped implementation before this branch review never checked, the case where resolution *succeeds*: a `manual-handoff-required`/`needs-input`/`blocked` run whose agent resolves alive (idle, working, or any status other than `agent_status: "blocked"`) fell through every branch and was dropped from all three lists, with no test here or in the test suite covering it. The corrected item 5: a non-terminal run whose own state is `manual-handoff-required`, `needs-input`, or `blocked` appears in `waiting` unconditionally, independent of agent resolution; a non-terminal run in any other live state (`running`, `launching`, `idle-awaiting-handoff`, `result-stale`) appears in `unresolved` if and only if its agent could not be resolved to a recognized non-`blocked`, non-`unknown` status.
6. Herdr being unavailable puts every non-terminal run in `unresolved`, reports it once, and exits 0. **Correction:** narrowed the same way as item 5 — an active run lands in `unresolved`; a `manual-handoff-required`/`needs-input` run lands in `waiting` even when Herdr itself is the reason nothing could be confirmed.
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

**Correction (recorded after running this command against the developer's real state root, and adding the `waiting` bucket it found missing — see the correction under "An agent it cannot resolve is reported, not dropped" above):** "what could not be determined is stated, never omitted" was true but insufficient — the real-data run showed that *how* it is stated matters as much as *whether* it is stated. A true diagnostic sentence ("No live Herdr agent found for pane X") told the operator the wrong thing when the run's own state already meant the absence was expected, not a fault. The corrected criterion: what could not be determined is stated, AND a run whose own state already means it needs the operator (`manual-handoff-required`, `needs-input`) is presented as waiting on them — with the one command that answers it, `workflow result <run-id>` — not as an infrastructure diagnostic about a vanished pane.
