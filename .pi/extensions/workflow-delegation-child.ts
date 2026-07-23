import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

const CHILD_EVENT_TYPE = "workflow-delegation-child-event";
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ITEMS = 20;
const WORKFLOW_ENV_KEYS = Object.freeze([
  "WORKFLOW_RUN_ID",
  "WORKFLOW_DELEGATION_ID",
  "WORKFLOW_DELEGATION_GENERATION",
  "WORKFLOW_DELEGATION_CLAIM_TOKEN",
  "WORKFLOW_RUN_DIR",
  "WORKFLOW_STATE_ROOT",
  "WORKFLOW_CONTROL_PLANE_BIN",
]);

function StringEnum(values, options = {}) {
  return { type: "string", enum: [...values], ...options };
}

const Optional = Symbol("optional");

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

const handoffSchema = Type.Object({
  status: StringEnum(["completed", "blocked", "failed"]),
  generation: Type.Integer({ minimum: 1 }),
  summary: Type.String(),
  verification: Type.Array(Type.Object({
    command: Type.String(),
    status: Type.String(),
  }), { maxItems: MAX_ITEMS }),
  concerns: Type.Array(Type.String(), { maxItems: MAX_ITEMS }),
  nextAction: Type.String(),
});

function fail(message) {
  throw new Error(message);
}

function ensureString(value, name, limit = 4096) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${name} must be a bounded non-empty string`);
  }
  return value.trim();
}

function validateEnvironment(env) {
  const picked = Object.fromEntries(WORKFLOW_ENV_KEYS.map((key) => [key, env?.[key]]));
  try {
    const generation = Number(ensureString(picked.WORKFLOW_DELEGATION_GENERATION, "WORKFLOW_DELEGATION_GENERATION", 64));
    if (!Number.isInteger(generation) || generation < 1) fail("WORKFLOW_DELEGATION_GENERATION must be a positive integer");
    return {
      runId: ensureString(picked.WORKFLOW_RUN_ID, "WORKFLOW_RUN_ID", 128),
      delegationId: ensureString(picked.WORKFLOW_DELEGATION_ID, "WORKFLOW_DELEGATION_ID", 128),
      generation,
      runDirectory: ensureString(picked.WORKFLOW_RUN_DIR, "WORKFLOW_RUN_DIR"),
      stateRoot: ensureString(picked.WORKFLOW_STATE_ROOT, "WORKFLOW_STATE_ROOT"),
      controlPlaneBin: ensureString(picked.WORKFLOW_CONTROL_PLANE_BIN, "WORKFLOW_CONTROL_PLANE_BIN"),
      env: picked,
    };
  } catch {
    return null;
  }
}

function validateVerification(value) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail("verification must be a bounded array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`verification[${index}] must be an object`);
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== "command" && key !== "status")) fail(`verification[${index}] contains unsupported fields`);
    return {
      command: ensureString(entry.command, `verification[${index}].command`),
      status: ensureString(entry.status, `verification[${index}].status`, 128),
    };
  });
}

function validateConcerns(value) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail("concerns must be a bounded array");
  return value.map((entry, index) => ensureString(entry, `concerns[${index}]`, 1024));
}

function validateHandoffInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("delegation handoff input must be an object");
  const keys = Object.keys(input);
  if (keys.some((key) => !(key in handoffSchema.properties))) fail("delegation handoff input contains unsupported fields");
  const status = ensureString(input.status, "status", 128);
  if (!handoffSchema.properties.status.enum.includes(status)) fail("delegation handoff status is unsupported");
  if (!Number.isInteger(input.generation) || input.generation < 1) fail("generation must be a positive integer");
  const summary = ensureString(input.summary, "summary");
  const nextAction = ensureString(input.nextAction, "nextAction");
  const verification = validateVerification(input.verification);
  const concerns = validateConcerns(input.concerns);
  const text = JSON.stringify({ status, generation: input.generation, summary, verification, concerns, nextAction });
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) fail("delegation handoff input exceeds the byte limit");
  return { status, generation: input.generation, summary, verification, concerns, nextAction };
}

function eventData(type, session, extra = {}) {
  return {
    type,
    runId: session.runId,
    delegationId: session.delegationId,
    generation: session.generation,
    ...extra,
  };
}

async function defaultSubmitHandoff({ session, input, inputPath }) {
  await fs.mkdir(dirname(inputPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      session.controlPlaneBin,
      "delegation",
      "handoff",
      session.runId,
      session.delegationId,
      "--input",
      inputPath,
      "--format",
      "json",
    ], {
      cwd: session.runDirectory,
      env: session.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= 8192) return;
      stderr += String(chunk).slice(0, 8192 - stderr.length);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(stderr.trim() || `workflow delegation handoff failed with exit code ${code ?? 1}`));
    });
  });

  return { ok: true, path: inputPath };
}

export function createWorkflowDelegationChildExtension({
  env = process.env,
  submitHandoff = defaultSubmitHandoff,
} = {}) {
  return function workflowDelegationChildExtension(pi) {
    let session = null;
    let terminalSubmitted = false;

    pi.on("session_start", async () => {
      session = validateEnvironment(env);
      terminalSubmitted = false;
      if (!session) return;
      pi.appendEntry(CHILD_EVENT_TYPE, eventData("session_start", session));
    });

    pi.on("before_agent_start", async (event) => {
      if (!session) return;
      pi.appendEntry(CHILD_EVENT_TYPE, eventData("before_agent_start", session, {
        promptBytes: Buffer.byteLength(String(event?.prompt ?? ""), "utf8"),
      }));
    });

    pi.on("agent_settled", async () => {
      if (!session) return;
      pi.appendEntry(CHILD_EVENT_TYPE, eventData("agent_settled", session, {
        handoffSubmitted: terminalSubmitted,
      }));
    });

    pi.on("session_shutdown", async () => {
      if (!session) return;
      pi.appendEntry(CHILD_EVENT_TYPE, eventData("session_shutdown", session, {
        handoffSubmitted: terminalSubmitted,
      }));
    });

    pi.registerTool({
      name: "workflow_delegation_handoff",
      label: "Workflow Delegation Handoff",
      description: "Submit the terminal advisory delegation result for the current Workflow child session.",
      parameters: handoffSchema,
      async execute(_toolCallId, params) {
        if (!session) fail("Workflow delegation child session is not active");
        const input = validateHandoffInput(params);
        if (input.generation !== session.generation) fail("delegation handoff generation is stale");
        const inputPath = join(session.runDirectory, "delegations", session.delegationId, "handoff-input.json");
        await submitHandoff({ session, input, inputPath });
        terminalSubmitted = true;
        return {
          content: [{ type: "text", text: `Submitted delegation handoff for ${session.delegationId}.` }],
          details: { delegationId: session.delegationId, inputPath, status: input.status },
          terminate: true,
        };
      },
    });
  };
}

export default createWorkflowDelegationChildExtension();
