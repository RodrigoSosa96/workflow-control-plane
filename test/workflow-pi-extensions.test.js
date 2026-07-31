import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createPreparedDelegationRequest } from "../src/workflow/coordinator-policy.js";
import { checkoutDigestFor } from "../src/workflow/delegation-invariants.js";
import { createWorkflowDelegationChildExtension } from "../.pi/extensions/workflow-delegation-child.ts";
import { createWorkflowCoordinatorExtension, createWorkflowCoordinatorRuntime } from "../.pi/extensions/workflow-coordinator/index.ts";
import { createSubprocessOwnOwnershipReader } from "../src/workflow/ownership.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const ADOPTABLE_DELEGATION_ID = "33333333-3333-4333-8333-333333333333";
const ORIGIN_SESSION_ID = "pi-origin-1";
const LATER_SESSION_ID = "pi-origin-2";
const CWD = "/fixture/review";
const TASK = "Review the frozen brief.";
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

function createFakePi() {
  const tools = new Map();
  const handlers = new Map();
  const messages = [];
  const entries = [];

  return {
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message, options) {
      messages.push({ message: structuredClone(message), options: structuredClone(options) });
    },
    appendEntry(customType, data) {
      entries.push({ customType, data: structuredClone(data) });
    },
    async emit(event, payload, ctx) {
      const list = handlers.get(event) ?? [];
      let result;
      for (const handler of list) {
        const value = await handler(payload, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
    tool(name) {
      return tools.get(name);
    },
    get toolNames() {
      return [...tools.keys()].sort();
    },
    get messages() {
      return messages;
    },
    get entries() {
      return entries;
    },
  };
}

function createContext({ hasUI = true, isIdle = true, sessionId = ORIGIN_SESSION_ID, confirmed = true, confirmations = [] } = {}) {
  return {
    hasUI,
    isIdle: () => isIdle,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
    ui: {
      async confirm(title, body) {
        confirmations.push({ title, body });
        return confirmed;
      },
      notify() {},
    },
  };
}

function preview() {
  return Object.freeze({
    version: 1,
    runId: RUN_ID,
    projectAlias: "fixture",
    role: "code-reviewer",
    mode: "background",
    originSessionId: ORIGIN_SESSION_ID,
    cwd: CWD,
    task: TASK,
    brief: "Review only the frozen brief.",
    taskDigest: `sha256:${createHash("sha256").update(TASK, "utf8").digest("hex")}`,
    briefDigest: `sha256:${"a".repeat(64)}`,
    budget: Object.freeze({ maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 }),
    remediationTurns: 2,
    tools: Object.freeze(["read", "bash", "grep", "find", "ls"]),
    approvalDigest: `sha256:${"b".repeat(64)}`,
  });
}

test("coordinator live runtime resolves an absolute Pi binary and honors a validated WORKFLOW_PROJECTS_FILE override", async () => {
  const transportCalls = [];
  const services = [];
  const launchCalls = [];
  const registryPath = "/tmp/custom-projects.yaml";

  const runtime = await createWorkflowCoordinatorRuntime({
    env: {
      WORKFLOW_PROJECTS_FILE: registryPath,
      WORKFLOW_STATE_ROOT: "/state/override",
    },
    lookupExecutableImpl: async (name, { env } = {}) => {
      assert.equal(name, "pi");
      assert.equal(env.WORKFLOW_PROJECTS_FILE, registryPath);
      return "/opt/pi/bin/pi";
    },
    loadRegistryImpl: async (path) => {
      assert.equal(path, registryPath);
      return {
        launcher: { state_root: "/state/from-registry" },
        projects: {
          fixture: {
            label: "Fixture Project",
            path: CWD,
            delegation: { remediationTurns: 2 },
          },
        },
      };
    },
    createRunStoreImpl: ({ stateRoot }) => {
      assert.equal(stateRoot, "/state/override");
      return {
        async read(runId) {
          assert.equal(runId, RUN_ID);
          return { id: runId, projectAlias: "fixture" };
        },
      };
    },
    createDelegationStoreImpl: () => ({
      async list() {
        return [];
      },
      async adoptResult() {
        throw new Error("not used");
      },
    }),
    createReservationStoreImpl: ({ stateRoot }) => {
      assert.equal(stateRoot, "/state/override");
      return {};
    },
    createProcessRunnerImpl: () => ({ marker: "runner" }),
    createGitAdapterImpl: ({ runner }) => ({ marker: `git:${runner.marker}` }),
    createHerdrAdapterImpl: ({ runner }) => ({ marker: `herdr:${runner.marker}` }),
    ensureCodexWorkerHooksImpl: async () => {},
    createLaunchCommandImpl: async (options, dependencies) => {
      launchCalls.push({ options, dependencies });
      return { preview: { approvalDigest: `sha256:${"d".repeat(64)}` } };
    },
    createTransportImpl: (options) => {
      transportCalls.push(options);
      return {
        async start() {
          throw new Error("not used");
        },
        async observeExact() {
          return { state: "missing", identity: null };
        },
        async deliverFollowUp() {
          throw new Error("not used");
        },
        async requestGracefulClose() {
          return { requested: false, manual: true };
        },
      };
    },
    createDelegationServicesImpl: (input) => {
      services.push(input);
      return { marker: "services" };
    },
    loadDelegationRoleImpl: async ({ name }) => ({
      name,
      tools: ["read", "bash", "grep", "find", "ls"],
      systemPrompt: "Review only the frozen brief.",
    }),
  });

  assert.equal(transportCalls[0].piCommand, "/opt/pi/bin/pi");
  assert.equal(transportCalls[0].stateRoot, "/state/override");
  assert.equal(typeof transportCalls[0].controlPlaneBin, "string");

  const resolved = await runtime.resolveServicesForRun(RUN_ID);
  assert.equal(resolved.marker, "services");
  assert.equal(services[0].projectAlias, "fixture");

  const command = await runtime.createLaunchCommand({ projectAlias: "fixture", task: "ASANA-123", request: "Review launch wiring." });
  assert.equal(command.preview.approvalDigest, `sha256:${"d".repeat(64)}`);
  assert.equal(launchCalls[0].options.registryPath, registryPath);
  assert.equal(launchCalls[0].options.stateRoot, "/state/override");
  assert.equal(launchCalls[0].dependencies.git.marker, "git:runner");
  assert.equal(launchCalls[0].dependencies.herdr.marker, "herdr:runner");
  assert.equal(typeof launchCalls[0].dependencies.ensureCodexWorkerHooks, "function");

  await assert.rejects(
    () => createWorkflowCoordinatorRuntime({
      env: { WORKFLOW_PROJECTS_FILE: "relative-projects.yaml" },
      lookupExecutableImpl: async () => "/opt/pi/bin/pi",
      loadRegistryImpl: async () => ({ launcher: { state_root: "/state" }, projects: {} }),
      createRunStoreImpl: () => ({ async read() { return { id: RUN_ID, projectAlias: "fixture" }; } }),
      createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
      createReservationStoreImpl: () => ({}),
      createTransportImpl: () => ({ async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} }),
      createDelegationServicesImpl: () => ({}),
      loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
    }),
    /WORKFLOW_PROJECTS_FILE|absolute|registry/i,
  );
});

test("the coordinator runtime builds both mutex-taking stores with one shared readOwnOwnership reader", async () => {
  const runStoreArgs = [];
  const reservationArgs = [];
  const injectedReader = async () => ({ pid: "4242", startedAt: "2024-12-31T00:00:00.000Z" });

  await createWorkflowCoordinatorRuntime({
    env: { WORKFLOW_STATE_ROOT: "/state/override" },
    readOwnOwnership: injectedReader,
    lookupExecutableImpl: async () => "/opt/pi/bin/pi",
    loadRegistryImpl: async () => ({ launcher: { state_root: "/state/override" }, projects: {} }),
    createRunStoreImpl: (args) => { runStoreArgs.push(args); return { async read() { return { id: RUN_ID, projectAlias: "fixture" }; } }; },
    createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
    createReservationStoreImpl: (args) => { reservationArgs.push(args); return {}; },
    createDelegationServicesImpl: () => ({}),
    createTransportImpl: () => ({ async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} }),
    loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
  });

  assert.equal(runStoreArgs[0].readOwnOwnership, injectedReader);
  assert.equal(reservationArgs[0].readOwnOwnership, injectedReader);
});

