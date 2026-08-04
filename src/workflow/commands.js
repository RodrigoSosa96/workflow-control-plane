import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { agentStatus, paneId } from "./agent-status.js";
import { closeWorker as defaultCloseWorker } from "./close.js";
import { WorkflowError } from "./errors.js";
import { readCurrentResult as defaultReadCurrentResult, submitHandoff as defaultSubmitHandoff } from "./handoff.js";
import { submitDelegationHandoff as defaultSubmitDelegationHandoff } from "./delegation-handoff.js";
import { createDelegationReservationStore } from "./delegation-reservations.js";
import { createDelegationServices as defaultCreateDelegationServices } from "./delegation-services.js";
import { createDelegationStore } from "./delegation-store.js";
import {
  buildClaudeWorkerSettings,
  buildHarnessResume,
  CLAUDE_WORKER_SETTINGS_FILE,
  CONTROL_PLANE_ROOT,
  runEnv,
} from "./harnesses.js";
import { launchCommand as createWorkflowLaunchCommand } from "./launch.js";
import { classifyOwnership, isPlainMarker, OBSERVATION_FAILED } from "./ownership.js";
import { createSessionTransport as buildSessionTransport } from "./session-transport.js";
import { planWorkflow } from "./planner.js";
import { resolveAgentProfile } from "./profiles.js";
import { loadRegistry, resolveProject } from "./registry.js";
import { reconcilePlan } from "./reconcile.js";
import { executeResume as defaultExecuteResume } from "./resume.js";
import { isRunState, LIVE_RUN_STATES, RUN_STATES } from "./run-state.js";
import { createRunStore } from "./run-store.js";
import { isTelemetrySupportedVersion, telemetrySupportedVersions } from "./telemetry-adapters.js";
import { createTelemetryStore } from "./telemetry-store.js";
import { publicTelemetrySnapshot } from "./telemetry.js";
import { createWorkerWatch } from "./telemetry-watch.js";

export const RESULT_EXIT_CODES = Object.freeze({
  pending: 20,
  "result-stale": 21,
  "manual-handoff-required": 22,
});

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
const RUN_LIKE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [];
}

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
  return {
    alias,
    label: project.label,
    kind: project.kind,
    repository: project.repository,
    ...(Array.isArray(project.verify) ? { verify: [...project.verify] } : {}),
  };
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

