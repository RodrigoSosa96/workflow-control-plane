import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowError } from "../src/workflow/errors.js";
import { executeStart, executeRuntime } from "../src/workflow/execute.js";
import { createHerdrAdapter } from "../src/workflow/herdr.js";

const workspacePath = "/repo/.worktrees/ASANA-123-discovered-docs";
const sessionName = "ocr-ASANA-123-discovered-docs";

function cliResult(result, id = "cli:test") {
  return JSON.stringify({ id, result });
}

function fixtureRunner(fixtures = []) {
  const queue = [...fixtures];
  return {
    runner: {
      async run(command, args = [], options = {}) {
        const fixture = queue.shift();
        if (!fixture) {
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        }
        fixture.assert?.({ command, args, options });
        return {
          code: fixture.code ?? 0,
          stdout: fixture.stdout ?? cliResult(fixture.result ?? null),
          stderr: fixture.stderr ?? "",
        };
      },
    },
  };
}

function buildPlan({
  status = "incomplete",
  conflicts = [],
  worktreeStatus = "missing",
  worktreeReconciliation,
  agentTabStatus = "missing",
  agentStatus = "missing",
  rootTabId = "w1:t1",
  rootPaneId = "w1:p1",
  workspaceId = "w1",
  agentTabActual,
  agentActual,
  agentHarness = "pi",
  agentProfileName = "pi-worker",
  agentProfile = { mode: "interactive", model: null, arguments: [] },
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
      command: agentHarness === "pi" ? "pi" : agentHarness,
      sessionName,
      tabLabel: "agent",
      worktreePath: workspacePath,
      profileName: agentProfileName,
      harness: agentHarness,
      roles: ["implementer"],
      profile: agentProfile,
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
        reconciliation: worktreeReconciliation ?? (worktreeStatus === "open"
          ? { status: "open", workspace: rootWorkspace, tab: rootTab, root_pane: rootPane }
          : worktreeStatus === "closed"
            ? { status: "closed", reason: "workspace is closed" }
            : worktreeStatus === "compatible"
              ? { status: "compatible" }
              : { status: worktreeStatus, reason: `worktree is ${worktreeStatus}` }),
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
        kind: agentHarness === "pi" ? "pi.session.start" : "agent.session.start",
        phase: "start",
        cwd: workspacePath,
        command: agentHarness === "pi" ? "pi" : agentHarness,
        sessionName,
        tabLabel: "agent",
        reconciliation: agentStatus === "compatible"
          ? { status: "compatible", actual: { agent_id: "a1", tab_id: rootTabId, workspace_id: workspaceId, name: sessionName } }
          : { status: agentStatus, reason: `agent is ${agentStatus}` },
      },
    ],
  };
}

function buildWorkspaceState({
  workspaceId = "w1",
  tabId = "w1:t1",
  bootstrapPaneId = "w1:p1",
  agentPaneId = "w1:p2",
  agentTabLabel = "agent",
  bootstrapPane = {},
  agentPane = {},
  workspaces,
  tabs,
  panes,
} = {}) {
  return {
    workspaces: workspaces ?? [
      {
        workspace_id: workspaceId,
        active_tab_id: tabId,
        label: "ASANA-123 discovered-docs",
        worktree: {
          checkout_path: workspacePath,
        },
      },
    ],
    tabs: tabs ?? {
      [workspaceId]: [
        { tab_id: tabId, workspace_id: workspaceId, label: agentTabLabel },
      ],
    },
    panes: panes ?? {
      [workspaceId]: [
        {
          pane_id: bootstrapPaneId,
          tab_id: tabId,
          workspace_id: workspaceId,
          cwd: workspacePath,
          foreground_cwd: workspacePath,
          ...bootstrapPane,
        },
        {
          pane_id: agentPaneId,
          tab_id: tabId,
          workspace_id: workspaceId,
          cwd: workspacePath,
          foreground_cwd: workspacePath,
          agent: "pi",
          agent_status: "working",
          ...agentPane,
        },
      ],
    },
  };
}

