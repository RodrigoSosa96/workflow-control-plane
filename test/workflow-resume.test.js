import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planResume, executeResume, UNREPRODUCIBLE_ENVELOPE_REASON } from "../src/workflow/resume.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

const REAL_RUN_ID = "11111111-1111-4111-8111-111111111111";
// A reproducible envelope: fixtures below that exercise the "missing" -> relaunch path for
// concerns other than the agentProfile check itself (claim mechanics, identity persistence,
// focus/needs-confirmation semantics) carry this so they keep reaching "relaunch" rather than
// tripping the new refusal this file adds.
const VALID_AGENT_PROFILE = { harness: "pi", command: "pi", arguments: [] };
const MISSING_RUN_ID = "22222222-2222-4222-8222-222222222222";
// A structurally-valid worker transport; these integration tests exercise the real store's read
// path, so observeExact only runs when a real identity is present.
const inertTransport = {
  start() {}, deliverFollowUp() {}, requestGracefulClose() {},
  async observeExact(identity) { return { state: "idle", identity }; },
};

async function realStore(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-resume-store-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  return createRunStore({ stateRoot, randomUUID: () => REAL_RUN_ID });
}

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
  const run = { id: "r1", harness: "pi", transportIdentity: identity, agentProfile: VALID_AGENT_PROFILE };
  assert.equal((await planResume({ ...deps({ observation: { state: "idle", identity }, run }), runId: "r1" })).action, "focus");
  assert.equal((await planResume({ ...deps({ observation: { state: "missing", identity }, run }), runId: "r1" })).action, "relaunch");
  assert.equal((await planResume({ ...deps({ observation: { state: "mismatch", identity }, run }), runId: "r1" })).action, "refuse");
});

test("a run with no agentProfile refuses a relaunch, but a live session still resumes by focus", async () => {
  const identity = { kind: "pi-session", sessionId: "s1" };
  const run = { id: "r1", harness: "pi", transportIdentity: identity };

  const relaunchPlan = await planResume({ ...deps({ observation: { state: "missing", identity }, run }), runId: "r1" });
  assert.equal(relaunchPlan.action, "refuse");
  assert.equal(relaunchPlan.reason, UNREPRODUCIBLE_ENVELOPE_REASON);

  // The refusal must not leak into the live path: a run with no agentProfile at all still
  // focuses (never builds an argv) when its session is observed alive.
  const focusPlan = await planResume({ ...deps({ observation: { state: "active", identity }, run }), runId: "r1" });
  assert.equal(focusPlan.action, "focus");
});

test("a run with a malformed agentProfile refuses a relaunch the same way a missing one does", async () => {
  const identity = { kind: "pi-session", sessionId: "s1" };
  // No `command`: assertProfile rejects this shape, so it is not a reproducible envelope.
  const run = { id: "r1", harness: "claude", transportIdentity: identity, agentProfile: { harness: "claude" } };
  const plan = await planResume({ ...deps({ observation: { state: "missing", identity }, run }), runId: "r1" });
  assert.equal(plan.action, "refuse");
  assert.equal(plan.reason, UNREPRODUCIBLE_ENVELOPE_REASON);
});

test("a run with a valid agentProfile still relaunches when its session is missing", async () => {
  const identity = { kind: "pi-session", sessionId: "s1" };
  const run = {
    id: "r1",
    harness: "claude",
    transportIdentity: identity,
    agentProfile: { harness: "claude", command: "claude", arguments: [] },
  };
  const plan = await planResume({ ...deps({ observation: { state: "missing", identity }, run }), runId: "r1" });
  assert.equal(plan.action, "relaunch");
});

test("executeResume never creates Herdr state when the plan refuses an unreproducible envelope", async () => {
  const calls = [];
  // Mirrors relaunchSession's real Herdr surface (commands.js): if executeResume ever routed a
  // refused plan into relaunch, this relaunch stub would call createTab, and the test would
  // catch it. Refusing at plan time means this must never happen.
  const herdr = {
    async createTab(...args) { calls.push({ method: "createTab", args }); return { tabId: "t1" }; },
    async focusAgent(...args) { calls.push({ method: "focusAgent", args }); },
    async focusTab(...args) { calls.push({ method: "focusTab", args }); },
  };
  const identity = { kind: "pi-session", sessionId: "s1" };
  const run = { id: "r1", harness: "pi", transportIdentity: identity };
  const store = { async read() { return run; } };
  const transport = {
    start() {}, deliverFollowUp() {}, requestGracefulClose() {},
    async observeExact() { return { state: "missing", identity }; },
  };
  const relaunch = async () => {
    await herdr.createTab({});
    return { identity };
  };

  await assert.rejects(
    () => executeResume({ store, transport, herdr, runId: "r1", confirmed: true, relaunch }),
    (error) => error instanceof WorkflowError && error.message.includes(UNREPRODUCIBLE_ENVELOPE_REASON),
  );
  assert.equal(calls.filter((call) => call.method === "createTab").length, 0);
});

