import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createProcessRunner } from "../../../src/workflow/process.js";
import { createGitAdapter } from "../../../src/workflow/git.js";
import { createHerdrAdapter } from "../../../src/workflow/herdr.js";
import { ensureCodexWorkerHooks } from "../../../src/workflow/codex-hooks.js";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { loadRegistry } from "../../../src/workflow/registry.js";
import { createRunStore } from "../../../src/workflow/run-store.js";
import { createDelegationStore } from "../../../src/workflow/delegation-store.js";
import { createDelegationReservationStore } from "../../../src/workflow/delegation-reservations.js";
import { createDelegationServices } from "../../../src/workflow/delegation-services.js";
import { createPiDelegationTransport } from "../../../src/workflow/pi-delegation-transport.js";
import { loadDelegationRole } from "../../../src/workflow/delegation-roles.js";
import { inspectExactProcessByPid } from "../../../src/workflow/process-observation.js";
import { spawnPsStatus, createSubprocessOwnOwnershipReader } from "../../../src/workflow/ownership.js";
import { validateSubagentRequestPolicy } from "../../../src/workflow/coordinator-policy.js";
import { createDelegationWatcher } from "../../../src/workflow/delegation-watcher.js";
import { createWorkerWatcher } from "../../../src/workflow/worker-watcher.js";
import { readEvents } from "../../../src/workflow/events-bus.js";
import { launchCommand } from "../../../src/workflow/commands.js";
import { lookupExecutable, resolveWorkflowProjectsFile } from "../../../src/workflow/runtime-config.js";

const PROJECTS_FILE = fileURLToPath(new URL("../../../projects.yaml", import.meta.url));
const CONTROL_PLANE_BIN = fileURLToPath(new URL("../../../bin/workflow.js", import.meta.url));
const AGENT_DIRECTORY = fileURLToPath(new URL("../../agents", import.meta.url));
const CHILD_EXTENSION_PATH = fileURLToPath(new URL("../workflow-delegation-child.ts", import.meta.url));
const PREVIEW_LIMIT = 16 * 1024;

// One reader per process, built at module scope -- same shape as workflow-worker-lifecycle.ts's
// and workflow-worker-observability.ts's identical defaults. Constructing it spawns nothing; the
// first mutex this session takes pays one `ps`, and createOwnOwnershipReader's memoization (which
// caches a null outcome too) means every later lock and gate in the session is free. That ratio
// is the reason a `ps` spawn inside a long-lived extension is acceptable: this coordinator holds
// the run lock across worktree creation, the Herdr calls and agent startup, the longest hold in
// the system, and residue from an interrupted launch is exactly what `workflow unlock` exists to
// recover.
const defaultReadOwnOwnership = createSubprocessOwnOwnershipReader();

function StringEnum(values, options = {}) {
  return { type: "string", enum: [...values], ...options };
}

const Optional = Symbol("optional");

function optional(schema) {
  return { ...schema, [Optional]: true };
}

const Type = {
  String(options = {}) {
    return { type: "string", ...options };
  },
  Integer(options = {}) {
    return { type: "integer", ...options };
  },
  Boolean(options = {}) {
    return { type: "boolean", ...options };
  },
  Array(items, options = {}) {
    return { type: "array", items, ...options };
  },
  Object(properties, options = {}) {
    const required = Object.entries(properties)
      .filter(([, schema]) => schema?.[Optional] !== true)
      .map(([key]) => key);
    const normalized = Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => {
        if (!schema || typeof schema !== "object") return [key, schema];
        const { [Optional]: _optional, ...clean } = schema;
        return [key, clean];
      }),
    );
    return {
      type: "object",
      properties: normalized,
      required,
      additionalProperties: false,
      ...options,
    };
  },
};

const budgetSchema = Type.Object({
  maxRuntimeMs: Type.Integer({ minimum: 1 }),
  concurrency: Type.Integer({ minimum: 1 }),
  maxTurns: Type.Integer({ minimum: 1 }),
  maxToolCalls: Type.Integer({ minimum: 1 }),
});

