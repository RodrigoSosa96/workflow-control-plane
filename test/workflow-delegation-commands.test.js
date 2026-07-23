import assert from "node:assert/strict";
import { test } from "node:test";
import { delegationReconcileCommand, delegationRemediateCommand, delegationResultCommand } from "../src/workflow/commands.js";
import { formatWorkflowResult } from "../src/workflow/format.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ALIAS = "fixture";
const CWD = "/fixture/review";
const REGISTRY = {
  launcher: {
    state_root: "/state/workflow",
    delegation: {
      version: 1,
      totalInternal: 4,
      foreground: 3,
      readOnlyBackground: 3,
      writersTotal: 1,
      writersPerCheckout: 1,
      maxDepth: 1,
      remediationTurns: 2,
      allowBackgroundWriters: false,
    },
  },
  projects: {
    [PROJECT_ALIAS]: {
      label: "Fixture Project",
      path: CWD,
      delegation: { remediationTurns: 2 },
    },
  },
};

function transportIdentity() {
  return {
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: `/state/workflow/${RUN_ID}/delegations/${DELEGATION_ID}/pi-session.jsonl`,
    cwd: CWD,
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  };
}

function currentResult(generation, overrides = {}) {
  return {
    status: "completed",
    generation,
    summary: "Reviewed scope",
    verification: [{ command: "git diff --check", status: "passed" }],
    concerns: [],
    nextAction: "Await coordinator",
    ...overrides,
  };
}

function delegationRecord(overrides = {}) {
  return {
    id: DELEGATION_ID,
    parentRunId: RUN_ID,
    role: "code-reviewer",
    mode: "background",
    originSessionId: "pi-origin-1",
    cwd: CWD,
    briefDigest: `sha256:${"a".repeat(64)}`,
    taskDigest: `sha256:${"b".repeat(64)}`,
    budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
    generation: 1,
    state: "completed",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:01:00.000Z",
    briefPath: `/state/workflow/${RUN_ID}/delegations/${DELEGATION_ID}/brief.md`,
    nativeSession: null,
    transportIdentity: transportIdentity(),
    startFailure: null,
    result: currentResult(1),
    remediationTurnsUsed: 0,
    remediationTurns: 2,
    ...overrides,
  };
}

function runRecord(record, overrides = {}) {
  return {
    id: RUN_ID,
    directory: `/state/workflow/${RUN_ID}`,
    projectAlias: PROJECT_ALIAS,
    projectLabel: "Fixture Project",
    originSessionId: "pi-origin-1",
    delegations: { [DELEGATION_ID]: record },
    ...overrides,
  };
}

function storeFor(runOrFactory) {
  const calls = [];
  return {
    calls,
    async read(runId) {
      calls.push(runId);
      return structuredClone(typeof runOrFactory === "function" ? runOrFactory() : runOrFactory);
    },
    async update() {
      assert.fail("delegation command tests must stay read-only");
    },
  };
}

function reservationStore(records = []) {
  const calls = [];
  return {
    calls,
    async list({ projectAlias }) {
      calls.push(projectAlias);
      return structuredClone(records);
    },
  };
}

function transportFor(observation) {
  const calls = [];
  return {
    calls,
    async start() {
      assert.fail("read-only delegation commands must not start a worker");
    },
    async observeExact(identity) {
      calls.push({ method: "observeExact", identity: structuredClone(identity) });
      return structuredClone(observation ?? { state: "idle", identity });
    },
    async deliverFollowUp(identity, prompt) {
      calls.push({ method: "deliverFollowUp", identity: structuredClone(identity), prompt });
      return { delivered: true, identity: structuredClone(identity) };
    },
    async requestGracefulClose(identity) {
      calls.push({ method: "requestGracefulClose", identity: structuredClone(identity) });
      return { requested: false, manual: true };
    },
  };
}

function deps(overrides = {}) {
  return {
    loadRegistry: async (path) => {
      assert.equal(path, "/tmp/projects.yaml");
      return REGISTRY;
    },
    ...overrides,
  };
}

test("delegation result returns bounded current advisory data and compact formatting excludes sensitive fields", async () => {
  const record = delegationRecord({
    result: currentResult(1, {
      summary: "Reviewed scope SECRET-PROMPT-BODY",
      concerns: ["stdout should stay private"],
    }),
  });
  const result = await delegationResultCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    registryPath: "/tmp/projects.yaml",
  }, deps({ store: storeFor(runRecord(record)) }));

  assert.equal(result.status, "completed");
  assert.equal(result.resultStatus, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.canonical, true);
  assert.equal(result.advisoryReason, "run-origin");
  assert.deepEqual(result.ownership, {
    status: "available",
    hasOriginSession: true,
    consumed: false,
    consumedByOrigin: false,
    adopted: false,
  });
  assert.equal(result.result.summary, "Reviewed scope SECRET-PROMPT-BODY");
  assert.deepEqual(result.nextActions, ["review-result", "reconcile"]);
  assert.equal(Object.hasOwn(result, "runDirectory"), false);
  assert.equal(Object.hasOwn(result.identity ?? {}, "sessionPath"), false);

  const compact = formatWorkflowResult("delegation-result", result, "compact");
  assert.match(compact, /Role: code-reviewer/);
  assert.match(compact, /Result status: completed/);
  assert.doesNotMatch(compact, /SECRET-PROMPT-BODY|stdout should stay private|sessionPath|\/state\/workflow/i);

  const json = formatWorkflowResult("delegation-result", result, "json");
  assert.doesNotMatch(json, /pi-origin-1|consumedBySessionId|adoptedBySessionId/i);
  assert.deepEqual(JSON.parse(json).ownership, result.ownership);
});

