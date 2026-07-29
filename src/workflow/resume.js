import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";

// A crashed resume leaves its claim behind (no-cleanup); claims older than
// this window are treated as residue and may be reclaimed by a new confirmed
// resume instead of blocking it forever.
const RESUME_CLAIM_FRESH_MS = 10 * 60 * 1000;

function fail(message, details) {
  throw new WorkflowError("resume", message, { details });
}

function identityKey(identity) {
  if (!identity || typeof identity !== "object") return null;
  return JSON.stringify({
    kind: identity.kind ?? null,
    sessionId: identity.sessionId ?? null,
    paneId: identity.paneId ?? null,
    tabId: identity.tabId ?? null,
  });
}

function claimIsFresh(claimedAt, nowIso) {
  const claimed = Date.parse(claimedAt ?? "");
  const now = Date.parse(nowIso);
  if (!Number.isFinite(claimed) || !Number.isFinite(now)) return false;
  return now - claimed < RESUME_CLAIM_FRESH_MS;
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
    // Focus Pi's own pane, not just its tab. The launch retains a bootstrap shell pane above the
    // agent pane, so `tab focus` would raise the tab but leave the empty shell as the active pane
    // (observed: resume landed on "the panel above Pi"). `agent focus <paneId>` brings the agent
    // pane itself forward. Fall back to tab focus only if we somehow lack a paneId.
    if (herdr && typeof herdr.focusAgent === "function" && plan.identity?.paneId) {
      await herdr.focusAgent({ target: plan.identity.paneId });
    } else if (herdr && typeof herdr.focusTab === "function" && plan.identity?.tabId) {
      await herdr.focusTab({ tabId: plan.identity.tabId });
    }
    return { action: "focused", identity: plan.identity };
  }
  if (plan.action === "relaunch") {
    if (!confirmed) return { action: "needs-confirmation", plan: "relaunch", identity: plan.identity };
    // The observe→relaunch window is otherwise unlocked: two concurrent
    // `resume --yes` can both observe "missing" and both relaunch into the
    // same worktree. Claim the relaunch under the run lock first — the store
    // serializes updaters — and refuse if another resume already claimed it
    // or the identity moved since this resume planned.
    const canPersist = typeof store.update === "function";
    const claimedAt = new Date().toISOString();
    if (canPersist) {
      await store.update(runId, (current) => {
        if (identityKey(current.transportIdentity) !== identityKey(plan.identity)) {
          fail("Cannot resume: the run's session identity changed since this resume was planned", {
            runId,
          });
        }
        if (current.resumeClaim?.claimedAt && claimIsFresh(current.resumeClaim.claimedAt, claimedAt)) {
          fail("Cannot resume: another resume already claimed this run's relaunch", {
            runId,
            claimedAt: current.resumeClaim.claimedAt,
          });
        }
        return { resumeClaim: { claimedAt } };
      });
    }
    let result;
    try {
      result = await relaunch(plan.identity);
    } catch (error) {
      if (canPersist) {
        try {
          await store.update(runId, () => ({ resumeClaim: null }));
        } catch {
          // Best-effort: a stale claim expires on its own after the freshness window.
        }
      }
      throw error;
    }
    const identity = result?.identity ?? plan.identity;
    // Persist the new pane/tab identity so the next resume observes the live pane instead of
    // the dead one; this is a foreground write triggered by the user's confirmed `--yes`, not
    // a background writer. Only fires on a confirmed relaunch that actually returned an
    // identity — never on focus or needs-confirmation.
    if (canPersist) {
      await store.update(runId, () => (
        result?.identity ? { transportIdentity: identity, resumeClaim: null } : { resumeClaim: null }
      ));
    }
    return { action: "relaunched", identity };
  }
  fail(`Cannot resume: ${plan.reason ?? plan.action}`, { runId });
}
