# Two-Lane Delegation Governance Design

**Date:** 2026-07-19  
**Status:** Approved for planning  
**Amends:** `2026-07-19-multi-harness-workflow-coordinator-design.md` and its supervised-lifecycle implementation plan

## Purpose

Make the Workflow Control Plane efficient at orchestrating coding agents without giving up its authority over project identity, worktrees, lifecycle, and canonical results.

The design adopts two useful ideas from agent-team workflows:

1. use specialized coordinator/executor roles with frozen task briefs; and
2. continue an exact persistent agent session for bounded corrections rather than repeatedly starting a new agent with an empty context.

It deliberately does **not** adopt terminal text as a result protocol, unregistered tmux sessions, permission/trust bypasses, or automatic cleanup.

## Goals

- Support distinct coordinator, scout, implementer, and reviewer roles.
- Permit bounded, configurable parallelism rather than a fixed global value.
- Permit background work where it does not undermine writer safety or lifecycle truth.
- Reuse an exact agent session for at most two approved remediation turns.
- Keep `workflow` as the sole authority for ticket identity, worktree ownership, assignment approval, locks, lifecycle, reconciliation, and external-worker results.
- Use `pi-subagents@0.34.0` as an internal execution engine only through its supported public Pi tool surface and only behind local policy enforcement.
- Share lifecycle/recovery behavior between external workers and internal Pi delegations without relying on a terminal emulator as a result source.

## Non-goals

- Replacing the Workflow Control Plane with `pi-subagents`, tmux, or Herdr.
- Allowing a subagent to create its own worktree, branch, deployment, cleanup, nested subagent, or production mutation.
- Trusting raw terminal panes, child transcripts, or a package artifact as a canonical worker handoff.
- Allowing approximate session discovery (`--last`, `--continue`, picker automation, or name-only matching).
- Automatically killing a process, deleting a worktree/branch/run/workspace, or accepting a hook trust dialog.
- Promising a specific percentage of token savings. Persistent context and role-specific models should reduce avoidable restarts, but actual use depends on tasks and models.

## Terminology

| Term | Meaning |
|---|---|
| External worker | A Pi, Claude, or Codex worker launched by `workflow` in a registered Herdr workspace/tab/pane. |
| Internal delegation | A Pi subagent run started by the coordinator for a bounded role. |
| Frozen brief | Immutable, approved delegation input containing role, objective, scope, cwd, limits, verification, and digests. |
| Writer | A role permitted to modify the one registered worktree assigned to it. |
| Read-only role | A role with no edit/write tools, assigned only inspection commands and advisory output; it is not an OS sandbox against a malicious shell command. |
| Generation | The current turn/revision of one external run or internal delegation. A new follow-up invalidates an earlier current result. |
| Exact session | A native session ID/path recorded for a specific delegation; never a guessed recent session. |

## Architecture

```text
                         ┌─────────────────────────┐
                         │      Pi coordinator     │
                         │ prepares, approves,     │
                         │ classifies, and reviews │
                         └────────────┬────────────┘
                                      │
          ┌───────────────────────────┴───────────────────────────┐
          │                                                       │
┌─────────▼─────────┐                                   ┌─────────▼─────────┐
│ External-worker   │                                   │ Internal-delegation│
│ lane              │                                   │ lane              │
│ Pi/Claude/Codex   │                                   │ pi-subagents      │
├───────────────────┤                                   ├───────────────────┤
│ workflow-owned    │                                   │ scouts/reviewers: │
│ worktree and lock │                                   │ read-only, fg/bg  │
│ one writer per    │                                   │ implementer:      │
│ checkout          │                                   │ assigned workflow │
│ native hooks      │                                   │ worktree only     │
│ handoff -> result │                                   │ bounded evidence  │
└─────────┬─────────┘                                   └─────────┬─────────┘
          └──────────────────┬────────────────────────────────────┘
                             ▼
                 private run store and reconciliation
```

### Authority boundaries

`workflow` owns:

- project/ticket identity, approval digests, frozen assignments, worktree creation and registration;
- writer locks, lifecycle state, generations, exact worker/session references, reconciliation, and graceful close;
- canonical external-worker handoffs: `handoff-input.json` is validated and canonized as `result.json`.

The Pi coordinator owns only orchestration decisions: whether an approved delegation is useful, whether reviewer evidence fits the frozen brief, and whether a valid exact session may receive an allowed remediation follow-up.

`pi-subagents` supplies bounded internal execution. Its output is advisory evidence for the coordinator and can never close, complete, or mutate an external workflow run.

Herdr is the transport for external workers. It is not the lifecycle/result authority and does not manage internal Pi child sessions.

## Policy and concurrency