test("a run with no transportIdentity is refused with a resume-category WorkflowError", async () => {
  const run = { id: "r1", harness: "pi" };
  const promise = planResume({ ...deps({ observation: { state: "idle" }, run }), runId: "r1" });
  await assert.rejects(promise, (err) => err instanceof WorkflowError && err.category === "resume");
});

test("executeResume focuses the live agent pane and gates relaunch on confirmation", async () => {
  const focus = [];
  // Focus the agent's PANE (herdr agent focus), not just its tab: the launch retains a
  // bootstrap shell pane above Pi, so `tab focus` lands the cursor on the empty shell.
  const herdr = { async focusAgent(a) { focus.push(a); } };
  const liveTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "idle", identity: { paneId: "w2:p9" } }; } };
  const store = { async read() { return { id: "r1", transportIdentity: { kind: "pi-session", tabId: "w2:t1", paneId: "w2:p9", sessionId: "s1" }, agentProfile: VALID_AGENT_PROFILE }; } };
  let relaunchCalls = 0;
  const relaunch = async () => { relaunchCalls += 1; return { identity: { sessionId: "s1" } }; };

  const focused = await executeResume({ store, transport: liveTransport, herdr, runId: "r1", confirmed: false, relaunch });
  assert.equal(focused.action, "focused");
  assert.equal(focus.length, 1);
  assert.deepEqual(focus[0], { target: "w2:p9" });

  const deadTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "missing", identity: {} }; } };
  const pending = await executeResume({ store, transport: deadTransport, herdr, runId: "r1", confirmed: false, relaunch });
  assert.equal(pending.action, "needs-confirmation");
  assert.equal(relaunchCalls, 0);
  const done = await executeResume({ store, transport: deadTransport, herdr, runId: "r1", confirmed: true, relaunch });
  assert.equal(done.action, "relaunched");
  assert.equal(relaunchCalls, 1);
});

test("executeResume persists the new identity after a confirmed relaunch, but never on focus or needs-confirmation", async () => {
  const updateCalls = [];
  const oldIdentity = { kind: "pi-session", sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1" };
  const newIdentity = { kind: "pi-session", sessionId: "s1", paneId: "w3:p1", tabId: "w3:t1" };
  const store = {
    async read() { return { id: "r1", transportIdentity: oldIdentity, agentProfile: VALID_AGENT_PROFILE }; },
    async update(runId, updater) {
      updateCalls.push({ runId, patch: await updater({ id: "r1", transportIdentity: oldIdentity, agentProfile: VALID_AGENT_PROFILE }) });
    },
  };
  const herdr = { async focusAgent() {} };

  // Focus path (live session): must not persist.
  const liveTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "idle", identity: oldIdentity }; } };
  const focused = await executeResume({ store, transport: liveTransport, herdr, runId: "r1", confirmed: false, relaunch: async () => { throw new Error("must not relaunch"); } });
  assert.equal(focused.action, "focused");
  assert.deepEqual(updateCalls, []);

  // Needs-confirmation path (dead session, not confirmed): must not persist.
  const deadTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "missing", identity: oldIdentity }; } };
  const pending = await executeResume({ store, transport: deadTransport, herdr, runId: "r1", confirmed: false, relaunch: async () => { throw new Error("must not relaunch"); } });
  assert.equal(pending.action, "needs-confirmation");
  assert.deepEqual(updateCalls, []);

  // Confirmed relaunch: first claims the relaunch under the run lock, then
  // persists the new identity (new paneId/tabId, same sessionId) and clears the claim.
  const relaunch = async () => ({ identity: newIdentity });
  const relaunched = await executeResume({ store, transport: deadTransport, herdr, runId: "r1", confirmed: true, relaunch });
  assert.equal(relaunched.action, "relaunched");
  assert.deepEqual(relaunched.identity, newIdentity);
  assert.equal(updateCalls.length, 2);
  assert.equal(updateCalls[0].runId, "r1");
  assert.equal(typeof updateCalls[0].patch.resumeClaim?.claimedAt, "string");
  assert.deepEqual(updateCalls[1].patch, { transportIdentity: newIdentity, resumeClaim: null });
  assert.equal(updateCalls[1].patch.transportIdentity.sessionId, oldIdentity.sessionId);
  assert.notEqual(updateCalls[1].patch.transportIdentity.paneId, oldIdentity.paneId);
});