// Reports the installed harness version against the versions telemetry pins.
// Telemetry fails closed to "unknown" on an unpinned version and every hook
// swallows its errors, so this is the one place a routine harness upgrade
// silently blanking telemetry becomes visible to the operator.
async function harnessTelemetryCheck(selectedAgent, harnessVersion) {
  const harness = selectedAgent.profile.harness;
  const expected = telemetrySupportedVersions(harness);
  const base = { harness, profileName: selectedAgent.name, expected: [...expected] };
  if (typeof harnessVersion !== "function") {
    return readinessCheck(`telemetry:${harness}`, "unknown", {
      ...base,
      value: null,
      reason: "Harness version inspection is unavailable",
    });
  }
  let version = null;
  try {
    version = await harnessVersion(selectedAgent);
  } catch (error) {
    return readinessCheck(`telemetry:${harness}`, "unknown", {
      ...base,
      value: null,
      reason: `Harness version could not be read: ${String(error?.message ?? error).slice(0, 200)}`,
    });
  }
  if (isTelemetrySupportedVersion(harness, version)) {
    return readinessCheck(`telemetry:${harness}`, "ready", { ...base, value: version });
  }
  return readinessCheck(`telemetry:${harness}`, "unknown", {
    ...base,
    value: version ?? null,
    reason: version
      ? `Installed ${harness} ${version} is not a telemetry-pinned version (${expected.join(", ") || "none"}); telemetry degrades to unknown`
      : "Harness version could not be parsed",
  });
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
  harnessVersion,
} = {}) {
  const { registry, project } = await loadRegistryAndProject(options, injectedLoadRegistry, { requireProject: false });
  const selectedAgent = selectAgent(registry, project, options);
  const preconditions = await resolvePreconditions(lookupExecutable, herdr, selectedAgent);
  const telemetryCheck = await harnessTelemetryCheck(selectedAgent, harnessVersion);
  const checks = [
    { id: "registry", status: "ready", path: options.registryPath },
    preconditions.git,
    preconditions.herdr,
    preconditions.agent,
    ...(project ? await inspectProjectRepositories(options.projectAlias, project, git) : []),
    preconditions.herdrStatus,
    preconditions.agentIntegration,
    telemetryCheck,
  ];

  return {
    command: "doctor",
    project: projectDescriptor(options.projectAlias, project),
    checks,
    // A telemetry version mismatch degrades observability only; it must not
    // make doctor report the environment as unusable for launching work.
    ok: checks.every((check) => check.status === "ready" || check.id === telemetryCheck.id),
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

function canonicalDelegationHandoffInputPath(run, delegationId) {
  return join(run.directory, "delegations", delegationId, "handoff-input.json");
}

function resultCommandFor(runId) {
  return `workflow result ${runId}`;
}

function reconcileCommandFor(runId) {
  return `workflow reconcile --run ${runId}`;
}

function relatedTicketsFromRun(run = {}) {
  if (Array.isArray(run.relatedTickets)) return run.relatedTickets.map(String);
  const primary = run.primaryTicket ?? run.task;
  return Array.isArray(run.tickets) ? run.tickets.map(String).filter((ticket) => ticket !== primary) : [];
}

function repositoryAliasesFromRun(run = {}) {
  if (Array.isArray(run.request?.repositories) && run.request.repositories.length > 0) {
    return run.request.repositories.map(String);
  }
  return Array.isArray(run.repositories)
    ? run.repositories.map((repository) => repository.alias ?? repository.id).filter(Boolean).map(String)
    : [];
}

function buildStatusCommandForRun(run = {}) {
  if (!run.projectAlias || !(run.task ?? run.primaryTicket)) return null;
  const parts = ["workflow", "status", run.projectAlias, run.task ?? run.primaryTicket];
  const feature = run.request?.feature ?? run.feature;
  const repositories = repositoryAliasesFromRun(run);
  const relatedTickets = relatedTicketsFromRun(run);
  if (feature) parts.push("--feature", quote(String(feature)));
  if (repositories.length) parts.push("--repos", repositories.join(","));
  if (relatedTickets.length) parts.push("--tickets", relatedTickets.join(","));
  return parts.join(" ");
}

function fallbackWorkspaceForRun(run = {}) {
  if (run.workspacePath) return run.workspacePath;
  if (Array.isArray(run.repositories) && run.repositories.length > 0) {
    return run.repositories[0].path ?? run.repositories[0].worktreePath ?? null;
  }
  return run.worktreePath ?? run.checkoutPath ?? null;
}

function runCommandSummary(run) {
  const statusCommand = buildStatusCommandForRun(run);
  return {
    resultCommand: resultCommandFor(run.id),
    reconcileCommand: reconcileCommandFor(run.id),
    handoffCommand: `workflow handoff ${run.id} --input ${canonicalHandoffInputPath(run)}`,
    ...(statusCommand ? { statusCommand } : {}),
  };
}

function runOutputBase(run) {
  const workspacePath = fallbackWorkspaceForRun(run);
  return {
    runId: run.id,
    runDirectory: run.directory,
    projectAlias: run.projectAlias,
    projectLabel: run.projectLabel,
    task: run.task ?? run.primaryTicket,
    primaryTicket: run.primaryTicket ?? run.task,
    relatedTickets: relatedTicketsFromRun(run),
    state: run.state,
    harness: run.harness,
    profileName: run.profileName,
    workspace: workspacePath ? { path: workspacePath } : null,
    fallbackWorkspace: workspacePath,
    tabId: run.tabId ?? null,
    paneId: run.paneId ?? null,
    agentId: run.agentId ?? null,
    nativeSessionId: run.nativeSessionId ?? null,
    ...runCommandSummary(run),
  };
}

function launchStateFromStatus(status) {
  if (status === "running") return RUN_STATES.RUNNING;
  if (status === "partial" || status === "failed") return RUN_STATES.FAILED;
  return status ?? null;
}

function agentOperationFromReport(report = {}) {
  return list(report.operations).find((operation) => operation.id === "agent" || operation.kind === "agent.session.start" || operation.kind === "pi.session.start") ?? null;
}

function runLikeFromLaunchPreview(report = {}, preview = {}) {
  const identity = preview.reconciliation?.identity ?? {};
  return {
    id: report.runId,
    directory: report.runDirectory,
    projectAlias: identity.projectAlias,
    projectLabel: identity.projectLabel,
    task: identity.task,
    primaryTicket: identity.primaryTicket ?? identity.task,
    relatedTickets: list(identity.relatedTickets).map(String),
    request: preview.request,
    repositories: list(preview.reconciliation?.repositories).map((repository) => ({
      id: repository.alias ?? repository.id,
      alias: repository.alias ?? repository.id,
      path: repository.worktreePath ?? repository.path,
    })),
  };
}

function decorateLaunchReport(report = {}, preview = {}) {
  const agentOperation = agentOperationFromReport(report);
  const workspacePath = preview.reconciliation?.workspace?.path ?? report.fallbackWorkspace ?? report.workspace?.path ?? null;
  const runLike = runLikeFromLaunchPreview(report, preview);
  return {
    ...report,
    state: report.state ?? launchStateFromStatus(report.status),
    harness: report.harness ?? preview.selection?.harness,
    profileName: report.profileName ?? preview.selection?.profileName,
    workspace: report.workspace ?? (workspacePath ? { path: workspacePath } : null),
    fallbackWorkspace: report.fallbackWorkspace ?? workspacePath,
    tabId: report.tabId ?? agentOperation?.tabId ?? agentOperation?.tab_id ?? null,
    paneId: report.paneId ?? agentOperation?.paneId ?? agentOperation?.pane_id ?? null,
    agentId: report.agentId ?? agentOperation?.agentId ?? agentOperation?.agent_id ?? null,
    resultCommand: report.resultCommand ?? resultCommandFor(report.runId),
    statusCommand: report.statusCommand ?? buildStatusCommandForRun(runLike),
    reconcileCommand: report.reconcileCommand ?? reconcileCommandFor(report.runId),
  };
}

function hasRegisteredResult(run) {
  return Boolean(run.resultPath || run.resultGeneration || run.resultArtifactDigest || run.resultStatus);
}

function pendingResultState(state) {
  return new Set([
    RUN_STATES.PLANNED,
    RUN_STATES.LAUNCHING,
    RUN_STATES.RUNNING,
    RUN_STATES.IDLE_AWAITING_HANDOFF,
    RUN_STATES.NEEDS_INPUT,
  ]).has(state);
}

function manualResultState(state) {
  return new Set([
    RUN_STATES.MANUAL_HANDOFF_REQUIRED,
    RUN_STATES.INTERRUPTED,
    RUN_STATES.FAILED,
  ]).has(state);
}

function stableResultExitCode(status) {
  return RESULT_EXIT_CODES[status] ?? 0;
}

async function stateRootForCommand(options = {}, deps = {}) {
  if (options.stateRoot) return options.stateRoot;
  if (deps.stateRoot) return deps.stateRoot;
  const injectedLoadRegistry = deps.loadRegistry ?? loadRegistry;
  const registry = await injectedLoadRegistry(options.registryPath);
  return registry.launcher.state_root;
}

async function storeForCommand(options = {}, deps = {}) {
  if (deps.store) return deps.store;
  const stateRoot = await stateRootForCommand(options, deps);
  const factory = deps.createRunStore ?? createRunStore;
  // deps.readOwnOwnership is bin/workflow.js's single per-process reader (see createLiveDependencies).
  // Threading it through here matters specifically when deps.store was NOT pre-built there --
  // i.e. WORKFLOW_STATE_ROOT is unset, the documented default, where stateRoot instead comes from
  // the registry a few lines up. Without this, that (normal) path would silently fall back to
  // createRunStore's own `readOwnOwnership: async () => null` default, and every lock marker this
  // store's own acquireLock writes would carry no pid/startedAt for `workflow unlock` to prove.
  return factory({ stateRoot, readOwnOwnership: deps.readOwnOwnership });
}

function usageError(message) {
  throw new WorkflowError("USAGE", message, { exitCode: 64 });
}

function assertKnownRunState(state) {
  if (!isRunState(state)) {
    // Same courtesy every other argument in this CLI gets (bin/workflow.js's
    // "--format must be compact or json." is the model) -- name what was rejected AND what
    // would have been accepted, so the operator does not have to go read run-state.js to find out.
    usageError(`Unknown run state: ${String(state)}. Valid states: ${Object.values(RUN_STATES).join(", ")}.`);
  }
}

// runsCommand needs list()'s skipped records back as data, not just written to the CLI's shared
// stderr reporter -- bin/workflow.js's reportListProblem, which is what deps.store already carries
// baked in whenever WORKFLOW_STATE_ROOT is set (storeForCommand's `if (deps.store) return
// deps.store` shortcut). A store's onListProblem is fixed at construction; there is no way to
// intercept it on an already-built store. So this builds its OWN store instance -- following
// stateRootForCommand's same resolution and the same createRunStore/readOwnOwnership threading
// storeForCommand uses -- with an onListProblem that collects into `skipped` instead of writing
// anywhere. It never touches, wraps, or repurposes the CLI's shared reporter, and it never calls
// storeForCommand, so every other command's stderr reporting is untouched by this function's
// existence.
async function runsStoreForCommand(options, deps) {
  const stateRoot = await stateRootForCommand(options, deps);
  const factory = deps.createRunStore ?? createRunStore;
  const skipped = [];
  const store = factory({
    stateRoot,
    readOwnOwnership: deps.readOwnOwnership,
    onListProblem: (problem) => skipped.push(problem),
  });
  return { store, skipped };
}

// Sorted separately from store.list(): that primitive's createdAt-ascending order is right for a
// store (and other callers may depend on it -- it is untouched by this command), but an operator
// asking "what is running right now" wants the most recently touched run first. `id` is a stable
// tiebreak only -- two runs sharing an updatedAt must still sort deterministically run to run.
function sortRunsForBoard(runs) {
  return [...runs].sort((left, right) => (
    String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id)
  ));
}

// Every read-only command asks store.list() to filter by project; only this command also decides
// WHICH states to show, because "what is running" has no single obvious answer -- see
// LIVE_RUN_STATES's own comment in run-state.js for why that set is a presentation decision, not
// a state-machine fact. `state` is the most specific ask and wins outright over `all`; with
// neither, the live set is the default so a run that fell out of it (completed/failed/interrupted)
// does not linger on the board an operator has stopped watching.
function selectRunsForBoard(runs, { state, all }) {
  if (state !== undefined) return runs.filter((run) => run.state === state);
  if (all) return runs;
  return runs.filter((run) => LIVE_RUN_STATES.has(run.state));
}

// The board underneath `workflow runs` (roadmap item 2.1): answers "what is running right now"
// across every project without an operator already knowing a run id. Read-only -- it only ever
// calls store.list(), never create/update -- so exit code is always 0: a report, not a check, the
// same contract with runs, without runs, and with skipped records.
export async function runsCommand(options = {}, deps = {}) {
  if (options.state !== undefined) assertKnownRunState(options.state);

  const { store, skipped } = await runsStoreForCommand(options, deps);
  const filters = options.projectAlias !== undefined ? { projectAlias: options.projectAlias } : {};
  const runs = await store.list(filters);

  return {
    command: "runs",
    runs: sortRunsForBoard(selectRunsForBoard(runs, { state: options.state, all: Boolean(options.all) })),
    skipped,
    exitCode: 0,
  };
}

// Herdr's listAgents() wire shape is `{agents: [...]}`, but some call sites (and test doubles)
// hand back a bare array -- the same normalization reconcile.js and execute.js already carry as
// private three-line helpers each; a third private copy here follows that precedent rather than
// promoting three lines to a shared module.
function listValue(value, key) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : [];
}

