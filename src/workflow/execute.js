import { basename, resolve } from "node:path";
import { WorkflowError } from "./errors.js";
import { buildHarnessLaunch } from "./harnesses.js";

function fail(category, message, details, exitCode = 1) {
  throw new WorkflowError(category, message, { details, exitCode });
}

function findOperation(plan, id) {
  return plan.operations.find((operation) => operation.id === id) ?? null;
}

function startCommandHint(plan) {
  const feature = plan.identity?.feature;
  return [
    "workflow start",
    plan.identity?.projectAlias,
    plan.identity?.task,
    feature ? `--feature ${JSON.stringify(feature)}` : null,
    "--yes",
  ].filter(Boolean).join(" ");
}

function runtimeCommandHint(plan) {
  const feature = plan.identity?.feature;
  return [
    "workflow runtime",
    plan.identity?.projectAlias,
    plan.identity?.task,
    feature ? `--feature ${JSON.stringify(feature)}` : null,
    plan.runtime?.profileName ? `--profile ${plan.runtime.profileName}` : null,
    "--yes",
  ].filter(Boolean).join(" ");
}

function recoveryGuidance(plan, error) {
  const rerun = startCommandHint(plan);
  return [
    `Inspect the preserved workspace at ${plan.workspace?.path} before rerunning.`,
    `Rerun the same start flow after fixing the issue: ${rerun}`,
    `Failure detail: ${error.message}`,
  ];
}

function runtimeRecoveryGuidance(plan, error) {
  const rerun = runtimeCommandHint(plan);
  return [
    `Inspect the preserved workspace at ${plan.workspace?.path} before rerunning runtime processes.`,
    `Rerun the same runtime flow after fixing the issue: ${rerun}`,
    `Failure detail: ${error.message}`,
  ];
}

function reusableStatus(value) {
  return value === "compatible" || value === "open";
}

function hasStartConflict(plan) {
  return plan.status === "conflict"
    || (plan.conflicts?.length ?? 0) > 0
    || plan.operations
      .filter((operation) => operation.phase === "start")
      .some((operation) => operation.reconciliation?.status === "conflict");
}

function buildOperationReport(operation, status, extra = {}) {
  return {
    id: operation.id,
    kind: operation.kind,
    status,
    ...extra,
  };
}

function ensureStartablePlan(plan) {
  if (plan?.mode !== "ordinary" && plan?.mode !== "group") {
    fail("PREFLIGHT", "executeStart only supports ordinary and group workflow execution", { mode: plan?.mode }, 10);
  }
}

function ensureNoConflicts(plan) {
  if (hasStartConflict(plan)) {
    fail("CONFLICT", "Cannot execute a conflicted workflow plan", { conflicts: plan.conflicts ?? [] }, 11);
  }
}

function worktreeReportStatus(result) {
  if (result?.disposition === "created") return "created";
  if (result?.disposition === "opened") return "opened";
  return "reused";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function hydrateAgentProfile(plan) {
  const agent = plan.agent ?? {};
  const profile = agent.profile && typeof agent.profile === "object" ? agent.profile : {};
  const harness = agent.harness ?? profile.harness ?? "pi";
  return {
    harness,
    command: agent.command ?? profile.command ?? harness,
    mode: profile.mode ?? "interactive",
    roles: Array.isArray(agent.roles) ? agent.roles : ["implementer"],
    model: profile.model ?? null,
    arguments: Array.isArray(profile.arguments) ? profile.arguments : [],
    ...(harness === "claude" || profile.permission_mode !== undefined ? { permission_mode: profile.permission_mode ?? "manual" } : {}),
    ...(harness === "codex" || profile.sandbox !== undefined ? { sandbox: profile.sandbox ?? "workspace-write" } : {}),
    ...(harness === "codex" || profile.approval_policy !== undefined ? { approval_policy: profile.approval_policy ?? "on-request" } : {}),
  };
}

function listValue(value, key) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : [];
}

function getWorkspaceId(value) {
  return value?.workspace_id ?? value?.workspaceId ?? null;
}

function getTabId(value) {
  return value?.tab_id ?? value?.tabId ?? null;
}

function getPaneId(value) {
  return value?.pane_id ?? value?.paneId ?? null;
}

function getWorkspacePath(value) {
  return value?.worktree?.checkout_path ?? value?.cwd ?? value?.path ?? null;
}

function commandExecutable(command) {
  if (typeof command !== "string") return null;
  return command.trim().split(/\s+/u)[0] ?? null;
}

const AGENT_START_KINDS = new Set(["agent.session.start", "pi.session.start"]);
const AGENT_HARNESSES = new Set(["pi", "claude", "codex", "opencode"]);

function normalizeAgentHarness(value, context) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    fail("PREFLIGHT", `${context} must be one of pi, claude, codex, or opencode`, { [context]: value }, 10);
  }
  const normalized = value.toLowerCase();
  if (!AGENT_HARNESSES.has(normalized)) {
    fail("PREFLIGHT", `Unsupported agent harness ${value}`, { [context]: value }, 10);
  }
  return normalized;
}

function commandAgentHarness(command) {
  const executable = commandExecutable(command);
  if (!executable) return null;
  const harness = basename(executable).toLowerCase();
  return AGENT_HARNESSES.has(harness) ? harness : null;
}

function agentStartOperation(plan) {
  return findOperation(plan, "agent")
    ?? plan.operations?.find((operation) => AGENT_START_KINDS.has(operation.kind))
    ?? null;
}

