# Pi Interactive Lifecycle — Design

> Design for sub-project #1 of the "finish the workflow with Pi" roadmap
> (`docs/superpowers/plans/2026-07-24-pi-workflow-next-steps.md`): make Pi's
> interactive lane trustworthy end-to-end, with observability and full lifecycle
> supervision. Scoped to Pi; Claude and Codex inherit the harness-neutral core
> later.

## Goal

An interactive Pi worker — the lane real projects (OCR, Acme, …) will use via
`herdr agent start --kind pi` — runs reliably in both an **autonomous** mode (Pi
does the work and closes the handoff while the user observes) and an **assisted**
mode (the user collaborates with follow-up prompts). Throughout, the run's state,
generation, and worker telemetry stay correct, and the worker can be resumed and
closed gracefully.

## Relationship to the existing lifecycle plan

A detailed design already exists in
`docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md`. This
spec does not replace it; it **validates, scopes it to Pi, and updates it** with
what the real Pi canary work established:

- Pi is **0.81.1** (not 0.80.10). `agent_settled` is the real "Stop" event
  ("no retry/compaction/follow-up left").
- The plan's prerequisites (Task 0: two-lane delegation foundation and the
  Workflow-owned Pi delegation adapter) are **already implemented** —
  `worker-transport.js`, `delegation-services.js`, `delegation-watcher.js`,
  `pi-delegation-transport.js` exist with passing tests.
- Herdr is **0.7.5** with the launcher fixes already merged to `main`.
- A worker observability Pi extension **already exists**
  (`.pi/extensions/workflow-worker-observability.ts`) and reports telemetry via
  Pi's native events; it is reused, not rebuilt.

The chosen architecture (a harness-neutral lifecycle callback plus a thin Pi
extension) matches the plan's `lifecycle.js` "harness-neutral generation
protocol".

## Scope

**In scope (Pi only):**

- Interactive Pi lane proven end-to-end in both modes.
- Harness-neutral lifecycle: run state machine driven by native Pi events,
  generation increments on follow-ups with prior-result invalidation, bounded
  stop-continuation.
- `resume` (exact Pi session by id/path, no `--last`/`--continue` heuristics) and
  `close` (graceful, only after process-identity validation).
- Observability extension adjusted to Pi 0.81.1, kept separate from lifecycle.

**Out of scope:** Claude and Codex. `lifecycle.js` is harness-neutral from day
one so adding them later is a thin adapter plus hook configuration, not a
redesign.

## Architecture

Two independent event flows leave the interactive Pi worker, each to its own
store, plus two recovery commands driven from the CLI.

```
   Pi interactive worker (in the ticket worktree)
        │  native events: agent_start / agent_settled /
        │  session_shutdown / session_start{reason:resume} / follow-up
        ├───────────────────────────────┬──────────────────────────────
        ▼                                ▼
  [Pi lifecycle extension] (thin)   [Pi observability extension] (existing → 0.81.1)
        │ translate event → call         │ telemetry (widget + measurement)
        ▼                                ▼
   lifecycle.js  (HARNESS-NEUTRAL)   telemetry-store  ──► workflow status/result
        │ state + generation
        │ + stop-continuation
        ▼
     run-store  ─────────────────────► workflow status/result/reconcile

   Recovery (CLI, outside the worker):
     workflow resume  → resume.js → harnesses.js (exact argv) + herdr
     workflow close   → close.js  → herdr process-info (identity + idle)
```

The two flows are independent: a telemetry failure never corrupts run state, and
vice versa. `lifecycle.js` touches neither Pi nor the UI, so it is unit-tested in
isolation and reused by other harnesses.

### Units and responsibilities

1. **`src/workflow/lifecycle.js` (new — the core).** Harness-neutral. Accepts a
   normalized lifecycle event (`prompt` / `stop` / `session-end`) and applies the
   transition to the run store: state (running / completed / failed), generation
   (first prompt = generation 1; a follow-up archives `result.json`, increments,
   returns to `running`), and a per-generation stop-continuation counter (max 2).
   Knows nothing about Pi. Depends only on `run-store` + `run-state`. Pure fakes
   in tests. **This is the mold Claude/Codex reuse.**

2. **Pi lifecycle extension (new, thin).** The only Pi→neutral adapter. Binds
   `pi.on("agent_start" | "agent_settled" | "session_shutdown" |
   "session_start")` and translates to `lifecycle.js` calls. On `agent_settled`
   it checks whether a valid handoff exists for the current generation; if not it
   queues at most two continuation messages (via `pi.sendUserMessage`), then
   records a manual-handoff fallback. Never loops.

3. **Pi observability extension (existing, adjusted to 0.81.1).** Unchanged
   responsibility — telemetry only (widget + telemetry store). Kept deliberately
   separate from lifecycle.

4. **`src/workflow/resume.js` (new).** Plans and executes resume of an **exact**
   Pi session (by session-id/path), distinguishing a live process from a dead
   one. Never guesses with `--last`/`--continue`.

5. **`src/workflow/close.js` (new).** Graceful close: validates process identity
   via `herdr process-info`, sends a graceful exit only when idle; never kills an
   unknown or working process.

6. **`src/workflow/harnesses.js` (existing, extended).** Adds extension loading
   to the launch argv and produces the exact resume argv.

