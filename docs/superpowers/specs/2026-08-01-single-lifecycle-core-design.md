# Single Lifecycle Core Design

**Date:** 2026-08-01
**Status:** Proposed
**Roadmap item:** 1.2. Closes review finding D5.

## Problem

The worker lifecycle protocol — when a prompt starts a new generation, when a stop should force a continuation, when a session end interrupts a run — is implemented twice.

- `hooks/lib/lifecycle-hook-core.mjs` drives Claude and Codex. It is a stateless subprocess invoked once per event, so it persists its discriminators on the run record (`${harness}StartedOnce`, `${harness}PendingContinuation`) and reads them back each time.
- `.pi/extensions/workflow-worker-lifecycle.ts` drives Pi. It runs in-process for a whole session, so it holds the same discriminators as `let` variables in a closure (`startedOnce`, `pendingContinuation`).

`continuationPrompt` is byte-identical in both (`workflow-worker-lifecycle.ts:6-8`, `lifecycle-hook-core.mjs:69-71`). `handoffExists` is duplicated too — and has already drifted: the core compares `run.state === RUN_STATES.COMPLETED`, the Pi copy compares `run.state === "completed"`, a bare string literal (`workflow-worker-lifecycle.ts:104`). Change what that constant holds and Pi silently stops recognising handoffs, forcing every Pi worker into continuation loops until its stop budget runs out. Nothing would fail.

### The divergence is observable, and neither behaviour was designed

`resume` touches neither `generation`, nor `stopAttempts`, nor the markers — verified by reading `src/workflow/resume.js` and `relaunchSession`. So what happens after a relaunch is an accident of *where each implementation keeps its state*:

- **Pi** is a fresh process, so `startedOnce` is `false` again. Its first `agent_start` after a resume takes the first-prompt branch and **reuses** the current generation.
- **Claude/Codex** read `${harness}StartedOnce` from the run record, which survived the relaunch. Their first `UserPromptSubmit` after a resume falls through to the follow-up branch and passes `current.generation + 1`, which `lifecycle.onPrompt` accepts as a follow-up — so the generation **increments**.

The generation is the key that validates handoffs (`handoff.js:507` refuses a handoff whose generation is not current) and staleness of stops (`lifecycle.js:onStop` no-ops when `generation !== current.generation`). The same operator action produces different arithmetic depending on which harness is running.

There is a second consequence that decides which behaviour is right. `lifecycle.onPrompt` resets `stopAttempts` to 0 **only** on a follow-up (`lifecycle.js:38-42`), and nothing else in the system resets it. So under Pi's semantics, resuming a worker that already exhausted its two stop attempts sends it straight back to `manual-handoff-required` on its first stop — the resume accomplishes nothing, in exactly the situation resume exists for.

`handoffCommand` reads the generation from the run record rather than from `WORKFLOW_GENERATION` (`commands.js:1086`), so there is no stale-env mismatch forcing either answer. This is a semantic choice, and it has been made by accident twice.

## Decision

Three changes.

1. **One core owns the protocol.** `.pi/extensions/workflow-worker-lifecycle.ts` becomes a thin adapter over `hooks/lib/lifecycle-hook-core.mjs`, using the persisted markers instead of in-memory flags. `continuationPrompt` and `handoffExists` keep exactly one definition each.
2. **The core returns a decision; each harness renders it.** Today `runLifecycleHook` returns Claude's wire format directly — `JSON.stringify({decision: "block", reason})`. Pi cannot use that: it continues a turn by calling `pi.sendUserMessage`, not by printing JSON to stdout. So the core returns a structured result and each harness's thin file renders it in its own protocol.
3. **`resume` says what it does.** A confirmed relaunch explicitly opens a new generation with a fresh stop budget and cleared markers, instead of the effect emerging from whether a marker happened to survive a process restart.

### Why the core returns a decision instead of a string

The current return contract is the one thing that makes the core Claude-shaped rather than harness-neutral. `claude-lifecycle.mjs` and `codex-lifecycle.mjs` both do `if (typeof output === "string" && output.length > 0) process.stdout.write(output)` — they are pass-throughs for a decision the core already encoded for them.

Keeping that would force the Pi adapter to parse a JSON string the core just built, to recover a prompt the core already had. The core would still "own" the conditions, but the *protocol* would leak into a module that has no business knowing Claude's wire format.

So `runLifecycleHook` returns `{ continuation: { prompt } }` when the stop decision is to continue, and `undefined` otherwise. The Claude and Codex hook files render that to `JSON.stringify({decision: "block", reason: prompt})` and write it to stdout; the Pi adapter renders it to `pi.sendUserMessage(prompt, {deliverAs: "followUp", triggerTurn: true})`. One module decides; three thin files speak their own protocol.

### Why increment, and why `resume` should own it

Incrementing is what makes resume work: it is the only path that resets the stop budget, so a resumed worker gets a fresh pair of attempts rather than being declared unrecoverable on its first stop. Pi's reuse semantics make resume a no-op for the runs most likely to need it.

But adopting the increment *by inheriting a marker* would leave the behaviour exactly as accidental as it is today — it would just be consistently accidental. So `executeResume` performs it explicitly, on the confirmed relaunch path, under the lock it already takes:

```text
generation:            current.generation + 1
previousGeneration:    current.generation
stopAttempts:          0
<harness>StartedOnce:        false
<harness>PendingContinuation: false
```

