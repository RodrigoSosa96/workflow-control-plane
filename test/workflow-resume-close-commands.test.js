import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeCommand, resumeCommand } from "../src/workflow/commands.js";
import { createPiSessionTransport } from "../src/workflow/pi-session-transport.js";
import { PI_WORKER_EXTENSIONS } from "../src/workflow/harnesses.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { createRunStore } from "../src/workflow/run-store.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RUN_DIRECTORY = "/state/runs/11111111-1111-4111-8111-111111111111";
const RUN_STATE_ROOT = "/state/runs";
const RUN_CONTROL_PLANE_BIN = "/control/bin/workflow";

// run.transportIdentity is only ever absent or `kind: "pi-session"` (delegation identities
// live under run.delegations[id], never on the top-level run) — see commands.js.
function transportIdentity() {
  return { kind: "pi-session", sessionId: "s1" };
}

// resume/close stay read-only except for one case: executeResume's confirmed-relaunch path
// persists the relaunched pi-session's new pane/tab identity (a foreground write triggered by
// the user's own `resume --yes`, not a background writer). updates[] lets tests assert that
// write happened only on that path, and never on focus/needs-confirmation/close.
function storeFor(run) {
  const calls = [];
  const updates = [];
  return {
    calls,
    updates,
    async read(runId) {
      calls.push(runId);
      return structuredClone(run);
    },
    async update(runId, updater) {
      const patch = await updater(structuredClone(run));
      updates.push({ runId, patch });
      return { ...structuredClone(run), ...patch };
    },
  };
}

// Fallback worker transport for runs with no transportIdentity, where commands.js keeps
// deferring to whatever transport the caller injected (e.g. the CLI's delegation transport).
function transportFor(observation) {
  const calls = [];
  return {
    calls,
    async start() {
      assert.fail("resume/close commands must not start a worker");
    },
    async observeExact(identity) {
      calls.push({ method: "observeExact", identity: structuredClone(identity) });
      return structuredClone(observation ?? { state: "idle", identity });
    },
    async deliverFollowUp() {
      assert.fail("resume/close commands must not deliver follow-ups");
    },
    async requestGracefulClose(identity) {
      calls.push({ method: "requestGracefulClose", identity: structuredClone(identity) });
      return { requested: true };
    },
  };
}

function agentRecord(identity, status) {
  return {
    agent_session: { value: `/state/workflow/2026-07-25T00-00-00-000Z_${identity.sessionId}.jsonl` },
    pane_id: identity.paneId,
    cwd: identity.cwd,
    agent_status: status,
  };
}

