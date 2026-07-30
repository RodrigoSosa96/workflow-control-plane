import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { delegationHandoffCommand } from "../src/workflow/commands.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/workflow/delegation-policy.js";
import { createDelegationReservationStore } from "../src/workflow/delegation-reservations.js";
import { createDelegationStore } from "../src/workflow/delegation-store.js";
import { submitDelegationHandoff } from "../src/workflow/delegation-handoff.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_DELEGATION_ID = "33333333-3333-4333-8333-333333333333";
const RESERVATION_ID = "44444444-4444-4444-8444-444444444444";
const RESERVATION_OWNER = "55555555-5555-4555-8555-555555555555";
const PROJECT_ALIAS = "fixture";
const CWD = "/fixture/review";

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-delegation-handoff-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function transportIdentity() {
  return {
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: `/private/${DELEGATION_ID}.jsonl`,
    cwd: CWD,
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  };
}

function nextTransportIdentity() {
  return {
    ...transportIdentity(),
    pid: "67890",
    processStartedAt: "2025-01-01T00:20:00.000Z",
  };
}

function advisoryInput(overrides = {}) {
  return {
    status: "completed",
    generation: 1,
    summary: "Reviewed scope",
    verification: [],
    concerns: [],
    nextAction: "Await coordinator",
    ...overrides,
  };
}

async function createFixture(t, { reserve = true } = {}) {
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

  await delegations.prepare({
    runId: run.id,
    input: {
      role: "code-reviewer",
      mode: "background",
      originSessionId: "pi-origin-1",
      cwd: CWD,
      brief: "Review only the frozen brief.",
      task: "Review only the frozen brief.",
      budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
      remediationTurns: 2,
    },
  });
  const claimed = await delegations.claim({ runId: run.id, delegationId: DELEGATION_ID });
  await delegations.recordTransportIdentity({ runId: run.id, delegationId: DELEGATION_ID, identity: transportIdentity() });

  if (reserve) {
    await reservations.reserve({
      projectAlias: PROJECT_ALIAS,
      delegationId: DELEGATION_ID,
      role: "code-reviewer",
      mode: "background",
      checkoutPath: CWD,
      policy: DEFAULT_DELEGATION_POLICY,
    });
  }

  // The per-delegation claim token is the secret the child receives through its
  // private env; every handoff must present it.
  return { stateRoot, store, run, delegations, reservations, claimToken: claimed.claimToken };
}

test("submitDelegationHandoff records a bounded current-generation advisory result", async (t) => {
  const { store, run, delegations, reservations, claimToken } = await createFixture(t);

  const result = await submitDelegationHandoff({
    runId: run.id,
    delegationId: DELEGATION_ID,
    input: advisoryInput(),
    store,
    delegations,
    reservations,
    claimToken,
    git: {},
  });

  assert.equal(result.state, "completed");
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.generation, 1);
  assert.doesNotMatch(JSON.stringify(result), /stdout|stderr|terminal|transcript/i);
});

test("submitDelegationHandoff accepts only the active remediation claim token for the current child", async (t) => {
  const { store, run, delegations, reservations } = await createFixture(t);

  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: advisoryInput() });
  const claimed = await delegations.claimRemediationLaunch({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
  });
  await delegations.completeRemediationLaunch({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    claimToken: claimed.remediation.claimToken,
    identity: nextTransportIdentity(),
  });

  await assert.rejects(
    () => submitDelegationHandoff({
      runId: run.id,
      delegationId: DELEGATION_ID,
      input: advisoryInput({ generation: 2 }),
      store,
      delegations,
      reservations,
      claimToken: SECOND_DELEGATION_ID,
    }),
    /claim|stale/i,
  );

  const accepted = await submitDelegationHandoff({
    runId: run.id,
    delegationId: DELEGATION_ID,
    input: advisoryInput({ generation: 2 }),
    store,
    delegations,
    reservations,
    claimToken: claimed.remediation.claimToken,
  });
  assert.equal(accepted.result.generation, 2);
});

