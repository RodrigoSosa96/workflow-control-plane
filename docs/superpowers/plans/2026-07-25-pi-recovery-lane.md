# Pi Recovery Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `workflow resume` and `workflow close` operate against a real interactive Pi worker — capture the exact Pi session identity at launch, observe/close it over Herdr, focus a live session or (on confirmation) relaunch a dead one.

**Architecture:** A new `pi-session-transport.js` implements the existing `worker-transport` contract over the Herdr adapter (`observeExact` via `agent list`, graceful close via `agent send-keys` when idle). The interactive launch persists a `pi-session` `transportIdentity` on the run. `resume.js` gains an execute step (focus live / confirmed relaunch of a dead session); `close.js` honors the transport result. The CLI selects the session transport for `pi-session` identities.

**Tech Stack:** Node.js 24 ES modules, `node:test`, Herdr 0.7.5, existing `worker-transport`/`run-store`/`herdr` modules.

**Design spec:** `docs/superpowers/specs/2026-07-25-pi-recovery-lane-design.md`

## Global Constraints

- Graceful close sends an idle exit via `herdr agent send-keys` ONLY after the agent is confirmed idle; never kill a working, unknown, missing, or mismatched process; never `pane close`.
- Resume of a dead session relaunches ONLY on explicit confirmation (`--yes`); never automatically.
- The session transport never reads terminal text; `observeExact` uses only `agent list` fields, and the `worker-transport` contract already forbids terminal-derived detail keys.
- Identity is exact: match native session id + pane id + cwd; a reused pane is a `mismatch`, not an action target.
- `close` honors the transport result: `closed` is true only when `requestGracefulClose` returned `requested: true`.
- Strict red-green-refactor TDD; Node 24 ESM; failures via `WorkflowError`. Run `npm test` green before each commit.
- Worker-transport contract (`src/workflow/worker-transport.js`): `{ start, observeExact, deliverFollowUp, requestGracefulClose }`; observation states `active | idle | missing | mismatch | unknown`; forbidden detail keys `terminal, paneText, transcript, stdout, stderr`.
- Herdr `agent list` agent shape: `{ agent, agent_session: { value }, agent_status: "working"|"idle", cwd, foreground_cwd, pane_id, tab_id }`.

## File Structure

- Modify `src/workflow/herdr.js` — add `agentSendKeys` and `focusPane` (or the probed focus command) methods.
- Create `src/workflow/pi-session-transport.js` — the `worker-transport` implementation over Herdr for `pi-session` identities.
- Modify `src/workflow/execute.js` — assemble and return the `pi-session` identity after an interactive `agent start`.
- Modify `src/workflow/launch.js` — persist the returned identity on the run as `transportIdentity` (interactive only).
- Modify `src/workflow/resume.js` — add `executeResume`.
- Modify `src/workflow/close.js` — honor the transport result.
- Modify `src/workflow/commands.js`, `bin/workflow.js` — select the session transport for `pi-session` identities; `resume --yes` confirms relaunch.
- Tests: extend `test/workflow-herdr.test.js`, `test/workflow-resume.test.js`, `test/workflow-close.test.js`, `test/workflow-execute.test.js`, `test/workflow-cli.test.js`; create `test/workflow-pi-session-transport.test.js`.
- Create `docs/superpowers/verification/pi-recovery-lane.md` — guided manual verification.

---

### Task 1: Empirical probe (MANUAL — human/TTY, gates Tasks 2–3 details)

> Not automatable; must NOT be dispatched to a subagent. Confirms the exact Herdr
> commands the transport wraps.

**Files:** Create `docs/superpowers/verification/pi-recovery-lane.md`

**Interfaces:** Produces the exact `agent send-keys` invocation + key sequence that makes an idle Pi exit; whether `pi --session-id <exact>` resumes the native session; the exact pane/tab/workspace focus-by-id command (or that none exists).

