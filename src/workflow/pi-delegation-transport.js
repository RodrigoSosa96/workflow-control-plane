import * as defaultFs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDelegationRole as defaultLoadDelegationRole } from "./delegation-roles.js";

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SHORT_TEXT = 4096;
const MAX_TEXT_BYTES = 64 * 1024;
const IDENTITY_KEYS = new Set(["kind", "runId", "delegationId", "sessionPath", "cwd", "pid", "processStartedAt"]);
const ASSIGNMENT_KEYS = new Set([
  "runId",
  "projectAlias",
  "delegationId",
  "delegation",
  "request",
  "prepared",
  "reservation",
  "role",
  "task",
  "brief",
  "budget",
  "remediationTurns",
]);
const DEFAULT_AGENT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".pi", "agents");
const DEFAULT_CHILD_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".pi", "extensions", "workflow-delegation-child.ts");

function fail(message) {
  throw new TypeError(message);
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value;
}

function assertExactKeys(value, allowed, context) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${context} contains unsupported field ${key}`);
  }
}

function assertString(value, context, { limit = MAX_SHORT_TEXT, absolute = false } = {}) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${context} must be a bounded non-empty string`);
  }
  if (absolute && !isAbsolute(value)) fail(`${context} must be an absolute path`);
  return value;
}

function assertBoolean(value, context) {
  if (typeof value !== "boolean") fail(`${context} must be a boolean`);
  return value;
}

function assertRunId(value) {
  if (typeof value !== "string" || !RUN_ID_RE.test(value)) fail("runId must be a path-safe UUID");
  return value.toLowerCase();
}

function equalList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function ensureContained(root, target, context) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rel = relative(normalizedRoot, normalizedTarget);
  if (rel.startsWith("..") || rel === "" || rel.split("/").includes("..")) {
    fail(`${context} must remain inside the run directory`);
  }
  return normalizedTarget;
}

function assertAbsolutePath(value, context) {
  return resolve(assertString(value, context, { absolute: true }));
}

function assertTransportIdentity(value) {
  const identity = assertObject(value, "transport identity");
  assertExactKeys(identity, IDENTITY_KEYS, "transport identity");
  if (identity.kind !== "pi-delegation") fail("transport identity kind is unsupported");
  return Object.freeze({
    kind: "pi-delegation",
    runId: assertString(identity.runId, "transport identity runId", { limit: 128 }),
    delegationId: assertString(identity.delegationId, "transport identity delegationId", { limit: 128 }),
    sessionPath: assertAbsolutePath(identity.sessionPath, "transport identity sessionPath"),
    cwd: assertAbsolutePath(identity.cwd, "transport identity cwd"),
    pid: assertString(String(identity.pid), "transport identity pid", { limit: 128 }),
    processStartedAt: assertString(identity.processStartedAt, "transport identity processStartedAt", { limit: 128 }),
  });
}

function assertPrompt(value, context = "Pi delegation prompt") {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    fail(`${context} must be bounded valid text`);
  }
  return value;
}

function assertSpawnResult(value) {
  const result = assertObject(value, "spawn result");
  return {
    pid: assertString(String(result.pid), "spawn result pid", { limit: 128 }),
    startedAt: assertString(result.startedAt, "spawn result startedAt", { limit: 128 }),
  };
}

function assertInspection(value) {
  if (value === null || value === undefined) return null;
  const inspection = assertObject(value, "process inspection");
  assertExactKeys(inspection, new Set(["pid", "startedAt", "cwd", "active"]), "process inspection");
  return {
    pid: assertString(String(inspection.pid), "process inspection pid", { limit: 128 }),
    startedAt: assertString(inspection.startedAt, "process inspection startedAt", { limit: 128 }),
    cwd: assertAbsolutePath(inspection.cwd, "process inspection cwd"),
    active: assertBoolean(inspection.active, "process inspection active"),
  };
}

function bootstrapPrompt({ roleDefinition, delegationId, generation, cwd, briefPath, task, brief }) {
  const prompt = [
    roleDefinition.systemPrompt,
    `Delegation ID: ${delegationId}`,
    `Generation: ${generation}`,
    `Working directory: ${cwd}`,
    `Frozen brief path: ${briefPath}`,
    "Task:",
    task,
    "Frozen brief:",
    brief,
    'When you are done, submit exactly one bounded result with workflow_delegation_handoff.',
  ].join("\n\n");
  return assertPrompt(prompt, "Pi delegation bootstrap text");
}

function runDirectoryFor(stateRoot, runId) {
  const root = assertAbsolutePath(stateRoot, "stateRoot");
  return ensureContained(root, join(root, assertRunId(runId)), "run directory");
}

function sessionPaths(runDirectory, delegationId) {
  const directory = ensureContained(runDirectory, join(runDirectory, "delegations", assertString(delegationId, "delegationId", { limit: 128 })), "session directory");
  const sessionPath = ensureContained(runDirectory, join(directory, "pi-session.jsonl"), "session path");
  return { sessionDirectory: directory, sessionPath };
}

