# Codex Interactive Lane — Design

> Sub-project #4 of the "finish the workflow with harnesses" roadmap. Brings the
> Codex CLI harness to the **maximum parity Codex allows**: interactive `workflow
> launch` that captures the session identity, drives run-state/generation
> (lifecycle) and records telemetry (best-effort), and supports `workflow
> resume`/`close` against the live session. Reuses the harness-neutral mold and the
> generalized session transport the Pi and Claude lanes established.

## Why Codex is different (and what "maximum parity" means)

Codex (`codex-cli` 0.145.0) diverges from Pi/Claude in ways that cap parity:

- **No `--session-id` flag.** Codex generates its own session id; the control plane
  cannot set it at launch. The identity must be **discovered post-launch**.
- **Resume is a subcommand:** `codex resume <SESSION_ID>` (or `--last`), not a flag.
- **Hooks are global + JSON, same shape as Claude** (`SessionStart`, `{command, type,
  timeout}`) but live in `~/.codex/hooks.json`, which Herdr already manages (its
  `SessionStart` hook runs `herdr-agent-state.sh`, which is how `herdr agent list`
  already tracks Codex). There is no per-launch `--settings` equivalent.
- **No statusLine.** Codex has no scriptable status line, so the in-TUI observability
  **widget is not possible** — observability is telemetry the lifecycle hook records
  (visible via `workflow worker status`), not an in-TUI line.
- **Autonomy** is `-s <sandbox>` + `-a never` (+ `--dangerously-bypass-approvals-and-sandbox`
  / `--dangerously-bypass-hook-trust`), the Codex analog of Claude's permission model.

"Maximum parity" = recovery (identity + resume/close) is **solid**; lifecycle
(run-state/generation) is **best-effort**, bounded by which hook events Codex actually
fires (settled in the probe); observability is **telemetry only** (no widget).

## Goal

After an interactive `workflow launch` with the `codex-worker` profile
(`mode: interactive`):

- The run records the exact Codex session identity (discovered post-launch), and
  `workflow resume`/`close` operate against the live session exactly as for Pi/Claude.
- The run-state advances via a Codex lifecycle hook driving the neutral `lifecycle.js`,
  to whatever fidelity Codex's hook events permit (at minimum `launching → running`;
  full generation/stop-continuation only if Codex fires prompt/stop events).
- The lifecycle hook records telemetry `phase` (best-effort observability).

## What it reuses

- `src/workflow/lifecycle.js` — `onPrompt`/`onStop`/`onSessionEnd`, verbatim.
- `src/workflow/resume.js` / `close.js` — plan/execute focus, relaunch, graceful close.
- `src/workflow/session-transport.js` — `createSessionTransport({ herdr, harness })`
  + `SESSION_ADAPTERS`; the Codex lane adds a `codex` adapter.
- `src/workflow/execute.js` — identity capture (extended for post-launch discovery).
- `src/workflow/harnesses.js` — `codexArgv` (already exists), `runEnv`.

## Codex facts (verified against codex-cli 0.145.0)

- `herdr agent start <name> --kind codex --pane <id>` is supported.
- `codex -C <cwd> -s <sandbox> -a <approval> [-m <model>] [prompt]` starts an
  interactive session (already what `codexArgv` builds); `codex exec` is the headless
  (stream-json) lane — untouched.
- `codex resume <SESSION_ID>` resumes a saved session by UUID (cwd-scoped; sessions in
  `~/.codex/sessions`). `codex resume --last` continues the most recent.
- Hooks: `~/.codex/hooks.json`, shape `{ hooks: { <Event>: [{ hooks: [{ command, type,
  timeout }] }] } }`; hook receives its event JSON on stdin (matches how
  `herdr-agent-state.sh` reads it). Herdr's `SessionStart` hook is already installed and
  says "add custom hooks beside this file."
- **Hook events (confirmed from the codex binary): the SAME set as Claude Code** —
  `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreToolUse`, `PostToolUse`,
  `PreCompact`, `Notification`. So the Codex lifecycle hook can drive **full** lifecycle
  parity (generation via `UserPromptSubmit`, terminal via `Stop`, `onSessionEnd` via
  `SessionEnd`) and is essentially a copy of `hooks/claude-lifecycle.mjs`. Lifecycle is
  **not** degraded — the only open lifecycle question is whether Codex's `Stop` hook
  honors a `{decision:"block"}` continuation (probe), and if not the run still reaches a
  terminal state via the handoff (the bounded stop-continuation is an optimization).
- Sessions are stored at `~/.codex/sessions/<YYYY>/<MM>/<...>_<uuid>.jsonl` (the id is in
  the filename), so post-launch identity discovery can read the newest one for the cwd.
- `-c key=value` overrides config; `-p <profile>` layers `$CODEX_HOME/<name>.config.toml`.

### Runtime unknowns to settle in the probe (human/TTY) — gate the adapters

1. **Stop-hook continuation:** the event SET is confirmed (same as Claude), so this is
   narrowed to: does Codex's `Stop` hook honor a `{decision:"block", reason}` output to
   force a continuation (like Claude), or must the worker reach a terminal state on its
   own? Either way lifecycle is full — this only decides whether the bounded
   stop-continuation optimization is available. Also confirm the hook stdin JSON field
   names (event name key, session id) match or differ from Claude's.