Each project has a versioned delegation policy in control-plane configuration. It is authoritative; the package's user-global configuration is not.

Initial safe defaults are:

```yaml
delegation:
  totalInternal: 4
  foreground: 3
  readOnlyBackground: 3
  writersTotal: 1
  writersPerCheckout: 1
  maxDepth: 1
  remediationTurns: 2
```

Project policies may tighten or raise budgets only through a reviewed configuration change. The effective limit is the smallest applicable global, lane, role, model-budget, and checkout limit.

Rules that never relax:

- one writer per checkout;
- depth one: a coordinator may delegate, but every managed child lacks the `subagent` tool;
- unknown roles, unregistered cwd values, and package administrative/configuration actions fail closed;
- `worktree: true` is always rejected for `pi-subagents`; `workflow` owns all worktree creation;
- a writer can run only in its registered, locked workflow worktree;
- only an approved, read-only role may use internal background execution in the initial rollout;
- a background writer is enabled only after the writer fixture/canary phase succeeds and still requires an approved brief, writer lock, registered worktree, and project budget.

## Roles and frozen briefs

| Role | Tools/permissions | Permitted mode | Responsibility |
|---|---|---|---|
| `workflow-coordinator` | Workflow orchestration only; no direct implementation | Foreground | Prepare/approve work, select roles, assess evidence, request user decisions. |
| `scout` | Read and bounded shell inspection | Foreground or background | Discover relevant code, constraints, and test targets. |
| `spec-reviewer` | Read and bounded shell inspection | Foreground or background | Compare implementation strictly with frozen brief/spec. |
| `code-reviewer` | Read and bounded shell inspection | Foreground or background | Find correctness, safety, regression, and verification concerns. |
| `sdd-implementer` | Read, bounded shell, edit/write only in assigned cwd | Foreground initially; background after rollout gate | Implement one approved task with TDD and report verification. |

Every delegation has a private frozen brief. It contains the role, parent run/delegation identity, approved objective, exact cwd/worktree, allowed tools, role/model budget, timeout, verification requirements, and immutable request/approval digests. Prompt-like content is held in a `0600` file when needed; state records retain only bounded metadata and digests.

The delegation state records at least:

```text
delegationId, parentRunId, originPiSessionId, role, mode,
briefDigest, cwd/worktree identity, nativeSession reference,
generation, process state, budget/timeout, result status, and bounded summary
```

An internal result is structured and bounded: status, generation, summary, verification/evidence references, concerns, and next action. It contains no transcript and does not become a canonical external-worker result.

### Read-only enforcement boundary

Pi's ordinary `bash` tool is not an operating-system read-only sandbox. Managed reviewer/scout roles therefore omit `edit` and `write`, receive explicit non-mutation instructions, and their permitted command set is constrained by coordinator policy where the host API allows it. Their output remains advisory and a post-run Git/worktree fingerprint check detects unexpected changes. A stronger hostile-agent boundary requires a separate sandboxed or read-only filesystem transport and is explicitly out of this Stage 2 scope; it must not be implied by a role prompt alone.

## Session persistence and remediation

The first delegation is always prepared as a preview and executed only with the user-approved digest.

That approval may authorize `remediationTurns` from zero through two; the default approved policy is two. After implementation and review, the coordinator may send a follow-up to the exact existing session only when all of these are true:

1. reviewer evidence describes a defect inside the frozen brief;
2. the change does not expand scope, permissions, model/cost budget, concurrency, or worktree ownership;
3. the exact process/session and writer lock remain valid;
4. no accepted external result conflicts with the change; and
5. the remediation-turn budget remains.

A follow-up increments the delegation generation and makes older delegation output historical. A live external worker receives text only through its exact validated Herdr pane; a supported internal child receives a follow-up only through the package's public supported session/resume mechanism.

If a process has exited but an exact persisted session reference is available, the system may explicitly resume that exact context as the same logical delegation. It never uses a recent-session heuristic. If no exact session is available, the coordinator prepares a new delegation with a compact, validated context summary and tells the user that prior context is unavailable.

Scope changes, product choices, ambiguity, repeated failure, a budget limit, missing identity, or a needed extra task stop automatic remediation and require a user decision.

## Transport contract

The control plane uses a small internal `WorkerTransport` boundary:

```text
start(approvedAssignment)
observeExact(identity)
deliverFollowUp(identity, approvedPrompt)
requestGracefulClose(identity)
```

It is not a new general-purpose worker framework.

- The **Herdr transport** implements it for external Pi/Claude/Codex workers using registered workspace/tab/pane IDs and process identity.
- The **Pi-subagent transport** implements only capabilities exposed by the installed package's supported public tool interface; it never imports package internals.
- A **fake transport** drives deterministic unit tests and generated fixtures.