function createHerdr(calls, {
  ensureResult = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", disposition: "created" },
  startResult = { agentId: "a1", tabId: "w1:t1", paneId: "w1:p2" },
  failRename = null,
  failStart = null,
  failListTabs = null,
  failListPanes = null,
  workspaces,
  tabs,
  panes,
} = {}) {
  const state = buildWorkspaceState({
    workspaceId: ensureResult.workspaceId,
    tabId: ensureResult.tabId,
    bootstrapPaneId: ensureResult.paneId,
    agentPaneId: startResult.paneId,
    workspaces,
    tabs,
    panes,
  });

  return {
    async ensureNativeWorktree(operation) {
      calls.push({
        kind: operation.reconciliation.status === "closed" ? "herdr.worktree.open" : "herdr.worktree.create",
        operation,
      });
      return ensureResult;
    },
    async listWorkspaces() {
      calls.push({ kind: "herdr.workspace.list" });
      return { workspaces: state.workspaces };
    },
    async listTabs({ workspaceId }) {
      calls.push({ kind: "herdr.tab.list", workspaceId });
      if (failListTabs) throw failListTabs;
      return { tabs: state.tabs[workspaceId] ?? [] };
    },
    async listPanes({ workspaceId }) {
      calls.push({ kind: "herdr.pane.list", workspaceId });
      if (failListPanes) throw failListPanes;
      return { panes: state.panes[workspaceId] ?? [] };
    },
    async renameTab({ tabId, label }) {
      calls.push({ kind: "herdr.tab.rename", tabId, label });
      if (failRename) throw failRename;
      return { tab_id: tabId, label };
    },
    async startAgent({ name, cwd, tabId, argv, env, focus }) {
      calls.push({ kind: "herdr.agent.start", name, cwd, tabId, argv, env, focus });
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

function runtimeProcessDefaults() {
  return [
    { id: "infrastructure", command: "pnpm docker:dev", cwd: "." },
    { id: "backend", command: "pnpm dev:api", cwd: ".", split: "right", ratio: 0.35 },
    { id: "frontend", command: "pnpm dev:front", cwd: "apps/front", split: "down", ratio: 0.5 },
  ];
}

function processCwd(process) {
  return process.cwd === "." ? workspacePath : `${workspacePath}/${process.cwd}`;
}

function buildRuntimePlan({
  status,
  conflicts = [],
  workspaceStatus = "compatible",
  workspaceId = "w1",
  runtimeTabStatus = "missing",
  runtimeTabActual,
  runtimeProcesses = runtimeProcessDefaults(),
  runtimeProcessStates = {},
} = {}) {
  const actualTab = runtimeTabActual ?? (runtimeTabStatus === "compatible"
    ? { tab_id: "w1:t9", workspace_id: workspaceId, label: "runtime" }
    : null);
  const processes = runtimeProcesses.map((process, index) => {
    const state = runtimeProcessStates[process.id] ?? {};
    const processStatus = state.status ?? "missing";
    return {
      ...process,
      status: processStatus,
      reason: state.reason ?? `runtime process ${process.id} is ${processStatus}`,
      actual: state.actual ?? (processStatus === "compatible"
        ? [{
            pane_id: `w1:rp${index + 1}`,
            tab_id: actualTab?.tab_id ?? "w1:t9",
            workspace_id: workspaceId,
            label: process.id,
            cwd: processCwd(process),
            foreground_cwd: processCwd(process),
          }]
        : []),
    };
  });
  const runtimeStatus = processes.some((process) => process.status === "conflict")
    ? "conflict"
    : processes.every((process) => process.status === "compatible")
      ? "compatible"
      : "incomplete";
  const planStatus = status ?? (runtimeStatus === "compatible" ? "compatible" : runtimeStatus);

  return {
    mode: "ordinary",
    status: planStatus,
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
      status: workspaceStatus,
      actual: workspaceStatus === "compatible"
        ? {
            workspace_id: workspaceId,
            worktree: {
              checkout_path: workspacePath,
            },
          }
        : null,
    },
    tabs: [
      {
        label: "runtime",
        kind: "runtime",
        phase: "runtime",
        worktreePath: workspacePath,
        profileName: "standard",
        processes,
        status: runtimeTabStatus,
        actual: actualTab,
      },
    ],
    agent: {
      command: "pi",
      sessionName,
      tabLabel: "agent",
      worktreePath: workspacePath,
      profileName: "pi-worker",
      harness: "pi",
      roles: ["implementer"],
      profile: { mode: "interactive", model: null, arguments: [] },
      status: "compatible",
      actual: { agent_id: "a1", tab_id: "w1:t1", workspace_id: workspaceId, name: sessionName },
    },
    runtime: {
      profileName: "standard",
      processes,
      worktreePath: workspacePath,
      tabLabel: "runtime",
      status: runtimeStatus,
      tab: actualTab ? { status: runtimeTabStatus, actual: actualTab } : null,
    },
    operations: [
      {
        id: "runtime-tab",
        kind: "herdr.tab.ensure",
        phase: "runtime",
        cwd: workspacePath,
        label: "runtime",
        reconciliation: runtimeTabStatus === "compatible"
          ? { status: "compatible", actual: actualTab }
          : { status: runtimeTabStatus, reason: `runtime tab is ${runtimeTabStatus}` },
      },
      {
        id: "runtime",
        kind: "workflow.runtime.start",
        phase: "runtime",
        cwd: workspacePath,
        profileName: "standard",
        processes,
        reconciliation: {
          status: runtimeStatus,
          reason: `runtime is ${runtimeStatus}`,
        },
      },
    ],
  };
}

function createRuntimeHerdr(calls, {
  createTabResult = { tabId: "w1:t9", paneId: "w1:p-root" },
  splitResults = [{ paneId: "w1:p2" }, { paneId: "w1:p3" }],
  processInfos = {},
} = {}) {
  const liveProcessInfos = new Map(Object.entries(processInfos));
  const queuedSplits = [...splitResults];

  return {
    async createTab({ workspaceId, cwd, label, focus }) {
      calls.push({ kind: "herdr.tab.create", workspaceId, cwd, label, focus });
      return createTabResult;
    },
    async renamePane({ paneId, label }) {
      calls.push({ kind: "herdr.pane.rename", paneId, label });
      return { pane_id: paneId, label };
    },
    async splitPane({ paneId, direction, ratio, cwd, focus }) {
      calls.push({ kind: "herdr.pane.split", paneId, direction, ratio, cwd, focus });
      return queuedSplits.shift() ?? { paneId: `generated:${calls.length}` };
    },
    async runInPane({ paneId, command }) {
      calls.push({ kind: "herdr.pane.run", paneId, command });
      if (!liveProcessInfos.has(paneId)) {
        liveProcessInfos.set(paneId, {
          running: true,
          executable: command.split(/\s+/u)[0],
          command,
        });
      }
      return { accepted: true };
    },
    async getPaneProcessInfo(paneId) {
      calls.push({ kind: "herdr.pane.process-info", paneId });
      return liveProcessInfos.has(paneId) ? liveProcessInfos.get(paneId) : null;
    },
  };
}

function fakeRuntimeAdapters(calls, options = {}) {
  return {
    herdr: createRuntimeHerdr(calls, options),
  };
}

test("creates native worktree and starts a named Pi session without a prompt", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.worktree.create",
    "herdr.tab.rename",
    "herdr.agent.start",
    "herdr.tab.list",
    "herdr.pane.list",
    "herdr.pane.close",
  ]);
  const launch = calls.find((call) => call.kind === "herdr.agent.start");
  assert.deepEqual(launch.argv, ["pi", "--name", sessionName]);
  assert.doesNotMatch(JSON.stringify(calls), /start-feature|implement/i);
  assert.equal(report.status, "completed");
  assert.equal(report.operations.at(-1).status, "created");
});

