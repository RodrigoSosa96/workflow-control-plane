# Codex Interactive Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Codex CLI harness to the maximum parity Codex allows — interactive launch that captures the (post-launch) session identity, drives run-state/generation via a Codex lifecycle hook (same event set as Claude), records telemetry, and supports `workflow resume`/`close` (relaunch via `codex resume <id>`) — reusing the generalized session transport.

**Architecture:** Reuse `lifecycle.js`, `resume.js`/`close.js`, and the generalized `session-transport.js`. Add a `codex` session adapter; discover Codex's self-generated session id post-launch (Codex has no `--session-id`); extract the Claude lifecycle-hook logic into a shared core and add a `codex-lifecycle.mjs` (Codex fires the same hooks as Claude); install the workflow hook into Codex's global `~/.codex/hooks.json` beside Herdr's (no-op guarded); relaunch via the `codex resume` subcommand.

**Tech Stack:** Node 24 ESM, native `node --test`, Herdr 0.7.5, codex-cli 0.145.0 (`codex resume <id>`, JSON hooks in `~/.codex/hooks.json`, `-s`/`-a`/`--dangerously-bypass-hook-trust`).

## Global Constraints

- Node 24 ESM, no new dependencies. TDD per task (red→green→commit); full suite (`node --test test/*.test.js`) stays green.
- Do NOT change the supervised (`codex exec` / stream-json) lane or the delegation transport.
- Pi and Claude lanes must keep working (their tests stay green): the transport, execute identity capture, lifecycle-hook core extraction, and relaunch generalization are additive/parameterized, never behavior-changing for pi/claude.
- Herdr agent names: 1-32 chars, `[a-z][a-z0-9_-]*`.
- Hooks/markers must never crash the worker — every handler swallows its own errors.
- The Codex hook install must NEVER clobber Herdr's entry in `~/.codex/hooks.json`; it is idempotent and no-ops for non-workers.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Verified facts (no probe needed)

- Codex fires the **same hook event set as Claude** (`SessionStart, UserPromptSubmit, Stop, SessionEnd, PreToolUse, PostToolUse, PreCompact, Notification` — from the codex binary). So the codex lifecycle hook mirrors `hooks/claude-lifecycle.mjs`.
- Codex hooks live in `~/.codex/hooks.json`, shape `{hooks:{<Event>:[{hooks:[{command,type,timeout}]}]}}`; Herdr already installs a `SessionStart` hook there.
- `codex resume <SESSION_ID>` resumes a saved session (cwd-scoped); sessions at `~/.codex/sessions/<YYYY>/<MM>/<...>_<uuid>.jsonl`.
- `codexArgv` already builds `codex -C <cwd> --add-dir <run-dir> -s <sandbox> -a <approval> [-m <model>] <bootstrap>`.

## Probe / e2e defaults (confirmed or adjusted in the human/TTY e2e — Task 7)

- `codex.sessionMatches(value, id)` defaults to `value === id` (bare uuid, like Claude); adjust if the probe shows a path.
- `codex` graceful exit defaults to `exitText: "/quit"` (send-text + enter); the e2e confirms and adjusts (Claude needed `/exit`, Pi needs `ctrl+d`).
- Post-launch identity: read from `herdr agent list` (agent at the started pane); fallback newest session file.
- Stop-hook `{decision:"block"}` continuation: emitted like Claude; if Codex ignores it, the run still completes via the handoff (non-load-bearing).

---

## Task 1: `SESSION_ADAPTERS.codex` — codex session adapter

**Files:**
- Modify: `src/workflow/session-transport.js` (`SESSION_ADAPTERS`, and `requestGracefulClose` if the codex exit needs the text path)
- Modify: `test/workflow-session-transport.test.js`

**Interfaces:**
- Consumes: `herdr` (`listAgents`, `agentSendKeys`, `sendText`, `focusAgent`), identity `{ kind:"codex-session", harness:"codex", sessionId, paneId, cwd, ... }`.
- Produces: `SESSION_ADAPTERS.codex = { sessionMatches(value, id), exitText: "/quit" }` (or `exitKeys` if the probe shows keys). `createSessionTransport({ herdr, harness:"codex" })` returns a working transport. The claude exit path (`exitText` → `sendText`+`enter`) already exists from the Claude lane — reuse it; codex just supplies `exitText`.