Transport observations are structured process/lifecycle facts. A pane capture may be displayed for human diagnosis, but cannot supply lifecycle truth or a result. Completion remains a lifecycle event plus a validated artifact.

The operations map safely to useful `open-agent-teams` ideas as follows:

| Need | Workflow adaptation |
|---|---|
| Start | Registered Herdr launch or an approved internal delegation. |
| Follow-up | Exact-session delivery after identity/idle validation. |
| Wait | Session-owned result watcher and bounded process observation; no busy loop. |
| Status | Run-store reconciliation plus typed transport facts. |
| Result | Canonical handoff for external workers; bounded advisory result for internal work. |
| Stop | Explicit, confirmed, graceful idle close only; no automatic kill or cleanup. |

## Coordinator guard

The project-local coordinator extension is the hard local guard for the `subagent` tool.

It permits only a prepared, unconsumed delegation request whose fingerprint matches the approved role, task digest, cwd, mode, budget, and concurrency. A request that is direct, stale, duplicated, or mismatched is blocked rather than rewritten. The approval is atomically consumed when the matching request starts.

The guard rejects:

- nested delegation, unknown managed roles, or child definitions with `subagent` access;
- `worktree: true`, an unregistered cwd, or a write-capable role without its writer lock;
- async mode without the role/mode approval;
- concurrency above the effective policy limit;
- package configuration, scheduling, fleet management, broad status enumeration, or other administrative actions initiated by the model;
- permission, sandbox, hook-trust, cleanup, deployment, or production-mutation bypasses.

The package's default values are defense in depth only. `pi-subagents` configuration is user-global, so project policy and the coordinator guard must remain the enforcement point.

## Lifecycle and failure behavior

The existing generation-aware lifecycle design remains authoritative for external workers. The new delegation lifecycle follows the same principles: identity is exact, state changes are idempotent, output from an older generation is stale, and process disappearance without a valid current result is never success.

Timeout, invalid result, lost process, unavailable session, policy rejection, and transport mismatch create recoverable/manual states with bounded diagnostics. They preserve worktrees, run records, package artifacts, and sessions for inspection. No failure path deletes or kills a resource automatically.

Results are injected only into the exact originating Pi coordinator session. A later Pi session may see pending results but must explicitly adopt them.

## Package handling

`pi-subagents@0.34.0` remains an exact project-local pin, but the source-review rule changes. The package contains async/background, watcher, scheduler, and internal-worktree features; this is an expected capability surface to constrain, not evidence that those features are absent.

Before project installation, the exact npm integrity, manifest, install behavior, and extension entrypoint are recorded in a task report. The project must not invoke its global `install.mjs`; no package lifecycle script may mutate unrelated user state. The package is usable only after the coordinator guard and static role-policy tests exist. Any version or integrity change requires a separate review and approval.

## Rollout and verification

1. **Policy core:** implement delegation state, budgets, generation rules, `WorkerTransport`, and fake-transport tests without installing packages or running agents.
2. **External lifecycle:** implement native hook configuration and the Herdr transport. Codex profile trust remains an explicit manual checkpoint.
3. **Guard and roles:** implement/test coordinator policy, frozen briefs, role definitions, and package source policy; then install the exact local package if the review still matches.
4. **Read-only fixture:** use generated disposable repositories for foreground/background scout and reviewer runs. Verify limits, exact identity, result delivery, and resume behavior.
5. **Writer fixture:** only after the prior gate, test one background implementer in a workflow-owned fixture worktree, including lock and remediation behavior.
6. **Opt-in canary:** only after fixture verification and a separate explicit approval. Never run a real implementation task against a registered project as a canary.

Required automated coverage includes policy permutations, concurrency races, exact-session follow-ups, remediation caps, stale generations, process loss, timeout, invalid output, no-terminal-result assertions, no-cleanup assertions, and package/role static configuration checks.

## Implementation-plan changes

The supervised-lifecycle plan must be revised before execution:

- Add a policy/delegation-state and fake-transport foundation before package installation.
- Extend Task 3's Herdr work with the narrow `WorkerTransport` adapter.
- Replace Task 4's foreground-only policy tests with two-lane policy tests and prepared-request provenance.
- Keep the coordinator watcher session-owned and artifact-based.
- Move exact package installation after the guard and role static tests; change its review criterion to record and constrain the actual 0.34.0 capability surface.
- Add fixture gates for read-only background work before any background writer is enabled.
- Preserve all prior rules about confirmation, no terminal scraping, exact resume, no automatic cleanup, no secret exposure, and no permission/trust bypass.
