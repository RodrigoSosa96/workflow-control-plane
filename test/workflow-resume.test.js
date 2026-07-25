import assert from "node:assert/strict";
import { test } from "node:test";
import { planResume, executeResume } from "../src/workflow/resume.js";
import { WorkflowError } from "../src/workflow/errors.js";

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
  const store = { async read() { return { id: "r1", transportIdentity: { kind: "pi-session", tabId: "w2:t1", paneId: "w2:p9", sessionId: "s1" } }; } };
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
    async read() { return { id: "r1", transportIdentity: oldIdentity }; },
    async update(runId, updater) {
      updateCalls.push({ runId, patch: await updater({ id: "r1", transportIdentity: oldIdentity }) });
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

  // Confirmed relaunch: must persist the new identity (new paneId/tabId, same sessionId).
  const relaunch = async () => ({ identity: newIdentity });
  const relaunched = await executeResume({ store, transport: deadTransport, herdr, runId: "r1", confirmed: true, relaunch });
  assert.equal(relaunched.action, "relaunched");
  assert.deepEqual(relaunched.identity, newIdentity);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].runId, "r1");
  assert.deepEqual(updateCalls[0].patch, { transportIdentity: newIdentity });
  assert.equal(updateCalls[0].patch.transportIdentity.sessionId, oldIdentity.sessionId);
  assert.notEqual(updateCalls[0].patch.transportIdentity.paneId, oldIdentity.paneId);
});
