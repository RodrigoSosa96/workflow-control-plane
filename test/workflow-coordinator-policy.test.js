import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createPreparedDelegationRequest, validateSubagentRequestPolicy } from "../src/workflow/coordinator-policy.js";

const DELEGATION_ID = "11111111-1111-4111-8111-111111111111";
const task = "Review the frozen brief.";
const taskDigest = `sha256:${createHash("sha256").update(task, "utf8").digest("hex")}`;
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

function delegation(overrides = {}) {
  return {
    id: DELEGATION_ID,
    role: "code-reviewer",
    mode: "background",
    cwd: "/fixture/review",
    taskDigest,
    budget: { concurrency: 1, maxRuntimeMs: 60_000 },
    state: "running",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    agent: "code-reviewer",
    task,
    async: true,
    worktree: false,
    cwd: "/fixture/review",
    concurrency: 1,
    ...overrides,
  };
}

function reservation(overrides = {}) {
  return {
    state: "active",
    delegationId: DELEGATION_ID,
    resources: ["totalInternal", "readOnlyBackground"],
    ...overrides,
  };
}

test("allows exactly one prepared read-only background request", () => {
  const prepared = createPreparedDelegationRequest({ delegation: delegation(), policy });
  const accepted = validateSubagentRequestPolicy({
    request: request(),
    prepared,
    policy,
    reservation: reservation(),
  });

  assert.deepEqual(accepted, { allowed: true, fingerprint: prepared.requestFingerprint });
  assert.match(prepared.requestFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(prepared.taskDigest, taskDigest);
  assert.equal(prepared.consumed, false);
});

test("rejects direct, stale, reused, mismatched, and unsafe requests", () => {
  const prepared = createPreparedDelegationRequest({ delegation: delegation(), policy });
  const cases = [
    [{ request: request(), prepared: undefined, policy, reservation: reservation() }, /prepared/i],
    [{ request: request({ task: "Different task" }), prepared, policy, reservation: reservation() }, /fingerprint|task/i],
    [{ request: request(), prepared: { ...prepared, consumed: true }, policy, reservation: reservation() }, /consumed|prepared/i],
    [{ request: request({ agent: "unknown" }), prepared, policy, reservation: reservation() }, /role|agent/i],
    [{ request: request({ tools: ["subagent"] }), prepared, policy, reservation: reservation() }, /nested|tool/i],
    [{ request: request({ worktree: true }), prepared, policy, reservation: reservation() }, /worktree/i],
    [{ request: request({ cwd: "/fixture/other" }), prepared, policy, reservation: reservation() }, /cwd|fingerprint/i],
    [{ request: request({ concurrency: 0 }), prepared, policy, reservation: reservation() }, /concurrency/i],
    [{ request: request({ action: "status", view: "fleet" }), prepared, policy, reservation: reservation() }, /action|administrative/i],
    [{ request: request(), prepared, policy, reservation: { ...reservation(), state: "released" } }, /reservation/i],
  ];

  for (const [input, message] of cases) {
    const result = validateSubagentRequestPolicy(input);
    assert.equal(result.allowed, false);
    assert.match(result.reason, message);
    assert.doesNotMatch(result.reason, /Different task/);
  }
});

test("requires writer reservations and keeps background writers disabled", () => {
  const writer = delegation({ role: "sdd-implementer", mode: "foreground" });
  const prepared = createPreparedDelegationRequest({ delegation: writer, policy });
  const foreground = request({ agent: "sdd-implementer", async: false });

  assert.deepEqual(
    validateSubagentRequestPolicy({
      request: foreground,
      prepared,
      policy,
      reservation: { state: "active", delegationId: DELEGATION_ID, resources: ["totalInternal", "foreground", "writersTotal", "checkout:abc"] },
    }),
    { allowed: true, fingerprint: prepared.requestFingerprint },
  );
  assert.equal(
    validateSubagentRequestPolicy({
      request: foreground,
      prepared,
      policy,
      reservation: reservation(),
    }).allowed,
    false,
  );

  assert.throws(
    () => createPreparedDelegationRequest({ delegation: delegation({ role: "sdd-implementer", mode: "background" }), policy }),
    /background writers/i,
  );
});
