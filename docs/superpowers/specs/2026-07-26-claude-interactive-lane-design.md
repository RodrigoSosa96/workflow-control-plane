# Claude Interactive Lane — Design

> Sub-project #3 of the "finish the workflow with Pi/harnesses" roadmap. Brings the
> Claude Code harness to full parity with the Pi interactive lane: an interactive
> `workflow launch` that drives run-state + generation (lifecycle), renders an
> observability widget, and supports `workflow resume`/`close` against the live
> session. It reuses the harness-neutral mold the Pi lanes established
> (`lifecycle.js`, `resume.js`, `close.js`, identity capture in `execute.js`) and
> **generalizes the session transport** so Pi, Claude, and later Codex share it.

## Goal

After an interactive `workflow launch` with a Claude profile (`mode: interactive`):

- The run's state machine advances (launching → running → idle-awaiting-handoff →
  completed / manual-handoff-required) and generation increments on user follow-ups,
  driven by **Claude Code hooks** — the same `lifecycle.js` the Pi extension drives.
- An **observability widget** renders in the Claude session (via `statusLine`).
- The run records the exact Claude **session identity**, and `workflow resume`/`close`
  operate against the live session exactly as they do for Pi (focus the agent pane;
  relaunch a dead session on `--yes`; graceful idle close).

Parity means: same run-state semantics, same telemetry surface, same recovery
behavior — only the harness-specific *adapters* differ (hooks + statusLine +
settings injection instead of `pi.on()` extensions).

## Why this rests on the existing mold

The Pi lanes already factored the harness-neutral seam:

- `src/workflow/lifecycle.js` — `onPrompt({runId, generation, source})`,
  `onStop({runId, generation, hasValidHandoff}) → {run, action}`,
  `onSessionEnd({runId})`. Fully harness-agnostic; Claude reuses it verbatim.
- `src/workflow/resume.js` / `close.js` — plan/execute focus, relaunch (confirmed),
  graceful close. Harness-agnostic; reused verbatim.
- `src/workflow/execute.js` — builds the `pi-session` `sessionIdentity` at interactive
  start and (post recovery-lane) persists it resiliently.
- `src/workflow/harnesses.js` — `runEnv` + `WORKFLOW_ENV_KEYS` (neutral worker env),
  `buildHarnessLaunch` (already has `claudeArgv`).

What is Pi-specific today and must gain a Claude sibling: the **lifecycle adapter**
(`.pi/extensions/workflow-worker-lifecycle.ts`, in-process `pi.on()`), the
**observability adapter** (`.pi/extensions/workflow-worker-observability.ts`,
in-TUI widget), and the transport's **session-match rule**.

## Claude Code facts (verified against Claude Code 2.1.220)

- **Interactive under Herdr:** `herdr agent start <name> --kind claude --pane <id>`
  is supported (`--kind` accepts `claude`).
