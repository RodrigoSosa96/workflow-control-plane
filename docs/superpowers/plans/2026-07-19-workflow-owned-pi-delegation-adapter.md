# Workflow-Owned Pi Delegation Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Workflow-owned Pi child-delegation adapter with private exact sessions, frozen briefs, durable reservations, bounded advisory handoffs, session-owned result delivery, and managed role definitions without installing or using `pi-subagents`.

**Architecture:** A pure delegation service consumes the completed two-lane foundation and creates approved delegation state. A Pi-specific transport starts a child process using one private explicit session file and reports only exact structured process facts. The child extension submits bounded advisory results through a fixed control-plane handoff command; the coordinator watcher delivers those results only to the exact origin Pi session.

**Tech Stack:** Node.js 24 ESM, `node:test`, Node `child_process`, Node filesystem APIs, existing private run store/delegation store/reservation store, Pi extension API 0.80+, TypeBox, and project-local TypeScript extensions loaded explicitly by path.

## Global Constraints

- Complete `2026-07-19-two-lane-delegation-foundation.md` and use its contracts; do not duplicate policy, reservation, or prepared-request rules.
- Follow strict red-green-refactor TDD. Every task ends with focused tests, `npm test`, `git diff --check`, spec review, and code-quality review.
- Do not install, import, copy, fork, configure, or execute `pi-subagents`; `.pi/settings.json` and `.pi/npm/` must remain absent.
- Do not launch Pi, Herdr, Claude, Codex, a model, a fixture, or a real child during automated verification. Tests use fake runners, fake transports, and fake Pi APIs only.
- `workflow` remains the authority for brief approval, worktrees, reservations, lifecycle, reconciliation, and external canonical results. Internal results are advisory only.
- Store all adapter session paths, artifacts, and diagnostics under an existing private Workflow run directory. Do not write `~/.pi`, global Pi config, package caches, `/tmp` control files, transcripts, or raw prompts.
- Use explicit private Pi session paths only. Never use `--continue`, `--last`, session pickers, name-only matching, global session directories, shell interpolation, or terminal output as lifecycle/result truth.
- Children run with discovered extensions, skills, and prompt templates disabled; add only the fixed Workflow child extension, bounded environment, target context files, and the managed role tool allowlist.
- Internal worktrees, nested delegation, scheduler/fleet/watchdog/configuration actions, automatic cleanup, automatic process kill, destructive Git actions, deploys, production mutations, permission bypasses, and hook-trust bypasses are prohibited.
- Read-only roles are an advisory tool boundary, not an OS sandbox. Record pre/post Git fingerprints and fail to manual review if a read-only child changes the checkout.
- One writer per checkout is non-relaxable. `sdd-implementer` is foreground only while `allowBackgroundWriters` is false; no test or code path may enable it in this plan.
- Start watcher/timer resources only in extension `session_start`; stop them idempotently in `session_shutdown`.
- A failed start after reservation acquisition retains the active reservation and requires manual recovery; no path deletes or automatically releases it.

---

## Planned File Structure

```text
src/workflow/
  delegation-services.js              Preview/execute/reconcile/remediate orchestration
  delegation-store.js                 Extended start, identity, consumption, and adoption state
  delegation-handoff.js               Bounded internal advisory-result validation/submission
  delegation-roles.js                 Strict role-definition loading and argv-safe tool profiles
  pi-delegation-transport.js          Exact private-session Pi WorkerTransport adapter
  delegation-watcher.js               Origin-session result consumption watcher
  commands.js                         Delegation handoff/result/reconcile command use cases
  run-store.js                        Atomic exact-session result-consumption primitive
bin/
  workflow.js                         `delegation` command parsing/confirmation/dispatch
.pi/
  agents/
    scout.md
    spec-reviewer.md
    code-reviewer.md
    sdd-implementer.md
  extensions/
    workflow-delegation-child.ts      Explicit child lifecycle/handoff extension
    workflow-coordinator/index.ts     Prepared delegation tools, guard, and watcher wiring
test/
  workflow-delegation-services.test.js
  workflow-delegation-handoff.test.js
  workflow-delegation-roles.test.js
  workflow-pi-delegation-transport.test.js
  workflow-delegation-watcher.test.js
  workflow-pi-extensions.test.js      Extended with fake Pi API contracts
  workflow-cli.test.js                Extended delegation syntax/confirmation tests
  workflow-delegation-store.test.js   Extended state/consumption tests
  workflow-docs.test.js               Extended final boundary assertions
README.md
docs/superpowers/plans/
  2026-07-19-supervised-lifecycle-pi-coordinator.md
```

