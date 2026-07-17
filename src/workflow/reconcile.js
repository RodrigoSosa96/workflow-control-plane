import { resolve } from "node:path";

function normalizePath(value) {
  return typeof value === "string" && value ? resolve(value) : null;
}

function normalizeBranch(value) {
  if (typeof value !== "string") return null;
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}

function listValue(value, key) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : [];
}

function aggregateStatus(values) {
  if (values.some((value) => value === "conflict")) return "conflict";
  if (values.every((value) => value === "compatible")) return "compatible";
  return "incomplete";
}

async function safeInspectRepository(git, cwd) {
  try {
    return await git.inspectRepository({ cwd });
  } catch {
    return null;
  }
}

async function safeStatus(git, cwd) {
  try {
    return await git.status({ cwd });
  } catch {
    return { dirty: false, entries: [] };
  }
}

function worktreeKey(worktree) {
  return `${worktree.role}:${worktree.alias ?? ""}:${worktree.path}`;
}

function workspacePath(workspace) {
  return normalizePath(workspace?.cwd ?? workspace?.worktree?.checkout_path ?? workspace?.path);
}

function workspaceRepoKey(workspace) {
  return normalizePath(workspace?.worktree?.repo_key ?? workspace?.repo_key);
}

function paneCwd(pane) {
  return normalizePath(pane?.foreground_cwd ?? pane?.cwd);
}

function paneCommand(pane) {
  return pane?.command ?? pane?.foreground_command ?? pane?.process?.command ?? null;
}

function classifyTabWhenWorkspaceUnavailable(tab, workspace) {
  if (workspace.status === "conflict") {
    return { ...tab, status: "conflict", reason: workspace.reason, actual: null };
  }
  return {
    ...tab,
    status: "missing",
    reason: workspace.status === "incomplete" ? "Workspace is not open" : "Workspace is missing",
    actual: null,
  };
}

async function classifyWorktrees(plan, git) {
  const results = [];
  const byKey = new Map();

  for (const planned of plan.worktrees) {
    const repository = await git.inspectRepository({ cwd: planned.repositoryPath });
    const expectedCommonDirPath = normalizePath(repository.commonDirPath);
    const plannedPath = normalizePath(planned.path);
    const listed = await git.listWorktrees({ cwd: planned.repositoryPath });
    const exact = listed.find((entry) => normalizePath(entry.path) === plannedPath);
    const sameBranch = listed.find((entry) => normalizeBranch(entry.branch) === planned.branch);
    const occupant = await safeInspectRepository(git, planned.path);
    const occupantCommonDirPath = normalizePath(occupant?.commonDirPath);

    let classified;

    if (exact) {
      const actualBranch = normalizeBranch(exact.branch);
      if (occupantCommonDirPath && occupantCommonDirPath !== expectedCommonDirPath) {
        classified = {
          ...planned,
          status: "conflict",
          reason: `Planned path ${planned.path} belongs to a different repository`,
          actual: { path: exact.path, branch: actualBranch, commonDirPath: occupantCommonDirPath },
          expectedCommonDirPath,
        };
      } else if (actualBranch !== planned.branch) {
        classified = {
          ...planned,
          status: "conflict",
          reason: `Planned path ${planned.path} has branch ${actualBranch ?? "detached"} instead of ${planned.branch}`,
          actual: { path: exact.path, branch: actualBranch, commonDirPath: expectedCommonDirPath },
          expectedCommonDirPath,
        };
      } else {
        const status = await safeStatus(git, planned.path);
        classified = {
          ...planned,
          status: "compatible",
          reason: `Worktree ${planned.path} matches ${planned.branch}`,
          actual: {
            path: exact.path,
            branch: actualBranch,
            commonDirPath: expectedCommonDirPath,
            dirty: Boolean(status?.dirty),
            entries: status?.entries ?? [],
          },
          expectedCommonDirPath,
        };
      }
    } else if (sameBranch) {
      classified = {
        ...planned,
        status: "conflict",
        reason: `Branch ${planned.branch} is already checked out at ${sameBranch.path}`,
        actual: {
          path: sameBranch.path,
          branch: normalizeBranch(sameBranch.branch),
          commonDirPath: expectedCommonDirPath,
        },
        expectedCommonDirPath,
      };
    } else if (occupantCommonDirPath) {
      classified = {
        ...planned,
        status: occupantCommonDirPath === expectedCommonDirPath ? "conflict" : "conflict",
        reason: occupantCommonDirPath === expectedCommonDirPath
          ? `Planned path ${planned.path} is occupied by another worktree from the same repository`
          : `Planned path ${planned.path} belongs to the wrong repository`,
        actual: {
          path: planned.path,
          branch: null,
          commonDirPath: occupantCommonDirPath,
        },
        expectedCommonDirPath,
      };
    } else {
      classified = {
        ...planned,
        status: "missing",
        reason: `Worktree ${planned.path} does not exist yet`,
        actual: null,
        expectedCommonDirPath,
      };
    }

    results.push(classified);
    byKey.set(worktreeKey(planned), classified);
  }

  return { results, byKey };
}