function safeEnv({ runId, delegationId, generation, runDirectory, stateRoot, controlPlaneBin }) {
  return Object.freeze({
    WORKFLOW_RUN_ID: runId,
    WORKFLOW_DELEGATION_ID: delegationId,
    WORKFLOW_DELEGATION_GENERATION: String(generation),
    WORKFLOW_RUN_DIR: runDirectory,
    WORKFLOW_STATE_ROOT: stateRoot,
    WORKFLOW_CONTROL_PLANE_BIN: controlPlaneBin,
  });
}

function launchArgv({ sessionPath, sessionDirectory, childExtensionPath, tools, bootstrap }) {
  return Object.freeze([
    "--session", sessionPath,
    "--session-dir", sessionDirectory,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--extension", childExtensionPath,
    "--tools", tools.join(","),
    bootstrap,
  ]);
}

function launchIdentity({ runId, delegationId, sessionPath, cwd, pid, startedAt }) {
  return Object.freeze({
    kind: "pi-delegation",
    runId,
    delegationId,
    sessionPath,
    cwd,
    pid,
    processStartedAt: startedAt,
  });
}

function assignmentContext(approvedAssignment, { stateRoot, controlPlaneBin }) {
  const assignment = assertObject(approvedAssignment, "approved assignment");
  assertExactKeys(assignment, ASSIGNMENT_KEYS, "approved assignment");
  if (Object.hasOwn(assignment, "env")) fail("approved assignment env is not allowed");
  const runId = assertRunId(assignment.runId);
  const delegationId = assertString(assignment.delegationId, "delegationId", { limit: 128 });
  const delegation = assertObject(assignment.delegation, "delegation");
  const request = assertObject(assignment.request, "delegation request");
  const role = assertObject(assignment.role, "delegation role");
  const roleName = assertString(role.name, "delegation role name", { limit: 128 });
  const roleTools = Array.isArray(role.tools)
    ? role.tools.map((tool, index) => assertString(tool, `delegation role tools[${index}]`, { limit: 128 }))
    : fail("delegation role tools must be an array");
  const cwd = assertAbsolutePath(delegation.cwd ?? request.cwd, "delegation cwd");
  const runDirectory = runDirectoryFor(stateRoot, runId);
  const briefPath = ensureContained(runDirectory, assertAbsolutePath(delegation.briefPath, "delegation briefPath"), "delegation briefPath");
  const generation = delegation.generation;
  if (!Number.isInteger(generation) || generation < 1) fail("delegation generation must be a positive integer");
  if (assertString(delegation.id, "delegation id", { limit: 128 }) !== delegationId) fail("delegation id must match the approved assignment");
  if (assertString(delegation.parentRunId, "delegation parentRunId", { limit: 128 }) !== runId) fail("delegation runId must match the approved assignment");
  if (assertString(delegation.role, "delegation role", { limit: 128 }) !== roleName || assertString(request.agent, "delegation request agent", { limit: 128 }) !== roleName) {
    fail("delegation role must match the approved request and loaded role");
  }
  if (assertAbsolutePath(request.cwd, "delegation request cwd") !== cwd) fail("delegation cwd must match the approved request cwd");
  if (request.worktree !== false) fail("delegation request worktree must remain disabled");
  const expectedAsync = delegation.mode === "background";
  if (assertBoolean(request.async, "delegation request async") !== expectedAsync) fail("delegation mode must match the approved request");
  return {
    runId,
    delegationId,
    roleName,
    roleTools,
    runDirectory,
    stateRoot: assertAbsolutePath(stateRoot, "stateRoot"),
    controlPlaneBin: assertAbsolutePath(controlPlaneBin, "controlPlaneBin"),
    cwd,
    briefPath,
    generation,
    task: assertPrompt(assignment.task, "delegation task"),
    brief: assertPrompt(assignment.brief, "delegation brief"),
  };
}

async function roleDefinitionFor({ loadDelegationRole, fs, agentDirectory, roleName, roleTools }) {
  const definition = await loadDelegationRole({ name: roleName, agentDirectory, fs });
  if (!equalList(definition.tools, roleTools)) fail("delegation role tools must match the managed role loader");
  return definition;
}

