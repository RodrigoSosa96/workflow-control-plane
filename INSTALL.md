# Installing the workflow control plane on a fresh machine

This repository is the coordination layer, not an application. It installs two global CLIs (`workflow` and `asana-workflow`) and provides Pi extensions and Claude/Codex hooks used by `workflow launch`.

## 1. Get this repository

```bash
git clone <url> /home/you/projects/personal/workflows
cd /home/you/projects/personal/workflows
```

Use the actual path where you keep the control plane. The examples below use `/home/you/projects/personal/workflows`; replace `you` with your Unix user.

## 2. Install the CLIs globally

```bash
npm install --global /home/you/projects/personal/workflows
```

Or with pnpm:

```bash
pnpm add --global /home/you/projects/personal/workflows
```

This exposes:

- `workflow` — the launcher and control-plane CLI.
- `asana-workflow` — read-only Asana triage CLI.

Make sure your npm/pnpm global `bin` directory is on `PATH`.

## 3. Configure Asana (for work projects)

Create the token file directly from your terminal. Do not paste the token into any agent transcript:

For zsh:

```zsh
mkdir -p ~/.config/workflows
chmod 700 ~/.config/workflows
read -r -s "ASANA_TOKEN?Asana token: "; echo
printf '%s' "$ASANA_TOKEN" > ~/.config/workflows/asana-token
unset ASANA_TOKEN
chmod 600 ~/.config/workflows/asana-token
```

For bash:

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

Bind projects in `config/asana-projects.json`, or copy that file to `~/.config/workflows/asana-projects.json` and override it per machine:

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

## 4. Configure the project registry

The launcher reads `projects.yaml` from this repository by default, but that file contains absolute paths tied to the original machine. On a new machine you should either:

- **Recommended:** copy `projects.example.yaml` to a machine-local path and override it:

  ```bash
  cp /home/you/projects/personal/workflows/projects.example.yaml ~/.config/workflows/projects.yaml
  # edit the paths inside
  export WORKFLOW_PROJECTS_FILE="$HOME/.config/workflows/projects.yaml"
  ```

- **Alternative:** edit `projects.yaml` directly in the repository (less portable, harder to share).

Each project entry must resolve to an absolute path. `~` expansion is supported; relative paths are rejected for security.

## 5. Install harness hooks and extensions

### Pi

Pi does **not** use scripts in `hooks/`. It loads TypeScript extensions from `.pi/extensions/`:

- `workflow-worker-lifecycle.ts` — drives the run-state machine from Pi events.
- `workflow-worker-observability.ts` — renders the workflow widget in Pi's UI.

When you run `workflow launch --agent pi-worker`, the launcher passes these extensions automatically via `--extension`. To use them outside the launcher, copy the two files into your Pi extensions directory (commonly `~/.pi/agent/extensions/`) and restart Pi.

### Claude

The launcher writes a per-run `--settings` file that wires:

- `hooks/claude-lifecycle.mjs` for `UserPromptSubmit`, `Stop`, and `SessionEnd`.
- `hooks/claude-statusline.mjs` for the status line.

No manual install is required. If you want to invoke the lifecycle hook by hand, run:

```bash
node /home/you/projects/personal/workflows/hooks/claude-lifecycle.mjs UserPromptSubmit
```

with the hook payload JSON on stdin and the required `WORKFLOW_*` environment variables exported.

### Codex

Codex uses a global `~/.codex/hooks.json` file. The launcher calls `ensureCodexWorkerHooks()` to additively merge the workflow entries without touching any existing hooks (for example, Herdr's own `SessionStart`).

To install manually:

```bash
node --input-type=module <<'EOF'
import { ensureCodexWorkerHooks } from "/home/you/projects/personal/workflows/src/workflow/codex-hooks.js";
await ensureCodexWorkerHooks({
  hooksPath: `${process.env.HOME}/.codex/hooks.json`,
  controlPlaneRoot: "/home/you/projects/personal/workflows",
});
console.log("Codex hooks installed");
EOF
```

Interactive Codex launches pass `--dangerously-bypass-hook-trust` so the worker does not stop for a trust prompt on every event.

## 6. Install and start Herdr

The launcher depends on a running Herdr server for workspaces, tabs, panes, and native worktrees. Install Herdr, start the server, and ensure the `herdr` CLI is on `PATH`.

Verify the whole stack:

```bash
workflow doctor ocr
```

## 7. Verify the launcher flow

From this directory, after a design and plan are approved:

```bash
workflow doctor ocr
workflow plan ocr ASANA-123 --feature "Discovered Docs"
workflow start ocr ASANA-123 --feature "Discovered Docs" --yes
workflow launch ocr ASANA-123 --agent pi-worker --prompt-file request.md --dry-run
```

## 8. Integrating another project

To register a new project:

1. Add it to your `projects.yaml` (or machine-local override).
2. Required fields:
   - `label`, `kind` (`work` or `personal`).
   - `path`: absolute path to the project checkout.
   - `repository`: `monorepo`, `single`, or `group`.
   - `base_branch`: branch used for new worktrees.
   - `task_source`: `asana` or `local`.
   - `default_agent_profile`.
   - `worktree.branch_template` and `worktree.path_template`.
3. For `group` projects (like Acme), also define:
   - `coordination.meta_repository` and `coordination.repos_directory`.
   - `repositories.<name>.path`, `base_branch`, `branch_template`.
4. The target repository should have its own `AGENTS.md` and/or `CLAUDE.md` with local rules.
5. Optionally define `verify` commands and `runtime` profiles in `projects.yaml`.

Keep application source code in the target repository. This control-plane repository only stores metadata, prompts, and shared skills.

## Uninstall

```bash
npm uninstall --global workflow-control-plane
```
