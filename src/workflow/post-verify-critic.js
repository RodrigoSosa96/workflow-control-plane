import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const POST_VERIFY_CRITIC_ORIGIN = "system-post-verify";
export const POST_VERIFY_CRITIC_ROLE = "code-reviewer";
export const POST_VERIFY_CRITIC_BUDGET = Object.freeze({
  maxRuntimeMs: 300_000,
  concurrency: 1,
  maxTurns: 1,
  maxToolCalls: 24,
});
export const POST_VERIFY_CRITIC_REMEDIATION_TURNS = 0;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw new TypeError(`post-verify critic ${message}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${label} must be a sha256 digest`);
  return value;
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value)) {
    fail(`${label} must be an absolute path`);
  }
  return value;
}

function assertVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("verification must be an object");
  if (value.type !== "verification") fail("verification must be a verification event");
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) fail("verification timestamp must be valid");
  if (typeof value.passed !== "boolean" || !Number.isInteger(value.exitCode) || !Array.isArray(value.results)) {
    fail("verification must carry passed, exitCode and results");
  }
  return value;
}

function normalizedFingerprints(value) {
  if (!Array.isArray(value) || value.length === 0) fail("fingerprints must be a non-empty array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`fingerprints[${index}] must be an object`);
    if (typeof entry.repositoryId !== "string" || !entry.repositoryId) fail(`fingerprints[${index}].repositoryId must be a string`);
    return {
      repositoryId: entry.repositoryId,
      path: assertAbsolutePath(entry.path, `fingerprints[${index}].path`),
      digest: assertDigest(entry.digest, `fingerprints[${index}].digest`),
    };
  });
}

export function verificationDigest(verification) {
  return digest(assertVerification(verification));
}

export function createReviewOf({ verification, assignmentPath, assignmentDigest, fingerprints } = {}) {
  assertVerification(verification);
  assertAbsolutePath(assignmentPath, "assignment path");
  return Object.freeze({
    verificationDigest: verificationDigest(verification),
    assignmentDigest: assertDigest(assignmentDigest, "assignment digest"),
    fingerprintDigest: digest(normalizedFingerprints(fingerprints)),
  });
}

function assertReviewOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("reviewOf must be an object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "assignmentDigest,fingerprintDigest,verificationDigest") fail("reviewOf contains unsupported fields");
  return {
    verificationDigest: assertDigest(value.verificationDigest, "reviewOf.verificationDigest"),
    assignmentDigest: assertDigest(value.assignmentDigest, "reviewOf.assignmentDigest"),
    fingerprintDigest: assertDigest(value.fingerprintDigest, "reviewOf.fingerprintDigest"),
  };
}

function registeredWorktrees(run, fingerprints) {
  if (!run || typeof run !== "object" || Array.isArray(run)) fail("run must be an object");
  if (!Array.isArray(run.repositories) || run.repositories.length === 0) fail("run repositories must be non-empty");
  const byId = new Map(fingerprints.map((fingerprint) => [fingerprint.repositoryId, fingerprint]));
  return run.repositories.map((repository, index) => {
    if (!repository || typeof repository !== "object" || Array.isArray(repository)) fail(`run.repositories[${index}] must be an object`);
    if (typeof repository.id !== "string" || !repository.id) fail(`run.repositories[${index}].id must be a string`);
    const path = assertAbsolutePath(repository.path, `run.repositories[${index}] worktree`);
    const fingerprint = byId.get(repository.id);
    if (!fingerprint || fingerprint.path !== path) fail(`run.repositories[${index}] has no matching fingerprint`);
    return { repositoryId: repository.id, path, fingerprint: fingerprint.digest };
  });
}

