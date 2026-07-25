import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { HARNESS_TELEMETRY_VERSIONS } from "./telemetry-adapters.js";
import { buildAssignmentTemplate } from "./assignment.js";
import { WorkflowError } from "./errors.js";
import { executeStart as defaultExecuteStart } from "./execute.js";
import { buildHarnessLaunch } from "./harnesses.js";
import { RUN_STATES } from "./run-state.js";

function fail(category, message, details, exitCode = 10) {
  throw new WorkflowError(category, message, { details, exitCode });
}

export function sha256Digest(text) {
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

const EXECUTION_INPUT_VERSION = 1;
const APPROVAL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VOLATILE_EXECUTION_OPTION_KEYS = new Set([
  "approvalDigest",
  "command",
  "yes",
  "dryRun",
  "format",
  "runId",
  "createdAt",
  "updatedAt",
  "originSession",
  "env",
]);

function approvedString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("PREFLIGHT", `launch preview requires valid ${name}`);
  }
  return value;
}

function optionOrDefault(options, deps, name) {
  return Object.hasOwn(options, name) && options[name] !== undefined ? options[name] : deps[name];
}

function approvedExecutionEnvironment(options = {}, deps = {}) {
  return {
    stateRoot: approvedString(optionOrDefault(options, deps, "stateRoot"), "stateRoot"),
    controlPlaneBin: approvedString(optionOrDefault(options, deps, "controlPlaneBin"), "controlPlaneBin"),
  };
}

