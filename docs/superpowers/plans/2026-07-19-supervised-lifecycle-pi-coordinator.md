# Supervised Lifecycle and Pi Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supervise Pi/Claude/Codex turns with native lifecycle hooks, generation-aware handoffs, exact-session resume/reconciliation, Pi-session result delivery, and conservative internal Pi delegation.

**Architecture:** A harness-neutral lifecycle callback updates the private run store from native SessionStart/UserPromptSubmit/Stop/SessionEnd events. Generated Claude settings, an explicitly installed Codex hook profile, and a launched-worker Pi extension adapt native event shapes; a separate project-local coordinator extension previews/executes CLI plans, watches only runs owned by its Pi session, and injects validated results without terminal scraping.

**Tech Stack:** Node.js 24 ES modules, `node:test`, Pi extension API 0.80+, Claude Code hooks 2.1+, Codex hooks 0.144+, Herdr 0.7.4, `pi-subagents@0.34.0` project-local package.

> **Amendment — two-lane delegation:** Complete `2026-07-19-two-lane-delegation-foundation.md` first. This plan must consume its project policy, private delegation store, durable reservations, prepared-request validator, and narrow worker transport; it must not reimplement their state or lock rules.

## Global Constraints

- Complete and review the multi-harness launch-core plan before starting this plan.
- Follow strict red-green-refactor TDD for every production behavior.
- A prompt or skill is advisory; native hooks and the run state machine own lifecycle truth.
- Stop-hook continuation is bounded to two workflow-owned attempts and must never loop indefinitely.
- Follow-up prompts typed directly in a worker increment the generation and stale any earlier result.
- User interrupt/session close must always remain possible; SessionEnd hooks never block closure.
- Process disappearance without a current valid handoff is not success.
- Resume must target an exact native session ID/path or refuse to guess; never use `--last` or `--continue` heuristics.
- Never scrape terminal text for lifecycle or results.
- No agent, hook, or extension may delete a branch/worktree/workspace/run or perform deployment/production mutation.
- Explicit close sends a graceful idle-session exit only after process identity validation; it must not kill an unknown or working process.
- No permission, sandbox, or hook-trust bypass flags.
- `pi-subagents` is pinned exactly to `0.34.0`, used only through its supported public Pi tool surface and never through package internals.
- Internal package worktrees, nested delegation, watchdog/scheduling/configuration actions, and unprepared requests are always blocked.
- Background Pi delegations follow the effective project policy: read-only scouts/reviewers may be enabled only by a prepared request and durable reservation; writers remain foreground until the generated writer fixture gate succeeds, then still require a workflow-owned worktree and one writer-per-checkout reservation.
- Concurrency follows the effective per-project policy rather than a fixed global cap; every request must hold matching total, role/mode, and writer-checkout capacity.
- Install project packages and user-level Codex hook configuration only at their explicit checkpoints.
- Start Pi timers/watchers only during `session_start`; stop them idempotently during `session_shutdown`.
- Results may be injected only into the exact originating Pi session; later sessions require explicit adoption.
- Never expose session transcript contents, `.env`, auth stores, hook trust stores, credentials, or raw environment data.
- End every task with focused tests, full `npm test`, `git diff --check`, specification review, and code-quality review.

---

## Planned File Structure

```text
bin/
  workflow.js                              resume/reconcile/close/hooks commands
  workflow-handoff-hook.js                 Native hook stdin adapter
src/workflow/
  delegation-policy.js                     Effective project limits and role classification
  delegation-store.js                      Frozen briefs, bounded internal state, generations
  delegation-reservations.js               Durable capacity and writer-checkout ownership
  worker-transport.js                      Exact external/internal transport boundary
  lifecycle.js                             Harness-neutral generation protocol
  hook-config.js                           Claude/Codex reviewed hook configuration
  resume.js                                Exact live/dead session resume planning/execution
  close.js                                 Explicit graceful worker close
  coordinator-policy.js                    Pi subagent/launch policy helpers
  coordinator-runs.js                      Session-owned watcher/adoption logic
  commands.js                              Lifecycle command use cases
  harnesses.js                             Hook-enabled launch and exact resume argv
  herdr.js                                 send-text/send-keys/focus/wait helpers
  launch.js                                Hook-enabled run startup
  reconcile.js                             Lifecycle/process/Git run reconciliation
  run-store.js                             Generation/result/event operations
.pi/
  settings.json                            Pinned project package source
  agents/
    sdd-implementer.md
    spec-reviewer.md
    code-reviewer.md
  extensions/
    workflow-worker-lifecycle.ts           Pi worker hook adapter and handoff tool
    workflow-coordinator/
      index.ts                             Thin Pi coordinator extension
      package.json                         Peer dependencies only when needed
scripts/
  install-codex-workflow-hooks.js          Previewable fixed profile installer

test/
  workflow-lifecycle.test.js
  workflow-hook-config.test.js
  workflow-resume.test.js
  workflow-close.test.js
  workflow-coordinator-policy.test.js
  workflow-coordinator-runs.test.js
  workflow-pi-extensions.test.js
  workflow-cli.test.js                     Extended
  workflow-commands.test.js                Extended
  workflow-harnesses.test.js               Extended
  workflow-reconcile.test.js               Extended
```