test("submitDelegationHandoff rejects unverified remediation children kept in manual recovery", async (t) => {
  const { store, run, delegations, reservations } = await createFixture(t);

  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: advisoryInput() });
  const claimed = await delegations.claimRemediationLaunch({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
  });
  await delegations.markRemediationLaunchManualRecovery({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    claimToken: claimed.remediation.claimToken,
    reason: "spawned-but-unverified",
  });

  await assert.rejects(
    () => submitDelegationHandoff({
      runId: run.id,
      delegationId: DELEGATION_ID,
      input: advisoryInput({ generation: 2 }),
      store,
      delegations,
      reservations,
      claimToken: claimed.remediation.claimToken,
    }),
    /generation|claim|stale|running/i,
  );
});

test("submitDelegationHandoff rejects wrong identity, stale generations, unbounded summaries, missing reservations, and duplicate results", async (t) => {
  const { store, run, delegations, reservations, claimToken } = await createFixture(t, { reserve: false });

  await assert.rejects(
    () => submitDelegationHandoff({ runId: "99999999-9999-4999-8999-999999999999", delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, claimToken, git: {} }),
    /run|not found/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: "99999999-9999-4999-8999-999999999999", input: advisoryInput(), store, delegations, reservations, claimToken, git: {} }),
    /delegation|not found/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput({ generation: 2 }), store, delegations, reservations, claimToken, git: {} }),
    /generation|current|stale/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput({ summary: "x".repeat(5000) }), store, delegations, reservations, claimToken, git: {} }),
    /summary|bounded|limit/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, claimToken, git: {} }),
    /reservation/i,
  );

  await reservations.reserve({
    projectAlias: PROJECT_ALIAS,
    delegationId: DELEGATION_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: CWD,
    policy: DEFAULT_DELEGATION_POLICY,
  });
  await submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, claimToken, git: {} });
  // A duplicate result stays rejected; the terminal handoff already released the
  // lease, so the reservation check is now the first guard to refuse it.
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, claimToken, git: {} }),
    /allowed state|duplicate|running|reservation/i,
  );
});

test("a terminal handoff releases the delegation reservation so per-project capacity is not exhausted", async (t) => {
  // release() could never be called (its owner token is never persisted outside
  // the lease file), so every delegation leaked its lease: with
  // writersPerCheckout: 1 a single successful writer delegation bricked the lane.
  const { store, run, delegations, reservations, claimToken } = await createFixture(t);

  const before = await reservations.list({ projectAlias: PROJECT_ALIAS });
  assert.deepEqual(before.filter((entry) => entry.state === "active").map((entry) => entry.delegationId), [DELEGATION_ID]);

  await submitDelegationHandoff({
    runId: run.id,
    delegationId: DELEGATION_ID,
    input: advisoryInput(),
    store,
    delegations,
    reservations,
    claimToken,
    git: {},
  });

  const after = await reservations.list({ projectAlias: PROJECT_ALIAS });
  assert.equal(after.filter((entry) => entry.state === "active").length, 0);
  assert.deepEqual(after.map((entry) => entry.state), ["released"]);
});

test("delegationHandoffCommand reads only the canonical delegation input path and verifies WORKFLOW identity", async (t) => {
  const { store, run, delegations, reservations, claimToken } = await createFixture(t);
  const canonicalInput = join(run.directory, "delegations", DELEGATION_ID, "handoff-input.json");
  await writeFile(canonicalInput, `${JSON.stringify(advisoryInput())}\n`);

  const result = await delegationHandoffCommand({
    runId: run.id,
    delegationId: DELEGATION_ID,
    input: canonicalInput,
    env: {
      WORKFLOW_RUN_ID: run.id,
      WORKFLOW_DELEGATION_ID: DELEGATION_ID,
      WORKFLOW_DELEGATION_GENERATION: "1",
      WORKFLOW_DELEGATION_CLAIM_TOKEN: claimToken,
    },
  }, {
    store,
    delegations,
    reservations,
    fs: realFs,
    git: {},
  });
  assert.equal(result.state, "completed");

  await assert.rejects(
    () => delegationHandoffCommand({ runId: run.id, delegationId: DELEGATION_ID, input: "/tmp/attacker.json", env: { WORKFLOW_RUN_ID: run.id, WORKFLOW_DELEGATION_ID: DELEGATION_ID, WORKFLOW_DELEGATION_GENERATION: "1", WORKFLOW_DELEGATION_CLAIM_TOKEN: claimToken } }, { store, delegations, reservations, fs: realFs, git: {} }),
    /handoff-input\.json|canonical|arbitrary/i,
  );
  await assert.rejects(
    () => delegationHandoffCommand({ runId: run.id, delegationId: DELEGATION_ID, input: canonicalInput, env: { WORKFLOW_RUN_ID: run.id, WORKFLOW_DELEGATION_ID: "other-delegation", WORKFLOW_DELEGATION_GENERATION: "1", WORKFLOW_DELEGATION_CLAIM_TOKEN: claimToken } }, { store, delegations, reservations, fs: realFs, git: {} }),
    /WORKFLOW_DELEGATION_ID|identity|mismatch/i,
  );
});

