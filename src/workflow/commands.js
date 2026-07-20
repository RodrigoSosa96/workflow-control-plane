import * as defaultFs from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkflowError } from "./errors.js";
import { submitHandoff as defaultSubmitHandoff } from "./handoff.js";
import { launchCommand as createWorkflowLaunchCommand } from "./launch.js";
import { planWorkflow } from "./planner.js";
import { resolveAgentProfile } from "./profiles.js";
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

function agentBinaryCheck(selectedAgent, path) {
  const command = selectedAgent.profile.command;
  const check = binaryCheck(command, path);
  return {
    ...check,
    harness: selectedAgent.profile.harness,
    profileName: selectedAgent.name,
  };
}

function agentIntegrationCheck(selectedAgent, integrations, reason) {
  const harness = selectedAgent.profile.harness;
  const integration = integrations.find((entry) => entry.name === harness);
  const id = `herdr:integration:${harness}`;
  if (integration?.status === "current") {
    return readinessCheck(id, "ready", {
      harness,
      profileName: selectedAgent.name,
      value: integration,
    });
  }
  return readinessCheck(id, integration ? "conflict" : "missing", {
    harness,
    profileName: selectedAgent.name,
    value: integration ?? null,
    reason: reason ?? (integration ? `${harness} integration is ${integration.status}` : `${harness} integration is not installed`),
  });
}

async function resolveBinaries(lookupExecutable, selectedAgent) {
  const [gitPath, herdrPath, agentPath] = await Promise.all([
    lookupExecutable("git"),
    lookupExecutable("herdr"),
    lookupExecutable(selectedAgent.profile.command),
  ]);

  const agent = agentBinaryCheck(selectedAgent, agentPath);
  const binaries = {
    git: binaryCheck("git", gitPath),
    herdr: binaryCheck("herdr", herdrPath),
    agent,
  };
  if (selectedAgent.profile.harness === "pi") binaries.pi = agent;
  return binaries;
}