---

### Task 0: Two-Lane Foundation Integration

**Prerequisite:** `2026-07-19-two-lane-delegation-foundation.md` is complete with fresh full-suite evidence.

Before any hook, package, or coordinator extension work, inject `resolveDelegationPolicy`, `createDelegationStore`, `createDelegationReservationStore`, `assertWorkerTransport`, and `validateSubagentRequestPolicy` through the lifecycle/coordinator dependencies. Add only adapter wiring tests here: no hook/user configuration write, package installation, or model invocation. External lifecycle continues to use canonical worker handoffs; internal delegation outputs remain advisory.

### Task 1: Generation-Aware Native Lifecycle Callback

**Files:**
- Create: `src/workflow/lifecycle.js`
- Create: `bin/workflow-handoff-hook.js`
- Create: `test/workflow-lifecycle.test.js`
- Modify: `package.json`
- Modify: `src/workflow/run-store.js`
- Modify: `src/workflow/run-state.js`

**Interfaces:**
- Produces `handleLifecycleEvent({ eventName, harness, input, env, store, git }) -> { exitCode, stdout, state }`.
- Produces `deriveLifecycleEventId({ eventName, harness, input, transcriptStat? }) -> string`.
- Adds run-store methods `beginPrompt`, `recordSession`, `recordStopAttempt`, `recordSessionEnd`, and `consumeResult`.
- Installs bin `workflow-handoff-hook` that accepts one fixed event-name argv and JSON stdin.

- [ ] **Step 1: Write failing lifecycle state tests**

Create table-driven tests for `pi`, `claude`, and `codex` event normalization. Cover:

- Session start captures only the matching harness/session/cwd.
- First prompt confirms generation 1.
- Second prompt archives generation 1, increments to 2, and changes terminal state back to `running`.
- Duplicate event IDs are idempotent.
- Stop with a valid current result allows stop and transitions to its reported state.
- Stop without a result returns `decision: "block"` twice.
- Third missing-result stop records `manual-handoff-required` and returns no block.
- Stop with a stale generation/fingerprint behaves as missing.
- SessionEnd with a result preserves it; without one records `interrupted`.
- User interrupt events that do not emit Stop are reconciled through SessionEnd.
- Malformed/NUL/oversized JSON fails closed with bounded output.

```js
test("bounds missing-handoff continuation and then requires manual handoff", async () => {
  const first = await handleLifecycleEvent(fixture.stopEvent());
  assert.deepEqual(JSON.parse(first.stdout), {
    decision: "block",
    reason: fixture.expectedHandoffInstruction(1),
  });

  const second = await handleLifecycleEvent(fixture.stopEvent({ eventId: "stop-2" }));
  assert.equal(JSON.parse(second.stdout).decision, "block");

  const third = await handleLifecycleEvent(fixture.stopEvent({ eventId: "stop-3" }));
  assert.equal(third.stdout, "");
  assert.equal((await fixture.store.read(fixture.runId)).state, "manual-handoff-required");
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/workflow-lifecycle.test.js`

Expected: FAIL because lifecycle module/bin do not exist.

- [ ] **Step 3: Implement strict event normalization**

Accept only allowlisted env keys:

```js
const requiredEnv = {
  runId: env.WORKFLOW_RUN_ID,
  runDir: env.WORKFLOW_RUN_DIR,
  generation: Number(env.WORKFLOW_GENERATION),
  harness: env.WORKFLOW_HARNESS,
};
```

