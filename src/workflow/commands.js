import { join } from "node:path";
import { planWorkflow } from "./planner.js";
import { loadRegistry, resolveProject } from "./registry.js";
import { reconcilePlan } from "./reconcile.js";

function quote(value) {
  return /[^A-Za-z0-9_./:-]/.test(value) ? JSON.stringify(value) : value;
}

function binaryCheck(name, path) {
  return path
    ? { id: `binary:${name}`, status: "ready", path }
    : { id: `binary:${name}`, status: "missing", reason: `${name} is not on PATH` };
}

function projectDescriptor(alias, project) {
  return { alias, label: project.label, kind: project.kind, repository: project.repository };
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
  const profile = extras.profile ?? options.runtimeProfile;
  if (profile) parts.push("--profile", profile);
  if (extras.yes) parts.push("--yes");
  return parts.join(" ");
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

function suggestedManifestFor(options, reconciliation) {
  if (reconciliation?.mode !== "group") return null;

  const selectedRepositories = reconciliation.repositories.map((repository) => repository.alias);
  const branches = Object.fromEntries(reconciliation.repositories.map((repository) => [repository.alias, repository.branch]));

  return {
    path: join(reconciliation.workspace.path, "coordination-manifest.json"),
    payload: {
      ticket: options.task,
      feature: options.feature ?? null,
      selectedRepositories,
      branches,
      integrationOrder: selectedRepositories,
      verificationCommands: [
        buildCommand("status", {
          projectAlias: options.projectAlias,
          task: options.task,
          feature: options.feature,
          repositories: selectedRepositories,
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
    return preconditions.pi.status === "ready"
      ? buildCommand("start", options, { yes: true })
      : buildCommand("doctor", { projectAlias: options.projectAlias });
  }

  if (!runtimePhaseReady(reconciliation)) {
    return buildCommand("runtime", options, {
      profile: reconciliation.runtime?.profileName ?? reconciliation.runtime?.tab?.profileName ?? reconciliation.runtime?.profile ?? reconciliation.runtime?.tab?.actual?.profileName ?? reconciliation.runtime?.tab?.actual?.profile ?? reconciliation.runtime?.tab?.profileName ?? reconciliation.runtime?.tab?.profile,
      yes: true,
    });
  }

  return buildCommand("status", options);
}

async function loadRegistryAndProject(options, injectedLoadRegistry) {
  const registry = await injectedLoadRegistry(options.registryPath);
  const project = resolveProject(registry, options.projectAlias);
  return { registry, project };
}

export async function doctorCommand(options = {}, {
  loadRegistry: injectedLoadRegistry = loadRegistry,
  git,
  herdr,
  lookupExecutable,
} = {}) {
  const { registry, project } = await loadRegistryAndProject(options, injectedLoadRegistry);
  const binaries = await resolveBinaries(lookupExecutable);
  const checks = [
    { id: "registry", status: "ready", path: options.registryPath },
    binaries.git,
    binaries.herdr,
    binaries.pi,
    ...await inspectProjectRepositories(options.projectAlias, project, git),
  ];

  if (binaries.herdr.status === "ready") {
    const liveStatus = await herdr.status();
    const compatible = Boolean(liveStatus?.server?.running) && Boolean(liveStatus?.server?.compatible);
    checks.push({
      id: "herdr:status",
      status: compatible ? "ready" : "conflict",
      value: liveStatus,
      ...(compatible ? {} : { reason: "Herdr server is not ready" }),
    });

    const integrations = await herdr.integrationStatus();
    const piIntegration = integrations.find((integration) => integration.name === "pi");
    checks.push(piIntegration?.status === "current"
      ? { id: "herdr:integration:pi", status: "ready", value: piIntegration }
      : {
          id: "herdr:integration:pi",
          status: piIntegration ? "conflict" : "missing",
          value: piIntegration ?? null,
          reason: piIntegration ? `Pi integration is ${piIntegration.status}` : "Pi integration is not installed",
        });
  }

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
  const preconditions = await resolveBinaries(lookupExecutable);
  const plan = planWorkflow({
    registry,
    projectAlias: options.projectAlias,
    task: options.task,
    feature: options.feature,
    repositories: options.repositories,
    runtimeProfile: options.runtimeProfile,
  });
  const reconciliation = await reconcilePlan(plan, { git, herdr });

  return {
    command: "plan",
    project: projectDescriptor(options.projectAlias, project),
    request: {
      task: options.task,
      feature: options.feature ?? null,
      repositories: options.repositories ?? [],
      runtimeProfile: options.runtimeProfile ?? null,
    },
    preconditions,
    reconciliation,
    conflicts: reconciliation.conflicts,
    nextCommand: nextCommandFor(options, preconditions, reconciliation),
    suggestedManifest: suggestedManifestFor(options, reconciliation),
  };
}

export async function statusCommand(options = {}, {
  loadRegistry: injectedLoadRegistry = loadRegistry,
  git,
  herdr,
  lookupExecutable,
} = {}) {
  const { registry, project } = await loadRegistryAndProject(options, injectedLoadRegistry);
  const preconditions = await resolveBinaries(lookupExecutable);
  const plan = planWorkflow({
    registry,
    projectAlias: options.projectAlias,
    task: options.task,
    feature: options.feature,
    repositories: options.repositories,
    runtimeProfile: options.runtimeProfile,
  });
  const reconciliation = await reconcilePlan(plan, { git, herdr });

  return {
    command: "status",
    project: projectDescriptor(options.projectAlias, project),
    request: {
      task: options.task,
      feature: options.feature ?? null,
      repositories: options.repositories ?? [],
      runtimeProfile: options.runtimeProfile ?? null,
    },
    preconditions,
    reconciliation,
    conflicts: reconciliation.conflicts,
    nextCommand: nextCommandFor(options, preconditions, reconciliation),
    suggestedManifest: suggestedManifestFor(options, reconciliation),
  };
}