- [ ] **Step 1: Launch an interactive Pi (reuse the sub-project #1 procedure)**

Use `docs/superpowers/verification/pi-interactive-lifecycle.md`'s launch block to get an interactive Pi in a Herdr pane. Note its `run-id`, `pane_id`, and the session id from `herdr agent list`.

- [ ] **Step 2: Probe the graceful-close key sequence**

With the agent idle, try (from `herdr agent send-keys --help` for the exact argv):
```bash
herdr agent list          # note agent_status is "idle" and the session/pane ids
herdr agent send-keys <target> <exit-keys>   # e.g. C-d ; confirm target is pane/session id
herdr agent list          # is the agent gone / did Pi exit cleanly?
```
Record: the exact `send-keys` argv, the exit key(s) that work, and the target id kind.

- [ ] **Step 3: Probe resume by exact session id**

After Pi exits, relaunch it into a fresh pane with its exact session id + extensions and confirm it resumes the same native session (not a fresh one):
```bash
herdr pane split <parent> --direction down --cwd <worktree> --env WORKFLOW_...  # a pane
herdr agent start <name> --kind pi --pane <pane> -- --session-id <exact> --extension <lifecycle> --extension <observability>
```
Record whether the session history is resumed and the extensions reload.

- [ ] **Step 4: Probe focus-by-id**

```bash
herdr pane --help ; herdr tab --help ; herdr workspace --help
```
Record the exact command (if any) that brings a specific pane/tab/workspace to the foreground by id.

- [ ] **Step 5: Write findings and commit**

Write `docs/superpowers/verification/pi-recovery-lane.md` with the three exact command shapes (send-keys, resume argv, focus). Commit:
```bash
git add docs/superpowers/verification/pi-recovery-lane.md
git commit -m "docs(verify): recovery-lane Herdr command probe"
```

---

### Task 2: Herdr adapter — `agentSendKeys` and `focusPane`

**Files:** Modify `src/workflow/herdr.js`; Test `test/workflow-herdr.test.js`

**Interfaces:**
- Consumes: the `run(area, command, args)` / `invoke` helpers already in `herdr.js`, and the probed argv (Task 1 confirmed: `agent send-keys <TARGET> <KEY>...`; focus-by-id is `tab focus <tabId>`, NOT `pane focus`).
- Produces: `herdr.agentSendKeys({ target, keys })` → wraps `herdr agent send-keys <target> <keys...>`; `herdr.focusTab({ tabId })` → wraps `herdr tab focus <tabId>`. Both return the parsed CLI result. This task ALSO updates `executeResume` in `resume.js` to call `herdr.focusTab({ tabId: plan.identity.tabId })` instead of the placeholder `focusPane({ paneId })` (adjust that test's fake to `focusTab`).

- [ ] **Step 1: Write the failing test for `agentSendKeys`**

```js
test("agentSendKeys sends the exit keys to the target via the public cli", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["agent", "send-keys", "w2:p9", "C-d"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ sent: true }, "cli:agent:send-keys"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });
  assert.deepEqual(await herdr.agentSendKeys({ target: "w2:p9", keys: ["C-d"] }), { sent: true });
});

test("agentSendKeys rejects a missing target or empty keys", async () => {
  const herdr = createHerdrAdapter({ runner: fixtureRunner([]).runner });
  await assert.rejects(herdr.agentSendKeys({ target: "", keys: ["C-d"] }), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
  await assert.rejects(herdr.agentSendKeys({ target: "w2:p9", keys: [] }), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-herdr.test.js`
Expected: FAIL — `agentSendKeys` is not a function.

- [ ] **Step 3: Implement `agentSendKeys` and `focusPane`**

In the adapter object in `src/workflow/herdr.js` (adjust the argv to the Task 1 probe):
```js
async agentSendKeys({ target, keys } = {}) {
  if (typeof target !== "string" || !target) {
    fail("PREFLIGHT", "agentSendKeys requires a target id", { target }, 10);
  }
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== "string" || !k)) {
    fail("PREFLIGHT", "agentSendKeys requires non-empty key strings", { target, keys }, 10);
  }
  return await invoke("agent", "send-keys", [target, ...keys]);
},

async focusTab({ tabId } = {}) {
  if (typeof tabId !== "string" || !tabId) {
    fail("PREFLIGHT", "focusTab requires a tab id", { tabId }, 10);
  }
  return await invoke("tab", "focus", [tabId]);
},
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workflow-herdr.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/herdr.js test/workflow-herdr.test.js
git commit -m "feat(herdr): agent send-keys and pane focus adapter methods"
```

---

### Task 3: `pi-session-transport.js`

**Files:** Create `src/workflow/pi-session-transport.js`; Test `test/workflow-pi-session-transport.test.js`

**Interfaces:**
- Consumes: a Herdr adapter with `listAgents()`, `agentSendKeys(...)`; `assertWorkerTransport` shape.
- Produces: `createPiSessionTransport({ herdr, exitKeys = ["C-d"] })` returning `{ start, observeExact, deliverFollowUp, requestGracefulClose }`. Identities are `{ kind: "pi-session", runId, sessionId, paneId, tabId, workspaceId, cwd }`.

- [ ] **Step 1: Write the failing observeExact test**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiSessionTransport } from "../src/workflow/pi-session-transport.js";

const ID = { kind: "pi-session", runId: "r1", sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1", workspaceId: "w2", cwd: "/wt" };
function herdrWith(agents, calls = []) {
  return { async listAgents() { return { agents }; }, async agentSendKeys(a) { calls.push(a); return { sent: true }; } };
}

test("observeExact maps agent_status and identity to a state", async () => {
  const idle = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: "s1" }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }]) });
  assert.equal((await idle.observeExact(ID)).state, "idle");
  const busy = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: "s1" }, pane_id: "w2:p9", cwd: "/wt", agent_status: "working" }]) });
  assert.equal((await busy.observeExact(ID)).state, "active");
  const gone = createPiSessionTransport({ herdr: herdrWith([]) });
  assert.equal((await gone.observeExact(ID)).state, "missing");
  const reused = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: "other" }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }]) });
  assert.equal((await reused.observeExact(ID)).state, "mismatch");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-pi-session-transport.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the transport**