Reject a run directory that is not the store's canonical directory for that run. Validate `session_id`, `cwd`, `turn_id`, `prompt`, `stop_hook_active`, and `last_assistant_message` only as bounded metadata; never persist prompt or assistant content in lifecycle events.

Use an explicit event ID when provided. Otherwise derive a SHA-256 ID from event name, harness, session ID, turn ID when present, bounded prompt digest, transcript path, and transcript file size. Do not parse transcripts.

- [ ] **Step 4: Implement prompt/stop/session transitions**

The first prompt event for a run confirms generation 1; later unique prompt events increment. Archive `result.json` before clearing current result metadata. Stop-hook retry counts are per generation and reset on the next prompt.

Continuation reason must be deterministic and bounded:

```text
Before ending this turn, create a workflow handoff for run <id>, generation <n>.
Use status completed, blocked, needs-input, or failed. Run the exact handoff command from assignment.md.
Do not perform cleanup or start unrelated work.
```

- [ ] **Step 5: Implement the hook executable**

`bin/workflow-handoff-hook.js` accepts exactly:

```text
session-start
prompt-submit
stop
session-end
```

It reads at most 256 KiB from stdin, maps `WORKFLOW_HARNESS`, invokes `handleLifecycleEvent`, writes only protocol JSON/empty stdout, writes bounded diagnostics to stderr, and sets the returned exit code. It must not load the canonical registry when run identity already resolves the state root from `WORKFLOW_STATE_ROOT`.

Add to `package.json`:

```json
"workflow-handoff-hook": "./bin/workflow-handoff-hook.js"
```

- [ ] **Step 6: Run focused and full tests**

```bash
node --test test/workflow-lifecycle.test.js test/workflow-run-store.test.js test/workflow-handoff.test.js
npm test
git diff --check
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add package.json package-lock.json bin/workflow-handoff-hook.js src/workflow/lifecycle.js src/workflow/run-store.js src/workflow/run-state.js test/workflow-lifecycle.test.js
git commit -m "feat(workflow): supervise worker lifecycle generations"
```

---

### Task 2: Native Pi, Claude, and Codex Hook Configuration

**Files:**
- Create: `src/workflow/hook-config.js`
- Create: `.pi/extensions/workflow-worker-lifecycle.ts`
- Create: `scripts/install-codex-workflow-hooks.js`
- Create: `test/workflow-hook-config.test.js`
- Create: `test/workflow-pi-extensions.test.js`
- Modify: `src/workflow/harnesses.js`
- Modify: `src/workflow/launch.js`
- Modify: `src/workflow/commands.js`
- Modify: `bin/workflow.js`
- Modify: `test/workflow-harnesses.test.js`
- Modify: `test/workflow-commands.test.js`
- Modify: `test/workflow-cli.test.js`

**Interfaces:**
- Produces `buildClaudeHookSettings({ hookBinary }) -> object`.
- Produces `buildCodexHookProfile({ hookBinary }) -> string`.
- Produces `inspectHookReadiness({ harness, paths }) -> diagnostic`.
- Adds `workflow hooks doctor [pi|claude|codex]` and previewable `workflow hooks install codex`.
- Pi worker extension registers lifecycle events and `workflow_handoff` tool.

- [ ] **Step 1: Write failing static hook-configuration tests**

Assert Claude settings contain command hooks for `SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd`, all calling one fixed absolute executable plus fixed event name. Assert no run ID, prompt, ticket text, shell substitution, or dangerous flag enters the command string.

Assert Codex TOML has the same events, uses command hooks only, and contains neither `dangerously-bypass-hook-trust` nor global auth/provider settings.

```js
const settings = buildClaudeHookSettings({ hookBinary: "/opt/workflow-handoff-hook" });
assert.equal(settings.hooks.Stop[0].hooks[0].command, "/opt/workflow-handoff-hook stop");
assert.equal(JSON.stringify(settings).includes("WORKFLOW_RUN_ID"), false);
```

Reject hook binary paths containing newline, NUL, shell metacharacters that cannot be represented safely, or relative paths.

- [ ] **Step 2: Write failing Pi worker-extension contract tests**

Load the extension through a fake Pi API and assert:

- `session_start` records SessionStart only with valid workflow env.
- `before_agent_start` records prompt submission.
- `agent_settled` validates current handoff, queues at most two continuation messages, then records manual fallback.
- `session_shutdown` records SessionEnd and clears timers.
- `workflow_handoff` accepts structured semantic fields, calls the core submission function, and returns `terminate: true` only for a successful terminal handoff.
- Without workflow env the extension is inert.

