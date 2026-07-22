import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDelegationRole, resolveDelegationPolicy, validateDelegationPolicy } from "../src/workflow/delegation-policy.js";

const defaults = {
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

function registry({ launcherDelegation = defaults, projectDelegation } = {}) {
  return {
    launcher: { delegation: launcherDelegation },
    projects: {
      demo: {
        ...(projectDelegation === undefined ? {} : { delegation: projectDelegation }),
      },
    },
  };
}

test("resolves project policy by tightening launcher defaults", () => {
  const policy = resolveDelegationPolicy({
    registry: registry({
      projectDelegation: {
        totalInternal: 2,
        foreground: 2,
        readOnlyBackground: 1,
      },
    }),
    projectAlias: "demo",
  });

  assert.deepEqual(policy, {
    ...defaults,
    totalInternal: 2,
    foreground: 2,
    readOnlyBackground: 1,
  });
  assert.equal(Object.isFrozen(policy), true);
});

test("rejects invalid delegation limits and forbidden background writers", () => {
  const invalid = [
    [{ ...defaults, version: 2 }, /version/i],
    [{ ...defaults, totalInternal: 0 }, /positive integer/i],
    [{ ...defaults, foreground: 5 }, /foreground.*totalInternal/i],
    [{ ...defaults, readOnlyBackground: 5 }, /readOnlyBackground.*totalInternal/i],
    [{ ...defaults, writersTotal: 5 }, /writersTotal.*totalInternal/i],
    [{ ...defaults, writersPerCheckout: 2 }, /writersPerCheckout.*writersTotal/i],
    [{ ...defaults, maxDepth: 2 }, /maxDepth/i],
    [{ ...defaults, remediationTurns: 3 }, /remediationTurns/i],
    [{ ...defaults, allowBackgroundWriters: true }, /allowBackgroundWriters|fixture gate/i],
    [{ ...defaults, unexpected: true }, /unknown/i],
  ];

  for (const [value, message] of invalid) {
    assert.throws(() => validateDelegationPolicy(value, "test policy"), message);
  }
});

test("classifies only the managed delegation roles", () => {
  assert.equal(classifyDelegationRole("scout"), "read-only");
  assert.equal(classifyDelegationRole("spec-reviewer"), "read-only");
  assert.equal(classifyDelegationRole("code-reviewer"), "read-only");
  assert.equal(classifyDelegationRole("sdd-implementer"), "writer");
  assert.throws(() => classifyDelegationRole("unknown"), /role/i);
});