function validateAgentStartIdentity(plan) {
  const operation = agentStartOperation(plan);
  if (!operation) return;
  if (!AGENT_START_KINDS.has(operation.kind)) {
    fail("PREFLIGHT", `Unsupported agent operation kind ${operation.kind}`, {
      operationId: operation.id ?? null,
      operationKind: operation.kind ?? null,
    }, 10);
  }

  const agent = plan.agent ?? {};
  const profile = agent.profile && typeof agent.profile === "object" ? agent.profile : {};
  const agentHarness = normalizeAgentHarness(agent.harness, "agent.harness");
  const profileHarness = normalizeAgentHarness(profile.harness, "agent.profile.harness");
  if (agentHarness && profileHarness && agentHarness !== profileHarness) {
    fail("PREFLIGHT", "Agent harness and profile harness disagree", {
      agentHarness,
      profileHarness,
      operationKind: operation.kind,
    }, 10);
  }

  const expectedHarness = agentHarness ?? profileHarness;
  const commandHarnesses = [
    commandAgentHarness(agent.command),
    commandAgentHarness(profile.command),
    commandAgentHarness(operation.command),
  ].filter(Boolean);
  const distinctCommandHarnesses = [...new Set(commandHarnesses)];
  if (distinctCommandHarnesses.length > 1) {
    fail("PREFLIGHT", "Agent command identities disagree", {
      agentCommand: agent.command ?? null,
      profileCommand: profile.command ?? null,
      operationCommand: operation.command ?? null,
      commandHarnesses: distinctCommandHarnesses,
    }, 10);
  }

  const commandHarness = distinctCommandHarnesses[0] ?? null;
  if (!expectedHarness) {
    if (operation.kind === "pi.session.start") {
      if (commandHarness && commandHarness !== "pi") {
        fail("PREFLIGHT", "Legacy Pi session start cannot use a non-Pi command without an explicit harness", {
          operationKind: operation.kind,
          command: operation.command ?? agent.command ?? profile.command ?? null,
          commandHarness,
        }, 10);
      }
      return;
    }

    fail("PREFLIGHT", "agent.session.start requires an explicit agent harness", {
      operationKind: operation.kind,
      command: operation.command ?? agent.command ?? profile.command ?? null,
      commandHarness,
    }, 10);
  }

  if (operation.kind === "pi.session.start" && expectedHarness !== "pi") {
    fail("PREFLIGHT", "Legacy pi.session.start operations must use the Pi harness", {
      operationKind: operation.kind,
      expectedHarness,
    }, 10);
  }

  if (commandHarness && commandHarness !== expectedHarness) {
    fail("PREFLIGHT", "Agent harness and command disagree", {
      expectedHarness,
      commandHarness,
      agentCommand: agent.command ?? null,
      profileCommand: profile.command ?? null,
      operationCommand: operation.command ?? null,
    }, 10);
  }
}

function processInfoCommand(processInfo) {
  if (typeof processInfo?.command === "string" && processInfo.command) return processInfo.command;
  if (typeof processInfo?.command_line === "string" && processInfo.command_line) return processInfo.command_line;
  if (typeof processInfo?.cmdline === "string" && processInfo.cmdline) return processInfo.cmdline;
  if (Array.isArray(processInfo?.argv) && processInfo.argv.length > 0) return processInfo.argv.join(" ");
  if (Array.isArray(processInfo?.command_argv) && processInfo.command_argv.length > 0) return processInfo.command_argv.join(" ");
  return null;
}

function processInfoExecutable(processInfo) {
  if (typeof processInfo?.executable === "string" && processInfo.executable) return processInfo.executable;
  if (typeof processInfo?.exe === "string" && processInfo.exe) return processInfo.exe;
  if (typeof processInfo?.binary === "string" && processInfo.binary) return processInfo.binary;
  if (Array.isArray(processInfo?.argv) && processInfo.argv.length > 0) return processInfo.argv[0];
  if (Array.isArray(processInfo?.command_argv) && processInfo.command_argv.length > 0) return processInfo.command_argv[0];
  return null;
}

function processInfoRunning(processInfo) {
  if (!processInfo) return false;
  if (processInfo.running === false) return false;
  if (typeof processInfo.state === "string" && ["stopped", "exited", "dead"].includes(processInfo.state)) return false;
  if (processInfo.exitCode !== undefined || processInfo.exit_code !== undefined) return false;
  return Boolean(processInfo.running === true || processInfoCommand(processInfo) || processInfoExecutable(processInfo));
}

function matchesExecutable(expectedCommand, processInfo) {
  const actual = processInfoExecutable(processInfo);
  if (!actual) return true;
  const expected = commandExecutable(expectedCommand);
  if (!expected) return false;
  return basename(actual) === basename(expected);
}

function matchesProcessIdentity(expectedCommand, processInfo) {
  return processInfoRunning(processInfo)
    && processInfoCommand(processInfo) === expectedCommand
    && matchesExecutable(expectedCommand, processInfo);
}

const DEFAULT_RUNTIME_OBSERVE_MS = 1000;
const RUNTIME_OBSERVE_INTERVAL_MS = 25;

async function observePaneProcess(herdr, paneId, expectedCommand, observeMs = 0) {
  if (typeof herdr?.getPaneProcessInfo !== "function") {
    fail("PREFLIGHT", "executeRuntime requires Herdr pane process-info inspection", { paneId }, 10);
  }

  const windowMs = Math.max(0, Number.isFinite(observeMs) ? observeMs : 0);
  const deadline = Date.now() + windowMs;
  let lastProcessInfo = null;
  let finalPollAfterDeadlinePending = windowMs > 0;

  while (true) {
    lastProcessInfo = await herdr.getPaneProcessInfo(paneId);
    if (!expectedCommand || matchesProcessIdentity(expectedCommand, lastProcessInfo)) {
      return lastProcessInfo;
    }

    if (Date.now() >= deadline) {
      if (finalPollAfterDeadlinePending) {
        finalPollAfterDeadlinePending = false;
        continue;
      }
      return lastProcessInfo;
    }

    const remainingMs = deadline - Date.now();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(RUNTIME_OBSERVE_INTERVAL_MS, remainingMs)));
  }
}

function runtimeProcessCwd(plan, process) {
  return resolve(plan.runtime.worktreePath, process.cwd ?? ".");
}