const reviewEvidenceSchema = Type.Object({
  generation: Type.Integer({ minimum: 1 }),
  summary: Type.String(),
  insideFrozenBrief: Type.Boolean(),
});

const prepareDelegationSchema = Type.Object({
  runId: Type.String(),
  role: Type.String(),
  mode: StringEnum(["foreground", "background"]),
  cwd: optional(Type.String()),
  brief: Type.String(),
  task: Type.String(),
  budget: budgetSchema,
  remediationTurns: optional(Type.Integer({ minimum: 0 })),
});

const executeDelegationSchema = Type.Object({
  approvalDigest: Type.String(),
});

const prepareLaunchSchema = Type.Object({
  projectAlias: Type.String({ minLength: 1, maxLength: 128 }),
  task: Type.String({ minLength: 1, maxLength: 128 }),
  request: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  feature: optional(Type.String({ minLength: 1, maxLength: 256 })),
  repositories: optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 8 })),
  tickets: optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
  agentProfile: optional(Type.String({ minLength: 1, maxLength: 128 })),
  selectionReason: optional(Type.String({ minLength: 1, maxLength: 4096 })),
});

const executeLaunchSchema = Type.Object({
  approvalDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
});

const delegationSelectorSchema = Type.Object({
  runId: Type.String(),
  delegationId: Type.String(),
});

const remediateDelegationSchema = Type.Object({
  runId: Type.String(),
  delegationId: Type.String(),
  expectedGeneration: Type.Integer({ minimum: 1 }),
  reviewEvidence: reviewEvidenceSchema,
  prompt: Type.String(),
});

function fail(message) {
  throw new Error(message);
}

function ensureString(value, name, limit = 64 * 1024) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${name} must be a bounded non-empty string`);
  }
  return value.trim();
}

function ensureInteger(value, name, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) fail(`${name} must be an integer >= ${minimum}`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function approvalDigestFor(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex")}`;
}

function bound(text, limit = PREVIEW_LIMIT) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const suffix = "\n...[preview truncated]";
  return value.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}

function requireUI(ctx, action) {
  if (!ctx?.hasUI) fail(`${action} requires UI confirmation`);
}

function sessionIdFromContext(ctx) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  return ensureString(sessionId, "session ID", 512);
}

function validateBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("budget must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !(key in budgetSchema.properties))) fail("budget contains unsupported fields");
  return {
    maxRuntimeMs: ensureInteger(value.maxRuntimeMs, "budget.maxRuntimeMs"),
    concurrency: ensureInteger(value.concurrency, "budget.concurrency"),
    maxTurns: ensureInteger(value.maxTurns, "budget.maxTurns"),
    maxToolCalls: ensureInteger(value.maxToolCalls, "budget.maxToolCalls"),
  };
}

function validateReviewEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("reviewEvidence must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !(key in reviewEvidenceSchema.properties))) fail("reviewEvidence contains unsupported fields");
  if (value.insideFrozenBrief !== true) fail("reviewEvidence.insideFrozenBrief must be true");
  return {
    generation: ensureInteger(value.generation, "reviewEvidence.generation"),
    summary: ensureString(value.summary, "reviewEvidence.summary"),
    insideFrozenBrief: true,
  };
}

function validatePrepareInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("delegation input must be an object");
  const keys = Object.keys(input);
  if (keys.some((key) => !(key in prepareDelegationSchema.properties))) fail("delegation input contains unsupported fields");
  return {
    runId: ensureString(input.runId, "runId", 128),
    role: ensureString(input.role, "role", 128),
    mode: ensureString(input.mode, "mode", 32),
    ...(input.cwd === undefined ? {} : { cwd: ensureString(input.cwd, "cwd") }),
    brief: ensureString(input.brief, "brief"),
    task: ensureString(input.task, "task"),
    budget: validateBudget(input.budget),
    remediationTurns: input.remediationTurns === undefined ? undefined : ensureInteger(input.remediationTurns, "remediationTurns", 0),
  };
}

