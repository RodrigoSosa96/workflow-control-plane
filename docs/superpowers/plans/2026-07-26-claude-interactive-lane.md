# Claude Interactive Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Claude Code harness to full parity with the Pi interactive lane — interactive launch that drives run-state/generation (lifecycle) and renders an observability widget, plus `workflow resume`/`close` against the live session — by reusing the harness-neutral mold and generalizing the session transport.

**Architecture:** Reuse `lifecycle.js`, `resume.js`, `close.js`, and `execute.js` identity capture unchanged. Generalize `pi-session-transport.js` into a shared transport parameterized by a per-harness session adapter (session-match rule + graceful-exit keys). Add Claude's harness-specific adapters: a `--settings`-injected hook set (`SessionStart`/`UserPromptSubmit`/`Stop`/`SessionEnd`) that shells out to a control-plane lifecycle script driving `lifecycle.js`, and a `statusLine` command rendering the observability widget.

**Tech Stack:** Node.js 24 ESM, native `node --test`, Herdr 0.7.5 CLI, Claude Code 2.1.220 (`--session-id`, `--settings`, hooks, statusLine).

## Global Constraints

- Node 24 ESM only; no new runtime dependencies.
- TDD per task (red → green → commit); the full suite (`node --test test/*.test.js`) stays green.
- Do NOT modify the supervised (stream-json) lane or the delegation transport.
- The existing Pi lanes must keep working — the transport refactor must leave every Pi test green and keep `createPiSessionTransport` callable.
- Herdr agent names: 1-32 chars, `[a-z][a-z0-9_-]*` (relaunch name must respect this).
- Hooks/statusLine scripts must never crash the worker — every handler swallows its own errors.
- Absolute paths only in generated settings/argv (control-plane scripts referenced by absolute path).
- Commit message trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Verified facts (no probe needed)

- Herdr reports a **Claude** agent as `agent_session: { kind: "id", value: "<bare-uuid>" }`
  (confirmed from `herdr agent list`) — so Claude's session-match rule is
  `value === sessionId` (contrast Pi: `kind:"path"`, value is a `.jsonl` path → suffix match).
- `claude --session-id <uuid>` sets an exact session id; `--settings <file-or-json>` loads
  additional settings (hooks + statusLine) without touching the user's global settings;
  `--permission-mode`, `--add-dir`, `--model`, `-n/--name` exist; `herdr agent start --kind claude`
  is supported; sessions persist at `~/.claude/projects/<munged-cwd>/<id>.jsonl` (cwd-scoped).
- Default graceful-exit keys `["ctrl+d"]` (same as Pi); confirmed for real in the Task 7 e2e.

---

## Task 1: Generalize the session transport with a per-harness adapter

**Files:**
- Modify: `src/workflow/pi-session-transport.js` → rename to `src/workflow/session-transport.js` (keep a thin `pi-session-transport.js` re-export for back-compat, or update imports — see steps)
- Create: `test/workflow-session-transport.test.js` (Claude-adapter + harness-selection cases)
- Keep: `test/workflow-pi-session-transport.test.js` (must stay green; update import if renamed)

**Interfaces:**
- Consumes: `herdr` adapter (`listAgents`, `agentSendKeys`, `focusAgent`), identity `{ kind, harness, runId, sessionId, paneId, tabId, workspaceId, cwd }`.
- Produces:
  - `createSessionTransport({ herdr, harness = "pi" })` → `{ start, observeExact, deliverFollowUp, requestGracefulClose }` (worker-transport contract). Picks the adapter by `harness`.
  - `createPiSessionTransport({ herdr, exitKeys })` → unchanged behavior (thin wrapper over `createSessionTransport({ herdr, harness: "pi" })`).
  - `SESSION_ADAPTERS` map: `{ pi: { sessionMatches(value, id), exitKeys }, claude: { sessionMatches(value, id), exitKeys } }`.
    - `pi.sessionMatches(value, id)` = `typeof value === "string" && value.endsWith("_" + id + ".jsonl")` (current Pi rule; keep exactly what pi-session-transport does today).
    - `pi.exitKeys` = `["ctrl+d"]`.
    - `claude.sessionMatches(value, id)` = `value === id`.
    - `claude.exitKeys` = `["ctrl+d"]`.

