import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildAssignmentTemplate } from "./assignment.js";
import { WorkflowError } from "./errors.js";
import { executeStart as defaultExecuteStart } from "./execute.js";
import { buildHarnessLaunch } from "./harnesses.js";
import { RUN_STATES } from "./run-state.js";

function fail(category, message, details, exitCode = 10) {
  throw new WorkflowError(category, message, { details, exitCode });
}

function sha256Digest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function cloneData(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    const child = value[key];
    if (typeof child !== "function" && child !== undefined) result[key] = canonicalize(child);
    return result;
  }, {});
}

function canonicalText(value) {
  return JSON.stringify(canonicalize(value));
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [];
}

function ready(check) {
  return check?.status === "ready";
}

function selectedPermissions(profile = {}) {
  return {
    ...(profile.permission_mode !== undefined ? { permission_mode: profile.permission_mode } : {}),
    ...(profile.sandbox !== undefined ? { sandbox: profile.sandbox } : {}),
    ...(profile.approval_policy !== undefined ? { approval_policy: profile.approval_policy } : {}),
  };
}

function selectedProfile(plan = {}) {
  const agent = plan.agent ?? {};
  const profile = agent.profile ?? {};
  return {
    profileName: agent.profileName ?? "unspecified",
    harness: agent.harness ?? profile.harness ?? "unspecified",
    command: agent.command ?? profile.command ?? agent.harness ?? "unspecified",
    roles: list(agent.roles),
    model: profile.model ?? null,
    arguments: list(profile.arguments),
    permissions: selectedPermissions(profile),
    reason: `selected workflow agent profile ${agent.profileName ?? "unspecified"}`,
  };
}

function repositoriesForDigest(plan = {}) {
  const repositories = list(plan.repositories);
  if (repositories.length > 0) {
    return repositories.map((repository) => ({
      alias: repository.alias ?? repository.id ?? null,
      path: repository.path ?? null,
      worktreePath: repository.worktreePath ?? repository.checkoutPath ?? null,
      branch: repository.branch ?? null,
      baseBranch: repository.baseBranch ?? repository.base ?? null,
    }));
  }

  return list(plan.worktrees).map((worktree) => ({
    alias: worktree.alias ?? worktree.role ?? null,
    path: worktree.repositoryPath ?? worktree.cwd ?? null,
    worktreePath: worktree.path ?? worktree.worktreePath ?? null,
    branch: worktree.branch ?? null,
    baseBranch: worktree.baseBranch ?? worktree.base ?? null,
  }));
}

function identityForDigest(plan = {}) {
  const identity = plan.identity ?? {};
  return {
    projectAlias: identity.projectAlias ?? null,
    projectLabel: identity.projectLabel ?? null,
    task: identity.task ?? identity.primaryTicket ?? null,
    primaryTicket: identity.primaryTicket ?? identity.task ?? null,
    relatedTickets: list(identity.relatedTickets).map(String),
    tickets: list(identity.tickets).map(String),
    feature: identity.feature ?? null,
    slug: identity.slug ?? null,
    mode: plan.mode ?? null,
  };
}

function digestPayload({ reconciliation, selection, assignment }) {
  return {
    version: 1,
    identity: identityForDigest(reconciliation),
    repositories: repositoriesForDigest(reconciliation),
    selection: {
      profileName: selection.profileName,
      harness: selection.harness,
      command: selection.command,
      roles: selection.roles,
      model: selection.model,
      arguments: selection.arguments,
      permissions: selection.permissions,
    },
    assignment,
  };
}

function approvalDigestFor(preview) {
  return sha256Digest(canonicalText(digestPayload(preview)));
}

function assignmentDigestFor(assignment) {
  return sha256Digest(assignment);
}

function planCommandOptions(options = {}) {
  const {
    request: _request,
    approvalDigest: _approvalDigest,
    stateRoot: _stateRoot,
    controlPlaneBin: _controlPlaneBin,
    runId: _runId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    originSession: _originSession,
    ...safe
  } = options;
  return { ...safe, command: "plan" };
}

function previewRequest(planPreview, options) {
  if (planPreview.request && typeof planPreview.request === "object") return cloneData(planPreview.request);
  const identity = planPreview.reconciliation?.identity ?? {};
  return {
    task: identity.task ?? options.task ?? null,
    tickets: list(identity.tickets).map(String),
    relatedTickets: list(identity.relatedTickets).map(String),
    feature: identity.feature ?? options.feature ?? null,
    repositories: repositoriesForDigest(planPreview.reconciliation).map((repository) => repository.alias).filter(Boolean),
    runtimeProfile: planPreview.reconciliation?.runtime?.profileName ?? options.runtimeProfile ?? null,
  };
}

