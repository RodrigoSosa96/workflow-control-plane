import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowWorkerObservabilityExtension, buildObservabilityLines } from "../.pi/extensions/workflow-worker-observability.ts";
import { createRunStore } from "../src/workflow/run-store.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function createFakePi() {
  const handlers = {};
  return {
    on(event, handler) {
      handlers[event] = handler;
    },
    async emit(event, payload, ctx) {
      const handler = handlers[event];
      if (handler) return await handler(payload, ctx);
    },
    get handlers() {
      return handlers;
    },
  };
}

function createContext({ mode = "tui", hasUI = true } = {}) {
  const widgetCalls = [];
  const statusCalls = [];
  return {
    mode,
    hasUI,
    ui: {
      setWidget(id, lines) {
        widgetCalls.push({ id, lines });
      },
      setStatus(id, text) {
        statusCalls.push({ id, text });
      },
      theme: { fg: (_color, text) => text },
    },
    sessionManager: { getSessionFile: () => "/tmp/session.json" },
    get widgetCalls() {
      return widgetCalls;
    },
    get statusCalls() {
      return statusCalls;
    },
  };
}

async function tempStateRoot() {
  return await mkdtemp(join(tmpdir(), "workflow-pi-obs-"));
}

async function createFixtureRun(stateRoot, runId) {
  const store = createRunStore({ stateRoot });
  return await store.create({
    runId,
    state: "planned",
    generation: 1,
    projectAlias: "fixture",
    task: "TASK-1",
    harness: "pi",
    profileName: "pi-worker",
    stateRoot,
    controlPlaneBin: "/bin/workflow.js",
  });
}

test("extension stays inert without required Pi env", async () => {
  const pi = createFakePi();
  createWorkflowWorkerObservabilityExtension({
    env: {},
  })(pi);
  assert.deepEqual(Object.keys(pi.handlers), []);
});

test("extension stays inert when harness is not pi", async () => {
  const pi = createFakePi();
  createWorkflowWorkerObservabilityExtension({
    env: {
      WORKFLOW_RUN_ID: RUN_ID,
      WORKFLOW_HARNESS: "claude",
      WORKFLOW_STATE_ROOT: "/state",
      WORKFLOW_CONTROL_PLANE_BIN: "/bin/workflow.js",
    },
  })(pi);
  assert.deepEqual(Object.keys(pi.handlers), []);
});

test("records lifecycle, tool, usage, and model through Pi events and renders redacted widget", async () => {
  const stateRoot = await tempStateRoot();
  await createFixtureRun(stateRoot, RUN_ID);

  const pi = createFakePi();
  createWorkflowWorkerObservabilityExtension({
    env: {
      WORKFLOW_RUN_ID: RUN_ID,
      WORKFLOW_HARNESS: "pi",
      WORKFLOW_STATE_ROOT: stateRoot,
      WORKFLOW_CONTROL_PLANE_BIN: "/bin/workflow.js",
      WORKFLOW_RUN_DIR: join(stateRoot, RUN_ID),
      WORKFLOW_GENERATION: "1",
    },
    // This suite is hermetic by default (mkdtemp isolation, injected clocks/runners); a real
    // `ps` spawn is opt-in only, never incidental. Without this, the extension's fallback store
    // construction uses its real, module-scope createSubprocessOwnOwnershipReader default,
    // which spawns actual `ps` on the first lock acquisition. These tests exercise a real
    // temp-dir-backed store on purpose (filesystem fidelity for telemetry/widget assertions) --
    // only the process inspection needs to be inert here.
    readOwnOwnership: async () => null,
  })(pi);

  const ctx = createContext();

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit("turn_start", { turnIndex: 1 }, ctx);
  await pi.emit("tool_execution_start", { toolName: "bash" }, ctx);
  await pi.emit("tool_execution_end", { toolCallId: "call-1" }, ctx);
  await pi.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        model: "gpt-4",
        usage: { input_tokens: 100, output_tokens: 50, cost: { total: 0.002 } },
      },
    },
    ctx,
  );
  await pi.emit("agent_settled", {}, ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);

  // Widget cleared on shutdown
  const lastWidget = ctx.widgetCalls.at(-1);
  assert.equal(lastWidget.id, "workflow-worker-observability");
  assert.equal(lastWidget.lines, undefined);

  const lastStatus = ctx.statusCalls.at(-1);
  assert.equal(lastStatus.id, "workflow-worker-observability");
  assert.equal(lastStatus.text, undefined);

  // Verify telemetry persisted
  const store = createRunStore({ stateRoot });
  const telemetry = (await import("../src/workflow/telemetry-store.js")).createTelemetryStore({ store });
  const snapshots = await telemetry.read({ runId: RUN_ID });
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.phase, "settled");
  assert.equal(snapshot.harness, "pi");
  assert.equal(snapshot.model, "gpt-4");

  // Verify widget lines did not leak private data
  const widgetPayload = JSON.stringify(ctx.widgetCalls);
  assert.equal(widgetPayload.includes(RUN_ID), false);
  assert.equal(widgetPayload.includes("gpt-4") || widgetPayload.includes("bash"), true);

  await rm(stateRoot, { recursive: true, force: true });
});