- [ ] **Step 1: Read the current transport** to preserve its exact `observeExact` states (active/idle/missing/mismatch/unknown) and `requestGracefulClose` behavior.

Run: read `src/workflow/pi-session-transport.js` and `test/workflow-pi-session-transport.test.js` fully. The only behavior that becomes adapter-driven is (a) how an agent's `agent_session.value` is matched to `identity.sessionId`, and (b) which keys `requestGracefulClose` sends.

- [ ] **Step 2: Write the failing Claude-adapter test**

```js
// test/workflow-session-transport.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionTransport, SESSION_ADAPTERS } from "../src/workflow/session-transport.js";

const identity = { kind: "claude-session", harness: "claude", runId: "r1", sessionId: "11111111-1111-4111-8111-111111111111", paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", cwd: "/wt" };

function herdrWith(agents) {
  return {
    async listAgents() { return { agents }; },
    async agentSendKeys() { return { type: "ok" }; },
    async focusAgent() {},
  };
}

test("claude adapter matches a bare-uuid agent_session value (kind:id), not a path suffix", async () => {
  const transport = createSessionTransport({ harness: "claude", herdr: herdrWith([
    { agent: "claude", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle",
      agent_session: { kind: "id", value: "11111111-1111-4111-8111-111111111111" } },
  ]) });
  const obs = await transport.observeExact(identity);
  assert.equal(obs.state, "idle");
});

test("claude adapter reports mismatch when the bare-uuid session differs", async () => {
  const transport = createSessionTransport({ harness: "claude", herdr: herdrWith([
    { agent: "claude", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle",
      agent_session: { kind: "id", value: "99999999-9999-4999-8999-999999999999" } },
  ]) });
  const obs = await transport.observeExact(identity);
  assert.equal(obs.state, "mismatch");
});

test("SESSION_ADAPTERS expose pi (path-suffix) and claude (bare-id) match rules", () => {
  assert.equal(SESSION_ADAPTERS.claude.sessionMatches("11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"), true);
  assert.equal(SESSION_ADAPTERS.pi.sessionMatches("/x/2026_abc.jsonl", "abc"), true);
  assert.equal(SESSION_ADAPTERS.pi.sessionMatches("abc", "abc"), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/workflow-session-transport.test.js`
Expected: FAIL (`session-transport.js` does not exist yet).

- [ ] **Step 4: Refactor the transport**

Rename `pi-session-transport.js` to `session-transport.js`. Introduce `SESSION_ADAPTERS` and make `observeExact`/`requestGracefulClose` read `sessionMatches`/`exitKeys` from the adapter selected by `harness` (default `"pi"`). Export `createSessionTransport({ herdr, harness = "pi" })`. Re-export `createPiSessionTransport` as `({ herdr, exitKeys } = {}) => createSessionTransport({ herdr, harness: "pi", ...(exitKeys ? { exitKeys } : {}) })` (keep the `exitKeys` override for existing callers). Update `src/workflow/pi-session-transport.js` to re-export from `session-transport.js` (so existing imports keep working) OR update the two importers (`commands.js`, the Pi transport test) — prefer the re-export to minimize churn.

Preserve every existing observeExact state exactly: absent → `missing`; herdr error → `unknown`; present with wrong cwd or non-matching session → `mismatch`; `agent_status === "working"` → `active`; else → `idle`.

- [ ] **Step 5: Run the new + existing transport tests**

Run: `node --test test/workflow-session-transport.test.js test/workflow-pi-session-transport.test.js`
Expected: PASS (Pi tests unchanged, Claude tests green).

- [ ] **Step 6: Run the full suite**

Run: `node --test test/*.test.js`
Expected: PASS (no regressions from the rename/re-export).

- [ ] **Step 7: Commit**

```bash
git add src/workflow/session-transport.js src/workflow/pi-session-transport.js test/workflow-session-transport.test.js
git commit -m "refactor(transport): generalize session transport with per-harness adapter (pi + claude)"
```

---

## Task 2: Carry `harness` on the transport identity

**Files:**
- Modify: `src/workflow/execute.js` (the two `sessionIdentity` literals: ordinary ~line 752 and group path ~line 983)
- Modify: `test/workflow-execute.test.js`