function runtimeTab(plan) {
  return plan.tabs?.find((item) => item.label === plan.runtime?.tabLabel) ?? null;
}

function runtimeTabId(plan) {
  return getTabId(runtimeTab(plan)?.actual) ?? null;
}

function runtimePaneId(process) {
  return getPaneId(process?.actual?.[0]) ?? null;
}

function runtimeFailureReason(process, processInfo) {
  if (!processInfo) {
    return `Runtime process ${process.id} stopped before process-info could confirm it`;
  }
  const exitCode = processInfo.exitCode ?? processInfo.exit_code;
  if (exitCode !== undefined || processInfo.state === "exited") {
    return `Runtime process ${process.id} exited immediately${exitCode === undefined ? "" : ` with exit code ${exitCode}`}`;
  }
  if (!processInfoRunning(processInfo)) {
    return `Runtime process ${process.id} is not running`;
  }
  return `Runtime process ${process.id} has mismatched executable or command evidence`;
}

function paneHarness(pane) {
  return pane?.agent ?? pane?.agent_session?.agent ?? pane?.agentSession?.agent ?? null;
}

function matchesExpectedHarnessPane(pane, expectedHarness) {
  return paneHarness(pane) === expectedHarness;
}

function isIdleBootstrapPane(pane) {
  if (!pane) return false;
  if (pane.agent || pane.agent_session || pane.agent_status) return false;
  if (pane.command || pane.foreground_command || pane?.process?.command) return false;
  return true;
}

function readKnownOpenContext(worktreeOperation) {
  const reconciliation = worktreeOperation.reconciliation ?? {};
  return {
    workspaceId: getWorkspaceId(reconciliation.workspace),
    tabId: getTabId(reconciliation.tab),
    paneId: getPaneId(reconciliation.root_pane),
    disposition: "already_open",
  };
}

async function ensureWorktreeStart(worktreeOperation, herdr) {
  const reconciliation = worktreeOperation.reconciliation ?? {};

  if (reconciliation.status === "open") {
    return {
      result: readKnownOpenContext(worktreeOperation),
      status: "reused",
      mutated: false,
    };
  }

  if (reconciliation.status === "missing" || reconciliation.status === "closed") {
    const result = await herdr.ensureNativeWorktree(worktreeOperation);
    return {
      result,
      status: worktreeReportStatus(result),
      mutated: true,
    };
  }

  if (reconciliation.status === "compatible") {
    return {
      result: null,
      status: "reused",
      mutated: false,
    };
  }

  fail("PREFLIGHT", "Unsupported worktree reconciliation state for executeStart", {
    status: reconciliation.status,
    operation: worktreeOperation,
  }, 10);
}

function resolveAgentTabId(plan, fallbackTabId) {
  const tab = plan.tabs?.find((item) => item.label === plan.agent.tabLabel);
  const actualTabId = getTabId(tab?.actual);
  return actualTabId ?? fallbackTabId ?? null;
}

function resolveAgentTabPaneId(plan, fallbackPaneId) {
  const tab = plan.tabs?.find((item) => item.label === plan.agent.tabLabel);
  const actualPaneId = getPaneId(tab?.actual);
  return actualPaneId ?? fallbackPaneId ?? null;
}

function ensureStartShape({ herdr, worktreeOperation, workspaceOperation, agentTabOperation, agentOperation }) {
  if (!herdr) {
    fail("PREFLIGHT", "executeStart requires a Herdr adapter", {}, 10);
  }
  if (typeof herdr.ensureNativeWorktree !== "function"
    || typeof herdr.renameTab !== "function"
    || typeof herdr.splitPane !== "function"
    || typeof herdr.startAgent !== "function") {
    fail("PREFLIGHT", "executeStart requires Herdr worktree, tab, split, and agent methods", {}, 10);
  }
  if (!worktreeOperation || !workspaceOperation || !agentTabOperation || !agentOperation) {
    fail("PREFLIGHT", "executeStart requires ordinary start operations for worktree, workspace, agent-tab, and agent", {
      worktreeOperation,
      workspaceOperation,
      agentTabOperation,
      agentOperation,
    }, 10);
  }
}

function ensureRuntimeShape({ plan, herdr, runtimeTabOperation, runtimeOperation }) {
  if (!herdr) {
    fail("PREFLIGHT", "executeRuntime requires a Herdr adapter", {}, 10);
  }
  if (typeof herdr.createTab !== "function"
    || typeof herdr.renamePane !== "function"
    || typeof herdr.splitPane !== "function"
    || typeof herdr.runInPane !== "function"
    || typeof herdr.getPaneProcessInfo !== "function") {
    fail("PREFLIGHT", "executeRuntime requires Herdr tab, pane, run, and process-info methods", {}, 10);
  }
  if (!runtimeTabOperation || !runtimeOperation || !plan?.runtime) {
    fail("PREFLIGHT", "executeRuntime requires runtime tab and runtime operations", {
      runtimeTabOperation,
      runtimeOperation,
      runtime: plan?.runtime,
    }, 10);
  }
  if (plan.workspace?.status !== "compatible" || !isNonEmptyString(getWorkspaceId(plan.workspace?.actual))) {
    fail("PREFLIGHT", "executeRuntime requires an open compatible Herdr workspace", {
      workspace: plan.workspace,
    }, 10);
  }
}

function buildInitialReport(plan) {
  return {
    mode: plan.mode,
    status: "completed",
    operations: [],
    guidance: [],
    notes: [],
    processes: [],
    repositories: [],
  };
}

function appendSkipped(report, operations, completedIds) {
  for (const operation of operations) {
    if (completedIds.has(operation.id)) continue;
    report.operations.push(buildOperationReport(operation, "skipped"));
  }
}