2. **`herdr agent list` shape for a Codex agent** — is `agent_session.value` a bare
   UUID (`kind:"id"`, like Claude) or a path? Sets `codex.sessionMatches` and confirms
   the id is readable post-launch.
3. **Graceful-exit sequence** for an idle Codex session (`/quit`? `ctrl+d`? `ctrl+c`
   twice?) and the `agent send-keys`/`send-text` target.
4. **`codex resume <id>` fidelity** — resumes the native session (history intact) in the
   original cwd, with the workflow hook still active.
5. **Global-hook safety** — a workflow hook added beside Herdr's in `~/.codex/hooks.json`,
   guarded to no-op unless `WORKFLOW_*` env is present, does not disturb ordinary Codex
   sessions.

## Architecture

```
workflow launch (interactive, codex profile mode: interactive)
  └─ codexArgv: codex -C <cwd> --add-dir <run-dir> -s <sandbox> -a never
       --dangerously-bypass-hook-trust [-m <model>] <bootstrap>
  └─ execute.js: after agent start, DISCOVER the session id (herdr agent list at the
       started pane; fallback newest ~/.codex/sessions for the cwd), then persist
       run.transportIdentity = { kind:"codex-session", harness:"codex", runId,
       sessionId, paneId, tabId, workspaceId, cwd }

Codex worker process
  └─ global ~/.codex/hooks.json (workflow hook installed beside Herdr's) →
       node <cp>/hooks/codex-lifecycle.mjs <event>
         guarded: no-op unless WORKFLOW_RUN_ID set & WORKFLOW_HARNESS==="codex"
         drives lifecycle.onPrompt/onStop/onSessionEnd to Codex's event fidelity
         records telemetry phase (best-effort observability; no statusLine)

workflow resume <run-id> [--yes]        workflow close <run-id>
  └─ transportForRun → createSessionTransport({ herdr, harness:"codex" })
  └─ resume.js/close.js (unchanged) → focus (agent focus) | relaunch | graceful close
     relaunch (codex): codex resume <exact sessionId> ... in the original cwd
```

### Units and responsibilities

1. **`SESSION_ADAPTERS.codex` (`src/workflow/session-transport.js`).** Add a codex
   adapter: `sessionMatches(value, id)` (per probe — likely `value === id`) and the exit
   strategy (`exitKeys` or `exitText`, per probe). The Herdr-generic observe/focus/close
   logic is unchanged.

2. **Post-launch identity discovery (`src/workflow/execute.js`).** Pi/Claude set the
   session id before start; Codex does not expose it, so after a successful interactive
   `agent start` for a codex plan, discover the id: query `herdr agent list`, find the
   agent at the started pane, read `agent_session.value`; fallback to the newest
   `~/.codex/sessions/**/*.jsonl` whose cwd matches. Persist `kind:"codex-session",
   harness:"codex"`. A small, codex-only branch; Pi/Claude keep their pre-set path.
   The discovery has a bounded retry (the id may appear a beat after start).

3. **Codex launch wiring (`src/workflow/harnesses.js`).** `codexArgv` already passes
   `-s <profile.sandbox>`, `-a <profile.approval_policy>`, `--add-dir <run-dir>`, and the
   model — the sandbox and approval come from the profile (a worker profile sets
   `approval_policy: never`), not hardcoded. For interactive runs it gains
   `--dangerously-bypass-hook-trust` so the workflow lifecycle hook runs without a
   per-invocation hook-trust prompt (the worker is isolated). No `--settings` (Codex
   hooks are global, installed separately in unit 5).

4. **Codex lifecycle hook (`hooks/codex-lifecycle.mjs`, new).** Essentially a copy of
   `hooks/claude-lifecycle.mjs` (Codex fires the same event set): reads the hook JSON on
   stdin + `WORKFLOW_*` env, no-ops unless this is a codex worker, maps `UserPromptSubmit
   → onPrompt`, `Stop → onStop`, `SessionEnd → onSessionEnd`, records telemetry `phase`,
   and uses the persisted `startedOnce`/`pendingContinuation` markers (the parent launch
   pre-sets `running`, and the hook is a stateless subprocess — the same two fixes the
   Claude lane needed). The `Stop → {decision:"block"}` continuation is emitted only if
   the probe confirms Codex honors it; otherwise `Stop` just records phase and the run
   completes via the handoff. Field-name differences from Claude's hook JSON (per probe)
   are handled here. Every handler error-swallowed. Consider extracting the shared
   lifecycle-hook core so `claude-lifecycle.mjs` and `codex-lifecycle.mjs` don't diverge.

5. **Codex hook installation (`hooks/codex-hook-install.mjs` or a launch step).** The
   workflow's lifecycle hook must be present in `~/.codex/hooks.json` for the events
   Codex fires, added **beside** Herdr's entry (never clobbering it), idempotently, and
   guarded to no-op for non-workers. Installed on demand (at launch, or a `workflow
   doctor`/setup step). The write is a careful read-merge-write of the global hooks.json.

