import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadRegistry } from "../../../src/workflow/registry.js";
import { createRunStore } from "../../../src/workflow/run-store.js";
import { createDelegationStore } from "../../../src/workflow/delegation-store.js";
import { createDelegationReservationStore } from "../../../src/workflow/delegation-reservations.js";
import { createDelegationServices } from "../../../src/workflow/delegation-services.js";
import { createPiDelegationTransport } from "../../../src/workflow/pi-delegation-transport.js";
import { loadDelegationRole } from "../../../src/workflow/delegation-roles.js";
import { validateSubagentRequestPolicy } from "../../../src/workflow/coordinator-policy.js";
import { createDelegationWatcher } from "../../../src/workflow/delegation-watcher.js";

const PROJECTS_FILE = fileURLToPath(new URL("../../../projects.yaml", import.meta.url));
const CONTROL_PLANE_BIN = fileURLToPath(new URL("../../../bin/workflow.js", import.meta.url));
const AGENT_DIRECTORY = fileURLToPath(new URL("../../agents", import.meta.url));
const CHILD_EXTENSION_PATH = fileURLToPath(new URL("../workflow-delegation-child.ts", import.meta.url));
const PREVIEW_LIMIT = 16 * 1024;

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
  cwd: Type.String(),
  brief: Type.String(),
  task: Type.String(),
  budget: budgetSchema,
  remediationTurns: optional(Type.Integer({ minimum: 0 })),
});

const executeDelegationSchema = Type.Object({
  approvalDigest: Type.String(),
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
  return {
    generation: ensureInteger(value.generation, "reviewEvidence.generation"),
    summary: ensureString(value.summary, "reviewEvidence.summary"),
    insideFrozenBrief: value.insideFrozenBrief === true,
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
    cwd: ensureString(input.cwd, "cwd"),
    brief: ensureString(input.brief, "brief"),
    task: ensureString(input.task, "task"),
    budget: validateBudget(input.budget),
    remediationTurns: input.remediationTurns === undefined ? undefined : ensureInteger(input.remediationTurns, "remediationTurns", 0),
  };
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

function renderDelegationRecord(record) {
  return bound([
    `Delegation ${record.id}`,
    `Run: ${record.parentRunId}`,
    `Role: ${record.role}`,
    `Mode: ${record.mode}`,
    `State: ${record.state}`,
    `Generation: ${record.generation}`,
    `Result: ${record.result?.status ?? "pending"}`,
    record.result?.summary ? `Summary: ${record.result.summary}` : "",
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

function summarizeExecution(result) {
  return bound(`Workflow delegation state: ${result.state}; generation ${result.generation}.`);
}

async function processStartTick(pid) {
  const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const endCommand = text.lastIndexOf(")");
  const fields = text.slice(endCommand + 2).trim().split(/\s+/);
  return fields[19];
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
      try {
        child.unref();
        const startedAt = await processStartTick(child.pid);
        resolvePromise({ pid: String(child.pid), startedAt });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function inspectChildProcess(identity) {
  try {
    const startedAt = await processStartTick(identity.pid);
    const cwd = await fs.readlink(`/proc/${identity.pid}/cwd`);
    return {
      pid: identity.pid,
      startedAt,
      cwd,
      active: true,
    };
  } catch {
    return null;
  }
}

async function resolveCanonicalPath(value) {
  try {
    return await fs.realpath(value);
  } catch {
    return resolve(value);
  }
}

async function createLiveRuntime() {
  const registry = await loadRegistry(PROJECTS_FILE);
  const stateRoot = process.env.WORKFLOW_STATE_ROOT ?? registry?.launcher?.state_root;
  const store = createRunStore({ stateRoot });
  const delegations = createDelegationStore({ store });
  const reservations = createDelegationReservationStore({
    stateRoot,
    canonicalPath: resolveCanonicalPath,
  });
  const roles = {
    async loadDelegationRole({ name }) {
      return await loadDelegationRole({ name, agentDirectory: AGENT_DIRECTORY });
    },
  };
  const transport = createPiDelegationTransport({
    spawnChild: spawnChildProcess,
    inspectProcess: inspectChildProcess,
    stateRoot,
    controlPlaneBin: CONTROL_PLANE_BIN,
    childExtensionPath: CHILD_EXTENSION_PATH,
    agentDirectory: AGENT_DIRECTORY,
    loadDelegationRole: roles.loadDelegationRole,
  });
  const servicesByProject = new Map();

  return {
    delegations,
    async resolveServicesForRun(runId) {
      const run = await store.read(runId);
      if (!servicesByProject.has(run.projectAlias)) {
        servicesByProject.set(run.projectAlias, createDelegationServices({
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
} = {}) {
  return function workflowCoordinatorExtension(pi) {
    const approvedPreviews = new Map();
    const approvedMutations = new Map();
    let watcher = null;
    let runtimePromise = null;

    async function runtime() {
      if (resolveServicesForRun && delegations) {
        return { resolveServicesForRun, delegations };
      }
      if (!runtimePromise) runtimePromise = createLiveRuntime();
      return await runtimePromise;
    }

    async function servicesForRun(runId) {
      return await (await runtime()).resolveServicesForRun(runId);
    }

    async function findDelegation(runId, delegationId, originSessionId) {
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
      watcher = createWatcher({
        delegations: (await runtime()).delegations,
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
      });
      watcher.start();
    });

    pi.on("session_shutdown", async () => {
      watcher?.stop();
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
        const record = await findDelegation(input.runId, input.delegationId, sessionIdFromContext(ctx));
        return {
          content: [{ type: "text", text: renderDelegationRecord(record) }],
          details: {
            runId: input.runId,
            delegationId: record.id,
            role: record.role,
            mode: record.mode,
            state: record.state,
            generation: record.generation,
            result: record.result ?? null,
          },
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
        const record = await findDelegation(input.runId, input.delegationId, originSessionId);
        const approved = await confirmMutation(ctx, "Adopt Workflow delegation result?", renderDelegationRecord(record), {
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