// herdr.listAgents() is called exactly once here and the result indexed by pane id -- see this
// function's only caller, inboxCommand, for why (the board can hold dozens of runs and Herdr is a
// subprocess, so one call amortized over every run beats one call per run). A missing/malformed
// adapter and a thrown/rejected listAgents() are both reported the same way -- herdrAvailable:
// false -- rather than thrown onward, because inboxCommand's whole contract is read-only, exit 0
// always, report what could not be determined rather than pretend the inbox is empty.
async function agentsByPaneFromHerdr(herdr) {
  if (!herdr || typeof herdr.listAgents !== "function") {
    return { agentsByPane: null, herdrAvailable: false };
  }
  try {
    const agents = listValue(await herdr.listAgents(), "agents");
    const agentsByPane = new Map();
    for (const agent of agents) {
      const key = paneId(agent);
      if (key) agentsByPane.set(key, agent);
    }
    return { agentsByPane, herdrAvailable: true };
  } catch {
    return { agentsByPane: null, herdrAvailable: false };
  }
}

// THE correlation `workflow inbox` exists around -- see
// docs/superpowers/specs/2026-08-04-workflow-inbox-design.md's "Correlation uses
// transportIdentity.paneId" section. `run.paneId` is written once, only "when the launch created
// the selected agent" (docs/run-record-fields.md), and never again. `executeResume`'s
// confirmed-relaunch path persists only `{transportIdentity, resumeClaim}` (resume.js:177), and
// the identity it persists carries the NEW pane `relaunchSession` (this file) creates -- so for
// every resumed run, the top-level `run.paneId` still names the pane Herdr closed when the
// original session died, while `run.transportIdentity.paneId` is the one actually alive. Reading
// `run.paneId` first silently loses every resumed run's blocked status: this command would report
// nothing for it, and "nothing" from an inbox reads as "nothing needs you" -- the one lie this
// command must not tell. Do NOT "simplify" this to `run.paneId ?? run.transportIdentity?.paneId`;
// that ordering is the bug this command exists to work around, not a style preference.
function correlationPaneId(run) {
  return run.transportIdentity?.paneId ?? run.paneId ?? null;
}

// Shared shape for every blocked/unresolved entry, so the two lists never drift apart on which
// fields identify a run: enough for an operator to act on (attach or `herdr agent send-keys` by
// pane, or `workflow result <runId>` for the rest) without exposing the whole run record --
// deliberately as small as `runs --format json`'s own projection (see runProjection's comment in
// format.js for why a board-scale JSON dump of full records is the wrong shape).
function inboxEntry(run, resolvedPaneId) {
  return {
    runId: run.id,
    projectAlias: run.projectAlias,
    primaryTicket: run.primaryTicket,
    harness: run.harness,
    paneId: resolvedPaneId,
  };
}

// `workflow inbox` (roadmap item 2.2): which of my workers are sitting at a permission prompt
// waiting on me, across every project, without looking at panes. Anchored on store.list() exactly
// like runsCommand -- `herdr agent list` returns every agent on the machine, including
// interactive sessions this control plane never launched, and a blocked agent with no run behind
// it is not this command's business (see the design spec's "anchored on runs, not agents"
// section). Read-only, exit 0 always: a blocked worker is information, not a failure, and an
// unreachable Herdr is reported via herdrAvailable/unresolved rather than thrown.
export async function inboxCommand(options = {}, deps = {}) {
  const { store, skipped } = await runsStoreForCommand(options, deps);
  const filters = options.projectAlias !== undefined ? { projectAlias: options.projectAlias } : {};
  // Only non-terminal runs have anything to wait on -- the same LIVE_RUN_STATES set runsCommand's
  // default view uses, and for the same reason (its own comment in run-state.js).
  const runs = (await store.list(filters)).filter((run) => LIVE_RUN_STATES.has(run.state));

  const { agentsByPane, herdrAvailable } = await agentsByPaneFromHerdr(deps.herdr);

  const blocked = [];
  const unresolved = [];
  for (const run of runs) {
    const pane = correlationPaneId(run);
    if (!herdrAvailable) {
      unresolved.push({ ...inboxEntry(run, pane), reason: "Herdr is unavailable" });
      continue;
    }
    if (!pane) {
      unresolved.push({ ...inboxEntry(run, pane), reason: "Run has no pane id recorded" });
      continue;
    }
    const agent = agentsByPane.get(pane);
    if (!agent) {
      unresolved.push({ ...inboxEntry(run, pane), reason: `No live Herdr agent found for pane ${pane}` });
      continue;
    }
    if (agentStatus(agent) === "blocked") {
      blocked.push(inboxEntry(run, pane));
    }
  }

  return {
    command: "inbox",
    blocked,
    unresolved,
    herdrAvailable,
    skipped,
    exitCode: 0,
  };
}

async function telemetryForCommand(options = {}, deps = {}) {
  if (deps.telemetry) return deps.telemetry;
  const store = await storeForCommand(options, deps);
  const factory = deps.createTelemetryStore ?? createTelemetryStore;
  return factory({ store });
}

function workerTelemetryFailure(error) {
  if (error instanceof WorkflowError && error.category === "telemetry") {
    throw new WorkflowError("PREFLIGHT", "Worker telemetry is malformed or unavailable; manual recovery required", { exitCode: 10 });
  }
  throw error;
}

export async function workerStatusCommand(options = {}, deps = {}) {
  const runId = assertPathSafeUuid(options.runId, "run ID");
  try {
    const telemetry = await telemetryForCommand(options, deps);
    const workers = await telemetry.read({ runId });
    if (!Array.isArray(workers)) throw new WorkflowError("telemetry", "Telemetry store returned invalid snapshots");
    return {
      command: "worker-status",
      runId,
      workers: workers.map((worker) => publicTelemetrySnapshot(worker)),
    };
  } catch (error) {
    return workerTelemetryFailure(error);
  }
}

export async function workerWatchCommand(options = {}, deps = {}) {
  const runId = assertPathSafeUuid(options.runId, "run ID");
  try {
    const telemetry = await telemetryForCommand(options, deps);
    return createWorkerWatch({
      runId,
      telemetry,
      ...(deps.workerWatchIntervalMs !== undefined ? { intervalMs: deps.workerWatchIntervalMs } : {}),
      ...(deps.workerWatchSleep ? { sleep: deps.workerWatchSleep } : {}),
      ...(deps.workerWatchSignal ? { signal: deps.workerWatchSignal } : {}),
    });
  } catch (error) {
    return workerTelemetryFailure(error);
  }
}

// Shared by every command that needs the delegation reservation store: reuses an injected
// deps.reservations verbatim (the live CLI path wires one, with readOwnOwnership, once per
// process -- see bin/workflow.js), otherwise constructs one from the state root. stateRoot is
// only resolved when actually needed, so an injected deps.reservations never forces a registry
// load just to compute a state root nothing will use.
async function reservationsForCommand(options = {}, deps = {}) {
  if (deps.reservations) return deps.reservations;
  const stateRoot = await stateRootForCommand(options, deps);
  const factory = deps.createDelegationReservationStore ?? createDelegationReservationStore;
  // Same reasoning, and the same single reader, as storeForCommand's readOwnOwnership threading
  // above -- this is the fallback path deps.reservations takes when bin/workflow.js did NOT
  // pre-build it (WORKFLOW_STATE_ROOT unset), which is `delegation release`/`remediate`/`runtime`'s
  // normal, documented configuration, not an edge case.
  return factory({ stateRoot, readOwnOwnership: deps.readOwnOwnership });
}

async function delegationStoresForCommand(options = {}, deps = {}) {
  const store = await storeForCommand(options, deps);
  return {
    store,
    delegations: deps.delegations ?? createDelegationStore({ store }),
    reservations: await reservationsForCommand(options, deps),
  };
}

function ensureMatchingRunProject(options, run, command) {
  if (options.projectAlias && run.projectAlias && options.projectAlias !== run.projectAlias) {
    throw new WorkflowError(command.toUpperCase(), `${command} project ${options.projectAlias} does not match run project ${run.projectAlias}`, { exitCode: 10 });
  }
}

function resultStatusWithoutArtifact(run) {
  if (run.state === RUN_STATES.RESULT_STALE) return "result-stale";
  if (manualResultState(run.state)) return "manual-handoff-required";
  if (pendingResultState(run.state)) return "pending";
  return "manual-handoff-required";
}

