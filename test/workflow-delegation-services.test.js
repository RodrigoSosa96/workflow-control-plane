import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPreparedDelegationRequest, validateSubagentRequestPolicy } from "../src/workflow/coordinator-policy.js";
import { createDelegationReservationStore } from "../src/workflow/delegation-reservations.js";
import { createDelegationServices } from "../src/workflow/delegation-services.js";
import { createDelegationStore } from "../src/workflow/delegation-store.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";
import { createFakeWorkerTransport } from "../src/workflow/worker-transport.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const RESERVATION_ID = "33333333-3333-4333-8333-333333333333";
const RESERVATION_OWNER = "44444444-4444-4444-8444-444444444444";
const PROJECT_ALIAS = "fixture";
const CWD = "/fixture/review";
const TASK = "Review only the frozen task.";
const BRIEF = "Review only the frozen task. Keep all findings inside scope.";

const policy = {
  version: 1,
  totalInternal: 4,
  foreground: 3,
  readOnlyBackground: 3,
  writersTotal: 1,
  writersPerCheckout: 1,
  maxDepth: 1,
  remediationTurns: 2,
  allowBackgroundWriters: false,
};

const registry = {
  launcher: { delegation: policy },
  projects: {
    [PROJECT_ALIAS]: {
      label: "Fixture Project",
      path: CWD,
      delegation: {
        remediationTurns: 2,
      },
    },
  },
};

const reviewInput = Object.freeze({
  role: "code-reviewer",
  mode: "background",
  originSessionId: "pi-origin-1",
  cwd: CWD,
  brief: BRIEF,
  task: TASK,
  budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
  remediationTurns: 2,
});

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-delegation-services-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function completedResult(generation, summary = "Review completed") {
  return {
    status: "completed",
    generation,
    summary,
    verification: [{ command: "git diff --check", status: "passed" }],
    concerns: [],
    nextAction: "Return findings to the coordinator",
  };
}

function transportIdentity(runId, delegationId) {
  return {
    kind: "pi-delegation",
    runId,
    delegationId,
    sessionPath: `/private/${delegationId}.jsonl`,
    cwd: CWD,
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  };
}

function nextTransportIdentity(runId, delegationId, overrides = {}) {
  return {
    ...transportIdentity(runId, delegationId),
    pid: "67890",
    processStartedAt: "2025-01-01T00:20:00.000Z",
    ...overrides,
  };
}

function createTransport({ startImpl, deliverFollowUpImpl, observations = [] } = {}) {
  const base = createFakeWorkerTransport({ observations });
  const calls = [];

  return {
    async start(assignment) {
      calls.push({ method: "start", assignment: structuredClone(assignment) });
      return await (startImpl ? startImpl(assignment) : { identity: assignment.identity });
    },
    async observeExact(identity) {
      return await base.observeExact(identity);
    },
    async deliverFollowUp(identity, prompt) {
      if (deliverFollowUpImpl) {
        calls.push({ method: "deliverFollowUp", identity: structuredClone(identity) });
        return await deliverFollowUpImpl(identity, prompt);
      }
      return await base.deliverFollowUp(identity, prompt);
    },
    async requestGracefulClose(identity) {
      return await base.requestGracefulClose(identity);
    },
    get calls() {
      return Object.freeze([...calls.map((call) => structuredClone(call)), ...base.calls]);
    },
  };
}

async function createFixture(t, { transport } = {}) {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID });
  const run = await store.create({ projectAlias: PROJECT_ALIAS, primaryTicket: "A-1", state: RUN_STATES.PLANNED });
  const delegations = createDelegationStore({
    store,
    randomUUID: uuidSequence(DELEGATION_ID),
  });
  const reservations = createDelegationReservationStore({
    stateRoot,
    randomUUID: uuidSequence(RESERVATION_ID, RESERVATION_OWNER),
    canonicalPath: async (value) => value,
  });
  const effectiveTransport = transport ?? createTransport({
    startImpl: async () => ({ identity: transportIdentity(RUN_ID, DELEGATION_ID) }),
    observations: [{ state: "idle", identity: transportIdentity(RUN_ID, DELEGATION_ID) }],
  });
  const services = createDelegationServices({
    registry,
    projectAlias: PROJECT_ALIAS,
    runStore: store,
    delegations,
    reservations,
    transport: effectiveTransport,
    roles: {
      async loadDelegationRole({ name }) {
        return Object.freeze({
          name,
          tools: ["read", "bash", "grep", "find", "ls"],
          systemPrompt: "Review only the frozen brief.",
        });
      },
    },
  });

  return { stateRoot, store, run, delegations, reservations, services, transport: effectiveTransport };
}

