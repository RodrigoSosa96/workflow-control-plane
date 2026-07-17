import { WorkflowError } from "./errors.js";

function fail(category, message, details, exitCode = 1) {
  throw new WorkflowError(category, message, { details, exitCode });
}

function findOperation(plan, id) {
  return plan.operations.find((operation) => operation.id === id) ?? null;
}

function commandHint(plan) {
  const feature = plan.identity?.feature;
  return [
    "workflow start",
    plan.identity?.projectAlias,
    plan.identity?.task,
    feature ? `--feature ${JSON.stringify(feature)}` : null,
    "--yes",
  ].filter(Boolean).join(" ");
}

function recoveryGuidance(plan, error) {
  const rerun = commandHint(plan);
  return [
    `Inspect the preserved workspace at ${plan.workspace?.path} before rerunning.`,
    `Rerun the same start flow after fixing the issue: ${rerun}`,
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

function ensureOrdinaryPlan(plan) {
  if (plan?.mode !== "ordinary") {
    fail("PREFLIGHT", "Task 6 only supports ordinary workflow execution", { mode: plan?.mode }, 10);
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

function agentArgv(plan) {
  return [plan.agent.command, "--name", plan.agent.sessionName];
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

function looksLikePiPane(pane) {
  return pane?.agent === "pi" || pane?.agent_session?.agent === "pi";
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

function ensureStartShape({ herdr, worktreeOperation, workspaceOperation, agentTabOperation, agentOperation }) {
  if (!herdr) {
    fail("PREFLIGHT", "executeStart requires a Herdr adapter", {}, 10);
  }
  if (typeof herdr.ensureNativeWorktree !== "function"
    || typeof herdr.renameTab !== "function"
    || typeof herdr.startAgent !== "function") {
    fail("PREFLIGHT", "executeStart requires Herdr worktree, tab, and agent methods", {}, 10);
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

function buildInitialReport(plan) {
  return {
    mode: plan.mode,
    status: "completed",
    operations: [],
    guidance: [],
    notes: [],
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

async function verifyCloseSafety({ herdr, workspaceId, expectedTabId, bootstrapPaneId, startedAgent }) {
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
  if (!startedPane || !looksLikePiPane(startedPane)) return false;
  if (!bootstrapPane || !isIdleBootstrapPane(bootstrapPane)) return false;
  if (getPaneId(bootstrapPane) === getPaneId(startedPane)) return false;
  return true;
}

async function executeOrdinaryStart(plan, { herdr }) {
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

    if (agentTabOperation.reconciliation?.status !== "compatible") {
      currentOperation = agentTabOperation;
      if (!agentTabId) {
        bootstrapContext = await resolveBootstrapContext(plan, worktreeOperation, ensured, herdr);
        agentTabId = bootstrapContext.tabId;
      }
      await herdr.renameTab({ tabId: agentTabId, label: plan.agent.tabLabel });
      agentTabStatus = "created";
    }

    report.operations.push(buildOperationReport(agentTabOperation, agentTabStatus, { tabId: agentTabId }));
    completedIds.add(agentTabOperation.id);

    if (agentOperation.reconciliation?.status === "compatible") {
      report.operations.push(buildOperationReport(agentOperation, "reused"));
      completedIds.add(agentOperation.id);
      return report;
    }

    currentOperation = agentOperation;
    const startedAgent = await herdr.startAgent({
      name: plan.agent.sessionName,
      cwd: plan.agent.worktreePath,
      tabId: agentTabId,
      argv: agentArgv(plan),
      focus: false,
    });

    report.operations.push(buildOperationReport(agentOperation, "created", {
      agentId: startedAgent.agentId,
      tabId: startedAgent.tabId,
      paneId: startedAgent.paneId,
    }));
    completedIds.add(agentOperation.id);

    if (bootstrapCreatedFromReturnedRootPane && typeof herdr.closePane === "function") {
      const workspaceId = bootstrapContext?.workspaceId ?? ensured.result?.workspaceId ?? null;
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

export async function executeStart(reconciledPlan, { git: _git, herdr } = {}) {
  ensureOrdinaryPlan(reconciledPlan);
  ensureNoConflicts(reconciledPlan);
  return await executeOrdinaryStart(reconciledPlan, { herdr });
}