## Shared Contracts

```js
// delegation-services.js
createDelegationServices({ registry, projectAlias, runStore, delegations, reservations, transport, roles, git, clock })
// -> { createPreview, executeApproved, reconcile, beginRemediation }

// pi-delegation-transport.js
createPiDelegationTransport({ spawnChild, inspectProcess, fs, piCommand, childExtensionPath, clock })
// WorkerTransport methods plus no public process-kill operation

// delegation-handoff.js
submitDelegationHandoff({ runId, delegationId, input, store, delegations, reservations, git })

// delegation-watcher.js
createDelegationWatcher({ delegations, originSessionId, onResult, intervalMs, clock })
// -> { start, poll, stop }
```

A Pi transport identity has no terminal/result fields:

```js
{
  kind: "pi-delegation",
  runId,
  delegationId,
  sessionPath,
  cwd,
  pid,
  processStartedAt,
}
```

The generated child argv always starts with this fixed safe prefix before the bounded role tools and bootstrap prompt:

```js
[
  piCommand,
  "--session", sessionPath,
  "--session-dir", sessionDirectory,
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-approve",
  "--extension", childExtensionPath,
  "--tools", role.tools.join(","),
]
```

---

### Task 1: Compose the Foundation into an Approved Delegation Service

**Files:**
- Create: `src/workflow/delegation-services.js`
- Create: `test/workflow-delegation-services.test.js`
- Modify: `src/workflow/delegation-store.js`
- Modify: `test/workflow-delegation-store.test.js`

**Interfaces:**
- `createPreview({ runId, input })` returns immutable data and an approval digest without writing state or reserving capacity.
- `executeApproved({ preview, approvalDigest })` writes/claims the frozen brief, reserves capacity, starts only the injected transport, and records exact identity.
- `reconcile({ runId, delegationId })` combines stored generation/result state with `transport.observeExact` facts; it never reads terminal content.
- `beginRemediation({ runId, delegationId, expectedGeneration, reviewEvidence, prompt })` rejects expanded scope, increments exactly one generation, and uses `transport.deliverFollowUp` only for the persisted exact identity.

- [ ] **Step 1: Write failing service tests**

Create a fake registry/project, real temporary run/delegation/reservation stores, fake roles, and `createFakeWorkerTransport`. Assert that preview is pure and binds all approval-relevant values:

```js
test("preview freezes role, cwd, budgets, and task digest without mutation", async () => {
  const preview = await services.createPreview({ runId, input: reviewInput });
  assert.match(preview.approvalDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(preview.role, "code-reviewer");
  assert.equal(preview.mode, "background");
  assert.equal((await store.read(runId)).delegations, undefined);
});
```