function assertPlanCommand(planCommand) {
  if (typeof planCommand !== "function") {
    fail("PREFLIGHT", "launch preview requires a planCommand dependency");
  }
}

export async function createLaunchPreview(options = {}, deps = {}) {
  const planCommand = deps.planCommand;
  assertPlanCommand(planCommand);

  const planPreview = await planCommand(planCommandOptions(options), deps);
  const reconciliation = cloneData(planPreview.reconciliation);
  const selection = selectedProfile(reconciliation);
  const assignment = buildAssignmentTemplate({
    request: options.request,
    context: {
      project: planPreview.project,
      stage: options.stage ?? "implementation",
      verificationCommands: options.verificationCommands,
    },
    plan: reconciliation,
    selection,
  });

  const preview = {
    command: "launch",
    project: cloneData(planPreview.project),
    request: previewRequest(planPreview, options),
    selection,
    preconditions: cloneData(planPreview.preconditions ?? {}),
    reconciliation,
    assignment,
    assignmentDigest: assignmentDigestFor(assignment),
    approvalDigest: null,
    conflicts: cloneData(planPreview.conflicts ?? reconciliation?.conflicts ?? []),
    operations: cloneData(list(reconciliation?.operations).filter((operation) => operation.phase === "start")),
  };
  preview.approvalDigest = approvalDigestFor(preview);
  return preview;
}

function assertApprovalDigest(preview) {
  if (typeof preview?.approvalDigest !== "string" || !preview.approvalDigest) {
    fail("PREFLIGHT", "Missing approval digest; rerun launch preview and approve the current digest");
  }
  const expected = approvalDigestFor(preview);
  if (preview.approvalDigest !== expected) {
    fail("PREFLIGHT", "Stale approval digest; rerun launch preview before executing", {
      supplied: preview.approvalDigest,
      expected,
    });
  }
}

function requiredPreconditions(preconditions = {}) {
  const generic = Object.hasOwn(preconditions, "agent") || Object.hasOwn(preconditions, "agentIntegration");
  return generic
    ? ["git", "herdr", "herdrStatus", "agent", "agentIntegration"]
    : ["git", "herdr", "herdrStatus", "pi", "piIntegration"];
}

function assertLaunchable(preview) {
  if ((preview.conflicts?.length ?? 0) > 0 || preview.reconciliation?.status === "conflict") {
    const first = preview.conflicts?.[0];
    fail("CONFLICT", first ? `${first.resource}: ${first.reason}` : "Workflow launch has conflicts", { conflicts: preview.conflicts }, 11);
  }

  for (const name of requiredPreconditions(preview.preconditions ?? {})) {
    const check = preview.preconditions?.[name];
    if (!check || typeof check !== "object" || typeof check.status !== "string") {
      fail("PREFLIGHT", `Missing or malformed required precondition: ${name}`);
    }
    if (!ready(check)) {
      fail("PREFLIGHT", check.reason ?? `Launch requires ready ${check.id ?? name}`);
    }
  }
}

function runRepositories(plan = {}) {
  const repositories = repositoriesForDigest(plan);
  if (repositories.length > 0) {
    return repositories.map((repository) => ({
      id: repository.alias ?? "repository",
      path: repository.worktreePath ?? repository.path,
      branch: repository.branch,
    }));
  }
  const cwd = plan.agent?.worktreePath ?? plan.workspace?.path;
  return [{ id: plan.identity?.projectAlias ?? "repository", path: cwd }];
}

function runInput(preview, { stateRoot, controlPlaneBin, originSession } = {}) {
  const identity = preview.reconciliation?.identity ?? {};
  const generation = 1;
  return {
    state: RUN_STATES.PLANNED,
    generation,
    projectAlias: identity.projectAlias,
    projectLabel: identity.projectLabel,
    task: identity.task,
    primaryTicket: identity.primaryTicket ?? identity.task,
    relatedTickets: list(identity.relatedTickets).map(String),
    tickets: list(identity.tickets).map(String),
    repositories: runRepositories(preview.reconciliation),
    request: cloneData(preview.request),
    profileName: preview.selection.profileName,
    harness: preview.selection.harness,
    stateRoot,
    controlPlaneBin,
    assignmentDigest: preview.assignmentDigest,
    approvalDigest: preview.approvalDigest,
    originSessionId: originSession?.sessionId ?? originSession?.id ?? null,
    originHarness: originSession?.harness ?? null,
  };
}

function assignmentWithExecutionHeader(run, assignment) {
  return [
    `Workflow Run: ${run.id}`,
    `Generation: ${run.generation ?? 1}`,
    `Run Directory: ${run.directory}`,
    "",
    assignment,
  ].join("\n");
}

function runForHarness(run, { stateRoot, controlPlaneBin }) {
  return {
    ...run,
    generation: run.generation ?? 1,
    stateRoot,
    controlPlaneBin,
  };
}

