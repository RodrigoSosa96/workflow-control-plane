import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { createPreparedDelegationRequest, validateSubagentRequestPolicy } from "./coordinator-policy.js";
import { classifyDelegationRole, resolveDelegationPolicy } from "./delegation-policy.js";
import { WorkflowError } from "./errors.js";
import { assertWorkerTransport } from "./worker-transport.js";

const APPROVAL_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MODES = new Set(["foreground", "background"]);
const TERMINAL_STATES = new Set(["completed", "blocked", "failed"]);
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_SHORT_TEXT = 4096;
const PREVIEW_DELEGATION_ID = "<generated at execute>";
const REVIEW_EVIDENCE_KEYS = new Set(["generation", "summary", "insideFrozenBrief"]);

function fail(message, details) {
  throw new WorkflowError("delegation-service", message, { details });
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value;
}

function assertExactKeys(value, keys, context) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`${context} contains unsupported field ${key}`);
  }
}

function assertString(value, context, { limit = MAX_SHORT_TEXT, absolute = false } = {}) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${context} must be a bounded non-empty string`);
  }
  if (absolute && !isAbsolute(value)) fail(`${context} must be an absolute path`);
  return value;
}

function digest(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function digestKey(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function canonicalDigest(value) {
  return digest(JSON.stringify(canonicalize(value)));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function validateBudget(value, policy, role, mode) {
  assertObject(value, "delegation budget");
  assertExactKeys(value, new Set(["maxRuntimeMs", "concurrency", "maxTurns", "maxToolCalls"]), "delegation budget");
  for (const field of ["maxRuntimeMs", "concurrency", "maxTurns", "maxToolCalls"]) {
    if (!Number.isInteger(value[field]) || value[field] < 1) fail(`delegation budget.${field} must be a positive integer`);
  }

  const kind = classifyDelegationRole(role);
  if (value.concurrency > policy.totalInternal) fail("delegation budget.concurrency exceeds policy");
  if (mode === "foreground" && value.concurrency > policy.foreground) fail("delegation budget.concurrency exceeds policy");
  if (kind === "read-only" && mode === "background" && value.concurrency > policy.readOnlyBackground) {
    fail("delegation budget.concurrency exceeds policy");
  }
  if (kind === "writer" && value.concurrency > policy.writersTotal) fail("delegation budget.concurrency exceeds policy");

  return {
    maxRuntimeMs: value.maxRuntimeMs,
    concurrency: value.concurrency,
    maxTurns: value.maxTurns,
    maxToolCalls: value.maxToolCalls,
  };
}

function validateRoleDefinition(value, expectedName) {
  assertObject(value, "delegation role");
  const role = {
    name: assertString(value.name, "delegation role name", { limit: 128 }),
    tools: Array.isArray(value.tools)
      ? value.tools.map((tool, index) => assertString(tool, `delegation role tools[${index}]`, { limit: 128 }))
      : fail("delegation role tools must be an array"),
    systemPrompt: assertString(value.systemPrompt ?? "system", "delegation role systemPrompt", { limit: MAX_TEXT_BYTES }),
  };
  if (role.name !== expectedName) fail("delegation role does not match the requested name");
  if (role.tools.includes("subagent")) fail("delegation role tools must not include nested subagents");
  return deepFreeze(role);
}

async function loadRoleDefinition(roles, name) {
  if (typeof roles === "function") return validateRoleDefinition(await roles({ name }), name);
  if (typeof roles?.loadDelegationRole === "function") return validateRoleDefinition(await roles.loadDelegationRole({ name }), name);
  fail("delegation role loader is required");
}

function validateReviewEvidence(value, expectedGeneration) {
  assertObject(value, "review evidence");
  assertExactKeys(value, REVIEW_EVIDENCE_KEYS, "review evidence");
  if (!Number.isInteger(value.generation) || value.generation < 1) fail("review evidence generation must be a positive integer");
  if (value.generation !== expectedGeneration) fail("review evidence generation is stale");
  if (value.insideFrozenBrief !== true) fail("review evidence expands scope beyond the frozen brief");
  return {
    generation: value.generation,
    summary: assertString(value.summary, "review evidence summary", { limit: MAX_SHORT_TEXT }),
    insideFrozenBrief: true,
  };
}

function validatePrompt(value) {
  return assertString(value, "delegation remediation prompt", { limit: MAX_TEXT_BYTES });
}

function validateMode(role, mode, policy) {
  if (!MODES.has(mode)) fail("delegation mode must be foreground or background");
  const kind = classifyDelegationRole(role);
  if (kind === "writer" && mode === "background" && policy.allowBackgroundWriters !== true) {
    fail("background writer delegations are disabled by policy");
  }
}

function validateRemediationTurns(value, policy) {
  const turns = value === undefined ? policy.remediationTurns : value;
  if (!Number.isInteger(turns) || turns < 0 || turns > policy.remediationTurns) {
    fail("delegation remediationTurns exceeds policy");
  }
  return turns;
}

function previewPayload(preview) {
  return {
    version: 1,
    runId: preview.runId,
    projectAlias: preview.projectAlias,
    delegationId: PREVIEW_DELEGATION_ID,
    role: preview.role,
    mode: preview.mode,
    cwd: preview.cwd,
    taskDigest: preview.taskDigest,
    briefDigest: preview.briefDigest,
    budget: clone(preview.budget),
    remediationTurns: preview.remediationTurns,
    tools: clone(preview.tools),
  };
}

function staleApprovalDigest(expected) {
  fail("Stale approval digest; rerun delegation preview before executing", expected ? { expected } : undefined);
}

function assertApprovalDigest(value) {
  if (typeof value !== "string" || !APPROVAL_DIGEST_RE.test(value)) {
    fail("Missing or invalid approval digest; rerun delegation preview before executing");
  }
}

function previewInput(preview) {
  return {
    role: preview.role,
    mode: preview.mode,
    originSessionId: preview.originSessionId,
    cwd: preview.cwd,
    brief: preview.brief,
    task: preview.task,
    budget: clone(preview.budget),
    remediationTurns: preview.remediationTurns,
  };
}

function expectedReservationResources(role, mode, checkoutDigest) {
  const kind = classifyDelegationRole(role);
  const resources = ["totalInternal"];
  if (mode === "foreground") resources.push("foreground");
  if (kind === "read-only" && mode === "background") resources.push("readOnlyBackground");
  if (kind === "writer") resources.push("writersTotal", `checkout:${checkoutDigest}`);
  return resources;
}

function reservationMatches(record, reservation) {
  if (!reservation || typeof reservation !== "object") return false;
  if (reservation.state !== "active" || reservation.delegationId !== record.id || reservation.role !== record.role || reservation.mode !== record.mode) {
    return false;
  }
  const checkoutDigest = digestKey(record.cwd);
  if (reservation.checkoutDigest !== checkoutDigest || !Array.isArray(reservation.resources)) return false;
  const expected = expectedReservationResources(record.role, record.mode, checkoutDigest);
  return expected.every((resource) => reservation.resources.includes(resource));
}

function publicState(record, identity, nextActions) {
  return {
    state: record.state,
    identity: identity ?? null,
    generation: record.generation,
    resultStatus: record.result?.status ?? null,
    nextActions: Object.freeze([...nextActions]),
  };
}

function recordFor(run, delegationId) {
  const record = run?.delegations?.[delegationId];
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("Delegation was not found");
  return clone(record);
}

function validateTransportIdentity(identity, runId, delegationId) {
  assertObject(identity, "transport identity");
  assertExactKeys(identity, new Set(["kind", "runId", "delegationId", "sessionPath", "cwd", "pid", "processStartedAt"]), "transport identity");
  if (identity.kind !== "pi-delegation") fail("transport identity kind is unsupported");
  const validated = {
    kind: "pi-delegation",
    runId: assertString(identity.runId, "transport identity runId", { limit: 128 }),
    delegationId: assertString(identity.delegationId, "transport identity delegationId", { limit: 128 }),
    sessionPath: assertString(identity.sessionPath, "transport identity sessionPath", { limit: MAX_SHORT_TEXT, absolute: true }),
    cwd: assertString(identity.cwd, "transport identity cwd", { limit: MAX_SHORT_TEXT, absolute: true }),
    pid: assertString(identity.pid, "transport identity pid", { limit: 128 }),
    processStartedAt: assertString(identity.processStartedAt, "transport identity processStartedAt", { limit: 128 }),
  };
  if (validated.runId !== runId || validated.delegationId !== delegationId) {
    fail("transport identity does not match the approved delegation");
  }
  return validated;
}

export function createDelegationServices({ registry, projectAlias, runStore, delegations, reservations, transport, roles } = {}) {
  if (!runStore || typeof runStore.read !== "function") fail("delegation services require a compatible run store");
  if (!delegations || typeof delegations.prepare !== "function" || typeof delegations.claim !== "function" || typeof delegations.recordTransportIdentity !== "function" || typeof delegations.recordStartFailure !== "function" || typeof delegations.beginRemediation !== "function") {
    fail("delegation services require a compatible delegation store");
  }
  if (!reservations || typeof reservations.reserve !== "function" || typeof reservations.list !== "function") {
    fail("delegation services require a compatible reservation store");
  }

  const workerTransport = assertWorkerTransport(transport);
  const policy = resolveDelegationPolicy({ registry, projectAlias });
  const project = registry?.projects?.[projectAlias];
  if (!project || typeof project !== "object") fail(`Unknown workflow project ${projectAlias}`);
  const projectPath = assertString(project.path, "project path", { limit: MAX_SHORT_TEXT, absolute: true });
  const consumedApprovalDigests = new Set();

  async function validatedPreview(runId, input) {
    const run = await runStore.read(assertString(runId, "run ID", { limit: 128 }));
    if (run.projectAlias !== projectAlias) fail("delegation run does not belong to the selected project");

    assertObject(input, "delegation input");
    assertExactKeys(input, new Set(["role", "mode", "originSessionId", "cwd", "brief", "task", "budget", "remediationTurns"]), "delegation input");
    const role = assertString(input.role, "delegation role", { limit: 128 });
    const roleDefinition = await loadRoleDefinition(roles, role);
    const mode = input.mode;
    validateMode(role, mode, policy);
    const cwd = assertString(input.cwd, "delegation cwd", { limit: MAX_SHORT_TEXT, absolute: true });
    if (cwd !== projectPath) fail("delegation cwd must match the registered project checkout");
    const budget = validateBudget(input.budget, policy, role, mode);
    const remediationTurns = validateRemediationTurns(input.remediationTurns, policy);
    const task = assertString(input.task, "delegation task", { limit: MAX_TEXT_BYTES });
    const brief = assertString(input.brief, "delegation brief", { limit: MAX_TEXT_BYTES });
    const preview = {
      version: 1,
      runId: run.id,
      projectAlias,
      role,
      mode,
      originSessionId: assertString(input.originSessionId, "delegation origin session", { limit: 512 }),
      cwd,
      task,
      brief,
      taskDigest: digest(task),
      briefDigest: digest(brief),
      budget,
      remediationTurns,
      tools: clone(roleDefinition.tools),
      approvalDigest: null,
    };
    preview.approvalDigest = canonicalDigest(previewPayload(preview));
    return deepFreeze(preview);
  }

  async function readRecord(runId, delegationId) {
    const run = await runStore.read(runId);
    return recordFor(run, assertString(delegationId, "delegation ID", { limit: 128 }));
  }

  async function activeReservation(record) {
    const matches = (await reservations.list({ projectAlias })).filter((reservation) => reservationMatches(record, reservation));
    if (matches.length !== 1) fail("Delegation reservation is missing or has changed");
    return matches[0];
  }

  async function createPreview({ runId, input } = {}) {
    return await validatedPreview(runId, input);
  }

  async function executeApproved({ preview, approvalDigest } = {}) {
    assertApprovalDigest(approvalDigest);
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) fail("delegation preview is required");
    if (preview.approvalDigest !== approvalDigest) staleApprovalDigest();
    if (consumedApprovalDigests.has(approvalDigest)) fail("Approved delegation preview has already been consumed");

    const fresh = await validatedPreview(preview.runId, previewInput(preview));
    if (fresh.approvalDigest !== approvalDigest) staleApprovalDigest(fresh.approvalDigest);

    const prepared = await delegations.prepare({
      runId: fresh.runId,
      input: previewInput(fresh),
    });
    const claimed = await delegations.claim({ runId: fresh.runId, delegationId: prepared.id });
    consumedApprovalDigests.add(approvalDigest);

    let reservation;
    try {
      reservation = await reservations.reserve({
        projectAlias,
        delegationId: claimed.id,
        role: claimed.role,
        mode: claimed.mode,
        checkoutPath: claimed.cwd,
        policy,
      });
    } catch (error) {
      await delegations.recordStartFailure({
        runId: fresh.runId,
        delegationId: claimed.id,
        reason: "Delegation reservation failed",
      });
      return publicState({ ...claimed, state: "failed", result: null }, null, ["create-new-preview", "manual-review"]);
    }

    const preparedRequest = createPreparedDelegationRequest({ delegation: claimed, policy });
    const request = {
      agent: claimed.role,
      task: fresh.task,
      async: claimed.mode === "background",
      worktree: false,
      cwd: claimed.cwd,
      concurrency: claimed.budget.concurrency,
    };
    const accepted = validateSubagentRequestPolicy({ request, prepared: preparedRequest, policy, reservation });
    if (accepted.allowed !== true) {
      await delegations.recordStartFailure({
        runId: fresh.runId,
        delegationId: claimed.id,
        reason: "Delegation request validation failed",
      });
      return publicState({ ...claimed, state: "failed", result: null }, null, ["manual-release-reservation", "create-new-preview"]);
    }

    try {
      const started = await workerTransport.start({
        runId: fresh.runId,
        projectAlias,
        delegationId: claimed.id,
        delegation: clone(claimed),
        request,
        prepared: preparedRequest,
        reservation: clone(reservation),
        role: { name: fresh.role, tools: clone(fresh.tools) },
        task: fresh.task,
        brief: fresh.brief,
        budget: clone(fresh.budget),
        remediationTurns: fresh.remediationTurns,
      });
      const identity = validateTransportIdentity(started?.identity ?? started, fresh.runId, claimed.id);
      const recorded = await delegations.recordTransportIdentity({
        runId: fresh.runId,
        delegationId: claimed.id,
        identity,
      });
      return publicState(recorded, identity, ["await-result"]);
    } catch (_error) {
      const failed = await delegations.recordStartFailure({
        runId: fresh.runId,
        delegationId: claimed.id,
        reason: "Delegation transport start failed",
      });
      return publicState(failed, null, ["manual-release-reservation", "create-new-preview"]);
    }
  }

  async function reconcile({ runId, delegationId } = {}) {
    const record = await readRecord(runId, delegationId);
    const identity = record.transportIdentity ?? null;
    let observation = null;
    if (identity) observation = await workerTransport.observeExact(identity);

    const nextActions = [];
    if (record.result && TERMINAL_STATES.has(record.result.status)) {
      nextActions.push("deliver-result");
      if (observation?.state === "idle" && record.remediationTurnsUsed < record.remediationTurns) {
        nextActions.push("begin-remediation");
      } else if (observation?.state === "missing" || observation?.state === "mismatch") {
        nextActions.push("manual-review");
      }
    } else if (record.state === "running") {
      nextActions.push("await-result");
    }

    if (record.startFailure) nextActions.unshift("manual-release-reservation");
    if (!identity) nextActions.push("manual-review");
    return publicState(record, identity, nextActions);
  }

  async function beginRemediation({ runId, delegationId, expectedGeneration, reviewEvidence, prompt } = {}) {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) fail("expected delegation generation must be a positive integer");
    validateReviewEvidence(reviewEvidence, expectedGeneration);
    validatePrompt(prompt);

    const record = await readRecord(runId, delegationId);
    if (record.generation !== expectedGeneration) fail("Delegation generation is stale");
    if (!record.result || !TERMINAL_STATES.has(record.result.status) || record.result.generation !== record.generation) {
      fail("Delegation does not have a terminal current result");
    }
    if (!record.transportIdentity) fail("Delegation is missing its exact transport identity");
    if (record.transportIdentity.cwd !== record.cwd) fail("Delegation cwd no longer matches the recorded identity");
    await activeReservation(record);

    const observation = await workerTransport.observeExact(record.transportIdentity);
    if (observation?.state !== "idle") {
      fail(`Delegation remediation observation is ${observation?.state ?? "missing"}; exact worker must be idle`);
    }

    let remediating = await delegations.beginRemediation({ runId, delegationId, expectedGeneration });
    let delivered;
    try {
      delivered = await workerTransport.deliverFollowUp(record.transportIdentity, prompt);
    } catch (_error) {
      remediating = await readRecord(runId, delegationId);
      return publicState(remediating, record.transportIdentity, ["manual-follow-up", "manual-review"]);
    }

    const identity = validateTransportIdentity(delivered?.identity ?? delivered, runId, delegationId);
    const recorded = await delegations.recordTransportIdentity({
      runId,
      delegationId,
      identity,
      replacement: {
        previousGeneration: expectedGeneration,
        previousIdentity: record.transportIdentity,
      },
    });
    return publicState(recorded, identity, ["await-result"]);
  }

  return Object.freeze({ createPreview, executeApproved, reconcile, beginRemediation });
}