- [ ] **Step 3: Verify RED**

Run:

```bash
node --test test/workflow-hook-config.test.js test/workflow-pi-extensions.test.js test/workflow-harnesses.test.js
```

Expected: FAIL because hook configuration/extension are absent.

- [ ] **Step 4: Implement Claude per-run settings**

Write generated settings to `<runDir>/hooks/claude-settings.json` with mode `0600` and launch Claude with:

```text
claude --name <session> --session-id <uuid>
  --permission-mode manual
  --add-dir <runDir>
  --settings <runDir>/hooks/claude-settings.json
  [--model <model>]
  <bootstrap>
```

Do not replace the user's normal settings sources; the additional settings layer only contributes workflow hooks.

- [ ] **Step 5: Implement explicit Codex profile installation**

`workflow hooks install codex` previews the exact target and TOML before writing. With confirmation/`--yes`, write `$CODEX_HOME/workflow-handoff.config.toml` or `~/.codex/workflow-handoff.config.toml` atomically with `0600`. It must contain only hook tables and fixed callback paths.

After installation, print manual trust steps:

```text
1. Run: codex --profile workflow-handoff
2. Review the four fixed workflow-handoff-hook commands.
3. Accept hook trust in Codex, then exit without sending a task.
4. Run: workflow hooks acknowledge codex --yes
```

`acknowledge` writes only a control-plane marker containing the profile digest and timestamp. It does not inspect or modify Codex auth/trust stores. Launch requires installed profile digest plus acknowledgement; a profile change invalidates acknowledgement.

Codex launch argv includes `--profile workflow-handoff`, safe sandbox/approval flags, run directory, and bootstrap. Never add the trust-bypass flag.

- [ ] **Step 6: Implement Pi lifecycle adapter**

The extension imports core lifecycle/handoff functions from the control-plane checkout, starts no resources in its factory, and uses Pi's documented `session_start`, `before_agent_start`, `agent_settled`, and `session_shutdown` events. Use `pi.sendUserMessage(reason, { deliverAs: "followUp" })` only when the current generation still lacks a valid result.

The handoff tool schema uses `StringEnum` for status fields and bounded arrays. Throw on validation failure; never return an error-looking success object.

Pi worker argv adds the explicit extension path with `-e` and retains project context/skills. Do not globally install this worker extension.

- [ ] **Step 7: Extend doctor and launch readiness**

`workflow hooks doctor` checks executable paths, generated-setting validity, Codex profile digest/acknowledgement, and installed harness versions without reading credentials. Profile-specific launch preconditions require the matching lifecycle integration.

- [ ] **Step 8: Run focused and full tests**

```bash
node --test test/workflow-hook-config.test.js test/workflow-pi-extensions.test.js test/workflow-harnesses.test.js test/workflow-commands.test.js test/workflow-cli.test.js
npm test
git diff --check
```

Expected: all tests pass; no user hook files are written by tests.

- [ ] **Step 9: Explicit local Codex-hook checkpoint**

Run only after reviewing the generated preview:

```bash
node bin/workflow.js hooks install codex
```

Do not pass `--yes` until the displayed target and four commands match the reviewed implementation. Complete the manual Codex trust flow; do not use `--dangerously-bypass-hook-trust`.

- [ ] **Step 10: Commit Task 2**

```bash
git add bin/workflow.js src/workflow/hook-config.js src/workflow/harnesses.js src/workflow/launch.js src/workflow/commands.js .pi/extensions/workflow-worker-lifecycle.ts scripts/install-codex-workflow-hooks.js test/workflow-hook-config.test.js test/workflow-pi-extensions.test.js test/workflow-harnesses.test.js test/workflow-commands.test.js test/workflow-cli.test.js package.json package-lock.json
git commit -m "feat(workflow): integrate native worker lifecycle hooks"
```

Do not add files from `~/.codex` or any trust/auth store to Git.

---

### Task 3: Exact Resume, Reconciliation, and Graceful Close