test("delegation result distinguishes pending, stale, and explicitly adopted external results", async () => {
  const pending = await delegationResultCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store: storeFor(runRecord(delegationRecord({ state: "running", result: null }))),
  }));
  assert.equal(pending.status, "pending");
  assert.equal(pending.resultStatus, null);
  assert.equal(pending.exitCode, 20);
  assert.deepEqual(pending.nextActions, ["reconcile"]);

  const stale = await delegationResultCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store: storeFor(runRecord(delegationRecord({ generation: 2, result: currentResult(1) }))),
  }));
  assert.equal(stale.status, "result-stale");
  assert.equal(stale.resultStatus, "completed");
  assert.equal(stale.exitCode, 21);
  assert.deepEqual(stale.nextActions, ["reconcile"]);

  const adopted = await delegationResultCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store: storeFor(runRecord(
      delegationRecord({
        result: currentResult(1, {
          consumedBySessionId: "pi-later-session",
          adoptedBySessionId: "pi-later-session",
        }),
      }),
      { originSessionId: null },
    )),
  }));
  assert.equal(adopted.status, "completed");
  assert.equal(adopted.canonical, false);
  assert.equal(adopted.advisoryReason, "external-run");
  assert.deepEqual(adopted.ownership, {
    status: "adopted",
    hasOriginSession: true,
    consumed: true,
    consumedByOrigin: false,
    adopted: true,
  });
});

test("delegation reconcile preserves process identity, ownership, observation, and active reservation distinctions", async () => {
  for (const observation of [
    { state: "missing", identity: transportIdentity() },
    {
      state: "mismatch",
      identity: transportIdentity(),
      details: {
        observedPid: "98765",
        observedStartedAt: "2025-01-01T00:20:00.000Z",
        observedCwd: CWD,
        observedActive: "false",
      },
    },
  ]) {
    const transport = transportFor(observation);
    const services = [];
    const result = await delegationReconcileCommand({
      runId: RUN_ID,
      delegationId: DELEGATION_ID,
      registryPath: "/tmp/projects.yaml",
    }, deps({
      store: storeFor(runRecord(delegationRecord())),
      reservations: reservationStore([{ delegationId: DELEGATION_ID, state: "active", ownerToken: "SECRET-OWNER" }]),
      transport,
      createDelegationServices(input) {
        services.push(input);
        return {
          async reconcile(request) {
            assert.deepEqual(request, { runId: RUN_ID, delegationId: DELEGATION_ID });
            return {
              state: "completed",
              generation: 1,
              resultStatus: "completed",
              observation,
              nextActions: ["deliver-result", "manual-review"],
            };
          },
        };
      },
    }));

    assert.equal(services[0].projectAlias, PROJECT_ALIAS);
    assert.equal(result.status, "completed");
    assert.equal(result.identity.status, "recorded");
    assert.equal(result.identity.pid, "12345");
    assert.equal(Object.hasOwn(result.identity, "cwd"), false);
    assert.equal(result.observation.state, observation.state);
    assert.equal(Object.hasOwn(result.observation, "details"), false);
    assert.deepEqual(result.ownership, {
      status: "available",
      hasOriginSession: true,
      consumed: false,
      consumedByOrigin: false,
      adopted: false,
    });
    assert.equal(result.reservation.state, "active");
    assert.equal(result.reservation.retained, false);
    assert.deepEqual(result.nextActions, ["deliver-result", "manual-review"]);
    assert.deepEqual(transport.calls.map((call) => call.method), []);
    assert.doesNotMatch(JSON.stringify(result), /SECRET-OWNER|sessionPath|observedCwd|\/state\/workflow/i);

    const json = formatWorkflowResult("delegation-reconcile", result, "json");
    assert.doesNotMatch(json, /pi-origin-1|consumedBySessionId|adoptedBySessionId/i);
  }
});

