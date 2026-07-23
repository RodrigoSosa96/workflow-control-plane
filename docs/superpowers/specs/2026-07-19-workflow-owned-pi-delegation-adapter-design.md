# Workflow-Owned Pi Delegation Adapter Design

**Date:** 2026-07-19
**Status:** Approved
**Amends:** `2026-07-19-two-lane-delegation-governance-design.md` and the supervised lifecycle/coordinator plan

## Decision

The control plane will implement its own small Pi delegation adapter. It will borrow proven *patterns* from public `pi-subagents` releases and public unreleased branches, but will not install, import, fork, vendor, or execute `pi-subagents`.

The rejected package creates global/runtime state, starts watchers before `session_start`, supports automatic cleanup and package-owned worktrees, and exposes administrative surfaces outside Workflow authority. A fork would retain those concerns and make Workflow responsible for a fast-moving external implementation.

The adapter is intentionally not a general workflow engine. `workflow` remains authoritative for assignment approval, worktrees, writer locks, lifecycle, result truth, reconciliation, and resource preservation.

## Goals

- Run governed Pi child delegations for the managed roles `scout`, `spec-reviewer`, `code-reviewer`, and `sdd-implementer`.
- Preserve exact private Pi session paths so a bounded remediation turn can resume the same delegation context.
- Support foreground delegations and policy-governed read-only background delegations now.
- Implement all writer safety machinery now, while keeping background writers disabled until the fixture gate explicitly enables them.
- Reuse the existing delegation policy, frozen-brief store, durable reservations, prepared-request validation, and `WorkerTransport` contract.
- Keep child output advisory, structured, bounded, and independent from terminal stdout, pane capture, or transcripts.
- Keep all adapter state beneath Workflow private run state, never under `~/.pi`, global Pi settings, package caches, or `/tmp` sentinels.

## Non-goals

- Installing `pi-subagents`, copying its source, or promising compatibility with its tool schema.
- A daemon, scheduler, fleet UI, watchdog, automatic review loop, transcript viewer, persistent agent memory, or package administration API.
- Automatic process kill, resource cleanup, reservation deletion, session deletion, worktree creation, branch deletion, or result acceptance.
- Internal worktree creation, nested delegation, raw terminal result parsing, approximate session resume, or model-directed policy changes.
- Enabling background writers before the generated writer fixture/canary gate succeeds and a reviewed configuration change sets `allowBackgroundWriters: true`.

## Public Research Incorporated

The implementation may reproduce only these independently designed ideas from public `pi-subagents` code:

- exact session leases and fail-closed session identity;
- bounded JSONL protocol lines and bounded diagnostic tails;
- versioned lifecycle/result records with unknown-field tolerance at read boundaries;
- structured acceptance evidence, role-specific tool allowlists, turn/tool/runtime budgets, and spawn preflight;
- session-scoped result delivery and correlated steering/remediation records;
- prompt redaction and task digests in history/state.

It deliberately excludes the package's global config discovery, startup watcher/poller behavior, result/transcript artifact ecosystem, scheduler, worktree manager, child fan-out, control/management actions, watchdog, automatic process signaling, and cleanup routines.

## Architecture

```text
Pi coordinator extension
  | prepares preview + receives explicit user confirmation
  v
Workflow delegation services
  | policy / frozen brief / reservation / prepared-request guard
  v
PiDelegationTransport
  | exact private session path + bounded process facts
  v
Pi child process
  | explicit Workflow child extension + role tool allowlist
  v
workflow delegation handoff command
  | validates bounded structured advisory result
  v
private Workflow run state
  | exact-session watcher injects result only to its origin Pi session
```

### 1. Workflow delegation services

A narrow service factory receives the already-tested foundation dependencies:

```text
createDelegationServices({ registry, projectAlias, runStore,
  delegationStore, reservationStore, transport })
```

It resolves and freezes the effective project policy once. It never reads package configuration. It exposes only preview/prepare/execute/reconcile/remediate operations used by the coordinator extension and CLI command handlers.

A delegation preview is pure data. It includes the effective role, mode, cwd, tool allowlist, bounded budgets, frozen-brief digest, required verification, and one approval digest. The coordinator must render the complete preview and obtain a confirmation before `prepare` writes the brief.

