# External Worker Origin Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch external workflow workers through Pi tools that bind the exact coordinator session, so terminal notifications return only to the session that started the run.

**Architecture:** Keep the existing CLI `--origin-session` path unchanged. Extend the coordinator runtime with the live launch dependencies already assembled by `bin/workflow.js`, then add prepare/execute Pi tools that store an approved launch command in memory with the origin object derived from `ctx.sessionManager`. The existing event bus and worker watcher use the persisted origin for exact-session routing.

**Tech Stack:** Node.js ESM, Pi extension TypeScript, Node test runner, existing Workflow launch/command services and Herdr/Git adapters.

## Global Constraints

- Preserve preview, approval-digest, and two explicit UI confirmation gates before launch mutation.
- The Pi tool must derive `{ harness: "pi", sessionId }` from `ctx.sessionManager`; no tool parameter, environment fallback, or model text may set it.
- Keep `workflow launch --origin-session <id>` supported for manual use.
- Worker notifications stay passive follow-ups and point to `workflow result <run-id>`; they do not inject or accept the handoff result.
- Preserve compatibility for legacy/unclaimed events (`originSessionId: null`).
- Do not add dependencies, shell interpolation, automatic cleanup, or historical-event replay.

---

## File Structure

- Modify: `.pi/extensions/workflow-coordinator/index.ts` — define bounded launch schemas, render previews/reports, create the live launch command via the runtime, retain approved session-bound previews, and register the two Pi tools.
- Modify: `test/workflow-pi-extensions.test.js` — prove tool schemas, origin binding, approval gates, cancellation/reuse behavior, and report redaction at the extension boundary.
- Modify: `README.md` — document manual origin metadata and the Pi-owned launch route.
- Modify: `.agents/skills/workflow-launch/SKILL.md` — direct coordinators to use Pi launch tools rather than a shell command when session-isolated completion is required.

No CLI/parser or watcher implementation change is planned: `bin/workflow.js` already parses `--origin-session`, `launch.js` already persists it, and `worker-watcher.js` already filters non-empty foreign origins.

### Task 1: Expose a live launch-command factory from the coordinator runtime

**Files:**
- Modify: `.pi/extensions/workflow-coordinator/index.ts:1-24, createWorkflowCoordinatorRuntime`
- Test: `test/workflow-pi-extensions.test.js`

**Interfaces:**
- Consumes: `launchCommand(options, deps)` from `src/workflow/commands.js`; `createProcessRunner`, `createGitAdapter`, `createHerdrAdapter`, and `ensureCodexWorkerHooks` from their existing workflow modules.
- Produces: `runtime().createLaunchCommand(options)` that calls the Workflow launch command with the loaded registry, resolved state root, absolute control-plane binary, live Git/Herdr dependencies, and the existing best-effort Codex hook installer.
- Produces: injectable `createLaunchCommand` dependency on `createWorkflowCoordinatorExtension` for isolated extension tests.

- [ ] **Step 1: Write the failing runtime/extension test**

Add a test-local fake launch factory and assert the extension obtains it only when a launch tool invokes it:

```js
const launchCalls = [];
const command = {
  preview: { approvalDigest: `sha256:${"c".repeat(64)}`, reconciliation: { status: "open" } },
  async execute() { return { status: "running", runId: RUN_ID }; },
};
createWorkflowCoordinatorExtension({
  resolveServicesForRun: async () => services,
  delegations,
  createLaunchCommand: async (options) => {
    launchCalls.push(structuredClone(options));
    return command;
  },
})(pi);
assert.deepEqual(launchCalls, []);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --test test/workflow-pi-extensions.test.js
```

Expected: FAIL because `createWorkflowCoordinatorExtension` does not accept/use `createLaunchCommand`.

- [ ] **Step 3: Add the runtime factory and injection seam**

In the coordinator extension module, import the existing live dependencies and command function:

```ts
import { launchCommand } from "../../../src/workflow/commands.js";
import { createProcessRunner } from "../../../src/workflow/process.js";
import { createGitAdapter } from "../../../src/workflow/git.js";
import { createHerdrAdapter } from "../../../src/workflow/herdr.js";
import { ensureCodexWorkerHooks } from "../../../src/workflow/codex-hooks.js";
```

