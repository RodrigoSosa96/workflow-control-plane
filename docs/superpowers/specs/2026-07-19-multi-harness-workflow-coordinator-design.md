# Multi-Harness Workflow Coordinator Design

**Date:** 2026-07-19
**Status:** Approved

## Goal

Extend the deterministic Workflow Launcher with an auditable Pi coordinator that can prepare and launch isolated workers in Pi, Claude Code, or Codex, return structured results to the originating Pi session when possible, recover when sessions or agents disappear, and group explicitly related tickets in one worktree under a primary ticket.

The extension preserves the control plane's existing safety properties: task context is not implementation permission, every mutating launch has an exact preview and explicit confirmation, only one writing agent may own a checkout, and no branch, worktree, workspace, process, or production resource is deleted automatically.

## Scope

This design adds:

- Named agent profiles for Pi, Claude Code, and Codex.
- Explicit harness selection with a project default and a coordinator recommendation path.
- A new `workflow launch` command that remains separate from `workflow start`.
- An exact assignment preview before the initial prompt is delivered.
- Persistent run state and structured handoff artifacts outside target repositories.
- Non-blocking launches with later result delivery to an originating Pi session.
- Native lifecycle hooks for Pi, Claude Code, and Codex.
- Generation-based invalidation when a user sends follow-up prompts directly to a worker.
- Resume, result, and reconciliation operations for interrupted runs.
- Explicit multi-ticket bundles in which a primary ticket owns the worktree identity.
- A thin Pi coordinator extension and a conservative, pinned `pi-subagents` installation.
- Generated disposable projects for automated tests, real Herdr smoke tests, and opt-in real-agent canaries.

This design does not add:

- Automatic ticket selection or automatic ticket grouping.
- Automatic implementation based only on Asana or meeting context.
- Multiple writing agents in one checkout.
- Terminal-screen scraping as a result protocol.
- Automatic prompts without preview and confirmation.
- Permission bypasses, unrestricted sandboxes, or hook-trust bypasses.
- Automatic fetch, rebase, reset, push, merge, deployment, production mutation, branch deletion, worktree removal, workspace closure, or process termination.
- Internal `pi-subagents` worktree management, watchdogs, or experimental async delegation.
- `pi-dynamic-workflows` as an orchestration dependency.
- Modifications to the real Acme meta-repository without a separate explicit approval.

## Approaches considered

### 1. Deterministic CLI, thin Pi extension, and `pi-subagents` — selected

The `workflow` CLI owns registry validation, planning, Git and Herdr reconciliation, run state, harness adapters, and handoff validation. A project-local Pi extension provides natural coordinator tools, user confirmation, background notifications, and result adoption. `pi-subagents` supplies internal Pi scouts, implementers, and reviewers through its public delegation and background-work APIs.

Advantages:

- The critical lifecycle remains usable from Pi, Claude, Codex, shell scripts, and tests.
- Existing planner and adapter abstractions remain the source of truth.
- Cross-harness behavior can be tested without model calls.
- The Pi integration stays replaceable and small.
- Superpowers workflows remain available to internal Pi workers.

Trade-off: native lifecycle integrations must be maintained for three harnesses.

### 2. Pi-extension-centric orchestration

A Pi extension would directly own Git, Herdr, prompt dispatch, and state.

Rejected because it would duplicate the existing CLI, make reuse from Claude and Codex difficult, and couple recovery behavior to one Pi session.

### 3. `pi-dynamic-workflows` as the primary engine

JavaScript workflows and in-process agents would own orchestration.

Rejected for this phase because the engine does not by itself provide Herdr workspaces, interactive Claude/Codex sessions, cross-harness hooks, or the launcher's conservative resource lifecycle. It remains a possible future engine for large read-only fan-out.

## Architecture

