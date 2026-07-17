# Workflow Launcher Design

**Date:** 2026-07-17
**Status:** Approved

## Goal

Add a deterministic launcher to the workflow control plane that prepares isolated development environments across Rodrigo's registered projects. The launcher will create or recover Git worktrees, Herdr workspaces and tabs, named Pi sessions, and optional runtime panes from `projects.yaml`.

The launcher prepares an environment only after triage, design, and planning have been approved. It does not authorize implementation, modify Asana, deploy software, merge branches, or mutate production systems.

## Scope

The first version will support:

- Resolving a project and repository from `projects.yaml`.
- Producing a complete dry-run plan before mutation.
- Creating or reopening one Git worktree per ticket or feature.
- Using Herdr's native worktree workspace groups for ordinary repositories.
- Creating coordinated multi-repository ticket bundles for Acme.
- Creating an `agent` tab with a named Pi session.
- Creating a separate `runtime` tab from a configured runtime profile.
- Inspecting an existing environment without changing it.
- Recovering safely from resources that already exist or from partially completed launches.

The first version will not:

- Select a ticket automatically.
- Infer Acme repositories without showing them in the plan.
- Send an implementation prompt automatically.
- Run `git fetch`, rebase, reset, push, merge, or delete branches.
- Remove worktrees or close active workspaces automatically.
- Create pull requests or modify Asana.
- Install or depend on a third-party Herdr plugin.
- Modify Herdr core.
- Launch multiple writing agents for the same checkout.

## Workflow position

The complete development flow becomes:

1. **Triage:** gather complete task context and classify readiness.
2. **Design:** produce and approve a written design.
3. **Plan:** produce and approve a testable implementation plan.
4. **Isolation:** invoke the Workflow Launcher to create or recover the environment.
5. **Implementation:** execute the approved plan in the isolated checkout.
6. **Verification:** run configured repository checks and review the diff.
7. **Handoff:** record status, decisions, blockers, branch dependencies, and next action.

The launcher owns stage 4 and the terminal preparation needed for stages 5 and 6. It must refuse to treat task context as permission to implement.

## Approaches considered

### 1. Harness-independent workflow CLI with Herdr adapters — selected

Extend the existing Node.js control-plane package with a deterministic CLI. The CLI reads the registry, validates Git and Herdr state, computes an execution plan, and invokes Git and Herdr through subprocess adapters.

Advantages:

- Reusable from Pi, Claude Code, Codex, a shell, and future Herdr plugin actions.
- Testable with fake Git and Herdr executors.
- Supports a real `--dry-run` without opening terminals.
- Keeps orchestration logic outside Pi and Herdr UI integrations.
- Matches the CLI-plus-skill strategy already used for Asana.

Trade-off: the control plane must own idempotency, naming, and partial-failure recovery.

### 2. Herdr plugin first

A Herdr plugin can declare actions and event hooks and can call the full Herdr CLI. Existing community plugins demonstrate automatic layouts after `worktree.created`.

Rejected as the first layer because plugin actions are a host surface, not a replacement for project resolution, Asana-aware naming, multi-repository planning, and standalone testing. A thin plugin may wrap the stable CLI later.

### 3. Herdr core modification

Herdr core could add arbitrary workspace groups spanning unrelated repositories.

Rejected because ordinary repositories already have native parent/child worktree grouping. Arbitrary grouping would affect state persistence, sidebar and mobile rendering, navigation, close semantics, API schemas, events, and tests. Acme can be represented without maintaining a Herdr fork.

## Architecture

```text
projects.yaml
     |
     v
Registry loader and validator
     |
     v
Pure launch planner -----------------> human-readable / JSON dry run
     |
     v
Execution coordinator
     |-------------------|
     v                   v
Git adapter          Herdr adapter
     |                   |
     v                   v
worktrees          workspaces/tabs/panes/Pi
```

### Registry loader

Loads and validates the project registry before any command executes. It must reject unknown keys relevant to launcher behavior, missing paths, unsupported repository kinds, duplicate aliases, invalid branch templates, and runtime processes without commands.