function reconcileStatusForRun(run) {
  if (run.state === RUN_STATES.RESULT_STALE) return "result-stale";
  if (hasRegisteredResult(run)) return run.resultStatus ?? run.state;
  if (manualResultState(run.state)) return "manual-handoff-required";
  if (pendingResultState(run.state)) return "pending";
  return run.state;
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

function assertDelegationId(value) {
  if (typeof value !== "string" || !value.trim()) {
    failHandoff("delegation ID is required");
  }
  return value.trim();
}

function delegationRecordFor(run, delegationId) {
  const record = run?.delegations?.[delegationId];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    failHandoff("Delegation was not found");
  }
  return record;
}

function assertDelegationWorkflowEnv(runId, delegationId, generation, env = {}) {
  assertWorkflowRunEnv(runId, env);
  if (env.WORKFLOW_DELEGATION_ID !== undefined && env.WORKFLOW_DELEGATION_ID !== delegationId) {
    failHandoff("WORKFLOW_DELEGATION_ID does not match the handoff delegation ID");
  }
  if (env.WORKFLOW_DELEGATION_GENERATION !== undefined && env.WORKFLOW_DELEGATION_GENERATION !== String(generation)) {
    failHandoff("WORKFLOW_DELEGATION_GENERATION does not match the active delegation generation");
  }
}

function parseHandoffJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    failHandoff("Handoff input JSON could not be parsed");
  }
}

function delegationError(category, message, exitCode = 10) {
  throw new WorkflowError(category, message, { exitCode });
}

function assertPathSafeUuid(value, label, category = "PREFLIGHT") {
  if (typeof value !== "string" || !RUN_LIKE_ID_RE.test(value)) {
    delegationError(category, `${label} must be a path-safe UUID`);
  }
  return value.toLowerCase();
}

function sha256Digest(text) {
  return `sha256:${createHash("sha256").update(String(text), "utf8").digest("hex")}`;
}

function delegationOwnership(record = {}) {
  const result = record.result ?? {};
  const hasOriginSession = Boolean(record.originSessionId);
  const consumed = Boolean(result.consumedBySessionId || result.consumedAt);
  const adopted = Boolean(result.adoptedBySessionId || result.adoptedAt);
  const consumedByOrigin = consumed && hasOriginSession && result.consumedBySessionId === record.originSessionId;
  let status = "available";
  if (adopted) status = "adopted";
  else if (consumed) status = consumedByOrigin ? "consumed-by-origin" : "consumed";
  return {
    status,
    hasOriginSession,
    consumed,
    consumedByOrigin,
    adopted,
  };
}

function publicDelegationResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return {
    status: result.status ?? null,
    generation: Number.isInteger(result.generation) ? result.generation : null,
    summary: result.summary ?? null,
    verification: list(result.verification).map((entry) => ({
      command: entry.command,
      status: entry.status,
    })),
    concerns: list(result.concerns).map(String),
    nextAction: result.nextAction ?? null,
  };
}

function delegationResultState(record = {}) {
  if (!record.result) {
    if (record.state === "prepared" || record.state === "running") return "pending";
    return record.state ?? "pending";
  }
  if (record.result.generation !== record.generation) return "result-stale";
  return record.result.status ?? record.state ?? "pending";
}

function stableDelegationExitCode(status) {
  return RESULT_EXIT_CODES[status] ?? 0;
}

function delegationBase(run = {}, record = {}) {
  return {
    runId: run.id,
    delegationId: record.id,
    projectAlias: run.projectAlias,
    projectLabel: run.projectLabel,
    role: record.role,
    mode: record.mode,
    state: record.state,
    generation: record.generation,
  };
}

function delegationCanonicality(run = {}, record = {}) {
  const canonical = Boolean(run.originSessionId) && run.originSessionId === record.originSessionId;
  return {
    canonical,
    advisory: true,
    advisoryReason: canonical ? "run-origin" : "external-run",
  };
}

function transportIdentityFor(value = {}) {
  if (value?.transportIdentity && typeof value.transportIdentity === "object" && !Array.isArray(value.transportIdentity)) {
    return value.transportIdentity;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.kind === "string") {
    return value;
  }
  return null;
}

function publicIdentity(value = {}) {
  const identity = transportIdentityFor(value);
  if (!identity) return { status: "missing" };
  return {
    status: "recorded",
    kind: identity.kind,
    pid: identity.pid,
    processStartedAt: identity.processStartedAt,
  };
}

function publicObservation(observation) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return { state: "not-observed" };
  return {
    state: observation.state ?? "not-observed",
  };
}

function publicReservation(record = {}, reservations = []) {
  const active = list(reservations).find((reservation) => reservation?.delegationId === record.id && reservation?.state === "active") ?? null;
  return {
    state: active?.state ?? "missing",
    retained: Boolean(active && record.startFailure),
  };
}

function remediationState(record = {}) {
  const total = Number.isInteger(record.remediationTurns) ? record.remediationTurns : 0;
  const used = Number.isInteger(record.remediationTurnsUsed) ? record.remediationTurnsUsed : 0;
  return {
    remainingTurns: Math.max(0, total - used),
    capped: used >= total,
  };
}

async function loadDelegationContext(options = {}, deps = {}, command = "delegation") {
  const runId = assertPathSafeUuid(options.runId, "run ID");
  const delegationId = assertPathSafeUuid(options.delegationId, "delegation ID");
  const store = await storeForCommand(options, deps);
  const reservations = await reservationsForCommand(options, deps);
  const run = await store.read(runId);
  ensureMatchingRunProject(options, run, command);
  const registry = deps.registry ?? await (deps.loadRegistry ?? loadRegistry)(options.registryPath);
  const project = resolveProject(registry, run.projectAlias);
  const record = delegationRecordFor(run, delegationId);
  return {
    runId,
    delegationId,
    store,
    delegations: deps.delegations ?? null,
    reservations,
    run,
    registry,
    project,
    record,
  };
}

function delegationServicesForContext(context, options = {}, deps = {}) {
  const transport = deps.transport;
  if (!transport) delegationError("PREFLIGHT", "delegation transport is required", 10);
  const injectedCreateDelegationServices = deps.createDelegationServices;
  const createDelegationServices = injectedCreateDelegationServices ?? defaultCreateDelegationServices;
  return createDelegationServices({
    registry: context.registry,
    projectAlias: context.project.alias ?? context.run.projectAlias,
    runStore: context.store,
    delegations: context.delegations ?? (injectedCreateDelegationServices ? deps.delegations ?? {} : createDelegationStore({ store: context.store })),
    reservations: context.reservations,
    transport,
    roles: deps.roles,
  });
}

function delegationReviewEvidence(preview) {
  return {
    generation: preview.generation,
    summary: "Approved via workflow delegation remediate CLI for the current delegation result",
    insideFrozenBrief: true,
  };
}

function delegationRemediationPreview(context, prompt) {
  const { run, record } = context;
  const status = delegationResultState(record);
  if (!record.result || status === "pending" || status === "result-stale") {
    delegationError("PREFLIGHT", "Delegation does not have a terminal current result");
  }
  if (remediationState(record).capped) {
    delegationError("PREFLIGHT", "Delegation remediation limit is exhausted");
  }
  const promptDigest = sha256Digest(prompt);
  const preview = {
    command: "delegation-remediate",
    ...delegationBase(run, record),
    status,
    resultStatus: record.result.status,
    remediation: remediationState(record),
    promptDigest,
    approvalDigest: null,
    nextActions: ["approve-remediation"],
  };
  preview.approvalDigest = sha256Digest(JSON.stringify({
    runId: preview.runId,
    delegationId: preview.delegationId,
    generation: preview.generation,
    role: preview.role,
    mode: preview.mode,
    resultStatus: preview.resultStatus,
    promptDigest,
  }));
  return preview;
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
  const handoffEnv = options.env ?? env;
  const result = await submitHandoff({
    store,
    git,
    runId,
    generation: run.generation ?? 1,
    input,
    stateRoot: handoffEnv.WORKFLOW_STATE_ROOT,
  });
  return result;
}