Add cases proving that execute rejects a changed approval digest before store/reservation/transport mutation; consumes one prepared request; records the returned exact identity; rejects a direct/changed task; retains a reservation when start throws; and permits only two remediation turns with matching review evidence and identity. Assert that a remediation prompt or invalid task text never appears in returned errors.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js
```

Expected: FAIL because `delegation-services.js` and the required delegation-store lifecycle methods do not exist.

- [ ] **Step 3: Extend delegation state atomically**

Add these bounded methods to `createDelegationStore`:

```js
recordTransportIdentity({ runId, delegationId, identity })
recordStartFailure({ runId, delegationId, reason })
consumeResult({ runId, delegationId, originSessionId })
adoptResult({ runId, delegationId, originSessionId })
```

Extend the private `budget` schema from `{ maxRuntimeMs, concurrency }` to exactly `{ maxRuntimeMs, concurrency, maxTurns, maxToolCalls }`; all four values are positive integers and neither extra field is optional. Persist only those numeric limits. `recordTransportIdentity` accepts only the exact Pi identity fields from the shared contract and only while the delegation is `running`. `recordStartFailure` transitions a claimed delegation to `failed` with a bounded reason and preserves its brief. `consumeResult` atomically requires a terminal current result, its exact original session, and no prior consumer; it writes only `{ consumedBySessionId, consumedAt }`. `adoptResult` requires an unconsumed terminal result and writes an explicit adoption record before consumption. Neither method writes prompt, transcript, stdout, stderr, owner tokens, or raw cwd to error text.

Add tests for duplicate consumption, wrong-session consumption, explicit adoption, stale generation rejection, and private state modes.

- [ ] **Step 4: Implement pure preview and approved execution**

Use canonical sorted JSON and SHA-256 for the preview digest. Include only this stable payload:

```js
{
  version: 1, runId, projectAlias, delegationId: "<generated at execute>",
  role, mode, cwd, taskDigest, briefDigest,
  budget: { maxRuntimeMs, concurrency, maxTurns, maxToolCalls },
  remediationTurns, tools,
}
```

`createPreview` validates role/mode/cwd against `resolveDelegationPolicy` and `loadDelegationRole`, calculates task/brief digests, and returns frozen data. `executeApproved` recomputes the preview and rejects any changed digest before invoking `delegations.prepare`. It then claims, reserves, starts, and records identity in the documented order. If start fails after reserve, call `recordStartFailure` and return a manual-release recovery action without calling `reservations.release`.

- [ ] **Step 5: Implement reconciliation and remediation gates**

`reconcile` calls `transport.observeExact(record.transportIdentity)` and returns only `{ state, identity, generation, resultStatus, nextActions }`. A missing/mismatch observation makes a terminal result unavailable for automatic remediation.

`beginRemediation` requires `reviewEvidence` with the exact current generation, bounded defect summary, and `insideFrozenBrief: true`. Reject zero/over-cap turns, changed worktree/cwd, non-terminal current result, changed reservation, missing identity, and evidence that expands scope. After `delegations.beginRemediation`, call `transport.deliverFollowUp(identity, prompt)`; if delivery fails, preserve the incremented delegation generation with manual recovery guidance.

- [ ] **Step 6: Run focused and full verification**

```bash
node --test test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js test/workflow-delegation-reservations.test.js test/workflow-coordinator-policy.test.js
npm test
git diff --check
```

Expected: all tests pass; no child process is started.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/workflow/delegation-services.js src/workflow/delegation-store.js test/workflow-delegation-services.test.js test/workflow-delegation-store.test.js
git commit -m "feat(workflow): orchestrate approved Pi delegations"
```

---

### Task 2: Validate Role Definitions and Submit Advisory Handoffs

**Files:**
- Create: `src/workflow/delegation-roles.js`
- Create: `src/workflow/delegation-handoff.js`
- Create: `test/workflow-delegation-roles.test.js`
- Create: `test/workflow-delegation-handoff.test.js`
- Create: `.pi/agents/scout.md`
- Create: `.pi/agents/spec-reviewer.md`
- Create: `.pi/agents/code-reviewer.md`
- Create: `.pi/agents/sdd-implementer.md`
- Modify: `src/workflow/commands.js`
- Modify: `bin/workflow.js`
- Modify: `test/workflow-cli.test.js`

**Interfaces:**
- `loadDelegationRole({ name, agentDirectory })` returns a frozen `{ name, tools, systemPrompt }` after strict frontmatter validation; Workflow policy selects the mode.
- `submitDelegationHandoff` accepts only `completed`, `blocked`, or `failed` advisory statuses and delegates canonical persistence to the delegation store.
- CLI accepts `workflow delegation handoff <run-id> <delegation-id> --input <run-dir>/delegations/<id>/handoff-input.json` as a non-interactive fixed-path command.

- [ ] **Step 1: Write failing role-definition tests**

Assert the four exact names, unique declarations, bounded descriptions, and tool profiles in the specification. Assert reviewer/scout roles omit `edit`, `write`, and `subagent`; the implementer includes edit/write but not `subagent`; every definition has `maxSubagentDepth: 1`, `async: false`, `inheritProjectContext: true`, and an explicit no-cleanup/no-deploy/no-push instruction.