async function resolveBootstrapContext(plan, worktreeOperation, ensured, herdr) {
  const known = ensured.result ?? {};
  if (isNonEmptyString(known.workspaceId) && isNonEmptyString(known.tabId) && isNonEmptyString(known.paneId)) {
    return known;
  }

  if (typeof herdr.listWorkspaces !== "function"
    || typeof herdr.listTabs !== "function"
    || typeof herdr.listPanes !== "function") {
    fail("PREFLIGHT", "Open workspace recovery requires Herdr workspace, tab, and pane inspection methods", {
      result: known,
    }, 10);
  }

  const workspaces = listValue(await herdr.listWorkspaces(), "workspaces");
  const expectedPath = plan.workspace?.path ?? worktreeOperation.path;
  const exactById = isNonEmptyString(known.workspaceId)
    ? workspaces.find((workspace) => getWorkspaceId(workspace) === known.workspaceId)
    : null;
  const byPath = workspaces.filter((workspace) => getWorkspacePath(workspace) === expectedPath);
  const workspace = exactById ?? (byPath.length === 1 ? byPath[0] : null);

  if (!workspace) {
    fail("PREFLIGHT", "Could not resolve the preserved Herdr workspace for start recovery", {
      workspaceId: known.workspaceId,
      expectedPath,
      workspaces,
    }, 10);
  }

  const workspaceId = getWorkspaceId(workspace);
  if (!isNonEmptyString(workspaceId) || getWorkspacePath(workspace) !== expectedPath) {
    fail("PREFLIGHT", "Recovered Herdr workspace does not match the planned worktree path", {
      workspace,
      expectedPath,
    }, 10);
  }

  const tabs = listValue(await herdr.listTabs({ workspaceId }), "tabs");
  const tabId = known.tabId
    ?? workspace.active_tab_id
    ?? (tabs.length === 1 ? getTabId(tabs[0]) : null);

  if (!isNonEmptyString(tabId)) {
    fail("PREFLIGHT", "Could not resolve the preserved Herdr root tab for start recovery", {
      workspace,
      tabs,
    }, 10);
  }

  const panes = listValue(await herdr.listPanes({ workspaceId }), "panes");
  const tabPanes = panes.filter((pane) => getTabId(pane) === tabId);
  const paneId = known.paneId
    ?? (tabPanes.length === 1 ? getPaneId(tabPanes[0]) : null);

  if (!isNonEmptyString(paneId)) {
    fail("PREFLIGHT", "Could not resolve the preserved Herdr root pane for start recovery", {
      workspace,
      tabs,
      panes,
      tabId,
    }, 10);
  }

  return {
    workspaceId,
    tabId,
    paneId,
    disposition: known.disposition,
  };
}

// A fixture supervisor is an ordinary process, not an interactive harness, so Herdr
// cannot attach it with `agent start --kind <harness>`. Run it in the prepared pane
// instead and report the same shape an attached agent would produce.
// Herdr's `agent start` blocks until the agent reports "ready", up to this timeout. Under load an
// interactive Pi (model init + extensions) can take a while, so keep this generous — a spurious
// readiness timeout used to fail the whole launch and drop the transport identity.
const AGENT_START_TIMEOUT_MS = 90000;

async function startAgentProcess({ herdr, plan, launch, paneId, tabId }) {
  if (launch.supervisor === true) {
    if (typeof herdr.runInPane !== "function") {
      fail("PREFLIGHT", "Starting a workflow supervisor requires a Herdr adapter with runInPane", { paneId }, 10);
    }
    await herdr.runInPane({ paneId, argv: launch.argv });
    return { agentId: null, tabId, paneId };
  }

  try {
    return await herdr.startAgent({
      name: plan.agent.agentName,
      paneId,
      kind: plan.agent.harness ?? "pi",
      argv: launch.argv,
      timeout: AGENT_START_TIMEOUT_MS,
    });
  } catch (error) {
    // Herdr's readiness wait can time out even though Pi actually started (the pane + session
    // exist) — it was just slow to report ready under load. Losing the launch to that also drops
    // the transport identity, permanently breaking resume/close. If the agent is present in the
    // pane we started it in, treat it as started so the identity is still captured. Any other
    // failure (or a truly absent agent) propagates unchanged.
    const recovered = await recoverStartedAgent({ herdr, error, paneId, tabId });
    if (recovered) return recovered;
    throw error;
  }
}

function isAgentStartupTimeout(error) {
  return /timed out waiting for agent startup/iu.test(String(error?.message ?? ""));
}

async function recoverStartedAgent({ herdr, error, paneId, tabId }) {
  if (!isAgentStartupTimeout(error) || typeof herdr.listAgents !== "function") return null;
  let agents;
  try {
    agents = listValue(await herdr.listAgents(), "agents");
  } catch {
    return null;
  }
  const match = agents.find((agent) => getPaneId(agent) === paneId);
  if (!match) return null;
  return {
    agentId: match.agentId ?? match.agent_id ?? null,
    tabId: getTabId(match) ?? tabId,
    paneId,
  };
}

async function verifyCloseSafety({ herdr, workspaceId, expectedTabId, bootstrapPaneId, startedAgent, expectedHarness }) {
  if (typeof herdr.listTabs !== "function" || typeof herdr.listPanes !== "function") {
    return false;
  }

  const tabs = listValue(await herdr.listTabs({ workspaceId }), "tabs");
  const panes = listValue(await herdr.listPanes({ workspaceId }), "panes");

  const startedTabExists = tabs.some((tab) => getTabId(tab) === startedAgent.tabId && getWorkspaceId(tab) === workspaceId);
  const startedPane = panes.find((pane) => (
    getPaneId(pane) === startedAgent.paneId
      && getTabId(pane) === startedAgent.tabId
      && getWorkspaceId(pane) === workspaceId
  ));
  const bootstrapPane = panes.find((pane) => (
    getPaneId(pane) === bootstrapPaneId
      && getTabId(pane) === expectedTabId
      && getWorkspaceId(pane) === workspaceId
  ));

  if (!startedTabExists) return false;
  if (startedAgent.tabId !== expectedTabId) return false;
  if (!startedPane || !matchesExpectedHarnessPane(startedPane, expectedHarness)) return false;
  if (!bootstrapPane || !isIdleBootstrapPane(bootstrapPane)) return false;
  if (getPaneId(bootstrapPane) === getPaneId(startedPane)) return false;
  return true;
}