```js
import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("pi-session-transport", message, { details });
}

function assertIdentity(identity) {
  if (!identity || identity.kind !== "pi-session" || typeof identity.sessionId !== "string" || !identity.sessionId
    || typeof identity.paneId !== "string" || !identity.paneId) {
    fail("pi-session identity requires kind, sessionId, and paneId", { identity });
  }
  return identity;
}

function agentList(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.agents) ? value.agents : [];
}

export function createPiSessionTransport({ herdr, exitKeys = ["C-d"] } = {}) {
  if (!herdr || typeof herdr.listAgents !== "function" || typeof herdr.agentSendKeys !== "function") {
    fail("pi-session transport requires a Herdr adapter with listAgents and agentSendKeys");
  }

  async function observeExact(requested) {
    const identity = assertIdentity(requested);
    let agents;
    try {
      agents = agentList(await herdr.listAgents());
    } catch {
      return { state: "unknown", identity };
    }
    const onPane = agents.find((a) => (a?.pane_id ?? a?.paneId) === identity.paneId);
    if (!onPane) return { state: "missing", identity };
    const sessionValue = onPane.agent_session?.value ?? onPane.agentSession?.value;
    const cwd = onPane.cwd ?? onPane.foreground_cwd;
    if (sessionValue !== identity.sessionId || (identity.cwd && cwd && cwd !== identity.cwd)) {
      return { state: "mismatch", identity, details: { observedActive: String(onPane.agent_status === "working") } };
    }
    return { state: onPane.agent_status === "working" ? "active" : "idle", identity };
  }

  async function requestGracefulClose(requested) {
    const identity = assertIdentity(requested);
    const observation = await observeExact(identity);
    if (observation.state !== "idle") return { requested: false };
    await herdr.agentSendKeys({ target: identity.paneId, keys: exitKeys });
    return { requested: true };
  }

  async function start() { fail("pi-session transport start is handled by resume relaunch, not the transport"); }
  async function deliverFollowUp() { fail("pi-session transport does not deliver follow-ups"); }

  return Object.freeze({ start, observeExact, deliverFollowUp, requestGracefulClose });
}
```
Note: `start`/`deliverFollowUp` are intentionally unsupported here — resume's relaunch uses the launch path (Task 5), not the transport. Adjust the `send-keys` target (pane vs session id) and `exitKeys` to the Task 1 probe.

- [ ] **Step 4: Add the requestGracefulClose tests and run**