function validateStringList(value, name, { maximumItems, maximumLength }) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) fail(`${name} must be a bounded non-empty list`);
  const normalized = value.map((entry) => ensureString(entry, name, maximumLength));
  if (new Set(normalized).size !== normalized.length) fail(`${name} must not contain duplicates`);
  return normalized;
}

function validatePrepareLaunchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("launch input must be an object");
  const keys = Object.keys(input);
  if (keys.some((key) => !(key in prepareLaunchSchema.properties))) fail("launch input contains unsupported fields");
  return {
    projectAlias: ensureString(input.projectAlias, "projectAlias", 128),
    task: ensureString(input.task, "task", 128),
    request: ensureString(input.request, "request", 64 * 1024),
    ...(input.feature === undefined ? {} : { feature: ensureString(input.feature, "feature", 256) }),
    ...(input.repositories === undefined ? {} : { repositories: validateStringList(input.repositories, "repositories", { maximumItems: 8, maximumLength: 128 }) }),
    ...(input.tickets === undefined ? {} : { tickets: validateStringList(input.tickets, "tickets", { maximumItems: 32, maximumLength: 128 }) }),
    ...(input.agentProfile === undefined ? {} : { agentProfile: ensureString(input.agentProfile, "agentProfile", 128) }),
    ...(input.selectionReason === undefined ? {} : { selectionReason: ensureString(input.selectionReason, "selectionReason", 4096) }),
  };
}

function validateLaunchApproval(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "approvalDigest")) {
    fail("launch approval must contain only approvalDigest");
  }
  const approvalDigest = ensureString(input.approvalDigest, "approvalDigest", 128);
  if (!/^sha256:[0-9a-f]{64}$/u.test(approvalDigest)) fail("approvalDigest must be a sha256 digest");
  return { approvalDigest };
}

function validateSelector(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("delegation selector must be an object");
  const keys = Object.keys(input);
  if (keys.some((key) => !(key in delegationSelectorSchema.properties))) fail("delegation selector contains unsupported fields");
  return {
    runId: ensureString(input.runId, "runId", 128),
    delegationId: ensureString(input.delegationId, "delegationId", 128),
  };
}

function validateRemediationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("delegation remediation input must be an object");
  const keys = Object.keys(input);
  if (keys.some((key) => !(key in remediateDelegationSchema.properties))) fail("delegation remediation input contains unsupported fields");
  return {
    runId: ensureString(input.runId, "runId", 128),
    delegationId: ensureString(input.delegationId, "delegationId", 128),
    expectedGeneration: ensureInteger(input.expectedGeneration, "expectedGeneration"),
    reviewEvidence: validateReviewEvidence(input.reviewEvidence),
    prompt: ensureString(input.prompt, "prompt"),
  };
}

function renderPreview(preview) {
  return bound([
    `Run: ${preview.runId}`,
    `Role: ${preview.role}`,
    `Mode: ${preview.mode}`,
    `Cwd: ${preview.cwd}`,
    `Budget: runtime ${preview.budget.maxRuntimeMs}ms, concurrency ${preview.budget.concurrency}, turns ${preview.budget.maxTurns}, tools ${preview.budget.maxToolCalls}`,
    `Tools: ${preview.tools.join(", ")}`,
    `Task digest: ${preview.taskDigest}`,
    `Brief digest: ${preview.briefDigest}`,
    `Approval digest: ${preview.approvalDigest}`,
  ].join("\n"));
}

function advisoryDetailsForRecord(record) {
  return {
    runId: record.parentRunId,
    delegationId: record.id,
    role: record.role,
    generation: record.generation,
    state: record.state,
    summary: record.result?.summary ?? null,
    verification: structuredClone(record.result?.verification ?? []),
    concerns: structuredClone(record.result?.concerns ?? []),
    nextAction: record.result?.nextAction ?? null,
  };
}