async function classifyWorkspace(plan, worktrees, herdr) {
  const allWorkspaces = listValue(await herdr.listWorkspaces(), "workspaces");
  const rootWorktree = worktrees.results.find((worktree) => worktree.role === "primary" || worktree.role === "meta")
    ?? worktrees.results[0];
  const plannedPath = normalizePath(plan.workspace.path);
  const matches = allWorkspaces.filter((workspace) => workspacePath(workspace) === plannedPath);

  if (matches.length > 1) {
    return {
      ...plan.workspace,
      status: "conflict",
      reason: `Multiple Herdr workspaces point at ${plan.workspace.path}`,
      actual: matches,
      expectedCommonDirPath: rootWorktree?.expectedCommonDirPath ?? null,
    };
  }

  const actual = matches[0] ?? null;
  const actualRepoKey = workspaceRepoKey(actual);
  if (actual) {
    if (rootWorktree?.expectedCommonDirPath && actualRepoKey && actualRepoKey !== rootWorktree.expectedCommonDirPath) {
      return {
        ...plan.workspace,
        status: "conflict",
        reason: `Herdr workspace at ${plan.workspace.path} belongs to a different repository`,
        actual,
        expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
      };
    }

    if (rootWorktree?.status === "missing") {
      return {
        ...plan.workspace,
        status: "conflict",
        reason: `Herdr workspace is open at ${plan.workspace.path} but the Git worktree is missing`,
        actual,
        expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
      };
    }

    return {
      ...plan.workspace,
      status: "compatible",
      reason: `Herdr workspace is open at ${plan.workspace.path}`,
      actual,
      expectedCommonDirPath: rootWorktree?.expectedCommonDirPath ?? null,
    };
  }

  if (rootWorktree?.status === "compatible") {
    return {
      ...plan.workspace,
      status: "incomplete",
      reason: `Git worktree exists at ${plan.workspace.path} but the Herdr workspace is closed or not open`,
      actual: null,
      expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
    };
  }

  if (rootWorktree?.status === "conflict") {
    return {
      ...plan.workspace,
      status: "conflict",
      reason: rootWorktree.reason,
      actual: null,
      expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
    };
  }

  return {
    ...plan.workspace,
    status: "missing",
    reason: `Workspace ${plan.workspace.path} is missing because the Git worktree is missing`,
    actual: null,
    expectedCommonDirPath: rootWorktree?.expectedCommonDirPath ?? null,
  };
}

async function classifyTabs(plan, workspace, herdr) {
  if (workspace.status !== "compatible") {
    const results = plan.tabs.map((tab) => classifyTabWhenWorkspaceUnavailable(tab, workspace));
    return { results, byLabel: new Map(results.map((tab) => [tab.label, tab])), panes: [] };
  }

  const actualTabs = listValue(await herdr.listTabs({ workspaceId: workspace.actual.workspace_id }), "tabs");
  const actualPanes = listValue(await herdr.listPanes({ workspaceId: workspace.actual.workspace_id }), "panes");
  const results = [];
  const byLabel = new Map();

  for (const planned of plan.tabs) {
    const matches = actualTabs.filter((tab) => tab.label === planned.label);
    let classified;

    if (matches.length > 1) {
      classified = {
        ...planned,
        status: "conflict",
        reason: `Multiple tabs use label ${planned.label}`,
        actual: matches,
      };
    } else if (matches.length === 1) {
      classified = {
        ...planned,
        status: "compatible",
        reason: `Tab ${planned.label} exists`,
        actual: matches[0],
      };
    } else {
      classified = {
        ...planned,
        status: "missing",
        reason: `Tab ${planned.label} is missing`,
        actual: null,
      };
    }

    results.push(classified);
    byLabel.set(planned.label, classified);
  }

  return { results, byLabel, panes: actualPanes };
}

