import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createPreparedDelegationRequest, validateSubagentRequestPolicy } from "../src/workflow/coordinator-policy.js";
import { checkoutDigestFor } from "../src/workflow/delegation-invariants.js";

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
    // Matches the default delegation()'s role/mode/cwd: the shared predicate
    // now checks all three, plus the checkoutDigest below, not just the
    // resources list.
    role: "code-reviewer",
    mode: "background",
    checkoutDigest: checkoutDigestFor("/fixture/review"),
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

  const writerCheckoutDigest = checkoutDigestFor(writer.cwd);
  assert.deepEqual(
    validateSubagentRequestPolicy({
      request: foreground,
      prepared,
      policy,
      reservation: {
        state: "active",
        delegationId: DELEGATION_ID,
        role: "sdd-implementer",
        mode: "foreground",
        checkoutDigest: writerCheckoutDigest,
        resources: ["totalInternal", "foreground", "writersTotal", `checkout:${writerCheckoutDigest}`],
      },
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

  // The case above now rejects on role/mode (reservation() is code-reviewer/background) before
  // ever reaching the resource check, so it no longer distinctly proves that a writer
  // reservation must carry writersTotal and checkout:<digest>. Prove that separately here with a
  // reservation whose role/mode match the writer request but whose resources are missing both
  // writer-specific entries.
  const missingWriterResources = validateSubagentRequestPolicy({
    request: foreground,
    prepared,
    policy,
    reservation: {
      state: "active",
      delegationId: DELEGATION_ID,
      role: "sdd-implementer",
      mode: "foreground",
      checkoutDigest: writerCheckoutDigest,
      resources: ["totalInternal", "foreground"],
    },
  });
  assert.equal(missingWriterResources.allowed, false);
  assert.match(missingWriterResources.reason, /reservation/i);

  assert.throws(
    () => createPreparedDelegationRequest({ delegation: delegation({ role: "sdd-implementer", mode: "background" }), policy }),
    /background writers/i,
  );
});

test("validation never rewrites the incoming subagent request", () => {
  const prepared = createPreparedDelegationRequest({ delegation: delegation(), policy });
  const incoming = request({ worktree: true, tools: ["grep"] });
  const before = structuredClone(incoming);

  const result = validateSubagentRequestPolicy({
    request: incoming,
    prepared,
    policy,
    reservation: reservation(),
  });

  assert.equal(result.allowed, false);
  assert.deepEqual(incoming, before);
});

test("rejects a writer reservation whose checkout digest belongs to a different checkout", () => {
  // Same shape of hole the shared predicate closes: a reservation only ever
  // proved it held *some* checkout:-prefixed resource, never that the digest
  // matched *this* delegation's cwd. A writer reservation minted for a
  // different checkout must not authorize this one.
  const writer = delegation({ role: "sdd-implementer", mode: "foreground" });
  const prepared = createPreparedDelegationRequest({ delegation: writer, policy });
  const foreground = request({ agent: "sdd-implementer", async: false });
  const otherCheckoutDigest = checkoutDigestFor("/fixture/other-checkout");

  const result = validateSubagentRequestPolicy({
    request: foreground,
    prepared,
    policy,
    reservation: {
      state: "active",
      delegationId: DELEGATION_ID,
      role: "sdd-implementer",
      mode: "foreground",
      checkoutDigest: otherCheckoutDigest,
      resources: ["totalInternal", "foreground", "writersTotal", `checkout:${otherCheckoutDigest}`],
    },
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /reservation/i);
});

test("rejects a reservation reserved for a different role or mode", () => {
  const prepared = createPreparedDelegationRequest({ delegation: delegation(), policy });

  const wrongRole = validateSubagentRequestPolicy({
    request: request(),
    prepared,
    policy,
    reservation: {
      state: "active",
      delegationId: DELEGATION_ID,
      role: "scout",
      mode: "background",
      checkoutDigest: checkoutDigestFor("/fixture/review"),
      resources: ["totalInternal", "readOnlyBackground"],
    },
  });
  assert.equal(wrongRole.allowed, false);
  assert.match(wrongRole.reason, /reservation/i);

  const wrongMode = validateSubagentRequestPolicy({
    request: request(),
    prepared,
    policy,
    reservation: {
      state: "active",
      delegationId: DELEGATION_ID,
      role: "code-reviewer",
      mode: "foreground",
      checkoutDigest: checkoutDigestFor("/fixture/review"),
      resources: ["totalInternal", "readOnlyBackground"],
    },
  });
  assert.equal(wrongMode.allowed, false);
  assert.match(wrongMode.reason, /reservation/i);
});
