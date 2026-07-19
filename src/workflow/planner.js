import { join } from "node:path";
import { WorkflowError } from "./errors.js";
import { expandTemplate, slugify, boundLabel } from "./naming.js";
import { resolveAgentProfile } from "./profiles.js";
import { resolveProject } from "./registry.js";
import { normalizeTicketBundle } from "./tickets.js";

function fail(category, message, options) {
  throw new WorkflowError(category, message, options);
}

function clone(value) {
  return structuredClone(value);
}

function selectRuntime(projectAlias, project, runtimeProfile) {
  if (!project.runtime) {
    if (runtimeProfile) {
      fail("plan", `Project ${projectAlias} does not define runtime profiles`);
    }
    return { profileName: null, processes: [] };
  }

  const profileName = runtimeProfile ?? project.runtime.default_profile;
  const profile = project.runtime.profiles?.[profileName];
  if (!profile) {
    fail("plan", `Unknown runtime profile ${profileName} for project ${projectAlias}`);
  }

  return {
    profileName,
    processes: clone(profile.processes ?? []),
  };
}

function sanitizeAgentProfile(profile) {
  const snapshot = {
    mode: profile.mode,
    model: profile.model,
    arguments: clone(profile.arguments ?? []),
  };

  if (profile.harness === "claude") {
    snapshot.permission_mode = profile.permission_mode;
  }

  if (profile.harness === "codex") {
    snapshot.sandbox = profile.sandbox;
    snapshot.approval_policy = profile.approval_policy;
  }

  return snapshot;
}

function buildIdentity({ projectAlias, project, bundle, feature, slug }) {
  return {
    projectAlias,
    projectLabel: project.label,
    projectKind: project.kind,
    task: bundle.primary,
    primaryTicket: bundle.primary,
    relatedTickets: bundle.related,
    tickets: bundle.all,
    feature: feature ?? null,
    slug,
  };
}

function buildAgent({ selectedAgent, sessionName, worktreePath, tabLabel }) {
  return {
    command: selectedAgent.profile.command,
    sessionName,
    tabLabel,
    worktreePath,
    profileName: selectedAgent.name,
    harness: selectedAgent.profile.harness,
    roles: clone(selectedAgent.profile.roles),
    profile: sanitizeAgentProfile(selectedAgent.profile),
  };
}

function buildOrdinaryPlan({ registry, projectAlias, project, bundle, slug, feature, runtimeProfile, selectedAgent }) {
  const taskId = bundle.primary;
  const worktreePath = expandTemplate(project.worktree.path_template, {
    worktree_root: registry.launcher.worktree_root,
    project: projectAlias,
    task: taskId,
    slug,
  });
  const branch = expandTemplate(project.worktree.branch_template, {
    project: projectAlias,
    task: taskId,
    slug,
  });
  const workspaceLabel = boundLabel(`${taskId} ${slug}`);
  const sessionName = expandTemplate(registry.launcher.session_template, {
    project: projectAlias,
    task: taskId,
    slug,
  });
  const runtime = selectRuntime(projectAlias, project, runtimeProfile);
  const identity = buildIdentity({ projectAlias, project, bundle, feature, slug });
  const agent = buildAgent({
    selectedAgent,
    sessionName,
    worktreePath,
    tabLabel: "agent",
  });

  return {
    mode: "ordinary",
    identity,
    repositories: [],
    worktrees: [
      {
        role: "primary",
        path: worktreePath,
        branch,
        baseBranch: project.base_branch,
        repositoryPath: project.path,
        label: workspaceLabel,
      },
    ],
    workspace: {
      kind: "ordinary",
      label: workspaceLabel,
      path: worktreePath,
    },
    tabs: [
      {
        label: "agent",
        kind: "agent",
        phase: "start",
        worktreePath,
        sessionName,
      },
      {
        label: "runtime",
        kind: "runtime",
        phase: "runtime",
        worktreePath,
        profileName: runtime.profileName,
        processes: runtime.processes,
      },
    ],
    agent,
    runtime: {
      profileName: runtime.profileName,
      processes: runtime.processes,
      worktreePath,
      tabLabel: "runtime",
    },
    operations: [
      {
        id: "worktree",
        kind: "herdr.worktree.ensure",
        phase: "start",
        cwd: project.path,
        branch,
        base: project.base_branch,
        path: worktreePath,
        label: workspaceLabel,
      },
      {
        id: "workspace",
        kind: "herdr.workspace.ensure",
        phase: "start",
        cwd: worktreePath,
        label: workspaceLabel,
      },
      {
        id: "agent-tab",
        kind: "herdr.tab.ensure",
        phase: "start",
        cwd: worktreePath,
        label: "agent",
      },
      {
        id: "agent",
        kind: "pi.session.start",
        phase: "start",
        cwd: worktreePath,
        command: agent.command,
        sessionName,
        tabLabel: "agent",
      },
      {
        id: "runtime-tab",
        kind: "herdr.tab.ensure",
        phase: "runtime",
        cwd: worktreePath,
        label: "runtime",
      },
      {
        id: "runtime",
        kind: "workflow.runtime.start",
        phase: "runtime",
        cwd: worktreePath,
        profileName: runtime.profileName,
        processes: runtime.processes,
      },
    ],
  };
}

function selectRepositories(projectAlias, project, repositories) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    fail("plan", `Project ${projectAlias} requires --repos to select child repositories`);
  }

  const uniqueAliases = [...new Set(repositories.map((alias) => String(alias).trim()).filter(Boolean))].sort();
  return uniqueAliases.map((alias) => {
    const repository = project.repositories?.[alias];
    if (!repository) fail("plan", `Unknown workflow repository: ${alias}`);
    return { alias, ...clone(repository) };
  });
}

