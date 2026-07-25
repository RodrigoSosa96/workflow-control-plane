# Pi Interactive Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pi's interactive lane trustworthy end-to-end — autonomous and assisted modes — with a harness-neutral lifecycle callback (state + generation + bounded stop-continuation), exact-session resume, graceful close, and faithful worker observability.

**Architecture:** Two independent event flows leave the interactive Pi worker. A thin Pi lifecycle extension translates native Pi events into calls on a harness-neutral `lifecycle.js` that drives the existing run-state machine and generation; the existing observability extension keeps reporting telemetry. `resume.js` and `close.js` drive recovery from the CLI over the existing `worker-transport` contract.

**Tech Stack:** Node.js 24 ES modules, `node:test`, Pi extension API 0.81+, Herdr 0.7.5, existing `run-store`/`run-state`/`worker-transport`/`telemetry-store` modules.

**Design spec:** `docs/superpowers/specs/2026-07-24-pi-interactive-lifecycle-design.md`

## Global Constraints

- Pi is 0.81.1; `agent_settled` is the "Stop" event ("no retry/compaction/follow-up left").
- `lifecycle.js` is harness-neutral: it consumes only `run-store` + `run-state`, never Pi APIs.
- Stop-hook continuation is bounded to two workflow-owned attempts per generation and must never loop.
- A genuine user follow-up increments the generation and stales the prior result; the extension's own queued continuations must NOT count as follow-ups.
- Resume targets an exact native session id/path; never `--last`/`--continue`.
- Close sends a graceful idle exit only after process-identity validation; never kill an unknown or working process.
- Never scrape terminal text for lifecycle or results (`worker-transport` already forbids terminal-derived detail keys).
- No background-writer enablement; no deletion of branch/worktree/workspace/run.
- Strict red-green-refactor TDD; frequent commits; run `npm test` green before each commit.
- Run states available (`src/workflow/run-state.js`): `planned, launching, running, idle-awaiting-handoff, needs-input, completed, blocked, failed, interrupted, manual-handoff-required, result-stale`.

## File Structure

- Create `src/workflow/lifecycle.js` — harness-neutral generation/state/continuation protocol.
- Create `src/workflow/resume.js` — exact-session resume planning/execution.
- Create `src/workflow/close.js` — graceful worker close.
- Create `.pi/extensions/workflow-worker-lifecycle.ts` — thin Pi→lifecycle adapter extension.
- Modify `.pi/extensions/workflow-worker-observability.ts` — version 0.80.10 → 0.81.1.
- Modify `src/workflow/harnesses.js` — add `--extension` wiring to the Pi launch argv; add exact resume argv.
- Modify `bin/workflow.js` — add `resume` and `close` subcommands.
- Create tests: `test/workflow-lifecycle.test.js`, `test/workflow-resume.test.js`, `test/workflow-close.test.js`, `test/workflow-pi-lifecycle-extension.test.js`; extend `test/workflow-harnesses.test.js` and `test/workflow-cli.test.js`.
- Create `docs/superpowers/verification/pi-interactive-lifecycle.md` — guided manual verification procedure.

---

### Task 1: Empirical verification of the interactive lane (MANUAL — human/TTY)

> This task is not automatable and MUST NOT be dispatched to a subagent. It runs
> before the integration tasks (7–8) so those build on verified facts. Tasks 2–6
> (harness-neutral core) do not depend on it and may proceed in parallel.

**Files:**
- Create: `docs/superpowers/verification/pi-interactive-lifecycle.md`

**Interfaces:**
- Produces: a findings section recording (a) whether worker extensions load in the ticket worktree, (b) the exact Pi event names/payloads observed for start/stop/follow-up/session-end, (c) any Herdr `agent start --kind pi` interactive-launch failures.

- [ ] **Step 1: Prepare a fixture and launch Pi interactively**

Run in a real terminal (TTY):
```bash
npm run smoke:fixture -- --fake --keep
# then, with a fixture registry that uses mode: interactive for pi-worker,
WORKFLOW_PROJECTS_FILE=<fixture>/projects.yaml node bin/workflow.js launch fixture-single FIX-101 --yes \
  --approval-digest <digest-from-dry-run> --prompt-file <fixture>/canary-prompt.txt
```
Expected: an interactive Pi starts in a Herdr pane in the ticket worktree.