function renderDelegationRecord(details) {
  return bound([
    `Delegation ${details.delegationId}`,
    `Run: ${details.runId}`,
    `Role: ${details.role}`,
    `State: ${details.state}`,
    `Generation: ${details.generation}`,
    details.summary ? `Summary: ${details.summary}` : "",
    details.nextAction ? `Next action: ${details.nextAction}` : "",
  ].filter(Boolean).join("\n"));
}

function renderRemediationPreview(input) {
  return bound([
    `Remediate delegation ${input.delegationId}`,
    `Run: ${input.runId}`,
    `Expected generation: ${input.expectedGeneration}`,
    `Review summary: ${input.reviewEvidence.summary}`,
    `Inside frozen brief: ${String(input.reviewEvidence.insideFrozenBrief)}`,
  ].join("\n"));
}

function renderDeliveredResult(result) {
  return bound([
    `Workflow delegation result: ${result.delegationId}`,
    `Role: ${result.role}`,
    `State: ${result.state}`,
    `Generation: ${result.generation}`,
    `Summary: ${result.summary}`,
    `Next action: ${result.nextAction}`,
  ].join("\n"));
}

function renderNotice(notice) {
  return bound([
    `Workflow delegation notice: ${notice.delegationId}`,
    `State: ${notice.state}`,
    `Reason: ${notice.reason}`,
  ].join("\n"));
}

function renderLaunchPreview(preview) {
  const identity = preview?.reconciliation?.identity ?? {};
  const selection = preview?.selection ?? {};
  return bound([
    `Proyecto: ${identity.projectAlias ?? "unspecified"}`,
    `Tarea: ${identity.task ?? "unspecified"}`,
    `Agente: ${selection.profileName ?? "unspecified"}`,
    `Harness: ${selection.harness ?? "unspecified"}`,
    `Aprobación: ${preview?.approvalDigest ?? "missing"}`,
    preview?.assignment ? `Asignación:\n${preview.assignment}` : "",
  ].filter(Boolean).join("\n"));
}

function launchDetailsForReport(report) {
  return {
    status: typeof report?.status === "string" ? report.status : "unknown",
    runId: typeof report?.runId === "string" ? report.runId : null,
    recoveryCommand: typeof report?.recoveryCommand === "string" ? report.recoveryCommand : null,
  };
}

function renderLaunchReport(report) {
  return bound([
    `Workflow launch: ${report.status}`,
    report.runId ? `Run: ${report.runId}` : "",
    report.recoveryCommand ? `Recuperación: ${report.recoveryCommand}` : "",
  ].filter(Boolean).join("\n"));
}

function renderWorkerEvent(event) {
  const origin = event.originSessionId ? "Un worker que lanzaste" : "Un worker";
  const stateLine = event.resultStatus
    ? `${event.runState} (${event.resultStatus})`
    : event.runState;
  return bound([
    `${origin} terminó: ${event.runId}`,
    `Estado: ${stateLine}`,
    event.resultSummary ? `Resumen: ${event.resultSummary}` : "",
    `Podés ver el resultado con: workflow result ${event.runId}`,
  ].filter(Boolean).join("\n"));
}

function summarizeExecution(result) {
  return bound(`Workflow delegation state: ${result.state}; generation ${result.generation}.`);
}

async function inspectCoordinatorPid(pid) {
  return await inspectExactProcessByPid(pid, {
    runProcess: spawnPsStatus,
    readCwd: async (path) => await fs.readlink(path),
  });
}

async function spawnChildProcess({ command, argv, cwd, env }) {
  return await new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(command, argv, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", reject);
    child.once("spawn", async () => {
      child.unref();
      try {
        const inspection = await inspectCoordinatorPid(child.pid);
        if (!inspection) {
          resolvePromise({ outcome: "spawned-but-unverified" });
          return;
        }
        resolvePromise({ pid: String(child.pid), startedAt: inspection.startedAt });
      } catch {
        resolvePromise({ outcome: "spawned-but-unverified" });
      }
    });
  });
}