test("uses an injected launch builder immediately before Herdr agent start", async () => {
  const calls = [];
  const launchSpec = {
    argv: ["codex", "-C", workspacePath, "Read assignment.md and write result.json."],
    env: { WORKFLOW_RUN_ID: "run-123", WORKFLOW_HARNESS: "codex" },
    expected: { profileName: "codex-worker", harness: "codex", nativeSessionId: null },
  };
  const plan = buildPlan({
    agentHarness: "codex",
    agentProfileName: "codex-worker",
    agentProfile: {
      mode: "interactive",
      model: "gpt-5-codex",
      arguments: [],
      sandbox: "workspace-write",
      approval_policy: "on-request",
    },
  });
  plan.operations = plan.operations.map((operation) => operation.id === "agent"
    ? { ...operation, kind: "agent.session.start", command: "codex" }
    : operation);
  plan.run = { id: "run-123", directory: "/state/run-123", generation: 1 };

  const report = await executeStart(plan, fakeAdapters(calls), {
    buildAgentLaunch(input) {
      calls.push({ kind: "launch.builder", input });
      return launchSpec;
    },
  });

  assert.equal(report.status, "completed");
  assert.deepEqual(calls.map((call) => call.kind).slice(0, 4), [
    "herdr.worktree.create",
    "herdr.tab.rename",
    "launch.builder",
    "herdr.agent.start",
  ]);
  const builderCall = calls.find((call) => call.kind === "launch.builder");
  assert.equal(builderCall.input.profileName, "codex-worker");
  assert.equal(builderCall.input.profile.harness, "codex");
  assert.equal(builderCall.input.sessionName, sessionName);
  assert.equal(builderCall.input.cwd, workspacePath);
  assert.deepEqual(builderCall.input.run, plan.run);

  const launch = calls.find((call) => call.kind === "herdr.agent.start");
  assert.deepEqual(launch.argv, launchSpec.argv);
  assert.deepEqual(launch.env, launchSpec.env);
});