export async function delegationHandoffCommand(options = {}, deps = {}) {
  assertNoHandoffOutputPath(options);
  const runId = assertRunId(options.runId);
  const delegationId = assertDelegationId(options.delegationId);
  const env = options.env ?? deps.env ?? process.env;
  const { store, delegations, reservations } = await delegationStoresForCommand(options, deps);
  const fs = deps.fs ?? defaultFs;
  const submitDelegationHandoff = deps.submitDelegationHandoff ?? defaultSubmitDelegationHandoff;
  if (typeof fs?.readFile !== "function") {
    failHandoff("Filesystem read interface is required");
  }
  if (typeof submitDelegationHandoff !== "function") {
    failHandoff("submitDelegationHandoff interface is required");
  }

  const run = await store.read(runId);
  const record = delegationRecordFor(run, delegationId);
  assertDelegationWorkflowEnv(runId, delegationId, record.generation, env);
  const inputPath = canonicalDelegationHandoffInputPath(run, delegationId);
  assertCanonicalHandoffInput(options.input, inputPath);
  const input = parseHandoffJson(await fs.readFile(inputPath, "utf8"));
  return await submitDelegationHandoff({
    store,
    delegations,
    reservations,
    git: deps.git,
    runId,
    delegationId,
    input,
    claimToken: env.WORKFLOW_DELEGATION_CLAIM_TOKEN,
  });
}

export async function delegationResultCommand(options = {}, deps = {}) {
  const context = await loadDelegationContext(options, deps, "delegation result");
  const { run, record } = context;
  const status = delegationResultState(record);
  return {
    command: "delegation-result",
    ...delegationBase(run, record),
    status,
    resultStatus: record.result?.status ?? null,
    result: publicDelegationResult(record.result),
    ownership: delegationOwnership(record),
    ...delegationCanonicality(run, record),
    exitCode: stableDelegationExitCode(status),
    nextActions: status === "completed" || status === "blocked" || status === "failed"
      ? ["review-result", "reconcile"]
      : ["reconcile"],
  };
}

export async function delegationReconcileCommand(options = {}, deps = {}) {
  const context = await loadDelegationContext(options, deps, "delegation reconcile");
  const services = delegationServicesForContext(context, options, deps);
  const reconciled = await services.reconcile({ runId: context.runId, delegationId: context.delegationId });
  const reservations = await context.reservations.list({ projectAlias: context.run.projectAlias });
  return {
    command: "delegation-reconcile",
    ...delegationBase(context.run, context.record),
    status: reconciled.resultStatus ?? reconciled.state ?? context.record.state,
    resultStatus: reconciled.resultStatus ?? null,
    ownership: delegationOwnership(context.record),
    identity: publicIdentity(reconciled.identity ?? context.record),
    observation: publicObservation(reconciled.observation),
    reservation: publicReservation(context.record, reservations),
    remediation: remediationState(context.record),
    ...(context.record.startFailure ? { startFailure: { reason: context.record.startFailure.reason } } : {}),
    nextActions: list(reconciled.nextActions).map(String),
    cleanup: "none",
    repairs: [],
  };
}

export async function delegationReleaseCommand(options = {}, deps = {}) {
  const context = await loadDelegationContext(options, deps, "delegation release");
  const { run, record, reservations } = context;
  if (typeof reservations.releaseForDelegation !== "function") {
    delegationError("PREFLIGHT", "reservation store does not support delegation release", 10);
  }
  // A running delegation keeps its lease: its child may still submit a result,
  // and that submission requires a live matching reservation.
  if (record.state === "running") {
    delegationError("CONFLICT", "Delegation is still running; its reservation was not released", 11);
  }
  // A remediation in flight keeps a terminal-looking state while a follow-up
  // child has been (or may have been) spawned; releasing here would make that
  // child's handoff unrecordable.
  if (record.remediation?.state) {
    delegationError("CONFLICT", `Delegation remediation is ${record.remediation.state}; its reservation was not released`, 11);
  }

  const before = await reservations.list({ projectAlias: run.projectAlias });
  const active = list(before).filter((reservation) => reservation?.delegationId === record.id && reservation?.state === "active");
  if (!active.length) {
    return {
      command: "delegation-release",
      ...delegationBase(run, record),
      released: [],
      reservation: { state: "missing", retained: false },
      cleanup: "none",
      nextActions: ["reconcile"],
      exitCode: 0,
    };
  }
  if (!options.confirmed) {
    return {
      command: "delegation-release",
      ...delegationBase(run, record),
      action: "needs-confirmation",
      released: [],
      pending: active.map((reservation) => ({ id: reservation.id, resources: [...(reservation.resources ?? [])] })),
      cleanup: "none",
      nextActions: ["confirm-release"],
      exitCode: 0,
    };
  }

  const released = await reservations.releaseForDelegation({ projectAlias: run.projectAlias, delegationId: record.id });
  return {
    command: "delegation-release",
    ...delegationBase(run, record),
    action: "released",
    released: list(released).map((reservation) => ({ id: reservation.id, resources: [...(reservation.resources ?? [])] })),
    reservation: { state: "released", retained: false },
    // Releasing a lease frees capacity only; no worktree, process, session, or
    // run state is touched.
    cleanup: "none",
    nextActions: ["reconcile"],
    exitCode: 0,
  };
}

export async function delegationRemediateCommand(options = {}, deps = {}) {
  const context = await loadDelegationContext(options, deps, "delegation remediate");
  const prompt = typeof options.prompt === "string" ? options.prompt : "";
  const preview = delegationRemediationPreview(context, prompt);
  return {
    preview,
    async execute(executeOptions = {}) {
      if (executeOptions.approvalDigest !== preview.approvalDigest) {
        delegationError("PREFLIGHT", "Stale approval digest; rerun delegation preview before executing", 10);
      }
      const freshContext = await loadDelegationContext(options, deps, "delegation remediate");
      const freshPreview = delegationRemediationPreview(freshContext, prompt);
      if (freshPreview.approvalDigest !== preview.approvalDigest) {
        delegationError("PREFLIGHT", "Stale approval digest; rerun delegation preview before executing", 10);
      }
      const services = delegationServicesForContext(freshContext, options, deps);
      const report = await services.beginRemediation({
        runId: freshContext.runId,
        delegationId: freshContext.delegationId,
        expectedGeneration: freshPreview.generation,
        reviewEvidence: delegationReviewEvidence(freshPreview),
        prompt,
      });
      return {
        command: "delegation-remediate",
        ...delegationBase(freshContext.run, freshContext.record),
        status: report.resultStatus ?? report.state,
        resultStatus: report.resultStatus ?? null,
        nextActions: list(report.nextActions).map(String),
        state: report.state,
        generation: report.generation,
      };
    },
  };
}

export async function resultCommand(options = {}, deps = {}) {
  const store = await storeForCommand(options, deps);
  const readCurrentResult = deps.readCurrentResult ?? defaultReadCurrentResult;
  const runId = assertRunId(options.runId);
  const run = await store.read(runId);
  const base = runOutputBase(run);

  if (!hasRegisteredResult(run)) {
    const status = resultStatusWithoutArtifact(run);
    return {
      command: "result",
      ...base,
      status,
      exitCode: stableResultExitCode(status),
      nextActions: status === "pending"
        ? [base.resultCommand, base.reconcileCommand]
        : [base.reconcileCommand],
    };
  }

  const current = await readCurrentResult({ store, git: deps.git, runId, markStale: false });
  const status = current.status;
  return {
    command: "result",
    ...base,
    status,
    result: current.result,
    errors: current.errors ?? [],
    exitCode: stableResultExitCode(status),
    nextActions: status === "result-stale" ? [base.reconcileCommand] : [],
  };
}