async function inspectChildProcess(identity) {
  return await inspectCoordinatorPid(identity.pid);
}

async function resolveCanonicalPath(value) {
  try {
    return await fs.realpath(value);
  } catch {
    return resolve(value);
  }
}

export async function createWorkflowCoordinatorRuntime({
  env = process.env,
  projectsFile = resolveWorkflowProjectsFile({ env, defaultPath: PROJECTS_FILE }),
  loadRegistryImpl = loadRegistry,
  createRunStoreImpl = createRunStore,
  createDelegationStoreImpl = createDelegationStore,
  createReservationStoreImpl = createDelegationReservationStore,
  createDelegationServicesImpl = createDelegationServices,
  createTransportImpl = createPiDelegationTransport,
  loadDelegationRoleImpl = loadDelegationRole,
  lookupExecutableImpl = lookupExecutable,
  createLaunchCommandImpl = launchCommand,
  createProcessRunnerImpl = createProcessRunner,
  createGitAdapterImpl = createGitAdapter,
  createHerdrAdapterImpl = createHerdrAdapter,
  ensureCodexWorkerHooksImpl = ensureCodexWorkerHooks,
  canonicalPath = resolveCanonicalPath,
  spawnChild = spawnChildProcess,
  inspectProcess = inspectChildProcess,
  controlPlaneBin = CONTROL_PLANE_BIN,
  agentDirectory = AGENT_DIRECTORY,
  childExtensionPath = CHILD_EXTENSION_PATH,
  readOwnOwnership = defaultReadOwnOwnership,
} = {}) {
  const registry = await loadRegistryImpl(projectsFile);
  const stateRoot = env.WORKFLOW_STATE_ROOT ?? registry?.launcher?.state_root;
  const piCommand = await lookupExecutableImpl("pi", { env });
  if (typeof piCommand !== "string" || !piCommand || !isAbsolute(piCommand)) {
    fail("Pi executable must resolve to an absolute path for delegation");
  }

  // Bounded diagnostics for channels that must never throw into a poll loop or a
  // listing: crash residue that list() now skips, and watcher poll failures.
  const diagnostics: string[] = [];
  const noteDiagnostic = (scope: string, detail: string) => {
    if (diagnostics.length >= 50) diagnostics.shift();
    diagnostics.push(`${scope}: ${String(detail).slice(0, 300)}`);
  };
  const store = createRunStoreImpl({
    stateRoot,
    onListProblem: (problem: { runId?: string; message?: string }) => {
      noteDiagnostic("run-store.list", `skipped ${problem?.runId ?? "unknown"}: ${problem?.message ?? "unreadable"}`);
    },
    readOwnOwnership,
  });
  const runner = createProcessRunnerImpl();
  const git = createGitAdapterImpl({ runner });
  const herdr = createHerdrAdapterImpl({ runner });
  const delegations = createDelegationStoreImpl({ store });
  const reservations = createReservationStoreImpl({
    stateRoot,
    canonicalPath,
    readOwnOwnership,
  });
  const roles = {
    async loadDelegationRole({ name }) {
      return await loadDelegationRoleImpl({ name, agentDirectory });
    },
  };
  const transport = createTransportImpl({
    piCommand,
    spawnChild,
    inspectProcess,
    stateRoot,
    controlPlaneBin,
    childExtensionPath,
    agentDirectory,
    loadDelegationRole: roles.loadDelegationRole,
  });
  const servicesByProject = new Map();

  return {
    delegations,
    stateRoot,
    diagnostics,
    noteDiagnostic,
    async createLaunchCommand(options) {
      return await createLaunchCommandImpl({
        ...options,
        registryPath: projectsFile,
        stateRoot,
        controlPlaneBin,
      }, {
        registry,
        stateRoot,
        controlPlaneBin,
        git,
        herdr,
        ensureCodexWorkerHooks: ensureCodexWorkerHooksImpl,
      });
    },
    async resolveServicesForRun(runId) {
      const run = await store.read(runId);
      if (!servicesByProject.has(run.projectAlias)) {
        servicesByProject.set(run.projectAlias, createDelegationServicesImpl({
          registry,
          projectAlias: run.projectAlias,
          runStore: store,
          delegations,
          reservations,
          transport,
          roles,
        }));
      }
      return servicesByProject.get(run.projectAlias);
    },
  };
}