**Files:**
- Create: `src/workflow/resume.js`
- Create: `src/workflow/close.js`
- Create: `test/workflow-resume.test.js`
- Create: `test/workflow-close.test.js`
- Modify: `src/workflow/harnesses.js`
- Modify: `src/workflow/herdr.js`
- Modify: `src/workflow/reconcile.js`
- Modify: `src/workflow/commands.js`
- Modify: `src/workflow/format.js`
- Modify: `bin/workflow.js`
- Modify: `test/workflow-harnesses.test.js`
- Modify: `test/workflow-herdr.test.js`
- Modify: `test/workflow-reconcile.test.js`
- Modify: `test/workflow-cli.test.js`

**Interfaces:**
- Produces `createResumePreview({ runId, promptFile? }, deps)` and `executeResume(preview, deps)`.
- Produces `reconcileRun({ runId, store, git, herdr }) -> RunReconciliation`.
- Produces `createClosePreview({ runId }, deps)` and `executeClose(preview, deps)`.
- Herdr adapter adds `sendText`, `sendKeys`, `focusAgent`, `waitForAgentStatus`, and read-only exact-agent lookup.

- [ ] **Step 1: Write failing exact-resume tests**

Cover:

- Alive exact worker + follow-up prompt: preview, idle check, `send-text`, then Enter, generation increment through native hook.
- Alive working/blocked worker: no automatic send and manual-focus guidance.
- Dead Pi with session path/ID: `pi --session <exact>`.
- Dead Claude with UUID: `claude --resume <exact>`.
- Dead Codex with UUID/name: exact resume argv using `codex resume <exact-session-id> <bootstrap>`.
- Missing native reference: refuse with new-run guidance; never `--last`, `--continue`, or picker automation.
- Existing other writer: conflict.
- Follow-up changes approval digest and stale previous result.

```js
for (const spec of [piResume, claudeResume, codexResume]) {
  assert.equal(spec.argv.includes("--last"), false);
  assert.equal(spec.argv.includes("--continue"), false);
  assert.match(spec.argv.join(" "), new RegExp(run.nativeSession.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
```

- [ ] **Step 2: Write failing reconcile/close tests**

Reconcile cases:

- active worker/current generation;
- idle worker owing a handoff;
- closed worker with current result;
- closed/killed worker without result;
- result stale after prompt event;
- result stale after Git fingerprint change;
- missing Herdr workspace with preserved Git worktree;
- corrupted run state fails closed.

Close cases:

- explicit confirmed close sends `ctrl+d` only to an idle exact pane;
- current result is not required but pending-state warning is displayed;
- working, unknown, missing, or identity-mismatched process is never sent keys;
- no pane/tab/workspace close command and no process kill occurs;
- timeout returns `manual-close-required` and preserves resources.

- [ ] **Step 3: Verify RED**

```bash
node --test test/workflow-resume.test.js test/workflow-close.test.js test/workflow-reconcile.test.js
```

Expected: FAIL for missing modules/methods.

- [ ] **Step 4: Implement exact harness resume specs**

Construct `profileArgs` first from the validated profile (model only when non-null, safe permission/hook options only), then use these exact array layouts:

```js
const piArgv = [command, "--session", exactSession, "--name", sessionName].concat(profileArgs, [bootstrap]);
const claudeArgv = [command, "--resume", exactSession, "--name", sessionName].concat(profileArgs, [bootstrap]);
const codexArgv = [command, "resume"].concat(profileArgs, [exactSession, bootstrap]);
```

Keep Codex options in positions accepted by `codex resume --help`. Add unit tests against the installed help contract, but do not invoke a model.

- [ ] **Step 5: Implement live follow-up delivery**

For an exact idle pane:

1. Revalidate run/harness/cwd/process identity.
2. Write the approved follow-up into the run directory with `0600`.
3. Send a short instruction via `herdr pane send-text <pane> <text>`.
4. Send Enter via `herdr pane send-keys <pane> enter`.
5. Do not claim delivery until Herdr reports success.

If direct native prompt hooks later increment generation, that event remains authoritative; executor-side state only records `follow-up-delivery-requested`.

- [ ] **Step 6: Implement operational reconciliation**

Return bounded structured evidence:

```js
{
  runId,
  state,
  worker: { harness, profile, process: "active|idle|missing|mismatch", workspaceId, tabId, paneId, nativeSession },
  generation: { current, resultGeneration, stopAttempts },
  git: [{ repository, head, digest, matchesResult }],
  result: { status: "current|missing|invalid|stale", consumed },
  nextActions: [],
}
```

Do not read source files or transcripts. Use run state, Herdr/process facts, and Git fingerprints only.

