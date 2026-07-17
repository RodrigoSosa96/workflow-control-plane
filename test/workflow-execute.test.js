import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowError } from "../src/workflow/errors.js";
import { executeStart } from "../src/workflow/execute.js";

const workspacePath = "/repo/.worktrees/ASANA-123-discovered-docs";
const sessionName = "ocr-ASANA-123-discovered-docs";

function buildPlan({
  status = "incomplete",
  conflicts = [],
  worktreeStatus = "missing",
  agentTabStatus = "missing",
  agentStatus = "missing",
  rootTabId = "w1:t1",
  rootPaneId = "w1:p1",
  workspaceId = "w1",
  agentTabActual,
  agentActual,
} = {}) {
  const rootWorkspace = { workspace_id: workspaceId };
  const rootTab = { tab_id: rootTabId, workspace_id: workspaceId, label: "bootstrap" };
  const rootPane = { pane_id: rootPaneId, tab_id: rootTabId, workspace_id: workspaceId };

  return {
    mode: "ordinary",
    status,
    conflicts,
    identity: {
      projectAlias: "ocr",
      projectLabel: "ExampleProject",
      projectKind: "work",
      task: "ASANA-123",
      feature: "Discovered Docs",
      slug: "discovered-docs",
    },
    workspace: {
      kind: "ordinary",
      label: "ASANA-123 discovered-docs",
      path: workspacePath,
    },
    tabs: [
      {
        label: "agent",
        kind: "agent",
        phase: "start",
        worktreePath: workspacePath,
        sessionName,
        status: agentTabStatus,
        actual: agentTabActual ?? (agentTabStatus === "compatible" ? { tab_id: rootTabId, workspace_id: workspaceId, label: "agent" } : null),
      },
    ],
    agent: {
      command: "pi",
      sessionName,
      tabLabel: "agent",
      worktreePath: workspacePath,
      status: agentStatus,
      actual: agentActual ?? (agentStatus === "compatible" ? { agent_id: "a1", tab_id: rootTabId, workspace_id: workspaceId, name: sessionName } : null),
    },
    runtime: {
      profileName: "standard",
      processes: [],
      worktreePath: workspacePath,
      tabLabel: "runtime",
    },
    operations: [
      {
        id: "worktree",
        kind: "herdr.worktree.ensure",
        phase: "start",
        cwd: "/repo/ocr",
        branch: "feature/ASANA-123/discovered-docs",
        base: "dev",
        path: workspacePath,
        label: "ASANA-123 discovered-docs",
        reconciliation: worktreeStatus === "open"
          ? { status: "open", workspace: rootWorkspace, tab: rootTab, root_pane: rootPane }
          : worktreeStatus === "closed"
            ? { status: "closed", reason: "workspace is closed" }
            : worktreeStatus === "compatible"
              ? { status: "compatible" }
              : { status: worktreeStatus, reason: `worktree is ${worktreeStatus}` },
      },
      {
        id: "workspace",
        kind: "herdr.workspace.ensure",
        phase: "start",
        cwd: workspacePath,
        label: "ASANA-123 discovered-docs",
        reconciliation: { status: worktreeStatus === "missing" ? "missing" : "incomplete" },
      },
      {
        id: "agent-tab",
        kind: "herdr.tab.ensure",
        phase: "start",
        cwd: workspacePath,
        label: "agent",
        reconciliation: agentTabStatus === "compatible"
          ? { status: "compatible", actual: { tab_id: rootTabId, workspace_id: workspaceId, label: "agent" } }
          : { status: agentTabStatus, reason: `agent tab is ${agentTabStatus}` },
      },
      {
        id: "agent",
        kind: "pi.session.start",
        phase: "start",
        cwd: workspacePath,
        command: "pi",
        sessionName,
        tabLabel: "agent",
        reconciliation: agentStatus === "compatible"
          ? { status: "compatible", actual: { agent_id: "a1", tab_id: rootTabId, workspace_id: workspaceId, name: sessionName } }
          : { status: agentStatus, reason: `agent is ${agentStatus}` },
      },
    ],
  };
}

