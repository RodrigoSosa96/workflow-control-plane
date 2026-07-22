import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createPreparedDelegationRequest } from "../src/workflow/coordinator-policy.js";
import { createWorkflowDelegationChildExtension } from "../.pi/extensions/workflow-delegation-child.ts";
import { createWorkflowCoordinatorExtension } from "../.pi/extensions/workflow-coordinator/index.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN_SESSION_ID = "pi-origin-1";
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

test("coordinator extension registers exact tools, starts its watcher only in session_start, and injects consumed results as follow-ups", async () => {
  const pi = createFakePi();
  const watcherCalls = [];
  const previewValue = preview();
  const confirmations = [];
  let watcherOptions;

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
    async list({ originSessionId }) {
      assert.equal(originSessionId, ORIGIN_SESSION_ID);
      return [{
        id: DELEGATION_ID,
        parentRunId: RUN_ID,
        role: "code-reviewer",
        mode: "background",
        originSessionId,
        generation: 1,
        state: "completed",
        result: {
          status: "completed",
          generation: 1,
          summary: "Reviewed scope",
          verification: [],
          concerns: [],
          nextAction: "Await coordinator",
        },
      }];
    },
    async adoptResult({ runId, delegationId, originSessionId }) {
      return {
        id: delegationId,
        parentRunId: runId,
        role: "code-reviewer",
        mode: "background",
        originSessionId,
        generation: 1,
        state: "completed",
        result: {
          status: "completed",
          generation: 1,
          summary: "Reviewed scope",
          verification: [],
          concerns: [],
          nextAction: "Await coordinator",
          adoptedBySessionId: originSessionId,
          consumedBySessionId: originSessionId,
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
    "workflow_prepare_delegation",
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
  assert.equal(advisory.details.state, "completed");

  const adopted = await adoptTool.execute("call-5", { runId: RUN_ID, delegationId: DELEGATION_ID }, undefined, undefined, ctx);
  assert.equal(adopted.details.result.adoptedBySessionId, ORIGIN_SESSION_ID);

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
