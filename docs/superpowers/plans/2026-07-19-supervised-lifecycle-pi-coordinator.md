# Supervised Lifecycle and Pi Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supervise external Pi/Claude/Codex turns with native lifecycle hooks, generation-aware handoffs, exact-session resume/reconciliation, graceful close, and session-owned result delivery while consuming the separate Workflow-owned Pi delegation adapter for internal work.

**Implementation status:** This document remains a future plan for external hooks, resume, and close. The merged adapter supplies internal advisory delegation only; no `workflow hooks`, `workflow resume`, or `workflow close` CLI command is implemented.

**Architecture:** A harness-neutral lifecycle callback updates the private run store from native SessionStart/UserPromptSubmit/Stop/SessionEnd events. Generated Claude settings, an explicitly installed Codex hook profile, a launched-worker Pi extension, and a Herdr-backed `WorkerTransport` adapt external event shapes. Internal Pi delegation previews, exact private sessions, advisory handoffs, and later-session adoption are owned by the separate Workflow adapter plan and are consumed here only through its stable contracts.

**Tech Stack:** Node.js 24 ES modules, `node:test`, Pi extension API 0.80+, Claude Code hooks 2.1+, Codex hooks 0.144+, Herdr 0.7.4.

> **Amendment — external lifecycle plus adapter prerequisite:** Complete `2026-07-19-two-lane-delegation-foundation.md` and `2026-07-19-workflow-owned-pi-delegation-adapter.md` first. This plan consumes their `WorkerTransport`, delegation services, exact private-session watcher/adoption, and managed-role contracts; it must not reimplement them or introduce package/global Pi state.

## Global Constraints

- Complete and review the multi-harness launch-core plan and the Workflow-owned adapter plan before starting this plan.
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
- Canonical external completion remains the validated Workflow handoff artifact; internal delegation outputs remain advisory and exact private-session scoped.
- Background writers stay disabled until the read-only and writer fixture gates pass, a separate canary is explicitly approved, and a reviewed policy change enables them.
- No daemon, package, or global Pi state may hold workflow truth, session ownership, or delegation policy.
- Start Pi timers/watchers only during `session_start`; stop them idempotently during `session_shutdown`.
- Results may be injected only into the exact originating Pi session; later sessions require explicit adoption.
- Never automatically release a reservation, clean up a run/worktree/session, or kill a process.
- Never expose session transcript contents, `.env`, auth stores, hook trust stores, credentials, or raw environment data.
- End every task with focused tests, full `npm test`, `git diff --check`, specification review, and code-quality review.

---

## Planned File Structure

```text
bin/
  workflow.js                              resume/reconcile/close/hooks commands
  workflow-handoff-hook.js                 Native hook stdin adapter
src/workflow/
  worker-transport.js                      Exact external-worker transport boundary
  lifecycle.js                             Harness-neutral generation protocol
  hook-config.js                           Claude/Codex reviewed hook configuration
  resume.js                                Exact live/dead session resume planning/execution
  close.js                                 Explicit graceful worker close
  coordinator-runs.js                      Session-owned external-result watcher/adoption logic
  commands.js                              Lifecycle command use cases
  harnesses.js                             Hook-enabled launch and exact resume argv
  herdr.js                                 send-text/send-keys/focus/wait helpers
  launch.js                                Hook-enabled run startup
  reconcile.js                             Lifecycle/process/Git run reconciliation
  run-store.js                             Generation/result/event operations
.pi/
  extensions/
    workflow-worker-lifecycle.ts           Pi worker hook adapter and handoff tool
    workflow-coordinator/
      index.ts                             Thin Pi coordinator integration layer
      package.json                         Peer dependencies only when needed
scripts/
  install-codex-workflow-hooks.js          Previewable fixed profile installer

test/
  workflow-lifecycle.test.js
  workflow-hook-config.test.js
  workflow-resume.test.js
  workflow-close.test.js
  workflow-coordinator-runs.test.js
  workflow-pi-extensions.test.js
  workflow-cli.test.js                     Extended
  workflow-commands.test.js                Extended
  workflow-harnesses.test.js               Extended
  workflow-reconcile.test.js               Extended
```

---

### Task 0: Two-Lane Foundation and Adapter Integration

**Prerequisite:** `2026-07-19-two-lane-delegation-foundation.md` and `2026-07-19-workflow-owned-pi-delegation-adapter.md` are complete with fresh full-suite evidence.

Before any external hook, Herdr, resume, or close work, inject `assertWorkerTransport`, `createDelegationServices`, `createDelegationWatcher`, and result/adoption helpers through the lifecycle/coordinator boundary. Add only adapter-consumption wiring tests here: no package installation, no user/global Pi configuration, no real Pi child, and no model invocation. External lifecycle continues to use canonical worker handoffs; internal delegation outputs remain advisory and session-owned.

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

### Task 4: Session-Owned External Result Delivery and Adapter Consumption