Reject duplicate names, unknown frontmatter, missing required role metadata, a shell fragment in a tool name, background default configuration, a child `subagent` tool, and a role file outside the expected agent directory.

- [ ] **Step 2: Write failing delegation-handoff and CLI tests**

Use a real temporary run store/delegation store with one running delegation and exact recorded identity. Cover a successful current-generation handoff, wrong run/delegation identity, stale generation, unbounded summary, arbitrary input path, wrong `WORKFLOW_*` environment, missing active reservation, and duplicate result.

```js
const result = await submitDelegationHandoff({
  runId, delegationId,
  input: { status: "completed", generation: 1, summary: "Reviewed scope", verification: [], concerns: [], nextAction: "Await coordinator" },
  store, delegations, reservations, git,
});
assert.equal(result.state, "completed");
assert.doesNotMatch(JSON.stringify(result), /stdout|stderr|terminal|transcript/i);
```

Assert CLI parsing accepts only the canonical delegation artifact path and cannot accept `--output`, prompt text, `--yes`, or a caller-selected result path.

- [ ] **Step 3: Verify RED**

```bash
node --test test/workflow-delegation-roles.test.js test/workflow-delegation-handoff.test.js test/workflow-cli.test.js
```

Expected: FAIL because the role loader, advisory handoff, agent files, and CLI command do not exist.

- [ ] **Step 4: Implement strict roles**

Use YAML frontmatter parsed with the existing `yaml` dependency. Permit only `name`, `description`, `tools`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `async`, and `maxSubagentDepth`. Require the role body to include all of these literal safety concepts: frozen brief, no subagents, no cleanup, no deploy, no push, bounded report, and configured verification.

Write the four role files. Reviewers use `read,bash,grep,find,ls`; `sdd-implementer` adds `edit,write`. All set `async: false`; background selection remains a Workflow transport decision rather than agent frontmatter.

- [ ] **Step 5: Implement bounded advisory handoff**

Validate exact keys and byte limits before delegating to `delegations.recordResult`:

```js
const allowed = new Set(["status", "generation", "summary", "verification", "concerns", "nextAction"]);
```

Require a matching active reservation for the role/mode before result persistence. The CLI reads only the canonical `handoff-input.json` below the delegation directory, rejects all alternate paths, and passes no raw environment beyond the identity allowlist.

- [ ] **Step 6: Run focused and full verification**

```bash
node --test test/workflow-delegation-roles.test.js test/workflow-delegation-handoff.test.js test/workflow-cli.test.js
npm test
git diff --check
```

Expected: passing static/CLI tests with no Pi invocation and no `.pi/settings.json`.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/workflow/delegation-roles.js src/workflow/delegation-handoff.js src/workflow/commands.js bin/workflow.js .pi/agents test/workflow-delegation-roles.test.js test/workflow-delegation-handoff.test.js test/workflow-cli.test.js
git commit -m "feat(workflow): validate Pi delegation roles and handoffs"
```

---

### Task 3: Build the Exact Private-Session Pi Transport

**Files:**
- Create: `src/workflow/pi-delegation-transport.js`
- Create: `test/workflow-pi-delegation-transport.test.js`
- Modify: `test/workflow-worker-transport.test.js`

**Interfaces:**
- `createPiDelegationTransport` satisfies `assertWorkerTransport`.
- Its injected `spawnChild({ command, argv, cwd, env })` returns `{ pid, startedAt }` and never runs through a shell.
- Its injected `inspectProcess(identity)` returns only bounded `{ pid, startedAt, cwd, active }` facts.

- [ ] **Step 1: Write failing argv and identity tests**

Assert a started child receives an argv containing the exact private session path, private session directory, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-approve`, the fixed child extension, and a comma-separated role allowlist. Assert it contains none of:

```text
--continue  --last  --resume  --fork  --approve  --session-dir ~/.pi
pi-subagents  --dangerously  --extension npm:  sh -c
```

Assert the identity retains exact run/delegation/session/cwd/pid/start time. Test that NUL, relative/escaping paths, non-managed tools, raw `PATH`/credential env fields, oversized bootstrap text, or a role/cwd mismatch fail before spawn.

