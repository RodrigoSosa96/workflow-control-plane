# Workflow Control Plane

AI-assisted development workflow control plane for [Pi](https://github.com/earendil-works/pi), Claude, Codex, and [Herdr](https://herdr.dev).

This repository is a **control plane**, not an application. It stores project metadata, reusable agent prompts, shared workflow skills, and a deterministic `workflow` CLI that dispatches Pi, Claude, Codex, or OpenCode workers into isolated git worktrees. Application source code stays in its original repositories.

## Features

- Multi-harness agent launcher: Pi, Claude, Codex, and fixture-only OpenCode.
- Deterministic, read-only planning checkpoints before any mutation.
- One dedicated git worktree per ticket or feature.
- Herdr workspace, tab, pane, and runtime process orchestration.
- Structured worker handoffs and canonical results.
- Two-lane operator model: external workers produce canonical results; internal Pi delegations produce advisory evidence.
- Read-only Asana triage CLI with secure token handling.

## Install

```bash
npm install --global /home/you/projects/personal/workflows
```

Or with pnpm:

```bash
pnpm add --global /home/you/projects/personal/workflows
```

This installs both `workflow` and `asana-workflow`. For a full fresh-machine setup, see [`INSTALL.md`](INSTALL.md).

## Development

Run the test suite with:

```bash
npm test
```

To check what CI will say before pushing, `npm run test:ci-like` runs the same suite with the harness binaries stripped from `PATH`, the CI environment variables set, and this project's own `WORKFLOW_*`/harness-related environment variables cleared for the child process — so a developer's shell profile (`WORKFLOW_STATE_ROOT`, `CODEX_HOME`, and similar) can't leak state CI would never have. It cleans up after itself and exits with the suite's own exit code.

## Quick start

After the design and implementation plan are approved:

```bash
workflow doctor ocr
workflow plan ocr ASANA-123 --feature "Discovered Docs"
workflow start ocr ASANA-123 --feature "Discovered Docs" --yes
workflow launch ocr ASANA-123 --agent pi-worker --prompt-file request.md --dry-run
workflow launch ocr ASANA-123 --agent pi-worker --prompt-file request.md --approval-digest sha256:<digest> --yes
workflow result <run-id>
workflow status ocr ASANA-123 --feature "Discovered Docs"
```

## Safety boundaries

- `workflow doctor`, `workflow plan`, `workflow status`, `workflow result`, `workflow reconcile`, `workflow runs`, and `workflow inbox` are read-only.
- `workflow verify <run-id>` is not read-only: it executes the project's own `verify` commands as a real shell (which may write build artifacts, coverage, or caches) and appends its evidence to the run's event log through `store.appendEvent`, taking the run lock. It requires no confirmation or `--yes` — the same no-gate posture as `status`/`result`/`reconcile` — but it does mutate, unlike every command in the read-only list above.
- `workflow start`, `workflow launch`, and `workflow runtime` require explicit confirmation or `--yes`; `workflow launch --yes` and `workflow merge --yes` also require the current `--approval-digest` from a dry-run preview.
- `workflow merge <run-id>` is the most consequential mutation this CLI performs: `--yes` runs a real `git merge --no-ff --no-edit` that **advances the project's `base_branch` in the operator's own base checkout** — the branch their own terminal is very likely sitting on. It is gated exactly like `workflow launch`: `--dry-run` previews the exact argv and the predicted conflicts, and `--yes` is refused without the `--approval-digest` that preview printed. It never pushes, and it never writes anything inside the run's worktree.
- In other words, every mutating launcher command that changes what's approved or running requires explicit confirmation or --yes. `workflow verify` is the deliberate exception: it mutates only the run's own evidence log, never what's approved or running, and its cost is bounded by its own timeout rather than requiring a gate — including if the operator interrupts it early: `verify-runner.js` traps SIGINT/SIGTERM for as long as its own command is running and kills that command's whole process group before letting the CLI exit, so an impatient Ctrl-C bounds the same way the timeout does rather than orphaning the check in the background — the same no-gate posture as the read-only commands above. `workflow merge` is not an exception to that rule; it is its strictest application, and the only command here gated by both `--yes` and a digest.
- `workflow launch` reads the untrusted request only from `--prompt-file`; there is no `--prompt` option.
- The launcher follows a no-cleanup policy: failed or partial launches preserve worktrees, Herdr tabs/panes, run directories, and the fallback workspace for manual recovery.
- No external or internal lane performs automatic cleanup, reservation release, or process kill.

## Installed foundations

- Herdr integration for Pi: `~/.pi/agent/extensions/herdr-agent-state.ts`
- Superpowers Pi package: `git:github.com/obra/superpowers`
- Project registry: `projects.yaml`
- Project-local Pi prompts: `.pi/prompts/`
- Pi worker observability widget: `.pi/extensions/workflow-worker-observability.ts` (packaged; loaded only by Workflow-launched Pi workers)

After changing Pi resources, run `/reload` in an existing Pi session or restart Pi.

## Fresh machine setup

For a new machine, follow the full setup in [`INSTALL.md`](INSTALL.md). It covers:

1. Installing the `workflow` and `asana-workflow` CLIs globally.
2. Configuring Asana securely without exposing tokens in agent transcripts.
3. Using a machine-local `projects.yaml` (copy `projects.example.yaml` and set `WORKFLOW_PROJECTS_FILE`) instead of editing the committed registry.
4. Installing the harness lifecycle hooks:
   - **Pi** uses `.pi/extensions/` rather than `hooks/` scripts.
   - **Claude** hooks are generated per-run via `--settings`.
   - **Codex** hooks are additively merged into `~/.codex/hooks.json`.
5. Starting Herdr and verifying with `workflow doctor <project>`.

## Initial commands

From this directory, start Pi and use:

```text
/triage-asana ocr
/start-feature ocr ASANA-TICKET
/start-feature personalProjectB feature description
/resume-feature personalProjectA feature description
```

These prompts intentionally stop before implementation. The expected flow is triage → design/spec → approval → implementation plan → `workflow plan` → confirmation → `workflow start` → implementation → verification.

## Hook layout

Pi is wired through `.pi/extensions/` because it supports in-process TypeScript extensions; Claude and Codex are wired through stateless scripts under `hooks/` because they expose lifecycle hooks via external subprocess calls. All three harnesses end up driving the same neutral run-state machine in `src/workflow/lifecycle.js`.

Lifecycle hooks never break the worker they are attached to: every failure is swallowed. To keep that from hiding a broken hook contract after a harness upgrade, each swallowed error is also appended to a bounded, private `hooks-debug.log` inside the run directory. If generations stop advancing, a run sticks in `running`, or a statusline freezes, read that file first.

Telemetry recognizes only pinned harness versions and reports `unknown` for anything else. `workflow doctor` runs `<harness> --version` and reports it against the pinned set as a `telemetry:<harness>` check, so an upgrade that silently degrades telemetry is visible. A mismatch is a warning: it does not make `doctor` report the environment as unusable.

## Project layout policy

Use one Herdr workspace per product. Use a dedicated git worktree for each ticket or feature when an agent will write code. Keep runtime processes in a separate tab from interactive agent sessions.

Acme is a workspace grouping three independent repositories; its worktrees must be created from the specific backend, panel, or webapp repository.

## Workflow launcher CLI

The repository also includes a deterministic `workflow` CLI for read-only planning, isolated workspace start, approved multi-harness launch runs, worker handoff, result inspection, runtime opt-in, and recovery status checks.

### Launcher safety boundaries

- `workflow doctor`, `workflow plan`, `workflow status`, `workflow result`, `workflow reconcile`, `workflow runs`, and `workflow inbox` are read-only.
- `workflow verify <run-id>` is not read-only: it executes the project's own `verify` commands as a real shell (which may write build artifacts, coverage, or caches) and appends its evidence to the run's event log through `store.appendEvent`, taking the run lock. It requires no confirmation or `--yes` — the same no-gate posture as `status`/`result`/`reconcile` — but it does mutate, unlike every command in the read-only list above.
- `workflow start`, `workflow launch`, and `workflow runtime` require explicit confirmation or `--yes`; `workflow launch --yes` and `workflow merge --yes` also require the current `--approval-digest` from a dry-run preview.
- `workflow merge <run-id>` is the most consequential mutation this CLI performs: `--yes` runs a real `git merge --no-ff --no-edit` that **advances the project's `base_branch` in the operator's own base checkout** — the branch their own terminal is very likely sitting on. It is gated exactly like `workflow launch`: `--dry-run` previews the exact argv and the predicted conflicts, and `--yes` is refused without the `--approval-digest` that preview printed. It never pushes, and it never writes anything inside the run's worktree.
- In other words, every mutating launcher command that changes what's approved or running requires explicit confirmation or --yes. `workflow verify` is the deliberate exception: it mutates only the run's own evidence log, never what's approved or running, and its cost is bounded by its own timeout rather than requiring a gate — including if the operator interrupts it early: `verify-runner.js` traps SIGINT/SIGTERM for as long as its own command is running and kills that command's whole process group before letting the CLI exit, so an impatient Ctrl-C bounds the same way the timeout does rather than orphaning the check in the background — the same no-gate posture as the read-only commands above. `workflow merge` is not an exception to that rule; it is its strictest application, and the only command here gated by both `--yes` and a digest.
- `workflow start` and `workflow launch` are separate: `workflow start` preserves the original no-prompt workspace preparation semantics, while `workflow launch` creates an approved run assignment from `--prompt-file` and starts one selected worker harness.
- `workflow start` does not submit an implementation prompt automatically.
- Runtime processes stay opt-in through `workflow runtime`; `workflow start` prepares only the agent workspace.
- `workflow launch` reads the untrusted request only from `--prompt-file`; there is no `--prompt` option, and the file is read as bytes rather than shell-interpreted text.
- Launch previews show the selected shell-free argv; run and native session values generated after approval are displayed as explicit placeholders, never guessed or passed from request text.
- Private state lives under `projects.yaml` `launcher.state_root` (or `WORKFLOW_STATE_ROOT` for worker handoff) with private run directories, `assignment.md`, `handoff-input.json`, and canonical `result.json` artifacts.
- The launcher follows a no-cleanup policy: failed or partial launches preserve worktrees, Herdr tabs/panes, run directories, and the fallback workspace for manual recovery.
- Acme bundle planning must name the selected repositories explicitly with `--repos`.
- Real Acme meta-repository setup remains a separate explicit checkpoint after disposable verification; the launcher branch must not initialize or modify the real work project automatically.
- Native lifecycle hooks, exact external resume, and explicit close remain planned downstream work. They are not commands available in this release; if implemented, they will operate only on exact recorded worker identity and will never guess a recent session, scrape a terminal, or inject a result into another Pi session automatically.
- No external or internal lane performs automatic cleanup, reservation release, or process kill; preserved resources remain available for manual inspection.
- The one documented exception to that no-cleanup policy: `workflow unlock <run-id>` and `workflow delegation gate-clear <project>` can each remove exactly one piece of crash residue (a wedged run lock or reservation gate) — but only when the mutex's owner is proven dead, never when elapsed time alone suggests it. See "Recovering a wedged run lock or reservation gate" below.

### Two-lane operator model

The control plane runs two governed lanes. External Pi/Claude/Codex workers produce canonical Workflow results. Internal Pi delegations produce advisory evidence only. `workflow` remains authoritative for ticket identity, assignments, lifecycle, results, reservations, reconciliation, and all worktrees.

| Lane | Result contract | Session and governance | Current gate |
|---|---|---|---|
| External worker | Canonical external worker result via `workflow handoff` and canonical `result.json`. | Workflow-owned worktree, native lifecycle hooks, exact external resume/close only. | Operational after approved launch preview and exact handoff. |
| Internal delegation | Advisory internal delegation result via `workflow delegation handoff`, `workflow delegation result`, and `workflow delegation reconcile`. | Exact private session file below the parent run directory, Workflow child handoff plus origin-session watcher, later sessions require explicit adoption. | Read-only foreground/background fixtures first; background writers stay denied until the read-only and writer fixture gates pass, a separate canary is approved, and policy is reviewed. |

Internal child sessions are Workflow-private. They are never sourced from `~/.pi`, a package daemon, or global Pi state. The control plane does not install or use `pi-subagents`; it ships its own `.pi/agents` and `.pi/extensions` paths, watches only the exact origin session, keeps internal results advisory, and preserves the one writer per checkout rule.

Across both lanes there is no terminal scraping, no guessed recent session, and no automatic cleanup, release, or kill. Package or user-global Pi configuration is never the authority for delegation policy.

### Profile selection precedence

Profile selection precedence is: explicit --agent wins first, then the project default profile, then the global default profile. Project allowlists in `projects.yaml` still apply, so an explicit profile outside `allowed_agent_profiles` is rejected. Profiles define the harness (`pi`, `claude`, or `codex`), binary, safe arguments, and permissions such as Claude `permission_mode` or Codex sandbox/approval policy.

### Bundle semantics

Bundle semantics keep the primary ticket as the branch/session/worktree identity. Related tickets supplied with `--tickets` are normalized, sorted, de-duplicated, and included in the assignment, result expectations, Acme manifests, and status commands without changing the primary ticket path.

### Launcher command flow

Run these from this repository after the design and implementation plan are approved:

```bash
workflow doctor ocr
workflow plan ocr ASANA-123 --feature "Discovered Docs"
workflow start ocr ASANA-123 --feature "Discovered Docs" --yes
workflow launch ocr ASANA-123 --agent pi-worker --prompt-file request.md --dry-run
workflow launch ocr ASANA-123 --agent claude-worker --prompt-file request.md --dry-run
workflow launch ocr ASANA-123 --agent codex-worker --prompt-file request.md --dry-run
workflow launch ocr ASANA-123 --agent pi-worker --prompt-file request.md --approval-digest sha256:<digest> --yes
workflow result <run-id>
workflow verify <run-id>
workflow merge <run-id> --dry-run
workflow merge <run-id> --yes --approval-digest sha256:<digest>
workflow reconcile [project] --run <run-id>
workflow runs [project] [--state <state>] [--all]
workflow inbox [project]
workflow handoff <run-id> --input <run-directory>/handoff-input.json
workflow delegation result <run-id> <delegation-id>
workflow delegation reconcile <run-id> <delegation-id>
workflow delegation release <run-id> <delegation-id> --yes
workflow runtime ocr ASANA-123 --feature "Discovered Docs" --profile standard --yes
workflow status ocr ASANA-123 --feature "Discovered Docs"
workflow plan acme ASANA-456 --feature Onboarding --repos backend,panel
```

Use `workflow plan` as the read-only environment checkpoint before `workflow start`. Use `workflow launch ... --dry-run` as the assignment preview checkpoint before `workflow launch --yes`: the preview prints the full approved assignment and an approval digest, and the non-dry launch recomputes the current preview before accepting that digest. If a launch is interrupted, inspect `workflow result <run-id>`, `workflow reconcile --run <run-id>`, and the preserved fallback terminal/workspace before retrying any mutating command.

`workflow runs [project] [--state <state>] [--all]` is the read-only board across every project: it answers what is running and what needs input without already knowing a run id. It defaults to the live set — everything except `completed`, `failed`, and `interrupted`, since the control plane cannot tell "completed and merged" from "completed and forgotten" apart — `--all` shows every state, and `--state <state>` narrows to exactly one. `--format json` carries a documented per-run projection sized for a board — `id`, `directory`, `state`, `projectAlias`, `primaryTicket`, `harness`, `updatedAt`, and `repositories` (the field the compact table cannot render) — not the full run record; see `runProjection` in `src/workflow/format.js` and the correction in `docs/superpowers/specs/2026-08-04-workflow-runs-board-design.md`. An operator or script that needs the rest of a run's fields runs `workflow result <run-id>`.

`workflow inbox [project]` is the read-only answer to "which of my workers is waiting on me", across every project, without looking at panes. It starts from the same live-run set `workflow runs`' default view uses, asks Herdr for each run's live agent status exactly once, and reports three lists: `blocked` (an agent actually sitting at a permission prompt right now, per Herdr's live `agent_status` — distinct from `workflow runs --state blocked`, which only ever shows a worker that self-reported being stuck in its own handoff, never a live prompt); `waiting` (a non-terminal run whose own state already means it needs the operator — `manual-handoff-required`, `needs-input`, or self-reported `blocked` — decided by the run's state alone, regardless of whether its agent could be resolved or what status it reports, because that is what makes it wait on a human); and `unresolved` (an *active* run — `running`, `launching`, `idle-awaiting-handoff`, or `result-stale` — whose agent status could not be confirmed or classified: no pane id, no matching live agent, Herdr unreachable, or a status Herdr reported that this command does not recognize, all reported with a reason rather than silently dropped, because an inbox that omits what it could not check is worse than one that admits uncertainty). Exit code is always `0`, including a non-empty inbox: a blocked or waiting worker is information, not a failure. See `docs/superpowers/specs/2026-08-04-workflow-inbox-design.md` for the correlation defect this command works around (a resumed run's live pane lives at `transportIdentity.paneId`, not the stale top-level `paneId`) and why the command is anchored on runs rather than on Herdr's raw agent list.

`workflow verify <run-id> [--format compact|json]` re-runs the project's own `verify` commands (from the *current* registry, not a snapshot) once per repository the run recorded, inside the exact worktree paths that run used, and writes structured pass/fail evidence to the run's event log — so "verification: passed" is something an operator can check, not just something a worker claimed. It is the one command in this CLI that runs a real shell (`/bin/sh -c`), a documented, single-site departure from every other spawn's `shell: false`: these are the operator's own strings from their own registry, not a worker's, and they enter no approval digest. A run with no repositories recorded, a project missing from the registry, or a project with no `verify` commands is refused with that specific reason, and nothing is appended for a run that was never actually verified. Exit code reflects the outcome: `0` for a pass, `1` for a failure, `10` for a refusal. `workflow result <run-id>` then shows two labeled, never-merged sections: **Reported by the worker** (the handoff's own self-reported `verification[]`) and **Verified by `workflow verify`** (the recorded evidence, with when it last ran, or an explicit "no recorded evidence" line if `workflow verify` has never completed against the run). Neither section overwrites the other and no verdict is computed about a disagreement between them — a command the worker called `passed` that the evidence shows failing is the most useful thing this pairing can surface, and it is left for the operator to read. See `docs/superpowers/specs/2026-08-04-workflow-verify-design.md`.

`workflow merge <run-id> --dry-run` and `workflow merge <run-id> --yes --approval-digest <digest>` are the governed end of the arc: the one step that actually changes what the project *is*, brought inside the same preview -> digest -> execute envelope `workflow launch` puts around starting a worker. **`workflow merge --yes` is the most consequential mutation this CLI performs.** Every other mutating command either creates something isolated (a worktree, a run directory, a Herdr tab) or writes to the run's own private state; this one runs a real `git merge --no-ff --no-edit` that **advances the project's `base_branch` inside the operator's own base checkout** — the shared branch their own terminal is probably sitting on. That is why it is gated, and gated the same way `launch` is rather than by a y/N prompt: a prompt approves a rendering, a digest approves the exact commits.

- **It never pushes.** Publishing to a remote is an outward-facing act with its own approval question; local integration is a complete unit of work.
- **It never touches the run worktree.** Not the branch, not the HEAD, not one byte of its working tree. The merge runs in the base checkout, because `base_branch` is what has to advance and git forbids checking out a branch that is already checked out somewhere else. Cleanup of the worktree is item 2.5's, not this command's.
- **It merges; it does not rebase**, and always with `--no-ff` even when a fast-forward is available. The merge commit is the audit trail and makes the integration revertible as one unit, and it keeps the preview exact: with fast-forward allowed the shape of the outcome would depend on ancestry at execution time.
- **The source branch comes from the worktree, never from the run record.** `repositories[].branch` is a launch-time intention: on this machine two of eight real runs record a branch that has since been renamed or deleted. The preview resolves the worktree's actual `HEAD` branch and sha, names any disagreement with the record prominently, and folds it into the digest — it does not silently substitute, and it does not refuse.
- **Conflicts are predicted for every repository before anything runs**, with `git merge-tree --write-tree` (git >= 2.38), which performs the real three-way merge machinery without reading or writing any working tree, index, or ref. Any conflict blocks execution for the whole run. A `merge-tree` that cannot answer is a refusal, never "no conflicts" — as is a dirty base checkout, a base checkout whose `git status` cannot be read, or a base checkout that is not on `base_branch`.
- **Verification evidence is surfaced and digested, and gates nothing.** The preview names the latest `workflow verify` evidence — present or absent, passed or failed, when it ran, and whether the source commit is newer than it — and that status is part of the approval digest. So approving a merge means approving the merge *of these commits, with this verification status*; rerun `workflow verify` or push another commit and the previous approval goes stale. A run that has never been verified reports `Verification: none recorded` and can still be approved: the control plane surfaces, the operator decides. The run's own `state` is treated identically.
- **It is not atomic across repositories, and it says so.** A group project is several independent git repositories with no cross-repository transaction. Execution runs them in the order the run recorded, stops at the first failure, and reports what merged, what failed with git's own stderr, and what was never attempted — as `partial`, never as success.

Exit codes: `0` merged, `10` refused (including a missing, invalid, or stale digest), `11` blocked by conflicts (a conflicted `--dry-run` also exits `11`, so a script gating on it is never misled), `13` partial, `1` failed. `--format json` carries the full preview; if a very wide group project overflows the shared 12,000-character budget, the response degrades through two measured tiers that keep every repository's `argv` and the conflict counts rather than collapsing the envelope. Those tiers are bounded, not unconditional: measured against a worst-case fixture they cover up to about nine or ten repositories, beyond which the response falls back to a minimal `{command, runId, truncated, truncationMarker}` that keeps no argv at all. See the measured table above `MERGE_OVERFLOW_TIERS` in `src/workflow/format.js`. See `docs/superpowers/specs/2026-08-06-workflow-merge-design.md`, including its honest note that `merge-tree --write-tree` does write unreferenced loose objects — it touches no ref, index, or working tree, and `git gc` collects them, but "dry-run" is not literally zero bytes.

### Worker handoff and results

External workers write structured JSON only to `$WORKFLOW_RUN_DIR/handoff-input.json` and submit it with:

```bash
workflow handoff <run-id> --input <run-directory>/handoff-input.json
```

Internal Pi delegations keep their exact private session and bounded advisory artifacts below the parent run directory and submit only through the child handoff path:

```bash
workflow delegation handoff <run-id> <delegation-id> --input <run-directory>/delegations/<delegation-id>/handoff-input.json
```

`workflow result <run-id>` reads the canonical external worker result. `workflow delegation result <run-id> <delegation-id>` reads the current advisory internal delegation result, and `workflow delegation reconcile <run-id> <delegation-id>` reports exact private-session/process state plus next actions.

External exit `0` means a current terminal result was available; exit `20` means pending, exit `21` means `result-stale`, and exit `22` means `manual-handoff-required`. `workflow reconcile [project] --run <run-id>` performs no repair, launch, cleanup, or destructive action; it emits exact safe next actions such as `workflow result`, `workflow status`, and the canonical `workflow handoff` command. When the run's lock is currently held, it also reports the lock's age and ownership verdict — never inferring liveness from elapsed time — and, only once that verdict proves the owner dead, adds `workflow unlock <run-id> --yes` to those next actions; see "Recovering a wedged run lock or reservation gate" below.

If the origin Pi session closes before an advisory delegation result is consumed, the result stays pending. A later coordinator session must explicitly adopt it; no cross-session result injection occurs automatically.

### Delegation reservation capacity

Each internal delegation holds a reservation lease that counts against the per-project delegation policy (`totalInternal`, `writersTotal`, `writersPerCheckout`). A terminal delegation handoff releases its own lease automatically. If a delegation fails to start, its lease is retained for inspection, and `workflow delegation reconcile` reports it as `reservation.state: active`. Release it explicitly with:

```bash
workflow delegation release <run-id> <delegation-id> --yes
```

The command refuses while the delegation is still running, releases capacity only, and never touches worktrees, processes, sessions, or run state.

### Recovering a wedged run lock or reservation gate

The per-run write lock (`run.lock`) and the per-project delegation reservation gate are both mkdir-based mutexes: whichever process acquires one first embeds its own pid and start time in an owner marker before continuing. If that process crashes while holding one, the mutex stays wedged, and — following the no-cleanup policy above — nothing removes it automatically. Two commands can:

```bash
workflow unlock <run-id> [--yes]
workflow delegation gate-clear <project> [--yes]
```

Both are the one documented exception to the no-cleanup policy, and both are held to the same rule: they remove crash residue only when the mutex's owner is **proven dead**, never when elapsed time alone suggests it. `--yes` authorizes deleting proven-dead evidence; it can never substitute for the proof itself:

- The owner is proven dead only when the recorded pid no longer maps to the recorded start time: either no process holds that pid at all, or a different, unrelated process now does. A recycled pid is detected by comparing start times rather than trusting the pid number alone — the exact case a pid-only liveness check gets wrong, and the one that would otherwise leave the mutex wedged forever after a pid wraps around to a new process.
- A live owner (matching pid and start time) is always refused, `--yes` or not.
- A marker written before this mechanism existed (no recorded pid/start time — a "version 1" marker) is refused as unprovable for either mutex, never treated as removable just because it predates provable ownership. Process inspection itself failing is refused the same way, with a distinct reason.
- The run lock has one further ambiguous case: more than one owner marker present in its active lock directory is refused rather than guessing which is authoritative. The reservation gate's marker is matched by an exact, single-entry filename, so this case cannot arise there.
- The run lock's age is reported (`ageMs`/`stale`) for context, but age alone is never grounds for removal. The reservation gate carries no age or staleness concept — `workflow delegation gate-clear` reports only the marker version.
- Without `--yes`, both commands are read-only: they report the verdict and, when it is proven-dead, that confirmation is needed — no filesystem mutation happens. Confirmation only authorizes deleting proven-dead evidence, never the proof itself: removal is authorized against whatever marker is actually re-read at removal time, not the earlier snapshot, so it never removes a mutex whose current owner is not proven dead.
- Neither command touches worktrees, Herdr tabs/panes, sessions, processes, run state, or reservation leases: `workflow unlock` only unblocks a future write to the run, and `workflow delegation gate-clear` only unblocks a future `reserve()`/`release()` call for the project.
- Exit `0` covers no lock/gate present, awaiting confirmation, and successful removal. Exit `11` means refused — the owner is alive, the verdict is unprovable, or a store-level race prevented removal even though the marker itself was approved.

`workflow reconcile --run <run-id>` surfaces the same verdict for a held run lock without ever removing anything, per "Worker handoff and results" above.

### Handoff notifications

The launcher can run a best-effort notifier when a worker reaches a terminal state (handoff, stop, or session end). It is **passive and opt-in**: it may alert the user, but it never injects a result, command, or message into another agent session.

Enable it by creating an executable script at:

```bash
~/.config/workflows/handoff-notifier
```

or by pointing `WORKFLOW_HANDOFF_NOTIFIER` to any executable path:

```bash
export WORKFLOW_HANDOFF_NOTIFIER=/path/to/your/notifier
```

The script receives the run context as environment variables:

```text
WORKFLOW_NOTIFICATION_TYPE=handoff|stop|run
WORKFLOW_RUN_CONTEXT=handoff|lifecycle|stop
WORKFLOW_RUN_ID
WORKFLOW_RUN_STATE
WORKFLOW_RUN_STATUS
WORKFLOW_RUN_DIR
WORKFLOW_RESULT_PATH
WORKFLOW_RESULT_STATUS
WORKFLOW_RESULT_SUMMARY
WORKFLOW_HARNESS
WORKFLOW_RUN_ACTION         # only for stop notifications
```

An example is provided at `hooks/handoff-notifier.example.sh`. It uses `notify-send` on Linux and `osascript` on macOS.

### Pi coordinator awareness

When the launcher runs in a Pi coordinator session, the `workflow-coordinator` extension
watches the workflow event bus (`$WORKFLOW_STATE_ROOT/events.jsonl`). As soon as an
external worker hands off a terminal result (or stops/blocks without one), Pi receives
a follow-up message with the run ID, state, and a pointer to the canonical result:

```text
Un worker terminó: <run-id>
Estado: completed
Podés ver el resultado con: workflow result <run-id>
```

This lets the coordinator session become aware of finished work automatically. It does
not inject the full result into the conversation; it just tells you the worker is ready
so you can ask Pi to pull it when you return.

The event bus is the same mechanism that feeds the optional notifier script above, so
the desktop notification and the Pi message share one source of truth.

### Session-isolated launches from Pi

An active Pi coordinator can launch an external worker through the
`workflow_prepare_launch` and `workflow_execute_launch` tools. The extension takes the
current Pi session ID itself, keeps the approved preview in that session only, and requires
two UI approvals before mutation. A terminal event for that run returns only to the Pi
session that prepared it.

For a manual or non-Pi launcher, provide the same metadata explicitly:

```bash
workflow launch <project> <ticket> --prompt-file <path> --origin-session <id>
```

The origin is notification routing metadata, not result acceptance. Pi still receives only a
readiness notice and must read the canonical `workflow result <run-id>` before reviewing the
handoff.

## Real harness canaries (interactive only)

Real canaries start an actual harness session and may consume API tokens. They are never run in CI, by `npm test`, or by `npm run test:ci-like` (see "Development" above).

```bash
# Pi real canary — requires TTY, --keep, and typed confirmation
npm run smoke:fixture -- --real --agent pi --keep
```

Before starting, the script prints the fixture root, registry, tickets, exact assignment, and a token-cost warning. Real canaries require a TTY, `--keep`, and typed confirmation. Type the exact harness name (`pi`) to confirm. On failure or timeout the fixture root and run directory are preserved for inspection.

This is also the only place Herdr workspace/tab/pane orchestration is verified live: `--real --agent <harness> --keep` behind the same TTY and typed-confirmation gates, deliberately with no automated equivalent.

Inspection commands for a preserved canary:

```bash
WORKFLOW_PROJECTS_FILE=<fixture-registry> workflow result <run-id>
WORKFLOW_PROJECTS_FILE=<fixture-registry> workflow reconcile --run <run-id>
WORKFLOW_PROJECTS_FILE=<fixture-registry> workflow worker status <run-id>
```

Replace `<fixture-registry>` and `<run-id>` with the paths printed by the script.

## Asana workflow CLI

The repository includes a zero-dependency, read-only Asana CLI. It discovers workspaces, projects, current sections, assignees, and full ticket context without injecting MCP tool schemas into every model request.

### Install

After this feature branch is integrated, install the local package yourself:

```bash
npm install --global /home/you/projects/personal/workflows
```

This installs both `asana-workflow` and `workflow`.

Alternatively:

```bash
pnpm add --global /home/you/projects/personal/workflows
```

The implementation agent intentionally does not perform the global installation.

### Configure authentication securely

Create the token file directly from your terminal. Do not paste the token into Pi, Claude, or another agent transcript:

For zsh (Rodrigo's default shell):

```zsh
mkdir -p ~/.config/workflows
chmod 700 ~/.config/workflows
read -r -s "ASANA_TOKEN?Asana token: "; echo
printf '%s' "$ASANA_TOKEN" > ~/.config/workflows/asana-token
unset ASANA_TOKEN
chmod 600 ~/.config/workflows/asana-token
```

For bash, the hidden-input line is instead:

```bash
read -r -s -p 'Asana token: ' ASANA_TOKEN; echo
printf '%s' "$ASANA_TOKEN" > ~/.config/workflows/asana-token
unset ASANA_TOKEN
chmod 600 ~/.config/workflows/asana-token
```

Verify without displaying the token:

```bash
asana-workflow auth status
asana-workflow me
```

For temporary shell use, `ASANA_ACCESS_TOKEN` takes precedence. `ASANA_TOKEN_FILE` selects another token file.

### Discover and bind projects

Project and section names are not assumed to be stable:

```bash
asana-workflow workspaces
asana-workflow projects
asana-workflow sections --project <project-gid>
```

Bind `ocr` or another alias in `config/asana-projects.json` using `projectGid` (preferred) or an exact `projectName`. `workspaceGid` disambiguates name-based discovery. `activeSections` is optional; without it, triage scans every current section.

To keep machine-specific bindings outside this checkout, copy the JSON file elsewhere and set:

```bash
export ASANA_PROJECTS_FILE="$HOME/.config/workflows/asana-projects.json"
```

Example binding:

```json
{
  "version": 1,
  "projects": {
    "ocr": {
      "projectGid": "1234567890",
      "activeSections": []
    }
  }
}
```

### Triage and inspect

```bash
asana-workflow triage --project ocr --assignee me
asana-workflow triage --project ocr --assignee any
asana-workflow triage --project ocr --sections "Esta semana,Próximo sprint" --assignee me
asana-workflow task <task-gid> --full
asana-workflow attachments <task-gid>
asana-workflow attachment download <attachment-gid> --output /tmp/asana-attachment
```

Use `--format json` when a script needs normalized structured output. Compact text is the default to reduce model context usage.

### Uninstall

```bash
npm uninstall --global workflow-control-plane
```

If the command is not found after installation, confirm that the npm or pnpm global bin directory is on `PATH`. If an alias is unbound, run `asana-workflow projects` and configure its exact GID. A `429` error includes Asana's retry interval when available.

## Next iteration

- Add scripts for deterministic Herdr workspace/tab/worktree creation.
- Add a Pi command extension over those scripts.
- Normalize missing or misplaced project instructions, especially PersonalProjectD and Acme.

## License

AGPL-3.0. See [LICENSE](LICENSE).