test("accepts an exact OpenCode agent identity before Herdr mutation", async () => {
  const calls = [];
  const plan = buildPlan({
    agentHarness: "opencode",
    agentProfileName: "opencode-worker",
    agentProfile: { mode: "stream-json", model: null, arguments: [], availability: "fixture-only" },
  });
  plan.operations = plan.operations.map((operation) => operation.id === "agent"
    ? { ...operation, kind: "agent.session.start", command: "opencode" }
    : operation);
  const launchSpec = {
    argv: ["opencode", "run", "--format", "json"],
    env: { WORKFLOW_RUN_ID: "run-123", WORKFLOW_HARNESS: "opencode" },
    expected: { profileName: "opencode-worker", harness: "opencode", nativeSessionId: null },
  };

  const report = await executeStart(plan, fakeAdapters(calls), { buildAgentLaunch: () => launchSpec });

  assert.equal(report.status, "completed");
  assert.deepEqual(calls.find((call) => call.kind === "herdr.agent.start").argv, launchSpec.argv);
});

test("rejects a generic Codex start operation without an explicit harness before mutation", async () => {
  const calls = [];
  const plan = buildPlan({
    agentHarness: "codex",
    agentProfileName: "codex-worker",
    agentProfile: {
      mode: "interactive",
      model: "gpt-5-codex",
      arguments: [],
      sandbox: "workspace-write",
      approval_policy: "on-request",
    },
  });
  delete plan.agent.harness;
  plan.operations = plan.operations.map((operation) => operation.id === "agent"
    ? { ...operation, kind: "agent.session.start", command: "codex" }
    : operation);

  await assert.rejects(
    executeStart(plan, fakeAdapters(calls)),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /agent\.session\.start|harness|codex/i);
      return true;
    },
  );

  assert.deepEqual(calls, []);
});