- [ ] **Step 7: Implement graceful close and CLI commands**

Add:

```text
workflow resume <run-id> [--prompt-file <path>] [--dry-run] [--approval-digest <sha>] [--yes]
workflow reconcile [project] --run <run-id> [--format compact|json]
workflow close <run-id> [--dry-run] [--approval-digest <sha>] [--yes]
```

Resume and close are mutating and require preview/confirmation. Reconcile is read-only. Close sends only graceful exit keys after exact idle validation and never deletes resources.

- [ ] **Step 8: Run focused and full tests**

```bash
node --test test/workflow-resume.test.js test/workflow-close.test.js test/workflow-reconcile.test.js test/workflow-harnesses.test.js test/workflow-herdr.test.js test/workflow-cli.test.js
npm test
git diff --check
```

Expected: all tests pass.

- [ ] **Step 9: Commit Task 3**

```bash
git add bin/workflow.js src/workflow/resume.js src/workflow/close.js src/workflow/harnesses.js src/workflow/herdr.js src/workflow/reconcile.js src/workflow/commands.js src/workflow/format.js test/workflow-resume.test.js test/workflow-close.test.js test/workflow-harnesses.test.js test/workflow-herdr.test.js test/workflow-reconcile.test.js test/workflow-cli.test.js
git commit -m "feat(workflow): reconcile and resume exact worker sessions"
```

---

### Task 4: Pi Coordinator Extension and Session-Owned Result Watcher

**Files:**
- Create: `src/workflow/coordinator-policy.js`
- Create: `src/workflow/coordinator-runs.js`
- Create: `.pi/extensions/workflow-coordinator/index.ts`
- Create: `test/workflow-coordinator-policy.test.js`
- Create: `test/workflow-coordinator-runs.test.js`
- Modify: `test/workflow-pi-extensions.test.js`

**Interfaces:**
- Produces `validateSubagentRequestPolicy(input) -> { allowed, reason? }`.
- Produces `createRunWatcher({ store, originSessionId, onResult, intervalMs?, clock? })` with `start()`, `poll()`, `stop()`.
- Coordinator extension registers launch/reconcile/result/adopt/resume tools and slash commands.

- [ ] **Step 1: Write failing subagent policy tests**

```js
test("blocks unsupported internal background, worktree, and excessive concurrency", () => {
  assert.match(validateSubagentRequestPolicy({ async: true }).reason, /foreground/i);
  assert.match(validateSubagentRequestPolicy({ worktree: true }).reason, /launcher-owned worktree/i);
  assert.match(validateSubagentRequestPolicy({ tasks: [{ agent: "a" }, { agent: "b" }], concurrency: 4 }).reason, /maximum.*3/i);
  assert.equal(validateSubagentRequestPolicy({ agent: "spec-reviewer", task: "Review", async: false }).allowed, true);
});
```

Walk sequential/static-parallel request shapes recursively. Block a child agent definition that requests `subagent` tools through the coordinator's managed roles. Unknown management actions pass through only when non-mutating; persistent config actions require direct user invocation rather than model automation.

- [ ] **Step 2: Write failing watcher/adoption tests**

Cover:

- watcher starts only after session start;
- lists only unconsumed runs whose `originSessionId` exactly matches;
- injects one bounded result and atomically marks it consumed by that session;
- no duplicate injection after reload/poll races;
- no injection into a different session;
- shutdown clears timer and leaves results persistent;
- a new session lists pending runs but requires explicit adoption;
- stale/manual results produce status notices, not completion turns.

Use fake timers/callbacks; never sleep in unit tests.

- [ ] **Step 3: Verify RED**

```bash
node --test test/workflow-coordinator-policy.test.js test/workflow-coordinator-runs.test.js test/workflow-pi-extensions.test.js
```

Expected: FAIL because coordinator modules/extension do not exist.

- [ ] **Step 4: Implement the session-owned watcher**

The watcher polls bounded metadata, not terminal content. It has one in-flight poll, uses an unref'd timer where supported, stops idempotently, and calls `store.consumeResult(runId, originSessionId)` before notification to win races.

A completion callback receives only:

```js
{
  runId,
  state,
  harness,
  summary,
  tickets,
  verification,
  concerns,
  nextAction,
  workspace,
}
```

- [ ] **Step 5: Implement thin Pi tools with UI confirmation**

Register tools with strict TypeBox schemas:

