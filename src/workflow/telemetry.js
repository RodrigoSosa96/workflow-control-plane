import { WorkflowError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEASUREMENT_AVAILABILITY = new Set(["reported", "not-reported", "unknown"]);
const MAX_SAFE_NAME_BYTES = 128;
const EVENT_FIELDS = Object.freeze({
  lifecycle: new Set(["type", "harness", "phase", "at"]),
  tool: new Set(["type", "harness", "toolName", "at"]),
  usage: new Set(["type", "harness", "tokens", "cost", "context", "at"]),
  model: new Set(["type", "harness", "model", "thinking", "at"]),
  retry: new Set(["type", "harness", "attempt", "maxAttempts", "at"]),
});
const TOKEN_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite"]);

export const TELEMETRY_HARNESSES = new Set(["pi", "claude", "codex", "opencode"]);
export const TELEMETRY_PHASES = new Set([
  "starting",
  "running",
  "tool",
  "retrying",
  "compacting",
  "settled",
  "failed",
  "unknown",
  "manual-recovery",
]);

function fail(message) {
  throw new WorkflowError("telemetry", message);
}

function assertPlainObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
}

function assertExactKeys(value, allowed, context) {
  assertPlainObject(value, context);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Unsupported telemetry ${context} field`);
  }
}

function assertSafeName(value, context) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_SAFE_NAME_BYTES || /[\0\r\n]/.test(value)) {
    fail(`Invalid telemetry ${context}`);
  }
  return value;
}

function assertHarness(value) {
  if (typeof value !== "string" || !TELEMETRY_HARNESSES.has(value)) {
    fail("Invalid telemetry harness");
  }
  return value;
}

function assertWorkerId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("Invalid telemetry worker ID");
  return value.toLowerCase();
}

function assertRunId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("Invalid telemetry run ID");
  return value.toLowerCase();
}

function assertNonNegative(value, context) {
  if (!Number.isFinite(value) || value < 0) fail(`Invalid telemetry ${context}`);
  return value;
}

function optionalTimestamp(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    fail("Invalid telemetry timestamp");
  }
  return new Date(value).toISOString();
}

function optionalThinking(value) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  return assertSafeName(value, "thinking");
}

function normalizedBase(input, allowed) {
  assertExactKeys(input, allowed, "event");
  return {
    type: input.type,
    harness: assertHarness(input.harness),
    ...(optionalTimestamp(input.at) ? { at: optionalTimestamp(input.at) } : {}),
  };
}

function normalizeTokens(value) {
  assertPlainObject(value, "telemetry tokens");
  const tokens = {};
  for (const [key, amount] of Object.entries(value)) {
    if (!TOKEN_FIELDS.has(key)) fail("Unsupported telemetry token field");
    tokens[key] = assertNonNegative(amount, "token value");
  }
  if (Object.keys(tokens).length === 0) fail("Telemetry usage must report a measurement");
  return tokens;
}

export function normalizeTelemetryEvent(input) {
  assertPlainObject(input, "telemetry event");
  if (typeof input.type !== "string" || !EVENT_FIELDS[input.type]) fail("Invalid telemetry event type");

  switch (input.type) {
    case "lifecycle": {
      const event = normalizedBase(input, EVENT_FIELDS.lifecycle);
      if (typeof input.phase !== "string" || !TELEMETRY_PHASES.has(input.phase)) fail("Invalid telemetry phase");
      return Object.freeze({ ...event, phase: input.phase });
    }
    case "tool": {
      const event = normalizedBase(input, EVENT_FIELDS.tool);
      return Object.freeze({ ...event, toolName: assertSafeName(input.toolName, "tool name") });
    }
    case "usage": {
      const event = normalizedBase(input, EVENT_FIELDS.usage);
      const normalized = { ...event };
      if (input.tokens !== undefined) normalized.tokens = normalizeTokens(input.tokens);
      if (input.cost !== undefined) normalized.cost = assertNonNegative(input.cost, "cost");
      if (input.context !== undefined) normalized.context = assertNonNegative(input.context, "context");
      if (normalized.tokens === undefined && normalized.cost === undefined && normalized.context === undefined) {
        fail("Telemetry usage must report a measurement");
      }
      return Object.freeze(normalized);
    }
    case "model": {
      const event = normalizedBase(input, EVENT_FIELDS.model);
      const normalized = { ...event };
      if (input.model !== undefined) normalized.model = assertSafeName(input.model, "model");
      if (input.thinking !== undefined) normalized.thinking = optionalThinking(input.thinking);
      if (normalized.model === undefined && normalized.thinking === undefined) fail("Telemetry model must report a measurement");
      return Object.freeze(normalized);
    }
    case "retry": {
      const event = normalizedBase(input, EVENT_FIELDS.retry);
      const attempt = assertNonNegative(input.attempt, "retry attempt");
      const maxAttempts = assertNonNegative(input.maxAttempts, "retry maximum");
      if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts) || attempt > maxAttempts) {
        fail("Invalid telemetry retry");
      }
      return Object.freeze({ ...event, attempt, maxAttempts });
    }
    default:
      fail("Invalid telemetry event type");
  }
}

function measurement(availability = "not-reported", value = null) {
  return { availability, value };
}

function usageSnapshot() {
  return {
    input: measurement(),
    output: measurement(),
    cacheRead: measurement(),
    cacheWrite: measurement(),
    cost: measurement(),
    context: measurement(),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createTelemetrySnapshot({ runId, workerId, harness, profileName, startedAt }) {
  const timestamp = optionalTimestamp(startedAt);
  if (!timestamp) fail("Telemetry snapshot startedAt is required");
  return {
    version: 1,
    runId: assertRunId(runId),
    workerId: assertWorkerId(workerId),
    harness: assertHarness(harness),
    profileName: assertSafeName(profileName, "profile name"),
    phase: "starting",
    observability: "reported",
    startedAt: timestamp,
    updatedAt: timestamp,
    turns: 0,
    tools: { count: 0, lastName: null },
    retries: { attempt: 0, maxAttempts: 0 },
    model: null,
    thinking: measurement(),
    usage: usageSnapshot(),
  };
}

export function assertTelemetrySnapshot(value) {
  assertPlainObject(value, "telemetry snapshot");
  if (value.version !== 1) fail("Invalid telemetry snapshot");
  assertRunId(value.runId);
  assertWorkerId(value.workerId);
  assertHarness(value.harness);
  assertSafeName(value.profileName, "profile name");
  if (!TELEMETRY_PHASES.has(value.phase) || !MEASUREMENT_AVAILABILITY.has(value.observability)) {
    fail("Invalid telemetry snapshot");
  }
  optionalTimestamp(value.startedAt);
  optionalTimestamp(value.updatedAt);
  if (!Number.isInteger(value.turns) || value.turns < 0) fail("Invalid telemetry snapshot");
  assertPlainObject(value.tools, "telemetry snapshot tools");
  assertNonNegative(value.tools.count, "tool count");
  if (value.tools.lastName !== null) assertSafeName(value.tools.lastName, "tool name");
  assertPlainObject(value.retries, "telemetry snapshot retries");
  assertNonNegative(value.retries.attempt, "retry attempt");
  assertNonNegative(value.retries.maxAttempts, "retry maximum");
  if (value.model !== null) assertSafeName(value.model, "model");
  assertPlainObject(value.thinking, "telemetry snapshot thinking");
  if (!MEASUREMENT_AVAILABILITY.has(value.thinking.availability)) fail("Invalid telemetry measurement");
  if (value.thinking.availability === "reported" && typeof value.thinking.value !== "boolean") {
    assertSafeName(value.thinking.value, "thinking");
  }
  if (value.thinking.availability !== "reported" && value.thinking.value !== null) fail("Invalid telemetry measurement");

  assertPlainObject(value.usage, "telemetry snapshot usage");
  for (const item of Object.values(value.usage)) {
    assertPlainObject(item, "telemetry measurement");
    if (!MEASUREMENT_AVAILABILITY.has(item.availability)) fail("Invalid telemetry measurement");
    if (item.availability === "reported") assertNonNegative(item.value, "measurement value");
    if (item.availability !== "reported" && item.value !== null) fail("Invalid telemetry measurement");
  }
  return value;
}

function updateMeasurement(current, value) {
  if (value === undefined) return current;
  return measurement("reported", Math.max(current.availability === "reported" ? current.value : 0, value));
}

export function applyTelemetryEvent(snapshot, event) {
  const current = assertTelemetrySnapshot(clone(snapshot));
  const normalized = normalizeTelemetryEvent(event);
  if (current.harness !== normalized.harness) fail("Telemetry event harness does not match worker");
  const next = clone(current);
  next.updatedAt = normalized.at ?? current.updatedAt;

  if (current.observability === "unknown") return next;

  switch (normalized.type) {
    case "lifecycle":
      next.phase = normalized.phase;
      if (normalized.phase === "unknown") next.observability = "unknown";
      if (normalized.phase === "running" && current.phase !== "running") next.turns += 1;
      break;
    case "tool":
      next.phase = "tool";
      next.tools.count += 1;
      next.tools.lastName = normalized.toolName;
      break;
    case "usage":
      for (const [name, amount] of Object.entries(normalized.tokens ?? {})) {
        next.usage[name] = updateMeasurement(next.usage[name], amount);
      }
      next.usage.cost = updateMeasurement(next.usage.cost, normalized.cost);
      next.usage.context = updateMeasurement(next.usage.context, normalized.context);
      break;
    case "model":
      if (normalized.model !== undefined) next.model = normalized.model;
      if (normalized.thinking !== undefined) next.thinking = { availability: "reported", value: normalized.thinking };
      break;
    case "retry":
      next.phase = "retrying";
      next.retries = {
        attempt: Math.max(next.retries.attempt, normalized.attempt),
        maxAttempts: Math.max(next.retries.maxAttempts, normalized.maxAttempts),
      };
      break;
    default:
      fail("Invalid telemetry event type");
  }
  return next;
}

export function publicTelemetrySnapshot(snapshot) {
  const value = assertTelemetrySnapshot(clone(snapshot));
  return {
    workerId: value.workerId,
    harness: value.harness,
    profileName: value.profileName,
    phase: value.phase,
    observability: value.observability,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    turns: value.turns,
    tools: { count: value.tools.count, lastName: value.tools.lastName },
    retries: { ...value.retries },
    model: value.model,
    thinking: { ...value.thinking },
    usage: clone(value.usage),
  };
}
