# AI Development Workflows

Control plane for Rodrigo's Pi + Herdr development workflow.

This directory stores project metadata and reusable workflow prompts. Application code remains in its original repository under `~/projects/work` or `~/projects/personal`.

## Installed foundations

- Herdr integration for Pi: `~/.pi/agent/extensions/herdr-agent-state.ts`
- Superpowers Pi package: `git:github.com/obra/superpowers`
- Project registry: `projects.yaml`
- Project-local Pi prompts: `.pi/prompts/`
- Pi worker observability widget: `.pi/extensions/workflow-worker-observability.ts` (packaged; loaded only by Workflow-launched Pi workers)

After changing Pi resources, run `/reload` in an existing Pi session or restart Pi.

## Initial commands

From this directory, start Pi and use:

```text
/triage-asana ocr
/start-feature ocr ASANA-TICKET
/start-feature personalProjectB feature description
/resume-feature personalProjectA feature description
```

These prompts intentionally stop before implementation. The expected flow is triage → design/spec → approval → implementation plan → `workflow plan` → confirmation → `workflow start` → implementation → verification.

## Project layout policy

Use one Herdr workspace per product. Use a dedicated git worktree for each ticket or feature when an agent will write code. Keep runtime processes in a separate tab from interactive agent sessions.

Acme is a workspace grouping three independent repositories; its worktrees must be created from the specific backend, panel, or webapp repository.

## Workflow launcher CLI

The repository also includes a deterministic `workflow` CLI for read-only planning, isolated workspace start, approved multi-harness launch runs, worker handoff, result inspection, runtime opt-in, and recovery status checks.

### Launcher safety boundaries

- `workflow doctor`, `workflow plan`, `workflow status`, `workflow result`, and `workflow reconcile` are read-only.
- `workflow start`, `workflow launch`, and `workflow runtime` require explicit confirmation or `--yes`; `workflow launch --yes` also requires the current `--approval-digest` from a dry-run preview.
- In other words, every mutating launcher command requires explicit confirmation or --yes.
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
workflow reconcile [project] --run <run-id>
workflow handoff <run-id> --input <run-directory>/handoff-input.json
workflow delegation result <run-id> <delegation-id>
workflow delegation reconcile <run-id> <delegation-id>
workflow runtime ocr ASANA-123 --feature "Discovered Docs" --profile standard --yes
workflow status ocr ASANA-123 --feature "Discovered Docs"
workflow plan acme ASANA-456 --feature Onboarding --repos backend,panel
```

Use `workflow plan` as the read-only environment checkpoint before `workflow start`. Use `workflow launch ... --dry-run` as the assignment preview checkpoint before `workflow launch --yes`: the preview prints the full approved assignment and an approval digest, and the non-dry launch recomputes the current preview before accepting that digest. If a launch is interrupted, inspect `workflow result <run-id>`, `workflow reconcile --run <run-id>`, and the preserved fallback terminal/workspace before retrying any mutating command.

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

External exit `0` means a current terminal result was available; exit `20` means pending, exit `21` means `result-stale`, and exit `22` means `manual-handoff-required`. `workflow reconcile [project] --run <run-id>` performs no repair, launch, cleanup, or destructive action; it emits exact safe next actions such as `workflow result`, `workflow status`, and the canonical `workflow handoff` command.

If the origin Pi session closes before an advisory delegation result is consumed, the result stays pending. A later coordinator session must explicitly adopt it; no cross-session result injection occurs automatically.

## Real harness canaries (interactive only)

Real canaries start an actual harness session and may consume API tokens. They are never run in CI or by `npm test`.

```bash
# Pi real canary — requires TTY, --keep, and typed confirmation
npm run smoke:fixture -- --real --agent pi --keep
```

Before starting, the script prints the fixture root, registry, tickets, exact assignment, and a token-cost warning. Real canaries require a TTY, `--keep`, and typed confirmation. Type the exact harness name (`pi`) to confirm. On failure or timeout the fixture root and run directory are preserved for inspection.

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
