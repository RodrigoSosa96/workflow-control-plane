import { join } from "node:path";
import { planWorkflow } from "./planner.js";
import { loadRegistry, resolveProject } from "./registry.js";
import { reconcilePlan } from "./reconcile.js";

const EMPTY_HERDR_READ_MODEL = {
  async listWorkspaces() {
    return { workspaces: [] };
  },
  async listTabs() {
    return { tabs: [] };
  },
  async listPanes() {
    return { panes: [] };
  },
  async listAgents() {
    return { agents: [] };
  },
};

function quote(value) {
  return /[^A-Za-z0-9_./:-]/.test(value) ? JSON.stringify(value) : value;
}

function binaryCheck(name, path) {
  return path
    ? { id: `binary:${name}`, status: "ready", path }
    : { id: `binary:${name}`, status: "missing", reason: `${name} is not on PATH` };
}

function projectDescriptor(alias, project) {
  if (!project) return null;
  return { alias, label: project.label, kind: project.kind, repository: project.repository };
}

function readinessCheck(id, status, extra = {}) {
  return {
    id,
    status,
    ...extra,
  };
}

function ready(value) {
  return value?.status === "ready";
}

function herdrServerCheck(liveStatus, reason = "Herdr server is not ready") {
  const compatible = Boolean(liveStatus?.server?.running) && Boolean(liveStatus?.server?.compatible);
  return compatible
    ? readinessCheck("herdr:status", "ready", { value: liveStatus })
    : readinessCheck("herdr:status", "conflict", { value: liveStatus ?? null, reason });
}

function piIntegrationCheck(integrations, reason) {
  const piIntegration = integrations.find((integration) => integration.name === "pi");
  if (piIntegration?.status === "current") {
    return readinessCheck("herdr:integration:pi", "ready", { value: piIntegration });
  }
  return readinessCheck("herdr:integration:pi", piIntegration ? "conflict" : "missing", {
    value: piIntegration ?? null,
    reason: reason ?? (piIntegration ? `Pi integration is ${piIntegration.status}` : "Pi integration is not installed"),
  });
}

async function resolveBinaries(lookupExecutable) {
  const [gitPath, herdrPath, piPath] = await Promise.all([
    lookupExecutable("git"),
    lookupExecutable("herdr"),
    lookupExecutable("pi"),
  ]);

  return {
    git: binaryCheck("git", gitPath),
    herdr: binaryCheck("herdr", herdrPath),
    pi: binaryCheck("pi", piPath),
  };
}

async function resolvePreconditions(lookupExecutable, herdr) {
  const binaries = await resolveBinaries(lookupExecutable);
  const preconditions = { ...binaries };

  if (!ready(binaries.herdr)) {
    return {
      ...preconditions,
      herdrStatus: readinessCheck("herdr:status", "missing", { value: null, reason: binaries.herdr.reason }),
      piIntegration: readinessCheck("herdr:integration:pi", "missing", { value: null, reason: binaries.herdr.reason }),
    };
  }

  if (typeof herdr?.status === "function") {
    try {
      preconditions.herdrStatus = herdrServerCheck(await herdr.status());
    } catch (error) {
      preconditions.herdrStatus = herdrServerCheck(null, error.message);
    }
  } else {
    preconditions.herdrStatus = herdrServerCheck(null, "Herdr status inspection is unavailable");
  }

  if (typeof herdr?.integrationStatus === "function") {
    try {
      preconditions.piIntegration = piIntegrationCheck(await herdr.integrationStatus());
    } catch (error) {
      preconditions.piIntegration = piIntegrationCheck([], error.message);
    }
  } else {
    preconditions.piIntegration = piIntegrationCheck([], "Herdr integration inspection is unavailable");
  }

  return preconditions;
}

function herdrReadModel(preconditions, herdr) {
  return ready(preconditions.herdr) && ready(preconditions.herdrStatus)
    ? herdr
    : EMPTY_HERDR_READ_MODEL;
}