test("resumeCommand builds the pi-session transport from the live Herdr adapter and focuses a live session", async () => {
  const identity = { kind: "pi-session", runId: RUN_ID, sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1", workspaceId: "w2", cwd: "/wt" };
  const store = storeFor({ id: RUN_ID, transportIdentity: identity });
  const built = [];
  const focusCalls = [];
  const herdr = {
    async listAgents() {
      return { agents: [agentRecord(identity, "idle")] };
    },
    async agentSendKeys() {
      assert.fail("resume must never send exit keys");
    },
    async focusTab(args) {
      focusCalls.push(args);
    },
  };
  const createSessionTransport = (opts) => {
    built.push(opts);
    return createPiSessionTransport(opts);
  };

  const result = await resumeCommand({ runId: RUN_ID, confirmed: false }, { store, herdr, createSessionTransport });

  assert.equal(built.length, 1);
  assert.equal(built[0].herdr, herdr);
  assert.deepEqual(result, { command: "resume", runId: RUN_ID, action: "focused", identity });
  assert.deepEqual(focusCalls, [{ tabId: identity.tabId }]);
  assert.deepEqual(store.calls, [RUN_ID]);
  assert.deepEqual(store.updates, []);
});

test("resumeCommand reports needs-confirmation for a dead pi-session and relaunches only when confirmed", async () => {
  const identity = { kind: "pi-session", runId: RUN_ID, sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1", workspaceId: "w2", cwd: "/wt" };
  const deadHerdr = {
    async listAgents() {
      return { agents: [] };
    },
    async agentSendKeys() {
      assert.fail("resume must never send exit keys");
    },
  };

  const pendingStore = storeFor({ id: RUN_ID, transportIdentity: identity });
  const pending = await resumeCommand(
    { runId: RUN_ID, confirmed: false },
    { store: pendingStore, herdr: deadHerdr },
  );
  assert.deepEqual(pending, { command: "resume", runId: RUN_ID, action: "needs-confirmation", plan: "relaunch", identity });
  assert.deepEqual(pendingStore.updates, []);

  const tabCalls = [];
  const splitCalls = [];
  const startCalls = [];
  const relaunchHerdr = {
    ...deadHerdr,
    async createTab(args) {
      tabCalls.push(args);
      return { tabId: "w3:t1", paneId: "w3:p0" };
    },
    async splitPane(args) {
      splitCalls.push(args);
      return { paneId: "w3:p1" };
    },
    async startAgent(args) {
      startCalls.push(args);
      return { agentId: "agent-9", tabId: "w3:t1", paneId: "w3:p1" };
    },
  };
  const lookupExecutable = async (name) => {
    assert.equal(name, "pi");
    return "/usr/bin/pi";
  };

  // relaunch must reload the workflow env from the run the identity belongs to, so the
  // stored run needs the same fields runEnv()/buildHarnessLaunch() require in production.
  const relaunchRun = {
    id: RUN_ID,
    transportIdentity: identity,
    directory: RUN_DIRECTORY,
    generation: 2,
    stateRoot: RUN_STATE_ROOT,
    controlPlaneBin: RUN_CONTROL_PLANE_BIN,
  };
  const expectedEnv = {
    WORKFLOW_RUN_ID: RUN_ID,
    WORKFLOW_RUN_DIR: RUN_DIRECTORY,
    WORKFLOW_GENERATION: "2",
    WORKFLOW_HARNESS: "pi",
    WORKFLOW_STATE_ROOT: RUN_STATE_ROOT,
    WORKFLOW_CONTROL_PLANE_BIN: RUN_CONTROL_PLANE_BIN,
  };

  const relaunchStore = storeFor(relaunchRun);
  const relaunched = await resumeCommand(
    { runId: RUN_ID, confirmed: true },
    { store: relaunchStore, herdr: relaunchHerdr, lookupExecutable },
  );

  const newIdentity = { ...identity, paneId: "w3:p1", tabId: "w3:t1" };
  assert.equal(relaunched.action, "relaunched");
  assert.deepEqual(relaunched.identity, newIdentity);

  // A fresh tab is opened with no env (matching Herdr's createTab, which has no env param).
  assert.deepEqual(tabCalls, [{ workspaceId: identity.workspaceId, cwd: identity.cwd, label: "resume-s1", focus: true }]);

  // The WORKFLOW_* env is carried by the split pane under that tab — exactly like the
  // interactive launch (createTab -> splitPane({ env }) -> startAgent) in execute.js.
  assert.equal(splitCalls.length, 1);
  assert.equal(splitCalls[0].paneId, "w3:p0");
  assert.equal(splitCalls[0].cwd, identity.cwd);
  assert.deepEqual(splitCalls[0].env, expectedEnv);

  // argv must resume the exact session (--session-id, no --last/--continue) and reload both
  // workflow extensions, or the resumed pane's widget/telemetry/lifecycle wiring is dead.
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].paneId, "w3:p1");
  assert.equal(startCalls[0].kind, "pi");
  assert.equal(startCalls[0].timeout, 30000);
  assert.deepEqual(startCalls[0].argv, [
    "/usr/bin/pi",
    "--name",
    "resume-s1",
    "--session-id",
    "s1",
    "--extension",
    PI_WORKER_EXTENSIONS[0],
    "--extension",
    PI_WORKER_EXTENSIONS[1],
  ]);
  // No bootstrap prompt is appended — a resume continues the existing session rather than
  // starting a fresh assignment.
  assert.equal(startCalls[0].argv.some((value) => /assignment\.md|handoff-input\.json/.test(value)), false);

  // The confirmed relaunch must persist the new pane/tab identity — same sessionId, new
  // paneId/tabId — so the next resume observes the live pane instead of the dead one.
  assert.equal(relaunchStore.updates.length, 1);
  assert.equal(relaunchStore.updates[0].runId, RUN_ID);
  assert.deepEqual(relaunchStore.updates[0].patch, { transportIdentity: newIdentity });
  assert.equal(relaunchStore.updates[0].patch.transportIdentity.sessionId, identity.sessionId);
});

