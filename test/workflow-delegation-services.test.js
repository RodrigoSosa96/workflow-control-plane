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
const PROJECT_PATH = "/fixture/shared";
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
      path: PROJECT_PATH,
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
    async deliverFollowUp(identity, prompt, resume) {
      if (deliverFollowUpImpl) {
        calls.push({ method: "deliverFollowUp", identity: structuredClone(identity), resume: structuredClone(resume) });
        return await deliverFollowUpImpl(identity, prompt, resume);
      }
      return await base.deliverFollowUp(identity, prompt, resume);
    },
    async requestGracefulClose(identity) {
      return await base.requestGracefulClose(identity);
    },
    get calls() {
      return Object.freeze([...calls.map((call) => structuredClone(call)), ...base.calls]);
    },
  };
}

async function createFixture(t, { transport, repositories = [{ id: "repository", path: CWD, branch: "main" }] } = {}) {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID });
  const run = await store.create({
    projectAlias: PROJECT_ALIAS,
    primaryTicket: "A-1",
    state: RUN_STATES.PLANNED,
    repositories,
  });
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

test("preview binds delegation cwd to the parent run checkout and rejects the shared project path", async (t) => {
  const { services, run } = await createFixture(t);

  const preview = await services.createPreview({ runId: run.id, input: reviewInput });
  assert.equal(preview.cwd, CWD);

  await assert.rejects(
    () => services.createPreview({
      runId: run.id,
      input: {
        ...reviewInput,
        cwd: PROJECT_PATH,
      },
    }),
    /checkout|registered|run|cwd/i,
  );
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

test("reconcile returns bounded state and allows remediation only after the exact process is proven gone", async (t) => {
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
  assert.deepEqual(reconciled.nextActions, ["deliver-result", "begin-remediation"]);
  assert.doesNotMatch(JSON.stringify(reconciled), /summary|verification|concerns|terminal|stdout|stderr/i);
});

test("reconcile does not suggest delivery after a current terminal result was consumed or adopted", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    observations: [{ state: "idle", identity: expectedIdentity }],
  });
  const { services, delegations, run } = await createFixture(t, { transport });
  const preview = await services.createPreview({ runId: run.id, input: reviewInput });
  await services.executeApproved({ preview, approvalDigest: preview.approvalDigest });
  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedResult(1) });

  await delegations.adoptResult({ runId: run.id, delegationId: DELEGATION_ID, originSessionId: "pi-later-session" });
  const reconciled = await services.reconcile({ runId: run.id, delegationId: DELEGATION_ID });

  assert.equal(reconciled.resultStatus, "completed");
  assert.equal(reconciled.nextActions.includes("deliver-result"), false);
  assert.equal(reconciled.nextActions.includes("review-result"), true);
});

test("beginRemediation allows follow-up only after the exact prior process is proven gone", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const nextIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    deliverFollowUpImpl: async () => ({ delivered: true, identity: nextIdentity }),
    observations: [{ state: "missing", identity: expectedIdentity }],
  });
  const { services, store, run } = await createCompletedDelegation(t, { transport });

  const remediated = await services.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
    prompt: "Address the approved correction.",
  });

  assert.equal(remediated.state, "running");
  assert.equal(remediated.generation, 2);
  assert.deepEqual(remediated.identity, nextIdentity);
  const persisted = (await store.read(run.id)).delegations[DELEGATION_ID];
  assert.equal(persisted.generation, 2);
  assert.equal(persisted.remediation?.state, "active");
  assert.match(persisted.remediation?.claimToken ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(transport.calls.filter((call) => call.method === "deliverFollowUp").length, 1);
});

test("beginRemediation races claim atomically so only one follow-up child launches", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const nextIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID);
  let releaseLaunch;
  const launchGate = new Promise((resolve) => {
    releaseLaunch = resolve;
  });
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    deliverFollowUpImpl: async () => {
      await launchGate;
      return { delivered: true, identity: nextIdentity };
    },
    observations: [
      { state: "missing", identity: expectedIdentity },
      { state: "missing", identity: expectedIdentity },
    ],
  });
  const { services, run } = await createCompletedDelegation(t, { transport });
  const request = {
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
    prompt: "Address the approved correction.",
  };

  const first = services.beginRemediation(request);
  await new Promise((resolve) => setImmediate(resolve));
  const second = services.beginRemediation(request);
  releaseLaunch();

  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  assert.match(settled.find((entry) => entry.status === "rejected").reason.message, /claimed|launch|stale|remediation|locked|active lock/i);
  assert.equal(transport.calls.filter((call) => call.method === "deliverFollowUp").length, 1);
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