On confirmed execution, the service performs these ordered operations:

1. write the immutable private brief through `DelegationStore.prepare`;
2. claim the new delegation once;
3. acquire the durable project/role/checkout reservation;
4. start the exact child through `PiDelegationTransport`;
5. record its exact Pi session reference and process identity.

A reservation failure marks the claimed delegation as a non-successful start failure with recovery instructions. A start failure after reservation acquisition preserves the active reservation and records manual recovery; it never releases a reservation automatically. A successful terminal result or an explicit future operator action may release a verified reservation while retaining its audit record.

### 2. PiDelegationTransport

`PiDelegationTransport` implements the existing four-method `WorkerTransport` boundary:

```text
start(approvedAssignment)
observeExact(identity)
deliverFollowUp(identity, approvedPrompt)
requestGracefulClose(identity)
```

It launches a child with a generated, private session path inside the parent run directory, for example:

```text
<run-dir>/delegations/<delegation-id>/pi-session.jsonl
```

The child command uses an explicit session path and private session directory. It disables discovered extensions, skills, and prompt templates, rejects project-resource trust for that child invocation, then adds only the Workflow child extension and the role's explicit tool allowlist. It does not use `--continue`, `--last`, a session picker, a global session directory, package installation, or a shell command string.

The transport records only structured process facts: command identity, pid, process start evidence when available, cwd, session path, and launch timestamps. It bounds/drains child stdout and stderr only to avoid pipe blockage; neither is lifecycle truth or result content.

`observeExact` returns `active`, `idle`, `missing`, or `mismatch` only after checking the persisted identity. A running child is never replaced. A finished child may be resumed only by starting Pi with the same explicit session path. A follow-up first increments the delegation generation through the store, then creates a new exact-session child. If identity is missing, the call fails closed and prepares a new preview rather than guessing context.

The first adapter does not attempt interactive key delivery to an internal child. `requestGracefulClose` records a confirmed close request and returns manual-close guidance unless a future reviewed child protocol supplies an exact graceful-close acknowledgement. It never sends a signal or kills a process.

### 3. Child extension and advisory handoff

The child receives the delegation/run IDs, generation, private run directory, exact session path, and a fixed control-plane binary through allowlisted environment variables. Its project-local extension is loaded explicitly by path rather than auto-discovered.

The extension provides one semantic terminal tool, `workflow_delegation_handoff`, with strict fields:

```text
status: completed | blocked | failed
generation: positive integer
summary: bounded text
verification: bounded [{ command, status }]
concerns: bounded string[]
nextAction: bounded text
```

The tool invokes a fixed Workflow handoff command. The command verifies run/delegation identity, current generation, bounded schema, and exact reservation/session association before `DelegationStore.recordResult` writes the private artifact. A successful terminal handoff may terminate the child turn. Invalid input throws and cannot produce an error-shaped success result.

The child extension records bounded lifecycle facts at `session_start`, `before_agent_start`, `agent_settled`, and `session_shutdown`. It does not start timers/watchers from its factory. It never reads or stores a transcript, raw prompt, credentials, arbitrary environment values, or terminal output.

### 4. Roles, tool boundary, and worktrees

Role definitions are owned in this repository and parsed/tested as data before use:

| Role | Allowed mode now | Tools |
|---|---|---|
| `scout` | foreground or background | `read`, `bash`, `grep`, `find`, `ls` |
| `spec-reviewer` | foreground or background | `read`, `bash`, `grep`, `find`, `ls` |
| `code-reviewer` | foreground or background | `read`, `bash`, `grep`, `find`, `ls` |
| `sdd-implementer` | foreground | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |

Read-only is an advisory tool boundary, not an OS sandbox. Each read-only completion is checked against a pre/post Git fingerprint; unexpected changes become a non-successful manual-review state. The child does not receive the delegation tool, so depth remains exactly one.

Every child cwd must equal the frozen registered checkout. A writer requires its matching active writer reservation, and the existing one-writer-per-checkout invariant remains non-relaxable. No child may request or create a worktree.

### 5. Background, budgets, remediation, and leases