- [ ] **Step 2: Write failing lifecycle observation tests**

Script `inspectProcess` results to prove `observeExact` returns `active` only when pid/start time/cwd all match, `missing` when absent, and `mismatch` when any fact differs. Assert `deliverFollowUp` refuses an active process, resumes only the exact recorded session when missing, and records only a new process identity. Assert `requestGracefulClose` returns `{ requested: false, manual: true }` and never calls a kill/signal dependency.

- [ ] **Step 3: Verify RED**

```bash
node --test test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js
```

Expected: FAIL because the Pi transport module does not exist.

- [ ] **Step 4: Implement safe child argv construction**

Construct argv as an array. Generate all paths beneath the supplied run directory and validate with `resolve`/`relative` containment checks. Build only this environment:

```js
{
  WORKFLOW_RUN_ID: runId,
  WORKFLOW_DELEGATION_ID: delegationId,
  WORKFLOW_DELEGATION_GENERATION: String(generation),
  WORKFLOW_RUN_DIR: runDirectory,
  WORKFLOW_STATE_ROOT: stateRoot,
  WORKFLOW_CONTROL_PLANE_BIN: controlPlaneBin,
}
```

Start through `spawnChild`; do not call `createProcessRunner`, because its timeout behavior sends SIGTERM. Bound/drain child streams inside the injected spawner and record only stream-byte counters/overflow flags as diagnostics.

- [ ] **Step 5: Implement exact observation and remediation launch**

`observeExact` compares every stored process fact. `deliverFollowUp` validates the prompt, calls `observeExact`, rejects `active`/`mismatch`, and starts a new child with the same `sessionPath` plus a new generation bootstrap. It never passes an arbitrary session string. `requestGracefulClose` records no process mutation and supplies manual-close guidance.

- [ ] **Step 6: Run focused and full verification**

```bash
node --test test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js test/workflow-delegation-services.test.js
npm test
git diff --check
```

