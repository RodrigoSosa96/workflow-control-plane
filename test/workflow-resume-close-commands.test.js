import assert from "node:assert/strict";
import { test } from "node:test";
import { closeCommand, resumeCommand } from "../src/workflow/commands.js";
import { createPiSessionTransport } from "../src/workflow/pi-session-transport.js";
import { WorkflowError } from "../src/workflow/errors.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

// run.transportIdentity is only ever absent or `kind: "pi-session"` (delegation identities
// live under run.delegations[id], never on the top-level run) — see commands.js.
function transportIdentity() {
  return { kind: "pi-session", sessionId: "s1" };
}

function storeFor(run) {
  const calls = [];
  return {
    calls,
    async read(runId) {
      calls.push(runId);
      return structuredClone(run);
    },
    async update() {
      assert.fail("resume/close commands must stay read-only");
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

  const pending = await resumeCommand(
    { runId: RUN_ID, confirmed: false },
    { store: storeFor({ id: RUN_ID, transportIdentity: identity }), herdr: deadHerdr },
  );
  assert.deepEqual(pending, { command: "resume", runId: RUN_ID, action: "needs-confirmation", plan: "relaunch", identity });

  const tabCalls = [];
  const startCalls = [];
  const relaunchHerdr = {
    ...deadHerdr,
    async createTab(args) {
      tabCalls.push(args);
      return { tabId: "w3:t1", paneId: "w3:p1" };
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

  const relaunched = await resumeCommand(
    { runId: RUN_ID, confirmed: true },
    { store: storeFor({ id: RUN_ID, transportIdentity: identity }), herdr: relaunchHerdr, lookupExecutable },
  );

  assert.equal(relaunched.action, "relaunched");
  assert.deepEqual(relaunched.identity, { ...identity, paneId: "w3:p1", tabId: "w3:t1" });
  assert.deepEqual(tabCalls, [{ workspaceId: identity.workspaceId, cwd: identity.cwd, label: "resume-s1", focus: true }]);
  assert.deepEqual(startCalls, [{ name: "resume-s1", paneId: "w3:p1", kind: "pi", argv: ["/usr/bin/pi", "--session-id", "s1"], timeout: 30000 }]);
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