- [ ] **Step 2: Record whether the extensions load**

In the Pi pane, confirm the observability widget appears. If it does not, record that worker extensions are NOT auto-discovered — Task 6 (argv `--extension` wiring) is then required before integration.

- [ ] **Step 3: Record the real event names**

Add a temporary logging extension (or inspect Pi docs against observed behavior) and note the exact events fired on: first prompt, tool use, Stop (idle), a typed follow-up, and session close. Confirm `agent_settled` fires on idle and that a typed follow-up produces a fresh `agent_start`.

- [ ] **Step 4: Write the findings doc**

Write `docs/superpowers/verification/pi-interactive-lifecycle.md` with the observed facts and any launch bugs. This doc also becomes the end-to-end manual procedure reused in Task 8.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/verification/pi-interactive-lifecycle.md
git commit -m "docs(verify): interactive Pi lane empirical findings"
```

---

### Task 2: Harness-neutral lifecycle core — generation and state

**Files:**
- Create: `src/workflow/lifecycle.js`
- Test: `test/workflow-lifecycle.test.js`

**Interfaces:**
- Consumes: `createRunStore` (`read(runId)`, `update(runId, updater)`), `RUN_STATES`, `transitionRun` from existing modules.
- Produces: `createLifecycle({ store, clock? })` returning `{ onPrompt, onStop, onSessionEnd }`, each `async ({ runId, generation, source }) => updatedRun`. `source` is `"user"` or `"continuation"`.

- [ ] **Step 1: Write the failing test for first prompt = generation 1**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

function fakeStore(initial) {
  let run = { id: "r1", state: RUN_STATES.LAUNCHING, generation: 1, stateHistory: [], updatedAt: "t0", ...initial };
  return {
    async read() { return { ...run }; },
    async update(_id, updater) { run = { ...run, ...updater({ ...run }) }; return { ...run }; },
    _get: () => run,
  };
}

test("first prompt confirms generation 1 and moves to running", async () => {
  const store = fakeStore();
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const run = await lifecycle.onPrompt({ runId: "r1", generation: 1, source: "user" });
  assert.equal(run.state, RUN_STATES.RUNNING);
  assert.equal(run.generation, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/workflow-lifecycle.test.js`
Expected: FAIL — `createLifecycle` is not defined.

- [ ] **Step 3: Implement the minimal `onPrompt`**

```js
import { RUN_STATES } from "./run-state.js";
import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("lifecycle", message, { details });
}

export function createLifecycle({ store, clock = () => new Date().toISOString() }) {
  if (!store || typeof store.read !== "function" || typeof store.update !== "function") {
    fail("lifecycle requires a run store");
  }

  async function onPrompt({ runId, generation, source }) {
    const current = await store.read(runId);
    if (!current) fail(`Run ${runId} not found`, { runId });
    const isFollowUp = source === "user" && current.state !== RUN_STATES.LAUNCHING && generation > current.generation;
    return store.update(runId, () => ({
      state: RUN_STATES.RUNNING,
      generation,
      stopAttempts: 0,
      updatedAt: clock(),
      ...(isFollowUp ? { previousGeneration: current.generation } : {}),
    }));
  }

  return { onPrompt };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/workflow-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Add the follow-up test (generation increment + stale prior result)**

```js
test("a user follow-up increments generation, returns to running, resets stop attempts", async () => {
  const store = fakeStore({ state: RUN_STATES.COMPLETED, generation: 1, stopAttempts: 2 });
  const lifecycle = createLifecycle({ store, clock: () => "t2" });
  const run = await lifecycle.onPrompt({ runId: "r1", generation: 2, source: "user" });
  assert.equal(run.state, RUN_STATES.RUNNING);
  assert.equal(run.generation, 2);
  assert.equal(run.stopAttempts, 0);
  assert.equal(run.previousGeneration, 1);
});