async function classifyAgent(plan, tabs, herdr) {
  const actualAgents = listValue(await herdr.listAgents(), "agents");
  const tab = tabs.byLabel.get(plan.agent.tabLabel);
  if (!tab || tab.status !== "compatible") {
    return {
      status: tab?.status === "conflict" ? "conflict" : "missing",
      reason: tab?.status === "conflict" ? tab.reason : `Agent tab ${plan.agent.tabLabel} is not ready`,
      actual: null,
    };
  }

  const matches = actualAgents.filter((agent) => {
    const sameName = agent.name === plan.agent.sessionName;
    const sameCwd = normalizePath(agent.cwd) === normalizePath(plan.agent.worktreePath);
    const sameTab = !agent.tab_id || agent.tab_id === tab.actual.tab_id;
    return sameName && sameCwd && sameTab;
  });

  if (matches.length > 1) {
    return {
      status: "conflict",
      reason: `Multiple Pi agents match ${plan.agent.sessionName}`,
      actual: matches,
    };
  }

  if (matches.length === 1) {
    return {
      status: "compatible",
      reason: `Pi agent ${plan.agent.sessionName} is running`,
      actual: matches[0],
    };
  }

  return {
    status: "missing",
    reason: `Pi agent ${plan.agent.sessionName} is not running`,
    actual: null,
  };
}

function classifyRuntime(plan, tabs, panes) {
  const runtimeTab = tabs.byLabel.get(plan.runtime.tabLabel);
  if (!runtimeTab || runtimeTab.status === "conflict") {
    return {
      status: runtimeTab?.status === "conflict" ? "conflict" : "incomplete",
      reason: runtimeTab?.reason ?? `Runtime tab ${plan.runtime.tabLabel} is missing`,
      profileName: plan.runtime.profileName,
      tab: runtimeTab ?? null,
      processes: plan.runtime.processes.map((process) => ({
        ...process,
        status: "missing",
        reason: runtimeTab?.status === "conflict" ? runtimeTab.reason : `Runtime tab ${plan.runtime.tabLabel} is missing`,
        actual: [],
      })),
    };
  }

  const processes = plan.runtime.processes.map((process) => {
    const expectedCwd = normalizePath(resolve(plan.runtime.worktreePath, process.cwd ?? "."));
    const matches = panes.filter((pane) => {
      if (pane.tab_id !== runtimeTab.actual.tab_id) return false;
      const sameCwd = paneCwd(pane) === expectedCwd;
      const liveCommand = paneCommand(pane);
      const sameCommand = !liveCommand || liveCommand === process.command;
      const sameLabel = pane.label === process.id;
      return sameCwd && (sameLabel || sameCommand);
    });

    if (matches.length > 1) {
      return {
        ...process,
        status: "conflict",
        reason: `Duplicate runtime panes match process ${process.id}`,
        actual: matches,
      };
    }

    if (matches.length === 1) {
      return {
        ...process,
        status: "compatible",
        reason: `Runtime process ${process.id} is present`,
        actual: matches,
      };
    }

    return {
      ...process,
      status: "missing",
      reason: `Runtime process ${process.id} is not running`,
      actual: [],
    };
  });

  return {
    status: aggregateStatus(processes.map((process) => process.status)),
    reason: aggregateStatus(processes.map((process) => process.status)) === "compatible"
      ? `Runtime tab ${plan.runtime.tabLabel} is ready`
      : `Runtime tab ${plan.runtime.tabLabel} is incomplete`,
    profileName: plan.runtime.profileName,
    tab: runtimeTab,
    processes,
  };
}

