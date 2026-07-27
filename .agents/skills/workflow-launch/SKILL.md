---
name: workflow-launch
description: Use when Rodrigo asks to implement tickets in separate sessions, spaces, or worktrees, to delegate implementation to Claude or Codex, to run several tickets in parallel, or to hand off an approved design or plan for isolated execution.
---

# Workflow Launch

Dispatch external worker sessions through the `workflow` CLI. Each launch creates an isolated
git worktree, opens a dedicated Herdr workspace with an agent tab, and starts a Pi, Claude, or
Codex session already bootstrapped: the worker's first prompt is submitted automatically and
points it at the generated `assignment.md`, which carries the request verbatim.

You CAN open Claude/Codex/Pi sessions yourself by running this CLI. Never claim that new
spaces or sessions must be created manually.

## Safety

- Read-only, run freely: `doctor`, `plan`, `status`, `result`, `reconcile`, `worker status`, `worker watch`.
- Mutating: `start`, `launch`, `runtime`, `resume`, `close`. Run them only after Rodrigo
  confirms the shown preview. Never add `--yes` on your own initiative.
- Pass the request only through `--prompt-file`; never inline ticket text into argv.
- One launch per ticket keeps contexts isolated. `--tickets a,b` bundles several tickets into
  ONE worktree and session — only when Rodrigo explicitly wants them together.
- Failed or partial launches preserve every resource (no-cleanup policy). Inspect with
  `workflow reconcile` and report; never delete worktrees, tabs, or run directories.

## Launch flow

1. Gather ticket context first (asana-triage skill for Asana work). Write a prompt file, e.g.
   `/tmp/launch-<ticket>.md`, containing: the context summary, acceptance criteria, and what
   the worker should do in its own session — typically brainstorm → spec → implementation plan
   → implement → verify. If an approved plan already exists, reference it instead.
2. Preflight: `workflow doctor <project> --agent <profile>`.
3. Preview: `workflow launch <project> <ticket> --prompt-file <path> --agent <profile> --feature "<short feature name>" --dry-run`.
   `--feature` (slugified) names the worktree directory, branch, Herdr workspace, and session;
   without it they all degrade to the bare ticket id repeated (`<id>-<id>`). Acme always
   needs `--repos` naming only the affected repositories (e.g. `--repos backend,webapp`).
4. Show Rodrigo the preview and its approval digest. Wait for explicit confirmation.
5. Execute: rerun the same command with `--approval-digest <digest> --yes`.
6. Repeat per ticket, then monitor.

## Choosing the harness

`--agent` selects a profile from `projects.yaml`: `pi-worker` (default), `claude-worker`,
`codex-worker`. If Rodrigo names one, use it. Otherwise recommend one and record why with
`--selection-reason`: `claude-worker` for complex, design-heavy, multi-file work;
`codex-worker` for well-scoped mechanical work; `pi-worker` to keep the Superpowers workflow.

## Monitor, recover, results

```bash
workflow worker status <run-id>   # snapshot of worker telemetry
workflow worker watch <run-id>    # live telemetry stream
workflow result <run-id>          # canonical result after the worker's handoff
workflow resume <run-id>          # relaunch a dead or closed session (confirm first)
workflow close <run-id>           # end a live session (confirm first)
```

## Common mistakes

| Mistake | Correction |
|---|---|
| "I can't create Claude/Codex spaces or sessions" | You can: `workflow launch --agent claude-worker` opens the space and starts the session. |
| Doing all design in the coordinator when Rodrigo asked for planning in the worker | Put the planning instructions in the prompt file; the worker plans inside its own session. |
| Offering internal pi subagents when Rodrigo asked for separate sessions | Internal delegations are advisory only; external workers produce the canonical result. |
| Bundling tickets with `--tickets` "for efficiency" | That is the opposite of isolation — one launch per ticket unless told otherwise. |
| Auto-approving with `--yes` | Dry-run preview + digest + Rodrigo's confirmation first, every time. |
| Acme launch without `--repos` | Acme must name the affected repositories explicitly. |
| Launch without `--feature` | Worktree, branch, and session end up named `<ticket-id>-<ticket-id>`; always pass a short descriptive feature name. |
| Reporting the retained top shell pane in a Acme launch as an error | It is deliberate: the group lane keeps a coordinator shell above the agent pane for manual cross-repository work. |