test("a queued continuation does NOT increment the generation", async () => {
  const store = fakeStore({ state: RUN_STATES.IDLE_AWAITING_HANDOFF, generation: 1 });
  const lifecycle = createLifecycle({ store, clock: () => "t3" });
  const run = await lifecycle.onPrompt({ runId: "r1", generation: 1, source: "continuation" });
  assert.equal(run.generation, 1);
});
```

- [ ] **Step 6: Run and confirm pass**

Run: `node --test test/workflow-lifecycle.test.js`
Expected: PASS (implementation already covers these).

- [ ] **Step 7: Commit**

```bash
git add src/workflow/lifecycle.js test/workflow-lifecycle.test.js
git commit -m "feat(lifecycle): harness-neutral prompt/generation transitions"
```

---

### Task 3: Lifecycle core — stop and session-end with bounded continuation

**Files:**
- Modify: `src/workflow/lifecycle.js`
- Test: `test/workflow-lifecycle.test.js`

**Interfaces:**
- Consumes: `createLifecycle` from Task 2.
- Produces: `onStop({ runId, generation, hasValidHandoff })` returning `{ run, action }` where `action` is `"none"` (handoff present → completed), `"continue"` (queue a continuation, under the cap), or `"manual"` (cap reached → manual-handoff-required); and `onSessionEnd({ runId, generation })` returning the run in a terminal-safe state.

- [ ] **Step 1: Write the failing stop tests**

```js
test("stop with a valid handoff completes without continuation", async () => {
  const store = fakeStore({ state: RUN_STATES.RUNNING, generation: 1, stopAttempts: 0 });
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const { run, action } = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: true });
  assert.equal(action, "none");
  assert.equal(run.state, RUN_STATES.COMPLETED);
});

test("stop without a handoff queues up to two continuations then requires manual handoff", async () => {
  const store = fakeStore({ state: RUN_STATES.RUNNING, generation: 1, stopAttempts: 0 });
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const first = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(first.action, "continue");
  assert.equal(first.run.stopAttempts, 1);
  const second = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(second.action, "continue");
  assert.equal(second.run.stopAttempts, 2);
  const third = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(third.action, "manual");
  assert.equal(third.run.state, RUN_STATES.MANUAL_HANDOFF_REQUIRED);
});