- [ ] **Step 1: Read** `src/workflow/session-transport.js` — note `SESSION_ADAPTERS` (pi path-suffix, claude bare-id + `exitText:"/exit"`) and how `requestGracefulClose` branches on `adapter.exitText` (added in the Claude lane). Codex reuses that branch.

- [ ] **Step 2: Write the failing test**

```js
// add to test/workflow-session-transport.test.js
test("codex adapter matches a bare-uuid session and closes via /quit text", async () => {
  const identity = { kind: "codex-session", harness: "codex", runId: "r1", sessionId: "11111111-1111-4111-8111-111111111111", paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", cwd: "/wt" };
  const calls = [];
  const herdr = {
    async listAgents() { return { agents: [{ agent: "codex", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle", agent_session: { kind: "id", value: "11111111-1111-4111-8111-111111111111" } }] }; },
    async sendText(a) { calls.push(["sendText", a]); },
    async agentSendKeys(a) { calls.push(["agentSendKeys", a]); return { type: "ok" }; },
    async focusAgent() {},
  };
  const t = createSessionTransport({ harness: "codex", herdr });
  assert.equal((await t.observeExact(identity)).state, "idle");
  const r = await t.requestGracefulClose(identity);
  assert.equal(r.requested, true);
  assert.deepEqual(calls[0], ["sendText", { paneId: "w1:p2", text: "/quit" }]);
  assert.deepEqual(calls[1], ["agentSendKeys", { target: "w1:p2", keys: ["enter"] }]);
});

test("SESSION_ADAPTERS.codex exposes a bare-id match rule", () => {
  assert.equal(SESSION_ADAPTERS.codex.sessionMatches("abc", "abc"), true);
  assert.equal(SESSION_ADAPTERS.codex.sessionMatches("/x/abc.jsonl", "abc"), false);
});
```

- [ ] **Step 3: Run → FAIL** (`SESSION_ADAPTERS.codex` undefined): `node --test test/workflow-session-transport.test.js`

- [ ] **Step 4: Implement** — add `codex: Object.freeze({ sessionMatches: (value, id) => value === id, exitText: "/quit" })` to `SESSION_ADAPTERS`. No other transport change should be needed (the `exitText` branch exists). Confirm `createSessionTransport` throws for unknown harness still holds.

- [ ] **Step 5: Run new + pi + claude transport tests → PASS**; then full suite → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/workflow/session-transport.js test/workflow-session-transport.test.js
git commit -m "feat(transport): codex session adapter (bare-id match, /quit exit)"
```

---

## Task 2: Post-launch session-id discovery for Codex

**Files:**
- Modify: `src/workflow/execute.js` (the interactive identity build — ordinary + group paths)
- Modify: `test/workflow-execute.test.js`

**Interfaces:**
- Consumes: `plan.agent.harness`, `launch.expected.nativeSessionId` (null for codex), the started agent's `paneId`, `herdr.listAgents`.
- Produces: for a codex plan, `sessionIdentity.sessionId` is DISCOVERED (not from `launch.expected`): after `startAgentProcess`, if `harness === "codex"` and no `nativeSessionId`, read it from `herdr.listAgents()` — the agent whose `pane_id === startedAgent.paneId`, take `agent_session.value`. Bounded retry (a few attempts) since it may appear a beat later. If not found, leave `sessionId: null` (resume will fail safe → offer relaunch). Pi/Claude keep `launch.expected.nativeSessionId`.

- [ ] **Step 1: Write the failing test**

```js
test("an interactive codex start discovers the session id from herdr agent list", async () => {
  const calls = [];
  const plan = buildPlan({ agentHarness: "codex", agentProfileName: "codex-worker",
    agentProfile: { mode: "interactive", model: null, arguments: [], sandbox: "workspace-write", approval_policy: "never" } });
  plan.operations = plan.operations.map((o) => o.id === "agent" ? { ...o, kind: "agent.session.start", command: "codex" } : o);
  const launchSpec = { argv: ["codex", "-C", plan.agent.worktreePath], env: {},
    expected: { harness: "codex", nativeSessionId: null, cwd: plan.agent.worktreePath } };
  // herdr reports the started codex agent (pane w1:p2) with its generated session id
  const herdr = createHerdr(calls, { agentsAfterStart: [{ agent: "codex", pane_id: "w1:p2", agent_session: { kind: "id", value: "codex-sess-9" } }] });
  const report = await executeStart(plan, { git: {}, herdr }, { buildAgentLaunch: () => launchSpec });
  const agentOp = report.operations.find((o) => o.id === "agent");
  assert.equal(agentOp.sessionIdentity.kind, "codex-session");
  assert.equal(agentOp.sessionIdentity.harness, "codex");
  assert.equal(agentOp.sessionIdentity.sessionId, "codex-sess-9");
});
```

(The `createHerdr` fake already gained `agentsAfterStart` + `listAgents` in the recovery-lane readiness-recovery work — reuse it. If it returns `listAgents` for the discovery, wire the fake so `listAgents` yields `agentsAfterStart`.)

- [ ] **Step 2: Run → FAIL** (codex identity has `sessionId: null`, no discovery).

- [ ] **Step 3: Implement** — in the `sessionIdentity` construction, for `harness === "codex"` with a null `launch.expected?.nativeSessionId`, call a small helper `discoverCodexSessionId({ herdr, paneId: startedAgent.paneId })` that reads `herdr.listAgents()`, finds `getPaneId(a) === paneId`, returns `a.agent_session?.value ?? null`, with a bounded retry loop (e.g. 3 attempts). Use its result as `sessionId`. Pi/Claude paths unchanged. Keep it a codex-only branch.

- [ ] **Step 4: Run → PASS**; full suite → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/workflow/execute.js test/workflow-execute.test.js
git commit -m "feat(execute): discover codex session id post-launch from herdr agent list"
```