```text
Natural request
      |
      v
Pi coordinator extension
  |-- Asana read-only triage
  |-- profile recommendation
  |-- exact assignment preview
  |-- explicit confirmation
  |-- background result adoption
      |
      v
workflow CLI / core
  |-- registry and profile validation
  |-- primary/related ticket normalization
  |-- pure launch planning
  |-- Git and Herdr adapters
  |-- harness adapters
  |-- run store and reconciliation
      |
      +--------------------+--------------------+
      v                    v                    v
     Pi                 Claude Code            Codex
 lifecycle extension   native hooks/profile   native hooks/profile
      |                    |                    |
      +--------------------+--------------------+
                           v
                  private run directory
                 assignment / events / result
```

The CLI is the only component allowed to declare a run operationally complete. Model prose, terminal idle state, process exit, and Git changes are evidence, not completion on their own.

## Registry and agent profiles

`projects.yaml` remains canonical. The launcher evolves from one global Pi command to named profiles:

```yaml
version: 3
launcher:
  worktree_root: /home/you/.herdr/worktrees
  state_root: ~/.local/state/workflow-launcher
  default_agent_profile: pi-worker
  agent_profiles:
    pi-worker:
      harness: pi
      command: pi
      mode: interactive
      roles: [coordinator, implementer, reviewer]
      model: null
      arguments: []
    claude-worker:
      harness: claude
      command: claude
      mode: interactive
      roles: [implementer, reviewer]
      model: null
      permission_mode: default
      arguments: []
    codex-worker:
      harness: codex
      command: codex
      mode: interactive
      roles: [implementer, reviewer]
      model: null
      sandbox: workspace-write
      approval_policy: on-request
      arguments: []
  max_bundle_tickets: 10
```

Projects may override `default_agent_profile` and restrict `allowed_agent_profiles`. A model value of `null` preserves the harness user's configured default. Profiles may select a model explicitly when the project requires it.

Validation rules:

- Profile names and harnesses are from closed sets.
- Commands are executable names or absolute paths, never shell fragments.
- Arguments are argv entries and never interpreted by a shell.
- Interactive mode is the only external-worker mode in the initial release.
- A project default must reference an allowed profile.
- `max_bundle_tickets` is a positive bounded integer and defaults to 10.
- Pi profiles reject permission-bypass arguments configured by this control plane.
- Claude profiles reject `--dangerously-skip-permissions` and equivalent bypass modes.
- Codex profiles reject `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, and equivalent bypasses.
- The per-run private directory is the only writable path outside the ticket checkout that the launcher adds.
- Registry migration preserves the existing `launcher.agent.command` behavior by generating a compatible Pi profile.

`workflow doctor [project]` reports the readiness of configured profiles without exposing auth details. Launching one selected profile only requires that profile's binary, integration, and hook prerequisites; a missing Claude installation must not prevent a Codex launch.

## Agent selection

Selection precedence is:

1. An explicit user selection.
2. A Pi coordinator recommendation among project-allowed profiles.
3. The project default.
4. The global default.

The CLI never asks a model to choose a profile. The coordinator must pass a concrete profile or allow the deterministic default chain to resolve one. Before confirmation, the plan displays:

- Profile and harness.
- Selection source and coordinator explanation, when present.
- Model or inherited-default marker.
- Permission mode, sandbox, and approval policy.
- Checkout and run-directory writable roots.
- Exact argv with sensitive values redacted.

An explicit `--agent <profile>` always wins. The coordinator may recommend another profile, but the recommendation and reason are part of the approved preview.

## Multi-ticket bundles

A bundle has exactly one primary ticket and zero or more related tickets.

```text
Primary: SHARY-123
Related: SHARY-140, SHARY-152
```

Rules:

- Grouping is explicit and never inferred automatically.
- Every ticket belongs to the same registered project.
- The primary ticket defines task identity, branch names, worktree paths, workspace labels, session names, and feature slug.
- Related ticket identifiers are normalized, deduplicated, sorted, and stored as metadata.
- The primary identifier cannot reappear in the related list.
- The total count cannot exceed `max_bundle_tickets`.
- The coordinator retrieves read-only context and readiness for every ticket before launch.
- A ticket that is missing required context or is not ready blocks launch rather than being silently dropped.
- One confirmation approves the complete set.
- Exactly one writing agent owns the resulting checkout.
- The handoff reports status and evidence for every ticket.
- Existing worktree compatibility requires the same primary ticket, feature slug, repository set, and target branches. Related-ticket changes require a new launch run but may reuse a compatible checkout after preview.

For Acme, `--repos` applies to the complete ticket bundle. The child repositories remain independent Git repositories. This design does not initialize or alter the real Acme coordination repository.

Existing commands accept `--tickets <csv>` so `plan`, `start`, `runtime`, and `status` describe the same checkout identity. Example:

```bash
workflow start acme SHARY-123 \
  --tickets SHARY-140,SHARY-152 \
  --feature onboarding \
  --repos backend,panel
