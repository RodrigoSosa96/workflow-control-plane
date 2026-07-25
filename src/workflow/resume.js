import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("resume", message, { details });
}

export async function planResume({ store, transport, runId }) {
  assertWorkerTransport(transport);
  const run = await store.read(runId);
  const identity = run.transportIdentity;
  if (!identity) fail("Run has no exact session identity to resume", { runId });
  const observation = await transport.observeExact(identity);
  switch (observation.state) {
    case "active":
    case "idle":
      return { action: "focus", identity };
    case "missing":
      return { action: "relaunch", identity };
    default:
      return { action: "refuse", identity, reason: observation.state };
  }
}

export async function executeResume({ store, transport, herdr, runId, confirmed = false, relaunch }) {
  const plan = await planResume({ store, transport, runId });
  if (plan.action === "focus") {
    if (herdr && typeof herdr.focusTab === "function" && plan.identity?.tabId) {
      await herdr.focusTab({ tabId: plan.identity.tabId });
    }
    return { action: "focused", identity: plan.identity };
  }
  if (plan.action === "relaunch") {
    if (!confirmed) return { action: "needs-confirmation", plan: "relaunch", identity: plan.identity };
    const result = await relaunch(plan.identity);
    const identity = result?.identity ?? plan.identity;
    // Persist the new pane/tab identity so the next resume observes the live pane instead of
    // the dead one; this is a foreground write triggered by the user's confirmed `--yes`, not
    // a background writer. Only fires on a confirmed relaunch that actually returned an
    // identity — never on focus or needs-confirmation.
    if (result?.identity && typeof store.update === "function") {
      await store.update(runId, () => ({ transportIdentity: identity }));
    }
    return { action: "relaunched", identity };
  }
  fail(`Cannot resume: ${plan.reason ?? plan.action}`, { runId });
}