- `workflow_prepare_launch`
- `workflow_execute_launch`
- `workflow_reconcile_run`
- `workflow_result`
- `workflow_adopt_result`
- `workflow_resume_run`

The prepare tool returns/renders the complete assignment and approval digest. Execute/resume require `ctx.hasUI`, call `ctx.ui.confirm`, and execute exactly the in-memory approved preview; headless modes fail closed with a CLI command. The extension does not infer paths outside `projects.yaml` and uses the existing read-only Asana CLI only as context gathering.

On a watcher result, use:

```ts
pi.sendMessage({
  customType: "workflow-run-result",
  content: boundedSummary,
  display: true,
  details,
}, {
  deliverAs: "followUp",
  triggerTurn: ctx.isIdle(),
});
```

Start the watcher in `session_start`; stop in `session_shutdown`. Persist minimal extension state through run-store consumption, not a second database.

- [ ] **Step 6: Enforce subagent policy at `tool_call`**

When `event.toolName === "subagent"`, call `validateSubagentRequestPolicy`. Return `{ block: true, reason }` for async, internal worktree, or concurrency violations. Do not mutate a dangerous request into a seemingly approved one.

- [ ] **Step 7: Run extension tests and manual load smoke**

```bash
node --test test/workflow-coordinator-policy.test.js test/workflow-coordinator-runs.test.js test/workflow-pi-extensions.test.js
npm test
pi -e ./.pi/extensions/workflow-coordinator/index.ts --no-session -p "List the workflow coordinator tools; do not launch anything."
git diff --check
```

Expected: tests pass; Pi lists tools and performs no mutation. This manual smoke may call the configured model once; show the command and obtain approval before running it if token use was not already approved for this verification.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/workflow/coordinator-policy.js src/workflow/coordinator-runs.js .pi/extensions/workflow-coordinator/index.ts test/workflow-coordinator-policy.test.js test/workflow-coordinator-runs.test.js test/workflow-pi-extensions.test.js
git commit -m "feat(workflow): notify the originating Pi coordinator"
```

---

### Task 5: Pinned `pi-subagents` and Conservative SDD Roles

**Files:**
- Create/Modify: `.pi/settings.json`
- Create: `.pi/agents/sdd-implementer.md`
- Create: `.pi/agents/spec-reviewer.md`
- Create: `.pi/agents/code-reviewer.md`
- Modify: `.gitignore`
- Create: `test/workflow-subagents-config.test.js`
- Modify: `README.md`

**Interfaces:**
- Project Pi settings load exactly `npm:pi-subagents@0.34.0`.
- Three project agents are discoverable with bounded tools and no nested subagent tool.
- Coordinator policy remains the hard local guard for async/worktree/concurrency requests.

- [ ] **Step 1: Review the exact package before installation**

Run in a disposable directory:

```bash
npm view pi-subagents@0.34.0 version dist.integrity dist.tarball --json
npm pack pi-subagents@0.34.0 --dry-run
```

Download/extract the tarball under `/tmp`, verify `package.json` version and Pi manifest, and review extension entrypoints plus install scripts. Confirm there is no package export for later `delegation`/`background-work` APIs and no install script that mutates unrelated user state. Record the integrity in the task report; do not commit the tarball.

- [ ] **Step 2: Write failing config-policy tests**

Test that `.pi/settings.json` contains the exact pinned source, not an unversioned/latest range. Parse each agent frontmatter and assert:

- no `subagent` tool;
- `maxSubagentDepth: 1`;
- `async` absent or false;
- implementer has read/bash/edit/write;
- reviewers omit edit/write and explicitly prohibit modifications in prose;
- all inherit project context;
- names are exact and unique.

Also assert `.gitignore` ignores `.pi/npm/` and no `.pi/npm` content is tracked.

- [ ] **Step 3: Verify RED**

Run: `node --test test/workflow-subagents-config.test.js`

Expected: FAIL because settings/agents are absent.

- [ ] **Step 4: Install the pinned package locally**

After source review:

```bash
pi install -l npm:pi-subagents@0.34.0
```

Inspect the resulting `.pi/settings.json`. Keep only the exact package entry generated by Pi; do not manually copy package source into the repository. Add `.pi/npm/` to `.gitignore`.

- [ ] **Step 5: Add conservative agent definitions**

Use this frontmatter shape for the implementer:

```yaml
---
name: sdd-implementer
description: Implements one approved plan task with TDD and a bounded report
tools: read,bash,edit,write
systemPromptMode: append
inheritProjectContext: true
inheritSkills: true
async: false
maxSubagentDepth: 1
---
```

The body must require: one task only, no subagents, TDD, no unapproved design changes, configured tests, `git diff --check`, no cleanup/push/deploy, and a final report with files/commands/risks.

Reviewers use `tools: read,bash`, `async: false`, `maxSubagentDepth: 1`, no edits, and distinct prompts:

- `spec-reviewer`: compare implementation only to task/spec; report missing/extra behavior.
- `code-reviewer`: inspect correctness, safety, tests, simplicity, and regressions after spec approval.

- [ ] **Step 6: Validate package and agent discovery**

```bash
node --test test/workflow-subagents-config.test.js
pi list
```

Then start an interactive trusted project Pi and run:

```text
/subagents-doctor
/subagents sdd-implementer details
/subagents spec-reviewer details
/subagents code-reviewer details
```

Do not launch a writing child in the main checkout. Use a read-only reviewer prompt or the later generated fixture for a real child test.

- [ ] **Step 7: Update documentation**

Document exact pin, foreground-only policy, max concurrency 3, no internal worktrees/watchdog, managed roles, coordinator tool-call guard, and the fact that version 0.34 has no public extension API. Document that upgrading requires separate review.

- [ ] **Step 8: Run full verification and commit**

```bash
npm test
npm pack --dry-run
git diff --check
git status --short
```

Then:

```bash
git add .pi/settings.json .pi/agents/sdd-implementer.md .pi/agents/spec-reviewer.md .pi/agents/code-reviewer.md .gitignore test/workflow-subagents-config.test.js README.md
git commit -m "chore(workflow): pin conservative Pi subagents"
```

Never add `.pi/npm/`, `~/.pi`, sessions, run history, auth, or package caches.

---

### Task 6: Lifecycle Documentation and Stage Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-19-multi-harness-workflow-coordinator-design.md` only if verified implementation constraints require a documented correction
- Modify: `test/workflow-docs.test.js`