test("stop with a stale generation is treated as missing (no state change)", async () => {
  const store = fakeStore({ state: RUN_STATES.RUNNING, generation: 2, stopAttempts: 0 });
  const lifecycle = createLifecycle({ store, clock: () => "t1" });
  const { action, run } = await lifecycle.onStop({ runId: "r1", generation: 1, hasValidHandoff: false });
  assert.equal(action, "none");
  assert.equal(run.generation, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-lifecycle.test.js`
Expected: FAIL — `onStop` is not a function.

- [ ] **Step 3: Implement `onStop` and `onSessionEnd`**

```js
const MAX_STOP_ATTEMPTS = 2;

// inside createLifecycle, add and export in the returned object:
async function onStop({ runId, generation, hasValidHandoff }) {
  const current = await store.read(runId);
  if (!current) fail(`Run ${runId} not found`, { runId });
  if (generation !== current.generation) {
    return { run: current, action: "none" };
  }
  if (hasValidHandoff) {
    const run = await store.update(runId, () => ({ state: RUN_STATES.COMPLETED, updatedAt: clock() }));
    return { run, action: "none" };
  }
  const attempts = (current.stopAttempts ?? 0) + 1;
  if (attempts > MAX_STOP_ATTEMPTS) {
    const run = await store.update(runId, () => ({ state: RUN_STATES.MANUAL_HANDOFF_REQUIRED, updatedAt: clock() }));
    return { run, action: "manual" };
  }
  const run = await store.update(runId, (prev) => ({
    state: prev.state === RUN_STATES.RUNNING ? RUN_STATES.IDLE_AWAITING_HANDOFF : prev.state,
    stopAttempts: attempts,
    updatedAt: clock(),
  }));
  return { run, action: "continue" };
}

async function onSessionEnd({ runId }) {
  const current = await store.read(runId);
  if (!current) fail(`Run ${runId} not found`, { runId });
  const terminal = new Set([RUN_STATES.COMPLETED, RUN_STATES.FAILED, RUN_STATES.MANUAL_HANDOFF_REQUIRED, RUN_STATES.RESULT_STALE]);
  if (terminal.has(current.state)) return current;
  return store.update(runId, () => ({ state: RUN_STATES.INTERRUPTED, updatedAt: clock() }));
}
```
Add `onStop` and `onSessionEnd` to the returned object. Note: the `RUNNING → IDLE_AWAITING_HANDOFF` and `IDLE_AWAITING_HANDOFF → COMPLETED/MANUAL_HANDOFF_REQUIRED` transitions are already allowed by `run-state.js`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workflow-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Add the session-end test and confirm**

```js
test("session end from a non-terminal state interrupts; terminal states are preserved", async () => {
  const running = fakeStore({ state: RUN_STATES.RUNNING, generation: 1 });
  assert.equal((await createLifecycle({ store: running, clock: () => "t" }).onSessionEnd({ runId: "r1" })).state, RUN_STATES.INTERRUPTED);
  const done = fakeStore({ state: RUN_STATES.COMPLETED, generation: 1 });
  assert.equal((await createLifecycle({ store: done, clock: () => "t" }).onSessionEnd({ runId: "r1" })).state, RUN_STATES.COMPLETED);
});
```
Run: `node --test test/workflow-lifecycle.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/lifecycle.js test/workflow-lifecycle.test.js
git commit -m "feat(lifecycle): bounded stop-continuation and session-end transitions"
```

---

### Task 4: Exact-session resume

**Files:**
- Create: `src/workflow/resume.js`
- Test: `test/workflow-resume.test.js`

**Interfaces:**
- Consumes: `assertWorkerTransport` and a transport with `observeExact(identity)` returning `{ state: "active"|"idle"|"missing"|"mismatch"|"unknown", identity }`; `createRunStore.read`.
- Produces: `planResume({ store, transport, runId })` → `{ action: "focus"|"relaunch"|"refuse", identity?, reason? }`. `active`/`idle` → `focus`; `missing` → `relaunch`; `mismatch`/`unknown` → `refuse`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { planResume } from "../src/workflow/resume.js";

function deps({ observation, run }) {
  return {
    store: { async read() { return run; } },
    transport: {
      start() {}, deliverFollowUp() {}, requestGracefulClose() {},
      async observeExact() { return observation; },
    },
  };
}

test("a live session is resumed by focus; a dead one relaunches; a mismatch refuses", async () => {
  const identity = { kind: "pi-session", sessionId: "s1" };
  const run = { id: "r1", harness: "pi", transportIdentity: identity };
  assert.equal((await planResume({ ...deps({ observation: { state: "idle", identity }, run }), runId: "r1" })).action, "focus");
  assert.equal((await planResume({ ...deps({ observation: { state: "missing", identity }, run }), runId: "r1" })).action, "relaunch");
  assert.equal((await planResume({ ...deps({ observation: { state: "mismatch", identity }, run }), runId: "r1" })).action, "refuse");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-resume.test.js`
Expected: FAIL — `planResume` is not defined.

- [ ] **Step 3: Implement `planResume`**

```js
import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

export async function planResume({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  if (!run) throw new WorkflowError("resume", `Run ${runId} not found`, { details: { runId } });
  const identity = run.transportIdentity;
  if (!identity) throw new WorkflowError("resume", "Run has no exact session identity to resume", { details: { runId } });
  const observation = await transport.observeExact(identity);
  switch (observation.state) {
    case "active":
    case "idle":
      return { action: "focus", identity };
    case "missing":
      return { action: "relaunch", identity };
    default:
      return { action: "refuse", identity, reason: observation.state };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workflow-resume.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/resume.js test/workflow-resume.test.js
git commit -m "feat(resume): plan exact-session resume over the worker transport"
```

---

### Task 5: Graceful close with identity validation

**Files:**
- Create: `src/workflow/close.js`
- Test: `test/workflow-close.test.js`

**Interfaces:**
- Consumes: transport `observeExact(identity)` and `requestGracefulClose(identity)`; `createRunStore.read`.
- Produces: `closeWorker({ store, transport, runId })` → `{ closed: boolean, reason?: string }`. Closes only when `observeExact` returns `idle`; `active` → refuse (working); `mismatch`/`unknown`/`missing` → refuse (identity not confirmed).

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeWorker } from "../src/workflow/close.js";

function deps({ state }) {
  const identity = { kind: "pi-session", sessionId: "s1" };
  const calls = [];
  return {
    calls,
    store: { async read() { return { id: "r1", transportIdentity: identity }; } },
    transport: {
      start() {}, deliverFollowUp() {},
      async observeExact() { return { state, identity }; },
      async requestGracefulClose(id) { calls.push(id); return { closed: true }; },
    },
  };
}

test("closes only an idle worker; refuses a working or unconfirmed one", async () => {
  const idle = deps({ state: "idle" });
  assert.equal((await closeWorker({ ...idle, runId: "r1" })).closed, true);
  assert.equal(idle.calls.length, 1);

  const working = deps({ state: "active" });
  const r = await closeWorker({ ...working, runId: "r1" });
  assert.equal(r.closed, false);
  assert.equal(working.calls.length, 0);

  const unknown = deps({ state: "unknown" });
  assert.equal((await closeWorker({ ...unknown, runId: "r1" })).closed, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-close.test.js`
Expected: FAIL — `closeWorker` is not defined.

- [ ] **Step 3: Implement `closeWorker`**

```js
import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

export async function closeWorker({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  if (!run) throw new WorkflowError("close", `Run ${runId} not found`, { details: { runId } });
  const identity = run.transportIdentity;
  if (!identity) return { closed: false, reason: "no-identity" };
  const observation = await transport.observeExact(identity);
  if (observation.state !== "idle") {
    return { closed: false, reason: observation.state === "active" ? "working" : "identity-unconfirmed" };
  }
  await transport.requestGracefulClose(identity);
  return { closed: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workflow-close.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/close.js test/workflow-close.test.js
git commit -m "feat(close): graceful worker close after identity validation"
```

---

### Task 6: Wire the lifecycle extension and its loading

> Depends on Task 1 findings for the exact Pi event names and whether explicit
> `--extension` wiring is required. The names below (`agent_start`,
> `agent_settled`, `session_shutdown`, `session_start`) are the documented Pi
> 0.81 events; adjust if Task 1 observed otherwise.

**Files:**
- Create: `.pi/extensions/workflow-worker-lifecycle.ts`
- Modify: `src/workflow/harnesses.js` (add `--extension` paths to `piArgv`)
- Test: `test/workflow-pi-lifecycle-extension.test.js`, extend `test/workflow-harnesses.test.js`

**Interfaces:**
- Consumes: `createLifecycle` (Tasks 2–3); Pi `ExtensionAPI` events; `WORKFLOW_RUN_ID`/`WORKFLOW_GENERATION` env.
- Produces: a default-exported extension factory `createWorkflowWorkerLifecycleExtension({ env })` mirroring the observability extension's inert-when-missing-env pattern; `piArgv` now includes `--extension <lifecycle>` and `--extension <observability>`.

- [ ] **Step 1: Write the failing harness argv test**

```js
test("pi interactive argv loads the workflow worker extensions", () => {
  const spec = buildHarnessLaunch({
    profileName: "pi-worker",
    profile: profile({ mode: "interactive" }),
    sessionName: SESSION_NAME, cwd: CWD, run: RUN,
  });
  const joined = spec.argv.join(" ");
  assert.match(joined, /--extension .*workflow-worker-lifecycle/);
  assert.match(joined, /--extension .*workflow-worker-observability/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-harnesses.test.js`
Expected: FAIL — no `--extension` in argv.

- [ ] **Step 3: Add extension paths in `piArgv`**

In `src/workflow/harnesses.js`, resolve the extension files relative to the control-plane root and push them into `piArgv` for Pi runs:
```js
// near the top of harnesses.js
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const CONTROL_PLANE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI_WORKER_EXTENSIONS = [
  join(CONTROL_PLANE_ROOT, ".pi/extensions/workflow-worker-lifecycle.ts"),
  join(CONTROL_PLANE_ROOT, ".pi/extensions/workflow-worker-observability.ts"),
];

// in piArgv, after --session-id and before profile.arguments:
if (run) {
  for (const ext of PI_WORKER_EXTENSIONS) argv.push("--extension", ext);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workflow-harnesses.test.js`
Expected: PASS.

> **Task 1 findings drive this design (verified against Pi 0.81.1):** hook
> `agent_start` (one per work cycle — NOT `turn_start`, which fires multiple times
> per tool call), `agent_settled` (idle stop), `session_shutdown` (session end).
> Pi exposes NO `streamingBehavior`/`stop_hook_active` field, so the extension
> distinguishes a user follow-up from its own queued continuation with local state:
> a `pendingContinuation` flag set when it queues a continuation and consumed by
> the next `agent_start`; and a `startedOnce` flag so the first `agent_start`
> confirms the launch generation while a later user `agent_start` is a follow-up
> (generation = current + 1, read from the store). `store` is injectable for tests.

- [ ] **Step 5: Write the extension contract tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowWorkerLifecycleExtension } from "../.pi/extensions/workflow-worker-lifecycle.ts";

function fakePi() {
  return {
    handlers: {},
    sent: [],
    on(name, fn) { this.handlers[name] = fn; },
    sendUserMessage(msg, opts) { this.sent.push({ msg, opts }); },
  };
}

function makeExt({ life, run, hasValidHandoff = async () => false }) {
  const store = { async read() { return { id: "r1", ...run }; } };
  return createWorkflowWorkerLifecycleExtension({
    env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "pi", WORKFLOW_STATE_ROOT: "/x" },
    lifecycle: life, store, hasValidHandoff,
  });
}

test("agent_settled without a handoff queues at most two continuations then falls back", async () => {
  const stop = ["continue", "continue", "manual"]; let i = 0;
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: stop[i++] }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await pi.handlers.agent_settled({}, {});
  await pi.handlers.agent_settled({}, {});
  await pi.handlers.agent_settled({}, {});
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[0].opts.deliverAs, "followUp");
});

test("a queued continuation is tagged source=continuation and reuses the generation", async () => {
  const calls = [];
  const life = { onPrompt: async (a) => calls.push(a), onStop: async () => ({ action: "continue" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "running" } })(pi);
  await pi.handlers.agent_start({}, {});
  assert.deepEqual(calls.at(-1), { runId: "r1", generation: 1, source: "user" });
  await pi.handlers.agent_settled({}, {});   // queues a continuation → sets pendingContinuation
  await pi.handlers.agent_start({}, {});     // the continuation's own agent_start
  assert.deepEqual(calls.at(-1), { runId: "r1", generation: 1, source: "continuation" });
});

test("a user follow-up after the first cycle increments the generation", async () => {
  const calls = [];
  const life = { onPrompt: async (a) => calls.push(a), onStop: async () => ({ action: "none" }), onSessionEnd: async () => {} };
  const pi = fakePi();
  makeExt({ life, run: { generation: 1, state: "completed" }, hasValidHandoff: async () => true })(pi);
  await pi.handlers.agent_start({}, {});     // first start → confirms gen 1
  assert.equal(calls.at(-1).generation, 1);
  await pi.handlers.agent_start({}, {});     // user follow-up → gen 2
  assert.deepEqual(calls.at(-1), { runId: "r1", generation: 2, source: "user" });
});

test("session_shutdown ends the session at the current generation", async () => {
  const ended = [];
  const life = { onPrompt: async () => {}, onStop: async () => ({ action: "none" }), onSessionEnd: async (a) => ended.push(a) };
  const pi = fakePi();
  makeExt({ life, run: { generation: 2, state: "running" } })(pi);
  await pi.handlers.session_shutdown({ reason: "quit" }, {});
  assert.deepEqual(ended.at(-1), { runId: "r1", generation: 2 });
});
```

- [ ] **Step 6: Implement the extension**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunStore } from "../../src/workflow/run-store.js";
import { createLifecycle } from "../../src/workflow/lifecycle.js";

function continuationPrompt(runId: string, generation: number): string {
  return `Before ending this turn, create the workflow handoff for run ${runId}, generation ${generation}.`;
}

export function createWorkflowWorkerLifecycleExtension({
  env = process.env as Record<string, string | undefined>,
  lifecycle,
  hasValidHandoff,
  store: injectedStore,
} = {} as any) {
  const runId = env.WORKFLOW_RUN_ID;
  if (!runId || env.WORKFLOW_HARNESS !== "pi") return (_pi: ExtensionAPI) => {};
  const store = injectedStore ?? createRunStore({ stateRoot: env.WORKFLOW_STATE_ROOT });
  const life = lifecycle ?? createLifecycle({ store });
  const validHandoff = hasValidHandoff ?? (async (gen: number) => await handoffExists(store, runId, gen));

  // Pi 0.81.1 emits no field distinguishing a user follow-up from our own queued
  // continuation (both are just agent_start), so we track it locally.
  let pendingContinuation = false;
  let startedOnce = false;

  return function workflowWorkerLifecycle(pi: ExtensionAPI) {
    pi.on("agent_start", async () => {
      const current = await store.read(runId);
      const source = pendingContinuation ? "continuation" : "user";
      pendingContinuation = false;
      // The first start confirms the launch generation; a later user start is a
      // follow-up that increments it. A continuation reuses the current generation.
      const generation = source === "user" && startedOnce ? current.generation + 1 : current.generation;
      startedOnce = true;
      await life.onPrompt({ runId, generation, source });
    });

    pi.on("agent_settled", async () => {
      const current = await store.read(runId);
      const { action } = await life.onStop({
        runId,
        generation: current.generation,
        hasValidHandoff: await validHandoff(current.generation),
      });
      if (action === "continue") {
        // Set the flag BEFORE sending, so the agent_start this triggers is tagged.
        pendingContinuation = true;
        pi.sendUserMessage(continuationPrompt(runId, current.generation), {
          deliverAs: "followUp",
          triggerTurn: true,
        });
      }
    });

    pi.on("session_shutdown", async () => {
      const current = await store.read(runId);
      await life.onSessionEnd({ runId, generation: current.generation });
    });
  };
}

async function handoffExists(store: any, runId: string, generation: number): Promise<boolean> {
  const run = await store.read(runId);
  return Boolean(run && run.state === "completed" && run.generation === generation);
}

export default createWorkflowWorkerLifecycleExtension();
```

- [ ] **Step 7: Run tests**

Run: `node --test test/workflow-pi-lifecycle-extension.test.js test/workflow-harnesses.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .pi/extensions/workflow-worker-lifecycle.ts src/workflow/harnesses.js test/workflow-pi-lifecycle-extension.test.js test/workflow-harnesses.test.js
git commit -m "feat(pi): thin lifecycle extension and worker extension loading"
```

---

### Task 7: Observability extension to Pi 0.81.1 + `resume`/`close` CLI

**Files:**
- Modify: `.pi/extensions/workflow-worker-observability.ts` (version bump)
- Modify: `bin/workflow.js` (add `resume`, `close` subcommands)
- Test: extend `test/workflow-cli.test.js`

**Interfaces:**
- Consumes: `planResume` (Task 4), `closeWorker` (Task 5), a real `worker-transport` (`pi-delegation-transport.js`).
- Produces: `workflow resume <run-id>` and `workflow close <run-id>` commands.

- [ ] **Step 1: Bump the observability extension version**

In `.pi/extensions/workflow-worker-observability.ts`, change `createTelemetryAdapter({ harness: "pi", version: "0.80.10" })` to `version: "0.81.1"`.

- [ ] **Step 2: Write the failing CLI test**

```js
test("resume and close subcommands dispatch to their commands read-only until confirmed", async () => {
  const calls = [];
  const deps = makeCliDeps({
    resumeCommand: async (opts) => { calls.push(["resume", opts.runId]); return { action: "focus" }; },
    closeCommand: async (opts) => { calls.push(["close", opts.runId]); return { closed: false, reason: "working" }; },
  });
  await main(["node", "workflow.js", "resume", "11111111-1111-4111-8111-111111111111"], deps);
  await main(["node", "workflow.js", "close", "11111111-1111-4111-8111-111111111111"], deps);
  assert.deepEqual(calls.map((c) => c[0]), ["resume", "close"]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/workflow-cli.test.js`
Expected: FAIL — unknown command `resume`.

- [ ] **Step 4: Add the subcommands in `bin/workflow.js`**

Follow the existing `result`/`reconcile` command dispatch pattern:
```js
if (command === "resume") {
  const runId = argv[0];
  return await run(dependencies.resumeCommand ?? defaultResumeCommand, { command: "resume", runId, ...commonOptions });
}
if (command === "close") {
  const runId = argv[0];
  return await run(dependencies.closeCommand ?? defaultCloseCommand, { command: "close", runId, ...commonOptions });
}
```
Add `resumeCommand`/`closeCommand` to `src/workflow/commands.js` that build the real `pi-delegation-transport` and call `planResume`/`closeWorker`, following the existing `delegation` command wiring.

- [ ] **Step 5: Run tests**

Run: `node --test test/workflow-cli.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .pi/extensions/workflow-worker-observability.ts bin/workflow.js src/workflow/commands.js test/workflow-cli.test.js
git commit -m "feat(cli): resume/close commands and observability 0.81.1"
```

---

### Task 8: Interactive end-to-end verification (MANUAL — human/TTY)

> Not automatable — dispatch to a human, not a subagent.

**Files:**
- Modify: `docs/superpowers/verification/pi-interactive-lifecycle.md` (add the e2e checklist)

- [ ] **Step 1: Autonomous run**

Launch an interactive Pi run against the fixture. Confirm: the observability widget updates; `workflow status <run-id>` shows `running`; Pi runs the handoff; `workflow result <run-id>` returns the handoff; final state `completed`.

- [ ] **Step 2: Assisted run with a follow-up**

Launch, let Pi settle without a handoff, confirm ≤2 continuation prompts then `manual-handoff-required`. Then type a follow-up; confirm `workflow status` shows the generation incremented and state back to `running`, and the prior `result.json` archived.

- [ ] **Step 3: Resume and close**

Kill the pane; run `workflow resume <run-id>`; confirm it relaunches the exact session. Then `workflow close <run-id>` on an idle worker; confirm graceful close; confirm it refuses a working worker.

- [ ] **Step 4: Record results and commit**

```bash
git add docs/superpowers/verification/pi-interactive-lifecycle.md
git commit -m "docs(verify): interactive lifecycle end-to-end results"
```

---

### Task 9: Full suite and integration check

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all pass (prior count 492 + new lifecycle/resume/close/extension tests), 1 skip.

- [ ] **Step 2: Git checks**

Run: `git diff --check && git status --short`

- [ ] **Step 3: Commit a verification marker**

```bash
git commit --allow-empty -m "chore: verify Pi interactive lifecycle integration"
```

---

## Self-Review

- **Spec coverage:** lifecycle core (Tasks 2–3), resume (4), close (5), Pi extension + loading (6), observability 0.81.1 + CLI (7), both interactive modes and recovery verified (1, 8). Generation/stale-result invariant covered in Task 2/3 tests. Empirical-first methodology honored by Task 1 preceding integration (6–8).
- **Placeholder scan:** Tasks 2–5 and 6–7 carry real test and implementation code. Task 1 and 8 are explicitly manual and cannot carry automated code; they carry concrete procedures.
- **Type consistency:** `createLifecycle` returns `{ onPrompt, onStop, onSessionEnd }` used identically in Tasks 3 and 6. `planResume`/`closeWorker` signatures match their CLI wiring in Task 7. Observation states (`active/idle/missing/mismatch/unknown`) match `worker-transport.js`.
- **Risk-gated tasks:** Task 6 depends on Task 1's observed Pi event names and extension-loading mechanism; both are called out inline.
