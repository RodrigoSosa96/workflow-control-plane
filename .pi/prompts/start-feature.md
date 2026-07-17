---
description: Start a ticket or personal feature through context, design, and worktree preparation
argument-hint: "<project> <ticket-or-feature>"
---
Prepare work for: $ARGUMENTS

Do not begin implementation immediately.

1. Resolve the project from `projects.yaml` and confirm the target repository. For Acme, identify which independent repository or repositories are affected.
2. Inspect the target repository's `AGENTS.md`, `CLAUDE.md`, relevant skills, current branch, worktrees, and working-tree status.
3. Gather the authoritative task context:
   - For work projects, inspect the complete Asana ticket and linked material.
   - For personal projects, inspect existing specs, roadmap notes, branches, worktrees, and prior session artifacts.
4. State what is known, assumptions, unanswered questions, dependencies, and acceptance criteria.
5. Use the applicable Superpowers brainstorming/design workflow before writing code.
6. Propose an isolation plan: existing worktree to resume or a new worktree, using the configured base branch and repository branch conventions.
7. Propose the Herdr layout and runtime commands needed for this task.
8. Present the resulting design/spec for approval. Wait for explicit approval before creating a worktree or implementing.
9. After the approved design and approved plan exist, propose the exact `workflow plan ...` dry-run command for this task.
10. Request confirmation before running workflow start; do not auto-approve with `--yes`.