function childAliasFromOperation(operation) {
  if (operation?.id?.startsWith("child-worktree:")) return operation.id.slice("child-worktree:".length);
  if (operation?.id?.startsWith("child-tab:")) return operation.id.slice("child-tab:".length);
  return null;
}

function findRepository(plan, alias) {
  return plan.repositories?.find((repository) => repository.alias === alias) ?? null;
}

function repositoryReport(repository, status, extra = {}) {
  return {
    alias: repository.alias,
    branch: repository.branch,
    worktreePath: repository.worktreePath,
    status,
    ...extra,
  };
}

function resolveTabId(plan, label, fallbackTabId = null) {
  const tab = plan.tabs?.find((item) => item.label === label);
  return getTabId(tab?.actual) ?? fallbackTabId ?? null;
}

async function ensureMetaRepositoryReady(metaWorktreeOperation, git) {
  if (typeof git?.inspectRepository !== "function") {
    fail("PREFLIGHT", "executeStart requires Git repository inspection for group workflows", {}, 10);
  }

  try {
    await git.inspectRepository({ cwd: metaWorktreeOperation.cwd });
  } catch (error) {
    fail("PREFLIGHT", `Acme meta repository is missing or invalid at ${metaWorktreeOperation.cwd}`, {
      cwd: metaWorktreeOperation.cwd,
      reason: error.message,
      guidance: [
        `Clone or restore the meta repository at ${metaWorktreeOperation.cwd}.`,
        "Then rerun the same workflow start command.",
      ],
    }, 10);
  }
}

function ensureGroupStartShape({ git, herdr, metaWorktreeOperation, coordinatorTabOperation, childWorktreeOperations, childTabOperations, agentOperation }) {
  if (!git) {
    fail("PREFLIGHT", "executeStart requires a Git adapter for group workflows", {}, 10);
  }
  if (!herdr) {
    fail("PREFLIGHT", "executeStart requires a Herdr adapter", {}, 10);
  }
  if (typeof git.createWorktree !== "function" || typeof git.inspectRepository !== "function") {
    fail("PREFLIGHT", "executeStart requires Git worktree creation and repository inspection for group workflows", {}, 10);
  }
  if (typeof herdr.ensureNativeWorktree !== "function"
    || typeof herdr.renameTab !== "function"
    || typeof herdr.createTab !== "function"
    || typeof herdr.splitPane !== "function"
    || typeof herdr.startAgent !== "function") {
    fail("PREFLIGHT", "executeStart requires Herdr worktree, tab, split, and agent methods", {}, 10);
  }
  if (!metaWorktreeOperation || !coordinatorTabOperation || !agentOperation || childWorktreeOperations.length === 0 || childTabOperations.length === 0) {
    fail("PREFLIGHT", "executeStart requires group start operations for meta worktree, child worktrees, coordinator tab, child tabs, and agent", {
      metaWorktreeOperation,
      coordinatorTabOperation,
      childWorktreeOperations,
      childTabOperations,
      agentOperation,
    }, 10);
  }
}