async function createCompletedDelegation(t, { transport } = {}) {
  const fixture = await createFixture(t, { transport });
  const preview = await fixture.services.createPreview({ runId: fixture.run.id, input: reviewInput });
  await fixture.services.executeApproved({ preview, approvalDigest: preview.approvalDigest });
  await fixture.delegations.recordResult({ runId: fixture.run.id, delegationId: DELEGATION_ID, result: completedResult(1) });
  return fixture;
}

test("preview freezes role, cwd, budgets, and task digest without mutation", async (t) => {
  const { services, store, run } = await createFixture(t);

  const preview = await services.createPreview({ runId: run.id, input: reviewInput });

  assert.match(preview.approvalDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(preview.role, "code-reviewer");
  assert.equal(preview.mode, "background");
  assert.equal(preview.cwd, CWD);
  assert.deepEqual(preview.budget, reviewInput.budget);
  assert.match(preview.taskDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.budget), true);
  assert.equal(Object.isFrozen(preview.tools), true);
  assert.equal((await store.read(run.id)).delegations, undefined);
});

test("execute rejects changed approval data before store, reservation, or transport mutation", async (t) => {
  const transport = createTransport({
    startImpl: async () => ({ identity: transportIdentity(RUN_ID, DELEGATION_ID) }),
  });
  const { services, store, run, reservations } = await createFixture(t, { transport });
  const preview = await services.createPreview({ runId: run.id, input: reviewInput });
  const changed = { ...structuredClone(preview), mode: "foreground" };

  await assert.rejects(
    () => services.executeApproved({ preview: changed, approvalDigest: preview.approvalDigest }),
    /approval digest|stale/i,
  );

  assert.equal((await store.read(run.id)).delegations, undefined);
  assert.deepEqual(await reservations.list({ projectAlias: PROJECT_ALIAS }), []);
  assert.deepEqual(transport.calls, []);
});

test("execute consumes one prepared request and records the returned exact identity", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async (assignment) => {
      const accepted = validateSubagentRequestPolicy({
        request: assignment.request,
        prepared: assignment.prepared,
        policy,
        reservation: assignment.reservation,
      });
      assert.deepEqual(accepted, {
        allowed: true,
        fingerprint: assignment.prepared.requestFingerprint,
      });
      assert.deepEqual(
        assignment.prepared,
        createPreparedDelegationRequest({ delegation: assignment.delegation, policy }),
      );
      assert.equal(assignment.request.task, TASK);
      return { identity: expectedIdentity };
    },
    observations: [{ state: "idle", identity: expectedIdentity }],
  });
  const { services, store, run } = await createFixture(t, { transport });
  const preview = await services.createPreview({ runId: run.id, input: reviewInput });

  const executed = await services.executeApproved({ preview, approvalDigest: preview.approvalDigest });

  assert.equal(executed.state, "running");
  assert.equal(executed.generation, 1);
  assert.deepEqual(executed.identity, expectedIdentity);
  assert.deepEqual((await store.read(run.id)).delegations[DELEGATION_ID].transportIdentity, expectedIdentity);
  await assert.rejects(
    () => services.executeApproved({ preview, approvalDigest: preview.approvalDigest }),
    /consumed|approved|preview/i,
  );
});

test("execute rejects a changed task without echoing it", async (t) => {
  const { services, run } = await createFixture(t);
  const preview = await services.createPreview({ runId: run.id, input: reviewInput });
  const changed = structuredClone(preview);
  changed.task = "SECRET-INVALID-DIRECT-TASK";

  await assert.rejects(
    () => services.executeApproved({ preview: changed, approvalDigest: preview.approvalDigest }),
    (error) => {
      assert.match(error.message, /approval digest|stale|task/i);
      assert.doesNotMatch(error.message, /SECRET-INVALID-DIRECT-TASK/);
      return true;
    },
  );
});