test("beginRemediation succeeds after rebuilding the transport from persisted private state", async (t) => {
  const firstIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const secondIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID);
  const fixture = await createCompletedDelegation(t, {
    transport: createTransport({
      startImpl: async () => ({ identity: firstIdentity }),
    }),
  });

  const freshTransport = createTransport({
    deliverFollowUpImpl: async (_identity, _prompt, resume) => {
      assert.equal(resume.runId, RUN_ID);
      assert.equal(resume.delegationId, DELEGATION_ID);
      assert.equal(resume.role, "code-reviewer");
      assert.equal(resume.mode, "background");
      assert.equal(resume.cwd, CWD);
      assert.equal(resume.generation, 2);
      assert.match(resume.claimToken, /^[0-9a-f-]{36}$/i);
      return {
        delivered: true,
        identity: secondIdentity,
      };
    },
    observations: [{ state: "missing", identity: firstIdentity }],
  });
  const freshServices = createDelegationServices({
    registry,
    projectAlias: PROJECT_ALIAS,
    runStore: fixture.store,
    delegations: fixture.delegations,
    reservations: fixture.reservations,
    transport: freshTransport,
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

  const remediated = await freshServices.beginRemediation({
    runId: fixture.run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
    prompt: "Address the approved correction.",
  });

  assert.equal(remediated.state, "running");
  assert.equal(remediated.generation, 2);
  assert.deepEqual(remediated.identity, secondIdentity);
  assert.deepEqual((await fixture.store.read(fixture.run.id)).delegations[DELEGATION_ID].transportIdentity, secondIdentity);
  assert.deepEqual(freshTransport.calls.filter((call) => call.method === "start"), []);
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
      { state: "missing", identity: firstIdentity },
      { state: "missing", identity: secondIdentity },
      { state: "missing", identity: secondIdentity },
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

  await delegations.recordResult({
    runId: run.id,
    delegationId: DELEGATION_ID,
    result: completedResult(2, "First remediation done"),
    claimToken: (await store.read(run.id)).delegations[DELEGATION_ID].remediation.claimToken,
  });
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
      { state: "missing", identity: expectedIdentity },
      { state: "missing", identity: secondIdentity },
      { state: "missing", identity: thirdIdentity },
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

  await delegations.recordResult({
    runId: run.id,
    delegationId: DELEGATION_ID,
    result: completedResult(2, "First remediation done"),
    claimToken: (await store.read(run.id)).delegations[DELEGATION_ID].remediation.claimToken,
  });
  const second = await services.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 2,
    reviewEvidence: { generation: 2, summary: "Second bounded defect", insideFrozenBrief: true },
    prompt: "Address the second approved correction.",
  });
  assert.equal(second.generation, 3);

  await delegations.recordResult({
    runId: run.id,
    delegationId: DELEGATION_ID,
    result: completedResult(3, "Second remediation done"),
    claimToken: (await store.read(run.id)).delegations[DELEGATION_ID].remediation.claimToken,
  });
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

test("beginRemediation blocks duplicate launch and invalid acceptance after post-spawn persistence failure", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const nextIdentity = nextTransportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    deliverFollowUpImpl: async () => ({ delivered: true, identity: nextIdentity }),
    observations: [
      { state: "missing", identity: expectedIdentity },
      { state: "missing", identity: expectedIdentity },
    ],
  });
  const fixture = await createCompletedDelegation(t, { transport });
  const brokenDelegations = {
    ...fixture.delegations,
    async completeRemediationLaunch() {
      throw new Error("SECRET-PERSISTENCE-FAILURE");
    },
  };
  const brokenServices = createDelegationServices({
    registry,
    projectAlias: PROJECT_ALIAS,
    runStore: fixture.store,
    delegations: brokenDelegations,
    reservations: fixture.reservations,
    transport,
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

  const first = await brokenServices.beginRemediation({
    runId: fixture.run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
    prompt: "Address the approved correction.",
  });
  assert.equal(first.state, "completed");
  assert.deepEqual(first.nextActions, ["manual-review"]);
  assert.equal(transport.calls.filter((call) => call.method === "deliverFollowUp").length, 1);

  const blockedRecord = (await fixture.store.read(fixture.run.id)).delegations[DELEGATION_ID];
  assert.equal(blockedRecord.generation, 1);
  assert.equal(blockedRecord.remediation?.state, "launching");

  await assert.rejects(
    () => brokenServices.beginRemediation({
      runId: fixture.run.id,
      delegationId: DELEGATION_ID,
      expectedGeneration: 1,
      reviewEvidence: { generation: 1, summary: "One bounded defect", insideFrozenBrief: true },
      prompt: "Address the approved correction.",
    }),
    /claimed|launch|remediation/i,
  );
  assert.equal(transport.calls.filter((call) => call.method === "deliverFollowUp").length, 1);

  await assert.rejects(
    () => fixture.delegations.recordResult({
      runId: fixture.run.id,
      delegationId: DELEGATION_ID,
      result: completedResult(2, "stale child"),
      claimToken: blockedRecord.remediation.claimToken,
    }),
    /generation|stale|running/i,
  );
});

test("beginRemediation leaves the current generation and result intact when follow-up delivery fails", async (t) => {
  const expectedIdentity = transportIdentity(RUN_ID, DELEGATION_ID);
  const transport = createTransport({
    startImpl: async () => ({ identity: expectedIdentity }),
    deliverFollowUpImpl: async () => {
      throw new Error("SECRET-DELIVERY-FAILURE");
    },
    observations: [{ state: "missing", identity: expectedIdentity }],
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

  assert.equal(result.state, "completed");
  assert.equal(result.generation, 1);
  assert.equal(result.resultStatus, "completed");
  assert.match(result.nextActions.join(" "), /remediation|manual/i);
  const record = (await store.read(run.id)).delegations[DELEGATION_ID];
  assert.equal(record.generation, 1);
  assert.equal(record.state, "completed");
  assert.equal(record.result?.generation, 1);
  assert.equal(record.result?.summary, "Review completed");
  assert.equal(record.remediationTurnsUsed, 0);
  assert.equal(record.remediation, null);
  assert.deepEqual(record.transportIdentity, expectedIdentity);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-DELIVERY-FAILURE|SECRET-FOLLOW-UP-PROMPT/);
});