```js
test("requestGracefulClose sends exit keys only when idle", async () => {
  const calls = [];
  const idle = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: "s1" }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }], calls) });
  assert.deepEqual(await idle.requestGracefulClose(ID), { requested: true });
  assert.equal(calls.length, 1);

  const busyCalls = [];
  const busy = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: "s1" }, pane_id: "w2:p9", cwd: "/wt", agent_status: "working" }], busyCalls) });
  assert.deepEqual(await busy.requestGracefulClose(ID), { requested: false });
  assert.equal(busyCalls.length, 0);
});
```
Run: `node --test test/workflow-pi-session-transport.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/pi-session-transport.js test/workflow-pi-session-transport.test.js
git commit -m "feat(transport): pi-session transport over Herdr (observe + graceful close)"
```

---

### Task 4: Capture the `pi-session` identity at launch

**Files:** Modify `src/workflow/execute.js` (both start paths), `src/workflow/launch.js`; Test `test/workflow-execute.test.js`

**Interfaces:**
- Consumes: `startedAgent` (`{ agentId, tabId, paneId }`) from `startAgentProcess`, `launch.expected.nativeSessionId`, `plan.agent.worktreePath`, the workspace id already in scope.
- Produces: a `sessionIdentity` on the start report for interactive runs; `launch.js` persists it as `run.transportIdentity`.

- [ ] **Step 1: Write the failing test**

```js
test("an interactive start reports a pi-session identity with session, pane, and cwd", async () => {
  const calls = [];
  const plan = buildPlan(); // interactive pi-worker (mode: interactive)
  const launchSpec = { argv: ["pi", "--name", "x", "--session-id", "sess-1"], env: {}, expected: { harness: "pi", nativeSessionId: "sess-1", cwd: "/wt" } };
  const report = await executeStart(plan, fakeAdapters(calls), { buildAgentLaunch: () => launchSpec });
  const agentOp = report.operations.find((o) => o.id === "agent");
  assert.equal(agentOp.sessionIdentity.kind, "pi-session");
  assert.equal(agentOp.sessionIdentity.sessionId, "sess-1");
  assert.equal(agentOp.sessionIdentity.paneId, "w1:p2");
  assert.equal(agentOp.sessionIdentity.cwd, plan.agent.worktreePath);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-execute.test.js`
Expected: FAIL — `sessionIdentity` is undefined.

- [ ] **Step 3: Assemble the identity in `startAgentProcess`/the start paths**

For interactive runs (not the supervisor path), after `startAgentProcess` returns `startedAgent`, build:
```js
const sessionIdentity = launch.supervisor === true ? null : {
  kind: "pi-session",
  runId: plan.run?.id,
  sessionId: launch.expected?.nativeSessionId ?? null,
  paneId: startedAgent.paneId,
  tabId: startedAgent.tabId,
  workspaceId, // already resolved in scope for the close-safety check
  cwd: plan.agent.worktreePath,
};
```
Include it in the agent operation report:
```js
report.operations.push(buildOperationReport(agentOperation, "created", {
  agentId: startedAgent.agentId,
  tabId: startedAgent.tabId,
  paneId: startedAgent.paneId,
  ...(sessionIdentity ? { sessionIdentity } : {}),
}));
```
Apply to BOTH the ordinary (~line 743) and group (~line 961) start paths.

- [ ] **Step 4: Persist it in `launch.js`**

Where `launch.js` updates the run from the start execution report, if an agent operation carries a `sessionIdentity`, write it to the run:
```js
const agentOp = execution.operations?.find((o) => o.sessionIdentity);
if (agentOp?.sessionIdentity?.sessionId) {
  await updateRun(store, run.id, { transportIdentity: agentOp.sessionIdentity });
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/workflow-execute.test.js test/workflow-launch.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/execute.js src/workflow/launch.js test/workflow-execute.test.js
git commit -m "feat(launch): capture the pi-session transport identity at interactive start"
```

---

### Task 5: `resume` execute step and `close` result fix

**Files:** Modify `src/workflow/resume.js`, `src/workflow/close.js`; Test `test/workflow-resume.test.js`, `test/workflow-close.test.js`