// reconcile's own read-only lock diagnostic: reuses inspectLock (never removeLock) and
// classifyMarkerOwnership -- the same observe-and-classify step mutexOwnerRecoveryFlow's
// `classify` runs through below -- so an operator sees a recoverable lock's verdict exactly where
// they already look, without reconcile gaining a mutation path of its own. Returns undefined
// (the field must be ABSENT, not `lock: null`) when no lock is held, when the injected store
// predates inspectLock, AND when inspectLock itself throws: a diagnostic must never break
// reconcile, and inspectLock throws for the same odd-filesystem-state anomalies (EACCES/EIO/
// EISDIR reaching throwFs inside inspectLockInternal) that a genuinely wedged, crashed run is
// most likely to have -- exactly the run an operator reaches for reconcile to diagnose.
async function reconcileLockDiagnostic(store, runId, inspectProcess) {
  if (typeof store.inspectLock !== "function") return undefined;
  try {
    const inspected = await store.inspectLock(runId);
    if (!inspected) return undefined;
    const ownership = await classifyMarkerOwnership(inspected.marker, inspectProcess);
    return { ageMs: inspected.ageMs, stale: inspected.stale, ownership };
  } catch {
    return undefined;
  }
}

export async function reconcileCommand(options = {}, deps = {}) {
  const store = await storeForCommand(options, deps);
  const runId = assertRunId(options.runId);
  const run = await store.read(runId);
  ensureMatchingRunProject(options, run, "reconcile");
  const base = runOutputBase(run);
  const status = reconcileStatusForRun(run);
  const lock = await reconcileLockDiagnostic(store, runId, deps.inspectProcess);
  const nextActions = [
    base.resultCommand,
    ...(base.statusCommand ? [base.statusCommand] : []),
    base.handoffCommand,
    ...(lock?.ownership?.removable ? [`workflow unlock ${runId} --yes`] : []),
  ];

  return {
    command: "reconcile",
    ...base,
    projectAlias: options.projectAlias ?? base.projectAlias,
    status,
    nextActions,
    cleanup: "none",
    repairs: [],
    ...(lock ? { lock } : {}),
  };
}

function assertWorkerTransportDependency(deps, command) {
  if (!deps.transport) delegationError("PREFLIGHT", `${command} requires a worker transport`, 10);
  return deps.transport;
}

// resume/close operate on the top-level run's own transportIdentity, which is only ever
// absent or an exact-session identity — `kind: "pi-session"` or `kind: "claude-session"`
// (see execute.js/launch.js — delegation identities live under run.delegations[id], a
// separate field). Any `*-session` identity always needs the session transport (built here
// from the live Herdr adapter, per-harness via `identity.harness`); anything else falls back
// to whatever worker transport the caller already injected (e.g. the CLI's delegation
// transport), preserving the prior behavior for runs with no exact session identity.
function scopedRunStore(store, runId, run) {
  return {
    async read(requestedId) {
      return requestedId === runId ? run : await store.read(requestedId);
    },
    // Only executeResume's confirmed-relaunch path calls update (a foreground write triggered
    // by the user's `resume --yes`), to persist the relaunched pi-session's new pane/tab
    // identity. Delegates straight to the real run store; requestedId is not special-cased the
    // way read() is, since there is no cached run object to shortcut against.
    async update(requestedId, updater) {
      return await store.update(requestedId, updater);
    },
  };
}

function transportForRun(run, deps, command) {
  const identity = run?.transportIdentity;
  if (typeof identity?.kind === "string" && identity.kind.endsWith("-session")) {
    if (!deps.herdr) delegationError("PREFLIGHT", `${command} requires a worker transport`, 10);
    const createSessionTransport = deps.createSessionTransport ?? buildSessionTransport;
    return createSessionTransport({ herdr: deps.herdr, harness: identity.harness ?? "pi" });
  }
  return assertWorkerTransportDependency(deps, command);
}

// This is the same file the interactive launch generates into the run directory, regenerated
// here so a relaunch reloads working hooks/statusLine (the settings file itself is not carried
// across the dead session).

// Relaunch a dead *-session so it comes back exactly as the interactive launch left it: same
// native session (`--session-id <exact>`, never `--last`/`--continue`) AND the same
// lifecycle/observability wiring the interactive start set up (see execute.js's
// executeOrdinaryStart/executeGroupStart: createTab -> splitPane({ env }) -> startAgent). A
// pane from herdr.createTab carries no env on its own, so skipping the split-with-env step
// here would resume the native history with the widget/telemetry/lifecycle wiring silently
// dead. session-transport.js deliberately does not implement this itself (its start/
// deliverFollowUp are stubs) — relaunch is owned by resume. The per-harness argv itself comes
// from buildHarnessResume (harnesses.js), shared with `workflow launch`; the one thing that
// still branches on `identity.harness` here is regenerating Claude's --settings file.
async function relaunchSession(identity, deps) {
  const herdr = deps.herdr;
  if (!herdr || typeof herdr.createTab !== "function" || typeof herdr.splitPane !== "function" || typeof herdr.startAgent !== "function") {
    delegationError("PREFLIGHT", "resume relaunch requires a Herdr adapter with createTab, splitPane, and startAgent", 10);
  }
  if (typeof deps.lookupExecutable !== "function") {
    delegationError("PREFLIGHT", "resume relaunch requires a lookupExecutable dependency", 10);
  }
  if (!deps.store || typeof deps.store.read !== "function") {
    delegationError("PREFLIGHT", "resume relaunch requires a run store to rebuild the workflow environment", 10);
  }
  const harness = identity.harness === "claude" ? "claude" : identity.harness === "codex" ? "codex" : "pi";
  const command = await deps.lookupExecutable(harness);
  if (!command || !isAbsolute(command)) {
    const harnessLabel = harness === "claude" ? "Claude" : harness === "codex" ? "Codex" : "Pi";
    delegationError("PREFLIGHT", `${harnessLabel} executable must resolve to an absolute path to relaunch a session`, 10);
  }

  const run = await deps.store.read(identity.runId);
  // run.agentProfile.harness is the authoritative record of what was approved (it drives the
  // argv builder below); `harness` above is derived from the transport identity instead, for the
  // env/settings-regeneration/startAgent kind decisions that happen before the profile is even
  // read. The two must agree — a disagreement means a hand-edited or corrupted run.json, not
  // something to reconcile silently: left unchecked, it would start one harness's argv under
  // another harness's executable with no error (e.g. a codex argv run under the claude binary).
  if (run.agentProfile && run.agentProfile.harness !== harness) {
    delegationError(
      "PREFLIGHT",
      `Resume identity harness "${harness}" disagrees with the approved profile's harness "${run.agentProfile.harness}"`,
      10,
    );
  }
  const env = runEnv(run, harness);
  // Herdr agent names are limited to 1-32 chars ([a-z][a-z0-9_-]*). A full session UUID makes
  // `resume-<uuid>` 43 chars, which `herdr agent start` rejects — so the relaunch would create
  // the tab + split pane but never start the agent, and the user sees an empty panel on reopen.
  // Use the session id's first block (matching the tab label). The resume is driven by the exact
  // session id buildHarnessResume encodes into the argv below (each harness's own resume form —
  // `--session-id` for pi, `--resume` for claude, the `resume` subcommand for codex), not by this
  // display name, so shortening it is safe.
  const shortSessionId = String(identity.sessionId ?? "").slice(0, 8) || "session";
  const sessionName = `resume-${shortSessionId}`;

  let settingsPath;
  if (harness === "claude") {
    // Regenerate claude-worker-settings.json (the dead session left no live process to have
    // kept it current) so the resumed pane reloads the same lifecycle/statusLine hooks the
    // original interactive launch wired up, via the run store — not raw fs — mirroring how
    // launch.js itself writes this file (store.writePrivateFile, not a direct fs write).
    const settings = buildClaudeWorkerSettings({ controlPlaneRoot: CONTROL_PLANE_ROOT });
    await deps.store.writePrivateFile(identity.runId, {
      relativePath: CLAUDE_WORKER_SETTINGS_FILE,
      text: `${JSON.stringify(settings, null, 2)}\n`,
      updater: () => ({}),
    });
    settingsPath = join(run.directory, CLAUDE_WORKER_SETTINGS_FILE);
  }

  // The argv that reattaches to the exact native session, under the same security envelope the
  // original launch's approval covered — one builder shared with `workflow launch` (see
  // harnesses.js), so a flag added to a launch cannot be forgotten here. run.agentProfile is the
  // profile that produced the approved launch argv, persisted on the run at launch time; it is
  // never re-resolved from the registry, which may have changed since the approval. The resolved
  // executable replaces the persisted profile's (launch-time) command string. Called before any
  // Herdr mutation below (createTab/splitPane): planResume's gate (assertProfile) checks less
  // than this builder demands (e.g. settingsPath for an interactive claude resume), so a profile
  // that clears the gate can still fail here — and must fail before a tab/pane exists, not after.
  const { argv } = buildHarnessResume({
    profileName: run.profileName,
    profile: { ...run.agentProfile, command },
    sessionName,
    cwd: identity.cwd,
    run,
    sessionId: identity.sessionId,
    settingsPath,
  });
  // buildHarnessResume also returns `env`, discarded here: splitPane below needs the WORKFLOW_*
  // env before this argv exists, so it already took it from runEnv(run, harness) above instead.

  // A fresh tab (no env — Herdr's createTab has no env parameter) gives us a root pane to
  // split from, exactly like the interactive launch's bootstrap pane.
  const tab = await herdr.createTab({
    workspaceId: identity.workspaceId,
    cwd: identity.cwd,
    label: sessionName,
    focus: true,
  });
  // The WORKFLOW_* env goes on the split pane, exactly as the interactive launch's agent pane.
  const agentPane = await herdr.splitPane({
    paneId: tab.paneId,
    direction: "down",
    cwd: identity.cwd,
    env,
    focus: true,
  });

  const started = await herdr.startAgent({
    name: sessionName,
    paneId: agentPane.paneId,
    kind: harness,
    argv,
    timeout: 30000,
  });
  const newPaneId = started.paneId ?? agentPane.paneId;
  // Focus the resumed agent pane, not the fresh tab's empty root pane. createTab -> splitPane
  // leaves an empty shell pane above the agent (same shape as launch), and createTab/splitPane
  // focus lands on that shell; without this the relaunch surfaces the empty panel (observed).
  if (typeof herdr.focusAgent === "function") {
    await herdr.focusAgent({ target: newPaneId });
  }
  return {
    identity: {
      ...identity,
      paneId: newPaneId,
      tabId: started.tabId ?? tab.tabId,
    },
  };
}