---

## Task 3: Codex launch autonomy flag

**Files:**
- Modify: `src/workflow/harnesses.js` (`codexArgv`)
- Modify: `test/workflow-harnesses.test.js`

**Interfaces:**
- Produces: interactive `codexArgv` appends `--dangerously-bypass-hook-trust` (so the workflow lifecycle hook runs without a per-invocation hook-trust prompt) ONLY when `run && profile.mode === "interactive"`. Sandbox/approval stay profile-driven (a worker profile sets `approval_policy: never`). `codex exec` / stream-json unaffected.

- [ ] **Step 1: Write the failing test**

```js
test("interactive codexArgv adds --dangerously-bypass-hook-trust; stream-json does not", () => {
  const run = { id: "r", directory: "/state/r", generation: 1, stateRoot: "/state", controlPlaneBin: "/cp/bin/workflow.js" };
  const base = { harness: "codex", command: "codex", model: null, arguments: [], sandbox: "workspace-write", approval_policy: "never" };
  const interactive = buildHarnessLaunch({ profileName: "codex-worker", profile: { ...base, mode: "interactive" }, sessionName: "s", cwd: "/wt", run });
  assert.ok(interactive.argv.includes("--dangerously-bypass-hook-trust"));
  const streamed = buildHarnessLaunch({ profileName: "codex-worker", profile: { ...base, mode: "stream-json" }, sessionName: "s", cwd: "/wt", run });
  assert.ok(!streamed.argv.includes("--dangerously-bypass-hook-trust"));
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `codexArgv`, push `--dangerously-bypass-hook-trust` when `run && profile.mode === "interactive"`. Keep the existing `-s`/`-a`/`--add-dir`/model/bootstrap wiring.
- [ ] **Step 4: Run → PASS**; full suite → PASS.
- [ ] **Step 5: Commit**
```bash
git add src/workflow/harnesses.js test/workflow-harnesses.test.js
git commit -m "feat(harness): interactive codex passes --dangerously-bypass-hook-trust"
```

---

## Task 4: Shared lifecycle-hook core + `codex-lifecycle.mjs`

**Files:**
- Create: `hooks/lib/lifecycle-hook-core.mjs` (extracted from `hooks/claude-lifecycle.mjs`)
- Modify: `hooks/claude-lifecycle.mjs` (use the shared core; claude tests stay green)
- Create: `hooks/codex-lifecycle.mjs`
- Modify: `test/workflow-claude-lifecycle-hook.test.js` (unchanged behavior)
- Create: `test/workflow-codex-lifecycle-hook.test.js`

**Interfaces:**
- Produces:
  - `runLifecycleHook({ harness, event, stdinJson, env, store, lifecycle, telemetry, hasValidHandoff })` in the core — the exact behavior `runClaudeLifecycleHook` has today (no-op unless `WORKFLOW_RUN_ID` set & `WORKFLOW_HARNESS === harness`; `UserPromptSubmit`→onPrompt with persisted `<h>StartedOnce`/`<h>PendingContinuation` markers; `Stop`→onStop + optional block; `SessionEnd`→onSessionEnd; telemetry phase; error-swallowed).
  - `runClaudeLifecycleHook(...)` becomes a thin wrapper: `runLifecycleHook({ harness: "claude", ... })`.
  - `runCodexLifecycleHook(...)` = `runLifecycleHook({ harness: "codex", ... })`; the CLI wrapper reads `process.argv[2]` as the event, stdin JSON, env, and builds store/lifecycle/telemetry.
- The marker field names must be harness-scoped (e.g. `${harness}StartedOnce`) so a run that somehow saw both never collides — but a run is single-harness, so simply reuse the same fields; keep them as the core already defines.

- [ ] **Step 1: Read** `hooks/claude-lifecycle.mjs` fully — it already carries the two fixes (persisted markers; telemetry). The extraction must preserve its behavior exactly (its tests must stay green).

- [ ] **Step 2: Write the failing codex test** (mirror the claude hook tests, harness "codex")

```js
import { runCodexLifecycleHook } from "../hooks/codex-lifecycle.mjs";
// ... same fake store/lifecycle/telemetry helpers as the claude hook test ...
test("codex: first UserPromptSubmit keeps generation 1 even when state is already running", async () => {
  const rec = [];
  const store = runningFixture(); // state running, no markers (parent pre-set running)
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "codex" }, store, lifecycle: fakeLifecycle(rec), telemetry: fakeTelemetry() });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 1, source: "user" }]);
});
test("codex: no-op unless WORKFLOW_HARNESS === codex", async () => {
  const rec = [];
  await runCodexLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" }, store: runningFixture(), lifecycle: fakeLifecycle(rec), telemetry: fakeTelemetry() });
  assert.equal(rec.length, 0);
});
```

- [ ] **Step 3: Run → FAIL** (`hooks/codex-lifecycle.mjs` missing).

- [ ] **Step 4: Implement** — extract `runLifecycleHook` into `hooks/lib/lifecycle-hook-core.mjs`, parameterized by `harness`; rewrite `claude-lifecycle.mjs` to delegate; create `codex-lifecycle.mjs` delegating with `harness:"codex"` + a CLI wrapper. If the probe (Task 7) finds Codex's hook stdin uses different field names than Claude's, normalize them in `codex-lifecycle.mjs` before calling the core.

- [ ] **Step 5: Run** the claude hook tests (unchanged, must pass) + the new codex tests → PASS; full suite → PASS.

- [ ] **Step 6: Commit**
```bash
git add hooks/lib/lifecycle-hook-core.mjs hooks/claude-lifecycle.mjs hooks/codex-lifecycle.mjs test/
git commit -m "feat(codex): lifecycle hook via shared core (claude+codex), full event parity"
```

---

## Task 5: Codex hook install (idempotent, beside Herdr's, guarded)

**Files:**
- Create: `src/workflow/codex-hooks.js` (install helper)
- Create: `test/workflow-codex-hooks.test.js`

**Interfaces:**
- Produces: `ensureCodexWorkerHooks({ hooksPath, controlPlaneRoot, readFile, writeFile })` — reads `~/.codex/hooks.json` (or an empty `{hooks:{}}` if absent), and for each of `UserPromptSubmit`, `Stop`, `SessionEnd`, ensures an entry `{ hooks:[{ type:"command", command:'node "<cp>/hooks/codex-lifecycle.mjs" <Event>', timeout: 10 }] }` is present **in addition to** whatever is already there (never removing/replacing Herdr's `SessionStart` entry). Idempotent: re-running does not duplicate the workflow entry (dedupe by the command string). Returns the merged object (and writes it). The command string is the dedupe key.
- Called at launch for an interactive codex run (or exposed for a `workflow doctor` setup step) — wiring decided with the launch author; the unit here is the pure merge + the install function.

- [ ] **Step 1: Write the failing tests**

```js
import { ensureCodexWorkerHooks, mergeCodexWorkerHooks } from "../src/workflow/codex-hooks.js";

