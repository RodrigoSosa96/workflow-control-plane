import { createHash, randomUUID as defaultRandomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { classifyDelegationRole } from "./delegation-policy.js";
import { WorkflowError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MODES = new Set(["foreground", "background"]);
const TERMINAL_STATES = new Set(["completed", "blocked", "failed"]);
const REMEDIABLE_STATES = new Set(["completed", "blocked", "failed"]);
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_SHORT_TEXT = 4096;
const MAX_CONCERNS = 20;
const MAX_VERIFICATION = 20;
const SESSION_KINDS = new Set(["pi", "claude", "codex"]);

function fail(message) {
  throw new WorkflowError("delegation", message);
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value;
}

function assertString(value, context, { limit = MAX_SHORT_TEXT, absolute = false } = {}) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${context} must be a bounded non-empty string`);
  }
  if (absolute && !isAbsolute(value)) fail(`${context} must be an absolute path`);
  return value;
}

function assertExactKeys(value, keys, context) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`${context} contains unsupported field ${key}`);
  }
}

function now(clock) {
  const value = typeof clock === "function" ? clock() : clock?.now?.();
  const timestamp = value instanceof Date ? value.toISOString() : typeof value === "number" ? new Date(value).toISOString() : value;
  if (typeof timestamp !== "string" || !timestamp.trim() || Number.isNaN(Date.parse(timestamp))) {
    fail("clock must return a valid timestamp");
  }
  return timestamp;
}

function digest(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function delegationId(randomUUID) {
  const value = randomUUID();
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("delegation ID generator returned an invalid UUID");
  return value.toLowerCase();
}

function remediationClaimToken(randomUUID) {
  const value = randomUUID();
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("delegation remediation claim generator returned an invalid UUID");
  return value.toLowerCase();
}

function delegationMap(run) {
  if (run.delegations === undefined) return {};
  assertObject(run.delegations, "run.delegations");
  return structuredClone(run.delegations);
}

function recordFor(run, id) {
  const record = delegationMap(run)[id];
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("Delegation was not found");
  return record;
}

function validateBudget(value) {
  assertObject(value, "delegation budget");
  assertExactKeys(value, new Set(["maxRuntimeMs", "concurrency", "maxTurns", "maxToolCalls"]), "delegation budget");
  for (const field of ["maxRuntimeMs", "concurrency", "maxTurns", "maxToolCalls"]) {
    if (!Number.isInteger(value[field]) || value[field] < 1) {
      fail(`delegation budget.${field} must be a positive integer`);
    }
  }
  return {
    maxRuntimeMs: value.maxRuntimeMs,
    concurrency: value.concurrency,
    maxTurns: value.maxTurns,
    maxToolCalls: value.maxToolCalls,
  };
}

function validateSession(value) {
  assertObject(value, "native session");
  assertExactKeys(value, new Set(["kind", "id", "path"]), "native session");
  if (!SESSION_KINDS.has(value.kind)) fail("native session kind is unsupported");
  const session = {
    kind: value.kind,
    id: assertString(value.id, "native session id", { limit: 512 }),
  };
  if (value.path !== undefined) session.path = assertString(value.path, "native session path", { limit: MAX_SHORT_TEXT, absolute: true });
  return session;
}

function validateTransportIdentity(value, runId, delegationId) {
  assertObject(value, "transport identity");
  assertExactKeys(value, new Set(["kind", "runId", "delegationId", "sessionPath", "cwd", "pid", "processStartedAt"]), "transport identity");
  if (value.kind !== "pi-delegation") fail("transport identity kind is unsupported");
  const identity = {
    kind: "pi-delegation",
    runId: assertString(value.runId, "transport identity runId", { limit: 128 }),
    delegationId: assertString(value.delegationId, "transport identity delegationId", { limit: 128 }),
    sessionPath: assertString(value.sessionPath, "transport identity sessionPath", { limit: MAX_SHORT_TEXT, absolute: true }),
    cwd: assertString(value.cwd, "transport identity cwd", { limit: MAX_SHORT_TEXT, absolute: true }),
    pid: assertString(value.pid, "transport identity pid", { limit: 128 }),
    processStartedAt: assertString(value.processStartedAt, "transport identity processStartedAt", { limit: 128 }),
  };
  if (identity.runId !== runId || identity.delegationId !== delegationId) {
    fail("transport identity does not match the delegation");
  }
  return identity;
}

function sameTransportIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.kind === right.kind
    && left.runId === right.runId
    && left.delegationId === right.delegationId
    && left.sessionPath === right.sessionPath
    && left.cwd === right.cwd
    && left.pid === right.pid
    && left.processStartedAt === right.processStartedAt,
  );
}

function validateTransportIdentityReplacement(value, runId, delegationId) {
  if (value === undefined) return null;
  assertObject(value, "transport identity replacement");
  assertExactKeys(value, new Set(["previousGeneration", "previousIdentity"]), "transport identity replacement");
  if (!Number.isInteger(value.previousGeneration) || value.previousGeneration < 1) {
    fail("transport identity replacement previousGeneration must be a positive integer");
  }
  return {
    previousGeneration: value.previousGeneration,
    previousIdentity: validateTransportIdentity(value.previousIdentity, runId, delegationId),
  };
}

function validateClaimToken(value, context = "delegation remediation claim token") {
  const token = assertString(value, context, { limit: 128 });
  if (!UUID_RE.test(token)) fail(`${context} must be a UUID`);
  return token.toLowerCase();
}

function validateResult(value) {
  assertObject(value, "delegation result");
  assertExactKeys(value, new Set(["status", "generation", "summary", "verification", "concerns", "nextAction"]), "delegation result");
  if (!TERMINAL_STATES.has(value.status)) fail("delegation result status is unsupported");
  if (!Number.isInteger(value.generation) || value.generation < 1) fail("delegation result generation must be a positive integer");
  const verification = value.verification;
  if (!Array.isArray(verification) || verification.length > MAX_VERIFICATION) fail("delegation result verification must be a bounded array");
  const concerns = value.concerns;
  if (!Array.isArray(concerns) || concerns.length > MAX_CONCERNS) fail("delegation result concerns must be a bounded array");

  return {
    status: value.status,
    generation: value.generation,
    summary: assertString(value.summary, "delegation result summary"),
    verification: verification.map((entry, index) => {
      assertObject(entry, `delegation result verification[${index}]`);
      assertExactKeys(entry, new Set(["command", "status"]), `delegation result verification[${index}]`);
      return {
        command: assertString(entry.command, `delegation result verification[${index}].command`),
        status: assertString(entry.status, `delegation result verification[${index}].status`, { limit: 128 }),
      };
    }),
    concerns: concerns.map((concern, index) => assertString(concern, `delegation result concerns[${index}]`, { limit: 1024 })),
    nextAction: assertString(value.nextAction, "delegation result nextAction"),
  };
}

function privatePath(id, name) {
  return `delegations/${id}/${name}`;
}

export function createDelegationStore({ store, clock = () => new Date().toISOString(), randomUUID = defaultRandomUUID } = {}) {
  if (!store || typeof store.read !== "function" || typeof store.update !== "function" || typeof store.writePrivateFile !== "function" || typeof store.list !== "function") {
    fail("Delegation store requires a compatible run store");
  }
  if (typeof randomUUID !== "function") fail("delegation randomUUID must be a function");

  async function prepare({ runId, input } = {}) {
    assertObject(input, "delegation input");
    assertExactKeys(input, new Set(["role", "mode", "originSessionId", "cwd", "brief", "task", "budget", "remediationTurns"]), "delegation input");
    const role = assertString(input.role, "delegation role", { limit: 128 });
    classifyDelegationRole(role);
    if (!MODES.has(input.mode)) fail("delegation mode must be foreground or background");
    const originSessionId = assertString(input.originSessionId, "delegation origin session", { limit: 512 });
    const cwd = assertString(input.cwd, "delegation cwd", { limit: MAX_SHORT_TEXT, absolute: true });
    const brief = assertString(input.brief, "delegation brief", { limit: MAX_TEXT_BYTES });
    const task = assertString(input.task, "delegation task", { limit: MAX_TEXT_BYTES });
    const budget = validateBudget(input.budget);
    const remediationTurns = input.remediationTurns === undefined ? 2 : input.remediationTurns;
    if (!Number.isInteger(remediationTurns) || remediationTurns < 0 || remediationTurns > 2) {
      fail("delegation remediationTurns must be an integer from 0 through 2");
    }
    const id = delegationId(randomUUID);
    const timestamp = now(clock);
    const relativePath = privatePath(id, "brief.md");

    const written = await store.writePrivateFile(runId, {
      relativePath,
      text: brief,
      updater: (run) => {
        const delegations = delegationMap(run);
        if (delegations[id]) fail("Delegation ID already exists");
        const record = {
          id,
          parentRunId: run.id,
          role,
          mode: input.mode,
          originSessionId,
          cwd,
          briefDigest: digest(brief),
          taskDigest: digest(task),
          budget,
          generation: 1,
          state: "prepared",
          createdAt: timestamp,
          updatedAt: timestamp,
          briefPath: join(run.directory, relativePath),
          nativeSession: null,
          transportIdentity: null,
          startFailure: null,
          result: null,
          remediation: null,
          remediationTurnsUsed: 0,
          remediationTurns,
        };
        return { delegations: { ...delegations, [id]: record } };
      },
    });
    return written.run.delegations[id];
  }

  async function updateRecord({ runId, delegationId: id, expectedStates, mutate }) {
    assertString(id, "delegation ID", { limit: 128 });
    if (typeof mutate !== "function") fail("delegation mutation must be a function");
    const timestamp = now(clock);
    const run = await store.update(runId, (current) => {
      const delegations = delegationMap(current);
      const currentRecord = delegations[id];
      if (!currentRecord || typeof currentRecord !== "object" || Array.isArray(currentRecord)) fail("Delegation was not found");
      if (expectedStates && !expectedStates.has(currentRecord.state)) fail("Delegation is not in an allowed state");
      const nextRecord = mutate(structuredClone(currentRecord), current);
      assertObject(nextRecord, "delegation update");
      return {
        delegations: {
          ...delegations,
          [id]: { ...nextRecord, updatedAt: timestamp },
        },
      };
    });
    return recordFor(run, id);
  }

  async function claim({ runId, delegationId: id } = {}) {
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: new Set(["prepared"]),
      mutate: (record) => ({ ...record, state: "running", claimedAt: now(clock) }),
    });
  }

  async function recordSession({ runId, delegationId: id, session } = {}) {
    const nativeSession = validateSession(session);
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: new Set(["running"]),
      mutate: (record) => ({ ...record, nativeSession }),
    });
  }

  async function recordTransportIdentity({ runId, delegationId: id, identity, replacement } = {}) {
    const transportIdentity = validateTransportIdentity(identity, runId, id);
    const transportReplacement = validateTransportIdentityReplacement(replacement, runId, id);
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: new Set(["running"]),
      mutate: (record) => {
        if (!transportReplacement) {
          if (record.transportIdentity) fail("Delegation transport identity is already recorded");
          return { ...record, transportIdentity };
        }
        if (!record.transportIdentity) fail("Delegation transport identity is missing");
        if (record.generation !== transportReplacement.previousGeneration + 1) {
          fail("Delegation transport identity replacement is stale");
        }
        if (!sameTransportIdentity(record.transportIdentity, transportReplacement.previousIdentity)) {
          fail("Delegation transport identity replacement is stale");
        }
        if (
          transportIdentity.sessionPath !== transportReplacement.previousIdentity.sessionPath
          || transportIdentity.cwd !== transportReplacement.previousIdentity.cwd
        ) {
          fail("Delegation transport identity replacement must keep the same session and cwd");
        }
        if (
          transportIdentity.pid === transportReplacement.previousIdentity.pid
          && transportIdentity.processStartedAt === transportReplacement.previousIdentity.processStartedAt
        ) {
          fail("Delegation transport identity replacement must record a new exact process identity");
        }
        return { ...record, transportIdentity };
      },
    });
  }

  async function recordStartFailure({ runId, delegationId: id, reason } = {}) {
    const boundedReason = assertString(reason, "delegation start failure reason", { limit: 1024 });
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: new Set(["running"]),
      mutate: (record) => ({
        ...record,
        state: "failed",
        startFailure: {
          reason: boundedReason,
          failedAt: now(clock),
        },
      }),
    });
  }

  async function recordResult({ runId, delegationId: id, result, claimToken } = {}) {
    assertString(id, "delegation ID", { limit: 128 });
    const validated = validateResult(result);
    const relativePath = privatePath(id, "result.json");
    const timestamp = now(clock);
    const written = await store.writePrivateFile(runId, {
      relativePath,
      text: `${JSON.stringify(validated, null, 2)}\n`,
      updater: (run) => {
        const delegations = delegationMap(run);
        const record = delegations[id];
        if (!record || typeof record !== "object" || Array.isArray(record)) fail("Delegation was not found");
        if (record.state !== "running") fail("Delegation is not running");
        if (record.generation !== validated.generation) fail("Delegation result generation is stale");
        const activeRemediation = record.remediation?.state === "active" && record.remediation?.generation === validated.generation
          ? record.remediation
          : null;
        if (activeRemediation) {
          if (validateClaimToken(claimToken) !== activeRemediation.claimToken) fail("Delegation handoff claim is stale");
        } else if (claimToken !== undefined) {
          validateClaimToken(claimToken);
          fail("Delegation handoff claim is not active for the current generation");
        }
        return {
          delegations: {
            ...delegations,
            [id]: {
              ...record,
              state: validated.status,
              updatedAt: timestamp,
              remediation: null,
              result: {
                ...validated,
                path: join(run.directory, relativePath),
                writtenAt: timestamp,
              },
            },
          },
        };
      },
    });
    return written.run.delegations[id];
  }

  async function claimRemediationLaunch({ runId, delegationId: id, expectedGeneration } = {}) {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      fail("expected delegation generation must be a positive integer");
    }
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: REMEDIABLE_STATES,
      mutate: (record) => {
        if (record.generation !== expectedGeneration) fail("Delegation generation is stale");
        if (!record.result || !TERMINAL_STATES.has(record.result.status) || record.result.generation !== record.generation) {
          fail("Delegation does not have a terminal current result");
        }
        if (!record.transportIdentity) fail("Delegation transport identity is missing");
        if (record.remediation) fail("Delegation remediation launch is already claimed");
        if (record.remediationTurnsUsed >= record.remediationTurns) fail("Delegation remediation limit is exhausted");
        return {
          ...record,
          remediation: {
            state: "launching",
            generation: record.generation + 1,
            claimToken: remediationClaimToken(randomUUID),
            claimedAt: now(clock),
          },
        };
      },
    });
  }

  async function completeRemediationLaunch({ runId, delegationId: id, expectedGeneration, claimToken, identity } = {}) {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      fail("expected delegation generation must be a positive integer");
    }
    const validatedClaimToken = validateClaimToken(claimToken);
    const nextIdentity = validateTransportIdentity(identity, runId, id);
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: REMEDIABLE_STATES,
      mutate: (record) => {
        if (record.generation !== expectedGeneration) fail("Delegation generation is stale");
        if (!record.remediation || record.remediation.state !== "launching") fail("Delegation remediation launch is not pending");
        if (record.remediation.claimToken !== validatedClaimToken) fail("Delegation remediation launch claim is stale");
        if (record.remediation.generation !== expectedGeneration + 1) fail("Delegation remediation launch generation is stale");
        if (!record.transportIdentity) fail("Delegation transport identity is missing");
        if (
          nextIdentity.sessionPath !== record.transportIdentity.sessionPath
          || nextIdentity.cwd !== record.transportIdentity.cwd
        ) {
          fail("Delegation remediation identity must keep the same session and cwd");
        }
        if (
          nextIdentity.pid === record.transportIdentity.pid
          && nextIdentity.processStartedAt === record.transportIdentity.processStartedAt
        ) {
          fail("Delegation remediation identity must record a new exact process identity");
        }
        return {
          ...record,
          state: "running",
          generation: record.remediation.generation,
          result: null,
          transportIdentity: nextIdentity,
          remediationTurnsUsed: record.remediationTurnsUsed + 1,
          remediation: {
            ...record.remediation,
            state: "active",
          },
        };
      },
    });
  }

  async function rollbackRemediationLaunch({ runId, delegationId: id, expectedGeneration, claimToken } = {}) {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      fail("expected delegation generation must be a positive integer");
    }
    const validatedClaimToken = validateClaimToken(claimToken);
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: REMEDIABLE_STATES,
      mutate: (record) => {
        if (record.generation !== expectedGeneration) fail("Delegation generation is stale");
        if (!record.remediation || record.remediation.state !== "launching") fail("Delegation remediation launch is not pending");
        if (record.remediation.claimToken !== validatedClaimToken) fail("Delegation remediation launch claim is stale");
        return {
          ...record,
          remediation: null,
        };
      },
    });
  }

  async function consumeResult({ runId, delegationId: id, originSessionId } = {}) {
    const consumer = assertString(originSessionId, "delegation origin session", { limit: 512 });
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: TERMINAL_STATES,
      mutate: (record) => {
        if (!record.result || !TERMINAL_STATES.has(record.result.status) || record.result.generation !== record.generation) {
          fail("Delegation does not have a terminal current result");
        }
        if (record.originSessionId !== consumer) fail("Delegation result belongs to a different origin session");
        if (record.result.consumedBySessionId || record.result.consumedAt) fail("Delegation result has already been consumed");
        return {
          ...record,
          result: {
            ...record.result,
            consumedBySessionId: consumer,
            consumedAt: now(clock),
          },
        };
      },
    });
  }

  async function adoptResult({ runId, delegationId: id, originSessionId } = {}) {
    const adopter = assertString(originSessionId, "delegation origin session", { limit: 512 });
    return await updateRecord({
      runId,
      delegationId: id,
      expectedStates: TERMINAL_STATES,
      mutate: (record) => {
        if (!record.result || !TERMINAL_STATES.has(record.result.status) || record.result.generation !== record.generation) {
          fail("Delegation does not have a terminal current result");
        }
        if (record.result.consumedBySessionId || record.result.consumedAt) fail("Delegation result has already been consumed");
        return {
          ...record,
          result: {
            ...record.result,
            adoptedBySessionId: adopter,
            adoptedAt: now(clock),
            consumedBySessionId: adopter,
            consumedAt: now(clock),
          },
        };
      },
    });
  }

  async function list({ originSessionId } = {}) {
    if (originSessionId !== undefined) assertString(originSessionId, "delegation origin session", { limit: 512 });
    const runs = await store.list({});
    const results = [];
    for (const run of runs) {
      for (const record of Object.values(delegationMap(run))) {
        if (originSessionId !== undefined && record.originSessionId !== originSessionId) continue;
        results.push(structuredClone(record));
      }
    }
    results.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
    return results;
  }

  return Object.freeze({
    prepare,
    claim,
    recordSession,
    recordTransportIdentity,
    recordStartFailure,
    recordResult,
    consumeResult,
    adoptResult,
    claimRemediationLaunch,
    completeRemediationLaunch,
    rollbackRemediationLaunch,
    list,
  });
}