Expected: every fake launch is argv-only; no executable, Pi session, or process is started.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/workflow/pi-delegation-transport.js test/workflow-pi-delegation-transport.test.js test/workflow-worker-transport.test.js
git commit -m "feat(workflow): launch governed Pi delegation sessions"
```

---

### Task 4: Add the Child and Coordinator Pi Extensions

**Files:**
- Create: `.pi/extensions/workflow-delegation-child.ts`
- Create: `.pi/extensions/workflow-coordinator/index.ts`
- Create: `src/workflow/delegation-watcher.js`
- Create: `test/workflow-delegation-watcher.test.js`
- Modify: `test/workflow-pi-extensions.test.js`
- Modify: `test/workflow-coordinator-policy.test.js`

**Interfaces:**
- Child extension registers `workflow_delegation_handoff` and no child delegation/management tools.
- Coordinator registers `workflow_prepare_delegation`, `workflow_execute_delegation`, `workflow_delegation_result`, `workflow_adopt_delegation_result`, and `workflow_remediate_delegation`.
- `createDelegationWatcher` delivers one bounded result after atomic store consumption only to its exact origin session.

- [ ] **Step 1: Write failing fake-Pi child-extension tests**

Load the child extension with a fake `ExtensionAPI`. Assert the factory creates no timer, watcher, process, file, or global configuration write. Assert `session_start` is inert without valid Workflow delegation env and records no raw prompt. Assert the handoff tool uses `StringEnum(["completed", "blocked", "failed"])`, calls the injected fixed handoff path, throws on invalid data, and returns `terminate: true` only after a successful terminal submission.

- [ ] **Step 2: Write failing coordinator guard/tool tests**

Assert the coordinator factory is inert until `session_start`. Its `tool_call` handler blocks only a `subagent` request that is direct, unsafe, nested, or mismatched according to the existing `validateSubagentRequestPolicy`; it does not rewrite input. Assert each Workflow delegation tool uses strict TypeBox schemas, refuses mutation without `ctx.hasUI`, renders the preview, calls `ctx.ui.confirm`, and executes only the approved in-memory digest.

- [ ] **Step 3: Write failing watcher race tests**

Use a fake timer/clock and deterministic delegation store. Cover start only after session start, one in-flight poll, terminal result consumed exactly once, wrong-origin result never injected, reload race loses no result, shutdown clears its timer, later session sees pending result but must explicitly adopt, and stale/manual statuses produce notices rather than completion turns.

```js
await watcher.poll();
await watcher.poll();
assert.equal(deliveries.length, 1);
assert.equal(deliveries[0].delegationId, delegationId);
```

- [ ] **Step 4: Verify RED**

```bash
node --test test/workflow-pi-extensions.test.js test/workflow-delegation-watcher.test.js test/workflow-coordinator-policy.test.js
```

Expected: FAIL because the extensions and watcher do not exist.

- [ ] **Step 5: Implement child extension lifecycle and handoff**

Use documented Pi `session_start`, `before_agent_start`, `agent_settled`, and `session_shutdown` events. Validate only the allowlisted environment. The extension uses no factory-side resource. Its terminal tool calls a function injected through the extension-local adapter that invokes the fixed CLI handoff; it never writes the result artifact directly.

- [ ] **Step 6: Implement watcher and coordinator tools**

The watcher calls `delegations.list({ originSessionId })`, filters terminal unconsumed current-generation records, then calls `consumeResult` before `onResult`. Its callback receives only:

```js
{ runId, delegationId, role, generation, state, summary, verification, concerns, nextAction }
```

The coordinator starts it in `session_start`, stops it in `session_shutdown`, and injects results through `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: ctx.isIdle() })`. A later session can call the explicit adoption tool; no implicit cross-session delivery exists.

- [ ] **Step 7: Run focused and full verification**

```bash
node --test test/workflow-pi-extensions.test.js test/workflow-delegation-watcher.test.js test/workflow-coordinator-policy.test.js
npm test
git diff --check
```

Expected: passing static extension contracts; no `pi -e`, model, or trust invocation.

- [ ] **Step 8: Commit Task 4**

```bash
git add .pi/extensions/workflow-delegation-child.ts .pi/extensions/workflow-coordinator/index.ts src/workflow/delegation-watcher.js test/workflow-pi-extensions.test.js test/workflow-delegation-watcher.test.js test/workflow-coordinator-policy.test.js
git commit -m "feat(workflow): deliver governed Pi delegation results"
```

---

### Task 5: Expose Safe Delegation CLI Operations and Reconciliation

**Files:**
- Modify: `src/workflow/commands.js`
- Modify: `src/workflow/format.js`
- Modify: `bin/workflow.js`
- Modify: `test/workflow-cli.test.js`
- Create: `test/workflow-delegation-commands.test.js`

**Interfaces:**
- Read-only: `workflow delegation result <run-id> <delegation-id>` and `workflow delegation reconcile <run-id> <delegation-id>`.
- Mutating preview/confirmation: `workflow delegation remediate <run-id> <delegation-id> --prompt-file <path> [--dry-run] [--approval-digest <digest>] [--yes]`.
- Fixed child-only handoff syntax from Task 2 remains non-interactive and never accepts arbitrary output paths.

- [ ] **Step 1: Write failing CLI parsing and exit-code tests**

Assert documented syntax accepts only path-safe IDs, compact/json format, and the existing prompt-file bounds. Reject guessed sessions, `--last`, `--continue`, raw prompt flags, background-writer overrides, `--output`, unsupported project paths, duplicate options, and noninteractive remediation lacking `--yes` plus current digest.

Assert `result`/`reconcile` expose bounded state and exact next actions without process mutation. Assert remediation dry-run creates no brief, reservation, session, or transport call; confirmed execution can only receive the preview digest.

- [ ] **Step 2: Write failing command-use-case tests**

Inject fake services and fake stores. Cover current result, pending result, stale result, missing/mismatched process identity, explicit result adoption, failed start with retained reservation, and remediation cap. Verify compact output never includes session transcripts, stdout/stderr, prompt bodies, credentials, reservation owner tokens, or raw state-root details.

- [ ] **Step 3: Verify RED**

```bash
node --test test/workflow-delegation-commands.test.js test/workflow-cli.test.js
```

Expected: FAIL because delegation command parsing and command use cases are absent.

- [ ] **Step 4: Implement fixed command dispatch**

Extend `parseArgs` with a `delegation` command family before generic command parsing. `result` and `reconcile` are read-only. `remediate` follows the existing launch preview/approval pattern and reads text only from a bounded UTF-8 `--prompt-file`. Reuse the existing error categories and output-bounding formatter; add a compact delegation formatter that shows IDs, role, mode, state, generation, result status, and next actions only.

- [ ] **Step 5: Implement service-backed command handlers**

Resolve the project from the parent run record and registry; reject a mismatched explicit project. Construct delegation services with the real private stores and injected transport only after a current preview is approved. `reconcile` calls service reconciliation but never starts/replaces a process. `result` returns advisory data and explicitly labels it non-canonical for external runs.

- [ ] **Step 6: Run focused and full verification**

```bash
node --test test/workflow-delegation-commands.test.js test/workflow-cli.test.js test/workflow-format.test.js
npm test
git diff --check
```

Expected: all delegation operations are deterministic, bounded, and no-op in dry-run/read-only modes.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/workflow/commands.js src/workflow/format.js bin/workflow.js test/workflow-delegation-commands.test.js test/workflow-cli.test.js
git commit -m "feat(workflow): reconcile governed Pi delegations"
```

