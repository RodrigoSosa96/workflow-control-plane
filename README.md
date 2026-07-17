# AI Development Workflows

Control plane for Rodrigo's Pi + Herdr development workflow.

This directory stores project metadata and reusable workflow prompts. Application code remains in its original repository under `~/projects/work` or `~/projects/personal`.

## Installed foundations

- Herdr integration for Pi: `~/.pi/agent/extensions/herdr-agent-state.ts`
- Superpowers Pi package: `git:github.com/obra/superpowers`
- Project registry: `projects.yaml`
- Project-local Pi prompts: `.pi/prompts/`

After changing Pi resources, run `/reload` in an existing Pi session or restart Pi.

## Initial commands

From this directory, start Pi and use:

```text
/triage-asana ocr
/start-feature ocr ASANA-TICKET
/start-feature personalProjectB feature description
/resume-feature personalProjectA feature description
```

These prompts intentionally stop before implementation. The expected flow is triage → design/spec → approval → worktree → implementation → verification.

## Project layout policy

Use one Herdr workspace per product. Use a dedicated git worktree for each ticket or feature when an agent will write code. Keep runtime processes in a separate tab from interactive agent sessions.

Acme is a workspace grouping three independent repositories; its worktrees must be created from the specific backend, panel, or webapp repository.

## Next iteration

- Add a reviewed Asana integration and `asana-triage` skill.
- Add scripts for deterministic Herdr workspace/tab/worktree creation.
- Add a Pi command extension over those scripts.
- Normalize missing or misplaced project instructions, especially PersonalProjectD and Acme.
