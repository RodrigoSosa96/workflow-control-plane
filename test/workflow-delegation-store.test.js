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
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-delegation-store-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
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

test("persists a private frozen brief and generation-aware advisory results", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID,
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
  });
  const run = await store.create({ projectAlias: "ocr", primaryTicket: "A-1", state: RUN_STATES.PLANNED });
  const delegations = createDelegationStore({
    store,
    randomUUID: () => DELEGATION_ID,
    clock: clockSequence(
      "2025-01-01T00:01:00.000Z",
      "2025-01-01T00:02:00.000Z",
      "2025-01-01T00:03:00.000Z",
      "2025-01-01T00:04:00.000Z",
      "2025-01-01T00:05:00.000Z",
      "2025-01-01T00:06:00.000Z",
    ),
  });

  const prepared = await delegations.prepare({
    runId: run.id,
    input: {
      role: "code-reviewer",
      mode: "background",
      originSessionId: "pi-origin-1",
      cwd: "/fixture/review",
      brief: "Review only the frozen task. SECRET-BRIEF-TEXT",
      task: "Review only the frozen task.",
      budget: { maxRuntimeMs: 60_000, concurrency: 1 },
    },
  });

  assert.equal(prepared.id, DELEGATION_ID);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.generation, 1);
  assert.match(prepared.briefDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(prepared.taskDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await readFile(prepared.briefPath, "utf8"), "Review only the frozen task. SECRET-BRIEF-TEXT");
  assert.equal(await fileMode(join(run.directory, "delegations", DELEGATION_ID)), 0o700);
  assert.equal(await fileMode(prepared.briefPath), 0o600);

  const persistedBeforeClaim = await readFile(join(run.directory, "run.json"), "utf8");
  assert.doesNotMatch(persistedBeforeClaim, /SECRET-BRIEF-TEXT|Review only the frozen task/);

  const claimed = await delegations.claim({ runId: run.id, delegationId: DELEGATION_ID });
  assert.equal(claimed.state, "running");
  await assert.rejects(() => delegations.claim({ runId: run.id, delegationId: DELEGATION_ID }), /allowed state|prepared|claim/i);

  const withSession = await delegations.recordSession({
    runId: run.id,
    delegationId: DELEGATION_ID,
    session: { kind: "pi", id: "child-session-1", path: "/private/child.jsonl" },
  });
  assert.deepEqual(withSession.nativeSession, { kind: "pi", id: "child-session-1", path: "/private/child.jsonl" });

  const completed = await delegations.recordResult({
    runId: run.id,
    delegationId: DELEGATION_ID,
    result: completedResult(1),
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.generation, 1);
  assert.equal(await fileMode(completed.result.path), 0o600);

  const remediating = await delegations.beginRemediation({
    runId: run.id,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
  });
  assert.equal(remediating.state, "running");
  assert.equal(remediating.generation, 2);
  assert.equal(remediating.result, null);
  assert.equal(remediating.remediationTurnsUsed, 1);

  await assert.rejects(
    () => delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedResult(1, "old result") }),
    /generation|stale/i,
  );
  const current = await delegations.recordResult({
    runId: run.id,
    delegationId: DELEGATION_ID,
    result: completedResult(2, "Current review completed"),
  });
  assert.equal(current.result.generation, 2);

  const listed = await delegations.list({ originSessionId: "pi-origin-1" });
  assert.deepEqual(listed.map((item) => item.id), [DELEGATION_ID]);
});

test("rejects oversized or invalid delegation data without echoing it", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID });
  const run = await store.create({ projectAlias: "ocr", primaryTicket: "A-1", state: RUN_STATES.PLANNED });
  const delegations = createDelegationStore({ store, randomUUID: () => DELEGATION_ID });

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
      assert.match(error.message, /role|brief|delegation/i);
      assert.doesNotMatch(error.message, /SECRET-DO-NOT-LEAK/);
      return true;
    },
  );

  assert.deepEqual((await store.read(run.id)).delegations ?? {}, {});
});