test("execute retains a reservation and records start failure when transport start throws", async (t) => {
  const transport = createTransport({
    startImpl: async () => {
      throw new Error("SECRET-TRANSPORT-FAILURE");
    },
  });
  const { services, store, run, reservations } = await createFixture(t, { transport });
  const preview = await services.createPreview({ runId: run.id, input: reviewInput });

  const result = await services.executeApproved({ preview, approvalDigest: preview.approvalDigest });
  const record = (await store.read(run.id)).delegations[DELEGATION_ID];
  const activeReservations = await reservations.list({ projectAlias: PROJECT_ALIAS });

  assert.equal(result.state, "failed");
  assert.match(result.nextActions.join(" "), /manual-release/i);
  assert.equal(record.state, "failed");
  assert.equal(record.startFailure.reason, "Delegation transport start failed");
  assert.equal(activeReservations.length, 1);
  assert.equal(activeReservations[0].state, "active");
  assert.doesNotMatch(JSON.stringify(result), /SECRET-TRANSPORT-FAILURE/);
});

test("reconcile returns bounded state and withholds automatic remediation after missing observations", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    observations: [{ state: "missing", identity: expectedIdentity }],
  });
  const { services, delegations, run } = await createFixture(t, { transport });
  const preview = await services.createPreview({ runId: run.id, input: reviewInput });
  await services.executeApproved({ preview, approvalDigest: preview.approvalDigest });
  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedResult(1) });

  const reconciled = await services.reconcile({ runId: run.id, delegationId: DELEGATION_ID });

  assert.deepEqual(Object.keys(reconciled).sort(), ["generation", "identity", "nextActions", "observation", "resultStatus", "state"]);
  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.resultStatus, "completed");
  assert.deepEqual(reconciled.identity, expectedIdentity);
  assert.equal(reconciled.observation.state, "missing");
  assert.match(reconciled.nextActions.join(" "), /manual|deliver/i);
  assert.doesNotMatch(JSON.stringify(reconciled), /summary|verification|concerns|terminal|stdout|stderr/i);
});

test("beginRemediation rejects missing observations before incrementing generation or delivering follow-up", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    observations: [{ state: "missing", identity: expectedIdentity }],
  });
  const { services, store, run } = await createCompletedDelegation(t, { transport });

  await assert.rejects(
    () => services.beginRemediation({
      runId: run.id,
      delegationId: DELEGATION_ID,
      expectedGeneration: 1,
      reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
      prompt: "Address the approved correction.",
    }),
    /observe|observation|missing|remediation/i,
  );

  assert.equal((await store.read(run.id)).delegations[DELEGATION_ID].generation, 1);
  assert.equal(transport.calls.filter((call) => call.method === "deliverFollowUp").length, 0);
});

test("beginRemediation rejects mismatched observations before incrementing generation or delivering follow-up", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    observations: [{
      state: "mismatch",
      identity: { ...expectedIdentity, pid: "99999", processStartedAt: "2025-01-01T00:20:00.000Z" },
    }],
  });
  const { services, store, run } = await createCompletedDelegation(t, { transport });

  await assert.rejects(
    () => services.beginRemediation({
      runId: run.id,
      delegationId: DELEGATION_ID,
      expectedGeneration: 1,
      reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
      prompt: "Address the approved correction.",
    }),
    /observe|observation|mismatch|remediation/i,
  );

  assert.equal((await store.read(run.id)).delegations[DELEGATION_ID].generation, 1);
  assert.equal(transport.calls.filter((call) => call.method === "deliverFollowUp").length, 0);
});

test("beginRemediation rejects unsafe active observations before incrementing generation or delivering follow-up", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    observations: [{ state: "active", identity: expectedIdentity }],
  });
  const { services, store, run } = await createCompletedDelegation(t, { transport });

  await assert.rejects(
    () => services.beginRemediation({
      runId: run.id,
      delegationId: DELEGATION_ID,
      expectedGeneration: 1,
      reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
      prompt: "Address the approved correction.",
    }),
    /observe|observation|active|idle|remediation/i,
  );

  assert.equal((await store.read(run.id)).delegations[DELEGATION_ID].generation, 1);
  assert.equal(transport.calls.filter((call) => call.method === "deliverFollowUp").length, 0);
});