function claimStore({ identity, resumeClaim = null, agentProfile = VALID_AGENT_PROFILE }) {
  const state = { id: "r1", transportIdentity: identity, resumeClaim, agentProfile };
  const updateCalls = [];
  return {
    updateCalls,
    async read() { return structuredClone(state); },
    async update(runId, updater) {
      const patch = await updater(structuredClone(state));
      Object.assign(state, patch);
      updateCalls.push({ runId, patch });
      return structuredClone(state);
    },
  };
}

test("a concurrent resume that already claimed the relaunch is refused", async () => {
  const identity = { kind: "pi-session", sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1" };
  const deadTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "missing", identity }; } };
  const store = claimStore({ identity, resumeClaim: { claimedAt: new Date().toISOString() } });
  let relaunchCalls = 0;
  await assert.rejects(
    () => executeResume({ store, transport: deadTransport, runId: "r1", confirmed: true, relaunch: async () => { relaunchCalls += 1; } }),
    (error) => error instanceof WorkflowError && /already claimed/i.test(error.message),
  );
  assert.equal(relaunchCalls, 0);
});

test("a stale resume claim (crash residue) does not block a new confirmed resume", async () => {
  const identity = { kind: "pi-session", sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1" };
  const deadTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "missing", identity }; } };
  const staleClaim = { claimedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() };
  const store = claimStore({ identity, resumeClaim: staleClaim });
  const done = await executeResume({ store, transport: deadTransport, runId: "r1", confirmed: true, relaunch: async () => ({ identity }) });
  assert.equal(done.action, "relaunched");
});

test("a resume whose identity moved since planning is refused before relaunching", async () => {
  const planned = { kind: "pi-session", sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1" };
  const moved = { ...planned, paneId: "w9:p1" };
  const deadTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "missing", identity: planned }; } };
  // The store's current identity changed (another resume relaunched) between
  // this resume's planning read and its claim.
  const store = claimStore({ identity: moved });
  store.read = async () => ({ id: "r1", transportIdentity: planned, agentProfile: VALID_AGENT_PROFILE });
  let relaunchCalls = 0;
  await assert.rejects(
    () => executeResume({ store, transport: deadTransport, runId: "r1", confirmed: true, relaunch: async () => { relaunchCalls += 1; } }),
    (error) => error instanceof WorkflowError && /identity changed/i.test(error.message),
  );
  assert.equal(relaunchCalls, 0);
});

test("a failed relaunch clears the resume claim so a retry is not blocked", async () => {
  const identity = { kind: "pi-session", sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1" };
  const deadTransport = { start(){}, deliverFollowUp(){}, requestGracefulClose(){}, async observeExact() { return { state: "missing", identity }; } };
  const store = claimStore({ identity });
  await assert.rejects(
    () => executeResume({ store, transport: deadTransport, runId: "r1", confirmed: true, relaunch: async () => { throw new Error("herdr unavailable"); } }),
    /herdr unavailable/,
  );
  assert.equal(store.updateCalls.at(-1).patch.resumeClaim, null);
  // The claim was released: a second confirmed resume succeeds.
  const done = await executeResume({ store, transport: deadTransport, runId: "r1", confirmed: true, relaunch: async () => ({ identity }) });
  assert.equal(done.action, "relaunched");
});

// Integration: the tests above use a fake store; these ride the REAL run-store read path so its
// actual record shape (no transportIdentity on a fresh run) and its real not-found error reach
// planResume, not a hand-shaped fake.
test("planResume refuses a real run that has no transport identity", async (t) => {
  const store = await realStore(t);
  await store.create({ projectAlias: "ocr", primaryTicket: "A-1", relatedTickets: [], state: RUN_STATES.PLANNED });
  await assert.rejects(
    () => planResume({ store, transport: inertTransport, runId: REAL_RUN_ID }),
    (error) => error instanceof WorkflowError && error.category === "resume" && /session identity/i.test(error.message),
  );
});

test("planResume propagates the real store's not-found error for a missing run", async (t) => {
  const store = await realStore(t);
  await assert.rejects(
    () => planResume({ store, transport: inertTransport, runId: MISSING_RUN_ID }),
    (error) => error instanceof WorkflowError && /not found/i.test(error.message),
  );
});