```

## Separate launch command

`workflow start` keeps its current contract: it prepares the environment and starts the configured default agent shell behavior without delivering an implementation assignment.

`workflow launch` is a separate, higher-risk operation:

```bash
workflow launch acme SHARY-123 \
  --tickets SHARY-140,SHARY-152 \
  --feature onboarding \
  --repos backend,panel \
  --agent claude-worker \
  --prompt-file /private/path/request.md
```

Launch flow:

1. Validate registry, project, tickets, profile, prompt file, Git, Herdr, and harness prerequisites.
2. Build a pure launch plan.
3. Build the complete assignment while preserving the original request verbatim.
4. Display all operations, permissions, ticket identities, and the assignment.
5. Require explicit confirmation.
6. Revalidate preconditions to limit time-of-check/time-of-use drift.
7. Create or reuse the isolated environment.
8. Create a private run directory and immutable assignment.
9. Start the selected harness in Herdr.
10. Capture its native session handle when available.
11. Deliver a short initial instruction directing the worker to the assignment and handoff contract.
12. Return the run ID after the worker is observed as running or interactively ready.

`workflow launch --dry-run` produces the full launch plan and exact assignment without mutation. Machine callers use JSON output for preview, then invoke an approved execution with `--yes`. Interactive execution may present a terminal confirmation. Non-interactive mutation without `--yes` fails closed.

Assignments are passed through a private file, not a long command-line argument. The harness receives only a bounded bootstrap instruction containing the run path. The assignment contains:

- Run and generation identifiers.
- Original user request verbatim.
- Resolved project, checkout, repositories, and tickets.
- Current workflow stage.
- Approved scope and constraints.
- Harness assignment and role.
- Required verification and review expectations.
- Handoff schema and result path.
- Explicit prohibition on cleanup, deploy, push, production mutation, and permission bypasses.

Ticket descriptions and meeting notes remain context, not permission. Secrets are not copied into assignments.

## Harness adapters

A common adapter interface owns profile-specific behavior:

```text
validate(profile, environment) -> diagnostics
buildLaunch(profile, run, checkout) -> argv + env
captureSession(runtimeState) -> native session reference | null
buildResume(profile, run, sessionReference) -> argv + env
```

### Pi

The adapter passes a named session, optional model/thinking configuration, the ticket checkout, the run directory, and the workflow lifecycle extension. It uses argv execution. A child Pi session does not become a second writer in a checkout already owned by another worker.

### Claude Code

The adapter passes the checkout, optional model, normal permission mode, the per-run directory as the only extra directory, and generated lifecycle settings. It records Claude's native session ID from hooks or Herdr integration. No permission bypass is allowed.

### Codex

The adapter passes the checkout, optional model, `workspace-write` sandbox by default, `on-request` approvals by default, the per-run directory as the only added writable directory, and a reviewed lifecycle hook profile. It records the native thread/session ID from hooks or Herdr integration. It never uses full-access or hook-trust bypass flags.

All adapters use `herdr agent start <name> -- <argv...>`. Agent identity reconciliation includes profile, harness, checkout, command, run ID, and captured session reference. An existing incompatible process is never replaced automatically.

## Persistent run store

Run state lives outside the repository:

```text
~/.local/state/workflow-launcher/runs/<run-id>/
├── assignment.md
├── run.json
├── current-generation.json
├── events.jsonl
├── result.json
├── results/
│   └── generation-<n>.json
└── hooks/
    ├── claude-settings.json
    └── codex-profile metadata