test("adds the workflow lifecycle hooks beside an existing Herdr SessionStart hook, without clobbering it", () => {
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash '/h/herdr-agent-state.sh' session", timeout: 10 }] }] } };
  const merged = mergeCodexWorkerHooks(existing, "/cp");
  // Herdr's SessionStart preserved
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, "bash '/h/herdr-agent-state.sh' session");
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmds = merged.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => /\/cp\/hooks\/codex-lifecycle\.mjs" ?Ev|codex-lifecycle\.mjs" /.test(c) || c.includes(`/cp/hooks/codex-lifecycle.mjs`)));
  }
});

test("is idempotent — merging twice does not duplicate the workflow hook", () => {
  const once = mergeCodexWorkerHooks({ hooks: {} }, "/cp");
  const twice = mergeCodexWorkerHooks(once, "/cp");
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmds = twice.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes("codex-lifecycle.mjs"));
    assert.equal(cmds.length, 1);
  }
});
```

- [ ] **Step 2: Run → FAIL** (module missing).
- [ ] **Step 3: Implement** `mergeCodexWorkerHooks(current, controlPlaneRoot)` (pure) + `ensureCodexWorkerHooks({...})` (read-merge-write with injected fs). The workflow command is `node "<cp>/hooks/codex-lifecycle.mjs" <Event>`; dedupe by that command string per event; never touch keys/entries it doesn't own.
- [ ] **Step 4: Run → PASS**; full suite → PASS.
- [ ] **Step 5: Wire** `ensureCodexWorkerHooks` into the interactive codex launch (call it before/at `agent start` for a codex interactive run, using the real `~/.codex/hooks.json` path — respect `$CODEX_HOME` if set). Add a launch test that a codex interactive launch calls the installer. Keep it a codex-only, best-effort step (a hook-install failure must not abort the launch — log a note).
- [ ] **Step 6: Commit**
```bash
git add src/workflow/codex-hooks.js src/workflow/launch.js test/
git commit -m "feat(codex): install workflow lifecycle hooks into ~/.codex/hooks.json (idempotent, beside herdr)"
```

---

## Task 6: CLI relaunch — `codex resume <id>` branch

**Files:**
- Modify: `src/workflow/commands.js` (`relaunchSession` — add a codex branch)
- Modify: `test/workflow-resume-close-commands.test.js`

**Interfaces:**
- Produces: `relaunchSession(identity, deps)` for `harness === "codex"` builds argv `[codexCommand, "resume", identity.sessionId, "-C", identity.cwd, "-s", <sandbox?>, "-a", "never", "--dangerously-bypass-hook-trust"]` — the `codex resume` SUBCOMMAND with the exact session id, run in the original cwd, no bootstrap. Resolve `lookupExecutable("codex")`. Agent name `resume-<sessionId first block>` (≤32), `--kind codex`, `focusAgent` the new pane, persist the new identity. Sandbox/approval that aren't on the identity may be omitted (documented follow-up, like the claude relaunch omits permission-mode/model). Pi (`--session-id`) and Claude (`--resume`) branches unchanged.

- [ ] **Step 1: Write the failing test**

```js
test("codex relaunch builds `codex resume <exact>` subcommand, no bootstrap, valid name", async () => {
  const sessionId = "d263185e-7ef5-4521-857d-8818074a826e";
  const identity = { kind: "codex-session", harness: "codex", runId: RUN_ID, sessionId, paneId: "w2:p9", tabId: "w2:t1", workspaceId: "w2", cwd: "/wt" };
  const startCalls = [];
  const herdr = { async listAgents() { return { agents: [] }; },
    async createTab() { return { tabId: "w3:t1", paneId: "w3:p0" }; },
    async splitPane() { return { paneId: "w3:p1" }; },
    async startAgent(a) { startCalls.push(a); return { agentId: "a", tabId: "w3:t1", paneId: "w3:p1" }; },
    async focusAgent() {} };
  const run = { id: RUN_ID, transportIdentity: identity, directory: RUN_DIRECTORY, generation: 1, stateRoot: RUN_STATE_ROOT, controlPlaneBin: RUN_CONTROL_PLANE_BIN, profileName: "codex-worker", harness: "codex" };
  const res = await resumeCommand({ runId: RUN_ID, confirmed: true }, { store: storeFor(run), herdr, lookupExecutable: async () => "/usr/bin/codex" });
  assert.equal(res.action, "relaunched");
  assert.equal(startCalls[0].kind, "codex");
  assert.ok(startCalls[0].name.length <= 32);
  assert.match(startCalls[0].name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(startCalls[0].argv[0], "/usr/bin/codex");
  assert.equal(startCalls[0].argv[1], "resume");
  assert.equal(startCalls[0].argv[2], sessionId);
  assert.ok(startCalls[0].argv.includes("-C"));
  assert.equal(startCalls[0].argv.some((v) => /assignment\.md|handoff-input\.json/.test(v)), false);
});
```

- [ ] **Step 2: Run → FAIL** (relaunch has no codex branch).
- [ ] **Step 3: Implement** the codex branch in `relaunchSession`: resolve `lookupExecutable("codex")`, build the `codex resume <id> -C <cwd> ...` argv (no bootstrap), keep the shared ≤32-char name + `focusAgent` + identity persistence. If codex needs a fresh settings/hook regeneration on relaunch, none is required (hooks are global). Pi/Claude branches untouched.
- [ ] **Step 4: Run → PASS** (codex + the existing pi/claude relaunch tests); full suite → PASS.
- [ ] **Step 5: Commit**
```bash
git add src/workflow/commands.js test/workflow-resume-close-commands.test.js
git commit -m "feat(cli): codex relaunch via `codex resume <id>` subcommand"
```

---

## Task 7: Codex fixture + probe/e2e verification doc

**Files:**
- Create: `docs/superpowers/verification/codex-interactive-lane.md`
- Modify (if needed): the fixture helper so a codex interactive fixture is easy (registry already has `codex-worker`; patch `mode: interactive`, `approval_policy: never`).

**Interfaces:** none (docs + fixture).

- [ ] **Step 1: Confirm the fixture** — verify `createWorkflowFixture` emits `codex-worker` (harness codex); patching `mode: interactive` + `approval_policy: never` yields an interactive codex launch in a `--dry-run` (op `agent.session.start`, `command: codex`). Document the fixture-build + digest steps (mirror `docs/superpowers/verification/claude-interactive-lane.md`).

- [ ] **Step 2: Probe section (human/TTY)** — the runtime unknowns: (a) `herdr agent list` `agent_session` shape for a codex agent (bare uuid? path?) → confirms `sessionMatches` + discovery; (b) the graceful-exit sequence (`/quit`? `ctrl+d`? `ctrl+c`×2) and target; (c) `codex resume <id>` resumes native history in the cwd with the workflow hook active; (d) which hook stdin fields Codex sends (event key, session id) vs Claude's; (e) the workflow hook installed beside Herdr's does not disturb ordinary Codex sessions (no-op guard). Exact commands.

- [ ] **Step 3: e2e section (before merge)** — full CLI cycle with the codex fixture: launch → identity discovered + `kind:"codex-session"` → run advances + telemetry `phase` recorded (`workflow worker status`) → `resume` focuses codex's pane → `close` idle → `resume` dead → `resume --yes` (`codex resume`) resumes real history → `resume` focuses the new pane. Alias-proof run-id capture; note the launch may report `partial` cosmetically — judge by identity + agent-alive. Fill-in checkboxes.

- [ ] **Step 4: Commit**
```bash
git add docs/superpowers/verification/codex-interactive-lane.md src/workflow/fixture.js
git commit -m "docs(verify): codex interactive lane probe + e2e procedure and fixture"
```

---

## Self-review checklist (run before dispatching execution)

- **Spec coverage:** codex adapter (T1), post-launch identity (T2), autonomy flag (T3), lifecycle hook via shared core (T4), hook install (T5), relaunch subcommand (T6), fixture+verification (T7) — every spec unit maps to a task.
- **Type consistency:** `SESSION_ADAPTERS.codex`, `discoverCodexSessionId`, `runLifecycleHook({harness})`/`runCodexLifecycleHook`, `mergeCodexWorkerHooks`/`ensureCodexWorkerHooks`, `relaunchSession` codex branch — names used consistently.
- **No placeholders:** every code step has real test/impl or an exact reference to the claude analog to mirror.

## Manual gates (human/TTY, after the code tasks)

The probe (T7 §2) and the e2e (T7 §3) run in a TTY (real Codex, tokens). The code uses confident defaults (bare-id match, `/quit` exit, `codex resume`, Claude-mirrored lifecycle); the e2e confirms/adjusts the tactical unknowns (exit sequence, agent_session shape, hook field names), exactly as the Claude e2e did.