// Back-compat alias: relaunchSession used to be Pi-only (relaunchPiSession). Nothing in this
// module still calls it under the old name, but keep the alias in case an external caller does.
const relaunchPiSession = relaunchSession;

export async function resumeCommand(options = {}, deps = {}) {
  const runId = assertRunId(options.runId);
  const store = await storeForCommand(options, deps);
  const run = await store.read(runId);
  const transport = transportForRun(run, deps, "resume");
  const executeResume = deps.executeResume ?? defaultExecuteResume;
  const relaunch = deps.relaunch ?? ((identity) => relaunchSession(identity, { ...deps, store }));
  const result = await executeResume({
    store: scopedRunStore(store, runId, run),
    transport,
    herdr: deps.herdr,
    runId,
    confirmed: Boolean(options.confirmed),
    relaunch,
  });
  return {
    command: "resume",
    runId,
    ...result,
  };
}

export async function closeCommand(options = {}, deps = {}) {
  const runId = assertRunId(options.runId);
  const store = await storeForCommand(options, deps);
  const run = await store.read(runId);
  const transport = transportForRun(run, deps, "close");
  const closeWorker = deps.closeWorker ?? defaultCloseWorker;
  const outcome = await closeWorker({ store: scopedRunStore(store, runId, run), transport, runId });
  return {
    command: "close",
    runId,
    ...outcome,
  };
}

// Shared by unlock (run lock) and delegation gate-clear (project reservation gate): the
// process-liveness probe for whichever mutex owner marker the caller is classifying. `null` is
// classifyOwnership's OWN sentinel for "a completed observation found nothing" (proven missing,
// owner-gone); it must never stand in for "this function did not observe at all", or the
// correctness of this repo's two destructive commands would depend on classifyOwnership checking
// pid/startedAt nullity before it looks at the observation -- reorder those checks (or introduce
// a marker shape that reaches the observation branch pid-less) and "I didn't look" silently
// becomes "proven dead". So every "did not observe" case returns OBSERVATION_FAILED here,
// unconditionally: a marker without BOTH a provable pid and startedAt (classifyOwnership requires
// both; a version-1 shape has neither), a missing inspector, or a throwing one (an ambiguous
// observation, by design). An ambiguous or unobserved owner is a verdict the operator sees
// ("unprovable"), never a command crash -- same fail-closed contract acquireLock's/acquireGate's
// readOwnOwnership gives a throwing inspectProcess.
async function observeOwner(marker, inspectProcess) {
  const provable = isPlainMarker(marker)
    && marker.pid !== null && marker.pid !== undefined
    && marker.startedAt !== null && marker.startedAt !== undefined;
  if (!provable) return OBSERVATION_FAILED;
  if (typeof inspectProcess !== "function") return OBSERVATION_FAILED;
  try {
    return await inspectProcess(String(marker.pid));
  } catch {
    return OBSERVATION_FAILED;
  }
}

// version 2 is the only shape acquireLock/acquireGate ever write with an explicit `version`
// field; a marker object with no `version` predates that (a version-1 marker, in
// classifyOwnership's own terms) rather than being unversioned nothing. Only a missing/unreadable
// marker (inspectLock's/inspectGate's marker: null, whether truly absent or ambiguous) reports
// markerVersion: null. Shared by unlock and delegation gate-clear -- both mutexes embed the same
// `version` field in the same place.
function ownerMarkerVersion(marker) {
  if (!isPlainMarker(marker)) return null;
  return Number.isInteger(marker.version) ? marker.version : 1;
}

// The observe-then-classify step: wrap the inspector so a throw becomes OBSERVATION_FAILED
// (observeOwner), then classify. This is the ONE place that combination is written -- both
// mutexOwnerRecoveryFlow's `classify` below and reconcileCommand's read-only lock diagnostic
// (above, in this file) call it, so reconcile surfacing the same verdict never becomes a third
// hand-rolled copy of this predicate. Exactly what review finding D17 this roadmap phase exists
// to stop repeating flagged: the same predicate hand-written four times, one copy weaker than the
// others.
async function classifyMarkerOwnership(marker, inspectProcess) {
  return classifyOwnership(marker, await observeOwner(marker, inspectProcess));
}

// The one place this repo's provable-owner-recovery predicate is written: classify the marker via
// classifyMarkerOwnership above, map (verdict x confirmed) to an action and an exit code, and
// re-classify inside `allow` against whatever marker `remove` actually re-reads -- never the
// up-front snapshot, which may be stale by the time confirmation arrives. `unlockCommand` and
// `delegationGateClearCommand` are this flow's only two callers; before this existed, each
// command re-derived (a variant of) this predicate by hand, which is exactly review finding D17
// this roadmap phase exists to stop repeating.
//
// `inspect` and `remove` are the mutex-specific operations (store.inspectLock/removeLock, or
// reservations.inspectGate/clearGate). `remove` must normalize its store's outcome to
// `{ success, reason, raw }` so this flow never needs to know whether the underlying store calls
// its boolean `removed` or `cleared`. `buildReport` turns the flow's generic
// `{ inspected, ownership, action, outcome, reason, exitCode }` into the command's own public
// shape; `action` is one of "no-target" | "refused" | "needs-confirmation" | "success", and each
// `buildReport` maps those onto its own vocabulary ("no-lock"/"removed" vs "no-gate"/"cleared").
async function mutexOwnerRecoveryFlow({ confirmed, inspectProcess, inspect, remove, buildReport }) {
  async function classify(marker) {
    return classifyMarkerOwnership(marker, inspectProcess);
  }

  const inspected = await inspect();
  if (!inspected) {
    return buildReport({ inspected: null, ownership: null, action: "no-target", outcome: null, reason: null, exitCode: 0 });
  }

  const ownership = await classify(inspected.marker);

  if (!ownership.removable) {
    return buildReport({ inspected, ownership, action: "refused", outcome: null, reason: ownership.reason, exitCode: 11 });
  }

  if (!confirmed) {
    return buildReport({ inspected, ownership, action: "needs-confirmation", outcome: null, reason: null, exitCode: 0 });
  }

  // `remove` re-reads the marker itself and hands THAT marker to `allow` -- it may differ from
  // the one classified above (time passed waiting on confirmation; a new owner may have since
  // acquired the mutex), so removal must be authorized against the freshly re-read marker, not
  // the earlier snapshot. `latestOwnership` captures whatever `allow` actually classified so the
  // final report reflects the verdict removal was authorized (or refused) against, not the
  // now-possibly-stale up-front one -- a machine caller must never see a removable verdict next
  // to a refused report, or vice versa.
  let latestOwnership = ownership;
  const outcome = await remove({
    allow: async (marker) => {
      latestOwnership = await classify(marker);
      return latestOwnership.removable;
    },
  });

  if (!outcome.success) {
    return buildReport({ inspected, ownership: latestOwnership, action: "refused", outcome: null, reason: outcome.reason, exitCode: 11 });
  }

  return buildReport({ inspected, ownership: latestOwnership, action: "success", outcome, reason: null, exitCode: 0 });
}