```

Directories are created with mode `0700`; control-plane-created files use `0600`. Result files created by workers are normalized to `0600` after validation. Run identifiers are unguessable and path-safe. State writes use temporary files and atomic rename; concurrent updates use an explicit lock with bounded waiting and stale-lock detection.

`run.json` records:

- Schema version and run ID.
- Project and primary/related ticket identities.
- Checkout, selected repositories, branches, and worktree paths.
- Agent profile, harness, selection source, and sanitized argv.
- Herdr workspace, tab, pane, and terminal references.
- Native harness session reference when available.
- Assignment digest and generation.
- Originating Pi session reference when available.
- State transitions and timestamps.
- Git fingerprints per repository.
- Last result-consumption event.

The store contains no auth token, environment dump, `.env` content, or credential-store path.

## Lifecycle and generations

Run states are:

```text
planned
launching
running
idle-awaiting-handoff
needs-input
completed
blocked
failed
interrupted
manual-handoff-required
result-stale
```

A run begins at generation 1. Lifecycle integrations implement the following protocol:

### Session start

- Validate `WORKFLOW_RUN_ID` and the private run directory.
- Record the native session ID and harness.
- Mark the process active.
- Reject a hook event whose harness, checkout, or run identity does not match.

### User prompt submit

Every initial or follow-up prompt received by the worker increments or confirms a generation according to an idempotent event ID. A later user prompt:

- Archives the prior result.
- Invalidates terminal status from an earlier generation.
- Records a fresh pre-turn Git fingerprint.
- Moves the run to `running`.

This includes prompts typed directly in the Claude or Codex terminal rather than sent by the Pi coordinator.

### Stop

Before a normal agent turn stops, the native hook checks for a valid handoff for the current generation. The worker must report one of:

- `completed`
- `blocked`
- `needs-input`
- `failed`

If the handoff is absent or invalid, the hook returns a continuation instruction explaining exactly how to create it. The integration makes at most two workflow-owned continuation attempts, below each harness's own safety cap. After that it allows the turn to stop and records `manual-handoff-required`; it never creates an infinite model loop.

A Stop hook is a safety net, not permission to run more implementation beyond the approved assignment. A `needs-input` handoff is the correct way to pause for a human decision.

### Session end and hard interruption

A normal SessionEnd event records the session closure. It cannot block a user from closing a harness. If the current generation has a valid handoff, that result remains available. Otherwise the run becomes `interrupted` or `manual-handoff-required`.

A process kill, Herdr closure, host restart, or crash may skip native hooks. Later reconciliation compares Herdr, process, Git, and run-store state and marks the run interrupted. The worktree and remaining resources are preserved.

## Handoff contract

A worker writes a temporary file and atomically renames it to `result.json`. The schema is versioned and bounded:

```json
{
  "version": 1,
  "runId": "019...",
  "generation": 2,
  "status": "completed",
  "summary": "Implemented the approved assignment.",
  "tickets": [
    {
      "id": "SHARY-123",
      "status": "completed",
      "evidence": ["Added validation and passing tests"]
    }
  ],
  "repositories": [
    {
      "id": "backend",
      "head": "abc123...",
      "worktreeFingerprint": "sha256:...",
      "changedFiles": ["src/example.ts"]
    }
  ],
  "verification": [
    {
      "command": "pnpm test",
      "status": "passed",
      "summary": "42 tests passed"
    }
  ],
  "decisions": [],
  "concerns": [],
  "nextAction": "Request code review"
}
```

Validation requires:

- Exact schema version, run ID, and generation.
- A known terminal or pause status.
- Exactly the expected primary and related tickets, each with status and evidence.
- Known selected repository IDs only.
- Bounded strings, arrays, file count, and total file size.
- Relative changed-file paths without traversal.
- Current Git fingerprints matching reported fingerprints.
- No secrets or raw environment values in known sensitive fields.

An artifact whose generation or Git fingerprint is no longer current is archived and exposed as `result-stale`, never accepted as current completion.

## Returning results to Pi

`workflow launch` is non-blocking and returns after startup with:

- Run ID.
- Harness and profile.
- Workspace, tab, and agent references.
- Result and status commands.

The Pi coordinator extension registers the run as background work. When a current valid result appears, it:

1. Appends a consumption event atomically.
2. Associates the result only with the originating Pi session.
3. Injects a bounded structured summary into that session.
4. Triggers a Pi turn only when the coordinator is idle.
5. Offers the next approved action, such as independent review.

No terminal output is scraped. If no artifact appears, the extension reports the workspace and `manual-handoff-required` fallback.

If the originating Pi session has closed, the result remains unconsumed. A later coordinator session can list pending runs and explicitly adopt one. Results are not injected automatically into an unrelated Pi session.

```bash
workflow result <run-id> [--format compact|json]
workflow reconcile <project> [--run <run-id>] [--format compact|json]
```

The Pi coordinator can understand operational completion from run metadata, Herdr state, Git fingerprints, validation evidence, and an independent review report without rereading the entire source tree. Semantic correctness still requires repository checks and review of the relevant diff; reconciliation does not claim otherwise.

## Resume and follow-up

```bash
workflow resume <run-id> [--prompt-file <path>] [--dry-run] [--yes]
```

Resume behavior:

- If the original agent is alive, `resume` focuses or targets that exact agent and previews any follow-up prompt before delivery.
- If the process is gone and a stable native session reference exists, the harness adapter previews and resumes that exact session.
- If no safe session reference exists, the command refuses to guess `--last`. It proposes a new run containing the previous handoff and current Git state as context.
- A follow-up prompt increments the generation and invalidates the earlier result.
- Assignment, profile, checkout, and ticket-set changes are shown before confirmation.
- Resume never starts a second writer while the original writer is still active.

## Reconciliation

Reconciliation derives truth from:

- Run-store state and event sequence.
- Current Herdr workspaces, tabs, panes, agents, and reported statuses.
- Foreground process identity.
- Native harness session references when available.
- Git HEAD, branch, worktree registration, dirty status, and a deterministic status/diff fingerprint for each selected repository.
- Current handoff and generation.
- Verification and independent-review artifacts.

It can conclude:

- The worker is active.
- The worker is idle and owes a handoff.
- The worker closed after a valid handoff.
- The worker disappeared without a handoff.
- A result is stale because a later prompt or Git change occurred.
- The environment is partially launched and recoverable.
- Manual intervention is required.

It cannot conclude semantic correctness solely from an idle terminal, an agent claim, or a clean working tree.

## Closing and cleanup

Completion does not close anything automatically. The coordinator offers:

1. Inspect the result.
2. Run an independent reviewer.
3. Open or focus the worker workspace.
4. Explicitly close only the worker process or tab after confirmation.
5. Keep all resources.

A close operation records user intent and revalidates process identity before sending a normal shutdown. It does not kill an unknown process. Branch deletion, worktree removal, workspace deletion, run-artifact pruning, and repository cleanup remain outside this feature and require separately designed explicit commands.

Models are instructed not to close or clean their own environment. Cleanup is a control-plane responsibility, never a handoff side effect.

## Pi coordinator extension

A project-local Pi extension exposes focused tools and commands rather than duplicating the CLI:

- Plan a launch and render its exact assignment.
- Ask for interactive confirmation.
- Execute an approved plan.
- List and adopt pending runs.
- Reconcile a run.
- Resume a run with a previewed follow-up.
- Show or focus the worker workspace.

The extension uses Asana through the existing read-only `asana-workflow` CLI and resolves all project paths through `projects.yaml`. It preserves the original user request verbatim and adds resolved context around it.

The extension must not let a model bypass its confirmation UI. In non-interactive Pi modes, mutating tools fail closed and return a command the user can approve explicitly.

## `pi-subagents` policy

Install `pi-subagents` locally to the workflow control-plane project, pinned initially to `0.34.0`. The integration uses conservative settings:

- Maximum concurrency: 3.
- Maximum delegation depth: 1.
- No internal worktrees.
- No watchdog.
- No experimental async/background mode for writing work.
- No automatic resource cleanup.
- No parallel writers in one checkout.

Initial roles are:

- `sdd-implementer`
- `spec-reviewer`
- `code-reviewer`

The Workflow Launcher owns external Pi/Claude/Codex processes and their worktrees. `pi-subagents` is used for bounded internal delegation and independent reviews through public APIs. `pi-dynamic-workflows` is not installed in this phase.

Package installation and any user-level hook trust are explicit implementation checkpoints. No installer may silently use dangerous hook-trust flags.

## Native hook integrations

A shared deterministic callback processes native lifecycle input:

```text
workflow-handoff-hook session-start
workflow-handoff-hook prompt-submit
workflow-handoff-hook stop
workflow-handoff-hook session-end
```

It receives event JSON on stdin and locates the run only through validated environment variables. It does not execute ticket text or model output as shell code.

- Pi loads a workflow lifecycle extension for launched Pi workers.
- Claude receives a generated settings layer referencing the fixed callback.
- Codex uses a reviewed and explicitly trusted hook profile/plugin referencing the fixed callback.

Skills and assignment instructions teach the worker how to produce a useful handoff. Hooks enforce the state transition and bounded continuation. Prompts and skills alone are not treated as guarantees.

A model may still ignore a request, a user may interrupt it, or a process may be killed. The system-level guarantee is therefore: an unvalidated or stale result is never represented as successful completion, and a missing worker is reconciled to an explicit non-success state.

## Fixture and verification strategy

The repository will contain a fixture generator, not a copy of a real project. It creates a unique temporary root containing:

```text
fixture-root/
├── registry/projects.yaml
├── tickets.json
├── single-repo/
└── bundle/
    ├── meta/
    └── sources/
        ├── backend/
        └── frontend/