test("delegation reconcile reuses the service observation snapshot exactly once", async () => {
  const transport = transportFor({ state: "idle", identity: transportIdentity() });
  const observation = {
    state: "mismatch",
    identity: transportIdentity(),
    details: { observedCwd: CWD },
  };

  const result = await delegationReconcileCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store: storeFor(runRecord(delegationRecord())),
    reservations: reservationStore([{ delegationId: DELEGATION_ID, state: "active" }]),
    transport,
    createDelegationServices() {
      return {
        async reconcile() {
          return {
            state: "completed",
            generation: 1,
            resultStatus: "completed",
            observation,
            nextActions: ["deliver-result", "manual-review"],
          };
        },
      };
    },
  }));

  assert.equal(result.observation.state, "mismatch");
  assert.equal(Object.hasOwn(result.observation, "details"), false);
  assert.deepEqual(transport.calls, []);
});

test("delegation reconcile reports failed starts with retained reservations and remediation caps without mutating processes", async () => {
  const failed = await delegationReconcileCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store: storeFor(runRecord(delegationRecord({
      state: "failed",
      transportIdentity: null,
      result: null,
      startFailure: { reason: "Delegation transport start failed", failedAt: "2025-01-01T00:02:00.000Z" },
    }))),
    reservations: reservationStore([{ delegationId: DELEGATION_ID, state: "active", ownerToken: "SECRET-OWNER" }]),
    transport: transportFor(),
    createDelegationServices() {
      return {
        async reconcile() {
          return {
            state: "failed",
            generation: 1,
            resultStatus: null,
            nextActions: ["manual-release-reservation", "manual-review"],
          };
        },
      };
    },
  }));
  assert.equal(failed.startFailure.reason, "Delegation transport start failed");
  assert.equal(failed.reservation.retained, true);
  assert.deepEqual(failed.nextActions, ["manual-release-reservation", "manual-review"]);

  const capped = await delegationReconcileCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store: storeFor(runRecord(delegationRecord({ remediationTurnsUsed: 2, remediationTurns: 2 }))),
    reservations: reservationStore([{ delegationId: DELEGATION_ID, state: "active" }]),
    transport: transportFor({ state: "idle", identity: transportIdentity() }),
    createDelegationServices() {
      return {
        async reconcile() {
          return {
            state: "completed",
            generation: 1,
            resultStatus: "completed",
            nextActions: ["deliver-result"],
          };
        },
      };
    },
  }));
  assert.deepEqual(capped.remediation, { remainingTurns: 0, capped: true });
  assert.deepEqual(capped.nextActions, ["deliver-result"]);
});

test("delegation remediate keeps preview read-only, delays service construction until approval, and rejects stale digests", async () => {
  const created = [];
  const began = [];
  const store = storeFor(runRecord(delegationRecord()));

  const command = await delegationRemediateCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    prompt: "Address the approved correction.",
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store,
    reservations: reservationStore([{ delegationId: DELEGATION_ID, state: "active" }]),
    transport: transportFor({ state: "idle", identity: transportIdentity() }),
    createDelegationServices(input) {
      created.push(input);
      return {
        async beginRemediation(request) {
          began.push(request);
          return {
            state: "running",
            generation: 2,
            resultStatus: null,
            nextActions: ["await-result"],
          };
        },
      };
    },
  }));

  assert.match(command.preview.approvalDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(command.preview.resultStatus, "completed");
  assert.deepEqual(command.preview.nextActions, ["approve-remediation"]);
  assert.equal(created.length, 0);

  const executed = await command.execute({ approvalDigest: command.preview.approvalDigest });
  assert.equal(created.length, 1);
  assert.equal(created[0].projectAlias, PROJECT_ALIAS);
  assert.deepEqual(began, [{
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: {
      generation: 1,
      summary: "Approved via workflow delegation remediate CLI for the current delegation result",
      insideFrozenBrief: true,
    },
    prompt: "Address the approved correction.",
  }]);
  assert.equal(executed.state, "running");
  assert.deepEqual(executed.nextActions, ["await-result"]);

  let generation = 1;
  const stale = await delegationRemediateCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    prompt: "Address the approved correction.",
    registryPath: "/tmp/projects.yaml",
  }, deps({
    store: storeFor(() => runRecord(delegationRecord({ generation, result: currentResult(generation) }))),
    reservations: reservationStore([{ delegationId: DELEGATION_ID, state: "active" }]),
    transport: transportFor({ state: "idle", identity: transportIdentity() }),
    createDelegationServices() {
      assert.fail("stale digests must fail before constructing services");
    },
  }));
  generation = 2;

  await assert.rejects(
    () => stale.execute({ approvalDigest: stale.preview.approvalDigest }),
    /stale approval digest|rerun delegation preview/i,
  );
});

test("delegation reconcile rejects mismatched explicit projects", async () => {
  await assert.rejects(
    () => delegationReconcileCommand({
      projectAlias: "other-project",
      runId: RUN_ID,
      delegationId: DELEGATION_ID,
      registryPath: "/tmp/projects.yaml",
    }, deps({
      store: storeFor(runRecord(delegationRecord())),
      reservations: reservationStore([]),
      transport: transportFor(),
      createDelegationServices() {
        return { async reconcile() { return { state: "completed", generation: 1, resultStatus: "completed", nextActions: [] }; } };
      },
    })),
    /does not match run project/i,
  );
});