test("submitDelegationHandoff now rejects a transport identity with a malformed field even when kind/runId/delegationId still match", async (t) => {
  // assertTransportIdentity used to check only kind/runId/delegationId, so a
  // record whose persisted identity drifted or was tampered with after
  // delegation-store.js recorded it (which validates the full strict shape)
  // would still pass this layer's check as long as those three fields lined
  // up. It now delegates to the same shared, strict shape check
  // delegation-store.js uses, so a malformed field is caught here too.
  const { store, run, delegations, reservations, claimToken } = await createFixture(t);

  await store.update(run.id, (current) => {
    const record = current.delegations[DELEGATION_ID];
    return {
      delegations: {
        ...current.delegations,
        [DELEGATION_ID]: {
          ...record,
          transportIdentity: { ...record.transportIdentity, cwd: "relative/not-absolute" },
        },
      },
    };
  });

  await assert.rejects(
    () => submitDelegationHandoff({
      runId: run.id,
      delegationId: DELEGATION_ID,
      input: advisoryInput(),
      store,
      delegations,
      reservations,
      claimToken,
      git: {},
    }),
    /transport identity cwd|absolute path/i,
  );
});

test("submitDelegationHandoff now rejects a transport identity carrying an extra field the old check used to ignore", async (t) => {
  const { store, run, delegations, reservations, claimToken } = await createFixture(t);

  await store.update(run.id, (current) => {
    const record = current.delegations[DELEGATION_ID];
    return {
      delegations: {
        ...current.delegations,
        [DELEGATION_ID]: {
          ...record,
          transportIdentity: { ...record.transportIdentity, injected: "unexpected-field" },
        },
      },
    };
  });

  await assert.rejects(
    () => submitDelegationHandoff({
      runId: run.id,
      delegationId: DELEGATION_ID,
      input: advisoryInput(),
      store,
      delegations,
      reservations,
      claimToken,
      git: {},
    }),
    /unsupported field injected/i,
  );
});

test("submitDelegationHandoff now rejects a transport identity missing a required field the old check never inspected", async (t) => {
  const { store, run, delegations, reservations, claimToken } = await createFixture(t);

  await store.update(run.id, (current) => {
    const record = current.delegations[DELEGATION_ID];
    const { pid, ...rest } = record.transportIdentity;
    return {
      delegations: {
        ...current.delegations,
        [DELEGATION_ID]: { ...record, transportIdentity: rest },
      },
    };
  });

  await assert.rejects(
    () => submitDelegationHandoff({
      runId: run.id,
      delegationId: DELEGATION_ID,
      input: advisoryInput(),
      store,
      delegations,
      reservations,
      claimToken,
      git: {},
    }),
    /transport identity pid/i,
  );
});

test("submitDelegationHandoff rejects a sibling forging a first-generation result without the claim token", async (t) => {
  // Run ID, delegation ID, and generation are all discoverable by any same-user
  // process: a sibling delegation can enumerate them under the run directory.
  // Only the per-delegation secret, handed to the child through its private env,
  // authenticates an advisory result.
  const { store, run, delegations, reservations, claimToken } = await createFixture(t);

  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, git: {} }),
    /claim token/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({
      runId: run.id,
      delegationId: DELEGATION_ID,
      input: advisoryInput(),
      store,
      delegations,
      reservations,
      claimToken: "99999999-9999-4999-8999-999999999999",
      git: {},
    }),
    /claim token does not match/i,
  );

  // No forged attempt may leave a result behind.
  const untouched = (await store.read(run.id)).delegations[DELEGATION_ID];
  assert.equal(untouched.state, "running");
  assert.equal(untouched.result, null);

  const accepted = await submitDelegationHandoff({
    runId: run.id,
    delegationId: DELEGATION_ID,
    input: advisoryInput(),
    store,
    delegations,
    reservations,
    claimToken,
    git: {},
  });
  assert.equal(accepted.state, "completed");
});