async function executeOrdinaryStart(plan, { herdr, buildAgentLaunch }) {
  const report = buildInitialReport(plan);
  const startOperations = plan.operations.filter((operation) => operation.phase === "start");
  const completedIds = new Set();
  const worktreeOperation = findOperation(plan, "worktree");
  const workspaceOperation = findOperation(plan, "workspace");
  const agentTabOperation = findOperation(plan, "agent-tab");
  const agentOperation = findOperation(plan, "agent");

  ensureStartShape({ herdr, worktreeOperation, workspaceOperation, agentTabOperation, agentOperation });

  let ensured;
  let bootstrapContext = null;
  let bootstrapCreatedFromReturnedRootPane = false;
  let currentOperation = worktreeOperation;

  try {
    ensured = await ensureWorktreeStart(worktreeOperation, herdr);
    bootstrapContext = ensured.result ?? null;
    bootstrapCreatedFromReturnedRootPane = Boolean(ensured.mutated);

    report.operations.push(buildOperationReport(worktreeOperation, ensured.status));
    completedIds.add(worktreeOperation.id);

    const workspaceStatus = reusableStatus(worktreeOperation.reconciliation?.status)
      ? "reused"
      : ensured.status;
    report.operations.push(buildOperationReport(workspaceOperation, workspaceStatus));
    completedIds.add(workspaceOperation.id);

    let agentTabStatus = "reused";
    let agentTabId = resolveAgentTabId(plan, bootstrapContext?.tabId ?? null);
    let agentTabPaneId = resolveAgentTabPaneId(plan, bootstrapContext?.paneId ?? null);

    if (agentTabOperation.reconciliation?.status !== "compatible") {
      currentOperation = agentTabOperation;
      if (!agentTabId || !agentTabPaneId) {
        bootstrapContext = await resolveBootstrapContext(plan, worktreeOperation, ensured, herdr);
        agentTabId = bootstrapContext.tabId;
        agentTabPaneId = bootstrapContext.paneId;
      }
      await herdr.renameTab({ tabId: agentTabId, label: plan.agent.tabLabel });
      agentTabStatus = "created";
    }

    report.operations.push(buildOperationReport(agentTabOperation, agentTabStatus, { tabId: agentTabId, paneId: agentTabPaneId }));
    completedIds.add(agentTabOperation.id);

    if (agentOperation.reconciliation?.status === "compatible") {
      report.operations.push(buildOperationReport(agentOperation, "reused"));
      completedIds.add(agentOperation.id);
      return report;
    }

    currentOperation = agentOperation;
    const launch = buildAgentLaunch({
      profileName: plan.agent.profileName ?? "pi-worker",
      profile: hydrateAgentProfile(plan),
      sessionName: plan.agent.sessionName,
      cwd: plan.agent.worktreePath,
      run: plan.run ?? null,
    });
    const agentPane = await herdr.splitPane({
      paneId: agentTabPaneId,
      direction: "down",
      cwd: plan.agent.worktreePath,
      env: launch.env,
      focus: false,
    });
    const startedAgent = await startAgentProcess({
      herdr,
      plan,
      launch,
      paneId: agentPane.paneId,
      tabId: agentTabId,
    });

    const workspaceId = bootstrapContext?.workspaceId ?? ensured.result?.workspaceId ?? null;
    const sessionIdentity = launch.supervisor === true ? null : {
      kind: "pi-session",
      runId: plan.run?.id,
      sessionId: launch.expected?.nativeSessionId ?? null,
      paneId: startedAgent.paneId,
      tabId: startedAgent.tabId,
      workspaceId,
      cwd: plan.agent.worktreePath,
    };

    report.operations.push(buildOperationReport(agentOperation, "created", {
      agentId: startedAgent.agentId,
      tabId: startedAgent.tabId,
      paneId: startedAgent.paneId,
      ...(sessionIdentity ? { sessionIdentity } : {}),
    }));
    completedIds.add(agentOperation.id);

    if (bootstrapCreatedFromReturnedRootPane && typeof herdr.closePane === "function") {
      const bootstrapPaneId = bootstrapContext?.paneId ?? ensured.result?.paneId ?? null;
      const expectedTabId = agentTabId ?? bootstrapContext?.tabId ?? ensured.result?.tabId ?? null;
      let canClose = false;

      if (isNonEmptyString(workspaceId)
        && isNonEmptyString(bootstrapPaneId)
        && isNonEmptyString(expectedTabId)
        && isNonEmptyString(startedAgent?.paneId)) {
        try {
          canClose = await verifyCloseSafety({
            herdr,
            workspaceId,
            expectedTabId,
            bootstrapPaneId,
            startedAgent,
          expectedHarness: plan.agent.harness ?? "pi",
          });
        } catch (error) {
          report.notes.push(`Retained the bootstrap shell pane because the post-start close safety inspection failed: ${error.message}`);
        }
      }

      if (canClose) {
        await herdr.closePane({ paneId: bootstrapPaneId });
      } else if (report.notes.length === 0) {
        report.notes.push("Retained the bootstrap shell pane because the close safety checks did not pass.");
      }
    } else if (bootstrapContext?.paneId ?? ensured.result?.paneId) {
      report.notes.push("Retained the bootstrap shell pane because the close safety checks did not pass.");
    }

    return report;
  } catch (error) {
    report.status = report.operations.length > 0 ? "partial" : "failed";
    if (error instanceof WorkflowError && error.category === "CONFLICT") throw error;

    const failedOperation = currentOperation && !completedIds.has(currentOperation.id)
      ? currentOperation
      : [agentTabOperation, agentOperation, workspaceOperation, worktreeOperation]
        .find((operation) => operation && !completedIds.has(operation.id));

    if (failedOperation) {
      report.operations.push(buildOperationReport(failedOperation, "failed", { error: error.message }));
      completedIds.add(failedOperation.id);
    }

    appendSkipped(report, startOperations, completedIds);
    report.guidance = recoveryGuidance(plan, error);
    report.error = {
      name: error.name,
      message: error.message,
    };
    return report;
  }
}