- **Session id:** `claude --session-id <uuid>` sets an exact session id at start
  (analog of Pi's `--session-id`). `--resume <id>` / `-c` resume; `--fork-session`
  forks. Sessions persist at `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` —
  **project-scoped by cwd**, exactly like Pi, so a relaunch MUST run in the original
  worktree cwd or Claude starts a fresh session (the Pi recovery-lane gotcha applies).
- **Settings/extensions injection:** `claude --settings <file-or-json>` loads
  *additional* settings without touching the user's `~/.claude/settings.json`. This is
  the Claude analog of Pi's `--extension`: the workflow injects its **hooks** and
  **statusLine** through a generated settings file. (`--bare` disables hooks — never
  use it here.)
- **Hooks:** `settings.hooks` supports `SessionStart`, `UserPromptSubmit`, `Stop`,
  `SessionEnd`, `PreToolUse`, `PostToolUse`, etc. Each hook is a `{type:"command",
  command}` that receives the hook event as JSON on stdin. A **`Stop` hook may return
  `{"decision":"block","reason":"…"}`** to force Claude to continue the turn — the
  Claude analog of Pi's `sendUserMessage(deliverAs:"followUp")` continuation.
- **statusLine:** `settings.statusLine = {type:"command", command}` runs a command that
  receives session JSON (session_id, model, cwd, transcript_path, …) on stdin and prints
  the status line — the Claude analog of Pi's observability widget.
- **Other launch flags** (already in `claudeArgv`): `--permission-mode`, `--add-dir`,
  `--model`, `-n/--name`.

### Runtime unknowns to settle in the probe (human/TTY)

1. Exact graceful-exit key(s) for an idle Claude session (`ctrl+d`? `/exit`?), and the
   `agent send-keys` target (pane id, as for Pi).
2. Whether `claude --session-id <exact> --settings …` in the original cwd resumes the
   native history AND reloads the workflow hooks + statusLine.
3. Which hooks actually fire and in what order (does a `Stop`-block continuation refire
   `UserPromptSubmit`? — determines how "user" vs "continuation" is distinguished).
4. How `herdr agent list` reports a Claude agent's `agent_session.value` (bare id? a
   `.jsonl` path? — sets the transport's Claude session-match rule).
5. That `herdr agent focus <paneId>` / `tab focus` behave as for Pi.

The probe runs FIRST (like the Pi Task 1 probe) and its findings gate the transport
match rule, the close keys, and the hook mapping.

## Architecture

Reuse the neutral core; add Claude adapters; generalize the transport.

```
workflow launch (interactive, claude profile mode: interactive)
  └─ harnesses.js claudeArgv: claude --session-id <uuid> --permission-mode <> --add-dir <>
       --settings <generated workflow settings> [--model] [args] [bootstrap]
  └─ execute.js: after agent start, persist run.transportIdentity =
       { kind: "claude-session", harness: "claude", runId, sessionId, paneId, tabId, workspaceId, cwd }

Claude worker process
  ├─ hooks (from --settings) → node <cp>/hooks/claude-lifecycle.mjs <event>
  │     SessionStart/UserPromptSubmit → lifecycle.onPrompt(user|continuation)
  │     Stop                          → lifecycle.onStop → block+reason if action==="continue"
  │     SessionEnd                    → lifecycle.onSessionEnd
  └─ statusLine (from --settings) → node <cp>/hooks/claude-statusline.mjs → widget line

workflow resume <run-id> [--yes]        workflow close <run-id>
  └─ commands.js transportForRun picks the neutral session transport for any
     transportIdentity.kind ending in "-session" (harness read from identity.harness)
  └─ resume.js / close.js (unchanged) → focus | relaunch | graceful close
```

### Units and responsibilities

1. **Generalized session transport (`src/workflow/session-transport.js`, refactor of
   `pi-session-transport.js`).** Keeps all the Herdr-generic logic (observeExact via
   `agent list`, requestGracefulClose via `agent send-keys`, focus via `agent focus`).
   The two harness-specific bits move behind a small **session adapter** looked up by
   harness:
   - `sessionMatches(agentSessionValue, sessionId)` — Pi: `value.endsWith("_"+id+
     ".jsonl")` (path suffix); Claude: per probe finding (bare id or path).
   - `exitKeys` — the graceful-close keys (Pi: `["ctrl+d"]`; Claude: per probe).
   `createPiSessionTransport` remains as a thin wrapper (`createSessionTransport({
   harness:"pi"})`) so nothing else changes. **Discriminator:** each harness keeps its
   own identity `kind` (`pi-session`, `claude-session`) for clarity and Pi back-compat,
   plus a `harness` field that selects the adapter (a `pi-session` identity without
   `harness` defaults to `"pi"`). `transportForRun` routes any `*-session` kind to the
   generalized transport.

2. **Claude launch wiring (`src/workflow/harnesses.js`).** `claudeArgv` gains, only when
   `run && mode === "interactive"`, `--settings <generatedSettingsPath>` pointing at a
   workflow settings file that wires the hooks + statusLine (mirrors how `piArgv` adds
   `--extension` for interactive runs). A `CLAUDE_WORKER_SETTINGS` builder produces that
   settings JSON (hooks + statusLine commands, absolute control-plane paths). The
   settings file is written into the run directory at launch (like the assignment).

3. **Claude lifecycle hook (`hooks/claude-lifecycle.mjs`, new).** A single CLI entry
   invoked per hook event. Reads the hook JSON from stdin + `WORKFLOW_*` env, builds the
   run store + `createLifecycle`, and:
   - `SessionStart` / first `UserPromptSubmit` → `onPrompt(generation=current, source:
     "user")` (first confirms launch generation).
   - subsequent `UserPromptSubmit` → `onPrompt(generation=current+1, source:"user")`.
   - `Stop` → `onStop`; if `action==="continue"`, print `{"decision":"block","reason":
     continuationPrompt}` on stdout so Claude finishes the handoff; `manual`/`none` →
     print nothing.
   - `SessionEnd` → `onSessionEnd`.
   The user-vs-continuation distinction follows the probe (finding #3): if a Stop-block
   continuation does not refire `UserPromptSubmit`, no local state is needed (cleaner
   than Pi); otherwise mirror Pi's `pendingContinuation` flag via a small run-scoped
   marker. Every handler swallows its own errors (a hook must never break the worker).

4. **Claude observability hook (`hooks/claude-statusline.mjs`, new).** Reads the run's
   telemetry snapshot and prints one status line (`Workflow <id> | <phase> | claude |
   <model> | …`), reusing the neutral `buildObservabilityLines` shaped for a single
   line. Telemetry itself is recorded by the lifecycle/tool hooks (phase transitions;
   cost/tokens derived from the Stop event's transcript) via the existing telemetry
   store — parity with what the Pi observability extension recorded.

5. **Identity capture (`src/workflow/execute.js`, small change).** The interactive
   `sessionIdentity` gains `harness` (from the plan/profile) so the transport can pick
   the right adapter. Pi keeps `kind:"pi-session"` (`harness:"pi"`); Claude uses
   `kind:"claude-session"`, `harness:"claude"`. The resilient persistence +
   readiness-timeout recovery from the recovery lane already cover Claude.

6. **CLI/relaunch wiring (`src/workflow/commands.js`).** `transportForRun` selects the
   generalized transport for any `*-session` identity and passes `harness`. `relaunchPiSession`
   generalizes to `relaunchSession`: rebuilds the harness's interactive argv (Claude:
   `claude --session-id <exact> --settings <regenerated> …`, no bootstrap) and env, in
   the original cwd. Agent name stays ≤32 chars (`resume-<sessionId first block>` — the
   recovery-lane fix), focuses the agent pane after start.

## Data flow

```
Launch:    launch → claudeArgv(--settings) → agent start --kind claude → identity persisted
Lifecycle: Claude fires SessionStart/UserPromptSubmit/Stop/SessionEnd → hook script →
           lifecycle.onPrompt/onStop/onSessionEnd → run-state + generation
Observe:   statusLine command → telemetry snapshot → widget line
Resume:    resume r1        → observeExact idle/active → agent focus <pane>
           resume r1 (dead) → needs-confirmation → --yes → relaunch claude --session-id <exact>
Close:     close r1         → observeExact idle → send-keys <exitKeys> → { closed: true }
```

## Testing

TDD per unit with fakes (no real Claude, no model):

- **session-transport** — the neutral logic is exercised by the existing Pi tests
  (must stay green after the refactor); add Claude-adapter tests (sessionMatches +
  exitKeys) and a harness-selection test.
- **claude-lifecycle hook** — feed representative hook JSON on stdin; assert the right
  `lifecycle` call and, for `Stop`, the `{"decision":"block"}` output when a
  continuation is due; error-swallowing verified.
- **claude-statusline hook** — given a telemetry snapshot, prints the expected line;
  never throws.
- **harnesses** — interactive `claudeArgv` includes `--settings <path>`; supervised
  (stream-json) does not; the settings file content wires the hooks + statusLine.
- **execute/commands** — identity carries `harness:"claude"`; `transportForRun` and
  relaunch select the Claude adapter; relaunch argv resumes the exact session with
  settings and no bootstrap.

**Manual verification (human/TTY), documented as a guided procedure** (the runtime
unknowns above), in two phases mirroring the Pi lanes:

- **Probe (first):** confirm exit keys, `--session-id` resume + settings reload, hook
  firing/order, `agent list` session shape, focus. Findings gate the adapter details.
- **Task N e2e (before merge):** launch → identity survives to a terminal state →
  observability widget renders → resume focuses Claude's pane → close idle → resume
  dead → `--yes` relaunch resumes real history with hooks/statusLine reloaded → resume
  focuses the new pane. Fixture built with the Claude profile patched to
  `mode: interactive`.

## Implementation methodology (empirical order)

1. **Probe first (human/TTY):** settle the runtime unknowns; write findings into
   `docs/superpowers/verification/claude-interactive-lane.md`.
2. Generalize the transport (TDD; Pi tests stay green) with the probed match rule.
3. Claude launch wiring (`--settings` + settings builder) (TDD).
4. Claude lifecycle hook (TDD) against `lifecycle.js`.
5. Claude observability hook + statusLine (TDD).
6. Identity `harness` + CLI/relaunch generalization (TDD).
7. Manual e2e (human/TTY) with a Claude fixture.

## Risks and open items

- **Hook firing model (highest).** The user-vs-continuation distinction and the exact
  hooks that fire drive the lifecycle adapter; the probe settles it before the hook is
  built. Fail-safe: if unclear, mirror Pi's local-state flag.
- **Refactoring the merged Pi transport.** Mitigated by the green Pi suite + the
  recovery lane's live verification; the neutral logic is unchanged, only the two
  harness bits move behind an adapter.
- **statusLine cadence.** Claude refreshes the status line on its own schedule; the
  widget may lag a phase. Cosmetic; acceptable for parity.
- **Telemetry fidelity.** Cost/tokens come from the transcript at `Stop`, not a live
  measurement stream; the widget shows last-known values between turns.
- **Session resume fidelity.** Must resume the exact native session in the original
  cwd; confirmed in the probe.

## Non-goals

- Codex interactive lane (the next sub-project; it inherits this generalized mold).
- Changing the supervised (stream-json) Claude lane or the delegation transport.
- A live per-token telemetry stream for Claude (transcript-derived is enough for parity).