Only a prepared request that exactly matches the frozen role, task digest, cwd, mode, concurrency, and reservation can start. Direct model calls are blocked rather than normalized. The coordinator extension exposes Workflow-specific prepare/execute tools; it does not expose a general child-management interface.

Read-only background work starts as a detached child only after its policy reservation is active. It retains an exact private session file and process identity. The coordinator watcher starts only in its own `session_start`, has one in-flight poll, uses an unref'd timer where available, and stops idempotently in `session_shutdown`.

Every result is consumed atomically by the exact originating Pi coordinator session. A later session can list it but must explicitly adopt it. Internal advisory results never complete an external Workflow run.

Budgets are applied before start: policy concurrency, the frozen brief's bounded max-runtime, tool-call, and turn caps, and the policy remediation cap. A budget breach records a bounded non-success state and preserves resources. It does not kill the child. Remediation requires reviewer evidence within the frozen brief, a matching active reservation/identity, no conflicting accepted external result, and a remaining policy turn. It calls `beginRemediation`, invalidates the prior advisory output, and resumes the exact private Pi session. Two remediation turns is the maximum.

Background writers are structurally implemented but fail closed while `allowBackgroundWriters` is false. They may be enabled only after the read-only and writer fixture gates pass, the user explicitly approves the canary, and a reviewed policy change enables the flag.

### 6. External-worker integration

The external Pi/Claude/Codex lifecycle remains separate. The revised lifecycle plan will add a Herdr-backed `WorkerTransport` adapter for external workers and use the same exact-observation/follow-up/close contract. Canonical external completion remains the validated Workflow handoff artifact; internal advisory evidence cannot alter it.

## Failure Handling

- Invalid/stale prepared request, reservation mismatch, unknown role, child nested delegation, worktree request, invalid cwd, or disallowed background writer: reject before launch.
- Child process disappears without a valid current advisory result: mark interrupted/missing, preserve all state, and provide exact reconciliation steps.
- Missing or mismatched session/process identity: refuse follow-up/close/resume and require a new preview.
- Invalid/oversized child protocol data: retain only bounded diagnostics, fail the delegation, and do not echo raw content.
- Session/session-directory creation, result write, or state corruption failure: fail closed; never replace, delete, or repair artifacts automatically.
- Lost origin coordinator session: preserve unconsumed result; require explicit adoption by a later session.

## Verification Strategy

Automated tests use fake transports, fake process runners, temporary private state roots, and static fake Pi APIs. They do not call a model, start Herdr, install a package, write user Pi settings, or trust a project.

Coverage must include:

- policy tightening, role/mode matrices, direct-request rejection, lease races, one writer per checkout, and retained reservation history;
- generated child argv: explicit session path, private session directory, explicit child extension, no global discovery, no shell, no recent-session heuristic, no package source;
- bounded child protocol/event parsing; no stdout/transcript-derived result; prompt/task redaction; private file modes;
- exact session resume, missing/mismatched identity rejection, generation invalidation, two-turn remediation cap, and no automatic signal/cleanup;
- read-only foreground/background result delivery, exact origin-session consumption/adoption, timer start/stop, and poll race handling;
- writer foreground ownership and background-writer fail-closed behavior;
- static role definitions, child tool allowlists, depth-one guard, and no `.pi/npm`, global config, package cache, scheduler, watchdog, or worktree-management files;
- compatibility of the existing external lifecycle/handoff path and a fake Herdr transport.

Generated fixtures remain the only place where real Pi/Claude/Codex execution is later considered. Real model calls, trust prompts, package installation, fixture canaries, and background writers remain explicit future checkpoints.

## Acceptance Criteria

The adapter is ready for fixture work when:

1. all delegation state, reservations, sessions, and artifacts are private under Workflow state roots;
2. every managed child has a frozen brief, exact session reference, current generation, policy reservation, and structured advisory result;
3. a direct/unknown/nested/worktree/admin request cannot start a child;
4. no terminal text, transcript, global Pi state, `pi-subagents`, or user configuration is used as workflow truth;
5. read-only background result delivery reaches only its exact origin session and supports explicit adoption;
6. writer foreground execution is bounded to its registered checkout and writer reservation;
7. writer-background execution remains denied until fixture gates and a reviewed policy change;
8. all test, package dry-run, diff, security/spec review gates pass with no agent or model invocation.