function createHerdr(calls, {
  ensureResult = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", disposition: "created" },
  startResult = { agentId: "a1", tabId: "w1:t1", paneId: "w1:p2" },
  failRename = null,
  failStart = null,
} = {}) {
  return {
    async ensureNativeWorktree(operation) {
      calls.push({
        kind: operation.reconciliation.status === "closed" ? "herdr.worktree.open" : "herdr.worktree.create",
        operation,
      });
      return ensureResult;
    },
    async renameTab({ tabId, label }) {
      calls.push({ kind: "herdr.tab.rename", tabId, label });
      if (failRename) throw failRename;
      return { tab_id: tabId, label };
    },
    async startAgent({ name, cwd, tabId, argv, focus }) {
      calls.push({ kind: "herdr.agent.start", name, cwd, tabId, argv, focus });
      if (failStart) throw failStart;
      return startResult;
    },
    async closePane({ paneId }) {
      calls.push({ kind: "herdr.pane.close", paneId });
      return { pane_id: paneId, closed: true };
    },
  };
}

function fakeAdapters(calls, options = {}) {
  return {
    git: {},
    herdr: createHerdr(calls, options),
  };
}

test("creates native worktree and starts a named Pi session without a prompt", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.worktree.create",
    "herdr.tab.rename",
    "herdr.agent.start",
    "herdr.pane.close",
  ]);
  const launch = calls.find((call) => call.kind === "herdr.agent.start");
  assert.deepEqual(launch.argv, ["pi", "--name", sessionName]);
  assert.doesNotMatch(JSON.stringify(calls), /start-feature|implement/i);
  assert.equal(report.status, "completed");
  assert.equal(report.operations.at(-1).status, "created");
});

test("reuses an already-open compatible workspace without mutating anything", async () => {
  const calls = [];
  const report = await executeStart(buildPlan({
    status: "compatible",
    worktreeStatus: "open",
    agentTabStatus: "compatible",
    agentStatus: "compatible",
  }), fakeAdapters(calls));

  assert.deepEqual(calls, []);
  assert.deepEqual(report.operations.map((operation) => operation.status), [
    "reused",
    "reused",
    "reused",
    "reused",
  ]);
});

test("reopens a closed workspace before renaming the bootstrap tab and starting Pi", async () => {
  const calls = [];
  const report = await executeStart(buildPlan({ worktreeStatus: "closed" }), fakeAdapters(calls, {
    ensureResult: { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", disposition: "opened" },
    startResult: { agentId: "a2", tabId: "w2:t1", paneId: "w2:p2" },
  }));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.worktree.open",
    "herdr.tab.rename",
    "herdr.agent.start",
    "herdr.pane.close",
  ]);
  assert.equal(report.operations[0].status, "opened");
});

test("returns recovery guidance and preserves the created worktree when tab preparation fails", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls, {
    failRename: new Error("rename failed"),
  }));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.worktree.create",
    "herdr.tab.rename",
  ]);
  assert.equal(report.status, "partial");
  assert.equal(report.operations.find((operation) => operation.id === "worktree").status, "created");
  assert.equal(report.operations.find((operation) => operation.id === "agent-tab").status, "failed");
  assert.equal(report.operations.find((operation) => operation.id === "agent").status, "skipped");
  assert.match(report.guidance.join("\n"), /rerun|inspect/i);
});

test("recovers on rerun by reusing the open workspace and completing the missing agent setup", async () => {
  const calls = [];
  const report = await executeStart(buildPlan({ worktreeStatus: "open" }), fakeAdapters(calls));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.tab.rename",
    "herdr.agent.start",
  ]);
  assert.deepEqual(report.operations.map((operation) => operation.status), [
    "reused",
    "reused",
    "created",
    "created",
  ]);
});

test("rejects all conflicts before any mutation", async () => {
  const calls = [];

  await assert.rejects(
    executeStart(buildPlan({
      status: "conflict",
      conflicts: [{ resource: "worktree:primary", reason: "wrong repository" }],
      worktreeStatus: "conflict",
    }), fakeAdapters(calls)),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "CONFLICT");
      assert.match(error.message, /conflict/i);
      return true;
    },
  );

  assert.deepEqual(calls, []);
});

test("retains the bootstrap shell when the Pi pane safety condition is not met", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls, {
    startResult: { agentId: "a1", tabId: "w1:t1", paneId: "w1:p1" },
  }));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.worktree.create",
    "herdr.tab.rename",
    "herdr.agent.start",
  ]);
  assert.match(report.notes.join("\n"), /retained|bootstrap shell|safety/i);
});