test("rejects an unsupported agent operation kind before any Herdr mutation", async () => {
  const calls = [];
  const plan = buildPlan();
  plan.operations = plan.operations.map((operation) => operation.id === "agent"
    ? { ...operation, kind: "agent.session.attach", command: "pi" }
    : operation);

  await assert.rejects(
    executeStart(plan, fakeAdapters(calls)),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /unsupported|agent|kind/i);
      return true;
    },
  );

  assert.deepEqual(calls, []);
});

test("rejects a generic start operation whose harness and command disagree before mutation", async () => {
  const calls = [];
  const plan = buildPlan({
    agentHarness: "codex",
    agentProfileName: "codex-worker",
    agentProfile: {
      mode: "interactive",
      model: "gpt-5-codex",
      arguments: [],
      sandbox: "workspace-write",
      approval_policy: "on-request",
    },
  });
  plan.agent.command = "claude";
  plan.operations = plan.operations.map((operation) => operation.id === "agent"
    ? { ...operation, kind: "agent.session.start", command: "claude" }
    : operation);

  await assert.rejects(
    executeStart(plan, fakeAdapters(calls)),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /harness|command|codex|claude/i);
      return true;
    },
  );

  assert.deepEqual(calls, []);
});

test("closes the bootstrap shell when the started pane matches the selected non-Pi harness", async () => {
  const calls = [];
  const report = await executeStart(buildPlan({
    agentHarness: "claude",
    agentProfileName: "claude-worker",
    agentProfile: {
      mode: "interactive",
      model: null,
      arguments: [],
      permission_mode: "manual",
    },
  }), fakeAdapters(calls, {
    panes: {
      w1: [
        {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
        },
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
          agent: "claude",
          agent_status: "working",
          agent_session: {
            agent: "claude",
            kind: "path",
            source: "herdr:claude",
            value: "/tmp/claude-session.jsonl",
          },
        },
      ],
    },
  }));

  assert.equal(report.status, "completed");
  assert.equal(calls.some((call) => call.kind === "herdr.pane.close" && call.paneId === "w1:p1"), true);
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
    "herdr.tab.list",
    "herdr.pane.list",
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

test("recovers a partial rerun from live Herdr workspace facts when open reconciliation lacks tab and root pane ids", async () => {
  const calls = [];
  const report = await executeStart(buildPlan({
    worktreeStatus: "open",
    worktreeReconciliation: {
      status: "open",
      workspace: { workspace_id: "w1" },
    },
  }), fakeAdapters(calls, {
    workspaces: [
      {
        workspace_id: "w1",
        active_tab_id: "w1:t7",
        label: "ASANA-123 discovered-docs",
        worktree: {
          checkout_path: workspacePath,
        },
      },
    ],
    tabs: {
      w1: [
        { tab_id: "w1:t7", workspace_id: "w1", label: "bootstrap" },
      ],
    },
    panes: {
      w1: [
        {
          pane_id: "w1:p9",
          tab_id: "w1:t7",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
        },
      ],
    },
  }));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.workspace.list",
    "herdr.tab.list",
    "herdr.pane.list",
    "herdr.tab.rename",
    "herdr.agent.start",
  ]);
  assert.equal(calls.find((call) => call.kind === "herdr.tab.rename").tabId, "w1:t7");
  assert.equal(calls.find((call) => call.kind === "herdr.agent.start").tabId, "w1:t7");
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
    "herdr.tab.list",
    "herdr.pane.list",
  ]);
  assert.match(report.notes.join("\n"), /retained|bootstrap shell|safety/i);
});

test("retains the bootstrap shell when Herdr reports the started Pi pane on the wrong tab", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls, {
    startResult: { agentId: "a1", tabId: "w1:t9", paneId: "w1:p2" },
    tabs: {
      w1: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "agent" },
        { tab_id: "w1:t9", workspace_id: "w1", label: "other" },
      ],
    },
    panes: {
      w1: [
        {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
        },
        {
          pane_id: "w1:p2",
          tab_id: "w1:t9",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
          agent: "pi",
          agent_status: "working",
        },
      ],
    },
  }));

  assert.equal(calls.some((call) => call.kind === "herdr.pane.close"), false);
  assert.match(report.notes.join("\n"), /retained|safety/i);
});