---

### Task 6: Replace the Package Rollout and Document the Adapter

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md`
- Modify: `test/workflow-docs.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Documentation identifies the adapter as Workflow-owned and states that `pi-subagents` is neither installed nor a dependency.
- The remaining lifecycle plan owns external hooks/Herdr transport/resume/close only; it consumes, rather than recreates, the adapter contracts.

- [ ] **Step 1: Write failing documentation/configuration assertions**

Assert README names `workflow delegation result`, `workflow delegation reconcile`, exact private sessions, advisory internal results, origin-session adoption, one writer per checkout, no terminal scraping, and the writer-background fixture gate. Assert it says `pi-subagents` is not installed or used.

Assert `.gitignore` excludes `.pi/npm/`, `.pi/sessions/`, and generated `.pi-subagents/` defensively, while tests assert no such path is tracked. Assert `package.json.files` packages `.pi/agents` and `.pi/extensions` so the fixed child/coordinator extension paths exist when the control plane is installed. Do not create ignored directories.

- [ ] **Step 2: Verify RED**

```bash
node --test test/workflow-docs.test.js
```

Expected: FAIL because the adapter-specific documentation and ignore assertions are absent.

- [ ] **Step 3: Revise the downstream lifecycle plan**

Replace package-installation/role tasks with an adapter-integration prerequisite referencing this plan. Retain external lifecycle hooks, the Herdr external transport, exact external resume/close, and the explicit Codex trust checkpoint. Remove every instruction to run `pi install`, `pi list`, package commands, package internals, user-level subagent config, or a real Pi package smoke.

- [ ] **Step 4: Document the operational boundary**

Add `.pi/agents` and `.pi/extensions` to `package.json.files`. Add a README table distinguishing external canonical worker results from internal advisory delegation results. State that child sessions are Workflow-private, results return through the child handoff plus origin-session watcher, background writers remain denied until fixture gates, and no daemon/package/global Pi state is used.

- [ ] **Step 5: Run final adapter verification**

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: all tests pass; package contents include no `.pi/npm`, session state, generated artifacts, package cache, or credentials.

- [ ] **Step 6: Commit Task 6**

```bash
git add README.md package.json .gitignore test/workflow-docs.test.js docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md
git commit -m "docs(workflow): document owned Pi delegation adapter"
```

## Completion Gate

Before executing the revised external lifecycle plan or generated fixtures:

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
git status --short
```

Then review the full diff against `2026-07-19-workflow-owned-pi-delegation-adapter-design.md`, specifically verifying: no `pi-subagents` references except explicit rejection/documentation; no user/global Pi state; no terminal-derived result field; every private path stays below its parent run directory; no automatic reservation release/cleanup/kill; and no background writer enablement.

Do not run a real Pi child, trust prompt, model call, external worker, fixture, or canary in this plan. Those require later explicit checkpoints.