Extend `createWorkflowCoordinatorRuntime` to construct one `runner`, `git`, and `herdr`, and return:

```ts
async createLaunchCommand(options) {
  return await launchCommand({
    ...options,
    registryPath: projectsFile,
    stateRoot,
    controlPlaneBin,
  }, {
    registry,
    stateRoot,
    controlPlaneBin,
    git,
    herdr,
    ensureCodexWorkerHooks,
  });
}
```

Extend `createWorkflowCoordinatorExtension` with `createLaunchCommand = async (options) => await (await runtime()).createLaunchCommand(options)`. Do not run it at extension construction or `session_start`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
node --test test/workflow-pi-extensions.test.js
```

Expected: PASS, with no launch factory call before a launch tool is executed.

- [ ] **Step 5: Commit the isolated runtime seam**

```bash
git add .pi/extensions/workflow-coordinator/index.ts test/workflow-pi-extensions.test.js
git commit -m "feat: expose workflow launch to the Pi coordinator"
```

### Task 2: Add session-bound Pi prepare/execute launch tools

**Files:**
- Modify: `.pi/extensions/workflow-coordinator/index.ts: schema definitions, rendering helpers, extension closure, and tool registration`
- Test: `test/workflow-pi-extensions.test.js`

**Interfaces:**
- Consumes: `createLaunchCommand({ projectAlias, task, request, feature?, repositories?, tickets?, agentProfile?, selectionReason?, originSession })` from Task 1.
- Produces: `workflow_prepare_launch` with bounded launch parameters and no `originSession`, `approvalDigest`, `stateRoot`, or executable-path fields.
- Produces: `workflow_execute_launch({ approvalDigest })`, which accepts only a preview kept by the current extension instance.

- [ ] **Step 1: Write failing tests for schema, binding, and approvals**

Add tests that call the new tools with a fake command and assert:

```js
const prepare = pi.tool("workflow_prepare_launch");
const execute = pi.tool("workflow_execute_launch");
assert.equal(prepare.parameters.additionalProperties, false);
assert.equal("originSession" in prepare.parameters.properties, false);

await prepare.execute("prepare", {
  projectAlias: "fixture",
  task: "ASANA-123",
  request: "Implement the approved feature.",
  feature: "approved-feature",
  agentProfile: "pi-worker",
}, undefined, undefined, createContext({ sessionId: ORIGIN_SESSION_ID }));

assert.deepEqual(launchCalls[0].originSession, {
  harness: "pi",
  sessionId: ORIGIN_SESSION_ID,
});
assert.equal(confirmations.length, 1);

await execute.execute("execute", { approvalDigest: command.preview.approvalDigest }, undefined, undefined, ctx);
assert.equal(executeCalls[0].approvalDigest, command.preview.approvalDigest);
assert.equal(confirmations.length, 2);
```

Add separate assertions that an unknown/reused digest rejects, declining prepare does not retain the digest, declining execute does not call `command.execute`, and `session_shutdown` clears approved launch previews.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --test test/workflow-pi-extensions.test.js
```

Expected: FAIL because `workflow_prepare_launch` and `workflow_execute_launch` are absent.

- [ ] **Step 3: Implement bounded input validation and tools**

Define schemas using the existing `Type` helpers:

```ts
const prepareLaunchSchema = Type.Object({
  projectAlias: Type.String({ minLength: 1, maxLength: 128 }),
  task: Type.String({ minLength: 1, maxLength: 128 }),
  request: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  feature: optional(Type.String({ minLength: 1, maxLength: 256 })),
  repositories: optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 8 })),
  tickets: optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
  agentProfile: optional(Type.String({ minLength: 1, maxLength: 128 })),
  selectionReason: optional(Type.String({ minLength: 1, maxLength: 4096 })),
});
const executeLaunchSchema = Type.Object({
  approvalDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
});
```

Add a `validatePrepareLaunchInput` companion to existing validators. It must reject NULs, empty strings, duplicate lists, and values beyond their stated bounds; it returns only the listed fields.

