# Pi + Herdr Development Workflow Design

**Date:** 2026-07-17
**Status:** Approved and phase 1 initialized

## Objective

Use `/home/you/projects/personal/workflows` as Rodrigo's control plane for AI-assisted development without copying application source code into it. Pi provides the adaptable agent harness, Herdr manages persistent workspaces and terminals, and each target repository retains its own instructions, skills, runtime, git history, and worktrees.

## Observed workflow

Rodrigo normally creates a terminal workspace per product, opens one or more Claude Code sessions, checks Asana or meeting notes for work context, develops a Superpowers spec, and keeps backend, frontend, and workers running in separate panes or tabs. Work projects are ticket-driven; personal projects are driven by features, roadmap documents, and existing sessions.

The initial project set is:

- ExampleProject
- Acme backend, panel, and webapp as three independent repositories
- PersonalProjectD
- PersonalProjectB
- PersonalProjectC
- PersonalProjectA

## Chosen organization

### Control plane

The `workflows` repository owns:

- `projects.yaml`: canonical paths, repository boundaries, base branches, runtime commands, and verification commands.
- `.pi/prompts/`: reusable entry points for triage, starting a feature, and recovering an existing feature.
- `.agents/skills/`: shared procedural integrations such as Asana triage.
- Future scripts and Pi extensions that orchestrate Herdr without embedding project code.

Opening Pi in this repository is a coordination session. Implementation agents must run in the target repository or its dedicated worktree so Pi loads the correct local context and skills.

### Herdr layout

Use one Herdr workspace per product. Within a product:

- Give each active ticket or feature a named agent tab.
- Keep persistent backend, frontend, worker, and infrastructure processes in a separate runtime tab.
- Name Pi sessions, tabs, and worktrees after the project and ticket/feature.
- For Acme, create worktrees from the specific backend, panel, or webapp repository rather than the non-git group directory.

### Isolation

Use one git worktree per ticket or feature whenever an agent writes code. Never run concurrent writing agents in the same checkout. A second agent may review read-only, but alternative implementations require separate worktrees. This is especially important for OCR database migrations and generated metadata.

## Workflow stages

1. **Triage:** inspect complete ticket or feature context and classify readiness.
2. **Design:** use Superpowers brainstorming to produce an approved written spec.
3. **Plan:** create a testable implementation plan.
4. **Isolation:** create or resume the dedicated worktree.
5. **Implementation:** follow TDD and execute the approved plan.
6. **Verification:** run repository checks and inspect the final diff.
7. **Handoff:** record status, decisions, blockers, and next action.

Context sources such as Asana, meeting notes, attachments, existing branches, and prior specs inform the workflow but do not grant permission to implement or perform production changes.

## Pi foundations

Phase 1 installs:

- The official Herdr Pi state extension.
- The official Superpowers package for Pi.
- Named prompt templates for Asana triage, feature start, and feature recovery.
- A repository-level `AGENTS.md` that enforces project resolution, isolation, secret safety, and approval gates.

Useful Pi session behavior includes named sessions, `/resume`, `/tree`, `/fork`, `/clone`, model switching, steering messages, and queued follow-ups. Codex through the OpenAI subscription is the initial default model; other models can be used for design or independent review.

## Integration strategy

Prefer small, reviewed CLIs plus progressively disclosed skills for external systems. This keeps integrations usable by Pi, Claude Code, Codex, shell scripts, and Herdr while minimizing repeated tool-schema tokens. Add a Pi extension only when native commands, UI, lifecycle events, or custom tools provide a clear advantage.

Asana is the first integration. It starts read-only as a compact CLI and skill. MCP remains optional if future interactive write operations justify its schema and adapter overhead.

## Safety boundaries

- Never expose `.env`, tokens, cookies, auth stores, or integration credentials to model context.
- Do not deploy, mutate production data, or run destructive migrations without explicit approval.
- Use a permission gate or isolated environment for dangerous shell operations rather than relying only on unrestricted agent execution.
- Review third-party Pi packages and skills before installation because they execute with user permissions.

## Planned evolution

1. Complete the read-only Asana CLI and triage skill.
2. Add deterministic Herdr scripts for project, tab, agent, runtime, and worktree startup.
3. Wrap stable scripts with a focused Pi command extension.
4. Normalize missing or misplaced repository instructions, especially PersonalProjectD and the three Acme repositories.
5. Evaluate subagent tooling only after the single-agent workflow and isolation conventions are stable.