The implementation may add a maintained YAML parser dependency rather than implementing an incomplete YAML parser. The zero-dependency constraint applied to the credential-sensitive Asana CLI and is not a requirement for the complete control-plane package.

### Pure launch planner

Produces an immutable plan containing:

- Project alias and label.
- Task identifier and slug.
- Repository or repositories involved.
- Base branches and target branches.
- Worktree paths.
- Herdr parent and task workspace labels.
- Agent and runtime tab layouts.
- Pi session names and launch arguments.
- Preconditions and conflicts.
- Ordered execution operations.

Planning performs read-only filesystem, Git, and Herdr inspection. It does not create directories, branches, worktrees, tabs, or processes.

### Execution coordinator

Executes the previously validated plan in order. Each operation reports one of:

- `created`
- `reused`
- `skipped`
- `failed`

The coordinator stops after a failed prerequisite and returns a recovery report. It does not roll back or delete successfully created Git resources automatically, because automatic rollback could destroy user work. Re-running the same request must recover by recognizing compatible resources.

### Git adapter

Uses argv-based Git subprocess calls rather than shell-concatenated commands. It is responsible for:

- Discovering repository roots and common Git directories.
- Listing existing worktrees and their branches.
- Validating base refs.
- Creating linked worktrees.
- Detecting branch/path collisions.
- Reporting dirty checkouts.

It never reads `.env` or credential files and never includes remote URLs or credential-bearing Git configuration in model-facing output.

### Herdr adapter

Uses Herdr's JSON CLI responses as its public interface. The raw socket API is unnecessary for v1. It is responsible for:

- Listing and locating workspaces, tabs, panes, and agents.
- Creating or opening native worktree workspaces.
- Creating and renaming tabs and panes.
- Starting Pi with a named session.
- Starting configured runtime commands.
- Returning stable resource identifiers to the coordinator.

The adapter must parse returned IDs; it must not guess IDs from creation order.

## Registry evolution

`projects.yaml` remains the canonical source. Version 2 adds launcher defaults and structured project layouts:

```yaml
version: 2

launcher:
  worktree_root: /home/you/.herdr/worktrees
  agent:
    command: pi
    session_template: "{project}-{task}-{slug}"

projects:
  example:
    path: /absolute/repository/path
    repository: monorepo
    base_branch: main

    worktree:
      branch_template: "feature/{task}/{slug}"
      path_template: "{worktree_root}/{project}/{task}-{slug}"

    runtime:
      default_profile: standard
      profiles:
        standard:
          processes:
            - id: backend
              cwd: .
              command: pnpm dev:api
            - id: frontend
              cwd: .
              command: pnpm dev:front
              split: right
              ratio: 0.5
```

Acme uses the same top-level defaults plus explicit coordination and child repositories:

```yaml
projects:
  acme:
    path: /home/you/projects/work/acme
    repository: group
    task_source: asana
    coordination:
      meta_repository: /home/you/projects/work/acme
      repos_directory: repos
    worktree:
      branch_template: "ticket/{task}/{slug}"
      path_template: "{worktree_root}/acme/{task}-{slug}"
    repositories:
      backend:
        path: /home/you/projects/work/acme/acme_backend
        base_branch: dev
        branch_template: "feature/{task}/{slug}"
      panel:
        path: /home/you/projects/work/acme/acme_panel
        base_branch: dev
        branch_template: "feature/{task}/{slug}"
      webapp:
        path: /home/you/projects/work/acme/acme_webapp
        base_branch: dev
        branch_template: "feature/{task}/{slug}"
```

Schema rules:

- `version` must be `2`; migration from version 1 is part of implementation.
- `launcher.worktree_root` and project/repository paths are absolute after `~` expansion.
- Ordinary projects require `path`, `repository`, `base_branch`, and `worktree`.
- Group projects require `coordination`, `worktree`, and at least one child under `repositories`.
- Supported template placeholders are exactly `{worktree_root}`, `{project}`, `{task}`, `{slug}`, and, for group children, `{repository}`.
- Unknown placeholders and unresolved placeholders are validation errors.
- Task and slug values are sanitized before use in branches, paths, labels, or session names.
- Each runtime process requires unique `id` and `command`; `cwd` defaults to `.`, `split` defaults to `right`, and `ratio` is optional in the open interval `(0, 1)`.
- Runtime commands come only from the trusted registry, never from ticket text.
- Existing verification commands remain independent from runtime profiles.

