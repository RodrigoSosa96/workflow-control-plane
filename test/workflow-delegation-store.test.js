import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDelegationStore } from "../src/workflow/delegation-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";
import { createRunStore } from "../src/workflow/run-store.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_DELEGATION_ID = "33333333-3333-4333-8333-333333333333";
const THIRD_DELEGATION_ID = "44444444-4444-4444-8444-444444444444";

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-delegation-store-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function clockSequence(...values) {
  let index = 0;
  return {
    now() {
      return values[index++] ?? values.at(-1);
    },
  };
}

async function fileMode(path) {
  return (await stat(path)).mode & 0o777;
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
    cwd: "/fixture/review",
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

async function createFixture(t, ids = [FIRST_DELEGATION_ID, SECOND_DELEGATION_ID, THIRD_DELEGATION_ID]) {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID,
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
  });
  const run = await store.create({ projectAlias: "ocr", primaryTicket: "A-1", state: RUN_STATES.PLANNED });
  const delegations = createDelegationStore({
    store,
    randomUUID: uuidSequence(...ids),
    clock: clockSequence(
      "2025-01-01T00:01:00.000Z",
      "2025-01-01T00:02:00.000Z",
      "2025-01-01T00:03:00.000Z",
      "2025-01-01T00:04:00.000Z",
      "2025-01-01T00:05:00.000Z",
      "2025-01-01T00:06:00.000Z",
      "2025-01-01T00:07:00.000Z",
      "2025-01-01T00:08:00.000Z",
      "2025-01-01T00:09:00.000Z",
      "2025-01-01T00:10:00.000Z",
      "2025-01-01T00:11:00.000Z",
      "2025-01-01T00:12:00.000Z",
      "2025-01-01T00:13:00.000Z",
      "2025-01-01T00:14:00.000Z",
      "2025-01-01T00:15:00.000Z",
    ),
  });
  return { stateRoot, store, run, delegations };
}

