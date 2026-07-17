# Workflow Control Plane

This repository coordinates Rodrigo's AI-assisted development workflows across projects. It is not an application and must not contain copies of project source code.

## Purpose

- Keep the project registry in `projects.yaml`.
- Keep reusable Pi prompts under `.pi/prompts/`.
- Add shared workflow skills and Herdr automation here over time.
- Launch work inside the target repository or an isolated git worktree.

## Operating rules

- Ask which project and task are active before modifying another repository.
- Resolve project paths and runtime commands from `projects.yaml`; do not guess them.
- Treat Asana, meeting notes, and existing specs as context sources, not as permission to implement.
- For work projects, triage ticket context before selecting work.
- For feature implementation, prefer one git worktree per ticket or feature.
- Never run two writing agents in the same checkout concurrently.
- Keep persistent dev processes in a separate Herdr tab from interactive agents.
- Name Pi sessions and Herdr tabs after the project and ticket/feature.
- Do not expose secrets from `.env`, credentials, auth stores, or project integrations.
- Do not deploy, mutate production data, or run destructive migrations without explicit approval.
- Follow the target repository's own `AGENTS.md`, `CLAUDE.md`, and local skills after entering it.

## Workflow stages

1. **Triage:** gather ticket or feature context and identify missing information.
2. **Design:** use Superpowers brainstorming/spec workflow and obtain approval.
3. **Plan:** write and approve the implementation plan before launching work.
4. **Isolation:** create or select a dedicated worktree.
5. **Implementation:** execute the approved plan with relevant tests.
6. **Verification:** run repository checks and review the diff.
7. **Handoff:** summarize status, decisions, blockers, and next action.

## Current scope

The initial supported projects are ExampleProject, Acme, PersonalProjectD, PersonalProjectB, PersonalProjectC, and PersonalProjectA. Acme is a group of three independent git repositories rather than one monorepo.