async function resolvePreconditions(lookupExecutable, herdr, selectedAgent) {
  const binaries = await resolveBinaries(lookupExecutable, selectedAgent);
  const preconditions = { ...binaries };

  if (!ready(binaries.herdr)) {
    const agentIntegration = readinessCheck(`herdr:integration:${selectedAgent.profile.harness}`, "missing", {
      harness: selectedAgent.profile.harness,
      profileName: selectedAgent.name,
      value: null,
      reason: binaries.herdr.reason,
    });
    return {
      ...preconditions,
      herdrStatus: readinessCheck("herdr:status", "missing", { value: null, reason: binaries.herdr.reason }),
      agentIntegration,
      ...(selectedAgent.profile.harness === "pi" ? { piIntegration: agentIntegration } : {}),
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
      preconditions.agentIntegration = agentIntegrationCheck(selectedAgent, await herdr.integrationStatus());
    } catch (error) {
      preconditions.agentIntegration = agentIntegrationCheck(selectedAgent, [], error.message);
    }
  } else {
    preconditions.agentIntegration = agentIntegrationCheck(selectedAgent, [], "Herdr integration inspection is unavailable");
  }
  if (selectedAgent.profile.harness === "pi") preconditions.piIntegration = preconditions.agentIntegration;

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
  if (options.agentProfile && name !== "runtime") parts.push("--agent", options.agentProfile);
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
    agentProfile: options.agentProfile,
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
    && ready(preconditions.agent ?? preconditions.pi)
    && ready(preconditions.herdrStatus)
    && ready(preconditions.agentIntegration ?? preconditions.piIntegration);
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
      : buildCommand("doctor", { projectAlias: options.projectAlias, agentProfile: options.agentProfile });
  }

  if (!runtimePhaseReady(reconciliation)) {
    return runtimeMutationReady(preconditions)
      ? buildCommand("runtime", options, {
        profile: reconciliation.runtime?.profileName ?? reconciliation.runtime?.tab?.profileName ?? reconciliation.runtime?.profile ?? reconciliation.runtime?.tab?.actual?.profileName ?? reconciliation.runtime?.tab?.actual?.profile ?? reconciliation.runtime?.tab?.profileName ?? reconciliation.runtime?.tab?.profile,
        yes: true,
      })
      : buildCommand("doctor", { projectAlias: options.projectAlias, agentProfile: options.agentProfile });
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

function selectAgent(registry, project, options = {}) {
  return resolveAgentProfile({
    registry,
    project,
    requestedProfile: options.agentProfile,
  });
}

function globalAgentProfileDiagnostics(registry, { include = false } = {}) {
  if (!include) return undefined;
  return Object.entries(registry.launcher.agent_profiles).map(([name, profile]) => ({
    name,
    harness: profile.harness,
    command: profile.command,
    roles: profile.roles,
  }));
}

export async function doctorCommand(options = {}, {
  loadRegistry: injectedLoadRegistry = loadRegistry,
  git,
  herdr,
  lookupExecutable,
} = {}) {
  const { registry, project } = await loadRegistryAndProject(options, injectedLoadRegistry, { requireProject: false });
  const selectedAgent = selectAgent(registry, project, options);
  const preconditions = await resolvePreconditions(lookupExecutable, herdr, selectedAgent);
  const checks = [
    { id: "registry", status: "ready", path: options.registryPath },
    preconditions.git,
    preconditions.herdr,
    preconditions.agent,
    ...(project ? await inspectProjectRepositories(options.projectAlias, project, git) : []),
    preconditions.herdrStatus,
    preconditions.agentIntegration,
  ];

  return {
    command: "doctor",
    project: projectDescriptor(options.projectAlias, project),
    checks,
    ok: checks.every((check) => check.status === "ready"),
    registryPath: options.registryPath,
    agentProfiles: globalAgentProfileDiagnostics(registry, { include: !project && !options.agentProfile }),
  };
}

export async function planCommand(options = {}, {
  loadRegistry: injectedLoadRegistry = loadRegistry,
  git,
  herdr,
  lookupExecutable,
} = {}) {
  const { registry, project } = await loadRegistryAndProject(options, injectedLoadRegistry);
  const selectedAgent = selectAgent(registry, project, options);
  const preconditions = await resolvePreconditions(lookupExecutable, herdr, selectedAgent);
  const plan = planWorkflow({
    registry,
    projectAlias: options.projectAlias,
    task: options.task,
    tickets: options.tickets,
    feature: options.feature,
    repositories: options.repositories,
    runtimeProfile: options.runtimeProfile,
    agentProfile: options.agentProfile,
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
  const selectedAgent = selectAgent(registry, project, options);
  const preconditions = await resolvePreconditions(lookupExecutable, herdr, selectedAgent);
  const plan = planWorkflow({
    registry,
    projectAlias: options.projectAlias,
    task: options.task,
    tickets: options.tickets,
    feature: options.feature,
    repositories: options.repositories,
    runtimeProfile: options.runtimeProfile,
    agentProfile: options.agentProfile,
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

function failHandoff(message, details) {
  throw new WorkflowError("HANDOFF", message, { details, exitCode: 10 });
}

function assertRunId(value) {
  if (typeof value !== "string" || !value.trim()) {
    failHandoff("run ID is required");
  }
  return value.trim();
}

function canonicalHandoffInputPath(run) {
  return join(run.directory, "handoff-input.json");
}

function assertCanonicalHandoffInput(inputPath, expectedPath) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    failHandoff("Handoff --input is required and must be the canonical run-directory handoff-input.json path");
  }
  if (inputPath !== expectedPath || resolve(inputPath) !== resolve(expectedPath)) {
    failHandoff("Handoff input must be the canonical run-directory handoff-input.json path; arbitrary input paths are not accepted");
  }
}

function assertNoHandoffOutputPath(options) {
  if (options.output !== undefined || options.outputPath !== undefined || options.resultPath !== undefined) {
    failHandoff("Handoff output paths are not accepted; submitHandoff creates the canonical run-directory result.json");
  }
}

function assertWorkflowRunEnv(runId, env = {}) {
  if (env.WORKFLOW_RUN_ID !== undefined && env.WORKFLOW_RUN_ID !== runId) {
    failHandoff("WORKFLOW_RUN_ID does not match the handoff run ID");
  }
}

function parseHandoffJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    failHandoff("Handoff input JSON could not be parsed");
  }
}

export async function handoffCommand(options = {}, {
  store,
  git,
  fs = defaultFs,
  env = process.env,
  submitHandoff = defaultSubmitHandoff,
} = {}) {
  assertNoHandoffOutputPath(options);
  const runId = assertRunId(options.runId);
  assertWorkflowRunEnv(runId, options.env ?? env);
  if (!store || typeof store.read !== "function") {
    failHandoff("Run store interface is required");
  }
  if (typeof fs?.readFile !== "function") {
    failHandoff("Filesystem read interface is required");
  }
  if (typeof submitHandoff !== "function") {
    failHandoff("submitHandoff interface is required");
  }

  const run = await store.read(runId);
  const inputPath = canonicalHandoffInputPath(run);
  assertCanonicalHandoffInput(options.input, inputPath);
  const input = parseHandoffJson(await fs.readFile(inputPath, "utf8"));
  return await submitHandoff({
    store,
    git,
    runId,
    generation: run.generation ?? 1,
    input,
  });
}

export async function launchCommand(options = {}, deps = {}) {
  return await createWorkflowLaunchCommand(options, {
    ...deps,
    planCommand: deps.planCommand ?? planCommand,
  });
}