// The default must be lazy: building a runtime happens on every Pi session start, and the reader
// is memoized per process, so construction itself must spawn nothing.
test("building a coordinator runtime never invokes the ownership reader", async () => {
  let readerCalls = 0;
  await createWorkflowCoordinatorRuntime({
    env: { WORKFLOW_STATE_ROOT: "/state/override" },
    readOwnOwnership: async () => { readerCalls += 1; return null; },
    lookupExecutableImpl: async () => "/opt/pi/bin/pi",
    loadRegistryImpl: async () => ({ launcher: { state_root: "/state/override" }, projects: {} }),
    createRunStoreImpl: () => ({ async read() { return { id: RUN_ID, projectAlias: "fixture" }; } }),
    createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
    createReservationStoreImpl: () => ({}),
    createDelegationServicesImpl: () => ({}),
    createTransportImpl: () => ({ async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} }),
    loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
  });
  assert.equal(readerCalls, 0);
});

// The coordinator's own inspector must keep reporting exactly the startedAt string the rest of
// the repo's pid observation produces: the transport records it at spawn (pi-delegation-transport
// launchIdentity) and compares it in observeExact, and a drift there degrades live children to an
// identity mismatch. Swapping runPsForPid for the shared spawnPsStatus must not move that string.
test("the coordinator's default process inspector reports the same startedAt as the shared subprocess ownership reader, for this live process", async (t) => {
  let capturedInspectProcess;
  await createWorkflowCoordinatorRuntime({
    env: { WORKFLOW_STATE_ROOT: "/state/override" },
    lookupExecutableImpl: async () => "/opt/pi/bin/pi",
    loadRegistryImpl: async () => ({ launcher: { state_root: "/state/override" }, projects: {} }),
    createRunStoreImpl: () => ({ async read() { return { id: RUN_ID, projectAlias: "fixture" }; } }),
    createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
    createReservationStoreImpl: () => ({}),
    createDelegationServicesImpl: () => ({}),
    loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
    createTransportImpl: (options) => {
      capturedInspectProcess = options.inspectProcess;
      return { async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} };
    },
  });

  // Degrade, don't silently pass: on a host without a usable `ps` the reader resolves null
  // (ownership.js swallows it by design). Skip with a named reason rather than asserting on nulls.
  const written = await createSubprocessOwnOwnershipReader()();
  if (!written) {
    t.skip("this host cannot report its own process start time via `ps`");
    return;
  }

  const observed = await capturedInspectProcess({ pid: String(process.pid), cwd: process.cwd() });
  assert.equal(observed.pid, String(process.pid));
  assert.equal(observed.startedAt, written.startedAt);
});

