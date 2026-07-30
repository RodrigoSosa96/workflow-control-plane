import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { createPreparedDelegationRequest, validateSubagentRequestPolicy } from "./coordinator-policy.js";
import { classifyDelegationRole, resolveDelegationPolicy } from "./delegation-policy.js";
import { validateDelegationTransportIdentity } from "./delegation-invariants.js";
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

function validAbsolutePath(value) {
  return typeof value === "string" && Boolean(value) && !value.includes("\0") && isAbsolute(value) && Buffer.byteLength(value, "utf8") <= MAX_SHORT_TEXT;
}

function uniquePaths(values) {
  const seen = new Set();
  const paths = [];
  for (const value of values) {
    if (!validAbsolutePath(value) || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

function registeredRunCheckouts(run) {
  const repositories = Array.isArray(run?.repositories) ? run.repositories : [];
  return uniquePaths([
    ...repositories.flatMap((repository) => [
      repository?.path,
      repository?.worktreePath,
      repository?.checkoutPath,
      repository?.repositoryPath,
      repository?.cwd,
    ]),
    run?.repositoryPath,
    run?.worktreePath,
    run?.checkoutPath,
    run?.path,
  ]);
}

function resolveDelegationCwd(run, inputCwd) {
  const candidates = registeredRunCheckouts(run);
  if (candidates.length === 0) fail("delegation run has no registered checkout");
  if (inputCwd === undefined) {
    if (candidates.length !== 1) fail("delegation cwd must match one registered run checkout");
    return candidates[0];
  }

  const cwd = assertString(inputCwd, "delegation cwd", { limit: MAX_SHORT_TEXT, absolute: true });
  if (!candidates.includes(cwd)) fail("delegation cwd must match one registered run checkout");
  return cwd;
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

function publicState(record, identity, nextActions, observation) {
  return {
    state: record.state,
    identity: identity ?? null,
    generation: record.generation,
    resultStatus: record.result?.status ?? null,
    ...(observation ? { observation: clone(observation) } : {}),
    nextActions: Object.freeze([...nextActions]),
  };
}

function recordFor(run, delegationId) {
  const record = run?.delegations?.[delegationId];
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("Delegation was not found");
  return clone(record);
}

function validateRemediationDelivery(delivered, runId, delegationId) {
  const value = assertObject(delivered, "transport remediation delivery");
  if (value.delivered === false) {
    assertExactKeys(value, new Set(["delivered", "outcome"]), "transport remediation delivery");
    if (value.outcome !== "spawned-but-unverified") fail("transport remediation delivery outcome is unsupported");
    return { delivered: false, outcome: "spawned-but-unverified" };
  }
  return {
    delivered: true,
    identity: validateDelegationTransportIdentity(value.identity ?? value, runId, delegationId, fail),
  };
}

export function createDelegationServices({ registry, projectAlias, runStore, delegations, reservations, transport, roles } = {}) {
  if (!runStore || typeof runStore.read !== "function") fail("delegation services require a compatible run store");
  if (
    !delegations
    || typeof delegations.prepare !== "function"
    || typeof delegations.claim !== "function"
    || typeof delegations.recordTransportIdentity !== "function"
    || typeof delegations.recordStartFailure !== "function"
    || typeof delegations.claimRemediationLaunch !== "function"
    || typeof delegations.completeRemediationLaunch !== "function"
    || typeof delegations.rollbackRemediationLaunch !== "function"
    || typeof delegations.markRemediationLaunchManualRecovery !== "function"
  ) {
    fail("delegation services require a compatible delegation store");
  }
  if (!reservations || typeof reservations.reserve !== "function" || typeof reservations.list !== "function") {
    fail("delegation services require a compatible reservation store");
  }

  const workerTransport = assertWorkerTransport(transport);
  const policy = resolveDelegationPolicy({ registry, projectAlias });
  const project = registry?.projects?.[projectAlias];
  if (!project || typeof project !== "object") fail(`Unknown workflow project ${projectAlias}`);
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
    const cwd = resolveDelegationCwd(run, input.cwd);
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
      const identity = validateDelegationTransportIdentity(started?.identity ?? started, fresh.runId, claimed.id, fail);
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
    const remediationPending = Boolean(record.remediation?.state);
    const currentTerminalResult = Boolean(
      record.result
      && TERMINAL_STATES.has(record.result.status)
      && record.result.generation === record.generation,
    );
    const consumedOrAdopted = Boolean(
      record.result?.consumedBySessionId
      || record.result?.consumedAt
      || record.result?.adoptedBySessionId
      || record.result?.adoptedAt,
    );
    if (currentTerminalResult) {
      nextActions.push(consumedOrAdopted ? "review-result" : "deliver-result");
      if (remediationPending) {
        nextActions.push("manual-review");
      } else if (observation?.state === "missing" && record.remediationTurnsUsed < record.remediationTurns) {
        nextActions.push("begin-remediation");
      } else if (observation?.state === "mismatch") {
        nextActions.push("manual-review");
      }
    } else if (record.state === "running") {
      nextActions.push("await-result");
    }

    if (record.startFailure) nextActions.unshift("manual-release-reservation");
    if (!identity) nextActions.push("manual-review");
    return publicState(record, identity, nextActions, observation);
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
    // A remediation already in flight (launching, active, or parked in manual
    // recovery) blocks a second one. Checked here, before any reservation, so a
    // rejected attempt performs no mutation at all — claimRemediationLaunch
    // enforces the same rule under the run lock.
    if (record.remediation?.state) {
      fail(`Delegation remediation launch is already ${record.remediation.state}`);
    }

    const observation = await workerTransport.observeExact(record.transportIdentity);
    if (observation?.state !== "missing") {
      fail(`Delegation remediation observation is ${observation?.state ?? "unknown"}; exact worker must be proven gone`);
    }

    // A reservation lease covers a LIVE child, not a terminal record: the
    // previous child's lease was released when its result landed, so a
    // remediation follow-up reserves fresh capacity. That keeps the
    // one-writer-per-checkout invariant honest — if another delegation took this
    // checkout in the meantime, the remediation is refused instead of joining it.
    // Reserved only after every read-only validation, so a rejected remediation
    // never leaves a lease behind.
    await reservations.reserve({
      projectAlias,
      delegationId,
      role: record.role,
      mode: record.mode,
      checkoutPath: record.cwd,
      policy,
    });
    const releaseRemediationReservation = async () => {
      try {
        await reservations.releaseForDelegation({ projectAlias, delegationId });
      } catch {
        // Surfaced by `workflow delegation reconcile` as a still-active lease;
        // `workflow delegation release` clears it.
      }
    };

    let claimed;
    let claimToken;
    try {
      claimed = await delegations.claimRemediationLaunch({
        runId,
        delegationId,
        expectedGeneration,
      });
      claimToken = claimed.remediation?.claimToken;
      if (typeof claimToken !== "string" || !claimToken) fail("Delegation remediation claim is missing");
    } catch (error) {
      // No follow-up child exists yet, so the fresh lease must not outlive the
      // failed claim.
      await releaseRemediationReservation();
      throw error;
    }

    let delivered;
    try {
      delivered = await workerTransport.deliverFollowUp(record.transportIdentity, prompt, {
        runId,
        delegationId,
        role: record.role,
        mode: record.mode,
        cwd: record.cwd,
        generation: expectedGeneration + 1,
        claimToken,
      });
    } catch (_error) {
      const rolledBack = await delegations.rollbackRemediationLaunch({
        runId,
        delegationId,
        expectedGeneration,
        claimToken,
      });
      // Delivery never reached a child, so the fresh lease is released and a
      // retried remediation can reserve again instead of hitting its own leak.
      await releaseRemediationReservation();
      return publicState(rolledBack, rolledBack.transportIdentity, ["begin-remediation", "manual-review"]);
    }

    const delivery = validateRemediationDelivery(delivered, runId, delegationId);
    if (delivery.delivered !== true) {
      const blocked = await delegations.markRemediationLaunchManualRecovery({
        runId,
        delegationId,
        expectedGeneration,
        claimToken,
        reason: delivery.outcome,
      });
      return publicState(blocked, blocked.transportIdentity, ["manual-review"]);
    }

    try {
      const remediating = await delegations.completeRemediationLaunch({
        runId,
        delegationId,
        expectedGeneration,
        claimToken,
        identity: delivery.identity,
      });
      return publicState(remediating, delivery.identity, ["await-result"]);
    } catch (_error) {
      const blocked = await delegations.markRemediationLaunchManualRecovery({
        runId,
        delegationId,
        expectedGeneration,
        claimToken,
        reason: "post-spawn-persistence-failure",
      });
      return publicState(blocked, blocked.transportIdentity, ["manual-review"]);
    }
  }

  return Object.freeze({ createPreview, executeApproved, reconcile, beginRemediation });
}