function executionInputFor(options = {}, deps = {}) {
  const approvedEnvironment = approvedExecutionEnvironment(options, deps);
  const safe = { ...options, ...approvedEnvironment };
  for (const [key, value] of Object.entries(safe)) {
    if (VOLATILE_EXECUTION_OPTION_KEYS.has(key) || value === undefined || typeof value === "function") {
      delete safe[key];
    }
  }
  return {
    version: EXECUTION_INPUT_VERSION,
    options: cloneData(canonicalize(safe)),
    ...(options.originSession !== undefined ? { originSession: cloneData(options.originSession) } : {}),
  };
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

function selectedProfile(plan = {}, { selectionReason } = {}) {
  const agent = plan.agent ?? {};
  const profile = agent.profile ?? {};
  return {
    profileName: agent.profileName ?? "unspecified",
    source: agent.selectionSource ?? "unspecified",
    harness: agent.harness ?? profile.harness ?? "unspecified",
    command: agent.command ?? profile.command ?? agent.harness ?? "unspecified",
    roles: list(agent.roles),
    model: profile.model ?? null,
    arguments: list(profile.arguments),
    permissions: selectedPermissions(profile),
    reason: selectionReason ?? `selected workflow agent profile ${agent.profileName ?? "unspecified"}`,
  };
}

function previewHarnessProfile(plan = {}) {
  const agent = plan.agent ?? {};
  const profile = agent.profile ?? {};
  return {
    harness: agent.harness,
    command: agent.command,
    mode: profile.mode ?? "interactive",
    model: profile.model ?? null,
    arguments: list(profile.arguments),
    ...(profile.permission_mode !== undefined ? { permission_mode: profile.permission_mode } : {}),
    ...(profile.sandbox !== undefined ? { sandbox: profile.sandbox } : {}),
    ...(profile.approval_policy !== undefined ? { approval_policy: profile.approval_policy } : {}),
  };
}

function previewLaunchSpec(plan = {}, selection = {}, executionOptions = {}) {
  const runId = "<generated-run-id>";
  return buildHarnessLaunch({
    profileName: selection.profileName,
    profile: previewHarnessProfile(plan),
    sessionName: plan.agent?.sessionName,
    cwd: plan.agent?.worktreePath,
    run: {
      id: runId,
      directory: join(executionOptions.stateRoot, runId),
      generation: 1,
      stateRoot: executionOptions.stateRoot,
      controlPlaneBin: executionOptions.controlPlaneBin,
    },
    nativeSessionId: "<generated-native-session-id>",
  });
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

function executionInputForDigest(executionInput = {}) {
  const { originSession: _originSession, ...stable } = executionInput;
  return stable;
}

function digestPayload({ project, request, executionInput, selection, preconditions, reconciliation, launchSpec, assignment, assignmentDigest, conflicts, operations }) {
  return {
    version: 2,
    executionInput: executionInputForDigest(executionInput),
    project,
    request,
    preconditions,
    reconciliation,
    launchSpec,
    conflicts,
    operations,
    selection: {
      profileName: selection?.profileName,
      source: selection?.source,
      harness: selection?.harness,
      command: selection?.command,
      roles: selection?.roles,
      model: selection?.model,
      arguments: selection?.arguments,
      permissions: selection?.permissions,
      reason: selection?.reason,
    },
    assignment,
    assignmentDigest,
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
  const executionInput = executionInputFor(options, deps);
  assertPlanCommand(planCommand);
  const executionOptions = executionInput.options;

  const planPreview = await planCommand(planCommandOptions(executionOptions), deps);
  const reconciliation = cloneData(planPreview.reconciliation);
  const selection = selectedProfile(reconciliation, { selectionReason: executionOptions.selectionReason });
  const launchSpec = previewLaunchSpec(reconciliation, selection, executionOptions);
  const assignment = buildAssignmentTemplate({
    request: executionOptions.request,
    context: {
      project: planPreview.project,
      stage: executionOptions.stage ?? "implementation",
      verificationCommands: executionOptions.verificationCommands,
    },
    plan: reconciliation,
    selection,
  });

  const preview = {
    command: "launch",
    executionInput,
    project: cloneData(planPreview.project),
    request: previewRequest(planPreview, executionOptions),
    selection,
    launchSpec: cloneData(launchSpec),
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

function assertSuppliedApprovalDigest(preview) {
  if (typeof preview?.approvalDigest !== "string" || !preview.approvalDigest) {
    fail("PREFLIGHT", "Missing approval digest; rerun launch preview and approve the current digest");
  }
  if (!APPROVAL_DIGEST_PATTERN.test(preview.approvalDigest)) {
    fail("PREFLIGHT", "Invalid approval digest; rerun launch preview and approve the current digest");
  }
}

function staleApprovalDigest(_supplied, expected, details = {}) {
  fail("PREFLIGHT", "Stale approval digest; rerun launch preview before executing", {
    ...(expected ? { expected } : {}),
    ...details,
  });
}

function assertApprovalDigest(preview) {
  assertSuppliedApprovalDigest(preview);
  const expected = approvalDigestFor(preview);
  if (preview.approvalDigest !== expected) {
    staleApprovalDigest(preview.approvalDigest, expected);
  }
}

function executionOptionsFromPreview(preview) {
  const executionInput = preview?.executionInput;
  if (!executionInput || executionInput.version !== EXECUTION_INPUT_VERSION || !executionInput.options || typeof executionInput.options !== "object" || Array.isArray(executionInput.options)) {
    fail("PREFLIGHT", "Launch preview is missing nonvolatile execution input; rerun launch preview before executing");
  }
  const options = cloneData(executionInput.options);
  if (Object.hasOwn(executionInput, "originSession")) options.originSession = cloneData(executionInput.originSession);
  return options;
}

async function recomputeApprovedPreview(preview, deps) {
  const fresh = await createLaunchPreview(executionOptionsFromPreview(preview), deps);
  if (preview.approvalDigest !== fresh.approvalDigest) {
    staleApprovalDigest(preview.approvalDigest, fresh.approvalDigest);
  }
  assertApprovalDigest(preview);
  return fresh;
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

function launchAgentOperation(plan = {}) {
  return list(plan.operations).find((operation) => operation.id === "agent" || operation.kind === "agent.session.start" || operation.kind === "pi.session.start") ?? null;
}

function assertNoPreexistingLaunchAgent(preview) {
  const plan = preview.reconciliation ?? {};
  const agentOperation = launchAgentOperation(plan);
  if (plan.agent?.status === "compatible" || agentOperation?.reconciliation?.status === "compatible") {
    fail("CONFLICT", "Pre-existing compatible agent cannot be reused for a newly approved launch", {
      resource: "agent",
      reason: "existing compatible agent did not receive this run assignment, environment, or bootstrap prompt",
    }, 11);
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
    selectionSource: preview.selection.source,
    selectionReason: preview.selection.reason,
    harness: preview.selection.harness,
    stateRoot,
    controlPlaneBin,
    assignmentDigest: preview.assignmentDigest,
    approvalDigest: preview.approvalDigest,
    launchArgv: cloneData(preview.launchSpec?.argv ?? []),
    originSessionId: typeof originSession === "string" ? originSession : originSession?.sessionId ?? originSession?.id ?? null,
    originHarness: typeof originSession === "string" ? null : originSession?.harness ?? null,
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

function agentOperationReport(report) {
  return operationById(report, "agent")
    ?? list(report?.operations).find((operation) => operation.kind === "agent.session.start" || operation.kind === "pi.session.start")
    ?? null;
}

function createdSelectedAgent(report) {
  return agentOperationReport(report)?.status === "created";
}

function completedLaunchWithCreatedAgent(report) {
  return report?.status !== "partial" && report?.status !== "failed" && createdSelectedAgent(report);
}

function partializeMissingCreatedAgent(report) {
  if (createdSelectedAgent(report) || report?.status === "partial" || report?.status === "failed") return report;
  return {
    ...report,
    status: "partial",
    notes: [
      ...list(report?.notes),
      "Launch did not create the selected agent for this run; use workflow reconcile before retrying.",
    ],
    error: report?.error ?? {
      name: "AgentNotCreatedError",
      message: "Selected agent was not created for this workflow run",
    },
  };
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

function isFixtureStreamJson(preview, registry) {
  return registry?.launcher?.fixture_mode === true && preview.reconciliation?.agent?.profile?.mode === "stream-json";
}

function buildFixtureRecord(directSpec, harnessVersion) {
  return {
    version: 1,
    harness: directSpec.expected.harness,
    command: directSpec.argv[0],
    // The supervisor spawns command + argv, so argv must not repeat the executable.
    argv: directSpec.argv.slice(1),
    cwd: directSpec.expected.cwd ?? null,
    env: directSpec.env,
    harnessVersion: harnessVersion ?? "0.0.0",
  };
}

function supervisorArgvFor({ controlPlaneBin, runId, workerId }) {
  const workerBin = join(dirname(controlPlaneBin), "workflow-worker.js");
  return [process.execPath, workerBin, "--run", runId, "--worker", workerId];
}

function assertStore(store) {
  if (!store || typeof store.create !== "function" || typeof store.writeAssignment !== "function" || typeof store.update !== "function") {
    fail("PREFLIGHT", "launch execution requires a run store");
  }
}

export async function executeLaunch(preview, deps = {}) {
  assertSuppliedApprovalDigest(preview);
  if (typeof deps.planCommand !== "function") assertApprovalDigest(preview);
  const fresh = await recomputeApprovedPreview(preview, deps);
  assertLaunchable(fresh);
  assertNoPreexistingLaunchAgent(fresh);
  assertStore(deps.store);

  const executionOptions = executionOptionsFromPreview(fresh);
  const stateRoot = approvedString(executionOptions.stateRoot, "stateRoot");
  const controlPlaneBin = approvedString(executionOptions.controlPlaneBin, "controlPlaneBin");
  if (deps.stateRoot !== undefined && deps.stateRoot !== stateRoot) {
    staleApprovalDigest(preview.approvalDigest, fresh.approvalDigest, { field: "stateRoot" });
  }
  if (deps.controlPlaneBin !== undefined && deps.controlPlaneBin !== controlPlaneBin) {
    staleApprovalDigest(preview.approvalDigest, fresh.approvalDigest, { field: "controlPlaneBin" });
  }

  const store = deps.store;
  const created = await store.create(runInput(fresh, {
    stateRoot,
    controlPlaneBin,
    originSession: executionOptions.originSession ?? deps.originSession,
  }));
  const run = runForHarness(created, { stateRoot, controlPlaneBin });
  await store.writeAssignment(run.id, assignmentWithExecutionHeader(run, fresh.assignment));
  await updateRun(store, run.id, {
    state: RUN_STATES.LAUNCHING,
    launchStartedAt: new Date().toISOString(),
  });

  const registry = deps.registry ?? null;
  const fixtureStreamJson = isFixtureStreamJson(fresh, registry);
  let workerId = null;
  let supervisorSpec = null;

  if (fixtureStreamJson) {
    const launchBuilder = deps.buildAgentLaunch ?? buildHarnessLaunch;
    const directInput = {
      profileName: fresh.reconciliation.agent?.profileName ?? fresh.selection.profileName,
      profile: {
        ...previewHarnessProfile(fresh.reconciliation),
        harness: fresh.selection.harness,
        command: fresh.selection.command,
      },
      sessionName: fresh.reconciliation.agent?.sessionName,
      cwd: fresh.reconciliation.agent?.worktreePath,
      run,
    };
    const directSpec = launchBuilder(directInput);
    const harness = directSpec.expected.harness;
    workerId = deps.randomUUID?.() ?? randomUUID();
    const record = buildFixtureRecord(directSpec, HARNESS_TELEMETRY_VERSIONS[harness]);
    const recordText = `${JSON.stringify(record)}\n`;
    const digest = sha256Digest(recordText);
    await store.writePrivateFile(run.id, {
      relativePath: `worker-launches/${workerId}.json`,
      text: recordText,
      exclusive: true,
      updater: (current) => ({
        fixtureMode: true,
        workerLaunches: {
          ...(current?.workerLaunches ?? {}),
          [workerId]: { digest, harness: record.harness },
        },
      }),
    });
    supervisorSpec = {
      // Not an interactive harness, so it is run as a process in the agent pane
      // rather than attached through Herdr's agent registry.
      supervisor: true,
      argv: supervisorArgvFor({ controlPlaneBin, runId: run.id, workerId }),
      env: directSpec.env,
      expected: directSpec.expected,
    };
  }

  let launchExpected = null;
  const launchBuilder = deps.buildAgentLaunch ?? buildHarnessLaunch;
  const executeStart = deps.executeStart ?? defaultExecuteStart;
  const planForStart = {
    ...cloneData(fresh.reconciliation),
    run,
  };

  try {
    const rawExecution = await executeStart(planForStart, { git: deps.git, herdr: deps.herdr }, {
      buildAgentLaunch(input) {
        if (supervisorSpec) {
          launchExpected = supervisorSpec.expected;
          return supervisorSpec;
        }
        const spec = launchBuilder(input);
        launchExpected = spec.expected;
        return spec;
      },
    });
    const execution = partializeMissingCreatedAgent(rawExecution);
    const isRunning = completedLaunchWithCreatedAgent(execution);
    const hasCreatedAgent = createdSelectedAgent(execution);
    const session = hasCreatedAgent ? sessionPatch(execution, launchExpected ?? {}) : {};
    const agentOp = agentOperationReport(execution);

    // Persist the transport identity FIRST, as a dedicated state-less merge. The interactive
    // worker's own lifecycle extension advances the run state concurrently with this launcher,
    // so the state-bearing write below can race it, hit an illegal transition, throw, and be
    // swallowed — silently dropping the identity and permanently breaking `resume`/`close`
    // (observed live: a CLI launch that completed still had transportIdentity: null). A patch
    // with no `state` field takes the store's same-state merge path, which never throws on a
    // transition, so the identity survives regardless of who wins the race. The identity is a
    // fact the moment the agent op is created — independent of whether the launch reports running.
    if (agentOp?.sessionIdentity?.sessionId) {
      await updateRun(store, run.id, { transportIdentity: cloneData(agentOp.sessionIdentity) });
    }

    await updateRun(store, run.id, {
      state: isRunning ? RUN_STATES.RUNNING : RUN_STATES.FAILED,
      harness: fresh.selection.harness,
      profileName: fresh.selection.profileName,
      launchStatus: isRunning ? (execution?.status ?? "completed") : "partial",
      launchOperations: cloneData(execution?.operations ?? []),
      launchNotes: cloneData(execution?.notes ?? []),
      ...(hasCreatedAgent ? session : {}),
      ...(!isRunning && execution?.error ? { launchError: cloneData(execution.error) } : {}),
    });

    if (!isRunning) {
      return buildLaunchReport("partial", run, execution, {
        error: cloneData(execution?.error),
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
        state: RUN_STATES.FAILED,
        harness: fresh.selection.harness,
        profileName: fresh.selection.profileName,
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
