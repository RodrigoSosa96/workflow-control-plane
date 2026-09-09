import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POST_VERIFY_CRITIC_BUDGET,
  POST_VERIFY_CRITIC_ORIGIN,
  POST_VERIFY_CRITIC_REMEDIATION_TURNS,
  POST_VERIFY_CRITIC_ROLE,
  buildPostVerifyCriticInput,
  createReviewOf,
  publicPostVerifyCritic,
} from "../src/workflow/post-verify-critic.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNMENT_DIGEST = `sha256:${"a".repeat(64)}`;
const FINGERPRINT_DIGEST = `sha256:${"b".repeat(64)}`;

function verification(overrides = {}) {
  return {
    type: "verification",
    timestamp: "2026-08-26T12:00:00.000Z",
    passed: true,
    exitCode: 0,
    results: [{ repositoryId: "primary", command: "npm test", status: "passed", exitCode: 0 }],
    ...overrides,
  };
}

function fingerprints(overrides = {}) {
  return [{
    repositoryId: "primary",
    path: "/worktrees/fixture",
    digest: FINGERPRINT_DIGEST,
    ...overrides,
  }];
}

function run(overrides = {}) {
  return {
    id: RUN_ID,
    projectAlias: "fixture",
    assignmentPath: "/state/runs/fixture/assignment.md",
    assignmentDigest: ASSIGNMENT_DIGEST,
    repositories: [{ id: "primary", path: "/worktrees/fixture" }],
    ...overrides,
  };
}

function reviewOf({ event = verification(), observed = fingerprints() } = {}) {
  return createReviewOf({
    verification: event,
    assignmentPath: "/state/runs/fixture/assignment.md",
    assignmentDigest: ASSIGNMENT_DIGEST,
    fingerprints: observed,
  });
}

test("buildPostVerifyCriticInput freezes the assignment, passing verification and registered fingerprints", () => {
  const event = verification();
  const observed = fingerprints();
  const input = buildPostVerifyCriticInput({ run: run(), verification: event, reviewOf: reviewOf({ event, observed }), fingerprints: observed });

  assert.equal(input.origin, POST_VERIFY_CRITIC_ORIGIN);
  assert.equal(input.role, POST_VERIFY_CRITIC_ROLE);
  assert.equal(input.mode, "background");
  assert.deepEqual(input.budget, POST_VERIFY_CRITIC_BUDGET);
  assert.equal(input.remediationTurns, POST_VERIFY_CRITIC_REMEDIATION_TURNS);
  assert.match(input.brief, /\/state\/runs\/fixture\/assignment\.md/);
  assert.match(input.brief, new RegExp(ASSIGNMENT_DIGEST));
  assert.match(input.brief, new RegExp(FINGERPRINT_DIGEST));
  assert.match(input.brief, /aside.*concern.*blocker/is);
  assert.doesNotMatch(input.brief, /stdout|stderr|transcript|secret/i);
  assert.equal(input.cwd, "/worktrees/fixture");
});

test("createReviewOf is canonical across object key order and changes when observed work changes", () => {
  const first = verification();
  const reordered = {
    results: [{ status: "passed", exitCode: 0, command: "npm test", repositoryId: "primary" }],
    exitCode: 0,
    passed: true,
    timestamp: "2026-08-26T12:00:00.000Z",
    type: "verification",
  };
  const firstReview = reviewOf({ event: first });
  const reorderedReview = reviewOf({ event: reordered });
  const changedReview = reviewOf({ observed: fingerprints({ digest: `sha256:${"c".repeat(64)}` }) });

  assert.deepEqual(reorderedReview, firstReview);
  assert.notEqual(changedReview.fingerprintDigest, firstReview.fingerprintDigest);
  assert.notEqual(changedReview.verificationDigest, "");
});

test("buildPostVerifyCriticInput refuses missing or relative assignment and worktree paths", () => {
  const event = verification();
  const observed = fingerprints();
  const link = reviewOf({ event, observed });

  assert.throws(
    () => buildPostVerifyCriticInput({ run: run({ assignmentPath: "assignment.md" }), verification: event, reviewOf: link, fingerprints: observed }),
    /assignment.*absolute/i,
  );
  assert.throws(
    () => buildPostVerifyCriticInput({ run: run({ repositories: [{ id: "primary", path: "relative" }] }), verification: event, reviewOf: link, fingerprints: observed }),
    /worktree.*absolute|repository.*absolute/i,
  );
  assert.throws(
    () => createReviewOf({ verification: event, assignmentPath: "/state/runs/fixture/assignment.md", assignmentDigest: ASSIGNMENT_DIGEST, fingerprints: [{ repositoryId: "primary", path: "/worktrees/fixture" }] }),
    /fingerprint.*digest/i,
  );
});

test("publicPostVerifyCritic selects only the matching system critic and marks it stale after a later verification", () => {
  const event = verification();
  const link = reviewOf({ event });
  const critic = {
    id: "22222222-2222-4222-8222-222222222222",
    origin: POST_VERIFY_CRITIC_ORIGIN,
    role: POST_VERIFY_CRITIC_ROLE,
    state: "completed",
    reviewOf: link,
    result: {
      status: "completed",
      generation: 1,
      summary: "Review complete",
      findings: [{ severity: "blocker", summary: "Digest missing", evidence: "commands.js:1", path: "src/workflow/commands.js" }],
      concerns: ["Inspect the digest"],
      nextAction: "Review the blocker",
      claimTokenDigest: "must-not-leak",
    },
  };
  const generic = { ...critic, id: "33333333-3333-4333-8333-333333333333", origin: "interactive", originSessionId: "pi-session-1" };

  const fresh = publicPostVerifyCritic({ delegations: { generic, critic }, latestVerification: event });
  assert.equal(fresh.delegationId, critic.id);
  assert.equal(fresh.status, "completed");
  assert.equal(fresh.result.findings[0].severity, "blocker");
  assert.doesNotMatch(JSON.stringify(fresh), /claimToken|brief|sessionPath/i);

  const stale = publicPostVerifyCritic({ delegations: { critic }, latestVerification: verification({ passed: false, exitCode: 1, timestamp: "2026-08-26T12:05:00.000Z" }) });
  assert.equal(stale.status, "stale");
});