async function inspectProjectRepositories(projectAlias, project, git) {
  const targets = project.repository === "group"
    ? [
        { id: `repository:${projectAlias}`, path: project.coordination.meta_repository },
        ...Object.entries(project.repositories).map(([alias, repository]) => ({ id: `repository:${alias}`, path: repository.path })),
      ]
    : [{ id: `repository:${projectAlias}`, path: project.path }];

  const checks = [];
  for (const target of targets) {
    try {
      const repository = await git.inspectRepository({ cwd: target.path });
      checks.push({
        id: target.id,
        status: "ready",
        path: target.path,
        commonDirPath: repository.commonDirPath,
        rootPath: repository.rootPath,
      });
    } catch (error) {
      checks.push({
        id: target.id,
        status: "conflict",
        path: target.path,
        reason: error.message,
      });
    }
  }

  return checks;
}

function buildCommand(name, options, extras = {}) {
  const parts = ["workflow", name, options.projectAlias];
  if (options.task) parts.push(options.task);
  if (options.feature) parts.push("--feature", quote(options.feature));
  if (options.repositories?.length) parts.push("--repos", options.repositories.join(","));
  if (name !== "doctor" && options.tickets?.length) parts.push("--tickets", options.tickets.join(","));
  const profile = extras.profile ?? options.runtimeProfile;
  if (profile) parts.push("--profile", profile);
  if (extras.yes) parts.push("--yes");
  return parts.join(" ");
}

function selectedRepositoriesForRequest(options, plan) {
  if (Array.isArray(plan?.repositories) && plan.repositories.length > 0) {
    return plan.repositories.map((repository) => repository.alias);
  }
  return options.repositories ?? [];
}

function requestFromPlan(options, plan) {
  return {
    task: plan.identity.task,
    tickets: plan.identity.tickets,
    relatedTickets: plan.identity.relatedTickets,
    feature: options.feature ?? null,
    repositories: selectedRepositoriesForRequest(options, plan),
    runtimeProfile: options.runtimeProfile ?? null,
  };
}

function cliRequestFromPlan(options, plan) {
  return {
    projectAlias: options.projectAlias,
    task: plan.identity.task,
    feature: options.feature,
    repositories: selectedRepositoriesForRequest(options, plan),
    tickets: plan.identity.relatedTickets,
    runtimeProfile: options.runtimeProfile,
  };
}

function startPhaseReady(reconciliation) {
  return reconciliation.operations
    .filter((operation) => operation.phase === "start")
    .every((operation) => operation.reconciliation.status === "compatible" || operation.reconciliation.status === "open");
}

function runtimePhaseReady(reconciliation) {
  return reconciliation.operations
    .filter((operation) => operation.phase === "runtime")
    .every((operation) => operation.reconciliation.status === "compatible");
}

function startMutationReady(preconditions) {
  return ready(preconditions.git)
    && ready(preconditions.herdr)
    && ready(preconditions.pi)
    && ready(preconditions.herdrStatus)
    && ready(preconditions.piIntegration);
}

function runtimeMutationReady(preconditions) {
  return ready(preconditions.git)
    && ready(preconditions.herdr)
    && ready(preconditions.herdrStatus);
}

function suggestedManifestFor(options, reconciliation) {
  if (reconciliation?.mode !== "group") return null;

  const selectedRepositories = reconciliation.repositories.map((repository) => repository.alias);
  const branches = Object.fromEntries(reconciliation.repositories.map((repository) => [repository.alias, repository.branch]));

  return {
    path: join(reconciliation.workspace.path, "coordination-manifest.json"),
    payload: {
      ticket: reconciliation.identity.primaryTicket,
      tickets: reconciliation.identity.tickets,
      relatedTickets: reconciliation.identity.relatedTickets,
      feature: options.feature ?? null,
      selectedRepositories,
      branches,
      integrationOrder: selectedRepositories,
      verificationCommands: [
        buildCommand("status", {
          projectAlias: options.projectAlias,
          task: reconciliation.identity.task,
          feature: options.feature,
          repositories: selectedRepositories,
          tickets: reconciliation.identity.relatedTickets,
          runtimeProfile: options.runtimeProfile,
        }),
        ...selectedRepositories.map((alias) => `git -C repos/${alias} status --short`),
      ],
    },
  };
}