Maintain `const approvedLaunches = new Map()` in the extension closure. In `workflow_prepare_launch`:

```ts
const originSession = { harness: "pi", sessionId: sessionIdFromContext(ctx) };
const command = await createLaunchCommand({ ...input, originSession });
const approved = await ctx.ui.confirm("Approve Workflow launch preview?", renderLaunchPreview(command.preview));
if (!approved) return { content: [{ type: "text", text: "Workflow launch preview was not approved." }], details: { approved: false, approvalDigest: command.preview.approvalDigest } };
approvedLaunches.set(command.preview.approvalDigest, { command, preview: command.preview, originSession });
```

In `workflow_execute_launch`, retrieve the exact map entry, verify the current `sessionIdFromContext(ctx)` still equals `originSession.sessionId`, show `renderLaunchPreview`, and use `confirmMutation` with `{ approvalDigest, preview, originSession }`. Only then call `command.execute({ approvalDigest })`, delete the map entry, and return a bounded launch report. Clear `approvedLaunches` from `session_shutdown`.

Do not use `pi.sendMessage` from either tool; external worker completion still flows solely through the watcher/event bus.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
node --test test/workflow-pi-extensions.test.js
```

Expected: PASS, including exact origin binding, both confirmation gates, rejection behavior, and cleanup on shutdown.

- [ ] **Step 5: Run the relevant launch and watcher regressions**

Run:

```bash
node --test test/workflow-launch.test.js test/workflow-cli.test.js test/workflow-worker-watcher.test.js test/workflow-pi-extensions.test.js
```

Expected: PASS; the existing CLI origin-session persistence and foreign-origin watcher filtering remain unchanged.

- [ ] **Step 6: Commit the session-bound tools**

```bash
git add .pi/extensions/workflow-coordinator/index.ts test/workflow-pi-extensions.test.js
git commit -m "feat: bind Pi workflow launches to their origin session"
```

### Task 3: Document both launch paths and verify the repository

**Files:**
- Modify: `README.md: Pi coordinator awareness section`
- Modify: `.agents/skills/workflow-launch/SKILL.md: Notifications and coordinator awareness`
- Test: `test/workflow-docs.test.js`

**Interfaces:**
- Consumes: `workflow_prepare_launch` / `workflow_execute_launch` from Task 2 and the established `workflow launch --origin-session <id>` CLI option.
- Produces: concise instructions that distinguish automatic Pi-origin binding from explicit manual metadata.

- [ ] **Step 1: Write failing documentation assertions**

Add assertions to `test/workflow-docs.test.js`:

```js
assert.match(readme, /workflow_prepare_launch/);
assert.match(readme, /workflow_execute_launch/);
assert.match(readme, /--origin-session <id>/);
assert.match(skill, /originSessionId|origin session/i);
```

- [ ] **Step 2: Run the docs test to verify it fails**

Run:

```bash
node --test test/workflow-docs.test.js
```

Expected: FAIL because the Pi-owned launch tools are not documented.

- [ ] **Step 3: Document behavior without promising automatic result acceptance**

Add a README subsection showing:

```text
From a Pi coordinator, use workflow_prepare_launch and workflow_execute_launch.
The extension binds the active Pi session automatically, and terminal notices return only there.
For a non-Pi/manual launch, pass --origin-session <id> explicitly.
```

Update the workflow-launch skill with the same distinction and retain the statement that notifications only announce readiness and require an explicit result read/review.

- [ ] **Step 4: Run docs and complete test suite**

Run:

```bash
node --test test/workflow-docs.test.js
npm test
```

Expected: all tests pass; the live Herdr smoke remains opt-in/skipped unless explicitly enabled.

- [ ] **Step 5: Review the final diff and commit**

Run:

```bash
git diff --check
git diff -- .pi/extensions/workflow-coordinator/index.ts test/workflow-pi-extensions.test.js README.md .agents/skills/workflow-launch/SKILL.md
```

Expected: no whitespace errors; no origin field is accepted from Pi tool input; docs describe both routes.

Commit:

```bash
git add README.md .agents/skills/workflow-launch/SKILL.md test/workflow-docs.test.js
git commit -m "docs: explain session-isolated workflow launches"
```