test("retains the bootstrap shell when the started Pi pane is not confirmed in the expected workspace", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls, {
    panes: {
      w1: [
        {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
        },
      ],
    },
  }));

  assert.equal(calls.some((call) => call.kind === "herdr.pane.close"), false);
  assert.match(report.notes.join("\n"), /retained|safety/i);
});

test("retains the bootstrap shell when the started pane belongs to a non-Pi agent", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls, {
    panes: {
      w1: [
        {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
        },
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
          agent: "claude",
          agent_status: "working",
          agent_session: {
            agent: "claude",
            kind: "path",
            source: "herdr:claude",
            value: "/tmp/claude-session.jsonl",
          },
        },
      ],
    },
  }));

  assert.equal(calls.some((call) => call.kind === "herdr.pane.close"), false);
  assert.match(report.notes.join("\n"), /retained|bootstrap shell|safety/i);
});

test("retains the bootstrap shell and still succeeds when post-start close safety inspection fails", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls, {
    failListTabs: new Error("tab inspection failed"),
  }));

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.worktree.create",
    "herdr.tab.rename",
    "herdr.agent.start",
    "herdr.tab.list",
  ]);
  assert.equal(report.status, "completed");
  assert.equal(report.operations.find((operation) => operation.id === "agent").status, "created");
  assert.equal(calls.some((call) => call.kind === "herdr.pane.close"), false);
  assert.match(report.notes.join("\n"), /retained|bootstrap shell|inspection|tab inspection failed/i);
});

test("retains the bootstrap shell when the bootstrap root pane is no longer idle", async () => {
  const calls = [];
  const report = await executeStart(buildPlan(), fakeAdapters(calls, {
    panes: {
      w1: [
        {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
          foreground_command: "vim",
        },
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          cwd: workspacePath,
          foreground_cwd: workspacePath,
          agent: "pi",
          agent_status: "working",
        },
      ],
    },
  }));

  assert.equal(calls.some((call) => call.kind === "herdr.pane.close"), false);
  assert.match(report.notes.join("\n"), /retained|safety/i);
});

test("runtime creates runtime panes from trusted registry commands", async () => {
  const calls = [];
  const report = await executeRuntime(buildRuntimePlan(), { ...fakeRuntimeAdapters(calls), observeMs: 0 });

  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.tab.create",
    "herdr.pane.rename",
    "herdr.pane.run",
    "herdr.pane.process-info",
    "herdr.pane.split",
    "herdr.pane.rename",
    "herdr.pane.run",
    "herdr.pane.process-info",
    "herdr.pane.split",
    "herdr.pane.rename",
    "herdr.pane.run",
    "herdr.pane.process-info",
  ]);
  assert.equal(calls.find((call) => call.kind === "herdr.tab.create").cwd, workspacePath);
  assert.deepEqual(calls.filter((call) => call.kind === "herdr.pane.rename").map((call) => ({ paneId: call.paneId, label: call.label })), [
    { paneId: "w1:p-root", label: "infrastructure" },
    { paneId: "w1:p2", label: "backend" },
    { paneId: "w1:p3", label: "frontend" },
  ]);
  assert.deepEqual(calls.filter((call) => call.kind === "herdr.pane.split").map((call) => ({
    paneId: call.paneId,
    direction: call.direction,
    ratio: call.ratio,
    cwd: call.cwd,
  })), [
    { paneId: "w1:p-root", direction: "right", ratio: 0.35, cwd: workspacePath },
    { paneId: "w1:p2", direction: "down", ratio: 0.5, cwd: `${workspacePath}/apps/front` },
  ]);
  assert.deepEqual(calls.filter((call) => call.kind === "herdr.pane.run").map((call) => call.command), [
    "pnpm docker:dev",
    "pnpm dev:api",
    "pnpm dev:front",
  ]);
  assert.equal(report.status, "completed");
  assert.deepEqual(report.processes.map(({ id, status }) => ({ id, status })), [
    { id: "infrastructure", status: "created" },
    { id: "backend", status: "created" },
    { id: "frontend", status: "created" },
  ]);
});

