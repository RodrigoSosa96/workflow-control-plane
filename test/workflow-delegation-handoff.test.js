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
const RESERVATION_ID = "33333333-3333-4333-8333-333333333333";
const RESERVATION_OWNER = "44444444-4444-4444-8444-444444444444";
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
  await delegations.claim({ runId: run.id, delegationId: DELEGATION_ID });
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

  return { stateRoot, store, run, delegations, reservations };
}

test("submitDelegationHandoff records a bounded current-generation advisory result", async (t) => {
  const { store, run, delegations, reservations } = await createFixture(t);

  const result = await submitDelegationHandoff({
    runId: run.id,
    delegationId: DELEGATION_ID,
    input: advisoryInput(),
    store,
    delegations,
    reservations,
    git: {},
  });

  assert.equal(result.state, "completed");
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.generation, 1);
  assert.doesNotMatch(JSON.stringify(result), /stdout|stderr|terminal|transcript/i);
});

test("submitDelegationHandoff rejects wrong identity, stale generations, unbounded summaries, missing reservations, and duplicate results", async (t) => {
  const { store, run, delegations, reservations } = await createFixture(t, { reserve: false });

  await assert.rejects(
    () => submitDelegationHandoff({ runId: "99999999-9999-4999-8999-999999999999", delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, git: {} }),
    /run|not found/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: "99999999-9999-4999-8999-999999999999", input: advisoryInput(), store, delegations, reservations, git: {} }),
    /delegation|not found/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput({ generation: 2 }), store, delegations, reservations, git: {} }),
    /generation|current|stale/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput({ summary: "x".repeat(5000) }), store, delegations, reservations, git: {} }),
    /summary|bounded|limit/i,
  );
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, git: {} }),
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
  await submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, git: {} });
  await assert.rejects(
    () => submitDelegationHandoff({ runId: run.id, delegationId: DELEGATION_ID, input: advisoryInput(), store, delegations, reservations, git: {} }),
    /allowed state|duplicate|running/i,
  );
});

test("delegationHandoffCommand reads only the canonical delegation input path and verifies WORKFLOW identity", async (t) => {
  const { store, run, delegations, reservations } = await createFixture(t);
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
    () => delegationHandoffCommand({ runId: run.id, delegationId: DELEGATION_ID, input: "/tmp/attacker.json", env: { WORKFLOW_RUN_ID: run.id, WORKFLOW_DELEGATION_ID: DELEGATION_ID, WORKFLOW_DELEGATION_GENERATION: "1" } }, { store, delegations, reservations, fs: realFs, git: {} }),
    /handoff-input\.json|canonical|arbitrary/i,
  );
  await assert.rejects(
    () => delegationHandoffCommand({ runId: run.id, delegationId: DELEGATION_ID, input: canonicalInput, env: { WORKFLOW_RUN_ID: run.id, WORKFLOW_DELEGATION_ID: "other-delegation", WORKFLOW_DELEGATION_GENERATION: "1" } }, { store, delegations, reservations, fs: realFs, git: {} }),
    /WORKFLOW_DELEGATION_ID|identity|mismatch/i,
  );
});