async function executeGroupStart(plan, { git, herdr, buildAgentLaunch }) {
  const report = buildInitialReport(plan);
  const startOperations = plan.operations.filter((operation) => operation.phase === "start");
  const completedIds = new Set();
  const metaWorktreeOperation = findOperation(plan, "meta-worktree");
  const coordinatorTabOperation = findOperation(plan, "coordinator-tab");
  const agentOperation = findOperation(plan, "agent");
  const childWorktreeOperations = startOperations.filter((operation) => operation.id.startsWith("child-worktree:"));
  const childTabOperations = startOperations.filter((operation) => operation.id.startsWith("child-tab:"));

  ensureGroupStartShape({
    git,
    herdr,
    metaWorktreeOperation,
    coordinatorTabOperation,
    childWorktreeOperations,
    childTabOperations,
    agentOperation,
  });

  let ensured;
  let bootstrapContext = null;
  let bootstrapCreatedFromReturnedRootPane = false;
  let currentOperation = metaWorktreeOperation;

  try {
    await ensureMetaRepositoryReady(metaWorktreeOperation, git);

    ensured = await ensureWorktreeStart(metaWorktreeOperation, herdr);
    bootstrapContext = ensured.result ?? null;
    bootstrapCreatedFromReturnedRootPane = Boolean(ensured.mutated);

    report.operations.push(buildOperationReport(metaWorktreeOperation, ensured.status));
    completedIds.add(metaWorktreeOperation.id);

    for (const operation of childWorktreeOperations) {
      currentOperation = operation;
      const alias = childAliasFromOperation(operation);
      const repository = findRepository(plan, alias);
      if (!repository) {
        fail("PREFLIGHT", `Unknown Acme repository for operation ${operation.id}`, { operation }, 10);
      }

      if (operation.reconciliation?.status === "compatible") {
        report.operations.push(buildOperationReport(operation, "reused"));
        report.repositories.push(repositoryReport(repository, "reused"));
        completedIds.add(operation.id);
        continue;
      }

      if (operation.reconciliation?.status !== "missing") {
        fail("PREFLIGHT", `Unsupported child worktree reconciliation state for ${alias}`, {
          operation,
          status: operation.reconciliation?.status,
        }, 10);
      }

      await git.createWorktree({
        cwd: operation.cwd,
        path: operation.path,
        branch: operation.branch,
        base: operation.base,
        reconciliation: operation.reconciliation,
      });

      report.operations.push(buildOperationReport(operation, "created"));
      report.repositories.push(repositoryReport(repository, "created"));
      completedIds.add(operation.id);
    }

    let coordinatorTabId = resolveTabId(plan, plan.agent.tabLabel, bootstrapContext?.tabId ?? null);
    let coordinatorTabPaneId = getPaneId(plan.tabs?.find((item) => item.label === plan.agent.tabLabel)?.actual) ?? bootstrapContext?.paneId ?? null;
    let coordinatorTabStatus = "reused";

    if (coordinatorTabOperation.reconciliation?.status !== "compatible") {
      currentOperation = coordinatorTabOperation;
      if (!coordinatorTabId || !coordinatorTabPaneId) {
        bootstrapContext = await resolveBootstrapContext(plan, metaWorktreeOperation, ensured, herdr);
        coordinatorTabId = bootstrapContext.tabId;
        coordinatorTabPaneId = bootstrapContext.paneId;
      }
      await herdr.renameTab({ tabId: coordinatorTabId, label: plan.agent.tabLabel });
      coordinatorTabStatus = "created";
    }

    report.operations.push(buildOperationReport(coordinatorTabOperation, coordinatorTabStatus, { tabId: coordinatorTabId, paneId: coordinatorTabPaneId }));
    completedIds.add(coordinatorTabOperation.id);

    let workspaceId = bootstrapContext?.workspaceId ?? ensured.result?.workspaceId ?? getWorkspaceId(plan.workspace?.actual);
    if (!isNonEmptyString(workspaceId) || !isNonEmptyString(coordinatorTabId)) {
      bootstrapContext = await resolveBootstrapContext(plan, metaWorktreeOperation, ensured, herdr);
      workspaceId = bootstrapContext.workspaceId;
      coordinatorTabId ??= bootstrapContext.tabId;
      coordinatorTabPaneId ??= bootstrapContext.paneId;
    }

    for (const operation of childTabOperations) {
      currentOperation = operation;
      const alias = childAliasFromOperation(operation);
      const repository = findRepository(plan, alias);
      if (!repository) {
        fail("PREFLIGHT", `Unknown Acme repository for operation ${operation.id}`, { operation }, 10);
      }

      if (operation.reconciliation?.status === "compatible") {
        report.operations.push(buildOperationReport(operation, "reused", { tabId: resolveTabId(plan, alias) }));
        completedIds.add(operation.id);
        continue;
      }

      const createdTab = await herdr.createTab({
        workspaceId,
        cwd: repository.worktreePath,
        label: alias,
        focus: false,
      });

      report.operations.push(buildOperationReport(operation, "created", {
        tabId: createdTab.tabId,
        paneId: createdTab.paneId,
      }));
      completedIds.add(operation.id);
    }

    if (agentOperation.reconciliation?.status === "compatible") {
      report.operations.push(buildOperationReport(agentOperation, "reused"));
      completedIds.add(agentOperation.id);
      return report;
    }

    currentOperation = agentOperation;
    const launch = buildAgentLaunch({
      profileName: plan.agent.profileName ?? "pi-worker",
      profile: hydrateAgentProfile(plan),
      sessionName: plan.agent.sessionName,
      cwd: plan.agent.worktreePath,
      run: plan.run ?? null,
    });
    const agentPane = await herdr.splitPane({
      paneId: coordinatorTabPaneId,
      direction: "down",
      cwd: plan.agent.worktreePath,
      env: launch.env,
      focus: false,
    });
    const startedAgent = await startAgentProcess({
      herdr,
      plan,
      launch,
      paneId: agentPane.paneId,
      tabId: coordinatorTabId,
    });

    const sessionIdentity = launch.supervisor === true ? null : {
      kind: "pi-session",
      runId: plan.run?.id,
      sessionId: launch.expected?.nativeSessionId ?? null,
      paneId: startedAgent.paneId,
      tabId: startedAgent.tabId,
      workspaceId,
      cwd: plan.agent.worktreePath,
    };

    report.operations.push(buildOperationReport(agentOperation, "created", {
      agentId: startedAgent.agentId,
      tabId: startedAgent.tabId,
      paneId: startedAgent.paneId,
      ...(sessionIdentity ? { sessionIdentity } : {}),
    }));
    completedIds.add(agentOperation.id);

    if (bootstrapCreatedFromReturnedRootPane || bootstrapContext?.paneId || ensured.result?.paneId) {
      report.notes.push("Retained the coordinator bootstrap shell pane for manual cross-repository coordination.");
    }

    return report;
  } catch (error) {
    report.status = report.operations.length > 0 ? "partial" : "failed";
    if (error instanceof WorkflowError && (error.category === "CONFLICT" || (error.category === "PREFLIGHT" && report.operations.length === 0))) throw error;

    const failedOperation = currentOperation && !completedIds.has(currentOperation.id)
      ? currentOperation
      : [
          agentOperation,
          ...childTabOperations.slice().reverse(),
          coordinatorTabOperation,
          ...childWorktreeOperations.slice().reverse(),
          metaWorktreeOperation,
        ].find((operation) => operation && !completedIds.has(operation.id));

    if (failedOperation) {
      report.operations.push(buildOperationReport(failedOperation, "failed", { error: error.message }));
      completedIds.add(failedOperation.id);

      const alias = childAliasFromOperation(failedOperation);
      const repository = alias ? findRepository(plan, alias) : null;
      if (repository && !report.repositories.some((item) => item.alias === repository.alias)) {
        report.repositories.push(repositoryReport(repository, "failed", { error: error.message }));
      }
    }

    appendSkipped(report, startOperations, completedIds);
    report.guidance = recoveryGuidance(plan, error);
    report.error = {
      name: error.name,
      message: error.message,
    };
    return report;
  }
}