**Interfaces:**
- Consumes: `planResume` (existing), a Herdr adapter with `focusPane`, a relaunch function.
- Produces: `executeResume({ store, transport, herdr, runId, confirmed, relaunch })` → `{ action: "focused" | "relaunched" | "needs-confirmation" }`; `closeWorker` returns `closed` from `requestGracefulClose`.

- [ ] **Step 1: Write the failing resume execute tests**

```js
test("executeResume focuses a live session and gates relaunch on confirmation", async () => {
  const focus = [];
  const herdr = { async focusPane(a) { focus.push(a); } };
  const liveTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "idle", identity: { paneId: "w2:p9" } }; } };
  const store = { async read() { return { id: "r1", transportIdentity: { kind: "pi-session", paneId: "w2:p9", sessionId: "s1" } }; } };
  const relaunch = async () => ({ identity: { sessionId: "s1" } });

  const focused = await executeResume({ store, transport: liveTransport, herdr, runId: "r1", confirmed: false, relaunch });
  assert.equal(focused.action, "focused");
  assert.equal(focus.length, 1);

  const deadTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "missing", identity: {} }; } };
  const pending = await executeResume({ store, transport: deadTransport, herdr, runId: "r1", confirmed: false, relaunch });
  assert.equal(pending.action, "needs-confirmation");
  const done = await executeResume({ store, transport: deadTransport, herdr, runId: "r1", confirmed: true, relaunch });
  assert.equal(done.action, "relaunched");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-resume.test.js`
Expected: FAIL — `executeResume` is not defined.

- [ ] **Step 3: Implement `executeResume`**

```js
export async function executeResume({ store, transport, herdr, runId, confirmed = false, relaunch }) {
  const plan = await planResume({ store, transport, runId });
  if (plan.action === "focus") {
    if (herdr && typeof herdr.focusPane === "function" && plan.identity?.paneId) {
      await herdr.focusPane({ paneId: plan.identity.paneId });
    }
    return { action: "focused", identity: plan.identity };
  }
  if (plan.action === "relaunch") {
    if (!confirmed) return { action: "needs-confirmation", plan: "relaunch", identity: plan.identity };
    const result = await relaunch(plan.identity);
    return { action: "relaunched", identity: result?.identity ?? plan.identity };
  }
  throw new WorkflowError("resume", `Cannot resume: ${plan.reason ?? plan.action}`, { details: { runId } });
}
```
`planResume` returns `identity` on focus/relaunch (extend it to include `identity` from the run if it does not already).

- [ ] **Step 4: Fix `closeWorker` to honor the transport result**

In `src/workflow/close.js`, replace the hardcoded `{ closed: true }`:
```js
const result = await transport.requestGracefulClose(identity);
return result?.requested === true
  ? { closed: true }
  : { closed: false, reason: "close-not-confirmed" };
```
Add a close test: an idle observation whose `requestGracefulClose` returns `{ requested: false }` yields `{ closed: false, reason: "close-not-confirmed" }`.

- [ ] **Step 5: Run tests**

Run: `node --test test/workflow-resume.test.js test/workflow-close.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/resume.js src/workflow/close.js test/workflow-resume.test.js test/workflow-close.test.js
git commit -m "feat(recovery): resume execute (focus/relaunch) and close honoring the transport result"
```

---

### Task 6: CLI wiring — select the session transport and confirm relaunch

**Files:** Modify `src/workflow/commands.js`, `bin/workflow.js`; Test `test/workflow-cli.test.js`, `test/workflow-resume-close-commands.test.js`

**Interfaces:**
- Consumes: `createPiSessionTransport` (Task 3), `executeResume`/`closeWorker` (Task 5), the run's `transportIdentity.kind`.
- Produces: `resumeCommand`/`closeCommand` build the session transport for `pi-session` identities; `resume --yes` sets `confirmed: true`.

- [ ] **Step 1: Write the failing command test**

