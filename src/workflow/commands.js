import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { agentStatus, HERDR_AGENT_STATUSES, HERDR_BLOCKED_STATUS, listValue, paneId } from "./agent-status.js";
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
import { APPROVAL_DIGEST_PATTERN, canonicalText, launchCommand as createWorkflowLaunchCommand } from "./launch.js";
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
import { runVerifyCommand as defaultRunVerifyCommand } from "./verify-runner.js";

export const RESULT_EXIT_CODES = Object.freeze({
  pending: 20,
  "result-stale": 21,
  "manual-handoff-required": 22,
});

// verifyCommand's own exit codes. Pass/fail follow every other read command's 0/nonzero
// convention; `refused` is its own value (not reused from RESULT_EXIT_CODES or the PREFLIGHT
// family in bin/workflow.js) because a refusal here is not "an error occurred" -- it's the
// command's designed response to "there is nothing to verify", and it needs to stay
// distinguishable from a verification that ran and failed (exitCode 1).
export const VERIFY_EXIT_CODES = Object.freeze({
  passed: 0,
  failed: 1,
  refused: 10,
});

// mergeCommand's own exit codes (roadmap item 2.4). `refused` and `conflicted` deliberately reuse
// the values bin/workflow.js already maps WorkflowError's PREFLIGHT and CONFLICT categories to
// (10 and 11), because merge produces both shapes: a refusal the dry-run PRINTS as a preview, and
// a refusal it THROWS from execute -- and an operator scripting against the exit code must not
// have to know which path produced it. `partial` reuses launch's own 13 (bin/workflow.js:840) for
// the same meaning: some of the work happened and some did not. A partial group merge is never
// reported as `merged`, and its exit code is never 0.
export const MERGE_EXIT_CODES = Object.freeze({
  merged: 0,
  failed: 1,
  refused: 10,
  conflicted: 11,
  partial: 13,
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

function verifyCommandFor(runId) {
  return `workflow verify ${runId}`;
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
    verifyCommand: verifyCommandFor(run.id),
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
//
// Roadmap item 2.5's board change: an ARCHIVED run is excluded from both the default view and
// `--all`, and an explicit `--state` still shows it. That asymmetry is the point -- `--all` means
// "every state", not "every record ever created", and the whole reason `workflow archive` marks the
// record instead of deleting the run directory is so the board can stop showing residue an operator
// has already dealt with (the relief item 2.1 explicitly named when it measured the 12-14 run JSON
// ceiling with no cleanup available). An explicit `--state completed` is an explicit ask for that
// state's records, archived or not, and narrowing it would leave an operator with no way to see an
// archived run from this command at all.
//
// The predicate is `typeof run.archivedAt === "string"`, deliberately not truthiness and
// deliberately not a boolean field: the record has to answer *when*, and only a full archive stamps
// it (a partial one leaves it unset on purpose, so the board can never hide a run that still has
// worktrees on disk).
//
// What is hidden is COUNTED and returned, never merely dropped -- item 2.1's own rule for skipped
// crash residue, applied to the residue this command chooses not to show.
function isArchivedRun(run) {
  return typeof run?.archivedAt === "string";
}

function selectRunsForBoard(runs, { state, all }) {
  if (state !== undefined) return { runs: runs.filter((run) => run.state === state), archivedHidden: 0 };
  const inScope = all ? runs : runs.filter((run) => LIVE_RUN_STATES.has(run.state));
  const visible = inScope.filter((run) => !isArchivedRun(run));
  // Counted against what this view would otherwise have shown, not against the whole store: the
  // default (live) view can hardly ever contain an archived run -- archiving a live run is refused
  // -- and reporting "12 archived hidden" under a board that was never going to show them would be
  // a true number answering a question nobody asked.
  return { runs: visible, archivedHidden: inScope.length - visible.length };
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
  const selected = selectRunsForBoard(runs, { state: options.state, all: Boolean(options.all) });

  return {
    command: "runs",
    runs: sortRunsForBoard(selected.runs),
    skipped,
    archivedHidden: selected.archivedHidden,
    exitCode: 0,
  };
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

// Shared shape for every blocked/waiting/unresolved entry, so the three lists never drift apart
// on which fields identify a run: enough for an operator to act on (attach or `herdr agent
// send-keys` by pane, or `workflow result <runId>` for the rest) without exposing the whole run
// record -- deliberately as small as `runs --format json`'s own projection (see runProjection's
// comment in format.js for why a board-scale JSON dump of full records is the wrong shape).
// Carries `state` -- added after running this command against the developer's real state root
// surfaced a design gap (see the correction paragraph in
// docs/superpowers/specs/2026-08-04-workflow-inbox-design.md): without it, the renderer cannot
// tell a `manual-handoff-required`/`needs-input` run whose worker exited normally apart from a
// `running` run whose pane vanished unexpectedly. Both used to read as the same diagnostic; only
// `state` lets a caller (here, or `formatInbox`) tell them apart.
function inboxEntry(run, resolvedPaneId) {
  return {
    runId: run.id,
    state: run.state,
    projectAlias: run.projectAlias,
    primaryTicket: run.primaryTicket,
    harness: run.harness,
    paneId: resolvedPaneId,
  };
}

// States whose own definition already means "waiting on the operator" -- `manual-handoff-required`
// is written when the worker gave up and needs a human (lifecycle.js:77); `needs-input` is a
// worker's own handoff saying the same (handoff.js:17); `blocked` is a worker's own self-reported
// "I am stuck" (handoff.js:16) -- by this design's own Problem section, a worker that told us it
// is blocked is waiting on the operator exactly as unambiguously as manual-handoff-required is
// (branch review finding I3). A run in any of these three, whether or not its agent resolved and
// whatever its agent status turns out to be, belongs in `waiting` -- see `inboxCommand` below,
// where this set is checked before agent resolution is even attempted, not only inside the
// branches where resolution failed (that was the C1 finding: a manual-handoff-required run whose
// agent was still alive and idle -- the ordinary shape right after a "manual" hook action leaves
// the harness Stop to proceed, per hooks/lib/lifecycle-hook-core.mjs -- fell through this file's
// old agent-status check and was silently dropped). A run in one of these states having no live
// Herdr agent is *also* an expected shape, not a surprise: the worker already exited (or, for
// self-reported `blocked`, said it needed help) and left the next move to the operator. Reporting
// that the same way as a `running` run's vanished pane -- "No live Herdr agent found for pane X"
// -- tells the operator the wrong thing: it reads as an infrastructure problem about a pane, when
// the real, actionable fact is `workflow result <run-id>`. See this file's `inboxCommand` and the
// design spec's correction paragraph for the real-data run that found this.
//
// `result-stale` is deliberately NOT in this set -- a decision made explicitly during the branch
// review, not fallen into. Unlike the three states above, it is not a worker self-reporting "I
// need a human": it means the result recorded on disk no longer matches what the control plane
// currently expects (missing, invalid, or a generation/fingerprint mismatch -- handoff.js's
// `readCurrentResult`/`markResultStale`), a fact the worker itself may not know. That is exactly
// what `unresolved` means -- the control plane does not know what is currently true -- not "a
// human is needed." Its own recommended next action (`workflow reconcile`, this file's
// `nextActions` for `status === "result-stale"`) is a diagnostic command, not an acknowledgement.
// A `result-stale` run whose agent cannot be confirmed keeps the vanished-pane framing in
// `unresolved`, same as any other active run.
const AWAITS_OPERATOR_STATES = new Set([
  RUN_STATES.MANUAL_HANDOFF_REQUIRED,
  RUN_STATES.NEEDS_INPUT,
  RUN_STATES.BLOCKED,
]);

// The message for a `waiting` entry: what the run's own state already means, and the one command
// that answers it -- never the vanished-pane detail, which is exactly the misleading framing this
// bucket exists to avoid (see AWAITS_OPERATOR_STATES's comment above).
function awaitsOperatorReason(run) {
  return `Waiting on you (${run.state}): run \`workflow result ${run.id}\``;
}

// Reason text for an agent whose status this command does not treat as confirming the run clear:
// absent (Herdr reported no agent_status field at all), `unknown` (Herdr's own documented "could
// not determine" value), or anything outside HERDR_AGENT_STATUSES entirely (an unrecognized or,
// per the C2 finding, a possibly-renamed value). All three used to fall through the old bare
// `agentStatus(agent) === "blocked"` comparison in silence, indistinguishable from "confirmed not
// blocked" -- naming which one it was is the fix.
function unresolvedAgentStatusReason(status, pane) {
  if (status === null) return `Herdr reported no agent_status for pane ${pane}`;
  if (status === "unknown") return `Herdr could not determine agent status for pane ${pane} (agent_status: unknown)`;
  return `Herdr reported an unrecognized agent status "${status}" for pane ${pane}, outside the vocabulary this command knows`;
}

// `workflow inbox` (roadmap item 2.2): which of my workers are waiting on me -- at a permission
// prompt, or because their own state already means they need a human -- across every project,
// without looking at panes. Anchored on store.list() exactly like runsCommand -- `herdr agent
// list` returns every agent on the machine, including interactive sessions this control plane
// never launched, and a blocked agent with no run behind it is not this command's business (see
// the design spec's "anchored on runs, not agents" section). Read-only, exit 0 always: a blocked
// or waiting worker is information, not a failure, and an unreachable Herdr is reported via
// herdrAvailable/unresolved rather than thrown.
export async function inboxCommand(options = {}, deps = {}) {
  const { store, skipped } = await runsStoreForCommand(options, deps);
  const filters = options.projectAlias !== undefined ? { projectAlias: options.projectAlias } : {};
  // Only non-terminal runs have anything to wait on -- the same LIVE_RUN_STATES set runsCommand's
  // default view uses, and for the same reason (its own comment in run-state.js).
  const runs = (await store.list(filters)).filter((run) => LIVE_RUN_STATES.has(run.state));

  const { agentsByPane, herdrAvailable } = await agentsByPaneFromHerdr(deps.herdr);

  const blocked = [];
  const waiting = [];
  const unresolved = [];
  for (const run of runs) {
    const pane = correlationPaneId(run);

    // C1 fix: test the run's own state first, independently of agent resolution. A run in one of
    // AWAITS_OPERATOR_STATES belongs in `waiting` unconditionally -- whether or not its agent
    // resolved, and whatever its agent status is -- because what makes it wait on a human is its
    // own persisted state, not any uncertainty about its agent. Checking this only inside the
    // branches below where resolution had already failed (the pre-fix shape) missed every such
    // run whose agent was still alive: the fresh, typical case right after a "manual" hook action,
    // not a corner case.
    if (AWAITS_OPERATOR_STATES.has(run.state)) {
      waiting.push({ ...inboxEntry(run, pane), reason: awaitsOperatorReason(run) });
      continue;
    }

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

    // C2 fix: classify the resolved agent's status through the shared vocabulary
    // (HERDR_AGENT_STATUSES/HERDR_BLOCKED_STATUS, agent-status.js) rather than a bare `===
    // "blocked"` literal. `unknown`, an absent status, and anything outside the vocabulary all
    // report as unresolved -- with a reason naming which one it was -- instead of silently
    // dropping the run the old bare comparison did. This also means a future rename of Herdr's own
    // "blocked" value stops matching nothing forever: it lands here, visibly, instead.
    const status = agentStatus(agent);
    if (!HERDR_AGENT_STATUSES.has(status) || status === "unknown") {
      unresolved.push({ ...inboxEntry(run, pane), reason: unresolvedAgentStatusReason(status, pane) });
      continue;
    }
    if (status === HERDR_BLOCKED_STATUS) {
      blocked.push(inboxEntry(run, pane));
    }
    // Any other recognized status (idle/working/done) means the agent is confirmed alive and not
    // waiting on the operator -- nothing to report for this run.
  }

  return {
    command: "inbox",
    blocked,
    waiting,
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

// The run's own append-only event log (run-store.js's appendEvent, EVENTS_FILE) is where
// verifyCommand's evidence lands, and there is no store method to read it back -- appendEvent is
// write-only by design, matching every other event producer in this file (telemetry-store.js, for
// example, keeps its own separate bounded journal rather than reading this file back). resultCommand
// is the one place that needs the evidence, so it reads the run's events.jsonl directly, the same
// way handoffCommand reads handoff-input.json directly (an injectable fs, defaulting to the real
// one). Read-only, and best-effort: any read or parse failure -- including the ordinary case of no
// verification event ever having been appended -- degrades to "no evidence" rather than breaking a
// command whose whole contract is "report what is known," the same fail-open discipline
// reconcileLockDiagnostic's own comment describes ("a diagnostic must never break reconcile").
// Only the LATEST verification event is surfaced -- `workflow result` shows one proof alongside one
// claim, not a history; an operator who reruns `workflow verify` gets a fresh entry that replaces
// the one shown here, never a merge of the two.
async function readLatestVerificationEvidence(run, fs) {
  let text;
  try {
    text = await fs.readFile(join(run.directory, "events.jsonl"), "utf8");
  } catch {
    return null;
  }
  let latest = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event && typeof event === "object" && event.type === "verification") latest = event;
  }
  if (!latest) return null;
  return {
    verifiedAt: latest.timestamp,
    passed: latest.passed,
    exitCode: latest.exitCode,
    results: list(latest.results),
  };
}

export async function resultCommand(options = {}, deps = {}) {
  const store = await storeForCommand(options, deps);
  const readCurrentResult = deps.readCurrentResult ?? defaultReadCurrentResult;
  const fs = deps.fs ?? defaultFs;
  const runId = assertRunId(options.runId);
  const run = await store.read(runId);
  const base = runOutputBase(run);
  // Reported by the worker (current.result.verification, once a result is registered below) and
  // verified by `workflow verify` (this) are two different sources about the same question, kept
  // and rendered separately -- see format.js's verificationClaimLines/verificationEvidenceLines.
  // Read regardless of whether a result has been registered yet: verification is independent of
  // the handoff, and an operator may well run `workflow verify` before the worker ever reports in.
  const verifiedEvidence = await readLatestVerificationEvidence(run, fs);

  if (!hasRegisteredResult(run)) {
    const status = resultStatusWithoutArtifact(run);
    return {
      command: "result",
      ...base,
      status,
      verifiedEvidence,
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
    verifiedEvidence,
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

// verifyCommand's own refusal shape: structured evidence that nothing ran, not a thrown error.
// The whole point of this command is that an operator asking "did this pass" always gets a
// legible answer back -- never a stack trace -- even when the answer is "could not check, because
// X". Refusing here, before the matrix ever starts, is also what makes "refusals append nothing"
// true for free: appendEvent is only ever reached after every refusal check below has passed.
function verifyRefusal(runId, reason) {
  return {
    command: "verify",
    runId,
    results: [],
    passed: false,
    exitCode: VERIFY_EXIT_CODES.refused,
    reason,
  };
}

// The matrix is every project.verify command x every run.repositories[] entry (design doc:
// "Once per repository, not once per run"). Repository-outer, command-inner so the evidence reads
// the way an operator thinks about it -- repository A's checks in order, then repository B's --
// rather than interleaved across repositories. Never stops early: a missing repository path, a
// timeout, a failure are all just another cell of the matrix, and the loop below has no branch
// that would skip or abort on any of them. Task 1's runVerifyCommand never throws for any of those
// cases, so nothing here needs to guard against one outcome breaking the rest of the sweep.
async function runVerifyMatrix(repositories, commands, { runVerify, timeoutMs, maxOutputBytes, spawnProcess, now }) {
  const results = [];
  for (const repository of repositories) {
    for (const command of commands) {
      const outcome = await runVerify(command, { cwd: repository.path, timeoutMs, maxOutputBytes, spawnProcess, now });
      results.push({
        repositoryId: repository.id,
        cwd: outcome.cwd,
        command: outcome.command,
        status: outcome.status,
        exitCode: outcome.exitCode,
        output: outcome.output,
        truncated: outcome.truncated,
        durationMs: outcome.durationMs,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      });
    }
  }
  return results;
}

// `workflow verify <run-id>` (roadmap item 2.3): re-runs the project's OWN verify commands, from
// the CURRENT registry, in the EXACT worktree paths the run recorded -- so "verification: passed"
// stops being the worker's self-report and becomes something an operator can check.
//
// The registry is read by run.projectAlias, not options.projectAlias, and deliberately reflects
// today's registry rather than anything snapshotted on the run (there is no verify-shaped field on
// a run record to snapshot). This is the mirror of item 1.3's security envelope: a resumed worker
// must run under what was approved, but evidence should reflect today's bar -- if the project has
// tightened its checks since the run launched, a stale standard would certify work as passing
// checks the project no longer considers sufficient.
//
// Never reports an unverified run as passing: a run with no repositories[], a project missing from
// the registry, and a project with no verify commands are each refused with their own reason
// (verifyRefusal above) and append nothing to the event log -- a run that was never verified must
// leave no evidence behind. Once the matrix actually runs, though, every outcome -- including a
// missing repository path or a timeout -- is recorded as evidence, not silently dropped, and a
// verification failure is reported cleanly (passed: false, a nonzero exitCode) rather than thrown.
export async function verifyCommand(options = {}, deps = {}) {
  const store = await storeForCommand(options, deps);
  const runId = assertRunId(options.runId);
  const run = await store.read(runId);

  const repositories = list(run.repositories);
  if (repositories.length === 0) {
    return verifyRefusal(runId, `Run ${runId} has no repositories[] recorded; nothing to verify.`);
  }

  const injectedLoadRegistry = deps.loadRegistry ?? loadRegistry;
  const registry = await injectedLoadRegistry(options.registryPath);
  const project = registry?.projects?.[run.projectAlias];
  if (!project) {
    return verifyRefusal(runId, `Unknown workflow project: ${run.projectAlias}`);
  }

  const commands = list(project.verify);
  if (commands.length === 0) {
    return verifyRefusal(runId, `Project ${run.projectAlias} has no verify commands configured.`);
  }

  const runVerify = deps.runVerifyCommand ?? defaultRunVerifyCommand;
  const results = await runVerifyMatrix(repositories, commands, {
    runVerify,
    timeoutMs: deps.timeoutMs,
    maxOutputBytes: deps.maxOutputBytes,
    spawnProcess: deps.spawnProcess,
    now: deps.now,
  });

  const passed = results.every((result) => result.status === "passed");
  const exitCode = passed ? VERIFY_EXIT_CODES.passed : VERIFY_EXIT_CODES.failed;

  // Evidence, appended only once the matrix has actually run -- every refusal above returns before
  // this point, so a run that was never verified never gets an entry here.
  //
  // I4 (branch review): appendEvent goes through store.withLock, and the matrix above has already
  // paid the real cost -- possibly minutes of `pnpm ci:verify` per repository -- by the time this
  // line runs. Before this fix, a lock held by any other in-flight command (another `workflow`
  // invocation against the same run) turned that into a thrown lock diagnostic and NOTHING else:
  // no table, no results, the whole matrix silently discarded after being fully paid for. The work
  // was already done; the operator should see it regardless of whether it could be persisted. So a
  // persistence failure here is recorded on the response instead of thrown -- `evidenceError`
  // names why nothing landed in the run's event log this time, and `workflow verify` can simply be
  // rerun once the lock clears to get both the results AND a persisted record.
  let evidenceError;
  try {
    await store.appendEvent(runId, { type: "verification", passed, exitCode, results });
  } catch (error) {
    evidenceError = `evidence could not be persisted: ${error?.message ?? String(error)}`;
  }

  return {
    command: "verify",
    runId,
    results,
    passed,
    exitCode,
    ...(evidenceError ? { evidenceError } : {}),
  };
}

// --- workflow merge (roadmap item 2.4) ---------------------------------------
//
// The arc's last ungoverned step, put under the same preview -> digest -> execute envelope as its
// first one. `--dry-run` computes, per repository the run recorded, the exact shell-free
// `git merge` argv and the conflicts that merge would produce -- without touching any working
// tree, index, or ref -- and prints an approval digest binding all of it. `--yes
// --approval-digest <digest>` recomputes the whole preview and merges only if nothing material
// moved in between.
//
// Two things shape everything below, both from the design doc:
//
//   1. The source branch is read from the WORKTREE, never trusted from `repositories[].branch`.
//      That field is a launch-time intention: two of the eight real runs on this machine record a
//      ref that no longer exists (run 0b2612a8 records `feature/1216110941098331/registro-impl`
//      while its worktree is on `feature/registro-impl`). A record-driven merge would fail on a
//      nonexistent ref at best and integrate a stale branch at worst. The disagreement is named
//      (`branchMismatch`) and digested -- never silently substituted, and never treated as a
//      blocking conflict, which would make the command unusable against every real completed
//      multi-repository run that exists today.
//   2. The merge runs in the BASE CHECKOUT, not the run worktree. The goal is to advance
//      `base_branch`, which is checked out there; merging into the worktree would advance the
//      feature branch instead. Git also forbids checking out a branch already checked out in
//      another worktree, so there is no third option.

const MERGE_PREVIEW_TIMEOUT_MS = 2 * 60 * 1000;
const MERGE_TIMEOUT_MS = 5 * 60 * 1000;
// The full conflict list is what the digest binds; these bound only what is PRINTED, so a
// pathological conflict does not blow the shared 12,000-character output budget a three-repository
// preview has to fit inside. Measured rather than estimated -- items 2.1 and 2.3 both shipped a
// collapse that only measurement caught. Measured on a synthetic worst case -- three repositories
// x 900 conflicted paths x 40 uncommitted paths, every path ~95 characters -- the pretty-printed
// JSON preview was 33,511 characters at (50, 50, 10) and is 11,641 at these values, inside the
// 12,000 budget. A realistic three-repository preview is 3,617 clean / 5,109 with two conflicts
// each. The reason strings get their own, much smaller cap because they otherwise restate a list
// that is already printed in full beside them.
const MERGE_CONFLICT_DISPLAY_LIMIT = 10;
const MERGE_REASON_PATH_LIMIT = 5;
const MERGE_DIRTY_DISPLAY_LIMIT = 5;
// Exported so the JSON size discipline in test/workflow-format.test.js can be measured against the
// caps that actually ship rather than against numbers copied out of this file. That test builds a
// worst-case preview and asserts the real three-repository project still fits without a fallback;
// with the limits hardcoded there, raising one HERE changed the shipped payload while every test
// kept passing -- which is precisely the silent degradation the test exists to catch, and it went
// unnoticed once already (task 3, fix round 1). Reading them from one place makes the coupling real.
export const MERGE_DISPLAY_LIMITS = Object.freeze({
  conflicts: MERGE_CONFLICT_DISPLAY_LIMIT,
  reasonPaths: MERGE_REASON_PATH_LIMIT,
  dirtyPaths: MERGE_DIRTY_DISPLAY_LIMIT,
});
const MERGE_FAILURE_TEXT_LIMIT = 2000;
const MERGE_DIGEST_VERSION = 1;

function mergeError(category, message, exitCode, details) {
  throw new WorkflowError(category, message, { exitCode, ...(details ? { details } : {}) });
}

function mergeErrorText(error) {
  return String(error?.message ?? error).slice(0, 256);
}

function mergeCommandFor(runId) {
  return `workflow merge ${runId} --dry-run`;
}

// The refusal shape, mirroring verifyRefusal: structured evidence that nothing ran, not a stack
// trace. A refused preview carries `approvalDigest: null`, so there is nothing an operator could
// pass back to execute -- and execute rebuilds this same preview and refuses again rather than
// trusting a digest from a previous, non-refused run.
//
// Every refusal reason names a concrete thing to go do, so `nextActions` is filled in here rather
// than left for the renderer to invent: run-record problems point at `reconcile`, registry
// problems at `doctor`, and every one of them ends with the dry-run to come back to once it is
// fixed. Callers pass the diagnostic; the re-preview is appended for all of them.
function mergeRefusal(runId, run, reason, diagnostics = []) {
  return {
    command: "merge",
    runId,
    projectAlias: run?.projectAlias ?? null,
    runState: run?.state ?? null,
    refused: true,
    reason,
    repositories: [],
    verification: null,
    conflicts: [],
    mergeable: false,
    approvalDigest: null,
    exitCode: MERGE_EXIT_CODES.refused,
    nextActions: [...diagnostics, mergeCommandFor(runId)],
  };
}

// The two diagnostics a refusal can point at. `doctorCommandFor` takes the alias because a
// registry problem is about the project, not about this run.
function doctorCommandFor(projectAlias) {
  return projectAlias ? `workflow doctor ${projectAlias}` : "workflow doctor";
}

function mergeGitAdapter(deps) {
  const git = deps.git;
  for (const method of ["resolveHead", "checkoutState", "resolveRef", "previewMerge", "mergeArgv", "mergeBranch"]) {
    if (typeof git?.[method] !== "function") {
      mergeError("PREFLIGHT", `workflow merge requires a git adapter with ${method}()`, 10);
    }
  }
  return git;
}

// The five shapes item 2.3's C1 finding enumerated -- field missing, `path: null`, `path: ""`, a
// bare string entry, an empty object -- all land here as `null`. run-store.js does not validate
// `repositories[]` at all, and both producers (`runLikeFromLaunchPreview`, `repositoriesForDigest`)
// round-trip a missing path through to a bare `null` without complaint.
function recordedRepositoryPath(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return typeof entry.path === "string" && entry.path.length > 0 ? entry.path : null;
}

function recordedRepositoryId(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null;
}

function recordedRepositoryBranch(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return typeof entry.branch === "string" && entry.branch ? entry.branch : null;
}

function repositoryLabel(repositoryId, index) {
  return repositoryId ? `"${repositoryId}"` : `at index ${index}`;
}

// Where `base_branch` actually lives, discriminated on `project.repository === "group"` rather
// than on the presence of a `repositories` map:
//
//   group    -> `project.repositories[<id>]` (a required `path` + `base_branch` per repository).
//               A group ALSO has a top-level `path`, and it is the group's META-repository
//               (`coordination.meta_repository`) -- so falling through to it for an id the
//               registry no longer knows would act on the wrong repository entirely, silently.
//               That is a refusal, never a fallback.
//   ordinary -> `project.path` + `project.base_branch`. Its single run entry gets `id: "primary"`
//               (launch.js's runRepositories), which is deliberately NOT a registry key, so an
//               id lookup would fail here for the ordinary case and must not be attempted.
//
// `consequence` is what falling through would have DONE, and it is a required argument rather than
// a defaulted one: this discrimination is now shared by `merge` (which would merge into the meta
// repository) and `archive` (which would measure this run's unmerged work against it), and each
// has to name its own harm. Defaulting it would let a third caller inherit merge's wording
// silently -- the same drift the single implementation exists to prevent.
function baseCheckoutFor(project, projectAlias, repositoryId, label, consequence) {
  if (project.repository === "group") {
    const entry = project.repositories?.[repositoryId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        error: `Group project ${projectAlias} has no repository ${label} in the current registry; refusing rather than ${consequence}.`,
      };
    }
    return { path: entry.path, baseBranch: entry.base_branch };
  }
  return { path: project.path, baseBranch: project.base_branch };
}

async function safeCommitTimestamp(git, cwd, ref, timeoutMs) {
  if (typeof git.commitTimestamp !== "function") return null;
  try {
    const value = await git.commitTimestamp({ cwd, ref, timeoutMs });
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function mergeConflict(repositoryId, resource, reason) {
  return { repositoryId, resource, reason };
}

function joinPaths(paths, limit) {
  const shown = paths.slice(0, limit);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

// Reads one repository into either a refusal (which aborts the whole preview) or a record. The
// split is the design doc's: a refusal means the preview could not be COMPUTED honestly, while a
// conflict means it was computed and says the merge must not run. Conflicts therefore stay on the
// record and are reported for every repository -- `merge-tree` mutates nothing, so a complete
// prediction is free, and an operator seeing only the first of three problems would fix one and
// come straight back.
async function inspectRepositoryForMerge({ runId, projectAlias, project, entry, index, git, timeoutMs }) {
  const repositoryId = recordedRepositoryId(entry);
  const label = repositoryLabel(repositoryId, index);
  const worktreePath = recordedRepositoryPath(entry);

  if (!worktreePath) {
    return { refusal: `Run ${runId} repository ${label} has no worktree path recorded; refusing rather than merging from an unknown directory.`, actions: [reconcileCommandFor(runId)] };
  }
  if (!isAbsolute(worktreePath)) {
    // Same false-green class item 2.3's R2 finding removed for verify: a relative path resolves
    // against THIS process's own cwd (the control plane's own checkout), not against any run
    // worktree -- and here that would mean reading a source branch out of the control plane itself.
    return { refusal: `Run ${runId} repository ${label} records a relative worktree path (${worktreePath}); refusing rather than resolving it against the control plane's own directory.`, actions: [reconcileCommandFor(runId)] };
  }

  const base = baseCheckoutFor(project, projectAlias, repositoryId, label, "merging into the group's meta-repository");
  if (base.error) return { refusal: base.error, actions: [doctorCommandFor(projectAlias)] };
  if (typeof base.path !== "string" || !base.path || !isAbsolute(base.path)) {
    return { refusal: `Project ${projectAlias} has no absolute base checkout path for repository ${label}; there is nothing to merge into.`, actions: [doctorCommandFor(projectAlias)] };
  }
  if (typeof base.baseBranch !== "string" || !base.baseBranch.trim()) {
    return { refusal: `Project ${projectAlias} has no base_branch configured for repository ${label}; there is nothing to merge into.`, actions: [doctorCommandFor(projectAlias)] };
  }
  const basePath = base.path;
  const baseBranch = base.baseBranch.trim();

  // Task 1's resolveHead/checkoutState THROW when rev-parse itself fails -- a worktree that was
  // removed, a path that is not a repository. That is the spec's own named refusal, so it is
  // wrapped here rather than allowed to surface as an uncaught WorkflowError.
  let head;
  try {
    head = await git.resolveHead({ cwd: worktreePath });
  } catch (error) {
    return { refusal: `Run ${runId} repository ${label} worktree HEAD could not be resolved at ${worktreePath}: ${mergeErrorText(error)}`, actions: [reconcileCommandFor(runId)] };
  }
  if (!head?.branch) {
    return { refusal: `Run ${runId} repository ${label} worktree at ${worktreePath} is on a detached HEAD; there is no source branch to merge.`, actions: [reconcileCommandFor(runId)] };
  }
  if (typeof head.sha !== "string" || !head.sha) {
    return { refusal: `Run ${runId} repository ${label} worktree at ${worktreePath} reported no HEAD commit; there is nothing to merge.`, actions: [reconcileCommandFor(runId)] };
  }

  let baseState;
  let baseHead;
  try {
    baseState = await git.checkoutState({ cwd: basePath });
    baseHead = await git.resolveHead({ cwd: basePath });
  } catch (error) {
    return { refusal: `Project ${projectAlias} base checkout for repository ${label} could not be read at ${basePath}: ${mergeErrorText(error)}`, actions: [doctorCommandFor(projectAlias)] };
  }

  // The preview predicts conflicts against the SHA, and the digest binds the SHA -- but the merge
  // that runs is `git merge --no-ff --no-edit <branch-name>`, which git resolves in the BASE
  // CHECKOUT's own ref namespace. Proving the object is merely present there is not enough: in a
  // separate-clone topology (the very case this refusal exists for), the base checkout can hold
  // the object from an earlier fetch while its own `feature/x` still points at an older commit --
  // and then the preview says "clean, merging X" while git merges Y and the report records X.
  // So the branch is resolved HERE, the same way merge will resolve it, and anything other than
  // an exact match with the worktree's sha is a refusal.
  let baseSourceSha;
  try {
    baseSourceSha = await git.resolveRef({ cwd: basePath, ref: head.branch, timeoutMs });
  } catch (error) {
    return { refusal: `Run ${runId} repository ${label} source branch ${head.branch} could not be resolved in the base checkout at ${basePath}: ${mergeErrorText(error)}` };
  }
  if (!baseSourceSha) {
    return { refusal: `Run ${runId} repository ${label} source branch ${head.branch} does not resolve to a commit in the base checkout at ${basePath}; refusing rather than merging a ref that checkout does not have.` };
  }
  if (baseSourceSha !== head.sha) {
    return { refusal: `Run ${runId} repository ${label} source branch ${head.branch} resolves to ${baseSourceSha} in the base checkout at ${basePath}, but the worktree at ${worktreePath} is at ${head.sha}; refusing rather than previewing one commit and merging another.` };
  }

  // M5: the base side is the RESOLVED SHA, never the branch NAME. The source side always was a
  // sha, and the asymmetry was a real preview-versus-execute divergence: with `refs/tags/dev`
  // alongside `refs/heads/dev`, `git merge-tree dev <src>` resolves the TAG and can report a clean
  // merge while the real `git merge` into `refs/heads/dev` conflicts -- a stable digest over a
  // prediction of a different merge. Both sides are now object ids, so merge-tree cannot resolve
  // anything other than what execution will.
  const baseSha = typeof baseHead?.sha === "string" && baseHead.sha ? baseHead.sha : null;
  if (!baseSha) {
    return { refusal: `Project ${projectAlias} base checkout for repository ${label} at ${basePath} reported no HEAD commit; there is nothing to merge into.`, actions: [doctorCommandFor(projectAlias)] };
  }

  // M8: the only adapter call in this function that was not defensively wrapped. `previewMerge` is
  // documented never to throw and does not -- but `runMergeSequence` wraps `mergeBranch` for
  // exactly this reason, and a contract must not be depended on where breaking it turns a
  // read-only `--dry-run` into a stack trace instead of a refusal.
  let preview;
  try {
    preview = await git.previewMerge({ cwd: basePath, base: baseSha, source: head.sha, timeoutMs });
  } catch (error) {
    preview = { status: "unknown", conflicts: [], reason: `git merge-tree could not run: ${mergeErrorText(error)}` };
  }
  const sourceCommittedAt = await safeCommitTimestamp(git, worktreePath, head.sha, timeoutMs);

  const recordedBranch = recordedRepositoryBranch(entry);
  const dirtyPaths = list(baseState.entries).map((statusEntry) => statusEntry?.path).filter((path) => typeof path === "string");
  const conflictPaths = list(preview.conflicts).map(String);
  const conflicts = [];

  // Checked BEFORE `dirty`, and independently of it, because "mid-merge" is the more specific and
  // more actionable fact and it must block even in the exotic case where a stopped merge staged
  // nothing. See git.js's checkoutState for where this came from: naming only the uncommitted
  // paths points an operator at `git add`/`git stash`, which is the wrong move for a checkout that
  // is actually sitting inside a failed merge.
  const uncommitted = dirtyPaths.length > 0
    ? ` with ${dirtyPaths.length} uncommitted path(s): ${joinPaths(dirtyPaths, MERGE_REASON_PATH_LIMIT)}`
    : "";
  if (baseState.merging === true) {
    conflicts.push(mergeConflict(
      repositoryId,
      `base:${basePath}`,
      `Base checkout ${basePath} is in the middle of a merge (MERGE_HEAD is present)${uncommitted}; most likely a previous merge that failed at commit time. Resolve it with \`git -C ${basePath} merge --abort\` (or finish it by hand) — staging or stashing those paths is not the fix.`,
    ));
  } else if (baseState.merging !== false) {
    // `merging` is tri-state and only an explicit `false` may pass. git.js's checkoutState
    // documents an unanswerable MERGE_HEAD probe as "cannot say" rather than "not merging", and
    // item 0.14's rule -- an unreadable state is a conflict, never clean -- is the same rule
    // already applied to `dirty` immediately below. Treating `null` as `false` here made the code
    // fail OPEN against its own doc comment: a checkout that might be sitting inside a stopped
    // merge would have been merged into. The residual case is narrow (a `--no-commit` merge that
    // staged nothing, plus a probe that failed while `git status` still worked) but the direction
    // is the binding constraint, not the size of the window.
    conflicts.push(mergeConflict(
      repositoryId,
      `base:${basePath}`,
      `Base checkout ${basePath} could not be checked for an in-progress merge (MERGE_HEAD is unreadable)${uncommitted}; an unknown merge state is a conflict, never clean. Confirm with \`git -C ${basePath} status\` before approving anything.`,
    ));
  } else if (baseState.dirty === true) {
    conflicts.push(mergeConflict(repositoryId, `base:${basePath}`, `Base checkout ${basePath} has ${dirtyPaths.length} uncommitted path(s): ${joinPaths(dirtyPaths, MERGE_REASON_PATH_LIMIT)}`));
  } else if (baseState.dirty !== false) {
    // Item 0.14's direction applied to a heavier operation: an unreadable status is a conflict,
    // never clean. `!== false` rather than `=== null` for the same reason the `merging` branch
    // above uses it: an adapter that omits `dirty` entirely produced `mergeable: true` with a
    // usable digest while the renderer printed `STATUS UNKNOWN` beside it -- the view and the
    // verdict disagreeing, which is the shape of every false green this roadmap has removed.
    // Ordered after the `=== true` branch so a genuinely dirty checkout still names its paths.
    conflicts.push(mergeConflict(repositoryId, `base:${basePath}`, `Base checkout ${basePath} status could not be read (${baseState.statusError ?? "reason unknown"}); an unreadable status is a conflict, never clean.`));
  }
  if (baseState.branch !== baseBranch) {
    conflicts.push(mergeConflict(repositoryId, `base:${basePath}`, `Base checkout ${basePath} is on ${baseState.branch ?? "a detached HEAD"}, not ${baseBranch}; git merge would advance the wrong branch.`));
  }
  if (preview.status === "conflicted") {
    const suffix = preview.truncated ? ` -- ${preview.reason}` : "";
    conflicts.push(mergeConflict(repositoryId, `merge:${basePath}`, `Merging ${head.branch} into ${baseBranch} conflicts in ${conflictPaths.length} file(s): ${joinPaths(conflictPaths, MERGE_REASON_PATH_LIMIT)}${suffix}`));
  }
  if (preview.status !== "conflicted" && preview.status !== "clean") {
    conflicts.push(mergeConflict(repositoryId, `merge:${basePath}`, `Conflicts could not be predicted for ${head.branch} into ${baseBranch}: ${preview.reason ?? "git merge-tree gave no answer"}`));
  }

  return {
    record: {
      repositoryId,
      worktreePath,
      recordedBranch,
      sourceBranch: head.branch,
      sourceSha: head.sha,
      sourceCommittedAt,
      // Literally `recordedBranch !== sourceBranch`, per the design: a run that recorded no branch
      // at all also disagrees with the worktree, and that is worth naming rather than hiding.
      branchMismatch: recordedBranch !== head.branch,
      basePath,
      baseBranch,
      baseCheckedOutBranch: baseState.branch ?? null,
      baseBranchCheckedOut: baseState.branch === baseBranch,
      baseDirty: baseState.dirty ?? null,
      baseMerging: baseState.merging ?? null,
      dirtyPaths,
      baseSha: typeof baseHead?.sha === "string" ? baseHead.sha : null,
      // From the adapter, never rebuilt here: the string an operator approves has to be the string
      // that runs, and `mergeBranch` destructures its child-process argv from this same expression.
      argv: git.mergeArgv({ source: head.branch }),
      conflictStatus: preview.status,
      conflictPaths,
      conflictsTruncated: Boolean(preview.truncated),
      conflictReason: preview.reason,
      conflicts,
    },
  };
}

// True when any source commit is newer than the evidence; false when every one of them is older;
// null when it cannot be known -- no evidence, an unparseable `verifiedAt`, or a commit date that
// could not be read. Fail closed: a single unknown commit date makes the whole answer unknown
// rather than letting the known-older ones report "not stale".
function staleRelativeToSource(verifiedAt, records) {
  const verifiedAtMs = Date.parse(verifiedAt ?? "");
  if (!Number.isFinite(verifiedAtMs)) return null;

  let sawUnknown = false;
  for (const record of records) {
    const committedAtMs = Date.parse(record.sourceCommittedAt ?? "");
    if (!Number.isFinite(committedAtMs)) {
      sawUnknown = true;
      continue;
    }
    if (committedAtMs > verifiedAtMs) return true;
  }
  return sawUnknown ? null : false;
}

// `workflow verify`'s evidence, surfaced and digested but never gated (design doc, open decision
// 2). Approving a merge therefore means approving the merge of THESE commits WITH THIS
// verification status: rerun verify, or push another commit, and the digest changes and the
// previous approval is refused as stale. The honest limit, stated in the spec and true here: an
// operator who never ran `workflow verify` gets `status: "none"` and can approve that.
function verificationForMerge(evidence, records) {
  if (!evidence) {
    return { status: "none", verifiedAt: null, passed: null, exitCode: null, staleRelativeToSource: null };
  }
  return {
    status: "recorded",
    verifiedAt: evidence.verifiedAt ?? null,
    passed: typeof evidence.passed === "boolean" ? evidence.passed : null,
    exitCode: Number.isInteger(evidence.exitCode) ? evidence.exitCode : null,
    staleRelativeToSource: staleRelativeToSource(evidence.verifiedAt, records),
  };
}

// The digest binds the resolved COMMIT SHAS -- source and base -- not just branch names, plus the
// checkout state that decides whether the merge may run at all, plus the verification status.
// Anything that moves between preview and execution changes it. The FULL conflict list goes in
// here (the public preview caps its own for printing) together with `conflictsTruncated`:
// approving "these 298 conflicts" when there are 900 is the wrong approval.
function mergeDigestPayload({ runId, run, records, verification }) {
  return {
    version: MERGE_DIGEST_VERSION,
    command: "merge",
    runId,
    projectAlias: run?.projectAlias ?? null,
    runState: run?.state ?? null,
    verification,
    repositories: records.map((record) => ({
      repositoryId: record.repositoryId,
      worktreePath: record.worktreePath,
      recordedBranch: record.recordedBranch,
      sourceBranch: record.sourceBranch,
      sourceSha: record.sourceSha,
      sourceCommittedAt: record.sourceCommittedAt,
      branchMismatch: record.branchMismatch,
      basePath: record.basePath,
      baseBranch: record.baseBranch,
      baseCheckedOutBranch: record.baseCheckedOutBranch,
      baseBranchCheckedOut: record.baseBranchCheckedOut,
      baseDirty: record.baseDirty,
      // Bound because it now blocks execution on its own (see inspectRepositoryForMerge): a
      // checkout that stops being mid-merge between preview and approval is a materially
      // different world, and the digest has to notice.
      baseMerging: record.baseMerging,
      baseSha: record.baseSha,
      argv: record.argv,
      conflictStatus: record.conflictStatus,
      conflicts: record.conflictPaths,
      conflictsTruncated: record.conflictsTruncated,
    })),
  };
}

function publicMergeRepository(record) {
  const conflicts = record.conflictPaths.slice(0, MERGE_CONFLICT_DISPLAY_LIMIT);
  const baseDirtyPaths = record.dirtyPaths.slice(0, MERGE_DIRTY_DISPLAY_LIMIT);
  return {
    repositoryId: record.repositoryId,
    worktreePath: record.worktreePath,
    recordedBranch: record.recordedBranch,
    sourceBranch: record.sourceBranch,
    sourceSha: record.sourceSha,
    sourceCommittedAt: record.sourceCommittedAt,
    branchMismatch: record.branchMismatch,
    basePath: record.basePath,
    baseBranch: record.baseBranch,
    baseCheckedOutBranch: record.baseCheckedOutBranch,
    baseBranchCheckedOut: record.baseBranchCheckedOut,
    baseDirty: record.baseDirty,
    baseMerging: record.baseMerging,
    baseDirtyPaths,
    baseDirtyCount: record.dirtyPaths.length,
    baseSha: record.baseSha,
    argv: [...record.argv],
    conflictStatus: record.conflictStatus,
    conflicts,
    conflictCount: record.conflictPaths.length,
    // True for either reason the list can be short: git's own capture limit, or this projection's
    // display cap. Both mean "what you are reading is a prefix of the truth".
    conflictsTruncated: record.conflictsTruncated || conflicts.length < record.conflictPaths.length,
    ...(record.conflictReason ? { conflictReason: record.conflictReason } : {}),
  };
}

async function buildMergePreview(runId, run, options, deps) {
  const repositories = list(run.repositories);
  if (repositories.length === 0) {
    return { preview: mergeRefusal(runId, run, `Run ${runId} has no repositories[] recorded; nothing to merge.`, [reconcileCommandFor(runId)]), records: [] };
  }

  const injectedLoadRegistry = deps.loadRegistry ?? loadRegistry;
  const registry = await injectedLoadRegistry(options.registryPath);
  const project = registry?.projects?.[run.projectAlias];
  if (!project) {
    return { preview: mergeRefusal(runId, run, `Unknown workflow project: ${run.projectAlias}`, [doctorCommandFor(run.projectAlias)]), records: [] };
  }

  const git = mergeGitAdapter(deps);
  const fs = deps.fs ?? defaultFs;
  const timeoutMs = Number.isFinite(deps.previewTimeoutMs) ? deps.previewTimeoutMs : MERGE_PREVIEW_TIMEOUT_MS;

  const records = [];
  for (const [index, entry] of repositories.entries()) {
    const outcome = await inspectRepositoryForMerge({
      runId,
      projectAlias: run.projectAlias,
      project,
      entry,
      index,
      git,
      timeoutMs,
    });
    if (outcome.refusal) return { preview: mergeRefusal(runId, run, outcome.refusal, list(outcome.actions)), records: [] };
    records.push(outcome.record);
  }

  const verification = verificationForMerge(await readLatestVerificationEvidence(run, fs), records);
  const conflicts = records.flatMap((record) => record.conflicts);
  const mergeable = conflicts.length === 0;

  const preview = {
    command: "merge",
    runId,
    projectAlias: run.projectAlias ?? null,
    runState: run.state ?? null,
    refused: false,
    repositories: records.map(publicMergeRepository),
    verification,
    conflicts,
    mergeable,
    approvalDigest: sha256Digest(canonicalText(mergeDigestPayload({ runId, run, records, verification }))),
    exitCode: mergeable ? MERGE_EXIT_CODES.merged : MERGE_EXIT_CODES.conflicted,
    nextActions: [],
  };
  // A blocked preview whose only next action is the dry-run that just printed it is a loop with no
  // exit, and that is exactly what a checkout stuck mid-merge used to get (task 3, step 5). The
  // abort is named first, per repository actually in that state, so the loop has a way out.
  const abortActions = [...new Set(
    records.filter((record) => record.baseMerging === true).map((record) => `git -C ${record.basePath} merge --abort`),
  )];
  preview.nextActions = mergeable
    ? [`workflow merge ${runId} --yes --approval-digest ${preview.approvalDigest}`]
    : [...abortActions, mergeCommandFor(runId)];
  return { preview, records };
}

async function mergeContext(options, deps) {
  const store = await storeForCommand(options, deps);
  const runId = assertRunId(options.runId);
  const run = await store.read(runId);
  const { preview, records } = await buildMergePreview(runId, run, options, deps);
  return { store, runId, run, preview, records };
}

function assertSuppliedMergeDigest(supplied) {
  if (typeof supplied !== "string" || !supplied) {
    mergeError("PREFLIGHT", "Missing approval digest; rerun workflow merge --dry-run and approve the current digest", MERGE_EXIT_CODES.refused);
  }
  if (!APPROVAL_DIGEST_PATTERN.test(supplied)) {
    mergeError("PREFLIGHT", "Invalid approval digest; rerun workflow merge --dry-run and approve the current digest", MERGE_EXIT_CODES.refused);
  }
}

function mergeFailureText(result) {
  // Task 1's interface note: on a timeout, a signal, or a failed spawn there is no stderr and the
  // message lives on `error`. Reading only stderr would report a nameless failure.
  const text = result.error ?? result.stderr ?? "";
  return String(text).trim().slice(0, MERGE_FAILURE_TEXT_LIMIT) || `git merge exited with code ${result.code}`;
}

function mergeReportEntry(record, extra = {}) {
  return {
    repositoryId: record.repositoryId,
    basePath: record.basePath,
    baseBranch: record.baseBranch,
    sourceBranch: record.sourceBranch,
    sourceSha: record.sourceSha,
    ...extra,
  };
}

// Sequential, stopping at the first failure. There is no cross-repository transaction for a group
// project -- it is several independent git repositories -- so the report is written to admit
// partial completion rather than to avoid admitting it: what merged, what failed with git's own
// output, and what was never attempted, each in its own list.
async function runMergeSequence(records, git, timeoutMs) {
  const merged = [];
  const failed = [];
  const skipped = [];

  for (const record of records) {
    if (failed.length > 0) {
      skipped.push(mergeReportEntry(record, {
        argv: [...record.argv],
        reason: "never attempted: an earlier repository's merge failed",
      }));
      continue;
    }

    // git.js's mergeBranch is documented never to throw, and does not. This guard exists anyway
    // because "never discard a report of merges that already happened" must not depend on another
    // module keeping its contract: one thrown error from repository 2 would otherwise unwind past
    // repository 1's real, already-committed merge and leave the operator with a stack trace
    // instead of the only record that it happened. These merges are not undoable by rerunning.
    let result;
    try {
      result = await git.mergeBranch({ cwd: record.basePath, source: record.sourceBranch, timeoutMs });
    } catch (error) {
      result = { ok: false, code: 1, stdout: "", stderr: "", argv: record.argv, error: String(error?.message ?? error) };
    }
    // The EXECUTED argv is reported, not the approved one. They are the same expression by
    // construction (git.js builds both from mergeArgvFor), and reporting the approved one would be
    // the false green if they ever were not.
    const entry = mergeReportEntry(record, {
      argv: [...(result.argv ?? record.argv)],
      code: result.code,
    });
    if (!result.ok) {
      failed.push({ ...entry, reason: mergeFailureText(result) });
      continue;
    }

    // M4: exit 0 does NOT prove an integration happened. `git merge --no-ff --no-edit <src>`
    // against an already-integrated branch prints "Already up to date.", exits 0, and creates NO
    // commit -- and this used to be recorded as `merged`, with a `merge` event appended, claiming
    // an integration that never occurred. The design's own `--no-ff, always` reasoning is that the
    // merge commit IS the audit trail, so an audit record that asserts one where none exists is
    // the thing that reasoning exists to prevent.
    //
    // Whether the base branch actually moved is read back rather than parsed out of git's
    // human-readable stdout, which is localizable. `null` means the read failed, which is reported
    // as "unconfirmed" and never as either outcome.
    let baseShaAfter = null;
    try {
      const head = await git.resolveHead({ cwd: record.basePath });
      baseShaAfter = typeof head?.sha === "string" && head.sha ? head.sha : null;
    } catch {
      baseShaAfter = null;
    }
    const integrated = baseShaAfter === null || typeof record.baseSha !== "string" || !record.baseSha
      ? null
      : baseShaAfter !== record.baseSha;
    merged.push({ ...entry, integrated, baseShaAfter });
  }

  return { merged, failed, skipped };
}

async function executeMerge(options, deps, supplied) {
  assertSuppliedMergeDigest(supplied);

  // recomputeApprovedPreview's shape: the preview is rebuilt from scratch and the supplied digest
  // is compared against the FRESH one, so anything that moved between preview and approval --
  // a new commit, a base branch that advanced, a checkout that went dirty, a rerun verify --
  // refuses instead of merging something the operator never saw.
  const fresh = await mergeContext(options, deps);
  if (fresh.preview.refused) {
    mergeError("PREFLIGHT", `workflow merge refused: ${fresh.preview.reason}`, MERGE_EXIT_CODES.refused);
  }
  if (supplied !== fresh.preview.approvalDigest) {
    mergeError(
      "PREFLIGHT",
      `Stale approval digest; rerun ${mergeCommandFor(fresh.runId)} before executing. Current digest: ${fresh.preview.approvalDigest}`,
      MERGE_EXIT_CODES.refused,
      { expected: fresh.preview.approvalDigest, supplied },
    );
  }
  if (fresh.preview.conflicts.length > 0) {
    const first = fresh.preview.conflicts[0];
    mergeError("CONFLICT", `${first.resource}: ${first.reason}`, MERGE_EXIT_CODES.conflicted, { conflicts: fresh.preview.conflicts });
  }

  const git = mergeGitAdapter(deps);
  const timeoutMs = Number.isFinite(deps.mergeTimeoutMs) ? deps.mergeTimeoutMs : MERGE_TIMEOUT_MS;
  const { merged, failed, skipped } = await runMergeSequence(fresh.records, git, timeoutMs);

  const passed = failed.length === 0;
  // A run in which every repository was already up to date advanced no branch and produced no
  // merge commit. It is not a failure -- the desired state holds -- but calling it `merged` puts
  // an integration in the event log that did not happen, so it gets its own status. A MIX still
  // reports `merged`, and the per-repository `integrated` flag carries which was which.
  const nothingIntegrated = merged.length > 0 && merged.every((entry) => entry.integrated === false);
  const status = passed
    ? (nothingIntegrated ? "already-up-to-date" : "merged")
    : merged.length > 0 ? "partial" : "failed";
  const exitCode = passed
    ? MERGE_EXIT_CODES.merged
    : status === "partial" ? MERGE_EXIT_CODES.partial : MERGE_EXIT_CODES.failed;

  // Item 2.3's I4 finding, and it matters more here than it did there: by this line real merge
  // commits exist in real repositories, and rerunning the command cannot undo them. A persistence
  // failure (a run lock held by another in-flight command, most likely) must therefore degrade to
  // a field on the response rather than throw away the only report of what actually happened.
  let evidenceError;
  try {
    await fresh.store.appendEvent(fresh.runId, {
      type: "merge",
      approvalDigest: supplied,
      status,
      passed,
      exitCode,
      merged,
      failed,
      skipped,
    });
  } catch (error) {
    evidenceError = `evidence could not be persisted: ${error?.message ?? String(error)}`;
  }

  return {
    command: "merge",
    runId: fresh.runId,
    projectAlias: fresh.run.projectAlias ?? null,
    approvalDigest: supplied,
    status,
    merged,
    failed,
    skipped,
    passed,
    exitCode,
    ...(evidenceError ? { evidenceError } : {}),
    nextActions: passed ? [] : [mergeCommandFor(fresh.runId)],
  };
}

export async function mergeCommand(options = {}, deps = {}) {
  const { preview } = await mergeContext(options, deps);
  return {
    preview,
    async execute(executeOptions = {}) {
      return await executeMerge(options, deps, executeOptions.approvalDigest);
    },
  };
}

// --- workflow archive (roadmap item 2.5) -------------------------------------
//
// The second exception to this repo's no-cleanup policy, and the only one that can destroy
// something irreplaceable if it is wrong. It removes each `run.repositories[]` worktree and the
// run's Herdr tab; it preserves the run directory, the branch and every commit.
//
// Four things shape everything below, all from the design doc, all measured:
//
//   1. **It never forces.** git's refusal to delete a worktree holding modified or untracked files
//      is the last line of defence, and this command's job is to refuse BEFORE reaching it -- in
//      the preview, for the whole run, naming the files. `git.removeWorktree` has no `force`
//      parameter to pass; nothing here may reintroduce one.
//   2. **The worktree is the durable residue; the tab is usually already gone.** Every recorded
//      tabId on this machine is stale. Tab closure is best-effort, runs AFTER the removals, and
//      `not-found` means already-archived rather than failed.
//   3. **Uncommitted changes refuse; unmerged commits only warn.** The line is recoverability:
//      uncommitted work has no other copy, unmerged commits are still on a branch. Making unmerged
//      commits a hard gate would need a `--force` the first time an operator legitimately archives
//      an abandoned experiment -- an escape hatch on the destructive step is a governance hole
//      with a flag on it.
//   4. **Unknown fails closed, everywhere.** An unreadable `git status`, an unreadable lock, an
//      `unprovable` owner verdict, a Herdr that cannot answer: each refuses. Item 0.14's rule, on
//      the most destructive command in the CLI.

// archiveCommand's own exit codes, mirroring MERGE_EXIT_CODES. There is no `conflicted` value:
// archive has no "computed, and it says do not run" class -- every blocking condition is a
// refusal. `partial` reuses 13 for the same meaning launch and merge give it: some of the work
// happened and some did not. A partial archive is never reported as `archived` and its exit code
// is never 0.
export const ARCHIVE_EXIT_CODES = Object.freeze({
  archived: 0,
  failed: 1,
  refused: 10,
  partial: 13,
});

const ARCHIVE_PREVIEW_TIMEOUT_MS = 2 * 60 * 1000;
const ARCHIVE_REMOVE_TIMEOUT_MS = 5 * 60 * 1000;
// These bound what is PRINTED, never what is digested (see archiveDigestPayload versus
// publicArchiveRepository below). Exported for the same reason MERGE_DISPLAY_LIMITS is: the JSON
// size discipline in the formatter's tests must measure the caps that actually ship rather than
// numbers copied out of this file, or raising one here silently changes the shipped payload while
// every test keeps passing.
// There is deliberately no dirty-PATH-array cap here, because there is no dirty path array to cap:
// a repository with `dirty: true` always refuses (irrecoverableRefusal), and a refusal carries
// `repositories: []`. An earlier round shipped a `dirtyPaths` field and an
// ARCHIVE_DIRTY_DISPLAY_LIMIT that were unreachable on every path, plus a test that claimed to
// exercise them and did not. The caps that actually ship are these two, both inside the refusal
// reason, and both are asserted against ARCHIVE_DISPLAY_LIMITS by test rather than against literals.
const ARCHIVE_REASON_PATH_LIMIT = 5;
const ARCHIVE_REASON_REPOSITORY_LIMIT = 5;
// The ignored-content cap, added by the whole-branch review's C1. Unlike the `dirtyPaths` cap an
// earlier round deleted, this one is REACHABLE on every non-refused preview: ignored entries do not
// refuse (see ignoredContentFor), so they are printed on exactly the path that goes on to remove
// them. 10 rather than 5 because this list is the only warning an operator gets before a file that
// exists nowhere else is deleted, and `--ignored=matching` already collapses `node_modules/` to a
// single entry, so 10 covers a realistic project's whole ignore surface.
const ARCHIVE_IGNORED_PATH_LIMIT = 10;
export const ARCHIVE_DISPLAY_LIMITS = Object.freeze({
  reasonPaths: ARCHIVE_REASON_PATH_LIMIT,
  reasonRepositories: ARCHIVE_REASON_REPOSITORY_LIMIT,
  ignoredPaths: ARCHIVE_IGNORED_PATH_LIMIT,
});
const ARCHIVE_FAILURE_TEXT_LIMIT = 2000;
const ARCHIVE_DIGEST_VERSION = 1;

function archiveError(category, message, exitCode, details) {
  throw new WorkflowError(category, message, { exitCode, ...(details ? { details } : {}) });
}

function archiveErrorText(error) {
  return String(error?.message ?? error).slice(0, 256);
}

function archiveCommandFor(runId) {
  return `workflow archive ${runId} --dry-run`;
}

function unlockCommandFor(runId) {
  return `workflow unlock ${runId} --yes`;
}

// Mirrors mergeRefusal: structured evidence that nothing ran, not a stack trace. A refused preview
// carries `approvalDigest: null`, so there is nothing an operator could pass back to execute -- and
// execute rebuilds this same preview and refuses again rather than trusting a digest from an
// earlier, non-refused run. Every refusal ends with the dry-run to come back to once the named
// problem is fixed.
//
// `evidence` is whatever the refusing gate had already established -- most usefully the lock's own
// ownership verdict, which is the thing an operator has to look at to decide whether `workflow
// unlock` is even applicable. Defaults to nulls so every refusal has the SAME key set regardless of
// how far the preview got: a renderer must never have to test for a field's presence to know which
// refusal it is holding.
function archiveRefusal(runId, run, reason, diagnostics = [], evidence = {}) {
  return {
    command: "archive",
    runId,
    projectAlias: run?.projectAlias ?? null,
    runState: run?.state ?? null,
    refused: true,
    reason,
    tabId: run?.tabId ?? null,
    agent: evidence.agent ?? null,
    lock: evidence.lock ?? null,
    repositories: [],
    losses: [],
    removable: false,
    approvalDigest: null,
    exitCode: ARCHIVE_EXIT_CODES.refused,
    nextActions: [...diagnostics, archiveCommandFor(runId)],
  };
}

// `isCommitReachable` and `pendingOperation` are as required as the rest: each closes half of a
// measured path from "clean archive" to "destroyed commit" (see inspectRepositoryForArchive). An
// adapter missing either cannot answer the questions this command must answer before removing
// anything, so it is a preflight refusal rather than a silently skipped check.
function archiveGitAdapter(deps) {
  const git = deps.git;
  for (const method of ["checkoutState", "resolveHead", "pendingOperation", "isCommitReachable", "ignoredEntries", "countCommitsNotIn", "removeWorktree"]) {
    if (typeof git?.[method] !== "function") {
      archiveError("PREFLIGHT", `workflow archive requires a git adapter with ${method}()`, ARCHIVE_EXIT_CODES.refused);
    }
  }
  return git;
}

// --- gate 1: the run state ---------------------------------------------------
//
// Item 2.1 established that NO run state is terminal in the state machine -- completed, failed and
// interrupted all transition back to running via resume. So "only terminal runs" cannot be read off
// `run-state.js`'s ALLOWED. Rather than invent a second classification, this archives exactly the
// complement of LIVE_RUN_STATES, the set 2.1 already defined and documented as a presentation
// decision requiring a new state to be classified deliberately.
function liveStateRefusal(runId, run) {
  if (!LIVE_RUN_STATES.has(run.state)) return null;
  return archiveRefusal(
    runId,
    run,
    `Run ${runId} is in ${run.state}, which is still live; only a completed, failed or interrupted run can be archived.`,
    [resultCommandFor(runId)],
  );
}

// --- gate 2: the run lock ----------------------------------------------------
//
// Item 1.1's machinery, used the way reconcileLockDiagnostic uses it -- observe and classify,
// never remove. Archive does NOT remove the lock: that stays `workflow unlock`'s job, and the
// refusal names it.
//
// The one place this deliberately differs from reconcile's diagnostic is the failure direction.
// Reconcile fails OPEN (a diagnostic must never break reconcile); archive fails CLOSED. A store
// that cannot say whether a lock is held, or that predates inspectLock entirely, has not proven
// that nobody else is mid-write against this run -- and this command is about to delete
// directories. "Could not ask" is not "no lock".
async function inspectArchiveLock(store, runId, inspectProcess) {
  if (typeof store.inspectLock !== "function") {
    return { error: "this run store cannot report whether the run lock is held; refusing rather than archiving a run that may be mid-write." };
  }
  let inspected;
  try {
    inspected = await store.inspectLock(runId);
  } catch (error) {
    return { error: `the run lock could not be inspected (${archiveErrorText(error)}); an unreadable lock is a refusal, never an absent one.` };
  }
  if (!inspected) return { lock: { held: false, ageMs: null, stale: null, ownership: null } };

  const ownership = withAmbiguousMarkerReason(inspected, await classifyMarkerOwnership(inspected.marker, inspectProcess));
  return { lock: { held: true, ageMs: inspected.ageMs ?? null, stale: inspected.stale ?? null, ownership } };
}

function lockRefusal(runId, run, lock) {
  if (!lock.held || lock.ownership?.removable) return null;
  return archiveRefusal(
    runId,
    run,
    `Run ${runId} still holds its run lock and its owner is not provably gone (${lock.ownership?.verdict ?? "unknown"}: ${lock.ownership?.reason ?? "no verdict"}); refusing rather than archiving a run something may still be writing to.`,
    [unlockCommandFor(runId)],
    { lock },
  );
}

// --- gate 3: the agent -------------------------------------------------------
//
// `agentsByPaneFromHerdr` is the same single, indexed listAgents() call `workflow inbox` makes, and
// `correlationPaneId` is the same correlation order -- transportIdentity.paneId FIRST, because
// executeResume leaves the top-level one naming the pane Herdr already closed.
//
// Where inbox reports an unreachable Herdr as `unresolved` and carries on, archive refuses: an
// answer is the proof, and no answer is not proof of absence. The one shape that needs no answer at
// all is a run that never recorded a pane (real run 273432a7, `failed`, died before agent
// creation) -- there is no agent to prove gone, so Herdr is never even asked.
// EVERY pane the run has ever named, not just the correlated one. `correlationPaneId` answers "which
// pane is authoritative", which is the right question for a report and the wrong one for a
// destructive gate: it is `transportIdentity.paneId ?? run.paneId`, so whenever a transport pane
// exists the top-level pane is never asked about at all. A resumed run whose ORIGINAL pane somehow
// still hosts a live agent would have been archived without anyone looking. The index is already
// built, so asking about both costs nothing.
function archiveAgentPaneIds(run) {
  return [...new Set([run?.transportIdentity?.paneId, run?.paneId].filter((pane) => typeof pane === "string" && pane))];
}

async function inspectArchiveAgent(run, herdr) {
  const panes = archiveAgentPaneIds(run);
  // The reported pane stays the correlated one, so this field keeps meaning the same thing it means
  // everywhere else in the control plane.
  const primary = correlationPaneId(run);
  // `checkedPaneIds: []` rather than an absent key, found reading real `--format json` output in
  // task 3's step 5: this branch was the one place the agent object's key set differed from the
  // other, against this command's own stated rule that a renderer must never have to test for a
  // field's presence to know which shape it is holding. Empty IS the honest answer here -- nothing
  // was asked, because there was nothing to ask about.
  if (panes.length === 0) return { agent: { paneId: null, checkedPaneIds: [], resolved: false, reason: "the run records no pane id, so it has no agent to resolve" } };

  const { agentsByPane, herdrAvailable } = await agentsByPaneFromHerdr(herdr);
  if (!herdrAvailable) {
    return { error: `Herdr could not be asked whether ${panes.map((pane) => `pane ${pane}`).join(" or ")} still has a live agent; refusing rather than archiving a run that may still be being worked on.` };
  }
  for (const pane of panes) {
    const agent = agentsByPane.get(pane);
    if (agent) {
      return { error: `Run's agent is still live in Herdr on pane ${pane} (agent_status: ${agentStatus(agent) ?? "not reported"}); refusing to archive a run someone is still working on.` };
    }
  }
  return { agent: { paneId: primary, checkedPaneIds: panes, resolved: false, reason: `Herdr reports no agent on ${panes.map((pane) => `pane ${pane}`).join(" or ")}` } };
}

// --- the losses --------------------------------------------------------------

// `--porcelain=v1` lists untracked files by default, and that is the right behaviour here: git
// refuses to remove a worktree for untracked files exactly as it does for modified ones. But the
// operator's remedy is NOT the same -- untracked files are cleaned, tracked edits are committed or
// stashed -- so the two are counted separately and the refusal names which it is. Reporting "2
// uncommitted paths" for two stray build artifacts points at `git add`/`git stash`, which does the
// wrong thing to both.
function splitDirtyPaths(entries) {
  const tracked = [];
  const untracked = [];
  for (const entry of list(entries)) {
    const path = typeof entry?.path === "string" ? entry.path : null;
    if (!path) continue;
    if (entry.x === "?" && entry.y === "?") untracked.push(path);
    else tracked.push(path);
  }
  return { tracked, untracked, all: [...tracked, ...untracked] };
}

// Positive proof of absence, which is what separates "this is exactly the residue archive exists to
// reclaim" from "this directory could not be inspected". `git worktree remove` on a vanished
// directory exits 0 and deregisters it (measured, git 2.43), so a missing worktree is archivable --
// but only an ENOENT/ENOTDIR from stat proves it is missing. Every other stat outcome, including a
// path that is not a directory, is unknown and therefore a refusal.
async function probeWorktreePresence(fs, path) {
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) return { error: `${path} exists but is not a directory` };
    return { present: true };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { present: false };
    return { error: `${path} could not be inspected (${archiveErrorText(error)})` };
  }
}

// Reads one repository into either a refusal (which aborts the whole preview, because the preview
// could not be COMPUTED honestly) or a record. A DIRTY worktree is not a refusal here: it lands on
// the record and is refused after the loop, so an operator with two dirty repositories sees both
// rather than fixing one and coming straight back -- the lesson mergeCommand's conflict list
// already learned.
async function inspectRepositoryForArchive({ runId, projectAlias, project, entry, index, git, fs, timeoutMs }) {
  const repositoryId = recordedRepositoryId(entry);
  const label = repositoryLabel(repositoryId, index);
  const worktreePath = recordedRepositoryPath(entry);
  const recordedBranch = recordedRepositoryBranch(entry);

  // The five shapes item 2.3's C1 finding enumerated: field missing, `path: null`, `path: ""`, a
  // bare string entry, an empty object. git.removeWorktree's own `unsafe-path` guard is a backstop
  // for these; refusing here, with the run id and the entry named, is the real fix.
  if (!worktreePath) {
    return { refusal: `Run ${runId} repository ${label} has no worktree path recorded; refusing rather than removing an unknown directory.`, actions: [reconcileCommandFor(runId)] };
  }
  if (!isAbsolute(worktreePath)) {
    // Item 2.3's R2 finding, and it is far worse here than it was for verify: a relative path
    // resolves against THIS process's own cwd -- the control plane's own checkout -- so a removal
    // would be aimed at the control plane rather than at any run worktree.
    return { refusal: `Run ${runId} repository ${label} records a relative worktree path (${worktreePath}); refusing rather than resolving it against the control plane's own directory.`, actions: [reconcileCommandFor(runId)] };
  }

  const base = baseCheckoutFor(project, projectAlias, repositoryId, label, "measuring this run's unmerged work against the group's meta-repository");
  if (base.error) return { refusal: base.error, actions: [doctorCommandFor(projectAlias)] };
  const basePath = typeof base.path === "string" && base.path && isAbsolute(base.path) ? base.path : null;
  if (!basePath) {
    // `git worktree remove` has to run inside the repository that registered the worktree, and the
    // base checkout is the only path known to be that repository. It cannot be run from inside the
    // worktree instead: that works for a present directory (measured, git 2.43) but not for a
    // VANISHED one, which is precisely the residue this command exists to reclaim -- there is no
    // directory left to spawn in. The registry already validates `path` as a required absolute
    // path for every project shape, so this is a fail-closed backstop, not an expected shape.
    return { refusal: `Project ${projectAlias} has no absolute base checkout path for repository ${label}; there is no repository to run the worktree removal from.`, actions: [doctorCommandFor(projectAlias)] };
  }
  // A missing base_BRANCH, unlike a missing base path, is NOT a refusal: archiving does not need
  // one, it only needs one to MEASURE what archiving would leave behind. An unmeasurable loss is
  // reported as unknown (never as 0) and the archive proceeds -- see unmergedCommitsFor.
  const baseBranch = typeof base.baseBranch === "string" && base.baseBranch.trim() ? base.baseBranch.trim() : null;

  const presence = await probeWorktreePresence(fs, worktreePath);
  if (presence.error) {
    return { refusal: `Run ${runId} repository ${label} worktree ${presence.error}; an uninspectable worktree is a refusal, never an empty one.`, actions: [reconcileCommandFor(runId)] };
  }

  if (!presence.present) {
    // The most archivable case, and the one whose loss cannot be measured: there is no checkout to
    // read a branch or a HEAD out of, so the unmerged count is `null` (unknown) rather than 0.
    // `headReachable: null` means "not asked", which is what it must be when there is no HEAD.
    return {
      record: {
        repositoryId, worktreePath, recordedBranch, present: false,
        branch: null, headSha: null, headReachable: null,
        dirty: false, dirtyPaths: [], trackedPaths: [], untrackedPaths: [],
        // Empty rather than absent, so every record carries the same key set: there is no directory
        // left to hold ignored content, so "none" here is a fact rather than a gap.
        ignoredFiles: [], ignoredDirectories: [],
        basePath, baseBranch, unmergedCommits: null,
        unmergedReason: `the worktree directory at ${worktreePath} no longer exists, so its branch cannot be read`,
      },
    };
  }

  // checkoutState and resolveHead THROW when rev-parse itself fails -- a path that is not a
  // repository, a repository whose object store is gone. That is unknown, and unknown refuses.
  let state;
  let head;
  try {
    state = await git.checkoutState({ cwd: worktreePath });
    head = await git.resolveHead({ cwd: worktreePath });
  } catch (error) {
    return { refusal: `Run ${runId} repository ${label} worktree at ${worktreePath} could not be read: ${archiveErrorText(error)}`, actions: [reconcileCommandFor(runId)] };
  }

  // Checked BEFORE `dirty`, and independently of it, for the reason git.js's checkoutState records:
  // a worktree stopped inside an unfinished operation holds resolution work that deleting the
  // directory destroys, and naming only the uncommitted paths points at `git add`/`git stash`,
  // which is the wrong move.
  //
  // `pendingOperation` rather than `checkoutState`'s `merging`, and that is the fix for half of a
  // measured commit-destroying path: `merging` comes from a MERGE_HEAD-only probe, so an
  // interrupted `git rebase` -- which leaves `rebase-merge/` and no MERGE_HEAD -- reported
  // `merging: false` and sailed straight through this gate. Measured on this machine, git 2.43: an
  // interrupted `rebase -i` stops with a CLEAN tree on a DETACHED HEAD, so neither this gate nor
  // the dirty one below saw it. `merging` is left untouched for `mergeCommand`, whose question
  // really is only about merges.
  // Guarded for the same reason unmergedCommitsFor guards countCommitsNotIn: git.js documents this
  // as never throwing and it does not, but a read that turns a read-only `--dry-run` into a stack
  // trace instead of a preview is a contract this file must not depend on another module keeping.
  // A probe that could not be run is `unknown`, which refuses -- the same answer as a probe that
  // ran and could not tell.
  let pending;
  try {
    pending = await git.pendingOperation({ cwd: worktreePath, timeoutMs });
  } catch (error) {
    pending = { status: "unknown", reason: `the unfinished-operation probe itself failed: ${archiveErrorText(error)}` };
  }
  if (pending?.status === "in-progress") {
    // `operation` and `remedy` are read defensively for the same reason: an `in-progress` result
    // missing `remedy` used to be a TypeError off `.replace`, i.e. a crash on the one branch whose
    // whole job is refusing safely. An unnamed remedy is reported as unnamed and NEVER replaced by
    // a guessed one -- the point of carrying the operation's own remedy is that `git merge --abort`
    // is the wrong move for a rebase, and inventing a default would reintroduce exactly that bug.
    const operation = typeof pending.operation === "string" && pending.operation ? pending.operation : "unfinished git operation";
    const remedy = typeof pending.remedy === "string" && pending.remedy
      ? `git -C ${worktreePath} ${pending.remedy.replace(/^git /, "")}`
      : null;
    return {
      refusal: `Run ${runId} repository ${label} worktree at ${worktreePath} is in the middle of a ${operation}; ${remedy ? `finish it or run \`${remedy}\`` : "finish or abort it (git reported no remedy for this operation)"} before archiving.`,
      actions: [`git -C ${worktreePath} status`, ...(remedy ? [remedy] : [])],
    };
  }
  if (pending?.status !== "none") {
    // Callers must treat `unknown` exactly like `in-progress`; the two are separated so the
    // operator is told which it was, never so one can be waved through.
    return { refusal: `Run ${runId} repository ${label} worktree at ${worktreePath} could not be checked for an unfinished git operation (${pending?.reason ?? "reason unknown"}); an unknown operation state is a refusal, never a clean one.`, actions: [`git -C ${worktreePath} status`] };
  }
  if (state.dirty !== true && state.dirty !== false) {
    // Item 0.14's direction: an unreadable status is never clean. `!== true && !== false` rather
    // than `=== null` so an adapter that omits `dirty` entirely fails closed too.
    return { refusal: `Run ${runId} repository ${label} worktree status at ${worktreePath} could not be read (${state.statusError ?? "reason unknown"}); an unreadable status is a refusal, never a clean one.`, actions: [`git -C ${worktreePath} status`] };
  }

  // The whole-branch review's C1, and the one probe whose absence let this command destroy a file
  // that existed nowhere else while reporting the worktree clean. `git status --porcelain=v1`
  // excludes ignored entries BY DEFINITION, and `git worktree remove` without `--force` deletes
  // them without a word (measured, git 2.43) -- so every gate above this line can pass over a
  // worktree holding the only copy of a `.env`.
  //
  // Unknown REFUSES, unlike the ignored content itself. The two are different questions: "there is
  // ignored content" is surfaced and digested so the operator can approve it knowingly (see
  // ignoredContentFor's own comment for why refusing on it would make the command useless), whereas
  // "I could not find out whether there is any" cannot be approved at all -- the design's promise is
  // an approval that NAMED what would be destroyed, and an unreadable probe has nothing to name. It
  // is the same fail-closed direction as the unreadable-status and unknown-operation refusals above,
  // for a strictly more destructive fact.
  const ignored = await ignoredContentFor({ git, worktreePath, timeoutMs });
  if (ignored.error) {
    return { refusal: `Run ${runId} repository ${label} worktree at ${worktreePath} could not be checked for ignored files (${ignored.error}); ignored content is deleted by \`git worktree remove\` without warning, so an unreadable answer is a refusal, never an empty one.`, actions: [`git -C ${worktreePath} status --ignored=matching`] };
  }

  const dirtyPaths = splitDirtyPaths(state.entries);
  const branch = state.branch ?? null;
  const headSha = typeof head?.sha === "string" && head.sha ? head.sha : null;
  const unmerged = await unmergedCommitsFor({ git, basePath, baseBranch, branch, worktreePath, timeoutMs });

  return {
    record: {
      repositoryId, worktreePath, recordedBranch, present: true,
      branch, headSha,
      headReachable: await headReachabilityFor({ git, basePath, branch, headSha, timeoutMs }),
      dirty: state.dirty === true,
      dirtyPaths: dirtyPaths.all,
      trackedPaths: dirtyPaths.tracked,
      untrackedPaths: dirtyPaths.untracked,
      ignoredFiles: ignored.files,
      ignoredDirectories: ignored.directories,
      basePath, baseBranch,
      unmergedCommits: unmerged.count,
      ...(unmerged.reason ? { unmergedReason: unmerged.reason } : {}),
    },
  };
}

// Ignored content is SURFACED AND DIGESTED, never refused, and that is a deliberate decision with a
// measured basis rather than a softening.
//
// Refusing on it was considered and rejected: 5 of the 8 real worktrees on the machine this was
// built against carry ignored content, and every Node project has `node_modules/`, so refusing
// would block essentially every real archive and leave the command useless -- which is worse than
// the status quo for a tool whose entire job is reclaiming worktrees. Refusing only on ignored
// FILES (as opposed to directories) is an arbitrary heuristic that would still fire on `.env` for
// every project, i.e. still useless, with a rule nobody could state.
//
// The design's actual promise is not "nothing is ever destroyed"; it is "nothing that exists only
// inside a worktree is ever destroyed without an explicit, digest-bound approval that named it".
// Naming the entries, splitting files from directories, and binding the full list into the digest
// honours that promise exactly -- the same treatment unmerged commits already get, for the same
// reason: the operator decides, having been told.
//
// A vanished worktree is not asked (there is nothing to read), which is why this is only called on
// the present branch.
async function ignoredContentFor({ git, worktreePath, timeoutMs }) {
  let result;
  try {
    result = await git.ignoredEntries({ cwd: worktreePath, timeoutMs });
  } catch (error) {
    // git.js documents this as never throwing, and it does not. Guarded for the same reason every
    // other adapter read in this function is: a contract this file must not depend on another
    // module keeping.
    return { error: `the ignored-content probe itself failed: ${archiveErrorText(error)}` };
  }
  if (result?.status !== "read") {
    return { error: result?.reason ?? "reason unknown" };
  }
  return { files: list(result.files).map(String), directories: list(result.directories).map(String) };
}

// The other half of the measured commit-destroying path, and the direct implementation of the
// design's unconditional acceptance criterion "archiving a run never destroys a commit".
//
//   on a branch  -> `null`, "not asked". The branch ref IS the reference that survives removal, so
//                   there is nothing to prove and nothing to spend a subprocess on.
//   detached     -> asked. `git worktree remove` deletes the worktree's HEAD and its per-worktree
//                   reflog, which on a detached HEAD are the only two things referencing its
//                   commits. `true` (some ref contains it) is a warning; `false` is a refusal.
//
// `false` is also what an unresolvable HEAD sha and a missing/failing adapter produce, because the
// caller's response to `false` is to refuse: "no ref references this" and "I could not find out"
// are the same action, and it is the safe one.
async function headReachabilityFor({ git, basePath, branch, headSha, timeoutMs }) {
  if (branch) return null;
  if (!headSha) return false;
  try {
    return await git.isCommitReachable({ cwd: basePath, sha: headSha, timeoutMs }) === true;
  } catch {
    return false;
  }
}

// How much work archiving this repository would leave behind on a branch nobody is looking at any
// more. Counted in the BASE checkout, the only place both refs resolve -- not in the worktree.
//
// Every branch that cannot answer returns `count: null` WITH a reason, never 0. Task 1's
// countCommitsNotIn already refuses an absent, empty or option-shaped ref before spawning, which is
// reachable from a run record whose project has no `base_branch` at all; the guards here exist so
// the preview can say WHY it is unknown rather than printing a bare null.
async function unmergedCommitsFor({ git, basePath, baseBranch, branch, worktreePath, timeoutMs }) {
  if (!branch) {
    return { count: null, reason: `the worktree at ${worktreePath} is on a detached HEAD, so there is no branch to measure` };
  }
  if (!baseBranch) {
    return { count: null, reason: "the project has no base_branch configured, so the unmerged count cannot be measured" };
  }
  // Documented never to throw, and does not. Guarded anyway, for the same reason runMergeSequence
  // guards mergeBranch: a read that turns a read-only `--dry-run` into a stack trace instead of a
  // preview is a contract this file must not depend on another module keeping.
  let count;
  try {
    count = await git.countCommitsNotIn({ cwd: basePath, base: baseBranch, branch, timeoutMs });
  } catch (error) {
    return { count: null, reason: `the unmerged count could not be read in ${basePath}: ${archiveErrorText(error)}` };
  }
  if (!Number.isInteger(count)) {
    return { count: null, reason: `git could not count commits on ${branch} that ${baseBranch} does not have, in ${basePath}` };
  }
  return { count };
}

// What would be LOST, as opposed to what would be removed -- the distinction the design doc puts
// at the centre of this command. Removals are `repositories[]`; these are the things that outlive
// the removal only in a place nobody is looking at.
//
// Derived from the records rather than digested separately: every field these are computed from
// (branch, headSha, unmergedCommits, present) is already in the digest, so a second copy here could
// only ever drift from it.
function archiveLosses(records) {
  const losses = [];
  for (const record of records) {
    if (record.present && !record.branch) {
      // **Corrected after the reachability split.** This branch used to say "nothing but this
      // worktree's own HEAD references those commits", and that is now the opposite of what the
      // command proved: a detached HEAD that NO ref contains is refused outright by
      // irrecoverableRefusal (headReachable === false), so every record that reaches this line has
      // `headReachable === true` -- some ref does contain the commit, and that ref is what keeps it
      // alive after `git worktree remove` deletes the worktree's HEAD and per-worktree reflog.
      //
      // So this is a loss of FINDABILITY, not of commits: nothing is destroyed, but the run's work
      // is on no branch of its own, and after the removal there is no name pointing at it that
      // belongs to this run. That is worth naming -- it is the same "removed, and therefore
      // forgotten" concern the unmerged-commits loss exists for -- and it is why this warns rather
      // than refusing.
      losses.push({
        repositoryId: record.repositoryId,
        kind: "detached-head",
        worktreePath: record.worktreePath,
        branch: null,
        baseBranch: record.baseBranch,
        count: null,
        detail: `the worktree at ${record.worktreePath} is on a detached HEAD at ${record.headSha ?? "an unknown commit"}; another ref still contains that commit, so removing the worktree destroys nothing — but this run's work is on no branch of its own, so afterwards there is no name of this run's left pointing at it`,
      });
    }
    // I1's non-refusing half. A live sharer refuses (irrecoverableRefusal), so anything reaching
    // here is a finished run that also recorded this directory -- removing it settles two records at
    // once, which is fine but is not something an operator should discover afterwards.
    if (record.sharedWith.length > 0) {
      losses.push({
        repositoryId: record.repositoryId,
        kind: "shared-worktree",
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseBranch: record.baseBranch,
        count: record.sharedWith.length,
        sharedWith: record.sharedWith,
        detail: `${record.sharedWith.map((sharer) => `run ${sharer.runId} (${sharer.state})`).join(", ")} also record${record.sharedWith.length === 1 ? "s" : ""} this worktree; none of them is live, so removing it is safe — but it reclaims their directory too, and they will preview as already gone afterwards`,
      });
    }
    if (record.unmergedCommits === null) {
      losses.push({
        repositoryId: record.repositoryId,
        kind: "unmerged-commits-unknown",
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseBranch: record.baseBranch,
        count: null,
        detail: `how much of this work is unmerged could not be determined: ${record.unmergedReason ?? "reason unknown"}`,
      });
      continue;
    }
    // C1. The most literal loss of the three kinds above it: unmerged commits survive on a branch
    // and a detached HEAD's commits survive on some other ref, but these files are DELETED off the
    // disk by `git worktree remove` and exist nowhere else. Files and directories are split because
    // they mean opposite things to an operator -- `node_modules/` is regenerable noise, a `.env` is
    // an only copy -- and a warning that cannot tell them apart is a warning nobody reads.
    if (record.ignoredFiles.length > 0 || record.ignoredDirectories.length > 0) {
      losses.push({
        repositoryId: record.repositoryId,
        kind: "ignored-content",
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseBranch: record.baseBranch,
        // Every entry, so `count: null` keeps meaning UNKNOWN everywhere in this array -- an
        // unreadable ignored probe refuses rather than arriving here as a null.
        count: record.ignoredFiles.length + record.ignoredDirectories.length,
        fileCount: record.ignoredFiles.length,
        directoryCount: record.ignoredDirectories.length,
        // Files first, and files capped separately from directories, so a project with a hundred
        // ignored directories can never push the one `.env` off the end of the printed list.
        files: record.ignoredFiles.slice(0, ARCHIVE_IGNORED_PATH_LIMIT),
        directories: record.ignoredDirectories.slice(0, ARCHIVE_IGNORED_PATH_LIMIT),
        filesTruncated: record.ignoredFiles.length > ARCHIVE_IGNORED_PATH_LIMIT,
        directoriesTruncated: record.ignoredDirectories.length > ARCHIVE_IGNORED_PATH_LIMIT,
        detail: describeIgnoredContent(record),
      });
    }
    if (record.unmergedCommits > 0) {
      losses.push({
        repositoryId: record.repositoryId,
        kind: "unmerged-commits",
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseBranch: record.baseBranch,
        count: record.unmergedCommits,
        detail: `${record.unmergedCommits} commit(s) on ${record.branch} are not in ${record.baseBranch}; the branch survives, but nothing will point at this work any more`,
      });
    }
  }
  return losses;
}

// Everything that exists only inside a worktree, collected across ALL repositories and refused
// once. Two classes, and the run refuses for either:
//
//   DIRTY            -- uncommitted and untracked work has no other copy.
//   UNREACHABLE HEAD -- a detached HEAD whose commits no ref contains; removing the worktree
//                       deletes the only two things referencing them.
//
// The whole run refuses, not just the offending repository: a group project is archived whole or
// not at all, because a half-archived group leaves residue harder to reason about than the
// original. Enforced HERE, in the preview, before the first removal -- a mid-loop discovery leaves
// a partial archive that re-running cannot fix.
//
// Both classes are reported together, and both list every affected repository (capped for
// printing), because an operator shown only the first of three problems fixes one and comes
// straight back. That is mergeCommand's own conflict-list lesson.
// The sentence an operator reads before approving the deletion of files that exist nowhere else.
// Files lead, because they are the ones with no other copy; directories follow, framed as what they
// usually are so the common `node_modules/` case does not train anyone to skim past this line.
function describeIgnoredContent(record) {
  const parts = [];
  if (record.ignoredFiles.length > 0) {
    parts.push(`${record.ignoredFiles.length} ignored file(s) — ${joinPaths(record.ignoredFiles, ARCHIVE_IGNORED_PATH_LIMIT)} — which git tracks nowhere, so removing the worktree DELETES them and no branch, commit or backup holds a copy`);
  }
  if (record.ignoredDirectories.length > 0) {
    parts.push(`${record.ignoredDirectories.length} ignored director(y/ies) — ${joinPaths(record.ignoredDirectories, ARCHIVE_IGNORED_PATH_LIMIT)} — deleted with it, usually regenerable build output but not checked`);
  }
  return parts.join("; ");
}

function describeDirtyRecord(record) {
  const parts = [];
  if (record.trackedPaths.length > 0) {
    parts.push(`${record.trackedPaths.length} uncommitted change(s): ${joinPaths(record.trackedPaths, ARCHIVE_REASON_PATH_LIMIT)}`);
  }
  if (record.untrackedPaths.length > 0) {
    parts.push(`${record.untrackedPaths.length} untracked file(s): ${joinPaths(record.untrackedPaths, ARCHIVE_REASON_PATH_LIMIT)}`);
  }
  // `dirty: true` with nothing enumerable -- a status entry with no path, an adapter that reports
  // the flag without the list. Still a refusal (the flag is the fail-closed signal), but it must
  // not render as "<path> has ", which reads like a truncation bug rather than a reason.
  if (parts.length === 0) parts.push("changes git reported but did not enumerate");
  return `${record.worktreePath} has ${parts.join(" and ")}`;
}

// One capped clause per class: the same ARCHIVE_REASON_REPOSITORY_LIMIT bounds the list and the
// `(+N more)` suffix says how much is not being named. `reason` and `nextActions` are capped by the
// SAME slice (see irrecoverableRefusal) -- an earlier round capped only the reason, so eight dirty
// repositories produced a bounded sentence beside a nextActions array that grew without limit.
function describeClause(records, describe, noun) {
  const shown = records.slice(0, ARCHIVE_REASON_REPOSITORY_LIMIT);
  const rest = records.length - shown.length;
  const suffix = rest > 0 ? ` (+${rest} more ${noun})` : "";
  return `${shown.map(describe).join("; ")}${suffix}`;
}

function irrecoverableRefusal(runId, run, records, evidence) {
  const dirty = records.filter((record) => record.dirty);
  const unreachable = records.filter((record) => record.headReachable === false);
  // I1 (whole-branch review). A worktree path this run records that ANOTHER, still-live run also
  // records. Measured on the machine this was built against: two pairs of the eight real runs record
  // byte-identical worktree path sets, because the path template derives from project + ticket +
  // slug, so relaunching a failed run reuses the directory -- the old run goes `failed` (archivable)
  // and the new one is `running`. Archiving the old one deleted the live one's worktree, reported
  // `archived`, exited 0, and left the live run's state untouched at `running`.
  //
  // This is the design's acceptance criterion "a run still being worked on cannot be archived by any
  // combination of flags" -- and it was reachable through a run that is not the one being archived,
  // which is why none of the three per-run gates saw it.
  const liveShared = records.filter((record) => record.sharedWith.some((sharer) => sharer.live));
  if (dirty.length === 0 && unreachable.length === 0 && liveShared.length === 0) return null;

  const clauses = [];
  // Named FIRST when present: it is the only class here whose remedy is not something the operator
  // can do to this run at all -- they have to wait for, or close, a different run.
  if (liveShared.length > 0) {
    clauses.push(`${describeClause(
      liveShared,
      (record) => `${record.worktreePath} is also recorded by ${record.sharedWith.filter((sharer) => sharer.live).map((sharer) => `run ${sharer.runId} (${sharer.state})`).join(" and ")}`,
      "repositories",
    )}. That run is still live, and removing this worktree would destroy the work it is doing right now.`);
  }
  if (dirty.length > 0) {
    clauses.push(`${describeClause(dirty, describeDirtyRecord, "repositories")}. Uncommitted and untracked work exists nowhere else, so this refuses for the whole run and never forces.`);
  }
  if (unreachable.length > 0) {
    clauses.push(`${describeClause(
      unreachable,
      (record) => `${record.worktreePath} is on a detached HEAD at ${record.headSha ?? "an unresolvable commit"} that no ref contains`,
      "repositories",
    )}. Removing the worktree would delete the only references to those commits, and archiving a run must never destroy one.`);
  }

  // Capped by the SAME slice the reason uses, so the two cannot diverge in length.
  const actions = [
    // Points at the LIVE run, not at this one: inspecting the run being archived tells the operator
    // nothing about the run that is actually using the directory.
    ...liveShared.slice(0, ARCHIVE_REASON_REPOSITORY_LIMIT).flatMap((record) => (
      record.sharedWith.filter((sharer) => sharer.live).map((sharer) => resultCommandFor(sharer.runId))
    )),
    ...dirty.slice(0, ARCHIVE_REASON_REPOSITORY_LIMIT).flatMap((record) => [
      `git -C ${record.worktreePath} status`,
      // Only ever `-n` (dry run). This command refuses to destroy untracked work; it must not hand
      // an operator a one-liner that destroys it either.
      ...(record.untrackedPaths.length > 0 && record.trackedPaths.length === 0 ? [`git -C ${record.worktreePath} clean -nd`] : []),
    ]),
    // The remedy for an unreachable detached HEAD is to give those commits a ref, which is exactly
    // what makes them survive the removal this command is being asked to perform.
    ...unreachable.slice(0, ARCHIVE_REASON_REPOSITORY_LIMIT).map((record) => `git -C ${record.worktreePath} switch -c <branch-name>`),
  ];

  return archiveRefusal(runId, run, `Run ${runId} cannot be archived: ${clauses.join(" ")}`, [...new Set(actions)], evidence);
}

// I1. Which OTHER runs record each of this run's worktree paths, read once from the store rather
// than per repository. Everything this command knew before came from the single `run` object, so a
// second run recording the same directory was structurally invisible.
//
// Fails CLOSED, the same direction as the lock gate and for a stronger reason: a store that cannot
// list has not proven that nobody else is using these directories, and this command is about to
// delete them. "Could not ask" is not "nobody else".
//
// Archived runs are skipped: their record of the path is stale by construction -- a run is only
// marked archived after every one of its worktrees was really removed, so it is no longer a claim
// on the directory. A PARTIAL archive leaves `archivedAt` unset precisely so its remaining residue
// still counts here.
async function inspectSharedWorktrees(store, runId, records) {
  if (typeof store?.list !== "function") {
    return { error: "this run store cannot list other runs, so it cannot say whether another run is using these worktrees; refusing rather than removing a directory something else may be working in." };
  }
  let runs;
  try {
    runs = await store.list();
  } catch (error) {
    return { error: `other runs could not be listed (${archiveErrorText(error)}); an unreadable run set is a refusal, never an empty one.` };
  }

  const byPath = new Map();
  for (const other of list(runs)) {
    if (!other || other.id === runId) continue;
    if (typeof other.archivedAt === "string") continue;
    for (const entry of (Array.isArray(other.repositories) ? other.repositories : [])) {
      const path = recordedRepositoryPath(entry);
      if (!path) continue;
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push({ runId: other.id, state: other.state ?? null, live: LIVE_RUN_STATES.has(other.state) });
    }
  }

  return {
    // Sorted by run id so the digest does not depend on directory-enumeration order.
    sharers: records.map((record) => [...(byPath.get(record.worktreePath) ?? [])].sort((a, b) => String(a.runId).localeCompare(String(b.runId)))),
  };
}

// The digest binds run state, tab id, and per repository the worktree path, the branch and HEAD it
// is at, whether it is dirty and how many paths, and the unmerged-commit count -- with `null`
// (unknown) kept DISTINCT from 0 (fully merged), which canonicalText preserves. Anything material
// that moves between preview and approval changes this and the approval goes stale.
//
// The FULL dirty path count goes in here; the public projection caps only what it PRINTS. Approving
// "these 3 dirty paths" when there are 300 is the wrong approval.
function archiveDigestPayload({ runId, run, records }) {
  return {
    version: ARCHIVE_DIGEST_VERSION,
    command: "archive",
    runId,
    projectAlias: run?.projectAlias ?? null,
    runState: run?.state ?? null,
    tabId: run?.tabId ?? null,
    repositories: records.map((record) => ({
      repositoryId: record.repositoryId,
      worktreePath: record.worktreePath,
      recordedBranch: record.recordedBranch,
      present: record.present,
      branch: record.branch,
      headSha: record.headSha,
      // Bound so the approval record names the fact that was checked. Stated honestly, because a
      // digest field that cannot independently change the hash is decoration and this one nearly
      // is: on any NON-refused preview `headReachable` is `null` (on a branch, or absent) or `true`
      // (detached and contained by some ref) -- `false` refuses -- and it cannot move between those
      // two without `branch` and `headSha` moving with it. So it never varies independently, and
      // dropping it from this payload fails no test.
      //
      // What actually protects against reachability being lost between preview and approval is
      // executeArchive's RECOMPUTE: the whole preview is rebuilt before the digest is compared, so
      // a world that became irrecoverable refuses outright rather than merely failing to match.
      // See the "reachability lost between preview and execute" test, which is that guard's own.
      headReachable: record.headReachable,
      dirty: record.dirty,
      dirtyCount: record.dirtyPaths.length,
      trackedCount: record.trackedPaths.length,
      untrackedCount: record.untrackedPaths.length,
      // C1, and the ONE place in this payload where the full path list is bound rather than just a
      // count. Every other list here is digested as a length because its contents survive the
      // removal in some other place -- a commit stays on a branch, a dirty file refuses outright.
      // Ignored entries are DELETED, so the design's promise ("an approval that named it") is only
      // kept if the names themselves are what the approval is over: with counts alone, a `.env`
      // renamed to `.envx` between preview and execute would keep the digest valid and destroy a
      // file the operator was never shown. Sorted so the hash does not depend on git's enumeration
      // order, and uncapped on purpose -- this payload is hashed, never printed, so its size costs
      // nothing an operator sees, and capping the DIGEST is exactly the "approving these 3 of 300"
      // defect the printed projection's caps exist to avoid.
      //
      // `--ignored=matching` collapses `node_modules/` to one entry, so this stays small for the
      // case that would otherwise dominate it, and it stays stable while npm rewrites the contents.
      ignoredFileCount: record.ignoredFiles.length,
      ignoredDirectoryCount: record.ignoredDirectories.length,
      ignoredEntries: [...record.ignoredFiles, ...record.ignoredDirectories].sort(),
      // I1. Binds WHICH other runs record this same worktree path, so an approval goes stale the
      // moment a relaunch starts recording it -- the exact sequence that makes this dangerous.
      sharedWith: record.sharedWith.map((sharer) => ({ runId: sharer.runId, state: sharer.state })),
      basePath: record.basePath,
      baseBranch: record.baseBranch,
      unmergedCommits: record.unmergedCommits,
    })),
  };
}

// What is PRINTED. Nothing here is capped, because nothing here can be long: this projection only
// ever runs on the non-refused branch, where every record is by construction clean (`dirty: true`
// refuses) -- so the dirty counts below are always 0 and there is no path list to truncate. They
// are kept rather than dropped because "checked, and found clean" is the evidence an operator is
// approving, and because they mirror the digest's own fields exactly.
function publicArchiveRepository(record) {
  return {
    repositoryId: record.repositoryId,
    worktreePath: record.worktreePath,
    recordedBranch: record.recordedBranch,
    present: record.present,
    branch: record.branch,
    // Literally `recordedBranch !== branch`, per merge's own precedent: a run that recorded no
    // branch at all also disagrees with the worktree, and that is worth naming rather than hiding.
    branchMismatch: record.recordedBranch !== record.branch,
    headSha: record.headSha,
    // `null` = on a branch, so not asked; `true` = detached but some ref contains it. `false` never
    // reaches here -- it refuses.
    headReachable: record.headReachable,
    dirty: record.dirty,
    dirtyCount: record.dirtyPaths.length,
    trackedCount: record.trackedPaths.length,
    untrackedCount: record.untrackedPaths.length,
    // C1. Counts are the FULL counts (they mirror the digest); the path lists are the only capped
    // fields on this projection, and they are capped separately per kind so a hundred ignored
    // directories can never hide the one ignored file that matters.
    ignoredFileCount: record.ignoredFiles.length,
    ignoredDirectoryCount: record.ignoredDirectories.length,
    ignoredFiles: record.ignoredFiles.slice(0, ARCHIVE_IGNORED_PATH_LIMIT),
    ignoredDirectories: record.ignoredDirectories.slice(0, ARCHIVE_IGNORED_PATH_LIMIT),
    ignoredFilesTruncated: record.ignoredFiles.length > ARCHIVE_IGNORED_PATH_LIMIT,
    ignoredDirectoriesTruncated: record.ignoredDirectories.length > ARCHIVE_IGNORED_PATH_LIMIT,
    // I1. Only ever non-live sharers reach a non-refused preview -- a live one refuses -- so this
    // is the "another finished run also recorded this path" warning, carried so the operator can see
    // that removing it settles two records at once.
    sharedWith: record.sharedWith,
    basePath: record.basePath,
    baseBranch: record.baseBranch,
    unmergedCommits: record.unmergedCommits,
    ...(record.unmergedReason ? { unmergedReason: record.unmergedReason } : {}),
  };
}

async function buildArchivePreview(runId, run, options, deps) {
  // The three gates, all of them before ANY worktree is inspected. Ordered cheapest and most
  // definite first: a live run is refused without spawning a single subprocess.
  const stateRefusal = liveStateRefusal(runId, run);
  if (stateRefusal) return { preview: stateRefusal, records: [] };

  const store = deps.store;
  const lockResult = await inspectArchiveLock(store, runId, deps.inspectProcess);
  if (lockResult.error) return { preview: archiveRefusal(runId, run, `Run ${runId} cannot be archived: ${lockResult.error}`, [unlockCommandFor(runId)]), records: [] };
  const lock = lockResult.lock;
  const heldRefusal = lockRefusal(runId, run, lock);
  if (heldRefusal) return { preview: heldRefusal, records: [] };

  const agentResult = await inspectArchiveAgent(run, deps.herdr);
  if (agentResult.error) return { preview: archiveRefusal(runId, run, agentResult.error, [resultCommandFor(runId)], { lock }), records: [] };
  const agent = agentResult.agent;
  // Everything from here on refuses with the two gates it already passed attached, so a refusal
  // about a dirty worktree still shows that the lock and the agent were checked and cleared.
  const evidence = { lock, agent };

  // NOT `list()`, which filters out `null`/`undefined` entries. That is right for the read-only
  // commands it was written for, and wrong here: `repositories: [valid, null]` would archive the
  // valid one and never mention the malformed sibling -- a sixth entry shape silently passing where
  // the five item 2.3's C1 finding enumerated all refuse. A malformed entry has to reach
  // inspectRepositoryForArchive, where it refuses like the rest.
  const repositories = Array.isArray(run.repositories) ? run.repositories : [];
  if (repositories.length === 0) {
    return { preview: archiveRefusal(runId, run, `Run ${runId} has no repositories[] recorded; there is nothing to archive.`, [reconcileCommandFor(runId)], evidence), records: [] };
  }

  const injectedLoadRegistry = deps.loadRegistry ?? loadRegistry;
  const registry = await injectedLoadRegistry(options.registryPath);
  const project = registry?.projects?.[run.projectAlias];
  if (!project) {
    return { preview: archiveRefusal(runId, run, `Unknown workflow project: ${run.projectAlias}`, [doctorCommandFor(run.projectAlias)], evidence), records: [] };
  }

  const git = archiveGitAdapter(deps);
  const fs = deps.fs ?? defaultFs;
  const timeoutMs = Number.isFinite(deps.previewTimeoutMs) ? deps.previewTimeoutMs : ARCHIVE_PREVIEW_TIMEOUT_MS;

  const records = [];
  for (const [index, entry] of repositories.entries()) {
    const outcome = await inspectRepositoryForArchive({ runId, projectAlias: run.projectAlias, project, entry, index, git, fs, timeoutMs });
    if (outcome.refusal) return { preview: archiveRefusal(runId, run, outcome.refusal, list(outcome.actions), evidence), records: [] };
    records.push(outcome.record);
  }

  // I1. One store read for the whole run, after every worktree path is resolved and before anything
  // can be removed. Annotated onto the records so the refusal, the digest and the printed projection
  // all read the same answer rather than each deriving its own.
  const shared = await inspectSharedWorktrees(store, runId, records);
  if (shared.error) {
    return { preview: archiveRefusal(runId, run, `Run ${runId} cannot be archived: ${shared.error}`, [reconcileCommandFor(runId)], evidence), records: [] };
  }
  for (const [index, record] of records.entries()) record.sharedWith = shared.sharers[index];

  const irrecoverable = irrecoverableRefusal(runId, run, records, evidence);
  if (irrecoverable) return { preview: irrecoverable, records: [] };

  const preview = {
    command: "archive",
    runId,
    projectAlias: run.projectAlias ?? null,
    runState: run.state ?? null,
    refused: false,
    reason: null,
    tabId: run.tabId ?? null,
    agent,
    lock,
    repositories: records.map(publicArchiveRepository),
    losses: archiveLosses(records),
    removable: true,
    approvalDigest: sha256Digest(canonicalText(archiveDigestPayload({ runId, run, records }))),
    exitCode: ARCHIVE_EXIT_CODES.archived,
    nextActions: [],
  };
  preview.nextActions = [
    `workflow archive ${runId} --yes --approval-digest ${preview.approvalDigest}`,
    // A lock whose owner is proven gone does not block the archive -- but store.update and
    // appendEvent both take that same lock, so the persistence step below WILL fail against it.
    // Naming the way out here means the operator does not discover it only after the removals.
    ...(lock.held ? [unlockCommandFor(runId)] : []),
  ];
  return { preview, records };
}

async function archiveContext(options, deps) {
  const store = await storeForCommand(options, deps);
  const runId = assertRunId(options.runId);
  const run = await store.read(runId);
  const { preview, records } = await buildArchivePreview(runId, run, options, { ...deps, store });
  return { store, runId, run, preview, records };
}

function assertSuppliedArchiveDigest(supplied) {
  if (typeof supplied !== "string" || !supplied) {
    archiveError("PREFLIGHT", "Missing approval digest; rerun workflow archive --dry-run and approve the current digest", ARCHIVE_EXIT_CODES.refused);
  }
  if (!APPROVAL_DIGEST_PATTERN.test(supplied)) {
    archiveError("PREFLIGHT", "Invalid approval digest; rerun workflow archive --dry-run and approve the current digest", ARCHIVE_EXIT_CODES.refused);
  }
}

function archiveFailureText(result) {
  const text = result?.error ?? result?.stderr ?? "";
  return String(text).trim().slice(0, ARCHIVE_FAILURE_TEXT_LIMIT) || `git worktree remove exited with code ${result?.code}`;
}

function archiveReportEntry(record, extra = {}) {
  return {
    repositoryId: record.repositoryId,
    worktreePath: record.worktreePath,
    branch: record.branch,
    ...extra,
  };
}

// Sequential, and deliberately NOT stopping at the first failure -- the one place this diverges
// from runMergeSequence, and the reason is that the operations differ in kind. Merge's repositories
// share an intent (one integration, several repositories), so continuing past a failure risks a
// half-integrated feature. Removals are independent reclamations of residue: the preview has
// already refused the whole run if any worktree was dirty, so by this line every removal is
// individually approved, and stopping early would leave MORE residue behind for no benefit.
//
// `kept[]` is every worktree still on disk afterwards, each with git's own reason. `removed[]` is
// what is really gone. Neither is undoable by re-running, which is why the report is written to
// admit partial completion rather than to avoid admitting it.
async function runArchiveRemovals(records, git, timeoutMs) {
  const removed = [];
  const kept = [];

  for (const record of records) {
    // git.js's removeWorktree is documented never to throw, and does not. Guarded anyway: one
    // thrown error from repository 2 would otherwise unwind past repository 1's real, already
    // completed removal and leave the operator with a stack trace instead of the only record that
    // it happened.
    let result;
    try {
      // `cwd` is the BASE checkout, never the worktree: a vanished worktree is the case this
      // command exists for, and there would be no directory left to spawn in. The preview refuses
      // any repository with no absolute base path for exactly this reason.
      result = await git.removeWorktree({ cwd: record.basePath, path: record.worktreePath, timeoutMs });
    } catch (error) {
      result = { ok: false, code: 1, stdout: "", stderr: "", reason: "failed", error: archiveErrorText(error) };
    }

    if (!result?.ok) {
      kept.push(archiveReportEntry(record, {
        code: result?.code ?? null,
        reason: result?.reason ?? "failed",
        detail: archiveFailureText(result),
      }));
      continue;
    }
    // The EXECUTED argv is reported, not one rebuilt here. `unsafe-path` and a failed spawn both
    // report an argv that never ran, which is why it is only carried on the SUCCESS side.
    removed.push(archiveReportEntry(record, { code: result.code, argv: [...list(result.argv)] }));
  }

  return { removed, kept };
}

// Best-effort and last, after removals that cannot be undone. Three outcomes an operator has to be
// able to tell apart, so all three are on the response:
//   - no tab was ever recorded         -> nothing was asked, and that is not a failure
//   - `not-found`                      -> already archived (the COMMON case; every recorded tabId
//                                         on this machine is stale)
//   - anything else                    -> reported, never thrown, never a rollback
async function closeArchiveTab(herdr, tabId) {
  if (typeof tabId !== "string" || !tabId) {
    return { tabId: null, closed: false, alreadyGone: false, reason: "no-tab-recorded" };
  }
  if (!herdr || typeof herdr.closeTab !== "function") {
    return { tabId, closed: false, alreadyGone: false, reason: "no Herdr adapter available to close the tab" };
  }
  let result;
  try {
    result = await herdr.closeTab({ tabId });
  } catch (error) {
    // herdr.js's closeTab is documented never to throw. Guarded for the same reason the removals
    // are: by this line real directories are already gone, and a throw here would discard the only
    // report that they went.
    return { tabId, closed: false, alreadyGone: false, reason: archiveErrorText(error) };
  }
  if (result?.closed) return { tabId, closed: true, alreadyGone: false, reason: null };
  const reason = typeof result?.reason === "string" ? result.reason : "the tab could not be closed";
  return { tabId, closed: false, alreadyGone: reason === "not-found", reason };
}

// The preview's losses describe a world in which every worktree WAS removed. On a `partial` or
// `failed` report that world did not happen, and telling an operator "nothing will point at this
// work any more" about a worktree still sitting on disk is exactly the kind of dishonesty the rest
// of this command's partial-completion handling is careful to avoid. Keyed on `worktreePath`, which
// is guaranteed present and unique, rather than on `repositoryId`, which may be null on more than
// one entry.
function archiveReportLosses(losses, removed) {
  const removedPaths = new Set(removed.map((entry) => entry.worktreePath));
  return losses.map((loss) => (
    removedPaths.has(loss.worktreePath)
      ? { ...loss, removed: true }
      : { ...loss, removed: false, detail: `${loss.detail} — but this worktree was NOT removed and is still on disk at ${loss.worktreePath}, so nothing has been lost yet.` }
  ));
}

// What the run's own event log keeps once the worktree is gone -- the design's "the run's evidence
// outlives its worktree", made concrete. After the removal this is the only surviving record of
// which branch each worktree was on, at which commit, and how much of it was never merged.
function archivedRepositoryEvidence(record) {
  return {
    repositoryId: record.repositoryId,
    worktreePath: record.worktreePath,
    branch: record.branch,
    headSha: record.headSha,
    basePath: record.basePath,
    baseBranch: record.baseBranch,
    unmergedCommits: record.unmergedCommits,
  };
}

async function executeArchive(options, deps, supplied) {
  assertSuppliedArchiveDigest(supplied);

  // The whole preview is rebuilt from scratch and the supplied digest compared against the FRESH
  // one, so anything that moved between preview and approval -- a new commit, a worktree that went
  // dirty, a resumed run, an agent that came back -- refuses instead of removing something the
  // operator never saw. All three gates are therefore re-evaluated here, not just the digest.
  const fresh = await archiveContext(options, deps);
  if (fresh.preview.refused) {
    archiveError("PREFLIGHT", `workflow archive refused: ${fresh.preview.reason}`, ARCHIVE_EXIT_CODES.refused);
  }
  if (supplied !== fresh.preview.approvalDigest) {
    archiveError(
      "PREFLIGHT",
      `Stale approval digest; rerun ${archiveCommandFor(fresh.runId)} before executing. Current digest: ${fresh.preview.approvalDigest}`,
      ARCHIVE_EXIT_CODES.refused,
      { expected: fresh.preview.approvalDigest, supplied },
    );
  }

  const git = archiveGitAdapter(deps);
  const timeoutMs = Number.isFinite(deps.archiveTimeoutMs) ? deps.archiveTimeoutMs : ARCHIVE_REMOVE_TIMEOUT_MS;
  const { removed, kept } = await runArchiveRemovals(fresh.records, git, timeoutMs);
  const tab = await closeArchiveTab(deps.herdr, fresh.run.tabId);

  const status = kept.length === 0 ? "archived" : removed.length > 0 ? "partial" : "failed";
  const exitCode = status === "archived"
    ? ARCHIVE_EXIT_CODES.archived
    : status === "partial" ? ARCHIVE_EXIT_CODES.partial : ARCHIVE_EXIT_CODES.failed;
  const archivedAt = typeof deps.now === "function" ? String(deps.now()) : new Date().toISOString();

  // Only a COMPLETE archive marks the record. A partial one still has residue on disk, and the
  // board hiding the run (item 2.1's relief, wired in the next task) would hide the residue with
  // it. Re-running after a partial archive re-previews the worktrees that are now gone as absent
  // and the kept ones as they are -- a fresh digest, and a way to finish.
  let recordError;
  if (status === "archived") {
    try {
      await fresh.store.update(fresh.runId, () => ({ archivedAt }));
    } catch (error) {
      // Item 2.3's I4 finding, and it matters more here than anywhere it has mattered before: by
      // this line real directories are gone from a real filesystem, and re-running cannot undo it.
      // The most likely cause is the run lock being held -- possibly by the proven-dead owner gate
      // 2 deliberately allowed through -- which is why the response names `workflow unlock`.
      recordError = `the run could not be marked archived: ${archiveErrorText(error)}`;
    }
  }

  let evidenceError;
  try {
    await fresh.store.appendEvent(fresh.runId, {
      type: "archive",
      approvalDigest: supplied,
      status,
      exitCode,
      archivedAt: status === "archived" ? archivedAt : null,
      removed,
      kept,
      tab,
      repositories: fresh.records.map(archivedRepositoryEvidence),
    });
  } catch (error) {
    evidenceError = `evidence could not be persisted: ${archiveErrorText(error)}`;
  }

  return {
    command: "archive",
    runId: fresh.runId,
    projectAlias: fresh.run.projectAlias ?? null,
    approvalDigest: supplied,
    status,
    archivedAt: status === "archived" ? archivedAt : null,
    removed,
    kept,
    tab,
    losses: archiveReportLosses(fresh.preview.losses, removed),
    exitCode,
    ...(recordError ? { recordError } : {}),
    ...(evidenceError ? { evidenceError } : {}),
    nextActions: [
      ...(status === "archived" ? [] : [archiveCommandFor(fresh.runId)]),
      ...(recordError || evidenceError ? [unlockCommandFor(fresh.runId)] : []),
    ],
  };
}

export async function archiveCommand(options = {}, deps = {}) {
  const { preview } = await archiveContext(options, deps);
  return {
    preview,
    async execute(executeOptions = {}) {
      return await executeArchive(options, deps, executeOptions.approvalDigest);
    },
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