function nextCommandFor(options, preconditions, reconciliation) {
  if (reconciliation.status === "conflict") return null;

  if (!startPhaseReady(reconciliation)) {
    return startMutationReady(preconditions)
      ? buildCommand("start", options, { yes: true })
      : buildCommand("doctor", { projectAlias: options.projectAlias });
  }

  if (!runtimePhaseReady(reconciliation)) {
    return runtimeMutationReady(preconditions)
      ? buildCommand("runtime", options, {
        profile: reconciliation.runtime?.profileName ?? reconciliation.runtime?.tab?.profileName ?? reconciliation.runtime?.profile ?? reconciliation.runtime?.tab?.actual?.profileName ?? reconciliation.runtime?.tab?.actual?.profile ?? reconciliation.runtime?.tab?.profileName ?? reconciliation.runtime?.tab?.profile,
        yes: true,
      })
      : buildCommand("doctor", { projectAlias: options.projectAlias });
  }

  return buildCommand("status", options);
}

async function loadRegistryAndProject(options, injectedLoadRegistry, { requireProject = true } = {}) {
  const registry = await injectedLoadRegistry(options.registryPath);
  const project = options.projectAlias === undefined && !requireProject
    ? null
    : resolveProject(registry, options.projectAlias);
  return { registry, project };
}

export async function doctorCommand(options = {}, {
  loadRegistry: injectedLoadRegistry = loadRegistry,
  git,
  herdr,
  lookupExecutable,
} = {}) {
  const { project } = await loadRegistryAndProject(options, injectedLoadRegistry, { requireProject: false });
  const preconditions = await resolvePreconditions(lookupExecutable, herdr);
  const checks = [
    { id: "registry", status: "ready", path: options.registryPath },
    preconditions.git,
    preconditions.herdr,
    preconditions.pi,
    ...(project ? await inspectProjectRepositories(options.projectAlias, project, git) : []),
    preconditions.herdrStatus,
    preconditions.piIntegration,
  ];

  return {
    command: "doctor",
    project: projectDescriptor(options.projectAlias, project),
    checks,
    ok: checks.every((check) => check.status === "ready"),
    registryPath: options.registryPath,
  };
}

export async function planCommand(options = {}, {
  loadRegistry: injectedLoadRegistry = loadRegistry,
  git,
  herdr,
  lookupExecutable,
} = {}) {
  const { registry, project } = await loadRegistryAndProject(options, injectedLoadRegistry);
  const preconditions = await resolvePreconditions(lookupExecutable, herdr);
  const plan = planWorkflow({
    registry,
    projectAlias: options.projectAlias,
    task: options.task,
    tickets: options.tickets,
    feature: options.feature,
    repositories: options.repositories,
    runtimeProfile: options.runtimeProfile,
  });
  const reconciliation = await reconcilePlan(plan, { git, herdr: herdrReadModel(preconditions, herdr) });
  const request = requestFromPlan(options, plan);
  const cliRequest = cliRequestFromPlan(options, plan);

  return {
    command: "plan",
    project: projectDescriptor(options.projectAlias, project),
    request,
    preconditions,
    reconciliation,
    conflicts: reconciliation.conflicts,
    nextCommand: nextCommandFor(cliRequest, preconditions, reconciliation),
    suggestedManifest: suggestedManifestFor(cliRequest, reconciliation),
  };
}

export async function statusCommand(options = {}, {
  loadRegistry: injectedLoadRegistry = loadRegistry,
  git,
  herdr,
  lookupExecutable,
} = {}) {
  const { registry, project } = await loadRegistryAndProject(options, injectedLoadRegistry);
  const preconditions = await resolvePreconditions(lookupExecutable, herdr);
  const plan = planWorkflow({
    registry,
    projectAlias: options.projectAlias,
    task: options.task,
    tickets: options.tickets,
    feature: options.feature,
    repositories: options.repositories,
    runtimeProfile: options.runtimeProfile,
  });
  const reconciliation = await reconcilePlan(plan, { git, herdr: herdrReadModel(preconditions, herdr) });
  const request = requestFromPlan(options, plan);
  const cliRequest = cliRequestFromPlan(options, plan);

  return {
    command: "status",
    project: projectDescriptor(options.projectAlias, project),
    request,
    preconditions,
    reconciliation,
    conflicts: reconciliation.conflicts,
    nextCommand: nextCommandFor(cliRequest, preconditions, reconciliation),
    suggestedManifest: suggestedManifestFor(cliRequest, reconciliation),
  };
}