**Interfaces:**
- User documentation covers lifecycle states, generations, native hooks, fallback, resume/reconcile, closed Pi adoption, and explicit graceful close.

- [ ] **Step 1: Write failing documentation assertions**

Assert README contains commands/examples for:

```text
workflow hooks doctor
workflow resume <run-id>
workflow reconcile --run <run-id>
workflow result <run-id>
workflow close <run-id>
manual-handoff-required
result-stale
```

Also assert it states no terminal scraping, no guessed recent session, no automatic cleanup, and no cross-session result injection.

- [ ] **Step 2: Update operational documentation**

Include scenario tables:

| Scenario | Reconciled behavior |
|---|---|
| Origin Pi closes | result persists; later session explicitly adopts |
| Worker gets follow-up prompt | generation increments; previous result stales |
| Worker closes with result | terminal result remains current |
| Worker closes without result | interrupted/manual handoff |
| Process is killed | later reconcile detects missing process |
| Git changes after handoff | result-stale |
| Native session ID missing | resume refuses to guess |

Explain that “return to Pi” means hook → run store → Pi watcher, not terminal switching. Explain hooks improve compliance but the hard guarantee is that missing/invalid/stale handoffs never become success.

- [ ] **Step 3: Run complete stage verification**

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
node bin/workflow.js doctor --format compact
node bin/workflow.js hooks doctor --format compact
pi list
```

Expected: all automated checks pass; doctor reports actual installed hook/package readiness without exposing credentials.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md test/workflow-docs.test.js docs/superpowers/specs/2026-07-19-multi-harness-workflow-coordinator-design.md
git commit -m "docs(workflow): explain supervised agent lifecycle"
```

If the spec was unchanged, omit it from `git add`.

---

## Stage 2 Completion Gate

Before building the fixture/canaries:

1. Run the full verification commands from Task 6 with fresh output.
2. Run fresh specification and code-quality/security reviewers.
3. Exercise only read-only coordinator commands in the real control-plane Pi session.
4. Confirm no unexpected workspaces, workers, user config, or tracked package caches were created.
5. Record exact Pi/Claude/Codex/Herdr and `pi-subagents` versions.
6. Preserve branch/worktree/session resources; do not clean automatically.

Do not run a real implementation prompt against OCR, Acme, or any registered project. Real harness execution belongs exclusively to the generated fixture plan.