Before implementation, Acme's configured base branches must be reconciled with the actual repositories. The current checkouts track `origin/dev`, while the current registry says `master`; the launcher must not silently choose either value.

## CLI interface

The package will expose a second bin named `workflow` alongside the existing `asana-workflow` bin. `workflow` is currently absent from the target machine's `PATH`; installation tests must still detect and report a future collision rather than overwrite an unrelated executable silently.

```text
workflow doctor [project]
workflow plan <project> <task-or-feature> [options]
workflow start <project> <task-or-feature> [options]
workflow runtime <project> <task-or-feature> [options]
workflow status <project> <task-or-feature> [options]
```

### `doctor`

Read-only prerequisite check:

- Registry validity.
- Project and repository paths.
- Git availability and repository boundaries.
- Herdr availability and server compatibility.
- Pi availability and Herdr Pi integration status.
- Acme meta-repository and child repository configuration.

### `plan`

Produces the exact operations for a launch. It is always read-only and supports compact and JSON output. For Acme, `--repos backend,panel,webapp` selects the affected repositories.

### `start`

Recomputes and displays the plan, requires explicit confirmation in an interactive terminal or an explicit noninteractive approval flag, then:

1. Creates or reopens the worktree environment.
2. Creates or locates the Herdr task workspace.
3. Prepares the agent tab.
4. Starts Pi with the planned session name.

It does not submit a prompt to Pi. The user remains responsible for invoking the approved implementation or recovery workflow.

### `runtime`

Creates or locates the runtime tab and starts the selected profile. It is separate from `start` so expensive infrastructure and watchers remain opt-in.

### `status`

Read-only reconciliation report covering:

- Planned and actual branches and worktree paths.
- Dirty state.
- Herdr workspace and tabs.
- Pi session detection and agent status.
- Runtime pane process information.
- Missing, conflicting, or stale resources.
- Safe next command.

## Naming

All generated names derive from a normalized project alias, task identifier, and short slug.

Example for OCR:

```text
branch:       feature/ASANA-123/discovered-doc-filters
worktree:     ~/.herdr/worktrees/ocr/ASANA-123-discovered-doc-filters
workspace:    ASANA-123 discovered-doc-filters
agent tab:    agent
runtime tab:  runtime
Pi session:   ocr-ASANA-123-discovered-doc-filters
```

Rules:

- Preserve the original task identifier in visible names when safe.
- Slugs use lowercase ASCII letters, numbers, and hyphens.
- Labels are bounded to avoid unreadable Herdr sidebars.
- Branch conventions may vary per project and come from the registry.
- Existing compatible names are reused; incompatible collisions stop execution.

## Ordinary repository topology

OCR, PersonalProjectD, PersonalProjectB, PersonalProjectC, and PersonalProjectA use Herdr's native worktree model:

```text
project workspace (main checkout)
└── task workspace (linked worktree)
    ├── agent tab
    └── runtime tab
```

Flow:

1. Locate or open the parent workspace for the main checkout.
2. Run `herdr worktree create` when the branch/worktree is absent.
3. Run `herdr worktree open` when a compatible checkout already exists but is closed.
4. Reuse the already-open child workspace when Herdr reports one.
5. Rename the child workspace to the bounded task label when necessary.
6. Prepare tabs inside the child workspace.

Herdr retains native repository provenance and visually groups task workspaces under the parent checkout.

## Acme meta-repository

### Purpose

The Acme root becomes a lightweight coordination repository while backend, panel, and webapp remain independent repositories. It exists to hold shared instructions and cross-repository specifications, not application source or Git submodule pointers.