test("resumeCommand resolves its own run store from stateRoot (registry state_root, no injected store) and completes a confirmed relaunch", async (t) => {
  // Reproduces the CLI's registry-configured path: WORKFLOW_STATE_ROOT is unset, so
  // `deps.store` is never populated, and `state_root` reaches commands.js only as a plain
  // `stateRoot` value (mirroring projects.yaml's launcher.state_root, resolved upstream by
  // stateRootForCommand). `storeForCommand` then builds its own store via `createRunStore`.
  // No test above exercises this: every other case injects `deps.store` directly, which is
  // exactly what masks the bug -- relaunch's closure only breaks when it has to fall back to
  // storeForCommand's resolved store instead of a pre-supplied one.
  const root = await mkdtemp(join(tmpdir(), "workflow-resume-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");

  const identity = { kind: "pi-session", runId: RUN_ID, sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1", workspaceId: "w2", cwd: "/wt" };

  // Seed the run on disk through the real store, exactly as `workflow launch` would have.
  const seedStore = createRunStore({ stateRoot });
  await seedStore.create({
    runId: RUN_ID,
    transportIdentity: identity,
    generation: 2,
    stateRoot: RUN_STATE_ROOT,
    controlPlaneBin: RUN_CONTROL_PLANE_BIN,
  });

  const deadHerdr = {
    async listAgents() {
      return { agents: [] };
    },
    async agentSendKeys() {
      assert.fail("resume must never send exit keys");
    },
  };

  // No `store` in deps anywhere below -- only `stateRoot`, exactly as the CLI passes it when
  // the registry (not WORKFLOW_STATE_ROOT) supplies state_root.
  const pending = await resumeCommand({ runId: RUN_ID, confirmed: false }, { stateRoot, herdr: deadHerdr });
  assert.deepEqual(pending, { command: "resume", runId: RUN_ID, action: "needs-confirmation", plan: "relaunch", identity });

  const tabCalls = [];
  const splitCalls = [];
  const startCalls = [];
  const relaunchHerdr = {
    ...deadHerdr,
    async createTab(args) {
      tabCalls.push(args);
      return { tabId: "w3:t1", paneId: "w3:p0" };
    },
    async splitPane(args) {
      splitCalls.push(args);
      return { paneId: "w3:p1" };
    },
    async startAgent(args) {
      startCalls.push(args);
      return { agentId: "agent-9", tabId: "w3:t1", paneId: "w3:p1" };
    },
  };
  const lookupExecutable = async (name) => {
    assert.equal(name, "pi");
    return "/usr/bin/pi";
  };

  // The reproduction: a confirmed relaunch, still with no `deps.store`. Before the fix, the
  // relaunch closure closes over the raw `deps` (whose `.store` is undefined here) instead of
  // the store `storeForCommand` resolved a few lines above in resumeCommand, so
  // relaunchPiSession throws "requires a run store" even though resume just successfully read
  // the run through that very store.
  const relaunched = await resumeCommand(
    { runId: RUN_ID, confirmed: true },
    { stateRoot, herdr: relaunchHerdr, lookupExecutable },
  );

  const newIdentity = { ...identity, paneId: "w3:p1", tabId: "w3:t1" };
  assert.equal(relaunched.action, "relaunched");
  assert.deepEqual(relaunched.identity, newIdentity);
  assert.deepEqual(tabCalls, [{ workspaceId: identity.workspaceId, cwd: identity.cwd, label: "resume-s1", focus: true }]);

  // The env rebuilt for the relaunch pane must come from the run this resolved store read --
  // proof relaunchPiSession actually received a working store rather than failing preflight.
  const expectedEnv = {
    WORKFLOW_RUN_ID: RUN_ID,
    WORKFLOW_RUN_DIR: join(stateRoot, RUN_ID),
    WORKFLOW_GENERATION: "2",
    WORKFLOW_HARNESS: "pi",
    WORKFLOW_STATE_ROOT: RUN_STATE_ROOT,
    WORKFLOW_CONTROL_PLANE_BIN: RUN_CONTROL_PLANE_BIN,
  };
  assert.equal(splitCalls.length, 1);
  assert.deepEqual(splitCalls[0].env, expectedEnv);
  assert.equal(startCalls.length, 1);

  // The confirmed relaunch's persistence write must have landed through the resolved store:
  // verify it via a second, independent store instance pointed at the same stateRoot.
  const verifyStore = createRunStore({ stateRoot });
  const persisted = await verifyStore.read(RUN_ID);
  assert.deepEqual(persisted.transportIdentity, newIdentity);
});

test("resumeCommand surfaces the resume-category error for a run with no transport identity", async () => {
  const store = storeFor({ id: RUN_ID });
  const transport = transportFor({ state: "idle" });

  await assert.rejects(
    () => resumeCommand({ runId: RUN_ID }, { store, transport }),
    (error) => error instanceof WorkflowError && error.category === "resume",
  );
  assert.deepEqual(transport.calls, []);
  assert.deepEqual(store.calls, [RUN_ID]);
});

test("resumeCommand requires a worker transport when a pi-session identity has no Herdr adapter available", async () => {
  const store = storeFor({ id: RUN_ID, transportIdentity: transportIdentity() });

  await assert.rejects(
    () => resumeCommand({ runId: RUN_ID }, { store }),
    (error) => error instanceof WorkflowError
      && error.category === "PREFLIGHT"
      && error.exitCode === 10
      && /resume requires a worker transport/i.test(error.message),
  );
  assert.deepEqual(store.calls, [RUN_ID]);
});

test("closeCommand builds the pi-session transport from the live Herdr adapter and closes an idle worker", async () => {
  const identity = { kind: "pi-session", sessionId: "s1", paneId: "w2:p9", cwd: "/wt" };
  const store = storeFor({ id: RUN_ID, transportIdentity: identity });
  const sendKeysCalls = [];
  const herdr = {
    async listAgents() {
      return { agents: [agentRecord(identity, "idle")] };
    },
    async agentSendKeys(args) {
      sendKeysCalls.push(args);
    },
  };

  const result = await closeCommand({ runId: RUN_ID }, { store, herdr });

  assert.deepEqual(result, { command: "close", runId: RUN_ID, closed: true });
  assert.deepEqual(sendKeysCalls, [{ target: identity.paneId, keys: ["ctrl+d"] }]);
  assert.deepEqual(store.calls, [RUN_ID]);
  assert.deepEqual(store.updates, []);
});

test("closeCommand refuses an active pi-session worker with reason 'working' and never sends exit keys", async () => {
  const identity = { kind: "pi-session", sessionId: "s1", paneId: "w2:p9", cwd: "/wt" };
  const store = storeFor({ id: RUN_ID, transportIdentity: identity });
  const herdr = {
    async listAgents() {
      return { agents: [agentRecord(identity, "working")] };
    },
    async agentSendKeys() {
      assert.fail("close must never send exit keys to a working session");
    },
  };

  const result = await closeCommand({ runId: RUN_ID }, { store, herdr });

  assert.deepEqual(result, { command: "close", runId: RUN_ID, closed: false, reason: "working" });
  assert.deepEqual(store.updates, []);
});

test("closeCommand requires a worker transport when a pi-session identity has no Herdr adapter available", async () => {
  const store = storeFor({ id: RUN_ID, transportIdentity: transportIdentity() });

  await assert.rejects(
    () => closeCommand({ runId: RUN_ID }, { store }),
    (error) => error instanceof WorkflowError
      && error.category === "PREFLIGHT"
      && error.exitCode === 10
      && /close requires a worker transport/i.test(error.message),
  );
  assert.deepEqual(store.calls, [RUN_ID]);
});