test("persists a private frozen brief, exact transport identity, and generation-aware advisory results", async (t) => {
  const { store, run, delegations } = await createFixture(t);

  const prepared = await delegations.prepare({
    runId: run.id,
    input: {
      role: "code-reviewer",
      mode: "background",
      originSessionId: "pi-origin-1",
      cwd: "/fixture/review",
      brief: "Review only the frozen task. SECRET-BRIEF-TEXT",
      task: "Review only the frozen task.",
      budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
      remediationTurns: 2,
    },
  });

  assert.equal(prepared.id, FIRST_DELEGATION_ID);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.generation, 1);
  assert.match(prepared.briefDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(prepared.taskDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(prepared.budget, { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 });
  assert.equal(await readFile(prepared.briefPath, "utf8"), "Review only the frozen task. SECRET-BRIEF-TEXT");
  assert.equal(await fileMode(join(run.directory, "delegations", FIRST_DELEGATION_ID)), 0o700);
  assert.equal(await fileMode(prepared.briefPath), 0o600);

  const persistedBeforeClaim = await readFile(join(run.directory, "run.json"), "utf8");
  assert.doesNotMatch(persistedBeforeClaim, /SECRET-BRIEF-TEXT|Review only the frozen task/);

  const claimed = await delegations.claim({ runId: run.id, delegationId: FIRST_DELEGATION_ID });
  assert.equal(claimed.state, "running");

  const withIdentity = await delegations.recordTransportIdentity({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    identity: transportIdentity(run.id, FIRST_DELEGATION_ID),
  });
  assert.deepEqual(withIdentity.transportIdentity, transportIdentity(run.id, FIRST_DELEGATION_ID));

  const completed = await delegations.recordResult({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    result: completedResult(1),
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.generation, 1);
  assert.equal(await fileMode(completed.result.path), 0o600);

  const remediationClaim = await delegations.claimRemediationLaunch({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    expectedGeneration: 1,
  });
  assert.equal(remediationClaim.generation, 1);
  assert.equal(remediationClaim.remediation.state, "launching");
  assert.equal(remediationClaim.remediation.generation, 2);

  const remediating = await delegations.completeRemediationLaunch({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    expectedGeneration: 1,
    claimToken: remediationClaim.remediation.claimToken,
    identity: nextTransportIdentity(run.id, FIRST_DELEGATION_ID),
  });
  assert.equal(remediating.state, "running");
  assert.equal(remediating.generation, 2);
  assert.equal(remediating.result, null);
  assert.equal(remediating.remediationTurnsUsed, 1);
  assert.equal(remediating.remediation.state, "active");

  await assert.rejects(
    () => delegations.recordResult({ runId: run.id, delegationId: FIRST_DELEGATION_ID, result: completedResult(1, "old result") }),
    /generation|stale/i,
  );
  const current = await delegations.recordResult({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    result: completedResult(2, "Current review completed"),
    claimToken: remediationClaim.remediation.claimToken,
  });
  assert.equal(current.result.generation, 2);
  assert.equal(current.remediation, null);

  const listed = await delegations.list({ originSessionId: "pi-origin-1" });
  assert.deepEqual(listed.map((item) => item.id), [FIRST_DELEGATION_ID]);
});

test("claims exactly one remediation launch, rolls back safely, and requires the active claim token for handoff", async (t) => {
  const { run, delegations } = await createFixture(t, [FIRST_DELEGATION_ID]);
  const firstIdentity = transportIdentity(run.id, FIRST_DELEGATION_ID);

  await delegations.prepare({
    runId: run.id,
    input: {
      role: "code-reviewer",
      mode: "background",
      originSessionId: "pi-origin-1",
      cwd: "/fixture/review",
      brief: "Review only the frozen task.",
      task: "Review only the frozen task.",
      budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
      remediationTurns: 2,
    },
  });
  await delegations.claim({ runId: run.id, delegationId: FIRST_DELEGATION_ID });
  await delegations.recordTransportIdentity({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    identity: firstIdentity,
  });
  await delegations.recordResult({ runId: run.id, delegationId: FIRST_DELEGATION_ID, result: completedResult(1) });

  const claimed = await delegations.claimRemediationLaunch({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    expectedGeneration: 1,
  });
  assert.equal(claimed.generation, 1);
  assert.equal(claimed.remediation.state, "launching");

  await assert.rejects(
    () => delegations.claimRemediationLaunch({
      runId: run.id,
      delegationId: FIRST_DELEGATION_ID,
      expectedGeneration: 1,
    }),
    /claimed|launch/i,
  );

  const rolledBack = await delegations.rollbackRemediationLaunch({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    expectedGeneration: 1,
    claimToken: claimed.remediation.claimToken,
  });
  assert.equal(rolledBack.generation, 1);
  assert.equal(rolledBack.result?.generation, 1);
  assert.equal(rolledBack.remediationTurnsUsed, 0);
  assert.equal(rolledBack.remediation, null);

  const restarted = await delegations.claimRemediationLaunch({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    expectedGeneration: 1,
  });
  const secondIdentity = nextTransportIdentity(run.id, FIRST_DELEGATION_ID);
  const remediating = await delegations.completeRemediationLaunch({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    expectedGeneration: 1,
    claimToken: restarted.remediation.claimToken,
    identity: secondIdentity,
  });
  assert.deepEqual(remediating.transportIdentity, secondIdentity);
  assert.equal(remediating.remediation.state, "active");

  await assert.rejects(
    () => delegations.recordResult({
      runId: run.id,
      delegationId: FIRST_DELEGATION_ID,
      result: completedResult(2, "wrong claim"),
      claimToken: SECOND_DELEGATION_ID,
    }),
    /claim|stale/i,
  );

  const completed = await delegations.recordResult({
    runId: run.id,
    delegationId: FIRST_DELEGATION_ID,
    result: completedResult(2, "Current review completed"),
    claimToken: restarted.remediation.claimToken,
  });
  assert.equal(completed.result.generation, 2);
  assert.equal(completed.remediation, null);
});

test("consumes exact-origin results once and supports explicit adoption", async (t) => {
  const { run, delegations } = await createFixture(t);

  const first = await delegations.prepare({
    runId: run.id,
    input: {
      role: "code-reviewer",
      mode: "background",
      originSessionId: "pi-origin-1",
      cwd: "/fixture/review",
      brief: "Review the first frozen task.",
      task: "Review the first frozen task.",
      budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
      remediationTurns: 2,
    },
  });
  await delegations.claim({ runId: run.id, delegationId: first.id });
  await delegations.recordTransportIdentity({
    runId: run.id,
    delegationId: first.id,
    identity: transportIdentity(run.id, first.id),
  });
  await delegations.recordResult({ runId: run.id, delegationId: first.id, result: completedResult(1) });

  await assert.rejects(
    () => delegations.consumeResult({ runId: run.id, delegationId: first.id, originSessionId: "pi-origin-2" }),
    /origin|session/i,
  );

  const consumed = await delegations.consumeResult({ runId: run.id, delegationId: first.id, originSessionId: "pi-origin-1" });
  assert.equal(consumed.result.consumedBySessionId, "pi-origin-1");
  assert.ok(consumed.result.consumedAt);

  await assert.rejects(
    () => delegations.consumeResult({ runId: run.id, delegationId: first.id, originSessionId: "pi-origin-1" }),
    /consumed|consumer/i,
  );

  const second = await delegations.prepare({
    runId: run.id,
    input: {
      role: "code-reviewer",
      mode: "background",
      originSessionId: "pi-origin-1",
      cwd: "/fixture/review",
      brief: "Review the second frozen task.",
      task: "Review the second frozen task.",
      budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
      remediationTurns: 2,
    },
  });
  await delegations.claim({ runId: run.id, delegationId: second.id });
  await delegations.recordTransportIdentity({
    runId: run.id,
    delegationId: second.id,
    identity: transportIdentity(run.id, second.id),
  });
  await delegations.recordResult({ runId: run.id, delegationId: second.id, result: completedResult(1, "Second review done") });

  const adopted = await delegations.adoptResult({ runId: run.id, delegationId: second.id, originSessionId: "pi-origin-2" });
  assert.equal(adopted.result.adoptedBySessionId, "pi-origin-2");
  assert.ok(adopted.result.adoptedAt);
  assert.equal(adopted.result.consumedBySessionId, "pi-origin-2");
  assert.ok(adopted.result.consumedAt);
});

test("records a bounded start failure without losing the private brief", async (t) => {
  const { run, delegations } = await createFixture(t, [FIRST_DELEGATION_ID]);

  const prepared = await delegations.prepare({
    runId: run.id,
    input: {
      role: "code-reviewer",
      mode: "background",
      originSessionId: "pi-origin-1",
      cwd: "/fixture/review",
      brief: "Review the frozen task without cleanup.",
      task: "Review the frozen task without cleanup.",
      budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
      remediationTurns: 2,
    },
  });
  await delegations.claim({ runId: run.id, delegationId: prepared.id });

  const failed = await delegations.recordStartFailure({
    runId: run.id,
    delegationId: prepared.id,
    reason: "Delegation transport start failed",
  });

  assert.equal(failed.state, "failed");
  assert.equal(failed.startFailure.reason, "Delegation transport start failed");
  assert.equal(await readFile(prepared.briefPath, "utf8"), "Review the frozen task without cleanup.");
});

test("rejects oversized or invalid delegation data without echoing it", async (t) => {
  const { store, run, delegations } = await createFixture(t, [FIRST_DELEGATION_ID]);

  await assert.rejects(
    () => delegations.prepare({
      runId: run.id,
      input: {
        role: "unknown",
        mode: "background",
        originSessionId: "pi-origin-1",
        cwd: "/fixture/review",
        brief: `SECRET-DO-NOT-LEAK-${"x".repeat(70 * 1024)}`,
        task: "Review",
        budget: { maxRuntimeMs: 60_000, concurrency: 1 },
      },
    }),
    (error) => {
      assert.match(error.message, /role|brief|budget|delegation/i);
      assert.doesNotMatch(error.message, /SECRET-DO-NOT-LEAK/);
      return true;
    },
  );

  assert.deepEqual((await store.read(run.id)).delegations ?? {}, {});
});