function collectConflicts(worktrees, workspace, tabs, agent, runtime) {
  return [
    ...worktrees.filter((worktree) => worktree.status === "conflict").map((worktree) => ({
      resource: `worktree:${worktree.alias ?? worktree.role}`,
      reason: worktree.reason,
    })),
    ...(workspace.status === "conflict" ? [{ resource: "workspace", reason: workspace.reason }] : []),
    ...tabs.filter((tab) => tab.status === "conflict").map((tab) => ({ resource: `tab:${tab.label}`, reason: tab.reason })),
    ...(agent.status === "conflict" ? [{ resource: "agent", reason: agent.reason }] : []),
    ...runtime.processes.filter((process) => process.status === "conflict").map((process) => ({
      resource: `runtime:${process.id}`,
      reason: process.reason,
    })),
  ];
}

function classifyOperation(operation, state) {
  if (operation.kind === "herdr.worktree.ensure") {
    const worktree = state.worktrees.find((item) => normalizePath(item.path) === normalizePath(operation.path));
    if (!worktree) return { status: "missing", reason: `Worktree ${operation.path} is not present` };
    if (worktree.status === "conflict") return { status: "conflict", reason: worktree.reason };
    if (worktree.status === "missing") return { status: "missing", reason: worktree.reason };
    if (state.workspace.status === "compatible") {
      const rootTab = state.tabs.find((tab) => tab.actual && tab.actual.workspace_id === state.workspace.actual.workspace_id);
      const rootPane = state.panes.find((pane) => pane.tab_id === rootTab?.actual?.tab_id);
      return {
        status: "open",
        reason: state.workspace.reason,
        workspace: state.workspace.actual,
        ...(rootTab?.actual ? { tab: rootTab.actual } : {}),
        ...(rootPane ? { root_pane: rootPane } : {}),
      };
    }
    if (state.workspace.status === "incomplete") {
      return { status: "closed", reason: state.workspace.reason };
    }
    return { status: "conflict", reason: state.workspace.reason };
  }

  if (operation.kind === "git.worktree.ensure") {
    const worktree = state.worktrees.find((item) => normalizePath(item.path) === normalizePath(operation.path));
    return { status: worktree?.status ?? "missing", reason: worktree?.reason ?? `Worktree ${operation.path} is missing` };
  }

  if (operation.kind === "herdr.workspace.ensure") {
    return { status: state.workspace.status, reason: state.workspace.reason };
  }

  if (operation.kind === "herdr.tab.ensure") {
    const tab = state.tabs.find((item) => item.label === operation.label);
    return { status: tab?.status ?? "missing", reason: tab?.reason ?? `Tab ${operation.label} is missing` };
  }

  if (operation.kind === "pi.session.start") {
    return { status: state.agent.status, reason: state.agent.reason };
  }

  if (operation.kind === "workflow.runtime.start") {
    return { status: state.runtime.status, reason: state.runtime.reason };
  }

  return { status: "missing", reason: `No reconciliation rule for ${operation.kind}` };
}

export async function reconcilePlan(plan, { git, herdr }) {
  const worktrees = await classifyWorktrees(plan, git);
  const workspace = await classifyWorkspace(plan, worktrees, herdr);
  const tabs = await classifyTabs(plan, workspace, herdr);
  const agent = await classifyAgent(plan, tabs, herdr);
  const runtime = classifyRuntime(plan, tabs, tabs.panes);
  const conflicts = collectConflicts(worktrees.results, workspace, tabs.results, agent, runtime);
  const status = conflicts.length > 0
    ? "conflict"
    : aggregateStatus([
      ...worktrees.results.map((worktree) => worktree.status === "missing" ? "incomplete" : worktree.status),
      workspace.status === "missing" ? "incomplete" : workspace.status,
      ...tabs.results.map((tab) => tab.status === "missing" ? "incomplete" : tab.status),
      agent.status === "missing" ? "incomplete" : agent.status,
      runtime.status,
    ]);

  const operations = plan.operations.map((operation) => ({
    ...operation,
    reconciliation: classifyOperation(operation, {
      worktrees: worktrees.results,
      workspace,
      tabs: tabs.results,
      panes: tabs.panes,
      agent,
      runtime,
    }),
  }));

  return {
    ...plan,
    status,
    conflicts,
    worktrees: worktrees.results,
    workspace,
    tabs: tabs.results,
    agent,
    runtime,
    operations,
  };
}