**Interfaces:**
- Consumes: `plan.agent.harness` (already used for `startAgentProcess` kind), `launch.expected.nativeSessionId`.
- Produces: `sessionIdentity = { kind: "<harness>-session", harness, runId, sessionId, paneId, tabId, workspaceId, cwd }`. For a pi plan → `kind:"pi-session", harness:"pi"` (back-compat); for a claude plan → `kind:"claude-session", harness:"claude"`.

- [ ] **Step 1: Write the failing test** (extend the existing interactive-identity test file)

```js
test("an interactive claude start reports a claude-session identity carrying harness", async () => {
  const calls = [];
  const plan = buildPlan({ agentHarness: "claude", agentProfileName: "claude-worker",
    agentProfile: { mode: "interactive", model: null, arguments: [], permission_mode: "manual" } });
  plan.operations = plan.operations.map((o) => o.id === "agent" ? { ...o, kind: "agent.session.start", command: "claude" } : o);
  const launchSpec = { argv: ["claude", "--session-id", "sess-1"], env: {},
    expected: { harness: "claude", nativeSessionId: "sess-1", cwd: plan.agent.worktreePath } };

  const report = await executeStart(plan, fakeAdapters(calls), { buildAgentLaunch: () => launchSpec });
  const agentOp = report.operations.find((o) => o.id === "agent");
  assert.equal(agentOp.sessionIdentity.kind, "claude-session");
  assert.equal(agentOp.sessionIdentity.harness, "claude");
  assert.equal(agentOp.sessionIdentity.sessionId, "sess-1");
});
```

Also assert the existing Pi identity test still expects `kind:"pi-session"` and now also `harness:"pi"` (add the `harness` assertion to the existing pi test).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/workflow-execute.test.js`
Expected: FAIL (identity has no `harness`; kind is hardcoded `"pi-session"`).

- [ ] **Step 3: Implement** — in both `sessionIdentity` literals, derive `const harness = plan.agent?.harness ?? "pi";` and set `kind: \`${harness}-session\``, `harness`. Leave every other field unchanged.

- [ ] **Step 4: Run tests**

