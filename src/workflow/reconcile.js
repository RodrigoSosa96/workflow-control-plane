import { realpath as defaultRealpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

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

function isMissingPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function createCanonicalPath(realpathImpl = defaultRealpath) {
  const cache = new Map();

  return async function canonicalPath(value, { allowMissing = true } = {}) {
    if (typeof value !== "string" || !value) return null;

    const resolved = resolve(value);
    const key = `${allowMissing}:${resolved}`;
    if (cache.has(key)) return await cache.get(key);

    const pending = (async () => {
      try {
        return await realpathImpl(resolved);
      } catch (error) {
        if (allowMissing && isMissingPathError(error)) return resolved;
        throw error;
      }
    })();

    cache.set(key, pending);
    return await pending;
  };
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

function workspaceRepoKey(workspace, canonicalPath) {
  return canonicalPath(workspace?.worktree?.repo_key ?? workspace?.repo_key);
}

function paneCommand(pane) {
  return pane?.command ?? pane?.foreground_command ?? pane?.process?.command ?? null;
}

async function panePath(pane, canonicalPath) {
  return await canonicalPath(pane?.foreground_cwd ?? pane?.cwd);
}

function paneId(pane) {
  return pane?.pane_id ?? pane?.paneId ?? null;
}

function commandExecutable(command) {
  if (typeof command !== "string") return null;
  return command.trim().split(/\s+/u)[0] ?? null;
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
  const liveCommand = processInfoCommand(processInfo);
  if (!processInfoRunning(processInfo) && !liveCommand) return false;
  return liveCommand === expectedCommand && matchesExecutable(expectedCommand, processInfo);
}

function hasLiveProcessEvidence(processInfo) {
  return processInfoRunning(processInfo) || Boolean(processInfoCommand(processInfo) || processInfoExecutable(processInfo));
}

async function loadPaneProcessInfo(herdr, pane) {
  if (typeof herdr?.getPaneProcessInfo !== "function") return { available: false, value: null };
  const id = paneId(pane);
  if (!id) return { available: true, value: null };
  return {
    available: true,
    value: await herdr.getPaneProcessInfo(id),
  };
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

async function classifyWorktrees(plan, git, canonicalPath) {
  const results = [];
  const byCanonicalPath = new Map();

  for (const planned of plan.worktrees) {
    const repository = await git.inspectRepository({ cwd: planned.repositoryPath });
    const expectedCommonDirPath = await canonicalPath(repository.commonDirPath);
    const plannedCanonicalPath = await canonicalPath(planned.path);
    const listed = await Promise.all(
      (await git.listWorktrees({ cwd: planned.repositoryPath })).map(async (entry) => ({
        ...entry,
        canonicalPath: await canonicalPath(entry.path),
        normalizedBranch: normalizeBranch(entry.branch),
      })),
    );
    const exact = listed.find((entry) => entry.canonicalPath === plannedCanonicalPath);
    const sameBranch = listed.find((entry) => entry.normalizedBranch === planned.branch && entry.canonicalPath !== plannedCanonicalPath);
    const occupant = await safeInspectRepository(git, planned.path);
    const occupantCommonDirPath = await canonicalPath(occupant?.commonDirPath);
    const occupantRootPath = await canonicalPath(occupant?.rootPath);

    let classified;

    if (exact) {
      if (occupantCommonDirPath && occupantCommonDirPath !== expectedCommonDirPath) {
        classified = {
          ...planned,
          status: "conflict",
          reason: `Planned path ${planned.path} belongs to a different repository`,
          canonicalPath: plannedCanonicalPath,
          actual: {
            path: exact.path,
            canonicalPath: exact.canonicalPath,
            branch: exact.normalizedBranch,
            commonDirPath: occupantCommonDirPath,
          },
          expectedCommonDirPath,
        };
      } else if (exact.normalizedBranch !== planned.branch) {
        classified = {
          ...planned,
          status: "conflict",
          reason: `Planned path ${planned.path} has branch ${exact.normalizedBranch ?? "detached"} instead of ${planned.branch}`,
          canonicalPath: plannedCanonicalPath,
          actual: {
            path: exact.path,
            canonicalPath: exact.canonicalPath,
            branch: exact.normalizedBranch,
            commonDirPath: expectedCommonDirPath,
          },
          expectedCommonDirPath,
        };
      } else {
        const status = await safeStatus(git, planned.path);
        classified = {
          ...planned,
          status: "compatible",
          reason: `Worktree ${planned.path} matches ${planned.branch}`,
          canonicalPath: plannedCanonicalPath,
          actual: {
            path: exact.path,
            canonicalPath: exact.canonicalPath,
            branch: exact.normalizedBranch,
            commonDirPath: expectedCommonDirPath,
            rootPath: occupantRootPath ?? exact.canonicalPath,
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
        canonicalPath: plannedCanonicalPath,
        actual: {
          path: sameBranch.path,
          canonicalPath: sameBranch.canonicalPath,
          branch: sameBranch.normalizedBranch,
          commonDirPath: expectedCommonDirPath,
        },
        expectedCommonDirPath,
      };
    } else if (occupantCommonDirPath) {
      classified = {
        ...planned,
        status: "conflict",
        reason: occupantCommonDirPath === expectedCommonDirPath
          ? `Planned path ${planned.path} is occupied by another worktree from the same repository`
          : `Planned path ${planned.path} belongs to the wrong repository`,
        canonicalPath: plannedCanonicalPath,
        actual: {
          path: planned.path,
          canonicalPath: occupantRootPath ?? plannedCanonicalPath,
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
        canonicalPath: plannedCanonicalPath,
        actual: null,
        expectedCommonDirPath,
      };
    }

    results.push(classified);
    byCanonicalPath.set(plannedCanonicalPath, classified);
  }

  return { results, byCanonicalPath };
}

async function classifyWorkspace(plan, worktrees, herdr, canonicalPath) {
  const allWorkspaces = listValue(await herdr.listWorkspaces(), "workspaces");
  const rootWorktree = worktrees.results.find((worktree) => worktree.role === "primary" || worktree.role === "meta")
    ?? worktrees.results[0];
  const plannedPath = await canonicalPath(plan.workspace.path);
  const matches = [];

  for (const workspace of allWorkspaces) {
    const checkoutPath = await canonicalPath(workspace?.cwd ?? workspace?.worktree?.checkout_path ?? workspace?.path);
    if (checkoutPath === plannedPath) {
      matches.push({ ...workspace, canonicalPath: checkoutPath });
    }
  }

  if (matches.length > 1) {
    return {
      ...plan.workspace,
      status: "conflict",
      reason: `Multiple Herdr workspaces point at ${plan.workspace.path}`,
      canonicalPath: plannedPath,
      actual: matches,
      expectedCommonDirPath: rootWorktree?.expectedCommonDirPath ?? null,
    };
  }

  const actual = matches[0] ?? null;
  const actualRepoKey = await workspaceRepoKey(actual, canonicalPath);
  if (actual) {
    if (rootWorktree?.expectedCommonDirPath && actualRepoKey && actualRepoKey !== rootWorktree.expectedCommonDirPath) {
      return {
        ...plan.workspace,
        status: "conflict",
        reason: `Herdr workspace at ${plan.workspace.path} belongs to a different repository`,
        canonicalPath: plannedPath,
        actual,
        expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
      };
    }

    if (rootWorktree?.status === "missing") {
      return {
        ...plan.workspace,
        status: "conflict",
        reason: `Herdr workspace is open at ${plan.workspace.path} but the Git worktree is missing`,
        canonicalPath: plannedPath,
        actual,
        expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
      };
    }

    return {
      ...plan.workspace,
      status: "compatible",
      reason: `Herdr workspace is open at ${plan.workspace.path}`,
      canonicalPath: plannedPath,
      actual,
      expectedCommonDirPath: rootWorktree?.expectedCommonDirPath ?? null,
    };
  }

  if (rootWorktree?.status === "compatible") {
    return {
      ...plan.workspace,
      status: "incomplete",
      reason: `Git worktree exists at ${plan.workspace.path} but the Herdr workspace is closed or not open`,
      canonicalPath: plannedPath,
      actual: null,
      expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
    };
  }

  if (rootWorktree?.status === "conflict") {
    return {
      ...plan.workspace,
      status: "conflict",
      reason: rootWorktree.reason,
      canonicalPath: plannedPath,
      actual: null,
      expectedCommonDirPath: rootWorktree.expectedCommonDirPath,
    };
  }

  return {
    ...plan.workspace,
    status: "missing",
    reason: `Workspace ${plan.workspace.path} is missing because the Git worktree is missing`,
    canonicalPath: plannedPath,
    actual: null,
    expectedCommonDirPath: rootWorktree?.expectedCommonDirPath ?? null,
  };
}

function findWorktreeForTab(plannedTab, worktrees, expectedCanonicalPath) {
  if (plannedTab.kind === "repository") {
    return worktrees.results.find((worktree) => worktree.alias === plannedTab.label)
      ?? worktrees.byCanonicalPath.get(expectedCanonicalPath)
      ?? null;
  }

  return worktrees.byCanonicalPath.get(expectedCanonicalPath) ?? null;
}

function buildTabConflict(planned, actual, reason) {
  return {
    ...planned,
    status: "conflict",
    reason,
    actual,
  };
}

function buildTabIncomplete(planned, actual, reason) {
  return {
    ...planned,
    status: "incomplete",
    reason,
    actual,
  };
}

async function classifyTabIdentity(planned, actual, actualPanes, loadAgents, worktrees, canonicalPath, plan) {
  const expectedCanonicalPath = await canonicalPath(planned.worktreePath ?? plan.workspace.path);
  const relatedWorktree = findWorktreeForTab(planned, worktrees, expectedCanonicalPath);
  const tabPanes = [];

  for (const pane of actualPanes.filter((candidate) => candidate.tab_id === actual.tab_id)) {
    tabPanes.push({
      ...pane,
      canonicalPath: await panePath(pane, canonicalPath),
      liveCommand: paneCommand(pane),
    });
  }

  if (planned.kind === "repository") {
    if (!relatedWorktree || relatedWorktree.status === "missing") {
      return buildTabIncomplete(planned, actual, `Repository tab ${planned.label} is waiting for its child worktree`);
    }
    if (relatedWorktree.status === "conflict") {
      return buildTabConflict(planned, actual, relatedWorktree.reason);
    }

    const matchingPanes = tabPanes.filter((pane) => pane.canonicalPath === expectedCanonicalPath);
    if (matchingPanes.length > 0) {
      return {
        ...planned,
        status: "compatible",
        reason: `Repository tab ${planned.label} matches ${planned.worktreePath}`,
        actual,
      };
    }

    if (tabPanes.length === 0) {
      return buildTabIncomplete(planned, actual, `Repository tab ${planned.label} has no pane identity yet`);
    }

    return buildTabConflict(planned, actual, `Repository tab ${planned.label} points at the wrong child worktree cwd`);
  }

  if (planned.kind === "agent") {
    const actualAgents = await loadAgents();
    const matchingAgents = actualAgents.filter((agent) => agent.tab_id === actual.tab_id && agent.name === plan.agent.sessionName);
    const agentMatches = [];
    for (const agent of matchingAgents) {
      if (await canonicalPath(agent.cwd) === expectedCanonicalPath) agentMatches.push(agent);
    }
    if (agentMatches.length > 1) {
      return buildTabConflict(planned, actual, `Multiple Pi agents match agent tab ${planned.label}`);
    }
    if (agentMatches.length === 1) {
      return {
        ...planned,
        status: "compatible",
        reason: `Agent tab ${planned.label} matches ${planned.worktreePath}`,
        actual,
      };
    }

    const matchingPanes = tabPanes.filter((pane) => pane.canonicalPath === expectedCanonicalPath);
    if (matchingPanes.length > 0) {
      return {
        ...planned,
        status: "compatible",
        reason: `Agent tab ${planned.label} matches ${planned.worktreePath}`,
        actual,
      };
    }

    if (tabPanes.length === 0) {
      return buildTabIncomplete(planned, actual, `Agent tab ${planned.label} has no cwd identity yet`);
    }

    return buildTabConflict(planned, actual, `Agent tab ${planned.label} points at the wrong cwd`);
  }

  if (planned.kind === "runtime") {
    const matchingPanes = tabPanes.filter((pane) => pane.canonicalPath === expectedCanonicalPath);
    if (matchingPanes.length > 0) {
      return {
        ...planned,
        status: "compatible",
        reason: `Runtime tab ${planned.label} matches ${planned.worktreePath}`,
        actual,
      };
    }

    if (tabPanes.length === 0) {
      return buildTabIncomplete(planned, actual, `Runtime tab ${planned.label} has no pane identity yet`);
    }

    return buildTabConflict(planned, actual, `Runtime tab ${planned.label} points at the wrong cwd`);
  }

  return buildTabConflict(planned, actual, `Unsupported tab kind ${planned.kind}`);
}

async function classifyTabs(plan, workspace, worktrees, herdr, loadAgents, canonicalPath) {
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
      classified = await classifyTabIdentity(planned, matches[0], actualPanes, loadAgents, worktrees, canonicalPath, plan);
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

async function classifyAgent(plan, tabs, loadAgents, canonicalPath) {
  const actualAgents = await loadAgents();
  const tab = tabs.byLabel.get(plan.agent.tabLabel);
  if (!tab || tab.status !== "compatible") {
    return {
      status: tab?.status === "conflict" ? "conflict" : "missing",
      reason: tab?.status === "conflict" ? tab.reason : `Agent tab ${plan.agent.tabLabel} is not ready`,
      actual: null,
    };
  }

  const expectedCanonicalPath = await canonicalPath(plan.agent.worktreePath);
  const matches = [];
  for (const agent of actualAgents) {
    const sameName = agent.name === plan.agent.sessionName;
    const sameTab = !agent.tab_id || agent.tab_id === tab.actual.tab_id;
    if (!sameName || !sameTab) continue;
    if (await canonicalPath(agent.cwd) === expectedCanonicalPath) matches.push(agent);
  }

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

async function classifyRuntime(plan, tabs, panes, herdr, canonicalPath) {
  const runtimeTab = tabs.byLabel.get(plan.runtime.tabLabel);
  if (!runtimeTab || runtimeTab.status !== "compatible") {
    return {
      status: runtimeTab?.status === "conflict" ? "conflict" : "incomplete",
      reason: runtimeTab?.reason ?? `Runtime tab ${plan.runtime.tabLabel} is missing`,
      profileName: plan.runtime.profileName,
      tab: runtimeTab ?? null,
      processes: plan.runtime.processes.map((process) => ({
        ...process,
        status: runtimeTab?.status === "conflict" ? "conflict" : "missing",
        reason: runtimeTab?.status === "conflict" ? runtimeTab.reason : `Runtime tab ${plan.runtime.tabLabel} is missing or incomplete`,
        actual: [],
      })),
    };
  }

  const runtimePanes = [];
  for (const pane of panes.filter((candidate) => candidate.tab_id === runtimeTab.actual.tab_id)) {
    const loadedProcessInfo = await loadPaneProcessInfo(herdr, pane);
    runtimePanes.push({
      ...pane,
      canonicalPath: await panePath(pane, canonicalPath),
      liveCommand: paneCommand(pane),
      processInfo: loadedProcessInfo.value,
      processInfoAvailable: loadedProcessInfo.available,
    });
  }

  const processes = [];
  for (const process of plan.runtime.processes) {
    const expectedCwd = await canonicalPath(resolve(plan.runtime.worktreePath, process.cwd ?? "."));
    const sameCwd = runtimePanes.filter((pane) => pane.canonicalPath === expectedCwd);
    const exactMatches = sameCwd.filter((pane) => pane.label === process.id && pane.processInfoAvailable && matchesProcessIdentity(process.command, pane.processInfo));
    const matchingCommandLabels = sameCwd.filter((pane) => !pane.processInfoAvailable && pane.label === process.id && typeof pane.liveCommand === "string" && pane.liveCommand === process.command);
    const mismatchedCommandLabels = sameCwd.filter((pane) => !pane.processInfoAvailable && pane.label === process.id && typeof pane.liveCommand === "string" && pane.liveCommand !== process.command);
    const commandMatches = sameCwd.filter((pane) => pane.label !== process.id && (
      (pane.processInfoAvailable && matchesProcessIdentity(process.command, pane.processInfo))
      || (!pane.processInfoAvailable && typeof pane.liveCommand === "string" && pane.liveCommand === process.command)
    ));
    const evidenceMatches = [...exactMatches, ...matchingCommandLabels, ...mismatchedCommandLabels, ...commandMatches];

    if (exactMatches.length > 1 || evidenceMatches.length > 1) {
      processes.push({
        ...process,
        status: "conflict",
        reason: `Duplicate runtime panes match process ${process.id}`,
        actual: evidenceMatches,
      });
      continue;
    }

    if (exactMatches.length === 1) {
      processes.push({
        ...process,
        status: "compatible",
        reason: `Runtime process ${process.id} is present`,
        actual: exactMatches,
      });
      continue;
    }

    if (mismatchedCommandLabels.length > 0) {
      processes.push({
        ...process,
        status: "conflict",
        reason: `Runtime process ${process.id} has mismatched command or label evidence`,
        actual: mismatchedCommandLabels,
      });
      continue;
    }

    const liveLabelMatches = sameCwd.filter((pane) => pane.label === process.id && pane.processInfoAvailable && hasLiveProcessEvidence(pane.processInfo));
    if (liveLabelMatches.length > 0) {
      processes.push({
        ...process,
        status: "conflict",
        reason: `Runtime process ${process.id} has mismatched command or label evidence`,
        actual: liveLabelMatches,
      });
      continue;
    }

    if (commandMatches.length > 0) {
      processes.push({
        ...process,
        status: "conflict",
        reason: `Runtime process ${process.id} has mismatched command or label evidence`,
        actual: commandMatches,
      });
      continue;
    }

    if (matchingCommandLabels.length > 0) {
      processes.push({
        ...process,
        status: "missing",
        reason: `Runtime process ${process.id} could not be confirmed because pane process-info is unavailable`,
        actual: matchingCommandLabels,
      });
      continue;
    }

    processes.push({
      ...process,
      status: "missing",
      reason: `Runtime process ${process.id} is not running`,
      actual: [],
    });
  }

  const status = aggregateStatus(processes.map((process) => process.status));
  return {
    status,
    reason: status === "compatible"
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

async function findWorktreeByOperationPath(worktrees, operationPath, canonicalPath) {
  const expectedCanonicalPath = await canonicalPath(operationPath);
  return worktrees.find((item) => item.canonicalPath === expectedCanonicalPath) ?? null;
}

async function classifyOperation(operation, state, canonicalPath) {
  if (operation.kind === "herdr.worktree.ensure") {
    const worktree = await findWorktreeByOperationPath(state.worktrees, operation.path, canonicalPath);
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
    const worktree = await findWorktreeByOperationPath(state.worktrees, operation.path, canonicalPath);
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

export async function reconcilePlan(plan, { git, herdr, realpath = defaultRealpath }) {
  const canonicalPath = createCanonicalPath(realpath);
  const loadAgents = (() => {
    let pending;
    return async () => {
      pending ??= Promise.resolve(herdr.listAgents()).then((value) => listValue(value, "agents"));
      return await pending;
    };
  })();
  const worktrees = await classifyWorktrees(plan, git, canonicalPath);
  const workspace = await classifyWorkspace(plan, worktrees, herdr, canonicalPath);
  const tabs = await classifyTabs(plan, workspace, worktrees, herdr, loadAgents, canonicalPath);
  const agent = {
    ...plan.agent,
    ...await classifyAgent(plan, tabs, loadAgents, canonicalPath),
  };
  const runtime = {
    ...plan.runtime,
    ...await classifyRuntime(plan, tabs, tabs.panes, herdr, canonicalPath),
  };
  const conflicts = collectConflicts(worktrees.results, workspace, tabs.results, agent, runtime);
  const status = conflicts.length > 0
    ? "conflict"
    : aggregateStatus([
      ...worktrees.results.map((worktree) => worktree.status === "missing" ? "incomplete" : worktree.status),
      workspace.status === "missing" ? "incomplete" : workspace.status,
      ...tabs.results.map((tab) => ["missing", "incomplete"].includes(tab.status) ? "incomplete" : tab.status),
      agent.status === "missing" ? "incomplete" : agent.status,
      runtime.status,
    ]);

  const operations = [];
  for (const operation of plan.operations) {
    operations.push({
      ...operation,
      reconciliation: await classifyOperation(operation, {
        worktrees: worktrees.results,
        workspace,
        tabs: tabs.results,
        panes: tabs.panes,
        agent,
        runtime,
      }, canonicalPath),
    });
  }

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
