import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunStore } from "../../src/workflow/run-store.js";
import { createLifecycle } from "../../src/workflow/lifecycle.js";
import { createSubprocessOwnOwnershipReader } from "../../src/workflow/ownership.js";
import { runLifecycleHook } from "../../hooks/lib/lifecycle-hook-core.mjs";

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

  // This extension is now a thin adapter over the harness-agnostic core
  // (hooks/lib/lifecycle-hook-core.mjs, shared with Claude/Codex's stateless subprocess hooks).
  // It holds no lifecycle condition of its own -- generation/source discrimination, marker
  // persistence, telemetry-phase recording, and stop notifications all live in the core, keyed
  // off `piStartedOnce` / `piPendingContinuation` on the run record. This file only maps Pi's
  // events onto the core's event vocabulary and renders the core's harness-neutral decision
  // ({ continuation: { prompt } } | undefined) into Pi's own protocol. Pi's events carry no
  // payload the core reads, so stdinJson is always {}; env is threaded through so the core's
  // recordDebug can write to the run's hook debug log via env.WORKFLOW_RUN_DIR -- strictly
  // better than the silent `catch {}` blocks this extension used to have.
  const runCore = (event: string) =>
    runLifecycleHook({ harness: "pi", event, stdinJson: {}, env, store, lifecycle: life, hasValidHandoff });

  return function workflowWorkerLifecycle(pi: ExtensionAPI) {
    pi.on("agent_start", async () => {
      try {
        await runCore("UserPromptSubmit");
      } catch {
        // Swallow: a lifecycle bookkeeping error must never crash the worker. This
        // handler runs inside Pi's fire-and-forget pi.on(...) dispatch, so a throw
        // here would surface as an unhandled rejection on a normal path.
      }
    });

    pi.on("agent_settled", async () => {
      try {
        const decision = await runCore("Stop");
        // Rendering the decision belongs here, in the file that speaks Pi's protocol -- Pi has
        // no wire format comparable to Claude/Codex's {"decision":"block",...} stdout contract,
        // so a continuation is simply delivered as a queued follow-up turn.
        if (decision?.continuation) {
          await pi.sendUserMessage(decision.continuation.prompt, {
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
        await runCore("SessionEnd");
      } catch {
        // Swallow: a lifecycle bookkeeping error must never crash the worker.
      }
    });
  };
}

export default createWorkflowWorkerLifecycleExtension();