export function createWorkflowCoordinatorExtension({
  resolveServicesForRun,
  delegations,
  getPreparedSubagentContext = async () => undefined,
  createWatcher = createDelegationWatcher,
  createWorkerWatcherImpl = createWorkerWatcher,
  createLaunchCommand,
  createRuntime = createWorkflowCoordinatorRuntime,
} = {}) {
  return function workflowCoordinatorExtension(pi) {
    const approvedPreviews = new Map();
    const approvedLaunches = new Map();
    const approvedMutations = new Map();
    let watcher = null;
    let workerWatcher = null;
    let runtimePromise = null;

    async function runtime() {
      if (resolveServicesForRun && delegations) {
        return { resolveServicesForRun, delegations };
      }
      if (!runtimePromise) runtimePromise = createRuntime();
      return await runtimePromise;
    }

    async function servicesForRun(runId) {
      return await (await runtime()).resolveServicesForRun(runId);
    }

    async function launchCommandForSession(options) {
      if (typeof createLaunchCommand === "function") return await createLaunchCommand(options);
      return await (await runtime()).createLaunchCommand(options);
    }

    async function findDelegation(runId, delegationId, { originSessionId } = {}) {
      const records = await (await runtime()).delegations.list(originSessionId ? { originSessionId } : {});
      const record = records.find((entry) => entry.parentRunId === runId && entry.id === delegationId);
      if (!record) fail("Delegation was not found");
      return record;
    }

    async function confirmMutation(ctx, title, body, payload) {
      requireUI(ctx, title);
      const approvalDigest = approvalDigestFor(payload);
      approvedMutations.set(approvalDigest, payload);
      const confirmed = await ctx.ui.confirm(title, body);
      if (!confirmed) {
        approvedMutations.delete(approvalDigest);
        return null;
      }
      const approved = approvedMutations.get(approvalDigest);
      approvedMutations.delete(approvalDigest);
      return approved;
    }

    pi.on("session_start", async (_event, ctx) => {
      const sessionId = sessionIdFromContext(ctx);
      const rt = await runtime();
      watcher = createWatcher({
        delegations: rt.delegations,
        originSessionId: sessionId,
        async onResult(result) {
          pi.sendMessage({
            customType: "workflow-delegation-result",
            content: renderDeliveredResult(result),
            details: result,
            display: true,
          }, {
            deliverAs: "followUp",
            triggerTurn: ctx.isIdle(),
          });
        },
        async onNotice(notice) {
          pi.sendMessage({
            customType: "workflow-delegation-notice",
            content: renderNotice(notice),
            details: notice,
            display: true,
          }, {
            deliverAs: "followUp",
            triggerTurn: false,
          });
        },
        onError(error) {
          rt.noteDiagnostic("delegation-watcher", error?.message ?? String(error));
        },
      });
      watcher.start();

      if (rt.stateRoot) {
        const { nextByte: initialByte } = await readEvents({ stateRoot: rt.stateRoot, fromByte: 0 });
        workerWatcher = createWorkerWatcherImpl({
          stateRoot: rt.stateRoot,
          originSessionId: sessionId,
          initialByte,
          async onEvent(event) {
            pi.sendMessage({
              customType: "workflow-worker-result",
              content: renderWorkerEvent(event),
              details: event,
              display: true,
            }, {
              deliverAs: "followUp",
              triggerTurn: ctx.isIdle(),
            });
          },
          onError(error) {
            rt.noteDiagnostic("worker-watcher", error?.message ?? String(error));
          },
        });
        workerWatcher.start();
      }
    });

    pi.on("session_shutdown", async () => {
      watcher?.stop();
      workerWatcher?.stop();
      approvedPreviews.clear();
      approvedLaunches.clear();
      approvedMutations.clear();
    });

    pi.on("tool_call", async (event, ctx) => {
      if (event?.toolName !== "subagent") return undefined;
      const preparedContext = await getPreparedSubagentContext(event, ctx);
      const accepted = validateSubagentRequestPolicy({
        request: event.input,
        prepared: preparedContext?.prepared,
        policy: preparedContext?.policy,
        reservation: preparedContext?.reservation,
      });
      if (accepted.allowed === true) return undefined;
      return { block: true, reason: accepted.reason };
    });

    pi.registerTool({
      name: "workflow_prepare_launch",
      label: "Workflow Prepare Launch",
      description: "Render and approve a session-bound external workflow launch preview.",
      parameters: prepareLaunchSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        requireUI(ctx, "workflow_prepare_launch");
        const input = validatePrepareLaunchInput(params);
        const originSession = { harness: "pi", sessionId: sessionIdFromContext(ctx) };
        const command = await launchCommandForSession({ ...input, originSession });
        const preview = command?.preview;
        const approvalDigest = ensureString(preview?.approvalDigest, "launch approvalDigest", 128);
        const approved = await ctx.ui.confirm("Approve Workflow launch preview?", renderLaunchPreview(preview));
        if (!approved) {
          return {
            content: [{ type: "text", text: "Workflow launch preview was not approved." }],
            details: { approved: false, approvalDigest },
          };
        }
        approvedLaunches.set(approvalDigest, { command, preview, originSession });
        return {
          content: [{ type: "text", text: `Approved Workflow launch preview ${approvalDigest}.` }],
          details: { approved: true, approvalDigest, preview },
        };
      },
    });

    pi.registerTool({
      name: "workflow_execute_launch",
      label: "Workflow Execute Launch",
      description: "Execute only a previously approved session-bound workflow launch preview.",
      parameters: executeLaunchSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        requireUI(ctx, "workflow_execute_launch");
        const { approvalDigest } = validateLaunchApproval(params);
        const prepared = approvedLaunches.get(approvalDigest);
        if (!prepared) fail("Approved Workflow launch preview is missing or stale");
        if (sessionIdFromContext(ctx) !== prepared.originSession.sessionId) {
          fail("Approved Workflow launch preview belongs to a different Pi session");
        }
        const approved = await confirmMutation(ctx, "Execute Workflow launch?", renderLaunchPreview(prepared.preview), {
          approvalDigest,
          preview: prepared.preview,
          originSession: prepared.originSession,
        });
        if (!approved) {
          return {
            content: [{ type: "text", text: "Workflow launch was cancelled." }],
            details: { approved: false, approvalDigest },
          };
        }
        approvedLaunches.delete(approvalDigest);
        const report = await prepared.command.execute({ approvalDigest });
        const details = launchDetailsForReport(report);
        return {
          content: [{ type: "text", text: renderLaunchReport(details) }],
          details,
        };
      },
    });

    pi.registerTool({
      name: "workflow_prepare_delegation",
      label: "Workflow Prepare Delegation",
      description: "Render and approve a governed delegation preview for the current Workflow coordinator session.",
      parameters: prepareDelegationSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        requireUI(ctx, "workflow_prepare_delegation");
        const input = validatePrepareInput(params);
        const preview = await (await servicesForRun(input.runId)).createPreview({
          runId: input.runId,
          input: {
            ...input,
            originSessionId: sessionIdFromContext(ctx),
          },
        });
        const previewText = renderPreview(preview);
        const approved = await ctx.ui.confirm("Approve Workflow delegation preview?", previewText);
        if (!approved) {
          return {
            content: [{ type: "text", text: "Delegation preview was not approved." }],
            details: { approved: false, approvalDigest: preview.approvalDigest },
          };
        }
        approvedPreviews.set(preview.approvalDigest, preview);
        return {
          content: [{ type: "text", text: `Approved Workflow delegation preview ${preview.approvalDigest}.` }],
          details: { approved: true, approvalDigest: preview.approvalDigest, preview },
        };
      },
    });

    pi.registerTool({
      name: "workflow_execute_delegation",
      label: "Workflow Execute Delegation",
      description: "Execute only a previously approved in-memory Workflow delegation preview.",
      parameters: executeDelegationSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        requireUI(ctx, "workflow_execute_delegation");
        const approvalDigest = ensureString(params?.approvalDigest, "approvalDigest", 128);
        const preview = approvedPreviews.get(approvalDigest);
        if (!preview) fail("Approved delegation preview is missing or stale");
        const approved = await confirmMutation(ctx, "Execute Workflow delegation?", renderPreview(preview), {
          approvalDigest,
          preview,
        });
        if (!approved) {
          return {
            content: [{ type: "text", text: "Delegation execution was cancelled." }],
            details: { approved: false, approvalDigest },
          };
        }
        const result = await (await servicesForRun(preview.runId)).executeApproved(approved);
        approvedPreviews.delete(approvalDigest);
        return {
          content: [{ type: "text", text: summarizeExecution(result) }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: "workflow_delegation_result",
      label: "Workflow Delegation Result",
      description: "Read the bounded advisory state for a Workflow delegation result without mutating it.",
      parameters: delegationSelectorSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const input = validateSelector(params);
        const record = await findDelegation(input.runId, input.delegationId, { originSessionId: sessionIdFromContext(ctx) });
        const advisory = advisoryDetailsForRecord(record);
        return {
          content: [{ type: "text", text: renderDelegationRecord(advisory) }],
          details: advisory,
        };
      },
    });

    pi.registerTool({
      name: "workflow_adopt_delegation_result",
      label: "Workflow Adopt Delegation Result",
      description: "Explicitly adopt a pending advisory result into the current exact coordinator session.",
      parameters: delegationSelectorSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const input = validateSelector(params);
        const originSessionId = sessionIdFromContext(ctx);
        const record = await findDelegation(input.runId, input.delegationId);
        const approved = await confirmMutation(ctx, "Adopt Workflow delegation result?", renderDelegationRecord(advisoryDetailsForRecord(record)), {
          runId: input.runId,
          delegationId: input.delegationId,
          originSessionId,
        });
        if (!approved) {
          return {
            content: [{ type: "text", text: "Delegation adoption was cancelled." }],
            details: { approved: false, delegationId: input.delegationId },
          };
        }
        const adopted = await (await runtime()).delegations.adoptResult(approved);
        return {
          content: [{ type: "text", text: `Adopted advisory delegation result ${adopted.id}.` }],
          details: adopted,
        };
      },
    });

    pi.registerTool({
      name: "workflow_remediate_delegation",
      label: "Workflow Remediate Delegation",
      description: "Resume an exact Workflow delegation session for one approved remediation turn.",
      parameters: remediateDelegationSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const input = validateRemediationInput(params);
        const approved = await confirmMutation(ctx, "Remediate Workflow delegation?", renderRemediationPreview(input), input);
        if (!approved) {
          return {
            content: [{ type: "text", text: "Delegation remediation was cancelled." }],
            details: { approved: false, delegationId: input.delegationId },
          };
        }
        const result = await (await servicesForRun(input.runId)).beginRemediation(approved);
        return {
          content: [{ type: "text", text: summarizeExecution(result) }],
          details: result,
        };
      },
    });
  };
}

export default createWorkflowCoordinatorExtension();