function operationById(report, id) {
  return list(report?.operations).find((operation) => operation.id === id) ?? null;
}

function sessionPatch(report, launchExpected = {}) {
  const agent = operationById(report, "agent") ?? {};
  return {
    agentId: agent.agentId ?? agent.agent_id ?? null,
    tabId: agent.tabId ?? agent.tab_id ?? null,
    paneId: agent.paneId ?? agent.pane_id ?? null,
    nativeSessionId: launchExpected.nativeSessionId ?? null,
    sessionName: launchExpected.sessionName ?? null,
  };
}

function recoveryCommand(runId) {
  return `workflow reconcile --run ${runId}`;
}

function buildLaunchReport(status, run, execution, extra = {}) {
  const recovery = recoveryCommand(run.id);
  return {
    command: "launch",
    status,
    runId: run.id,
    runDirectory: run.directory,
    recoveryCommand: recovery,
    guidance: status === "partial" || status === "failed" ? [recovery] : [recovery],
    operations: cloneData(execution?.operations ?? []),
    notes: cloneData(execution?.notes ?? []),
    ...extra,
  };
}

async function updateRun(store, runId, patch) {
  return await store.update(runId, () => patch);
}

function assertStore(store) {
  if (!store || typeof store.create !== "function" || typeof store.writeAssignment !== "function" || typeof store.update !== "function") {
    fail("PREFLIGHT", "launch execution requires a run store");
  }
}

export async function executeLaunch(preview, deps = {}) {
  assertApprovalDigest(preview);
  assertLaunchable(preview);
  assertStore(deps.store);

  const stateRoot = deps.stateRoot ?? preview.stateRoot;
  const controlPlaneBin = deps.controlPlaneBin ?? preview.controlPlaneBin;
  if (typeof stateRoot !== "string" || !stateRoot) fail("PREFLIGHT", "launch execution requires stateRoot");
  if (typeof controlPlaneBin !== "string" || !controlPlaneBin) fail("PREFLIGHT", "launch execution requires controlPlaneBin");

  const store = deps.store;
  const created = await store.create(runInput(preview, {
    stateRoot,
    controlPlaneBin,
    originSession: deps.originSession,
  }));
  const run = runForHarness(created, { stateRoot, controlPlaneBin });
  await store.writeAssignment(run.id, assignmentWithExecutionHeader(run, preview.assignment));
  await updateRun(store, run.id, {
    state: RUN_STATES.LAUNCHING,
    launchStartedAt: new Date().toISOString(),
  });

  let launchExpected = null;
  const launchBuilder = deps.buildAgentLaunch ?? buildHarnessLaunch;
  const executeStart = deps.executeStart ?? defaultExecuteStart;
  const planForStart = {
    ...cloneData(preview.reconciliation),
    run,
  };

  try {
    const execution = await executeStart(planForStart, { git: deps.git, herdr: deps.herdr }, {
      buildAgentLaunch(input) {
        const spec = launchBuilder(input);
        launchExpected = spec.expected;
        return spec;
      },
    });
    const session = sessionPatch(execution, launchExpected ?? {});
    await updateRun(store, run.id, {
      state: RUN_STATES.RUNNING,
      harness: preview.selection.harness,
      profileName: preview.selection.profileName,
      launchStatus: execution?.status ?? "unknown",
      launchOperations: cloneData(execution?.operations ?? []),
      launchNotes: cloneData(execution?.notes ?? []),
      ...session,
    });

    if (execution?.status === "partial" || execution?.status === "failed") {
      return buildLaunchReport("partial", run, execution, {
        error: cloneData(execution.error),
      });
    }

    return buildLaunchReport("running", run, execution);
  } catch (error) {
    const execution = {
      status: "partial",
      operations: [],
      notes: [],
      error: { name: error.name, message: error.message },
    };
    try {
      await updateRun(store, run.id, {
        state: RUN_STATES.RUNNING,
        harness: preview.selection.harness,
        profileName: preview.selection.profileName,
        launchStatus: "partial",
        launchError: { name: error.name, message: error.message },
      });
    } catch (_updateError) {
      // Preserve the original environment/start failure and the run directory for manual reconciliation.
    }
    return buildLaunchReport("partial", run, execution, {
      error: { name: error.name, message: error.message },
    });
  }
}

export async function launchCommand(options = {}, deps = {}) {
  const preview = await createLaunchPreview(options, deps);
  return {
    preview,
    async execute(executeOptions = {}) {
      const approvalDigest = executeOptions.approvalDigest ?? options.approvalDigest;
      const fresh = await createLaunchPreview(options, deps);
      return await executeLaunch({ ...fresh, approvalDigest }, { ...deps, ...executeOptions });
    },
  };
}