6. **CLI/relaunch wiring (`src/workflow/commands.js`).** `transportForRun` already routes
   `*-session` by harness. `relaunchSession` gains a `codex` branch: build `codex resume
   <exact sessionId> -C <cwd> -s <sandbox> -a never --dangerously-bypass-hook-trust`
   (subcommand form, no `--session-id`), run in the original cwd; `agent focus` the new
   pane; persist the new identity. Pi (`--session-id`) and Claude (`--resume`) branches
   unchanged.

## Data flow

```
Launch:    launch → codexArgv → agent start --kind codex → DISCOVER id → identity persisted
Lifecycle: Codex fires <events> → global hook (guarded) → codex-lifecycle.mjs →
           lifecycle.onPrompt/onStop/onSessionEnd (to Codex's fidelity) + telemetry phase
Resume:    resume r1        → observeExact idle/active → agent focus <pane>
           resume r1 (dead) → needs-confirmation → --yes → codex resume <exact id> in cwd
Close:     close r1         → observeExact idle → <codex exit sequence> → { closed:true }
```

## Testing

TDD per unit with fakes (no real Codex, no model):

- **session-transport** — a `codex` adapter test (sessionMatches + exit strategy) and
  harness selection; Pi/Claude adapters stay green.
- **execute (post-launch discovery)** — with a fake herdr `agent list` returning a codex
  agent at the started pane, the identity is discovered and persisted with
  `kind:"codex-session"`; the fallback path (agent list empty → sessions dir) covered
  with a fake fs; the Pi/Claude pre-set path unchanged.
- **codex-lifecycle hook** — feed representative Codex hook JSON; assert the right
  `lifecycle` call + telemetry record for each supported event; degraded-mode
  (SessionStart-only) drives `running`; error-swallowing verified.
- **hook install** — a read-merge-write test: adds the workflow hook beside an existing
  Herdr hook without clobbering it; idempotent (re-running does not duplicate).
- **harnesses** — interactive `codexArgv` includes the autonomy flags; `codex exec`
  (supervised) is untouched.
- **commands/relaunch** — `transportForRun` selects the codex adapter; `relaunchSession`
  builds `codex resume <exact id>` (subcommand), no `--session-id`, valid agent name,
  focuses the new pane.

**Manual verification (human/TTY)** in two phases, like the prior lanes:

- **Probe (first):** settle the five runtime unknowns above. Findings gate the adapter
  (sessionMatches, exit keys), the identity discovery (agent_session shape), the
  lifecycle hook (which events → what fidelity), and the hook-install safety.
- **e2e (before merge):** launch → identity discovered + `kind:"codex-session"` → run
  advances (to Codex's fidelity) + telemetry `phase` recorded → `resume` focuses Codex's
  pane → `close` idle → `resume` dead → `resume --yes` (`codex resume`) resumes real
  history → `resume` focuses the new pane. Fixture with the codex profile patched to
  `mode: interactive`.

## Implementation methodology (empirical order)

1. **Probe first (human/TTY):** settle the unknowns; write findings into
   `docs/superpowers/verification/codex-interactive-lane.md`. These gate everything
   codex-specific.
2. `SESSION_ADAPTERS.codex` (TDD) with the probed match rule + exit strategy.
3. Post-launch identity discovery in `execute.js` (TDD).
4. Codex launch autonomy flags in `codexArgv` (TDD).
5. Codex lifecycle hook + telemetry (TDD), to the probed event fidelity.
6. Codex hook install (TDD, read-merge-write).
7. CLI/relaunch `codex resume` branch (TDD).
8. Manual e2e (human/TTY) with a Codex fixture.

## Risks and open items

- **Lifecycle.** De-risked: Codex fires the same hook event set as Claude, so the
  lifecycle hook mirrors `claude-lifecycle.mjs` and drives full generation/terminal
  state. The only residual is whether the `Stop` hook honors a `{decision:"block"}`
  continuation; if not, the worker reaches a terminal state via the handoff (the
  stop-continuation is an optimization, not load-bearing). Hook stdin field names are
  confirmed against Claude's in the probe.
- **Global hook side effect.** The workflow hook lives in the user's `~/.codex/hooks.json`.
  Mitigated by the no-op guard (matches Herdr's own pattern) and idempotent, non-clobbering
  install. Documented; a per-run `CODEX_HOME` isolation is a heavier fallback if needed.
- **Post-launch identity race.** The session id may appear a beat after `agent start`
  returns; discovery uses a bounded retry, and resume/observe fail safe (missing →
  offer relaunch) if the id can't be read.
- **Autonomy flags.** `--dangerously-bypass-*` gives the worker free rein in its isolated
  worktree (parity with the Pi/Claude worker models); the sandbox still applies unless
  fully bypassed.

## Non-goals

- In-TUI observability widget (Codex has no statusLine).
- Changing the supervised (`codex exec` / stream-json) lane or the delegation transport.
- A per-run `CODEX_HOME` (only if the global-hook approach proves unsafe in the probe).