test("does not render widget in json/print mode but still records telemetry", async () => {
  const stateRoot = await tempStateRoot();
  await createFixtureRun(stateRoot, RUN_ID);

  const pi = createFakePi();
  createWorkflowWorkerObservabilityExtension({
    env: {
      WORKFLOW_RUN_ID: RUN_ID,
      WORKFLOW_HARNESS: "pi",
      WORKFLOW_STATE_ROOT: stateRoot,
      WORKFLOW_CONTROL_PLANE_BIN: "/bin/workflow.js",
      WORKFLOW_RUN_DIR: join(stateRoot, RUN_ID),
      WORKFLOW_GENERATION: "1",
    },
    // This suite is hermetic by default (mkdtemp isolation, injected clocks/runners); a real
    // `ps` spawn is opt-in only, never incidental. Without this, the extension's fallback store
    // construction uses its real, module-scope createSubprocessOwnOwnershipReader default,
    // which spawns actual `ps` on the first lock acquisition. These tests exercise a real
    // temp-dir-backed store on purpose (filesystem fidelity for telemetry/widget assertions) --
    // only the process inspection needs to be inert here.
    readOwnOwnership: async () => null,
  })(pi);

  const ctx = createContext({ mode: "json", hasUI: false });

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit("agent_settled", {}, ctx);

  assert.equal(ctx.widgetCalls.length, 0);
  assert.equal(ctx.statusCalls.length, 0);

  const store = createRunStore({ stateRoot });
  const telemetry = (await import("../src/workflow/telemetry-store.js")).createTelemetryStore({ store });
  const snapshots = await telemetry.read({ runId: RUN_ID });
  assert.equal(snapshots.length, 1);

  await rm(stateRoot, { recursive: true, force: true });
});

test("ignores non-assistant message_end without crashing", async () => {
  const stateRoot = await tempStateRoot();
  await createFixtureRun(stateRoot, RUN_ID);

  const pi = createFakePi();
  createWorkflowWorkerObservabilityExtension({
    env: {
      WORKFLOW_RUN_ID: RUN_ID,
      WORKFLOW_HARNESS: "pi",
      WORKFLOW_STATE_ROOT: stateRoot,
      WORKFLOW_CONTROL_PLANE_BIN: "/bin/workflow.js",
      WORKFLOW_RUN_DIR: join(stateRoot, RUN_ID),
      WORKFLOW_GENERATION: "1",
    },
    // This suite is hermetic by default (mkdtemp isolation, injected clocks/runners); a real
    // `ps` spawn is opt-in only, never incidental. Without this, the extension's fallback store
    // construction uses its real, module-scope createSubprocessOwnOwnershipReader default,
    // which spawns actual `ps` on the first lock acquisition. These tests exercise a real
    // temp-dir-backed store on purpose (filesystem fidelity for telemetry/widget assertions) --
    // only the process inspection needs to be inert here.
    readOwnOwnership: async () => null,
  })(pi);

  const ctx = createContext();

  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit(
    "message_end",
    {
      message: { role: "user", content: "hello" },
    },
    ctx,
  );
  await pi.emit("agent_settled", {}, ctx);

  const store = createRunStore({ stateRoot });
  const telemetry = (await import("../src/workflow/telemetry-store.js")).createTelemetryStore({ store });
  const snapshots = await telemetry.read({ runId: RUN_ID });
  const snapshot = snapshots[0];
  assert.equal(snapshot?.phase, "settled");
  assert.equal(snapshot?.model, null);

  await rm(stateRoot, { recursive: true, force: true });
});