async function executeRuntimePhase(plan, { herdr, observeMs = DEFAULT_RUNTIME_OBSERVE_MS }) {
  const report = buildInitialReport(plan);
  const runtimeOperations = plan.operations.filter((operation) => operation.phase === "runtime");
  const completedIds = new Set();
  const runtimeTabOperation = findOperation(plan, "runtime-tab");
  const runtimeOperation = findOperation(plan, "runtime");

  ensureRuntimeShape({ plan, herdr, runtimeTabOperation, runtimeOperation });

  let currentOperation = runtimeTabOperation;
  let currentProcessIndex = -1;
  let currentProcess = null;
  let createdRootPaneId = null;
  let anchorPaneId = null;
  let runtimeMutated = false;

  const appendSkippedProcesses = () => {
    const completed = new Set(report.processes.map((process) => process.id));
    for (const process of plan.runtime.processes) {
      if (completed.has(process.id)) continue;
      report.processes.push({ id: process.id, status: "skipped" });
    }
  };

  try {
    let tabId = runtimeTabId(plan);
    if (runtimeTabOperation.reconciliation?.status === "compatible") {
      report.operations.push(buildOperationReport(runtimeTabOperation, "reused", { tabId }));
      completedIds.add(runtimeTabOperation.id);
    } else {
      currentOperation = runtimeTabOperation;
      const createdTab = await herdr.createTab({
        workspaceId: getWorkspaceId(plan.workspace.actual),
        cwd: plan.runtime.worktreePath,
        label: plan.runtime.tabLabel,
        focus: false,
      });
      tabId = createdTab.tabId;
      createdRootPaneId = createdTab.paneId;
      runtimeMutated = true;
      report.operations.push(buildOperationReport(runtimeTabOperation, "created", { tabId, paneId: createdRootPaneId }));
      completedIds.add(runtimeTabOperation.id);
    }

    currentOperation = runtimeOperation;
    for (const [index, process] of plan.runtime.processes.entries()) {
      currentProcessIndex = index;
      currentProcess = process;

      if (process.status === "compatible") {
        const paneId = runtimePaneId(process);
        report.processes.push({ id: process.id, status: "reused", paneId });
        if (isNonEmptyString(paneId)) anchorPaneId = paneId;
        continue;
      }

      let paneId = createdRootPaneId;
      if (createdRootPaneId) {
        createdRootPaneId = null;
      } else {
        if (!isNonEmptyString(anchorPaneId)) {
          fail("PREFLIGHT", `Cannot deterministically place runtime process ${process.id} without a preceding planned pane`, {
            process,
            processes: plan.runtime.processes,
          }, 10);
        }
        const split = await herdr.splitPane({
          paneId: anchorPaneId,
          direction: process.split ?? "right",
          ratio: process.ratio,
          cwd: runtimeProcessCwd(plan, process),
          focus: false,
        });
        paneId = split.paneId;
      }

      await herdr.renamePane({ paneId, label: process.id });
      await herdr.runInPane({ paneId, command: process.command });
      const processInfo = await observePaneProcess(herdr, paneId, process.command, observeMs);

      if (!matchesProcessIdentity(process.command, processInfo)) {
        const reason = runtimeFailureReason(process, processInfo);
        report.processes.push({ id: process.id, status: "failed", paneId, reason });
        appendSkippedProcesses();
        report.status = report.processes.some((item) => item.status === "created" || item.status === "reused") ? "partial" : "failed";
        report.operations.push(buildOperationReport(runtimeOperation, "failed", { processes: report.processes }));
        completedIds.add(runtimeOperation.id);
        report.guidance = runtimeRecoveryGuidance(plan, new Error(reason));
        report.error = { name: "RuntimeObservationError", message: reason };
        return report;
      }

      report.processes.push({ id: process.id, status: "created", paneId });
      anchorPaneId = paneId;
      runtimeMutated = true;
    }

    report.operations.push(buildOperationReport(runtimeOperation, runtimeMutated ? "created" : "reused", {
      processes: report.processes,
      tabId,
    }));
    completedIds.add(runtimeOperation.id);
    return report;
  } catch (error) {
    report.status = report.operations.length > 0 || report.processes.length > 0 ? "partial" : "failed";
    if (error instanceof WorkflowError && error.category === "CONFLICT") throw error;

    if (currentProcess && !report.processes.some((process) => process.id === currentProcess.id)) {
      report.processes.push({
        id: currentProcess.id,
        status: "failed",
        paneId: null,
        reason: error.message,
      });
    }
    appendSkippedProcesses();

    const failedOperation = currentOperation && !completedIds.has(currentOperation.id)
      ? currentOperation
      : [runtimeOperation, runtimeTabOperation].find((operation) => operation && !completedIds.has(operation.id));

    if (failedOperation) {
      report.operations.push(buildOperationReport(failedOperation, "failed", {
        error: error.message,
        ...(failedOperation.id === "runtime" ? { processes: report.processes } : {}),
      }));
      completedIds.add(failedOperation.id);
    }

    appendSkipped(report, runtimeOperations, completedIds);
    report.guidance = runtimeRecoveryGuidance(plan, error);
    report.error = {
      name: error.name,
      message: error.message,
      ...(currentProcessIndex >= 0 ? { processId: currentProcess?.id } : {}),
    };
    return report;
  }
}

export async function executeStart(reconciledPlan, { git, herdr } = {}, { buildAgentLaunch = buildHarnessLaunch } = {}) {
  ensureStartablePlan(reconciledPlan);
  validateAgentStartIdentity(reconciledPlan);
  ensureNoConflicts(reconciledPlan);
  return reconciledPlan.mode === "group"
    ? await executeGroupStart(reconciledPlan, { git, herdr, buildAgentLaunch })
    : await executeOrdinaryStart(reconciledPlan, { herdr, buildAgentLaunch });
}

export async function executeRuntime(reconciledPlan, { herdr, observeMs } = {}) {
  ensureNoConflicts(reconciledPlan);
  return await executeRuntimePhase(reconciledPlan, { herdr, observeMs });
}