Run: `node --test test/workflow-execute.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `node --test test/*.test.js` → PASS
```bash
git add src/workflow/execute.js test/workflow-execute.test.js
git commit -m "feat(execute): carry harness on the interactive session identity (pi/claude)"
```

---

## Task 3: Claude worker settings (hooks + statusLine) injected via `--settings`

**Files:**
- Modify: `src/workflow/harnesses.js` (`claudeArgv`, add a `buildClaudeWorkerSettings` + `CLAUDE_WORKER_HOOKS` constant; export it)
- Modify: `src/workflow/launch.js` and/or `src/workflow/execute.js` — write the settings file into the run dir before starting a Claude interactive agent (mirror how the assignment is written)
- Modify: `test/workflow-harnesses.test.js` (or the existing harnesses test file)

**Interfaces:**
- Consumes: `run` (for `runEnv`), control-plane root.
- Produces:
  - `buildClaudeWorkerSettings({ controlPlaneRoot })` → a settings object `{ hooks: {...}, statusLine: {...} }` whose commands are `node <abs>/hooks/claude-lifecycle.mjs <event>` and `node <abs>/hooks/claude-statusline.mjs` (absolute paths).
  - `claudeArgv({ profile, cwd, run, nativeSessionId, settingsPath })` — when `run && profile.mode === "interactive"`, append `--settings <settingsPath>` (analogous to piArgv's `--extension`). Supervised (stream-json) claude must NOT get `--settings`.
  - The generated settings file path lives at `<run.directory>/claude-worker-settings.json`.

- [ ] **Step 1: Write the failing test for settings content**

```js
import { buildClaudeWorkerSettings } from "../src/workflow/harnesses.js";

test("claude worker settings wire lifecycle hooks and a statusLine to control-plane scripts", () => {
  const s = buildClaudeWorkerSettings({ controlPlaneRoot: "/cp" });
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmd = s.hooks[ev][0].hooks[0].command;
    assert.match(cmd, /\/cp\/hooks\/claude-lifecycle\.mjs/);
    assert.equal(s.hooks[ev][0].hooks[0].type, "command");
  }
  assert.match(s.statusLine.command, /\/cp\/hooks\/claude-statusline\.mjs/);
  assert.equal(s.statusLine.type, "command");
});
```

- [ ] **Step 2: Write the failing test for the argv wiring**

```js
test("interactive claudeArgv appends --settings; stream-json does not", () => {
  const run = { id: "r", directory: "/state/r", generation: 1, stateRoot: "/state", controlPlaneBin: "/cp/bin/workflow.js" };
  const interactive = buildHarnessLaunch({ profileName: "claude-worker",
    profile: { harness: "claude", command: "claude", mode: "interactive", model: null, arguments: [], permission_mode: "manual" },
    sessionName: "s", cwd: "/wt", run, settingsPath: "/state/r/claude-worker-settings.json" });
  assert.ok(interactive.argv.includes("--settings"));
  assert.equal(interactive.argv[interactive.argv.indexOf("--settings") + 1], "/state/r/claude-worker-settings.json");

  const streamed = buildHarnessLaunch({ profileName: "claude-worker",
    profile: { harness: "claude", command: "claude", mode: "stream-json", model: null, arguments: [], permission_mode: "manual" },
    sessionName: "s", cwd: "/wt", run });
  assert.ok(!streamed.argv.includes("--settings"));
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `node --test test/workflow-harnesses.test.js`
Expected: FAIL (`buildClaudeWorkerSettings` undefined; `claudeArgv` ignores settings).

- [ ] **Step 4: Implement** — add `buildClaudeWorkerSettings`, thread `settingsPath` through `buildHarnessLaunch` → `claudeArgv`, and append `--settings <settingsPath>` only when `run && profile.mode === "interactive"` and `settingsPath` is set. Export `buildClaudeWorkerSettings`.

- [ ] **Step 5: Write the settings file at launch** — where the interactive Claude agent is started (the launch path that builds the agent launch), write `buildClaudeWorkerSettings({ controlPlaneRoot })` to `<run.directory>/claude-worker-settings.json` and pass that path as `settingsPath` to the launch builder. Add a test in the launch/execute test that a Claude interactive launch writes the settings file and passes `--settings` pointing at it. (Follow the existing pattern for how the assignment file is written + how `buildAgentLaunch` is invoked.)

- [ ] **Step 6: Run tests**

Run: `node --test test/workflow-harnesses.test.js test/workflow-launch.test.js`
Expected: PASS.

- [ ] **Step 7: Full suite + commit**

```bash
git add src/workflow/harnesses.js src/workflow/launch.js src/workflow/execute.js test/
git commit -m "feat(harness): inject claude worker hooks+statusLine via --settings for interactive runs"
```

---

## Task 4: Claude lifecycle hook script

**Files:**
- Create: `hooks/claude-lifecycle.mjs`
- Create: `test/workflow-claude-lifecycle-hook.test.js`

**Interfaces:**
- Consumes: hook event JSON on stdin (`{ hook_event_name, session_id, ... }`), `WORKFLOW_*` env, `createRunStore`, `createLifecycle`.
- Produces: an exported `runClaudeLifecycleHook({ event, stdinJson, env, store, lifecycle })` (pure, testable) plus a thin CLI wrapper (`argv[2]` = event, reads real stdin/env). Behavior:
  - event `SessionStart` or first `UserPromptSubmit` → `lifecycle.onPrompt({ runId, generation: current.generation, source: "user" })` (first start confirms launch generation).
  - subsequent `UserPromptSubmit` → `lifecycle.onPrompt({ runId, generation: current.generation + 1, source: "user" })`.
  - `Stop` → `lifecycle.onStop({ runId, generation: current.generation, hasValidHandoff })`; if `action === "continue"`, write `JSON.stringify({ decision: "block", reason: continuationPrompt(runId, generation) })` to stdout; otherwise write nothing.
  - `SessionEnd` → `lifecycle.onSessionEnd({ runId })`.
  - Distinguishing first vs subsequent `UserPromptSubmit`: use `current.state === "launching"` (first) vs running (subsequent), mirroring `onPrompt`'s own `isFollowUp` guard — so no extra local state is needed. (A `Stop`-block continuation does not fire `UserPromptSubmit`, so continuations never reach `onPrompt` here — confirmed in the Task 7 probe.)
  - Every branch is wrapped so a thrown error is swallowed and the process exits 0 (a hook must not break the worker).
- `continuationPrompt(runId, generation)` — reuse the wording from the Pi extension: `Before ending this turn, create the workflow handoff for run <runId>, generation <generation>.`
- `hasValidHandoff(store, runId, generation)` — reuse the Pi extension's `handoffExists` semantics (run `completed` at that generation). Import or replicate the small helper.

- [ ] **Step 1: Write the failing tests**

```js
import { runClaudeLifecycleHook } from "../hooks/claude-lifecycle.mjs";

function fakeStore(run) {
  const calls = [];
  return { calls, async read() { return run; }, async update(id, fn) { calls.push(await fn(run)); return run; } };
}
function fakeLifecycle(rec) {
  return {
    async onPrompt(a) { rec.push(["onPrompt", a]); },
    async onStop(a) { rec.push(["onStop", a]); return { action: rec.stopAction ?? "none" }; },
    async onSessionEnd(a) { rec.push(["onSessionEnd", a]); },
  };
}

test("first UserPromptSubmit calls onPrompt with the current generation, source user", async () => {
  const rec = []; rec.stopAction = "none";
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "launching", generation: 1 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 1, source: "user" }]);
});

test("a subsequent UserPromptSubmit (running) increments the generation", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 2 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 3, source: "user" }]);
});

test("Stop with action continue emits a block decision on stdout", async () => {
  const rec = []; rec.stopAction = "continue";
  const out = await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 1 }), lifecycle: fakeLifecycle(rec), hasValidHandoff: async () => false });
  assert.equal(rec[0][0], "onStop");
  assert.match(out ?? "", /"decision":"block"/);
});

test("a store/lifecycle error is swallowed (never throws)", async () => {
  await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: { async read() { throw new Error("boom"); }, async update() {} }, lifecycle: fakeLifecycle([]) });
  // no throw = pass
});

test("no-op when WORKFLOW_RUN_ID / harness is absent", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: {}, store: fakeStore({}), lifecycle: fakeLifecycle(rec) });
  assert.equal(rec.length, 0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/workflow-claude-lifecycle-hook.test.js`
Expected: FAIL (`hooks/claude-lifecycle.mjs` does not exist).

- [ ] **Step 3: Implement** `hooks/claude-lifecycle.mjs` with `runClaudeLifecycleHook(...)` per the interface, returning the stdout string (or undefined). The CLI wrapper reads stdin JSON, `process.argv[2]` as event, builds the store + lifecycle, calls the function, and writes any returned string to stdout. Guard on `env.WORKFLOW_RUN_ID && env.WORKFLOW_HARNESS === "claude"` (no-op otherwise). Wrap the body in try/catch that swallows and exits 0.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Full suite + commit**

```bash
git add hooks/claude-lifecycle.mjs test/workflow-claude-lifecycle-hook.test.js
git commit -m "feat(claude): lifecycle hook driving lifecycle.js (onPrompt/onStop/onSessionEnd)"
```

---

## Task 5: Claude observability statusLine hook

**Files:**
- Create: `hooks/claude-statusline.mjs`
- Create: `test/workflow-claude-statusline-hook.test.js`
- Reference: `.pi/extensions/workflow-worker-observability.ts` (`buildObservabilityLines(runId, snapshot)`) — reuse its line-building for a single status line.

**Interfaces:**
- Consumes: statusLine JSON on stdin (`{ session_id, model, cwd, ... }`), `WORKFLOW_*` env, the run's telemetry snapshot (via the run store / telemetry store).
- Produces: `renderClaudeStatusLine({ env, stdinJson, snapshot })` → a single-line string (`Workflow <id8> | <phase> | claude | <model?> | <observability?>`). Reads the measurement `.value` (never assumes a raw number — matches the observability extension's measurement handling). Never throws (returns a minimal line on error).

- [ ] **Step 1: Write the failing tests**

```js
import { renderClaudeStatusLine } from "../hooks/claude-statusline.mjs";

test("renders a workflow status line from a telemetry snapshot", () => {
  const line = renderClaudeStatusLine({ env: { WORKFLOW_RUN_ID: "abc1234567", WORKFLOW_HARNESS: "claude" },
    stdinJson: { model: { display_name: "Sonnet" } },
    snapshot: { phase: "running", observability: "reported" } });
  assert.match(line, /abc12345/);
  assert.match(line, /running/);
  assert.match(line, /claude/);
});

test("returns a safe minimal line on bad input (never throws)", () => {
  const line = renderClaudeStatusLine({ env: {}, stdinJson: null, snapshot: null });
  assert.equal(typeof line, "string");
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL (file missing)

- [ ] **Step 3: Implement** `hooks/claude-statusline.mjs` with `renderClaudeStatusLine(...)` and a CLI wrapper that reads stdin JSON + env, loads the telemetry snapshot from the store, calls the function, prints the line. Guard/try-catch so it always prints something and exits 0.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Full suite + commit**

```bash
git add hooks/claude-statusline.mjs test/workflow-claude-statusline-hook.test.js
git commit -m "feat(claude): statusLine hook rendering the workflow observability widget"
```

---

## Task 6: CLI transport selection + generalized relaunch for Claude

**Files:**
- Modify: `src/workflow/commands.js` (`transportForRun`, `relaunchPiSession` → generalize to `relaunchSession`)
- Modify: `test/workflow-resume-close-commands.test.js`

**Interfaces:**
- Consumes: `run.transportIdentity` (with `kind` ending `-session` + `harness`), `deps.herdr`, `deps.lookupExecutable`, `deps.store`, `buildHarnessLaunch`/`buildClaudeWorkerSettings`.
- Produces:
  - `transportForRun(run, deps, command)` selects `createSessionTransport({ herdr, harness })` for any identity whose `kind` ends in `-session` (harness from `identity.harness`, default `"pi"`).
  - `relaunchSession(identity, deps)` — for `harness === "claude"`, regenerate the worker settings file, build argv `claude --session-id <exact> --permission-mode <..> --add-dir <cwd> --settings <regenerated> [--model]` (NO bootstrap prompt), start in `identity.cwd`; agent name `resume-<sessionId first block>` (≤32 chars); focus the new pane via `focusAgent`. For `harness === "pi"`, keep the existing Pi relaunch argv. Persist the new identity (existing behavior).

- [ ] **Step 1: Write the failing tests**

```js
test("transportForRun selects the session transport for a claude-session identity", async () => {
  const run = { id: RUN_ID, transportIdentity: { kind: "claude-session", harness: "claude", sessionId: "s", paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", cwd: "/wt" } };
  // resume against a live idle claude agent → focused
  const identity = run.transportIdentity;
  const herdr = { async listAgents() { return { agents: [{ agent: "claude", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle", agent_session: { kind: "id", value: "s" } }] }; },
    async focusAgent(a) { herdr._f = a; }, async agentSendKeys() { assert.fail("no keys on resume"); } };
  const result = await resumeCommand({ runId: RUN_ID, confirmed: false }, { store: storeFor(run), herdr });
  assert.equal(result.action, "focused");
  assert.deepEqual(herdr._f, { target: "w1:p2" });
});

test("claude relaunch builds claude --session-id <exact> --settings, no bootstrap, valid agent name", async () => {
  const sessionId = "d263185e-7ef5-4521-857d-8818074a826e";
  const identity = { kind: "claude-session", harness: "claude", runId: RUN_ID, sessionId, paneId: "w2:p9", tabId: "w2:t1", workspaceId: "w2", cwd: "/wt" };
  const startCalls = [];
  const herdr = { async listAgents() { return { agents: [] }; },
    async createTab() { return { tabId: "w3:t1", paneId: "w3:p0" }; },
    async splitPane() { return { paneId: "w3:p1" }; },
    async startAgent(a) { startCalls.push(a); return { agentId: "a", tabId: "w3:t1", paneId: "w3:p1" }; },
    async focusAgent() {} };
  const run = { id: RUN_ID, transportIdentity: identity, directory: RUN_DIRECTORY, generation: 1, stateRoot: RUN_STATE_ROOT, controlPlaneBin: RUN_CONTROL_PLANE_BIN,
    profileName: "claude-worker", harness: "claude" };
  const res = await resumeCommand({ runId: RUN_ID, confirmed: true }, { store: storeFor(run), herdr, lookupExecutable: async () => "/usr/bin/claude" });
  assert.equal(res.action, "relaunched");
  assert.equal(startCalls[0].kind, "claude");
  assert.ok(startCalls[0].name.length <= 32);
  assert.match(startCalls[0].name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(startCalls[0].argv.includes(sessionId));
  assert.ok(startCalls[0].argv.includes("--settings"));
  assert.equal(startCalls[0].argv.some((v) => /assignment\.md|handoff-input\.json/.test(v)), false);
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL (transportForRun only handles `pi-session`; relaunch is Pi-only).

- [ ] **Step 3: Implement** — generalize `transportForRun` to match `*-session` and pass `harness`; generalize `relaunchPiSession` → `relaunchSession` branching on `identity.harness` for the argv (Claude vs Pi), regenerating the Claude settings file, keeping the ≤32-char name + `focusAgent` + identity persistence. Keep `relaunchPiSession` name as an alias if referenced elsewhere.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Full suite + commit**

```bash
git add src/workflow/commands.js test/workflow-resume-close-commands.test.js
git commit -m "feat(cli): route *-session identities to the shared transport; claude relaunch"
```

---

## Task 7: Claude fixture + probe/e2e verification doc

**Files:**
- Create: `docs/superpowers/verification/claude-interactive-lane.md`
- Modify (if needed): the fixture/smoke helper so a Claude interactive fixture is easy to build (the registry already defines `claude-worker`; the fixture just needs `mode: interactive` patched, exactly as the Pi recovery-lane e2e did).

**Interfaces:** none (docs + fixture harness).

- [ ] **Step 1: Confirm the fixture path** — verify `createWorkflowFixture` emits a `claude-worker` profile (harness `claude`, command `claude`) and that patching `agent_profiles["claude-worker"].mode = "interactive"` produces an interactive Claude launch in a dry-run (`op agent.session.start`, `command: claude`). Document the exact fixture-build + digest steps (mirror `docs/superpowers/verification/pi-recovery-lane.md`).

- [ ] **Step 2: Write the probe section** (human/TTY) — the runtime unknowns to confirm on a real Claude session: (a) `ctrl+d` exits an idle Claude cleanly (else `/exit`); (b) `claude --session-id <exact> --settings <file>` resumes native history AND the hooks + statusLine reload; (c) which hooks fire and that a `Stop`-block continuation does NOT refire `UserPromptSubmit`; (d) `herdr agent list` reports the claude agent_session as `kind:"id"`, bare uuid (already observed — re-confirm); (e) `agent focus`/`tab focus` behave. Give exact commands.

- [ ] **Step 3: Write the Task-7 e2e section** — full CLI cycle with the Claude fixture: launch → identity survives to a terminal state → observability line renders → `resume` focuses Claude's pane → `close` idle → `resume` dead → `resume --yes` relaunch resumes real history with hooks+statusLine reloaded → `resume` focuses the new pane. Fill-in checkboxes to hand back.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/verification/claude-interactive-lane.md src/workflow/fixture.js
git commit -m "docs(verify): claude interactive lane probe + e2e procedure and fixture"
```

---

## Self-review checklist (run before dispatching execution)

- **Spec coverage:** transport generalization (T1), identity harness (T2), settings/hooks injection (T3), lifecycle hook (T4), observability (T5), CLI/relaunch (T6), fixture+verification (T7) — every spec unit maps to a task.
- **Type consistency:** `createSessionTransport({ herdr, harness })`, `SESSION_ADAPTERS`, `sessionIdentity.{kind,harness}`, `buildClaudeWorkerSettings({ controlPlaneRoot })`, `claudeArgv(...settingsPath)`, `runClaudeLifecycleHook({ event, stdinJson, env, store, lifecycle, hasValidHandoff })`, `renderClaudeStatusLine({ env, stdinJson, snapshot })`, `relaunchSession(identity, deps)` — names used consistently across tasks.
- **No placeholders:** every code step carries real test/impl code or an exact reference to existing code to mirror.

## Manual gates (human/TTY, after the code tasks)

The probe (T7 §2) and the Task-7 e2e (T7 §3) are run by the operator in a TTY — real Claude consumes tokens and needs a terminal, so they are NOT run by the implementer agents. The code tasks use high-confidence defaults (ctrl+d, bare-id match, hook mapping); the e2e confirms them and any adjustment is a small follow-up.