test("runtime works with the real Herdr adapter process-info contract", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "herdr");
        assert.deepEqual(args, [
          "tab",
          "create",
          "--workspace",
          "w1",
          "--cwd",
          workspacePath,
          "--label",
          "runtime",
          "--no-focus",
        ]);
        assert.deepEqual(options, { allowFailure: true, cwd: workspacePath });
      },
      stdout: cliResult({
        type: "tab_created",
        tab: { tab_id: "w1:t9", workspace_id: "w1", label: "runtime" },
        root_pane: { pane_id: "w1:p-root", tab_id: "w1:t9", workspace_id: "w1" },
      }, "cli:tab:create"),
    },
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "herdr");
        assert.deepEqual(args, ["pane", "rename", "w1:p-root", "api"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ pane_id: "w1:p-root", label: "api" }, "cli:pane:rename"),
    },
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "herdr");
        assert.deepEqual(args, ["pane", "run", "w1:p-root", "pnpm dev:api"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ accepted: true }, "cli:pane:run"),
    },
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "herdr");
        assert.deepEqual(args, ["pane", "process-info", "--pane", "w1:p-root"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "pane_process_info",
        pane: { pane_id: "w1:p-root", tab_id: "w1:t9", workspace_id: "w1" },
        process: {
          running: true,
          executable: "/usr/bin/pnpm",
          command: "pnpm dev:api",
        },
      }, "cli:pane:process-info"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const report = await executeRuntime(buildRuntimePlan({
    runtimeProcesses: [
      { id: "api", command: "pnpm dev:api", cwd: "." },
    ],
  }), { herdr, observeMs: 0 });

  assert.equal(report.status, "completed");
  assert.deepEqual(report.processes.map(({ id, status }) => ({ id, status })), [
    { id: "api", status: "created" },
  ]);
});

test("runtime does a final process-info poll when a transient shell handoff reaches the observe deadline late", async (t) => {
  const calls = [];
  let now = 1_000;
  let processInfoReads = 0;

  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, ms = 0) => {
    now += ms;
    queueMicrotask(() => callback());
    return 0;
  });

  const shellProcessInfo = (paneId) => ({
    running: true,
    executable: "/usr/bin/zsh",
    command: "/usr/bin/zsh",
    argv: ["/usr/bin/zsh"],
    cmdline: "/usr/bin/zsh",
    pane_id: paneId,
    shell_pid: 111,
    foreground_process_group_id: 111,
    foreground_processes: [
      {
        argv: ["/usr/bin/zsh"],
        cmdline: "/usr/bin/zsh",
        cwd: workspacePath,
        name: "zsh",
        pid: 111,
      },
    ],
  });
  const runtimeProcessInfo = (paneId) => ({
    running: true,
    executable: "sleep",
    command: "sleep 10000",
    argv: ["sleep", "10000"],
    cmdline: "sleep 10000",
    pane_id: paneId,
    shell_pid: 111,
    foreground_process_group_id: 222,
    foreground_processes: [
      {
        argv: ["sleep", "10000"],
        cmdline: "sleep 10000",
        cwd: workspacePath,
        name: "sleep",
        pid: 222,
      },
    ],
  });

  const herdr = {
    async createTab({ workspaceId, cwd, label, focus }) {
      calls.push({ kind: "herdr.tab.create", workspaceId, cwd, label, focus });
      return { tabId: "w1:t9", paneId: "w1:p-root" };
    },
    async renamePane({ paneId, label }) {
      calls.push({ kind: "herdr.pane.rename", paneId, label });
      return { pane_id: paneId, label };
    },
    async splitPane() {
      throw new Error("splitPane should not be called for a single runtime process");
    },
    async runInPane({ paneId, command }) {
      calls.push({ kind: "herdr.pane.run", paneId, command });
      return { accepted: true };
    },
    async getPaneProcessInfo(paneId) {
      calls.push({ kind: "herdr.pane.process-info", paneId, read: processInfoReads + 1 });
      processInfoReads += 1;
      if (processInfoReads <= 4) {
        return shellProcessInfo(paneId);
      }
      if (processInfoReads === 5) {
        now = 1_151;
        return shellProcessInfo(paneId);
      }
      return runtimeProcessInfo(paneId);
    },
  };

  const report = await executeRuntime(buildRuntimePlan({
    runtimeProcesses: [
      { id: "sleeper", command: "sleep 10000", cwd: "." },
    ],
  }), { herdr, observeMs: 150 });

  assert.equal(report.status, "completed");
  assert.deepEqual(report.processes.map(({ id, status }) => ({ id, status })), [
    { id: "sleeper", status: "created" },
  ]);
  assert.equal(processInfoReads, 6);
});

