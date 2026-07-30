import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunStore } from "../../src/workflow/run-store.js";
import { createLifecycle } from "../../src/workflow/lifecycle.js";
import { createSubprocessOwnOwnershipReader } from "../../src/workflow/ownership.js";

function continuationPrompt(runId: string, generation: number): string {
  return `Before ending this turn, create the workflow handoff for run ${runId}, generation ${generation}.`;
}

// One reader per process, built at module scope -- like hooks/claude-lifecycle.mjs's identical
// defaultReadOwnOwnership, but the cost model differs: this extension runs in-process for the
// WHOLE Pi session (one module load, many agent_start/agent_settled events), not once per event
// like the subprocess hooks. createSubprocessOwnOwnershipReader's memoization therefore buys one
// `ps` spawn per session -- paid on the first lock this session acquires -- rather than one per
// event. That is the only reason a `ps` spawn living inside an extension is acceptable here.
const defaultReadOwnOwnership = createSubprocessOwnOwnershipReader();

export function createWorkflowWorkerLifecycleExtension({
  env = process.env as Record<string, string | undefined>,
  lifecycle,
  hasValidHandoff,
  store: injectedStore,
  createRunStore: createRunStoreImpl = createRunStore,
  readOwnOwnership = defaultReadOwnOwnership,
} = {} as any) {
  const runId = env.WORKFLOW_RUN_ID;
  if (!runId || env.WORKFLOW_HARNESS !== "pi") return (_pi: ExtensionAPI) => {};
  const store = injectedStore ?? createRunStoreImpl({ stateRoot: env.WORKFLOW_STATE_ROOT, readOwnOwnership });
  const life = lifecycle ?? createLifecycle({ store });
  const validHandoff = hasValidHandoff ?? (async (gen: number) => await handoffExists(store, runId, gen));

  // Pi 0.81.1 emits no field distinguishing a user follow-up from our own queued
  // continuation (both are just agent_start), so we track it locally.
  let pendingContinuation = false;
  let startedOnce = false;

  return function workflowWorkerLifecycle(pi: ExtensionAPI) {
    pi.on("agent_start", async () => {
      try {
        const current = await store.read(runId);
        const source = pendingContinuation ? "continuation" : "user";
        pendingContinuation = false;
        // The first start confirms the launch generation; a later user start is a
        // follow-up that increments it. A continuation reuses the current generation.
        const generation = source === "user" && startedOnce ? current.generation + 1 : current.generation;
        startedOnce = true;
        await life.onPrompt({ runId, generation, source });
      } catch {
        // Swallow: a lifecycle bookkeeping error must never crash the worker. This
        // handler runs inside Pi's fire-and-forget pi.on(...) dispatch, so a throw
        // here would surface as an unhandled rejection on a normal path.
      }
    });

    pi.on("agent_settled", async () => {
      try {
        const current = await store.read(runId);
        const { action } = await life.onStop({
          runId,
          generation: current.generation,
          hasValidHandoff: await validHandoff(current.generation),
        });
        // Best-effort notification for non-continuation stop states (settled / manual).
        if (action !== "continue" && action !== "none") {
          try {
            const { notifyStop } = await import("../../src/workflow/notifier.js");
            await notifyStop({ run: current, store, runId, action });
          } catch {
            // swallow: a notifier must never break the lifecycle hook
          }
        }
        if (action === "continue") {
          // Set the flag BEFORE sending, so the agent_start this triggers is tagged.
          pendingContinuation = true;
          await pi.sendUserMessage(continuationPrompt(runId, current.generation), {
            deliverAs: "followUp",
            triggerTurn: true,
          });
        }
      } catch {
        // Swallow: a lifecycle bookkeeping error must never crash the worker.
      }
    });

    pi.on("session_shutdown", async () => {
      try {
        await life.onSessionEnd({ runId });
        // Best-effort notification when the session ends without a handoff.
        try {
          const { notifyRun } = await import("../../src/workflow/notifier.js");
          await notifyRun({ store, runId });
        } catch {
          // swallow: a notifier must never break the lifecycle hook
        }
      } catch {
        // Swallow: a lifecycle bookkeeping error must never crash the worker.
      }
    });
  };
}

export async function handoffExists(store: any, runId: string, generation: number): Promise<boolean> {
  const run = await store.read(runId);
  return Boolean(run && run.state === "completed" && run.generation === generation);
}

export default createWorkflowWorkerLifecycleExtension();