test("beginRemediation persists replacement identities and later observation/remediation uses them", async (t) => {
  const firstIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const secondIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID);
  const thirdIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID, {
    pid: "99999",
    processStartedAt: "2025-01-01T00:30:00.000Z",
  });
  const transport = createTransport({
    startImpl: async () => ({ identity: firstIdentity }),
    deliverFollowUpImpl: async (identity) => ({
      delivered: true,
      identity: identity.pid === firstIdentity.pid ? secondIdentity : thirdIdentity,
    }),
    observations: [
      { state: "idle", identity: firstIdentity },
      { state: "idle", identity: secondIdentity },
      { state: "idle", identity: secondIdentity },
    ],
  });
  const { services, delegations, store, run } = await createCompletedDelegation(t, { transport });

  const first = await services.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
    prompt: "Address the approved correction.",
  });
  assert.equal(first.state, "running");
  assert.equal(first.generation, 2);
  assert.deepEqual(first.identity, secondIdentity);
  assert.deepEqual((await store.read(run.id)).delegations[DELEGATION_ID].transportIdentity, secondIdentity);

  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedResult(2, "First remediation done") });
  const reconciled = await services.reconcile({ runId: run.id, delegationId: DELEGATION_ID });
  assert.deepEqual(reconciled.identity, secondIdentity);

  const second = await services.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 2,
    reviewEvidence: { generation: 2, summary: "Second bounded defect", insideFrozenBrief: true },
    prompt: "Address the second approved correction.",
  });
  assert.equal(second.generation, 3);
  assert.deepEqual(second.identity, thirdIdentity);
  assert.deepEqual((await store.read(run.id)).delegations[DELEGATION_ID].transportIdentity, thirdIdentity);

  assert.deepEqual(
    transport.calls.filter((call) => call.method === "observeExact").map((call) => call.identity),
    [firstIdentity, secondIdentity, secondIdentity],
  );
  assert.deepEqual(
    transport.calls.filter((call) => call.method === "deliverFollowUp").map((call) => call.identity),
    [firstIdentity, secondIdentity],
  );
});

test("beginRemediation permits only two turns with matching review evidence and identity", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const secondIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID);
  const thirdIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID, {
    pid: "99999",
    processStartedAt: "2025-01-01T00:30:00.000Z",
  });
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    deliverFollowUpImpl: async (identity) => ({
      delivered: true,
      identity: identity.pid === expectedIdentity.pid ? secondIdentity : thirdIdentity,
    }),
    observations: [
      { state: "idle", identity: expectedIdentity },
      { state: "idle", identity: secondIdentity },
      { state: "idle", identity: thirdIdentity },
    ],
  });
  const { services, delegations, run } = await createCompletedDelegation(t, { transport });

  const first = await services.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
    prompt: "Address the approved correction.",
  });
  assert.equal(first.state, "running");
  assert.equal(first.generation, 2);

  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedResult(2, "First remediation done") });
  const second = await services.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 2,
    reviewEvidence: { generation: 2, summary: "Second bounded defect", insideFrozenBrief: true },
    prompt: "Address the second approved correction.",
  });
  assert.equal(second.generation, 3);

  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedResult(3, "Second remediation done") });
  await assert.rejects(
    () => services.beginRemediation({
      runId: run.id,
      delegationId: DELEGATION_ID,
      expectedGeneration: 3,
      reviewEvidence: { generation: 3, summary: "Still inside the frozen brief", insideFrozenBrief: true },
      prompt: "SECRET-REMEDIATION-PROMPT",
    }),
    (error) => {
      assert.match(error.message, /limit|remediation/i);
      assert.doesNotMatch(error.message, /SECRET-REMEDIATION-PROMPT/);
      return true;
    },
  );
});

test("beginRemediation preserves the incremented generation when follow-up delivery fails", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    deliverFollowUpImpl: async () => {
      throw new Error("SECRET-DELIVERY-FAILURE");
    },
    observations: [{ state: "idle", identity: expectedIdentity }],
  });
  const { services, delegations, store, run } = await createFixture(t, { transport });
  const preview = await services.createPreview({ runId: run.id, input: reviewInput });
  await services.executeApproved({ preview, approvalDigest: preview.approvalDigest });
  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedResult(1) });

  const result = await services.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
    prompt: "SECRET-FOLLOW-UP-PROMPT",
  });

  assert.equal(result.state, "running");
  assert.equal(result.generation, 2);
  assert.match(result.nextActions.join(" "), /manual/i);
  assert.equal((await store.read(run.id)).delegations[DELEGATION_ID].generation, 2);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-DELIVERY-FAILURE|SECRET-FOLLOW-UP-PROMPT/);
});