export function createPiDelegationTransport({
  spawnChild,
  inspectProcess,
  fs = defaultFs,
  piCommand = "pi",
  childExtensionPath = DEFAULT_CHILD_EXTENSION_PATH,
  agentDirectory = DEFAULT_AGENT_DIRECTORY,
  stateRoot,
  controlPlaneBin,
  loadDelegationRole = defaultLoadDelegationRole,
} = {}) {
  if (typeof spawnChild !== "function") fail("spawnChild is required");
  if (typeof inspectProcess !== "function") fail("inspectProcess is required");
  if (!fs || typeof fs.readFile !== "function" || typeof fs.readdir !== "function" || typeof fs.realpath !== "function") {
    fail("fs must provide readFile(), readdir(), and realpath()");
  }
  if (typeof loadDelegationRole !== "function") fail("loadDelegationRole is required");

  const command = assertString(piCommand, "piCommand", { limit: 512 });
  const resolvedStateRoot = assertAbsolutePath(stateRoot, "stateRoot");
  const resolvedControlPlaneBin = assertAbsolutePath(controlPlaneBin, "controlPlaneBin");
  const resolvedChildExtensionPath = assertAbsolutePath(childExtensionPath, "childExtensionPath");
  if (resolvedChildExtensionPath.startsWith("npm:")) fail("childExtensionPath must be a local path");
  const resolvedAgentDirectory = assertAbsolutePath(agentDirectory, "agentDirectory");
  const launches = new Map();

  async function start(approvedAssignment) {
    const context = assignmentContext(approvedAssignment, {
      stateRoot: resolvedStateRoot,
      controlPlaneBin: resolvedControlPlaneBin,
    });
    const roleDefinition = await roleDefinitionFor({
      loadDelegationRole,
      fs,
      agentDirectory: resolvedAgentDirectory,
      roleName: context.roleName,
      roleTools: context.roleTools,
    });
    const { sessionDirectory, sessionPath } = sessionPaths(context.runDirectory, context.delegationId);
    const env = safeEnv({
      runId: context.runId,
      delegationId: context.delegationId,
      generation: context.generation,
      runDirectory: context.runDirectory,
      stateRoot: resolvedStateRoot,
      controlPlaneBin: resolvedControlPlaneBin,
    });
    const argv = launchArgv({
      sessionPath,
      sessionDirectory,
      childExtensionPath: resolvedChildExtensionPath,
      tools: roleDefinition.tools,
      bootstrap: bootstrapPrompt({
        roleDefinition,
        delegationId: context.delegationId,
        generation: context.generation,
        cwd: context.cwd,
        briefPath: context.briefPath,
        task: context.task,
        brief: context.brief,
      }),
    });
    const spawned = assertSpawnResult(await spawnChild({ command, argv, cwd: context.cwd, env }));
    const identity = launchIdentity({
      runId: context.runId,
      delegationId: context.delegationId,
      sessionPath,
      cwd: context.cwd,
      pid: spawned.pid,
      startedAt: spawned.startedAt,
    });
    launches.set(`${context.runId}:${context.delegationId}`, {
      runId: context.runId,
      delegationId: context.delegationId,
      cwd: context.cwd,
      sessionPath,
      sessionDirectory,
      generation: context.generation,
      tools: [...roleDefinition.tools],
      identity,
    });
    return { identity };
  }

  async function observeExact(requestedIdentity) {
    const identity = assertTransportIdentity(requestedIdentity);
    const observed = assertInspection(await inspectProcess(identity));
    if (!observed) return { state: "missing", identity };
    if (observed.pid !== identity.pid || observed.startedAt !== identity.processStartedAt || observed.cwd !== identity.cwd) {
      return {
        state: "mismatch",
        identity,
        details: {
          observedPid: observed.pid,
          observedStartedAt: observed.startedAt,
          observedCwd: observed.cwd,
          observedActive: String(observed.active),
        },
      };
    }
    return { state: observed.active ? "active" : "idle", identity };
  }

  async function deliverFollowUp(requestedIdentity, prompt) {
    const identity = assertTransportIdentity(requestedIdentity);
    const observation = await observeExact(identity);
    if (observation.state === "active") fail("exact worker is still active");
    if (observation.state === "mismatch") fail("exact worker identity no longer matches the recorded session");
    const key = `${identity.runId}:${identity.delegationId}`;
    const existing = launches.get(key);
    if (!existing || existing.identity.sessionPath !== identity.sessionPath) {
      fail("exact delegation session is unknown to this transport instance");
    }
    const generation = existing.generation + 1;
    const env = safeEnv({
      runId: identity.runId,
      delegationId: identity.delegationId,
      generation,
      runDirectory: runDirectoryFor(resolvedStateRoot, identity.runId),
      stateRoot: resolvedStateRoot,
      controlPlaneBin: resolvedControlPlaneBin,
    });
    const argv = launchArgv({
      sessionPath: identity.sessionPath,
      sessionDirectory: existing.sessionDirectory,
      childExtensionPath: resolvedChildExtensionPath,
      tools: existing.tools,
      bootstrap: assertPrompt(prompt),
    });
    const spawned = assertSpawnResult(await spawnChild({ command, argv, cwd: existing.cwd, env }));
    const nextIdentity = launchIdentity({
      runId: identity.runId,
      delegationId: identity.delegationId,
      sessionPath: identity.sessionPath,
      cwd: existing.cwd,
      pid: spawned.pid,
      startedAt: spawned.startedAt,
    });
    launches.set(key, { ...existing, generation, identity: nextIdentity });
    return { delivered: true, identity: nextIdentity };
  }

  async function requestGracefulClose(requestedIdentity) {
    assertTransportIdentity(requestedIdentity);
    return { requested: false, manual: true };
  }

  return Object.freeze({ start, observeExact, deliverFollowUp, requestGracefulClose });
}