```

The fixture provides:

- A minimal single-repository Node project.
- A coordinated multi-repository project similar in topology to Acme but unrelated to production code.
- A primary ticket and related tickets from a static local provider.
- Minimal deterministic verification commands.
- An optional HTTP runtime.
- A fake interactive harness that emits native-equivalent lifecycle events, performs a bounded deterministic edit, writes a result, and remains inspectable.
- An alternate registry selected through `WORKFLOW_PROJECTS_FILE`.

### Test layers

#### Unit tests

Cover:

- Registry v3 migration and profile validation.
- Forbidden permissions and argv safety.
- Profile selection precedence.
- Ticket normalization, primary identity, limits, and compatibility.
- Assignment construction and verbatim request preservation.
- Run-store permissions, locking, and atomic updates.
- State transitions and idempotent lifecycle events.
- Generation invalidation.
- Result schema and size/path bounds.
- Single- and multi-repository Git fingerprints.
- Adapter launch/resume argv.

#### Integration tests

Use temporary Git repositories and fake subprocess/Herdr adapters to cover:

- Launch preview versus confirmed execution.
- Partial-launch recovery.
- Result creation and consumption.
- Coordinator closure and later adoption.
- Manual worker closure.
- Follow-up prompts after completion.
- Invalid or absent artifacts.
- Stale Git fingerprints.
- Exact-session resume and refusal to guess a session.
- Multi-ticket single- and group-repository launches.

#### Real Herdr smoke with fake harness

A local smoke test uses the installed Herdr server and generated projects but no model API. It validates:

- Workspace, worktree, tab, and process creation.
- Assignment delivery.
- Lifecycle callback handling.
- Follow-up generation changes.
- Result return and reconciliation.
- Closure without a handoff.
- Resource preservation on failure.

#### Opt-in real-agent canaries

```bash
npm run smoke:fixture -- --real --agent pi --keep
npm run smoke:fixture -- --real --agent claude --keep
npm run smoke:fixture -- --real --agent codex --keep
```

Canaries:

- Never run in CI or as part of the default test suite.
- Show an exact preview and token-cost warning.
- Require explicit confirmation.
- Use only generated repositories and tickets.
- Perform a tiny, deterministic task with local verification.
- Exercise native hooks and result return.
- Preserve all resources with `--keep`.
- Preserve resources automatically on failure.
- Remove only uniquely identified fixture-owned resources after success when `--keep` is absent.

No fixture or test reads production credentials, modifies Asana, or touches a registered real project.

## Error handling

- Registry, profile, hook, prompt, or precondition errors occur before mutation.
- A failure after worktree creation preserves the worktree and reports recovery steps.
- A harness startup timeout records the Herdr resources and leaves them inspectable.
- A hook parse failure appends a bounded diagnostic without copying raw sensitive input.
- A corrupted run store fails closed and is never overwritten opportunistically.
- A result-validation failure preserves the submitted artifact under a quarantined filename and reports bounded validation errors.
- A missing origin Pi session leaves the result unconsumed.
- A missing native session reference disables exact resume rather than using a recent-session heuristic.
- A process identity mismatch blocks send, resume, or close operations.
- A direct Git change after handoff produces `result-stale`.

## Implementation stages

Because the design spans three dependent subsystems, implementation is divided into three sequential plans, each ending in working, reviewed software:

1. **Multi-harness launch core:** registry v3, agent profiles, multi-ticket identity, run store, result schema, harness adapters, `launch`, `result`, and baseline reconciliation.
2. **Supervised lifecycle and Pi coordinator:** native hooks, generations, resume/adoption, coordinator extension, pinned `pi-subagents`, background result delivery, and explicit close behavior.
3. **Generated fixture and canaries:** fixture generator, local ticket provider, fake harness, real-Herdr smoke, opt-in Pi/Claude/Codex canaries, and final documentation.

Each stage uses TDD, one fresh implementation agent per task, specification review, code-quality review, repository checks, and a clean final diff review before proceeding.

## Acceptance criteria

The feature is accepted when:

- Existing `workflow start` behavior remains compatible and does not deliver implementation prompts.
- A user or Pi coordinator can preview and explicitly launch Pi, Claude, or Codex from a named allowed profile.
- No dangerous permission or hook-trust bypass can enter a valid profile.
- A primary ticket and explicit related tickets share one checkout while retaining per-ticket handoff evidence.
- The original request is preserved verbatim in the approved assignment.
- Launch returns without blocking the coordinator.
- A valid current result reaches the originating Pi session when it remains open.
- A closed Pi session can later adopt an unconsumed result.
- Follow-up prompts invalidate earlier results and require a fresh generation handoff.
- Manual worker closure and hard process disappearance reconcile without false success.
- Pi can inspect operational status through structured metadata and fingerprints without rereading all source code.
- Resume targets an exact captured session or refuses to guess.
- No model or completion event performs automatic cleanup.
- Unit, integration, real-Herdr fake-harness smoke, and opt-in real-agent canaries all have documented commands and expected outcomes.