**Files:**
- Create: `src/workflow/coordinator-runs.js`
- Modify: `.pi/extensions/workflow-coordinator/index.ts`
- Create: `test/workflow-coordinator-runs.test.js`
- Modify: `test/workflow-pi-extensions.test.js`

**Interfaces:**
- Produces `createRunWatcher({ store, originSessionId, onResult, intervalMs?, clock? })` with `start()`, `poll()`, `stop()`.
- Coordinator integration consumes adapter-owned delegation services/watchers and keeps later-session adoption explicit.

- [ ] **Step 1: Write failing watcher/adoption tests**

Cover:

- watcher starts only after session start;
- lists only unconsumed external results whose `originSessionId` exactly matches;
- injects one bounded result and atomically marks it consumed by that session;
- no duplicate injection after reload/poll races;
- no injection into a different session;
- shutdown clears timer and leaves results persistent;
- a new session lists pending results but requires explicit adoption;
- stale/manual states produce status notices, not completion turns.

Use fake timers/callbacks; never sleep in unit tests.

- [ ] **Step 2: Verify RED**

```bash
node --test test/workflow-coordinator-runs.test.js test/workflow-pi-extensions.test.js
```

Expected: FAIL because watcher/integration wiring is absent.

- [ ] **Step 3: Implement the session-owned watcher**

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

- [ ] **Step 4: Wire thin Pi coordinator integration**

Keep external run observation in this plan and consume the adapter-owned delegation tools exactly as documented in `2026-07-19-workflow-owned-pi-delegation-adapter.md`. Start watchers only in `session_start`; stop them in `session_shutdown`. Do not recreate delegation policy, role parsing, child-session management, package discovery, or user-global Pi configuration here.

- [ ] **Step 5: Run extension tests**

```bash
node --test test/workflow-coordinator-runs.test.js test/workflow-pi-extensions.test.js
npm test
git diff --check
```

Expected: tests pass with no real Pi/model invocation.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/workflow/coordinator-runs.js .pi/extensions/workflow-coordinator/index.ts test/workflow-coordinator-runs.test.js test/workflow-pi-extensions.test.js
git commit -m "feat(workflow): notify the originating coordinator session"
```

---

### Task 5: Documentation and Staged Validation Handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md`
- Modify: `test/workflow-docs.test.js`

**Interfaces:**
- User documentation distinguishes canonical external worker results from advisory internal delegation results.
- Downstream validation gates stay artifact-based and explicitly ordered.

- [ ] **Step 1: Write failing documentation assertions**

Assert README documents:

```text
workflow hooks doctor
workflow resume <run-id>
workflow reconcile --run <run-id>
workflow result <run-id>
workflow close <run-id>
workflow delegation result <run-id> <delegation-id>
workflow delegation reconcile <run-id> <delegation-id>
manual-handoff-required
result-stale
```

Also assert it states: no terminal scraping, no guessed recent session, no automatic cleanup/release/kill, exact private internal sessions, advisory internal results, explicit later-session adoption, no package/global Pi state, and background writers still blocked until approved fixture/canary gates.

- [ ] **Step 2: Update operational documentation**

Include a two-lane table and scenario notes covering:

| Scenario | Reconciled behavior |
|---|---|
| Origin Pi closes | external result persists; later session explicitly adopts any pending advisory delegation result |
| Worker gets follow-up prompt | generation increments; previous result stales |
| Worker closes with result | terminal result remains current |
| Worker closes without result | interrupted/manual handoff |
| Process is killed | later reconcile detects missing process |
| Git changes after handoff | result-stale |
| Native session ID missing | resume refuses to guess |

Explain that “return to Pi” means child/external handoff → run store → exact origin-session watcher, not terminal switching. Explain that hooks improve compliance but the hard guarantee is still that missing/invalid/stale handoffs never become success.

- [ ] **Step 3: Run documentation-stage verification**

```bash
node --test test/workflow-docs.test.js
npm ci
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: all tests pass; package contents include no session state, generated artifacts, package cache, or credentials.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md test/workflow-docs.test.js
git commit -m "docs(workflow): explain external lifecycle and adapter boundary"
```

---

## Stage 2 Completion Gate

Before executing generated fixtures or any later canary:

1. Re-run the artifact checks from Task 5 with fresh output.
2. Review the full diff against `2026-07-19-two-lane-delegation-governance-design.md` and `2026-07-19-workflow-owned-pi-delegation-adapter-design.md`.
3. Confirm external canonical handoffs remain distinct from internal advisory delegation results.
4. Confirm exact private-session governance, explicit later-session adoption, one writer per checkout, and no terminal-derived result fields.
5. Confirm no automatic cleanup, reservation release, or process kill was added.
6. Proceed in order: read-only delegation fixtures, writer fixture, then a separately approved canary/trust checkpoint.
7. Keep background writers disabled until those downstream gates pass and a reviewed policy change enables them.

Do not mark fixtures, canaries, or trust checks as run or passed in this plan. Do not run a real implementation prompt against OCR, Acme, or any registered project here.