Clearing the markers matters as much as the bump. With them cleared, the first prompt after a relaunch takes the first-prompt branch in **every** harness and confirms the generation the resume already opened, rather than bumping it a second time. The behaviour stops depending on whether the process restarted.

### It must happen before the worker's env is built

`relaunchSession` computes the pane's env with `runEnv(run, harness)`, which stamps `WORKFLOW_GENERATION` from the run record. So the update has to land **before** `relaunch()` is called, or the resumed pane runs with the old generation in its env while the record says otherwise.

`executeResume` already has exactly the right place: the claim update it performs under the run lock before relaunching, which also validates that the transport identity has not moved and refuses a concurrent resume. The generation bump joins it.

That update's existing failure path must extend to cover the new fields: when `relaunch()` throws, `executeResume` already clears `resumeClaim`; it must now also restore the generation, the stop budget and the markers, or a failed relaunch leaves the record claiming a generation whose worker never started.

## Goals

- One module owns `continuationPrompt`, `handoffExists`, generation discrimination, and the stop/notify conditions.
- All three harnesses produce identical generation arithmetic for identical operator actions.
- What a resume does to the generation is stated in one place, not emergent from process restarts.
- No harness-specific wire format lives in the shared core.
- A resumed worker gets a usable stop budget.

## Non-goals

- Changing the state machine in `src/workflow/lifecycle.js` or `run-state.js`.
- Changing what any hook is wired into, or any generated hook configuration (item 1.6 owns that, and its ingestion tests must keep passing untouched).
- Changing telemetry phases or the notifier.
- Giving `resume` an approval digest.
- Item 1.5's `run.json` version check, even though this item adds no new field shape that would need one — the markers already exist.

## Architecture

```text
                       hooks/lib/lifecycle-hook-core.mjs
                       (the only module that decides)
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
   claude-lifecycle.mjs   codex-lifecycle.mjs   workflow-worker-lifecycle.ts
   renders to stdout      renders to stdout     renders to pi.sendUserMessage
   {decision:"block"}     {decision:"block"}    (deliverAs: followUp)

   event: UserPromptSubmit | Stop | SessionEnd
   Pi adapter maps:  agent_start → UserPromptSubmit
                     agent_settled → Stop
                     session_shutdown → SessionEnd
```

The Pi adapter passes `stdinJson: {}` — the core only reads it for harnesses that supply a payload, and Pi's events carry none it needs.

Markers stay `${harness}StartedOnce` / `${harness}PendingContinuation`, so Pi's become `piStartedOnce` / `piPendingContinuation`. A run is single-harness, so they never collide.

## Error Handling

Unchanged in kind, and load-bearing: every path stays swallowed.

- The Pi adapter's handlers run inside Pi's fire-and-forget `pi.on(...)` dispatch, where a throw surfaces as an unhandled rejection on a normal path. The core already wraps its whole body in `try/catch`; the adapter keeps its own outer `try/catch` too rather than trusting the core's.
- The core's `recordDebug` writes to the run's hook debug log using `env.WORKFLOW_RUN_DIR`. The Pi adapter has that env, so its failures become visible the same way the subprocess hooks' do — an improvement over today, where the extension's `catch {}` blocks are silent.
- A resume whose marker/generation update succeeds but whose relaunch then fails must roll back all of it, not just the claim.

## Verification Strategy

1. Pi's `agent_start` on a fresh run confirms the launch generation and persists `piStartedOnce`; a second `agent_start` in the same session increments it; an `agent_start` following a continuation reuses it. Asserted on the run record, per event.
2. The Pi adapter renders a continuation by calling `pi.sendUserMessage` with the core's prompt — and never by writing JSON.
3. Claude and Codex still render the same `{"decision":"block","reason":…}` on stdout they render today, byte-for-byte. Their existing hook tests must pass untouched; if any needs changing, that is a finding.
4. `continuationPrompt` and `handoffExists` have exactly one definition each, proven by grep. The `"completed"` string literal is gone.
5. **The divergence is closed:** the same sequence of events (launch → prompt → stop-continue → prompt → resume → prompt) produces the same generation arithmetic for pi, claude and codex. One test, three harnesses, same assertions.
6. A confirmed resume opens generation N+1 with `stopAttempts: 0` and both markers cleared, and does so **before** `relaunch` is called — assert the ordering, not just the end state.
7. The resumed pane's env carries the new generation: `runEnv` is computed from the updated record.
8. A resume whose relaunch throws restores the generation, the stop budget and the markers along with the claim.
9. A resumed worker that had exhausted its stop attempts gets a fresh budget: after resume, its first stop yields `continue`, not `manual`.
10. Item 1.6's hook-ingestion tests pass untouched — the generated configuration and its execution path are unaffected.
11. `npm test` green, still zero skips.

## Acceptance Criteria

- Pi, Claude and Codex produce identical run records for identical event sequences, including across a resume.
- No harness's lifecycle protocol logic exists outside `hooks/lib/lifecycle-hook-core.mjs`; the three harness files contain only their own protocol rendering.
- Resuming a worker that exhausted its stop attempts gives it a working retry, where today it does so only under Claude and Codex and only by accident.
- What a resume does to the generation can be read in one place.
- No Claude wire format appears in a module shared with Pi.
