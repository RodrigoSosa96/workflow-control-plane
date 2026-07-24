# Pi Workflow — Next Steps Roadmap

> Status snapshot and prioritized roadmap, written 2026-07-24 after the real Pi
> fixture canary was brought to green end-to-end. This is a roadmap for review,
> not an implementation plan; each block below should get its own brainstorming +
> written plan before code is touched.

## What works today (verified)

- **Supervised headless lane (`mode: stream-json`, the fixture supervisor).**
  Verified end-to-end against Herdr 0.7.5 and Pi 0.81.1: worktree → workspace →
  pane → `pane run` supervisor → Pi (`--print --mode json`) edits files, runs
  tests, writes the structured handoff, and the control plane verifies it.
  Worker telemetry is faithful (phase advances starting → running → tool →
  settled with `observability: reported`, turns/tools/model/cost populated).
- **CLI surface.** `doctor / plan / status / start / launch / runtime / handoff /
  result / reconcile / delegation` are implemented and read-only vs. mutating
  boundaries hold.
- **Internal advisory delegation** (Workflow-owned Pi delegation adapter).

## What is NOT yet done for Pi

### 1. Prove the interactive production lane end-to-end (recommended first)

The lane real projects (OCR, Acme, …) will use is `mode: interactive` →
`herdr agent start --kind pi --pane <id>`, which launches an interactive Pi in a
pane the user drives. The Herdr 0.7.5 fixes from this branch repair it
structurally (command shape, Herdr-safe agent name, `--env` forwarding, pane
readiness wait), and the command shape was verified against live Herdr — but a
full `workflow launch` in interactive mode was never run to completion.

- **Action:** run an interactive `workflow launch` against a fixture or
  low-risk real project; confirm Pi starts in the pane, receives the assignment,
  and the handoff closes.
- **Why first:** empirically reveals how much of #2 and #3 is actually required,
  the same approach that surfaced the 14 canary bugs. Low risk, high signal.

### 2. Port today's telemetry fixes to the interactive lane

`.pi/extensions/workflow-worker-observability.ts` (the worker observability
widget loaded only inside a Workflow-launched Pi) still pins
`createTelemetryAdapter({ harness: "pi", version: "0.80.10" })` and shares the
adapter that was fixed on this branch. Without porting the fixes, an interactive
Pi worker will degrade telemetry to `unknown` exactly as the supervisor did
before today.

- **Action:** update the extension to Pi 0.81.1 and carry over the adapter fixes
  — ignore no-measurement events (`session`, `message_start`, `message_update`,
  `turn_end`, `agent_end`, tool-progress, non-assistant `message_end`), route
  oversized lines by type, and declare the real version.
- **Scope:** bounded, TDD-able. Depends on #1 to confirm the real interactive
  event path.

### 3. Lifecycle hooks (the large block)

Plan: `2026-07-19-supervised-lifecycle-pi-coordinator.md` — explicitly not
implemented (`no workflow hooks, resume, or close CLI command is implemented`).
An interactive Pi has no stdout stream to capture; the run store must be updated
from native Pi lifecycle events (SessionStart / UserPromptSubmit / Stop /
SessionEnd).

- Without it: `workflow status` / `workflow result` do not reflect an
  interactive worker's progress; there is no bounded Stop-hook continuation and
  no graceful close.
- Prerequisites named by that plan: complete
  `2026-07-19-two-lane-delegation-foundation.md` and
  `2026-07-19-workflow-owned-pi-delegation-adapter.md` first (their
  `WorkerTransport`, delegation services, and managed-role contracts are
  consumed, not reimplemented).
- Largest and highest-leverage block for interactive observability.

### 4. `workflow resume` / `workflow close`

Same plan as #3. Resume must target an exact native Pi session id/path (never
`--last`/`--continue` heuristics); close sends a graceful idle-session exit only
after process-identity validation and must never kill an unknown or working
process.

### 5. Version robustness (minor)

`HARNESS_TELEMETRY_VERSIONS.pi` and `SUPPORTED_VERSIONS.pi` are hardcoded to
`0.81.1`. Detecting the installed version at runtime (`pi --version`) would keep
the telemetry adapter from silently degrading to `unknown` on the next Pi bump —
the same failure mode fixed on this branch.

## Beyond Pi (later)

- Real Claude / Codex canaries. `scripts/smoke-workflow-fixture.js` currently
  supports only `pi` (`Real canary for '<x>' is not implemented; only 'pi' is
  supported`).

## Recommended order

1 → 2 → (3 + 4 together) → 5, with Claude/Codex canaries after the interactive Pi
lane is trustworthy. Start each block with brainstorming and a written plan.

## Open design question surfaced during the canary work

The fixture supervisor leaves the bootstrap shell pane open because
`verifyCloseSafety` only closes it when it confirms an interactive harness in the
sibling pane; a supervisor pane is not recognized, so the shell is retained (the
safe direction). If the extra pane is unwanted, extend `verifyCloseSafety` to
recognize a supervisor pane and close the bootstrap shell. Not a bug — a
deliberate safety default.