test("child extension stays inert until valid session env, records bounded lifecycle facts, and terminates only after a successful handoff", async () => {
  const pi = createFakePi();
  const submissions = [];
  const extension = createWorkflowDelegationChildExtension({
    env: {},
    async submitHandoff(request) {
      submissions.push(request);
      return { ok: true, path: request.inputPath };
    },
  });

  extension(pi);

  assert.deepEqual(pi.toolNames, ["workflow_delegation_handoff"]);
  assert.equal(pi.entries.length, 0);
  assert.equal(submissions.length, 0);

  await pi.emit("session_start", { reason: "startup" }, createContext());
  assert.equal(pi.entries.length, 0);

  const validPi = createFakePi();
  const validSubmissions = [];
  createWorkflowDelegationChildExtension({
    env: {
      WORKFLOW_RUN_ID: RUN_ID,
      WORKFLOW_DELEGATION_ID: DELEGATION_ID,
      WORKFLOW_DELEGATION_GENERATION: "1",
      WORKFLOW_RUN_DIR: "/state/workflow/11111111-1111-4111-8111-111111111111",
      WORKFLOW_STATE_ROOT: "/state/workflow",
      WORKFLOW_CONTROL_PLANE_BIN: "/control/bin/workflow",
    },
    async submitHandoff(request) {
      validSubmissions.push(request);
      return { ok: true, path: request.inputPath };
    },
  })(validPi);

  await validPi.emit("session_start", { reason: "startup" }, createContext());
  await validPi.emit("before_agent_start", { prompt: "SECRET RAW PROMPT" }, createContext());
  await validPi.emit("agent_settled", {}, createContext());
  await validPi.emit("session_shutdown", { reason: "quit" }, createContext());

  assert.equal(validPi.entries.length, 4);
  assert.doesNotMatch(JSON.stringify(validPi.entries), /SECRET RAW PROMPT/);
  assert.equal(validPi.entries[1].data.promptBytes > 0, true);

  const tool = validPi.tool("workflow_delegation_handoff");
  assert.deepEqual(tool.parameters.properties.status.enum, ["completed", "blocked", "failed"]);
  assert.equal(tool.parameters.additionalProperties, false);

  await assert.rejects(
    () => tool.execute("call-1", {
      status: "pending",
      generation: 1,
      summary: "Nope",
      verification: [],
      concerns: [],
      nextAction: "Wait",
    }, undefined, undefined, createContext()),
    /status|enum|handoff/i,
  );

  const result = await tool.execute("call-2", {
    status: "completed",
    generation: 1,
    summary: "Reviewed scope",
    verification: [{ command: "git diff --check", status: "passed" }],
    concerns: [],
    nextAction: "Await coordinator",
  }, undefined, undefined, createContext());

  assert.equal(validSubmissions.length, 1);
  assert.match(validSubmissions[0].inputPath, new RegExp(`/delegations/${DELEGATION_ID}/handoff-input\\.json$`));
  assert.equal(result.terminate, true);
});

