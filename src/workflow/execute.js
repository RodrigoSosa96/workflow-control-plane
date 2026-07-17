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

function canCloseBootstrapPane({ worktreeDisposition, bootstrapCreatedFromReturnedRootPane, bootstrapPaneId, agentPaneId }) {
  if (!bootstrapCreatedFromReturnedRootPane) return false;
  if (!isNonEmptyString(bootstrapPaneId)) return false;
  if (!isNonEmptyString(agentPaneId)) return false;
  if (bootstrapPaneId === agentPaneId) return false;
  return worktreeDisposition === "created" || worktreeDisposition === "opened";
}

function agentArgv(plan) {
  return [plan.agent.command, "--name", plan.agent.sessionName];
}

function resolveReusedRootIds(worktreeOperation) {
  const reconciliation = worktreeOperation.reconciliation ?? {};
  const workspaceId = reconciliation.workspace?.workspace_id ?? reconciliation.workspace?.workspaceId ?? null;
  const tabId = reconciliation.tab?.tab_id ?? reconciliation.tab?.tabId ?? null;
  const paneId = reconciliation.root_pane?.pane_id ?? reconciliation.root_pane?.paneId ?? null;

  if (!workspaceId || !tabId || !paneId) {
    fail("PREFLIGHT", "Open worktree reconciliation is missing required Herdr IDs", {
      reconciliation,
      workspaceId,
      tabId,
      paneId,
    }, 10);
  }

  return {
    workspaceId,
    tabId,
    paneId,
    disposition: "already_open",
  };
}

async function ensureWorktreeStart(worktreeOperation, herdr) {
  const reconciliation = worktreeOperation.reconciliation ?? {};

  if (reconciliation.status === "open") {
    return {
      result: resolveReusedRootIds(worktreeOperation),
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
  const actualTabId = tab?.actual?.tab_id ?? tab?.actual?.tabId ?? null;
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
  let bootstrapTabId = null;
  let bootstrapPaneId = null;
  let bootstrapCreatedFromReturnedRootPane = false;
  let currentOperation = worktreeOperation;

  try {
    ensured = await ensureWorktreeStart(worktreeOperation, herdr);
    if (ensured.result) {
      bootstrapTabId = ensured.result.tabId;
      bootstrapPaneId = ensured.result.paneId;
    }
    bootstrapCreatedFromReturnedRootPane = Boolean(ensured.mutated);

    report.operations.push(buildOperationReport(worktreeOperation, ensured.status));
    completedIds.add(worktreeOperation.id);

    const workspaceStatus = reusableStatus(worktreeOperation.reconciliation?.status)
      ? "reused"
      : ensured.status;
    report.operations.push(buildOperationReport(workspaceOperation, workspaceStatus));
    completedIds.add(workspaceOperation.id);

    let agentTabStatus = "reused";
    let agentTabId = resolveAgentTabId(plan, bootstrapTabId);

    if (agentTabOperation.reconciliation?.status !== "compatible") {
      currentOperation = agentTabOperation;
      if (!agentTabId) {
        fail("PREFLIGHT", "Agent tab cannot be prepared because no bootstrap tab ID is available", {
          operation: agentTabOperation,
          bootstrapTabId,
        }, 10);
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

    if (typeof herdr.closePane === "function"
      && canCloseBootstrapPane({
        worktreeDisposition: ensured.result?.disposition,
        bootstrapCreatedFromReturnedRootPane,
        bootstrapPaneId,
        agentPaneId: startedAgent.paneId,
      })) {
      await herdr.closePane({ paneId: bootstrapPaneId });
    } else if (bootstrapPaneId) {
      report.notes.push("Retained the bootstrap shell pane because the close safety conditions were not met.");
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