test("widget renders measurement values, never [object Object], for tokens and cost", () => {
  const snapshot = {
    phase: "settled",
    harness: "pi",
    model: "kimi-k2.7-code",
    usage: {
      input: { availability: "reported", value: 36765 },
      output: { availability: "reported", value: 1621 },
      cost: { availability: "reported", value: 0.037 },
    },
    tools: { lastName: "bash" },
  };
  const text = buildObservabilityLines("0244f07e-1bd7-49d0-abef-2eaafbd3a288", snapshot).join("\n");
  assert.equal(text.includes("[object Object]"), false);
  assert.match(text, /Tokens: in=36765 out=1621/);
  assert.match(text, /Cost: \$0\.037/);
  assert.match(text, /settled \| pi/);
  assert.match(text, /Tool: bash/);
});

test("widget omits not-reported measurements", () => {
  const snapshot = {
    phase: "running",
    harness: "pi",
    usage: {
      input: { availability: "not-reported", value: null },
      cost: { availability: "not-reported", value: null },
    },
  };
  const text = buildObservabilityLines("run-xyz", snapshot).join("\n");
  assert.equal(text.includes("Cost"), false);
  assert.equal(text.includes("Tokens"), false);
  assert.equal(text.includes("[object Object]"), false);
});

test("widget shows starting when there is no snapshot", () => {
  assert.match(buildObservabilityLines("run12345abc", null).join("\n"), /starting \| pi/);
});

// --- Task 4: readOwnOwnership threaded into the fallback store construction ------------------
//
// Unlike the lifecycle extension, this one had no store-injection seam before this task; these
// tests add the minimal one its sibling extension already uses (store: injectedStore plus a
// fake-able createRunStore), rather than inventing a new pattern. A store stub must satisfy
// createTelemetryStore's own contract (read/writePrivateFile/appendEvent), which
// workflowWorkerObservability constructs synchronously the moment it runs.

function stubTelemetryStore() {
  return {
    async read() { return null; },
    async writePrivateFile() { return null; },
    async appendEvent() { return null; },
  };
}

// Load-bearing: verified by temporarily reverting the fallback's createRunStoreImpl call back to
// `createRunStoreImpl({ stateRoot })` (dropping readOwnOwnership), re-running this test, and
// observing it fail with `capturedArgs.readOwnOwnership` equal to `undefined` rather than a
// function; then restoring the argument and confirming the suite is green again. See the task-4
// report for the before/after run.
test("the fallback store construction receives a readOwnOwnership function", () => {
  let capturedArgs = null;
  const fakeCreateRunStore = (args) => {
    capturedArgs = args;
    return stubTelemetryStore();
  };
  const pi = createFakePi();
  createWorkflowWorkerObservabilityExtension({
    env: {
      WORKFLOW_RUN_ID: RUN_ID,
      WORKFLOW_HARNESS: "pi",
      WORKFLOW_STATE_ROOT: "/state",
      WORKFLOW_CONTROL_PLANE_BIN: "/bin/workflow.js",
    },
    createRunStore: fakeCreateRunStore,
  })(pi);
  assert.ok(capturedArgs, "createRunStore should have been called");
  assert.equal(typeof capturedArgs.readOwnOwnership, "function");
});

// This matters because every other test in this file drives the extension through a real,
// temp-directory-backed run store; if wiring readOwnOwnership had made an injected store fall
// through to createRunStoreImpl anyway, an injected store would no longer be a real bypass.
test("an injected store bypasses the fallback entirely: no createRunStore call, no reader used", () => {
  let fallbackCalled = false;
  const fakeCreateRunStore = () => {
    fallbackCalled = true;
    return stubTelemetryStore();
  };
  const pi = createFakePi();
  createWorkflowWorkerObservabilityExtension({
    env: {
      WORKFLOW_RUN_ID: RUN_ID,
      WORKFLOW_HARNESS: "pi",
      WORKFLOW_STATE_ROOT: "/state",
      WORKFLOW_CONTROL_PLANE_BIN: "/bin/workflow.js",
    },
    store: stubTelemetryStore(),
    createRunStore: fakeCreateRunStore,
  })(pi);
  assert.equal(fallbackCalled, false);
});