test("coordinator extension registers exact tools, starts its watcher only in session_start, sanitizes advisory results, and allows later-session explicit adoption", async () => {
  const pi = createFakePi();
  const watcherCalls = [];
  const previewValue = preview();
  const confirmations = [];
  const listCalls = [];
  let watcherOptions;

  const advisoryRecord = {
    id: DELEGATION_ID,
    parentRunId: RUN_ID,
    role: "code-reviewer",
    mode: "background",
    originSessionId: ORIGIN_SESSION_ID,
    generation: 1,
    state: "completed",
    result: {
      status: "completed",
      generation: 1,
      summary: "Reviewed scope",
      verification: [{ command: "git diff --check", status: "passed" }],
      concerns: [],
      nextAction: "Await coordinator",
      path: "/state/private/result.json",
      writtenAt: "2025-01-01T00:00:00.000Z",
      consumedBySessionId: ORIGIN_SESSION_ID,
      consumedAt: "2025-01-01T00:00:01.000Z",
      adoptedBySessionId: LATER_SESSION_ID,
      adoptedAt: "2025-01-01T00:00:02.000Z",
    },
  };
  const adoptableRecord = {
    ...structuredClone(advisoryRecord),
    id: ADOPTABLE_DELEGATION_ID,
    result: {
      ...structuredClone(advisoryRecord.result),
      consumedBySessionId: undefined,
      consumedAt: undefined,
      adoptedBySessionId: undefined,
      adoptedAt: undefined,
    },
  };

  const services = {
    async createPreview({ runId, input }) {
      assert.equal(runId, RUN_ID);
      assert.equal(input.originSessionId, ORIGIN_SESSION_ID);
      return previewValue;
    },
    async executeApproved({ preview: approved, approvalDigest }) {
      assert.equal(approved, previewValue);
      assert.equal(approvalDigest, previewValue.approvalDigest);
      return { state: "running", generation: 1, identity: null, resultStatus: null, nextActions: ["await-result"] };
    },
    async beginRemediation({ runId, delegationId, expectedGeneration, reviewEvidence, prompt }) {
      return { runId, delegationId, state: "running", generation: expectedGeneration + 1, reviewEvidence, prompt, nextActions: ["await-result"] };
    },
  };
  const delegations = {
    async list({ originSessionId } = {}) {
      listCalls.push(originSessionId);
      const records = [structuredClone(advisoryRecord), structuredClone(adoptableRecord)];
      return originSessionId ? records.filter((record) => record.originSessionId === originSessionId) : records;
    },
    async adoptResult({ runId, delegationId, originSessionId }) {
      assert.equal(runId, RUN_ID);
      assert.equal(delegationId, ADOPTABLE_DELEGATION_ID);
      assert.equal(originSessionId, LATER_SESSION_ID);
      return {
        ...structuredClone(adoptableRecord),
        result: {
          ...structuredClone(adoptableRecord.result),
          adoptedBySessionId: originSessionId,
          adoptedAt: "2025-01-01T00:00:03.000Z",
          consumedBySessionId: originSessionId,
          consumedAt: "2025-01-01T00:00:03.000Z",
        },
      };
    },
  };

  createWorkflowCoordinatorExtension({
    resolveServicesForRun: async () => services,
    delegations,
    getPreparedSubagentContext: async () => undefined,
    createWatcher(options) {
      watcherOptions = options;
      return {
        start() {
          watcherCalls.push("start");
        },
        stop() {
          watcherCalls.push("stop");
        },
      };
    },
  })(pi);

  assert.deepEqual(pi.toolNames, [
    "workflow_adopt_delegation_result",
    "workflow_delegation_result",
    "workflow_execute_delegation",
    "workflow_execute_launch",
    "workflow_prepare_delegation",
    "workflow_prepare_launch",
    "workflow_remediate_delegation",
  ]);
  assert.deepEqual(watcherCalls, []);

  const ctx = createContext({ confirmations });
  await pi.emit("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(watcherCalls, ["start"]);
  await watcherOptions.onResult({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    role: "code-reviewer",
    generation: 1,
    state: "completed",
    summary: "Reviewed scope",
    verification: [],
    concerns: [],
    nextAction: "Await coordinator",
  });
  assert.deepEqual(pi.messages[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(pi.messages[0].message.content, /Reviewed scope/);

  const prepareTool = pi.tool("workflow_prepare_delegation");
  const executeTool = pi.tool("workflow_execute_delegation");
  const adoptTool = pi.tool("workflow_adopt_delegation_result");
  const remediateTool = pi.tool("workflow_remediate_delegation");
  const resultTool = pi.tool("workflow_delegation_result");

  for (const name of [prepareTool.name, executeTool.name, adoptTool.name, remediateTool.name, resultTool.name]) {
    assert.equal(pi.tool(name).parameters.additionalProperties, false);
  }

  await assert.rejects(
    () => prepareTool.execute("call-1", {
      runId: RUN_ID,
      role: "code-reviewer",
      mode: "background",
      cwd: CWD,
      brief: "Review only the frozen brief.",
      task: TASK,
      budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
      remediationTurns: 2,
    }, undefined, undefined, createContext({ hasUI: false })),
    /ui|confirm/i,
  );

  const prepared = await prepareTool.execute("call-2", {
    runId: RUN_ID,
    role: "code-reviewer",
    mode: "background",
    cwd: CWD,
    brief: "Review only the frozen brief.",
    task: TASK,
    budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
    remediationTurns: 2,
  }, undefined, undefined, ctx);
  assert.equal(prepared.details.approvalDigest, previewValue.approvalDigest);

  const executed = await executeTool.execute("call-3", { approvalDigest: previewValue.approvalDigest }, undefined, undefined, ctx);
  assert.equal(executed.details.state, "running");
  assert.equal(confirmations.length >= 2, true);

  const advisory = await resultTool.execute("call-4", { runId: RUN_ID, delegationId: DELEGATION_ID }, undefined, undefined, createContext({ hasUI: false }));
  assert.deepEqual(advisory.details, {
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    role: "code-reviewer",
    generation: 1,
    state: "completed",
    summary: "Reviewed scope",
    verification: [{ command: "git diff --check", status: "passed" }],
    concerns: [],
    nextAction: "Await coordinator",
  });
  assert.doesNotMatch(JSON.stringify(advisory), /path|writtenAt|consumedBySessionId|consumedAt|adoptedBySessionId|adoptedAt/);

  const adopted = await adoptTool.execute(
    "call-5",
    { runId: RUN_ID, delegationId: ADOPTABLE_DELEGATION_ID },
    undefined,
    undefined,
    createContext({ confirmations: [], sessionId: LATER_SESSION_ID }),
  );
  assert.equal(adopted.details.result.adoptedBySessionId, LATER_SESSION_ID);
  assert.equal(listCalls.includes(undefined), true);

  const remediated = await remediateTool.execute("call-6", {
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    expectedGeneration: 1,
    reviewEvidence: {
      generation: 1,
      summary: "Inside the frozen brief.",
      insideFrozenBrief: true,
    },
    prompt: "Address the approved correction.",
  }, undefined, undefined, ctx);
  assert.equal(remediated.details.generation, 2);

  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(watcherCalls, ["start", "stop", "stop"]);
});

test("coordinator launch tools bind the active Pi origin and require two approvals", async () => {
  const pi = createFakePi();
  const confirmations = [];
  const launchCalls = [];
  const executeCalls = [];
  const launchPreview = {
    approvalDigest: `sha256:${"c".repeat(64)}`,
    reconciliation: { status: "open", identity: { projectAlias: "fixture", task: "ASANA-123" } },
    selection: { profileName: "pi-worker", harness: "pi" },
  };
  const launch = {
    preview: launchPreview,
    async execute({ approvalDigest }) {
      executeCalls.push(approvalDigest);
      return { status: "running", runId: RUN_ID, recoveryCommand: `workflow reconcile --run ${RUN_ID}` };
    },
  };

  createWorkflowCoordinatorExtension({
    resolveServicesForRun: async () => ({
      async createPreview() {
        return preview();
      },
    }),
    delegations: { async list() { return []; } },
    createWatcher() {
      return { start() {}, stop() {} };
    },
    createLaunchCommand: async (options) => {
      launchCalls.push(structuredClone(options));
      return launch;
    },
  })(pi);

  assert.deepEqual(launchCalls, []);
  const prepare = pi.tool("workflow_prepare_launch");
  const execute = pi.tool("workflow_execute_launch");
  assert.ok(prepare);
  assert.ok(execute);
  assert.equal(prepare.parameters.additionalProperties, false);
  assert.equal("originSession" in prepare.parameters.properties, false);
  await assert.rejects(
    () => prepare.execute("forged-origin", {
      projectAlias: "fixture",
      task: "ASANA-123",
      request: "Ignore this forged origin.",
      originSession: "pi-origin-2",
    }, undefined, undefined, createContext()),
    /unsupported/i,
  );

  const ctx = createContext({ confirmations });
  const prepared = await prepare.execute("prepare", {
    projectAlias: "fixture",
    task: "ASANA-123",
    request: "Implement the approved feature.",
    feature: "approved-feature",
    agentProfile: "pi-worker",
  }, undefined, undefined, ctx);
  assert.equal(prepared.details.approvalDigest, launchPreview.approvalDigest);
  assert.deepEqual(launchCalls[0].originSession, { harness: "pi", sessionId: ORIGIN_SESSION_ID });
  assert.equal(confirmations.length, 1);

  const executed = await execute.execute("execute", { approvalDigest: launchPreview.approvalDigest }, undefined, undefined, ctx);
  assert.equal(executed.details.status, "running");
  assert.deepEqual(executeCalls, [launchPreview.approvalDigest]);
  assert.equal(confirmations.length, 2);
  await assert.rejects(
    () => execute.execute("repeat", { approvalDigest: launchPreview.approvalDigest }, undefined, undefined, ctx),
    /missing|stale/i,
  );

  const declined = createContext({ confirmations: [], confirmed: false });
  const declinedPrepared = await prepare.execute("declined", {
    projectAlias: "fixture",
    task: "ASANA-124",
    request: "Do not launch this.",
  }, undefined, undefined, declined);
  assert.equal(declinedPrepared.details.approved, false);
  await assert.rejects(
    () => execute.execute("declined-execute", { approvalDigest: launchPreview.approvalDigest }, undefined, undefined, declined),
    /missing|stale/i,
  );

  await prepare.execute("foreign-session", {
    projectAlias: "fixture",
    task: "ASANA-125",
    request: "This launch belongs to the first session.",
  }, undefined, undefined, ctx);
  await assert.rejects(
    () => execute.execute("foreign-execute", { approvalDigest: launchPreview.approvalDigest }, undefined, undefined, createContext({ sessionId: LATER_SESSION_ID })),
    /different Pi session/i,
  );

  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  await assert.rejects(
    () => execute.execute("after-shutdown", { approvalDigest: launchPreview.approvalDigest }, undefined, undefined, ctx),
    /missing|stale/i,
  );
});

test("coordinator remediation rejects invalid insideFrozenBrief at the extension boundary before confirmation or execution", async () => {
  const pi = createFakePi();
  const confirmations = [];
  let remediationCalls = 0;

  createWorkflowCoordinatorExtension({
    resolveServicesForRun: async () => ({
      async beginRemediation() {
        remediationCalls += 1;
        return { state: "running", generation: 2, nextActions: ["await-result"] };
      },
    }),
    delegations: {
      async list() {
        return [];
      },
      async adoptResult() {
        throw new Error("not used");
      },
    },
    createWatcher() {
      return { start() {}, stop() {} };
    },
  })(pi);

  const remediateTool = pi.tool("workflow_remediate_delegation");
  for (const insideFrozenBrief of [false, "true", 1]) {
    await assert.rejects(
      () => remediateTool.execute("call-invalid", {
        runId: RUN_ID,
        delegationId: DELEGATION_ID,
        expectedGeneration: 1,
        reviewEvidence: {
          generation: 1,
          summary: "Still inside the frozen brief.",
          insideFrozenBrief,
        },
        prompt: "Address the approved correction.",
      }, undefined, undefined, createContext({ confirmations })),
      /insideFrozenBrief|frozen brief|true/i,
    );
  }

  assert.equal(confirmations.length, 0);
  assert.equal(remediationCalls, 0);
});

test("coordinator tool_call blocks only unsafe or unprepared subagent requests and never rewrites input", async () => {
  const pi = createFakePi();
  const prepared = createPreparedDelegationRequest({
    delegation: {
      id: DELEGATION_ID,
      role: "code-reviewer",
      mode: "background",
      cwd: CWD,
      taskDigest: `sha256:${createHash("sha256").update(TASK, "utf8").digest("hex")}`,
      budget: { concurrency: 1, maxRuntimeMs: 60_000 },
      state: "running",
    },
    policy,
  });
  const reservation = {
    state: "active",
    delegationId: DELEGATION_ID,
    // Matches the prepared delegation's role/mode/cwd above: the shared
    // predicate now checks all three plus checkoutDigest, not just the
    // resources list.
    role: "code-reviewer",
    mode: "background",
    checkoutDigest: checkoutDigestFor(CWD),
    resources: ["totalInternal", "readOnlyBackground"],
  };

  createWorkflowCoordinatorExtension({
    resolveServicesForRun: async () => ({
      async createPreview() {
        return preview();
      },
      async executeApproved() {
        return { state: "running", generation: 1, identity: null, resultStatus: null, nextActions: ["await-result"] };
      },
      async beginRemediation() {
        return { state: "running", generation: 2, nextActions: ["await-result"] };
      },
    }),
    delegations: {
      async list() {
        return [];
      },
      async adoptResult() {
        throw new Error("not used");
      },
    },
    async getPreparedSubagentContext() {
      return { prepared, policy, reservation };
    },
    createWatcher() {
      return { start() {}, stop() {} };
    },
  })(pi);

  const handlerCtx = createContext();
  const allowed = {
    toolName: "subagent",
    input: {
      agent: "code-reviewer",
      task: TASK,
      async: true,
      worktree: false,
      cwd: CWD,
      concurrency: 1,
    },
  };
  const allowedBefore = structuredClone(allowed.input);
  assert.equal(await pi.emit("tool_call", allowed, handlerCtx), undefined);
  assert.deepEqual(allowed.input, allowedBefore);

  const blocked = {
    toolName: "subagent",
    input: {
      ...structuredClone(allowed.input),
      worktree: true,
    },
  };
  const blockedBefore = structuredClone(blocked.input);
  const blockedResult = await pi.emit("tool_call", blocked, handlerCtx);
  assert.equal(blockedResult.block, true);
  assert.match(blockedResult.reason, /worktree|prepared|policy/i);
  assert.deepEqual(blocked.input, blockedBefore);

  assert.equal(await pi.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, handlerCtx), undefined);
});
