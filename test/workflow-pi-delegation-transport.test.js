import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPiDelegationTransport } from "../src/workflow/pi-delegation-transport.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDirectory = join(projectRoot, ".pi", "agents");
const childExtensionPath = join(projectRoot, ".pi", "extensions", "workflow-delegation-child.ts");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const STATE_ROOT = "/state/workflow";
const CONTROL_PLANE_BIN = "/control/bin/workflow";
const CWD = "/fixture/review";
const RUN_DIRECTORY = join(STATE_ROOT, RUN_ID);
const SESSION_DIRECTORY = join(RUN_DIRECTORY, "delegations", DELEGATION_ID);
const SESSION_PATH = join(SESSION_DIRECTORY, "pi-session.jsonl");
const BRIEF_PATH = join(SESSION_DIRECTORY, "brief.md");
const ROLE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function assignment(overrides = {}) {
  const delegation = {
    id: DELEGATION_ID,
    parentRunId: RUN_ID,
    role: "sdd-implementer",
    mode: "foreground",
    originSessionId: "pi-origin-1",
    cwd: CWD,
    briefDigest: `sha256:${"a".repeat(64)}`,
    taskDigest: `sha256:${"b".repeat(64)}`,
    budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
    generation: 1,
    state: "claimed",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    briefPath: BRIEF_PATH,
    nativeSession: null,
    transportIdentity: null,
    startFailure: null,
    result: null,
    remediationTurnsUsed: 0,
    remediationTurns: 2,
    ...overrides.delegation,
  };
  const request = {
    agent: delegation.role,
    task: "Implement only the frozen task.",
    async: delegation.mode === "background",
    worktree: false,
    cwd: delegation.cwd,
    concurrency: 1,
    ...overrides.request,
  };
  const role = {
    name: delegation.role,
    tools: [...ROLE_TOOLS],
    ...overrides.role,
  };
  return {
    runId: RUN_ID,
    projectAlias: "fixture",
    delegationId: DELEGATION_ID,
    delegation,
    request,
    prepared: { requestFingerprint: `sha256:${"c".repeat(64)}` },
    reservation: { id: "reservation-1", state: "active" },
    role,
    task: request.task,
    brief: "Follow only the frozen brief and return a bounded report.",
    budget: { ...delegation.budget },
    remediationTurns: delegation.remediationTurns,
    ...overrides,
    delegation,
    request,
    role,
  };
}

function createTransport({ spawnChild, inspectProcess } = {}) {
  return createPiDelegationTransport({
    spawnChild: spawnChild ?? (async () => ({ pid: "12345", startedAt: "2025-01-01T00:10:00.000Z" })),
    inspectProcess: inspectProcess ?? (async () => null),
    fs: realFs,
    piCommand: "pi",
    childExtensionPath,
    agentDirectory,
    stateRoot: STATE_ROOT,
    controlPlaneBin: CONTROL_PLANE_BIN,
  });
}