7. **CLI commands (`bin/workflow.js`): new `resume` and `close`; `reconcile`
   already exists.**

8. **Extension loading into the worker (component with risk).** The observability
   extension is not passed via `--extension` today (the `pi-worker` profile has
   `arguments: []`), so it currently relies on Pi discovery/packaging — and the
   worker runs in the ticket worktree, not in `workflows/`, so it is unverified
   that it loads at all. Define/verify an explicit mechanism (most likely
   `pi --extension <path>` in the launch argv). First candidate to break in the
   empirical test.

## Data flow

### Autonomous mode

```
workflow launch → run-store: planned → launching → running (gen 1)
Pi: session_start        → ext.lifecycle: confirm gen 1, state running
Pi works (turns/tools)   → ext.observability: live telemetry
Pi runs the handoff cmd  → handoff CLI writes result.json, state → completed
Pi: agent_settled        → ext.lifecycle: valid handoff for gen 1? YES → no continuation
Pi: session_shutdown     → terminal state confirmed
```

Success = the run completes untouched; `workflow result` sees the handoff.

### Assisted mode

```
… same start through running (gen 1) …
Pi: agent_settled WITHOUT a valid handoff → ext.lifecycle queues a continuation
     attempt 1: "before ending, create the workflow handoff for run X generation 1"
     attempt 2: same  ── still no handoff → manual fallback (no loop)
User types a follow-up → new agent_start → ext.lifecycle:
     archive gen 1 result.json (stale), gen++ → gen 2, state → running,
     reset the stop-continuation counter
Pi works gen 2, agent_settled with a valid handoff for gen 2 → completed
```

Key invariant: **a follow-up always invalidates the prior result** and raises the
generation; the old generation's `result.json` is archived, never overwritten.

### Recovery

```
workflow resume <run-id> → resume.js reads the EXACT session-id from run-store
     process/pane alive? (herdr) → YES: focus/reconnect
                                    NO: relaunch pi --session-id <exact> + extensions
     never --last / --continue
workflow close <run-id>  → close.js: herdr process-info validates identity + idle
     idle and is the run's pi → graceful exit ; working/unknown → refuse
```

## Testing

Strict TDD per isolated unit:

- **`lifecycle.js`** — pure tests with a fake run store: first prompt = gen 1; a
  follow-up archives and increments; stop-continuation bounded to 2 then manual
  fallback; a stop with a stale generation/fingerprint is treated as missing;
  malformed / NUL / oversized events fail closed with bounded output.
- **Pi lifecycle extension** — contract tests with fake Pi events (same pattern
  the observability extension uses today): `agent_settled` validates the handoff,
  queues ≤2 continuations, falls back.
- **`resume.js` / `close.js`** — tests with fake herdr/run-store: resume live vs.
  dead; close refuses a working or unverified-identity process.
- **Observability** — extend the adapter tests for Pi 0.81.1 (largely done on the
  merged branch).

**Automation boundary (honest limit):** the headless canary is automatable
because Pi runs with `--print --mode json`. The interactive lane is not — it
needs a TTY and a human typing. Automated coverage therefore stops at the units
(with fakes); **interactive end-to-end verification is a guided manual
procedure** the user runs (launch, type a follow-up, confirm the transitions),
just like the canaries run during the fixture work. It is documented as a
verification script with steps and checks, not a CI test.

## Implementation methodology (empirical order)

1. **Test first.** A real interactive `workflow launch` with what exists today —
   confirm whether the extensions load in the worker and what state/telemetry
   updates. The extension-loading risk (and possibly Herdr bugs like the canary's)
   surfaces here.
2. `lifecycle.js` + the lifecycle extension (TDD) → prove autonomous end-to-end.
3. Generation + stop-continuation → prove assisted with follow-ups.
4. `resume` / `close` → prove recovery.

Starting with #1 avoids building hooks on broken assumptions.

## Risks and open items

- **Extension loading (highest).** Unverified that worker extensions load in the
  ticket worktree; may require explicit `--extension` argv wiring. Verified in
  methodology step 1 before any lifecycle code.
- **Interactive Herdr path.** The interactive `agent start --kind pi` lane was
  repaired structurally on the merged branch but never run to completion; step 1
  may surface launch bugs the headless canary did not exercise.
- **Follow-up detection fidelity (subtle).** A new generation must be raised only
  by a genuine **user** follow-up — not by the continuation messages the lifecycle
  extension itself queues on `agent_settled`, and not by internal steering/retry
  `agent_start`s. Counting our own continuations as follow-ups would inflate the
  generation and wrongly stale results. Distinguishing them relies on Pi's
  `agent_start` / `streamingBehavior` / `stop_hook_active` semantics; to be
  confirmed against 0.81.1 in step 1, and covered by explicit `lifecycle.js`
  tests (a queued continuation does not increment the generation).
- **Version robustness.** `HARNESS_TELEMETRY_VERSIONS.pi` / `SUPPORTED_VERSIONS`
  are pinned to `0.81.1`; a runtime `pi --version` probe (roadmap item #5) would
  prevent silent `unknown` degradation on the next bump. Out of this sub-project
  but noted.

## Non-goals

- Claude/Codex hooks, canaries, or launch (later sub-projects).
- Rewriting the delegation/transport foundation (already implemented).
- Any background-writer enablement (stays disabled per existing policy).