test("runtime reuses existing expected processes without duplicate launches", async () => {
  const calls = [];
  const report = await executeRuntime(buildRuntimePlan({
    runtimeTabStatus: "compatible",
    status: "compatible",
    runtimeProcessStates: {
      infrastructure: { status: "compatible" },
      backend: { status: "compatible" },
      frontend: { status: "compatible" },
    },
  }), { ...fakeRuntimeAdapters(calls), observeMs: 0 });

  assert.deepEqual(calls, []);
  assert.equal(report.status, "completed");
  assert.deepEqual(report.processes.map(({ id, status }) => ({ id, status })), [
    { id: "infrastructure", status: "reused" },
    { id: "backend", status: "reused" },
    { id: "frontend", status: "reused" },
  ]);
});

test("runtime rejects mismatched live process conflicts before any mutation", async () => {
  const calls = [];

  await assert.rejects(
    executeRuntime(buildRuntimePlan({
      status: "conflict",
      conflicts: [{ resource: "runtime:backend", reason: "runtime process backend has mismatched command evidence" }],
      runtimeTabStatus: "compatible",
      runtimeProcessStates: {
        infrastructure: { status: "compatible" },
        backend: { status: "conflict", reason: "runtime process backend has mismatched command evidence" },
      },
    }), { ...fakeRuntimeAdapters(calls), observeMs: 0 }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "CONFLICT");
      assert.match(error.message, /conflict/i);
      return true;
    },
  );

  assert.deepEqual(calls, []);
});

test("runtime reports a stopped pane when the observed process never becomes live", async () => {
  const calls = [];
  const report = await executeRuntime(buildRuntimePlan({
    runtimeProcesses: [
      { id: "api", command: "pnpm dev:api", cwd: "." },
    ],
  }), {
    ...fakeRuntimeAdapters(calls, {
      processInfos: {
        "w1:p-root": null,
      },
    }),
    observeMs: 0,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.processes[0].status, "failed");
  assert.match(report.processes[0].reason, /stopped|not running|process-info/i);
  assert.match(report.guidance.join("\n"), /workflow runtime|rerun/i);
});

test("runtime preserves successful siblings when a later process exits immediately", async () => {
  const calls = [];
  const report = await executeRuntime(buildRuntimePlan(), {
    ...fakeRuntimeAdapters(calls, {
      processInfos: {
        "w1:p-root": { running: true, executable: "pnpm", command: "pnpm docker:dev" },
        "w1:p2": { state: "exited", exitCode: 1, executable: "pnpm", command: "pnpm dev:api" },
      },
    }),
    observeMs: 0,
  });

  assert.equal(report.status, "partial");
  assert.deepEqual(report.processes.map(({ id, status }) => ({ id, status })), [
    { id: "infrastructure", status: "created" },
    { id: "backend", status: "failed" },
    { id: "frontend", status: "skipped" },
  ]);
  assert.match(report.processes[1].reason, /exit|stopped/i);
});