function buildGroupPlan({ registry, projectAlias, project, bundle, slug, feature, repositories, runtimeProfile, selectedAgent }) {
  const taskId = bundle.primary;
  const workspacePath = expandTemplate(project.worktree.path_template, {
    worktree_root: registry.launcher.worktree_root,
    project: projectAlias,
    task: taskId,
    slug,
  });
  const branch = expandTemplate(project.worktree.branch_template, {
    project: projectAlias,
    task: taskId,
    slug,
  });
  const workspaceLabel = boundLabel(`${taskId} ${slug}`);
  const sessionName = expandTemplate(registry.launcher.session_template, {
    project: projectAlias,
    task: taskId,
    slug,
  });
  const runtime = selectRuntime(projectAlias, project, runtimeProfile);
  const selectedRepositories = selectRepositories(projectAlias, project, repositories);
  const childWorktrees = selectedRepositories.map((repository) => {
    const worktreePath = join(workspacePath, project.coordination.repos_directory, repository.alias);
    const childBranch = expandTemplate(repository.branch_template, {
      project: projectAlias,
      repository: repository.alias,
      task: taskId,
      slug,
    });
    return {
      alias: repository.alias,
      path: repository.path,
      baseBranch: repository.base_branch,
      branch: childBranch,
      worktreePath,
    };
  });
  const identity = buildIdentity({ projectAlias, project, bundle, feature, slug });
  const agent = buildAgent({
    selectedAgent,
    sessionName,
    worktreePath: workspacePath,
    tabLabel: "coordinator",
  });

  return {
    mode: "group",
    identity,
    repositories: childWorktrees,
    worktrees: [
      {
        role: "meta",
        path: workspacePath,
        branch,
        repositoryPath: project.coordination.meta_repository,
        label: workspaceLabel,
      },
      ...childWorktrees.map((repository) => ({
        role: "child",
        alias: repository.alias,
        path: repository.worktreePath,
        branch: repository.branch,
        baseBranch: repository.baseBranch,
        repositoryPath: repository.path,
      })),
    ],
    workspace: {
      kind: "group",
      label: workspaceLabel,
      path: workspacePath,
    },
    tabs: [
      {
        label: "coordinator",
        kind: "agent",
        phase: "start",
        worktreePath: workspacePath,
        sessionName,
      },
      ...childWorktrees.map((repository) => ({
        label: repository.alias,
        kind: "repository",
        phase: "start",
        worktreePath: repository.worktreePath,
      })),
      {
        label: "runtime",
        kind: "runtime",
        phase: "runtime",
        worktreePath: workspacePath,
        profileName: runtime.profileName,
        processes: runtime.processes,
      },
    ],
    agent,
    runtime: {
      profileName: runtime.profileName,
      processes: runtime.processes,
      worktreePath: workspacePath,
      tabLabel: "runtime",
    },
    operations: [
      {
        id: "meta-worktree",
        kind: "herdr.worktree.ensure",
        phase: "start",
        cwd: project.coordination.meta_repository,
        branch,
        path: workspacePath,
        label: workspaceLabel,
      },
      ...childWorktrees.map((repository) => ({
        id: `child-worktree:${repository.alias}`,
        kind: "git.worktree.ensure",
        phase: "start",
        cwd: repository.path,
        branch: repository.branch,
        base: repository.baseBranch,
        path: repository.worktreePath,
        label: workspaceLabel,
      })),
      {
        id: "coordinator-tab",
        kind: "herdr.tab.ensure",
        phase: "start",
        cwd: workspacePath,
        label: "coordinator",
      },
      ...childWorktrees.map((repository) => ({
        id: `child-tab:${repository.alias}`,
        kind: "herdr.tab.ensure",
        phase: "start",
        cwd: repository.worktreePath,
        label: repository.alias,
      })),
      {
        id: "agent",
        kind: "pi.session.start",
        phase: "start",
        cwd: workspacePath,
        command: agent.command,
        sessionName,
        tabLabel: "coordinator",
      },
      {
        id: "runtime-tab",
        kind: "herdr.tab.ensure",
        phase: "runtime",
        cwd: workspacePath,
        label: "runtime",
      },
      {
        id: "runtime",
        kind: "workflow.runtime.start",
        phase: "runtime",
        cwd: workspacePath,
        profileName: runtime.profileName,
        processes: runtime.processes,
      },
    ],
  };
}

export function planWorkflow({ registry, projectAlias, task, tickets, feature, repositories, runtimeProfile, agentProfile } = {}) {
  const project = resolveProject(registry, projectAlias);
  const bundle = normalizeTicketBundle({
    primary: task,
    related: tickets,
    maxTickets: registry.launcher.max_bundle_tickets,
  });
  const slug = feature ? slugify(feature) : slugify(bundle.primary);
  const selectedAgent = resolveAgentProfile({
    registry,
    project,
    requestedProfile: agentProfile,
  });

  return project.repository === "group"
    ? buildGroupPlan({
      registry,
      projectAlias,
      project,
      bundle,
      slug,
      feature,
      repositories,
      runtimeProfile,
      selectedAgent,
    })
    : buildOrdinaryPlan({
      registry,
      projectAlias,
      project,
      bundle,
      slug,
      feature,
      runtimeProfile,
      selectedAgent,
    });
}
