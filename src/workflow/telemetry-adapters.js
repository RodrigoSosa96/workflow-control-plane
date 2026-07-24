import { WorkflowError } from "./errors.js";
import { normalizeTelemetryEvent, TELEMETRY_HARNESSES } from "./telemetry.js";

const CAPABILITIES = Object.freeze({
  pi: Object.freeze({ model: true, usage: true, cost: true, context: true, session: false }),
  claude: Object.freeze({ model: true, usage: true, cost: false, context: false, session: false }),
  codex: Object.freeze({ model: false, usage: false, cost: false, context: false, session: false }),
  opencode: Object.freeze({ model: false, usage: false, cost: false, context: false, session: false }),
});
const SUPPORTED_VERSIONS = Object.freeze({
  pi: new Set(["0.80.10", "0.81.1"]),
  claude: new Set(["2.1.218"]),
  codex: new Set(["0.144.3"]),
  opencode: new Set(["1.0.126"]),
});
const EMPTY_CAPABILITIES = Object.freeze({ model: false, usage: false, cost: false, context: false, session: false });
const CODEX_TOOL_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

function fail(message) {
  throw new WorkflowError("telemetry", message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A recognized protocol event that reports nothing measurable. Distinct from unknown:
// ignoring records no telemetry, whereas unknown pins the worker snapshot to unknown.
const IGNORE_EVENT = Symbol("telemetry-ignore");

function unknown(harness) {
  return [normalizeTelemetryEvent({ type: "lifecycle", harness, phase: "unknown" })];
}

function lifecycle(harness, phase) {
  return normalizeTelemetryEvent({ type: "lifecycle", harness, phase });
}

function ownNumber(object, key, context) {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  if (!Number.isFinite(value) || value < 0) fail(`Invalid telemetry ${context}`);
  return value;
}

function usageEvent(harness, usage, { cost, context } = {}) {
  if (!plainObject(usage)) fail("Invalid telemetry usage");
  const tokens = {};
  const mappings = [
    ["input", "input"],
    ["input", "input_tokens"],
    ["output", "output"],
    ["output", "output_tokens"],
    ["cacheRead", "cacheRead"],
    ["cacheRead", "cache_read_input_tokens"],
    ["cacheWrite", "cacheWrite"],
    ["cacheWrite", "cache_creation_input_tokens"],
  ];
  for (const [target, source] of mappings) {
    if (tokens[target] !== undefined || !Object.hasOwn(usage, source)) continue;
    tokens[target] = ownNumber(usage, source, "usage");
  }
  const normalized = { type: "usage", harness };
  if (Object.keys(tokens).length) normalized.tokens = tokens;
  if (cost !== undefined) normalized.cost = cost;
  if (context !== undefined) normalized.context = context;
  return normalizeTelemetryEvent(normalized);
}

function piEvents(record) {
  switch (record.type) {
    // Real Pi stream events that carry no telemetry measurement; recognized but ignored.
    case "session":
    case "message_start":
    case "message_update":
    case "turn_end":
    case "agent_end":
    case "queue_update":
    case "auto_retry_end":
    case "tool_execution_update":
    case "tool_execution_end":
      return IGNORE_EVENT;
    case "agent_start":
    case "turn_start":
      return [lifecycle("pi", "running")];
    case "agent_settled":
      return [lifecycle("pi", "settled")];
    case "tool_execution_start":
      if (typeof record.toolName !== "string") fail("Invalid Pi tool event");
      return [normalizeTelemetryEvent({ type: "tool", harness: "pi", toolName: record.toolName })];
    case "compaction_start":
      return [lifecycle("pi", "compacting")];
    case "compaction_end":
      if (record.aborted === true || typeof record.willRetry !== "boolean") fail("Invalid Pi compaction event");
      return [lifecycle("pi", record.willRetry ? "retrying" : "running")];
    case "auto_retry_start":
      return [normalizeTelemetryEvent({
        type: "retry",
        harness: "pi",
        attempt: ownNumber(record, "attempt", "retry"),
        maxAttempts: ownNumber(record, "maxAttempts", "retry"),
      })];
    case "message_end": {
      // Only an assistant message reports model or usage. A user message_end echoes the
      // prompt, and an assistant message may close without measurement; both are ignored
      // rather than failed, so they cannot pin the snapshot to unknown.
      if (!plainObject(record.message) || record.message.role !== "assistant") return IGNORE_EVENT;
      const events = [];
      if (record.message.model !== undefined) {
        events.push(normalizeTelemetryEvent({ type: "model", harness: "pi", model: record.message.model }));
      }
      if (record.message.usage !== undefined) {
        const usage = record.message.usage;
        const cost = plainObject(usage?.cost) ? ownNumber(usage.cost, "total", "cost") : undefined;
        events.push(usageEvent("pi", usage, { cost }));
      }
      if (!events.length) return IGNORE_EVENT;
      return events;
    }
    case "response": {
      if (record.success !== true || !plainObject(record.data)) fail("Invalid Pi response");
      const data = record.data;
      if (record.command === "get_state") {
        if (!plainObject(data.model) || typeof data.model.id !== "string") fail("Invalid Pi state response");
        const model = { type: "model", harness: "pi", model: data.model.id };
        if (data.thinkingLevel !== undefined) model.thinking = data.thinkingLevel;
        return [normalizeTelemetryEvent(model)];
      }
      if (record.command === "get_session_stats") {
        const cost = ownNumber(data, "cost", "cost");
        const context = plainObject(data.contextUsage) ? ownNumber(data.contextUsage, "tokens", "context") : undefined;
        return [usageEvent("pi", data.tokens, { cost, context })];
      }
      fail("Invalid Pi response");
    }
    default:
      fail("Unsupported Pi telemetry event");
  }
}

function claudeEvents(record) {
  if (record.type === "assistant") {
    if (!plainObject(record.message)) fail("Invalid Claude assistant event");
    const events = [];
    if (record.message.model !== undefined) {
      events.push(normalizeTelemetryEvent({ type: "model", harness: "claude", model: record.message.model }));
    }
    if (record.message.usage !== undefined) events.push(usageEvent("claude", record.message.usage));
    if (!events.length) fail("Invalid Claude assistant event");
    return events;
  }
  if (record.type === "result" && record.subtype === "success") return [lifecycle("claude", "settled")];
  fail("Unsupported Claude telemetry event");
}

function codexEvents(record) {
  switch (record.type) {
    case "thread.started":
    case "turn.started":
      return [lifecycle("codex", "running")];
    case "turn.completed":
      return [lifecycle("codex", "settled")];
    case "turn.failed":
      return [lifecycle("codex", "failed")];
    case "item.started":
      if (!plainObject(record.item) || !CODEX_TOOL_TYPES.has(record.item.type)) fail("Invalid Codex item event");
      return [normalizeTelemetryEvent({ type: "tool", harness: "codex", toolName: record.item.type })];
    default:
      fail("Unsupported Codex telemetry event");
  }
}

function opencodeEvents(record) {
  if (record.type === "session.created") return [lifecycle("opencode", "starting")];
  if (record.type !== "session.updated" || !plainObject(record.properties) || typeof record.properties.status !== "string") {
    fail("Unsupported OpenCode telemetry event");
  }
  const phaseByStatus = { busy: "running", running: "running", idle: "settled", failed: "failed", error: "failed" };
  if (!Object.hasOwn(phaseByStatus, record.properties.status)) fail("Invalid OpenCode session status");
  return [lifecycle("opencode", phaseByStatus[record.properties.status])];
}

const PARSERS = Object.freeze({ pi: piEvents, claude: claudeEvents, codex: codexEvents, opencode: opencodeEvents });

export const HARNESS_TELEMETRY_VERSIONS = Object.freeze({
  pi: "0.81.1",
  claude: "2.1.218",
  codex: "0.144.3",
  opencode: "1.0.126",
});

export function createTelemetryAdapter({ harness, version } = {}) {
  if (typeof harness !== "string" || !TELEMETRY_HARNESSES.has(harness)) fail("Invalid telemetry harness");
  const supported = typeof version === "string" && SUPPORTED_VERSIONS[harness].has(version);
  const parser = PARSERS[harness];

  return Object.freeze({
    consume(record) {
      if (!supported || !plainObject(record) || typeof record.type !== "string") return unknown(harness);
      let events;
      try {
        events = parser(record);
      } catch (_error) {
        return unknown(harness);
      }
      // A recognized no-measurement event records nothing, without degrading the snapshot.
      if (events === IGNORE_EVENT) return [];
      if (!Array.isArray(events) || events.length === 0) return unknown(harness);
      return events;
    },
    capabilities() {
      return { ...(supported ? CAPABILITIES[harness] : EMPTY_CAPABILITIES) };
    },
  });
}
