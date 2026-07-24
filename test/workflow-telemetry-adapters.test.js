import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryAdapter } from "../src/workflow/telemetry-adapters.js";

test("normalizes only safe fields from documented structured harness events", () => {
  const pi = createTelemetryAdapter({ harness: "pi", version: "0.80.10" });
  assert.deepEqual(pi.consume({ type: "tool_execution_start", toolName: "edit", args: { path: "/private/.env" } })[0], {
    type: "tool", harness: "pi", toolName: "edit",
  });
  assert.deepEqual(pi.consume({
    type: "response",
    command: "get_state",
    success: true,
    data: {
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "high",
      sessionFile: "/private/session.jsonl",
      sessionId: "opaque-session",
    },
  }), [{ type: "model", harness: "pi", model: "gpt-5", thinking: "high" }]);
  assert.deepEqual(pi.consume({
    type: "response",
    command: "get_session_stats",
    success: true,
    data: {
      sessionFile: "/private/session.jsonl",
      tokens: { input: 12, output: 3, cacheRead: 2, cacheWrite: 1 },
      cost: 0.01,
      contextUsage: { tokens: 15, contextWindow: 100 },
    },
  })[0], {
    type: "usage",
    harness: "pi",
    tokens: { input: 12, output: 3, cacheRead: 2, cacheWrite: 1 },
    cost: 0.01,
    context: 15,
  });

  const claude = createTelemetryAdapter({ harness: "claude", version: "2.1.218" });
  assert.equal(claude.consume({
    type: "assistant",
    message: { model: "claude-sonnet", content: [{ type: "text", text: "DO-NOT-LEAK" }], usage: { input_tokens: 12, output_tokens: 3 } },
  }).at(-1).type, "usage");

  const codex = createTelemetryAdapter({ harness: "codex", version: "0.144.3" });
  assert.deepEqual(codex.consume({ type: "thread.started", thread_id: "opaque-thread" }), [{
    type: "lifecycle", harness: "codex", phase: "running",
  }]);

  const opencode = createTelemetryAdapter({ harness: "opencode", version: "1.0.126" });
  assert.deepEqual(opencode.consume({ type: "session.updated", properties: { status: "busy", title: "DO-NOT-LEAK" } }), [{
    type: "lifecycle", harness: "opencode", phase: "running",
  }]);
});

test("reports only provider capabilities for exact supported harness versions", () => {
  assert.deepEqual(createTelemetryAdapter({ harness: "pi", version: "0.80.10" }).capabilities(), {
    model: true, usage: true, cost: true, context: true, session: false,
  });
  assert.deepEqual(createTelemetryAdapter({ harness: "claude", version: "2.1.218" }).capabilities(), {
    model: true, usage: true, cost: false, context: false, session: false,
  });
});

test("fails closed for unsupported versions, record types, and aggregate OpenCode stats", () => {
  const unsupported = createTelemetryAdapter({ harness: "pi", version: "0.80.11" });
  const opencode = createTelemetryAdapter({ harness: "opencode", version: "1.0.126" });
  const expectedUnknown = [{ type: "lifecycle", harness: "pi", phase: "unknown" }];

  assert.deepEqual(unsupported.consume({ type: "agent_start" }), expectedUnknown);
  assert.deepEqual(opencode.consume({ type: "stats", total_cost: 99, sessions: ["opaque"] }), [{
    type: "lifecycle", harness: "opencode", phase: "unknown",
  }]);
  assert.deepEqual(opencode.consume({ type: "session.updated", properties: { status: "unrecognized" } }), [{
    type: "lifecycle", harness: "opencode", phase: "unknown",
  }]);
  assert.equal(unsupported.capabilities().usage, false);
});

test("never retains text, tool arguments, opaque IDs, or malformed nested fields", () => {
  const secret = "DO-NOT-LEAK-TRANSCRIPT";
  const adapters = [
    createTelemetryAdapter({ harness: "pi", version: "0.80.10" }),
    createTelemetryAdapter({ harness: "claude", version: "2.1.218" }),
    createTelemetryAdapter({ harness: "codex", version: "0.144.3" }),
    createTelemetryAdapter({ harness: "opencode", version: "1.0.126" }),
  ];
  const records = [
    { type: "tool_execution_start", toolName: "x".repeat(129), args: { command: secret } },
    { type: "assistant", message: { usage: { input_tokens: -1 }, content: secret } },
    { type: "item.started", item: [] },
    { type: "session.updated", properties: [] },
  ];

  for (let index = 0; index < adapters.length; index += 1) {
    const events = adapters[index].consume(records[index]);
    assert.deepEqual(events, [{ type: "lifecycle", harness: ["pi", "claude", "codex", "opencode"][index], phase: "unknown" }]);
    assert.equal(JSON.stringify(events).includes(secret), false);
  }

  const claude = createTelemetryAdapter({ harness: "claude", version: "2.1.218" });
  for (const message of [
    { model: "x".repeat(129), usage: { input_tokens: 1 } },
    { model: "claude", usage: { input_tokens: Number.NaN } },
  ]) {
    assert.deepEqual(claude.consume({ type: "assistant", message }), [{
      type: "lifecycle", harness: "claude", phase: "unknown",
    }]);
  }
});

test("ignores Pi protocol events that carry no measurement instead of degrading to unknown", () => {
  const pi = createTelemetryAdapter({ harness: "pi", version: "0.81.1" });

  // These events are part of Pi's real stream but report nothing measurable. Treating
  // them as unknown pins the worker snapshot to unknown for the rest of the run, so they
  // must be ignored (no telemetry event) rather than degraded.
  for (const type of [
    "session", "message_start", "message_update", "turn_end", "agent_end",
    "tool_execution_update", "tool_execution_end", "queue_update", "auto_retry_end",
  ]) {
    assert.deepEqual(pi.consume({ type }), [], `expected ${type} to be ignored`);
  }

  // A user message_end echoes the prompt and carries no measurement; only assistant
  // message_end reports model and usage. Neither may degrade the snapshot.
  assert.deepEqual(pi.consume({ type: "message_end", message: { role: "user", content: [] } }), []);
  assert.deepEqual(pi.consume({ type: "message_end", message: { role: "assistant", content: [] } }), []);
  assert.deepEqual(
    pi.consume({ type: "message_end", message: { role: "assistant", model: "kimi", usage: { input: 1, output: 2 } } }).map((event) => event.type),
    ["model", "usage"],
  );

  // Recognized measurement events still map through.
  assert.deepEqual(pi.consume({ type: "agent_start" }), [{ type: "lifecycle", harness: "pi", phase: "running" }]);
  assert.deepEqual(pi.consume({ type: "turn_start" }), [{ type: "lifecycle", harness: "pi", phase: "running" }]);
  assert.deepEqual(pi.consume({ type: "agent_settled" }), [{ type: "lifecycle", harness: "pi", phase: "settled" }]);

  // A genuinely unknown event still degrades, fail-closed.
  assert.deepEqual(pi.consume({ type: "totally_unknown_event" }), [{ type: "lifecycle", harness: "pi", phase: "unknown" }]);
});

test("supports the installed Pi version", () => {
  const pi = createTelemetryAdapter({ harness: "pi", version: "0.81.1" });
  assert.deepEqual(pi.consume({ type: "agent_start" }), [{ type: "lifecycle", harness: "pi", phase: "running" }]);
  assert.deepEqual(pi.capabilities(), { model: true, usage: true, cost: true, context: true, session: false });
});