function unlockReport({ runId, lock, ownership, action, removed, reason = null, exitCode }) {
  return {
    command: "unlock",
    runId,
    lock,
    ownership,
    action,
    removed,
    reason,
    // Removing a lock only unblocks future writes; it never touches run state, worktrees,
    // Herdr tabs/panes, sessions, processes, or reservation leases.
    cleanup: "none",
    // Runnable, not a bare token: matches this repo's convention (and reconcile's own
    // nextActions, in this very branch) of emitting the exact command an operator or script can
    // paste/exec, not an opaque label they have to translate themselves.
    nextActions: action === "needs-confirmation" ? [`workflow unlock ${runId} --yes`] : [],
    exitCode,
  };
}

// unlock's read-only report otherwise reuses classifyOwnership's generic "not a recognizable
// marker object" reason for inspectLock's marker: null, which also covers the specific "more
// than one owner marker present" case inspectLock's own markerAmbiguous flag distinguishes
// (run-store.js) -- exactly the reason removeLock's refusal path already uses for it, but that
// path is never reached from here (a non-removable verdict refuses before `remove` is ever
// called; see mutexOwnerRecoveryFlow below). Sharpens the diagnostic text an operator sees on
// exactly the wedged-lock case that needs it; verdict/removable are untouched either way, so
// ambiguity still fails closed as "unprovable" regardless of which reason string is shown.
function withAmbiguousMarkerReason(inspected, ownership) {
  if (!ownership || !inspected?.markerAmbiguous) return ownership;
  return Object.freeze({
    ...ownership,
    reason: "more than one owner marker is present; refusing rather than guessing which is authoritative",
  });
}

// The blessed, confirmed exception to this repo's "crash residue is preserved and reported,
// never removed automatically" policy: removes exactly one run lock, and only when the lock's
// owner is PROVEN dead (classifyOwnership's `removable`), only with `confirmed: true`. A
// non-removable verdict ("owner-alive" or "unprovable") refuses regardless of `confirmed` --
// confirmation authorizes deleting proven-dead evidence, it can never override the proof itself.
// Built on mutexOwnerRecoveryFlow, shared with delegationGateClearCommand below.
export async function unlockCommand(options = {}, deps = {}) {
  const runId = assertPathSafeUuid(options.runId, "run ID");
  const store = await storeForCommand(options, deps);

  return mutexOwnerRecoveryFlow({
    confirmed: Boolean(options.confirmed),
    inspectProcess: deps.inspectProcess,
    inspect: () => store.inspectLock(runId),
    remove: async ({ allow }) => {
      const outcome = await store.removeLock(runId, { allow });
      return { success: outcome.removed, reason: outcome.reason, raw: outcome };
    },
    buildReport({ inspected, ownership, action, outcome, reason, exitCode }) {
      const lock = inspected ? { ageMs: inspected.ageMs, stale: inspected.stale, markerVersion: ownerMarkerVersion(inspected.marker) } : null;
      const reportedAction = action === "no-target" ? "no-lock" : action === "success" ? "removed" : action;
      return unlockReport({
        runId,
        lock,
        ownership: withAmbiguousMarkerReason(inspected, ownership),
        action: reportedAction,
        removed: outcome ? { markerPath: outcome.raw.markerPath, activePath: outcome.raw.activePath } : null,
        reason,
        exitCode,
      });
    },
  });
}

function gateClearReport({ projectAlias, gate, ownership, action, cleared, reason = null, exitCode }) {
  return {
    command: "delegation-gate-clear",
    projectAlias,
    gate,
    ownership,
    action,
    cleared,
    reason,
    // Clearing a gate only unblocks future reserve()/release() calls for the project; it never
    // touches leases, run state, worktrees, tabs, sessions, or processes.
    cleanup: "none",
    // Runnable, not a bare token -- see unlockReport's identical note above.
    nextActions: action === "needs-confirmation" ? [`workflow delegation gate-clear ${projectAlias} --yes`] : [],
    exitCode,
  };
}

// unlock's sibling for the per-project reservation gate: removes an active gate only when its
// owner is PROVEN dead, and only with `confirmed: true` -- same non-negotiable rule, `--yes` can
// never override proof. Unlike unlock, there is no run or delegation id to key off; the project
// is resolved through the registry alone (never loadDelegationContext, which requires both), so
// an unknown alias fails as a preflight error before any filesystem access. Built on
// mutexOwnerRecoveryFlow, shared with unlockCommand above.
export async function delegationGateClearCommand(options = {}, deps = {}) {
  await loadRegistryAndProject(options, deps.loadRegistry ?? loadRegistry);
  const projectAlias = options.projectAlias;
  const reservations = await reservationsForCommand(options, deps);

  return mutexOwnerRecoveryFlow({
    confirmed: Boolean(options.confirmed),
    inspectProcess: deps.inspectProcess,
    inspect: () => reservations.inspectGate({ projectAlias }),
    remove: async ({ allow }) => {
      const outcome = await reservations.clearGate({ projectAlias, allow });
      return { success: outcome.cleared, reason: outcome.reason, raw: outcome };
    },
    buildReport({ inspected, ownership, action, outcome, reason, exitCode }) {
      const gate = inspected ? { markerVersion: ownerMarkerVersion(inspected.marker) } : null;
      const reportedAction = action === "no-target" ? "no-gate" : action === "success" ? "cleared" : action;
      return gateClearReport({
        projectAlias,
        gate,
        ownership,
        action: reportedAction,
        cleared: outcome ? { activeGate: outcome.raw.activeGate } : null,
        reason,
        exitCode,
      });
    },
  });
}

export async function launchCommand(options = {}, deps = {}) {
  const stateRoot = await stateRootForCommand(options, deps);
  const controlPlaneBin = options.controlPlaneBin ?? deps.controlPlaneBin;
  // deps.readOwnOwnership is bin/workflow.js's single per-process reader (see
  // createLiveDependencies). Threading it through here matters exactly like storeForCommand's own
  // threading above: whenever deps.store was NOT pre-built there -- i.e. WORKFLOW_STATE_ROOT is
  // unset, the documented default -- this is the fallback construction. Without it, every lock
  // launch's own writes acquire (create, writeAssignment, the LAUNCHING/RUNNING/FAILED
  // transitions) would carry no pid/startedAt, and a crash mid-launch -- the single most
  // crash-prone window in the whole system -- would leave residue `workflow unlock`/`reconcile`
  // can never prove dead. Final-review finding 1: this call site bypassed storeForCommand
  // entirely and was the one createRunStore call this roadmap item's own acquisition path missed.
  const store = deps.store ?? (deps.createRunStore ?? createRunStore)({ stateRoot, readOwnOwnership: deps.readOwnOwnership });
  const registry = deps.registry ?? await loadRegistry(options.registryPath, { fs: deps.fs });
  const command = await createWorkflowLaunchCommand({ ...options, stateRoot, controlPlaneBin }, {
    ...deps,
    store,
    stateRoot,
    controlPlaneBin,
    registry,
    planCommand: deps.planCommand ?? planCommand,
  });
  return {
    preview: command.preview,
    async execute(executeOptions = {}) {
      return decorateLaunchReport(await command.execute(executeOptions), command.preview);
    },
  };
}
