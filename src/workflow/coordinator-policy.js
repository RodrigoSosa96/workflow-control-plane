import { createHash } from "node:crypto";
import { classifyDelegationRole, validateDelegationPolicy } from "./delegation-policy.js";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const READ_ONLY_ROLES = new Set(["scout", "spec-reviewer", "code-reviewer"]);
const WRITER_ROLE = "sdd-implementer";
const REQUEST_KEYS = new Set(["agent", "task", "async", "worktree", "cwd", "concurrency", "tools", "action", "view"]);

function digest(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function boundedString(value, limit = 4096) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= limit;
}

function canonicalFingerprint(value) {
  const sorted = Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex")}`;
}

function reject(reason) {
  return { allowed: false, reason };
}

function reservationResources(role, mode) {
  const kind = classifyDelegationRole(role);
  const resources = ["totalInternal"];
  if (mode === "foreground") resources.push("foreground");
  if (kind === "read-only" && mode === "background") resources.push("readOnlyBackground");
  if (kind === "writer") resources.push("writersTotal");
  return resources;
}

function reservationAllows(reservation, role, mode, delegationId) {
  if (!reservation || typeof reservation !== "object" || reservation.state !== "active" || reservation.delegationId !== delegationId || !Array.isArray(reservation.resources)) {
    return false;
  }
  const required = reservationResources(role, mode);
  if (!required.every((resource) => reservation.resources.includes(resource))) return false;
  if (role === WRITER_ROLE && !reservation.resources.some((resource) => typeof resource === "string" && resource.startsWith("checkout:"))) {
    return false;
  }
  return true;
}

function validPrepared(prepared) {
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) return false;
  if (!boundedString(prepared.delegationId, 128) || !boundedString(prepared.role, 128) || !boundedString(prepared.cwd)) return false;
  if ((prepared.mode !== "foreground" && prepared.mode !== "background") || !Number.isInteger(prepared.concurrency) || prepared.concurrency < 1) return false;
  if (typeof prepared.async !== "boolean" || prepared.worktree !== false || prepared.consumed !== false) return false;
  if (!DIGEST_RE.test(prepared.taskDigest) || !DIGEST_RE.test(prepared.requestFingerprint)) return false;
  return true;
}

export function createPreparedDelegationRequest({ delegation, policy } = {}) {
  if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) {
    throw new TypeError("Prepared delegation requires a delegation record");
  }
  const effectivePolicy = validateDelegationPolicy(policy, "coordinator policy");
  if (delegation.state !== "running") throw new TypeError("Prepared delegation must be claimed and running");
  const role = delegation.role;
  const kind = classifyDelegationRole(role);
  if (delegation.mode !== "foreground" && delegation.mode !== "background") throw new TypeError("Prepared delegation mode is invalid");
  if (!boundedString(delegation.id, 128) || !boundedString(delegation.cwd) || !DIGEST_RE.test(delegation.taskDigest)) {
    throw new TypeError("Prepared delegation record is malformed");
  }
  const concurrency = delegation.budget?.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("Prepared delegation concurrency is invalid");
  if (concurrency > effectivePolicy.totalInternal || (delegation.mode === "foreground" && concurrency > effectivePolicy.foreground)) {
    throw new TypeError("Prepared delegation concurrency exceeds policy");
  }
  if (kind === "read-only" && delegation.mode === "background" && concurrency > effectivePolicy.readOnlyBackground) {
    throw new TypeError("Prepared delegation background concurrency exceeds policy");
  }
  if (kind === "writer" && concurrency > effectivePolicy.writersTotal) {
    throw new TypeError("Prepared delegation writer concurrency exceeds policy");
  }
  if (kind === "writer" && delegation.mode === "background" && effectivePolicy.allowBackgroundWriters !== true) {
    throw new TypeError("Prepared delegation background writers are disabled by policy");
  }

  const request = {
    delegationId: delegation.id,
    role,
    mode: delegation.mode,
    cwd: delegation.cwd,
    concurrency,
    async: delegation.mode === "background",
    worktree: false,
    taskDigest: delegation.taskDigest,
  };
  return Object.freeze({
    ...request,
    requestFingerprint: canonicalFingerprint(request),
    consumed: false,
  });
}

export function validateSubagentRequestPolicy({ request, prepared, policy, reservation } = {}) {
  if (!validPrepared(prepared)) return reject("Prepared delegation request is missing, stale, or consumed");
  let effectivePolicy;
  try {
    effectivePolicy = validateDelegationPolicy(policy, "coordinator policy");
  } catch {
    return reject("Coordinator delegation policy is invalid");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) return reject("Subagent request is malformed");
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) return reject("Subagent request contains an unsupported field");
  }
  if (request.action !== undefined || request.view !== undefined) return reject("Subagent administrative action is not allowed");
  if (Array.isArray(request.tools) && request.tools.includes("subagent")) return reject("Nested subagent tools are not allowed");
  if (request.tools !== undefined && !Array.isArray(request.tools)) return reject("Subagent tools request is malformed");
  if (!boundedString(request.agent, 128) || !boundedString(request.task, 64 * 1024) || !boundedString(request.cwd)) {
    return reject("Subagent request has invalid identity or task fields");
  }
  if (request.agent !== prepared.role) return reject("Subagent role does not match the prepared delegation");
  try {
    classifyDelegationRole(request.agent);
  } catch {
    return reject("Subagent role is not managed");
  }
  if (request.worktree !== false) return reject("Internal subagent worktree is not allowed");
  if (typeof request.async !== "boolean") return reject("Subagent async mode is invalid");
  if (!Number.isInteger(request.concurrency) || request.concurrency < 1 || request.concurrency > effectivePolicy.totalInternal) {
    return reject("Subagent concurrency is invalid or exceeds policy");
  }
  if (request.cwd !== prepared.cwd) return reject("Subagent cwd does not match the prepared delegation");
  if (request.concurrency !== prepared.concurrency || request.async !== prepared.async) {
    return reject("Subagent request does not match the prepared concurrency or mode");
  }
  if (prepared.mode === "foreground" && request.async !== false) return reject("Foreground delegation must not run asynchronously");
  if (prepared.mode === "background" && request.async !== true) return reject("Background delegation must run asynchronously");
  if (request.agent === WRITER_ROLE && request.async === true && effectivePolicy.allowBackgroundWriters !== true) {
    return reject("Background writer delegation is disabled by policy");
  }
  if (READ_ONLY_ROLES.has(request.agent) && request.async === true && request.concurrency > effectivePolicy.readOnlyBackground) {
    return reject("Read-only background concurrency exceeds policy");
  }
  if (request.agent === WRITER_ROLE && request.concurrency > effectivePolicy.writersTotal) {
    return reject("Writer concurrency exceeds policy");
  }
  if (!reservationAllows(reservation, request.agent, prepared.mode, prepared.delegationId)) {
    return reject("Subagent reservation is missing or incompatible");
  }

  const actualFingerprint = canonicalFingerprint({
    delegationId: prepared.delegationId,
    role: request.agent,
    mode: prepared.mode,
    cwd: request.cwd,
    concurrency: request.concurrency,
    async: request.async,
    worktree: request.worktree,
    taskDigest: digest(request.task),
  });
  if (actualFingerprint !== prepared.requestFingerprint) return reject("Subagent task or request fingerprint does not match the prepared delegation");
  return { allowed: true, fingerprint: prepared.requestFingerprint };
}