test("start builds an exact private-session argv, allowlisted env, and identity", async () => {
  const launches = [];
  const transport = createTransport({
    spawnChild: async (launch) => {
      launches.push(structuredClone(launch));
      return { pid: "12345", startedAt: "2025-01-01T00:10:00.000Z" };
    },
  });

  const started = await transport.start(assignment());

  assert.deepEqual(started, {
    identity: {
      kind: "pi-delegation",
      runId: RUN_ID,
      delegationId: DELEGATION_ID,
      sessionPath: SESSION_PATH,
      cwd: CWD,
      pid: "12345",
      processStartedAt: "2025-01-01T00:10:00.000Z",
    },
  });
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.equal(launch.command, "pi");
  assert.equal(launch.cwd, CWD);
  assert.deepEqual(launch.env, {
    WORKFLOW_RUN_ID: RUN_ID,
    WORKFLOW_DELEGATION_ID: DELEGATION_ID,
    WORKFLOW_DELEGATION_GENERATION: "1",
    WORKFLOW_RUN_DIR: RUN_DIRECTORY,
    WORKFLOW_STATE_ROOT: STATE_ROOT,
    WORKFLOW_CONTROL_PLANE_BIN: CONTROL_PLANE_BIN,
  });
  assert.deepEqual(Object.keys(launch.env), [
    "WORKFLOW_RUN_ID",
    "WORKFLOW_DELEGATION_ID",
    "WORKFLOW_DELEGATION_GENERATION",
    "WORKFLOW_RUN_DIR",
    "WORKFLOW_STATE_ROOT",
    "WORKFLOW_CONTROL_PLANE_BIN",
  ]);
  assert.equal(launch.argv.every((value) => typeof value === "string" && value.length > 0), true);
  assert.equal(launch.argv[launch.argv.indexOf("--session") + 1], SESSION_PATH);
  assert.equal(launch.argv[launch.argv.indexOf("--session-dir") + 1], SESSION_DIRECTORY);
  assert.equal(launch.argv[launch.argv.indexOf("--extension") + 1], childExtensionPath);
  assert.equal(launch.argv[launch.argv.indexOf("--tools") + 1], ROLE_TOOLS.join(","));
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve"]) {
    assert.equal(launch.argv.includes(flag), true);
  }
  const commandLine = launch.argv.join(" ");
  for (const forbidden of [
    "--continue",
    "--last",
    "--resume",
    "--fork",
    "--approve",
    "--session-dir ~/.pi",
    "pi-subagents",
    "--dangerously",
    "--extension npm:",
    "sh -c",
  ]) {
    assert.doesNotMatch(commandLine, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const bootstrap = launch.argv.at(-1);
  assert.match(bootstrap, /workflow_delegation_handoff/);
  assert.match(bootstrap, /frozen brief/i);
  assert.match(bootstrap, /Generation: 1/);
  assert.ok(Buffer.byteLength(bootstrap, "utf8") <= 64 * 1024);
});

test("start rejects unsafe paths, mismatches, injected env, unmanaged tools, and oversized bootstrap text before spawn", async () => {
  const launches = [];
  const transport = createTransport({
    spawnChild: async (launch) => {
      launches.push(launch);
      return { pid: "12345", startedAt: "2025-01-01T00:10:00.000Z" };
    },
  });

  await assert.rejects(() => transport.start(assignment({ task: "bad\0task" })), /task|bootstrap|text/i);
  await assert.rejects(() => transport.start(assignment({ delegation: { briefPath: "/tmp/escape.md" } })), /run directory|path|inside/i);
  await assert.rejects(() => transport.start(assignment({ request: { cwd: "relative/path" } })), /cwd|absolute|path/i);
  await assert.rejects(() => transport.start(assignment({ role: { tools: ["read", "bash", "dangerously-run"] } })), /role|tool|managed/i);
  await assert.rejects(() => transport.start(assignment({ env: { PATH: "/tmp/bin", AWS_SECRET_ACCESS_KEY: "secret" } })), /env|PATH|credential|unsupported/i);
  await assert.rejects(
    () => transport.start(assignment({ task: "t".repeat(40 * 1024), brief: "b".repeat(40 * 1024) })),
    /bootstrap|bounded|prompt|text/i,
  );
  await assert.rejects(() => transport.start(assignment({ request: { agent: "scout", cwd: "/other/project" } })), /role|cwd|match/i);
  assert.equal(launches.length, 0);
});

test("observeExact treats any exact live process as active and reserves missing for proven-gone identities", async () => {
  const started = [];
  const inspections = [
    { pid: "12345", startedAt: "2025-01-01T00:10:00.000Z", cwd: CWD, active: true },
    { pid: "12345", startedAt: "2025-01-01T00:10:00.000Z", cwd: CWD, active: false },
    null,
    { pid: "99999", startedAt: "2025-01-01T00:10:00.000Z", cwd: CWD, active: true },
    { pid: "12345", startedAt: "2025-01-01T00:20:00.000Z", cwd: CWD, active: true },
    { pid: "12345", startedAt: "2025-01-01T00:10:00.000Z", cwd: "/other/project", active: true },
  ];
  const transport = createTransport({
    spawnChild: async (launch) => {
      started.push(launch);
      return { pid: "12345", startedAt: "2025-01-01T00:10:00.000Z" };
    },
    inspectProcess: async () => inspections.shift() ?? null,
  });

  const identity = (await transport.start(assignment())).identity;

  assert.equal((await transport.observeExact(identity)).state, "active");
  assert.equal((await transport.observeExact(identity)).state, "active");
  assert.equal((await transport.observeExact(identity)).state, "missing");
  assert.equal((await transport.observeExact(identity)).state, "mismatch");
  assert.equal((await transport.observeExact(identity)).state, "mismatch");
  assert.equal((await transport.observeExact(identity)).state, "mismatch");
  assert.equal(started.length, 1);
});

test("deliverFollowUp rebuilds exact-session remediation from persisted private state in a fresh transport", async () => {
  const launches = [];
  const transport = createTransport({
    spawnChild: async (launch) => {
      launches.push(structuredClone(launch));
      return { pid: "67890", startedAt: "2025-01-01T00:20:00.000Z" };
    },
    inspectProcess: async () => null,
  });

  const delivered = await transport.deliverFollowUp({
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: SESSION_PATH,
    cwd: CWD,
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  }, "Address the approved correction.", {
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    role: "sdd-implementer",
    mode: "foreground",
    cwd: CWD,
    generation: 2,
  });

  assert.deepEqual(delivered, {
    delivered: true,
    identity: {
      kind: "pi-delegation",
      runId: RUN_ID,
      delegationId: DELEGATION_ID,
      sessionPath: SESSION_PATH,
      cwd: CWD,
      pid: "67890",
      processStartedAt: "2025-01-01T00:20:00.000Z",
    },
  });
  const resumedLaunch = launches.at(-1);
  assert.equal(resumedLaunch.argv[resumedLaunch.argv.indexOf("--session") + 1], SESSION_PATH);
  assert.equal(resumedLaunch.argv[resumedLaunch.argv.indexOf("--session-dir") + 1], SESSION_DIRECTORY);
  assert.equal(resumedLaunch.env.WORKFLOW_DELEGATION_GENERATION, "2");
  assert.equal(resumedLaunch.argv.at(-1), "Address the approved correction.");
});


test("deliverFollowUp rejects matching sleeping live identities and mismatches, and only respawns after exact absence", async () => {
  const identity = {
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: SESSION_PATH,
    cwd: CWD,
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  };
  const resume = {
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    role: "sdd-implementer",
    mode: "foreground",
    cwd: CWD,
    generation: 2,
  };

  const sleepingTransport = createTransport({
    inspectProcess: async () => ({ pid: "12345", startedAt: "2025-01-01T00:10:00.000Z", cwd: CWD, active: false }),
  });
  await assert.rejects(
    () => sleepingTransport.deliverFollowUp(identity, "Address the approved correction.", resume),
    /active|exists|exact worker/i,
  );

  const mismatchTransport = createTransport({
    inspectProcess: async () => ({ pid: "99999", startedAt: "2025-01-01T00:20:00.000Z", cwd: CWD, active: false }),
  });
  await assert.rejects(
    () => mismatchTransport.deliverFollowUp(identity, "Address the approved correction.", resume),
    /mismatch|identity|exact/i,
  );

  const missingTransport = createTransport({
    spawnChild: async () => ({ pid: "67890", startedAt: "2025-01-01T00:20:00.000Z" }),
    inspectProcess: async () => null,
  });
  const delivered = await missingTransport.deliverFollowUp(identity, "Address the approved correction.", resume);
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.identity.pid, "67890");
});

test("requestGracefulClose returns manual guidance and never mutates the process", async () => {
  const transport = createTransport();

  assert.deepEqual(await transport.requestGracefulClose({
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: SESSION_PATH,
    cwd: CWD,
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  }), {
    requested: false,
    manual: true,
  });
});