```text
acme/
├── .git/
├── .gitignore
├── AGENTS.md
├── README.md
├── projects.yaml
├── docs/
│   └── specs/
├── acme_backend/       # independent repository, ignored by meta-repo
├── acme_panel/     # independent repository, ignored by meta-repo
└── acme_webapp/    # independent repository, ignored by meta-repo
```

The three existing child checkout directories must be ignored before the first meta-repository commit. The launcher will not initialize this repository automatically; setup is an explicit prerequisite reviewed separately.

### Why no submodules

Submodules would add pinned commit pointers, detached-HEAD handling, recursive initialization, parent pointer commits, and additional CI/release semantics. Those costs are justified only if Acme formally needs reproducible product releases from exact child commits. They are unnecessary for coordinating development tickets.

### Ticket bundle

A cross-repository ticket uses a linked worktree of the meta-repository as its Herdr-native task workspace. Independent child worktrees are placed under an ignored `repos/` directory:

```text
acme/.worktrees/ASANA-123-onboarding/
├── AGENTS.md and coordination docs from meta-repo
└── repos/
    ├── backend/       # acme_backend linked worktree, if selected
    ├── panel/         # acme_panel linked worktree, if selected
    └── webapp/        # acme_webapp linked worktree, if selected
```

Only selected repositories are materialized. Child worktrees are created with Git directly rather than `herdr worktree create`; otherwise Herdr would open unrelated repository-group workspaces instead of keeping the ticket together.

### Herdr topology

```text
Acme meta workspace
└── ASANA-123 onboarding
    ├── coordinator tab
    ├── backend tab, when selected
    ├── panel tab, when selected
    ├── webapp tab, when selected
    └── runtime tab
```

The coordinator Pi session starts at the meta-worktree root and owns cross-repository planning, dependency tracking, and handoff. Repository-specific Pi sessions, if explicitly requested later, start in the corresponding child worktree so they load local instructions and skills.

V1 launches only the coordinator automatically. It creates repository tabs as shells ready for direct use. Automatic multi-agent delegation is outside scope.

### Cross-repository coordination manifest

Each Acme ticket bundle has a coordination manifest containing:

- Ticket identifier and title.
- Selected repositories.
- Base and feature branch for each repository.
- Integration dependencies and ordering.
- Repository-specific verification commands.
- Cross-repository smoke-test expectations.
- PR and deployment ordering when known.

The canonical reviewed specification belongs in the Acme meta-repository. Runtime Herdr IDs, process IDs, tokens, and machine-specific paths must not be committed to it.

A Acme task is not complete until each affected repository passes its checks and the handoff records cross-repository compatibility and merge/deploy ordering.

## Runtime layout

Runtime processes always use the task worktree, never the main checkout. A runtime profile creates a dedicated tab and one pane per configured process.

Requirements:

- Each pane has a stable process label.
- Pane working directories are explicit.
- Commands come from `projects.yaml`.
- Layout creation is deterministic and based on returned Herdr IDs.
- Re-running `runtime` does not start a duplicate when the matching pane still runs the expected command.
- A stopped or mismatched pane is reported; v1 asks before replacing it.
- Startup success means the process remains present after a short bounded observation period.
- Service health checks and browser verification are not implied unless explicitly configured in a later version.

Infrastructure commands remain opt-in even when they belong to the default profile.

## Idempotency and reconciliation

The launcher derives state from Git and Herdr rather than treating a private state file as authoritative.

For every requested resource:

- Missing resource: plan creation.
- Existing compatible resource: reuse it.
- Existing incomplete resource: continue from the first missing operation.
- Existing incompatible resource: stop and explain the conflict.

Compatibility checks include:

- Worktree path belongs to the expected Git common directory.
- Worktree branch matches the planned branch.
- Branch is not checked out in another incompatible path.
- Herdr workspace cwd matches the planned checkout.
- Tab label and pane process identities do not conflict.
- Acme child worktree paths correspond to the selected child repositories.

Herdr numeric IDs are runtime discoveries and are never used as durable identity. Cwd, Git provenance, branch, bounded labels, and process metadata form the reconciliation key.

## Failure handling

### Preflight failures

No mutation occurs when:

- Project or repository alias is unknown.
- Acme repository selection is missing or invalid.
- Base ref does not exist locally.
- Target branch/path is ambiguous or conflicting.
- Required parent checkout cannot be resolved.
- Herdr is unavailable or protocol-incompatible.
- Pi or its Herdr integration is unavailable for `start`.
- The registry contains invalid or unsafe commands/templates.

### Partial execution failures

If execution fails after creating resources, return:

- Operations completed.
- Operation that failed and bounded stderr.
- Resources that remain.
- Whether rerunning is safe.
- Manual inspection commands.
- Explicit cleanup options, without running them.

The launcher never automatically removes a worktree, branch, pane containing a running process, or Acme bundle after failure.

### Runtime failures

A runtime pane that exits immediately is marked failed. Other successfully started panes remain open for inspection. The command returns nonzero with the relevant pane output bounded and sanitized.

## Security

- Never read or print Asana tokens, `.env` files, auth stores, cookies, or Git credential helpers.
- Do not pass ticket descriptions or user-provided task text to a shell.
- Use argv arrays for Git, Herdr, and Pi process creation.
- Treat runtime commands in the versioned project registry as trusted local configuration.
- Bound subprocess output before returning it to an agent.
- Refuse destructive Git and Herdr operations in v1.
- Do not expose unrelated environment variables in plans or diagnostics.
- Do not start implementation merely because environment creation succeeded.

## Testing strategy

### Unit tests

- Registry validation and repository-kind handling.
- Placeholder expansion and sanitization.
- Branch, path, label, and session naming.
- Ordinary-repository planning.
- Acme one-, two-, and three-repository bundle planning.
- Runtime profile expansion.
- Conflict and compatibility classification.
- Compact and JSON plan formatting.

### Adapter tests

Use fake process executors to test:

- Git worktree parsing and argv construction.
- Herdr JSON response parsing and ID threading.
- Bounded/sanitized failures.
- No shell interpolation of ticket values.

### Integration tests

Use temporary Git repositories and a fake Herdr executable to verify:

- Fresh ordinary worktree launch.
- Re-running a completed launch.
- Recovery after worktree creation but before tab creation.
- Branch/path collision refusal.
- Acme bundle creation with two and three child repositories.
- Runtime layout and duplicate-process detection.

A separate opt-in smoke test may drive a real Herdr server against disposable repositories. It must not use the real OCR or Acme repositories.

### Manual validation

After automated tests pass:

1. Run `doctor` and `plan` for OCR.
2. Launch an approved disposable or real OCR ticket environment with no implementation prompt.
3. Verify native Herdr grouping, cwd, tab labels, Pi session name, and runtime opt-in.
4. Run `status`, detach, reattach, and run `start` again to confirm recovery.
5. After the Acme meta-repository is approved and initialized separately, validate a ticket bundle using at least two child repositories.
6. Confirm no source changes, secrets, Asana mutations, branch deletion, or deployment occurred during launcher validation.

## Future integration surfaces

After the CLI is stable:

- Add a small Herdr plugin action or popup that invokes the CLI.
- Add Pi commands such as `/project`, `/start-ticket`, and `/runtime` as thin wrappers.
- Consider a declarative layout plugin only if it removes code without weakening project-specific planning.
- Evaluate multi-agent orchestration such as pi-herd only after single-agent isolation and recovery are proven.
- Propose arbitrary workspace groups upstream to Herdr only if multiple unrelated-repository products need native sidebar grouping beyond Acme.

## Delivery sequence

1. Reconcile registry facts, especially Acme base branches.
2. Finalize and validate the launcher registry schema.
3. Implement read-only `doctor`, planning, naming, and `--dry-run`.
4. Implement ordinary Git/Herdr worktree reconciliation.
5. Implement agent-tab and named Pi launch.
6. Implement opt-in runtime profiles.
7. Initialize the Acme meta-repository as a separately reviewed setup task.
8. Implement Acme bundle planning and child worktrees.
9. Validate OCR end to end.
10. Validate a two-or-three-repository Acme ticket.
11. Add thin Pi or Herdr wrappers only after the CLI behavior is stable.
