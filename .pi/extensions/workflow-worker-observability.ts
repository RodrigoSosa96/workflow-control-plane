import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunStore } from "../../src/workflow/run-store.js";
import { createTelemetryStore } from "../../src/workflow/telemetry-store.js";
import { createTelemetryAdapter } from "../../src/workflow/telemetry-adapters.js";
import { publicTelemetrySnapshot } from "../../src/workflow/telemetry.js";

const REQUIRED_ENV = Object.freeze([
  "WORKFLOW_RUN_ID",
  "WORKFLOW_RUN_DIR",
  "WORKFLOW_GENERATION",
  "WORKFLOW_HARNESS",
  "WORKFLOW_STATE_ROOT",
  "WORKFLOW_CONTROL_PLANE_BIN",
]);

function readEnv(source: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const key of REQUIRED_ENV) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

export function createWorkflowWorkerObservabilityExtension({
  env = process.env as Record<string, string | undefined>,
} = {}) {
  const boundEnv = readEnv(env);
  if (!boundEnv.WORKFLOW_RUN_ID || boundEnv.WORKFLOW_HARNESS !== "pi") {
    return function inertExtension(_pi: ExtensionAPI) {
      // No-op when required env is missing or harness is not pi
    };
  }

  const stateRoot = boundEnv.WORKFLOW_STATE_ROOT;
  const runId = boundEnv.WORKFLOW_RUN_ID;

  return function workflowWorkerObservability(pi: ExtensionAPI) {
    const store = createRunStore({ stateRoot });
    const telemetry = createTelemetryStore({ store });
    const adapter = createTelemetryAdapter({ harness: "pi", version: "0.81.1" });

    async function updateWidget(ctx: any) {
      const snapshots = await telemetry.read({ runId });
      const raw = snapshots[0] ?? null;
      const lines: string[] = [];
      if (raw) {
        const snapshot = publicTelemetrySnapshot(raw);
        lines.push(`Workflow ${runId.slice(0, 8)}… | ${snapshot.phase} | ${snapshot.harness}`);
        if (snapshot.model) lines.push(`Model: ${snapshot.model}`);
        if (snapshot.usage) {
          const t = snapshot.usage.tokens;
          const c = snapshot.usage.cost;
          const parts: string[] = [];
          if (t?.input !== undefined) parts.push(`in=${t.input}`);
          if (t?.output !== undefined) parts.push(`out=${t.output}`);
          if (parts.length) lines.push(`Tokens: ${parts.join(" ")}`);
          if (c !== undefined) lines.push(`Cost: $${c}`);
        }
        if (snapshot.tools?.lastName) lines.push(`Tool: ${snapshot.tools.lastName}`);
      } else {
        lines.push(`Workflow ${runId.slice(0, 8)}… | starting | pi`);
      }
      if (ctx.hasUI) {
        ctx.ui.setWidget("workflow-worker-observability", lines);
        ctx.ui.setStatus("workflow-worker-observability", `pi ${raw ? publicTelemetrySnapshot(raw).phase : "starting"}`);
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      await telemetry.record({ runId, workerId: runId, event: { type: "lifecycle", phase: "starting", harness: "pi" } });
      await updateWidget(ctx);
    });

    pi.on("turn_start", async (_event, ctx) => {
      const events = adapter.consume({ type: "turn_start" });
      for (const e of events) {
        await telemetry.record({ runId, workerId: runId, event: e });
      }
      await updateWidget(ctx);
    });

    pi.on("tool_execution_start", async (event, ctx) => {
      const events = adapter.consume({ type: "tool_execution_start", toolName: event.toolName });
      for (const e of events) {
        await telemetry.record({ runId, workerId: runId, event: e });
      }
      await updateWidget(ctx);
    });

    pi.on("tool_execution_end", async (_event, ctx) => {
      // No telemetry event; refresh widget to reflect any cleared tool state
      await updateWidget(ctx);
    });

    pi.on("message_end", async (event, ctx) => {
      if (event.message?.role !== "assistant") return;
      const events = adapter.consume({
        type: "message_end",
        message: {
          role: "assistant",
          model: event.message.model,
          usage: event.message.usage,
        },
      });
      for (const e of events) {
        await telemetry.record({ runId, workerId: runId, event: e });
      }
      await updateWidget(ctx);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      const events = adapter.consume({ type: "agent_settled" });
      for (const e of events) {
        await telemetry.record({ runId, workerId: runId, event: e });
      }
      await updateWidget(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.setWidget("workflow-worker-observability", undefined);
        ctx.ui.setStatus("workflow-worker-observability", undefined);
      }
      // Telemetry persists; no process signaling or cleanup
    });
  };
}

export default createWorkflowWorkerObservabilityExtension();
