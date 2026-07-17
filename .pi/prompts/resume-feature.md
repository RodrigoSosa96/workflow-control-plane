---
description: Recover the current state of an existing ticket or feature before continuing
argument-hint: "<project> [ticket-or-feature]"
---
Recover and assess the current state of: $ARGUMENTS

Do not change code until the recovery report is complete.

1. Resolve the project using `projects.yaml` and locate relevant branches, worktrees, and saved Pi sessions.
2. Inspect repository instructions and relevant local skills.
3. Read git status, recent commits, branch divergence, uncommitted changes, and available planning/progress/spec files.
4. Use `workflow status` when the task already has a launcher-managed workspace so the recovery report includes current worktree, tabs, agent, and runtime state.
5. If a ticket is provided and Asana is available, compare local state with the latest description, comments, dependencies, and acceptance criteria.
6. Determine:
   - what has been completed and verified;
   - what is partially implemented;
   - what remains;
   - decisions and assumptions already made;
   - blockers or context that may be stale;
   - the safest next concrete action.
7. Identify whether another active agent or worktree may be touching the same scope.
8. Use the launcher recovery output before rerunning `workflow start` or `workflow runtime`; request confirmation instead of auto-approving with `--yes`.
9. Return a concise recovery report and proposed continuation plan. Wait for confirmation before editing or running destructive commands.