```js
test("resumeCommand builds the pi-session transport and passes confirmed from --yes", async () => {
  const built = [];
  const run = { id: "r1", transportIdentity: { kind: "pi-session", paneId: "w2:p9", sessionId: "s1" } };
  const deps = {
    store: { async read() { return run; } },
    herdr: { async focusPane() {} , async listAgents() { return { agents: [{ agent_session: { value: "s1" }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }] }; } },
    createSessionTransport: (opts) => { built.push(opts); return createPiSessionTransport(opts); },
  };
  const focused = await resumeCommand({ runId: "r1", confirmed: false, ...deps });
  assert.equal(built.length, 1);
  assert.equal(focused.action, "focused");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workflow-resume-close-commands.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement transport selection in `commands.js`**

`resumeCommand`/`closeCommand` read the run, and when `run.transportIdentity?.kind === "pi-session"` build `createPiSessionTransport({ herdr })` (a live Herdr adapter injected the way `withLiveDelegationTransport` injects the delegation transport). Call `executeResume`/`closeWorker` with it. Keep the delegation path for other identity kinds.

- [ ] **Step 4: Add `--yes → confirmed` in `bin/workflow.js`**

In the `resume` dispatch block, pass `confirmed: Boolean(options.yes)` into the command options. `resume` without `--yes` on a dead session returns `needs-confirmation` and prints the relaunch plan; `close` needs no `--yes`.

- [ ] **Step 5: Run tests**

Run: `node --test test/workflow-resume-close-commands.test.js test/workflow-cli.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/commands.js bin/workflow.js test/workflow-resume-close-commands.test.js test/workflow-cli.test.js
git commit -m "feat(cli): select pi-session transport for resume/close; --yes confirms relaunch"
```

---

### Task 7: Interactive end-to-end verification (MANUAL — human/TTY)

**Files:** Modify `docs/superpowers/verification/pi-recovery-lane.md`

- [ ] **Step 1: Launch, then observe/close idle**

Launch an interactive Pi (sub-project #1 procedure). While it is idle: `workflow close <run-id>` → confirm the pane's Pi exits gracefully and the command reports `closed`. Confirm `workflow close` on a working agent refuses.

- [ ] **Step 2: Resume live (focus)**

Launch again; from another pane run `workflow resume <run-id>` → confirm it focuses the live pane and reports `focused`.

- [ ] **Step 3: Resume dead (report → confirm)**

Kill the pane (`herdr pane close`). `workflow resume <run-id>` → reports `needs-confirmation` with the relaunch plan, relaunches nothing. `workflow resume <run-id> --yes` → relaunches `pi --session-id <exact>` and the session resumes with extensions.

- [ ] **Step 4: Record results and commit**

```bash
git add docs/superpowers/verification/pi-recovery-lane.md
git commit -m "docs(verify): recovery-lane end-to-end results"
```

---

### Task 8: Full suite and integration check

- [ ] **Step 1:** Run `npm test` — expected all pass (prior 542 + new transport/resume/close/herdr/cli tests), 1 skip.
- [ ] **Step 2:** `git diff --check && git status --short`.
- [ ] **Step 3:** `git commit --allow-empty -m "chore: verify Pi recovery lane integration"`.

---

## Self-Review

- **Spec coverage:** identity capture (Task 4), pi-session transport observe+close (Task 3) on the Herdr methods (Task 2), resume execute + close fix (Task 5), CLI selection + `--yes` (Task 6), both manual probes/verification (Tasks 1, 7). Every spec decision (send-keys when idle, relaunch only on `--yes`, close honors result) maps to a task.
- **Placeholder scan:** Tasks 2–6 carry real test + implementation code. Tasks 1 and 7 are explicitly manual with concrete command procedures. The `send-keys`/focus argv are marked "per Task 1 probe" — a real dependency, not a placeholder; Task 1 produces the exact shapes before Tasks 2–3 finalize.
- **Type consistency:** `createPiSessionTransport({ herdr, exitKeys })` returns the `worker-transport` shape used identically by `executeResume`/`closeWorker`/the CLI. Observation states (`active/idle/missing/mismatch/unknown`) match `worker-transport.js`. `pi-session` identity fields (`sessionId/paneId/tabId/workspaceId/cwd`) are the same in Task 4 capture and Task 3 consumption.
- **Risk-gated:** Task 1 (probe) precedes the transport details in Tasks 2–3; the exact `send-keys` target/keys and focus command come from it.