export function buildPostVerifyCriticInput({ run, verification, reviewOf, fingerprints } = {}) {
  const event = assertVerification(verification);
  if (event.passed !== true) fail("verification must have passed");
  const assignmentPath = assertAbsolutePath(run?.assignmentPath, "assignment path");
  const assignmentDigest = assertDigest(run?.assignmentDigest, "assignment digest");
  const observed = normalizedFingerprints(fingerprints);
  const review = assertReviewOf(reviewOf);
  const expected = createReviewOf({ verification: event, assignmentPath, assignmentDigest, fingerprints: observed });
  if (JSON.stringify(review) !== JSON.stringify(expected)) fail("reviewOf does not match the observed verify state");
  const worktrees = registeredWorktrees(run, observed);
  const primary = worktrees[0];
  const task = `Review the current diff for Workflow run ${run.id} against its approved assignment.`;
  const brief = [
    "Review only; do not modify files, run cleanup, deploy, or push.",
    `Run: ${run.id}`,
    `Project: ${run.projectAlias ?? "unknown"}`,
    `Approved assignment: ${assignmentPath}`,
    `Assignment digest: ${assignmentDigest}`,
    `Verification digest: ${review.verificationDigest}`,
    `Observed fingerprint digest: ${review.fingerprintDigest}`,
    "Registered worktrees:",
    ...worktrees.map((worktree) => `- ${worktree.repositoryId}: ${worktree.path} (${worktree.fingerprint})`),
    "Compare the diff against the approved assignment and return findings with severity aside, concern, or blocker.",
  ].join("\n");

  return Object.freeze({
    origin: POST_VERIFY_CRITIC_ORIGIN,
    role: POST_VERIFY_CRITIC_ROLE,
    mode: "background",
    cwd: primary.path,
    brief,
    task,
    budget: { ...POST_VERIFY_CRITIC_BUDGET },
    remediationTurns: POST_VERIFY_CRITIC_REMEDIATION_TURNS,
    reviewOf: review,
  });
}

function isPostVerifyCritic(record) {
  return record
    && typeof record === "object"
    && !Array.isArray(record)
    && record.origin === POST_VERIFY_CRITIC_ORIGIN
    && record.role === POST_VERIFY_CRITIC_ROLE;
}

function recordStatus(record) {
  if (!record.result && (record.state === "prepared" || record.state === "running")) return "pending";
  return record.result?.status ?? record.state ?? "pending";
}

export function selectPostVerifyCritic({ delegations, latestVerification } = {}) {
  const records = Object.values(delegations ?? {}).filter(isPostVerifyCritic);
  if (records.length === 0) return null;
  const latestDigest = latestVerification ? verificationDigest(latestVerification) : null;
  if (latestDigest) {
    const matching = records.filter((record) => record.reviewOf?.verificationDigest === latestDigest);
    if (matching.length > 0) return matching.at(-1);
  }
  return records.at(-1);
}

function publicCriticResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return {
    status: result.status ?? null,
    generation: Number.isInteger(result.generation) ? result.generation : null,
    summary: typeof result.summary === "string" ? result.summary : null,
    findings: Array.isArray(result.findings) ? result.findings.map((finding) => ({
      severity: finding?.severity ?? null,
      summary: finding?.summary ?? null,
      evidence: finding?.evidence ?? null,
      ...(typeof finding?.path === "string" ? { path: finding.path } : {}),
    })) : [],
    concerns: Array.isArray(result.concerns) ? result.concerns.map(String) : [],
    nextAction: typeof result.nextAction === "string" ? result.nextAction : null,
  };
}

export function publicPostVerifyCritic({ delegations, latestVerification } = {}) {
  const record = selectPostVerifyCritic({ delegations, latestVerification });
  if (!record) return null;
  const fresh = Boolean(latestVerification && record.reviewOf?.verificationDigest === verificationDigest(latestVerification));
  return {
    delegationId: typeof record.id === "string" ? record.id : null,
    status: fresh ? recordStatus(record) : "stale",
    reviewOf: record.reviewOf ?? null,
    ...(record.result ? { result: publicCriticResult(record.result) } : {}),
  };
}
