import { assertWorkerTransport } from "./worker-transport.js";
import { WorkflowError } from "./errors.js";
import { assertProfile } from "./harnesses.js";

// A crashed resume leaves its claim behind (no-cleanup); claims older than
// this window are treated as residue and may be reclaimed by a new confirmed
// resume instead of blocking it forever.
const RESUME_CLAIM_FRESH_MS = 10 * 60 * 1000;

// Rendered verbatim in the CLI's error line (`fail` below folds plan.reason straight into the
// thrown message, and bin/workflow.js prints that message as-is) — a sentence, not a slug, so
// the operator sees what happened and what to do next without cross-referencing a code.
export const UNREPRODUCIBLE_ENVELOPE_REASON =
  "This run's approved envelope cannot be reproduced (it predates agent-profile tracking); " +
  "start a fresh, freshly-approved launch instead of resuming.";

function fail(message, details) {
  throw new WorkflowError("resume", message, { details });
}

// True only when run.agentProfile is present and passes assertProfile: the argv builder's own
// judgment of a reproducible envelope, not a hand-rolled shape check duplicating it here.
function resumableProfile(run) {
  try {
    assertProfile(run?.agentProfile);
    return true;
  } catch {
    return false;
  }
}

// Mirrors relaunchSession's own normalization (commands.js) exactly: anything other than
// "claude"/"codex" is treated as Pi. The marker field names the lifecycle core reads
// (`${harness}StartedOnce` / `${harness}PendingContinuation`) must agree with the harness
// relaunchSession derives from the same identity, or this clears the wrong run fields and the
// bug this item exists to close survives silently.
function normalizeHarness(identityHarness) {
  return identityHarness === "claude" ? "claude" : identityHarness === "codex" ? "codex" : "pi";
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
  // Fail closed: a claim we cannot date is treated as held, not as absent.
  // Otherwise a malformed timestamp would wave a concurrent relaunch through.
  if (!Number.isFinite(claimed) || !Number.isFinite(now)) return true;
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
      // A relaunch has to reproduce the argv the approval digest covered, and run.agentProfile is
      // the only record of it (the registry may have changed since launch; transportIdentity does
      // not carry it). Runs created before that field existed cannot be reproduced, so they are
      // refused here rather than relaunched under an envelope nobody approved — the escalation
      // this item removed. Refusing in planResume, not in the relaunch itself, means the operator
      // sees it in the read-only preview instead of after a Herdr tab already exists.
      return resumableProfile(run)
        ? { action: "relaunch", identity }
        : { action: "refuse", identity, reason: UNREPRODUCIBLE_ENVELOPE_REASON };
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
    // Same normalization relaunchSession applies to this same identity (commands.js) — the
    // marker fields cleared below must be the ones the core will actually read for this harness.
    const harness = normalizeHarness(plan.identity?.harness);
    // Captured from `current` inside the updater below, before the generation bump, so a failed
    // relaunch can restore exactly what was there rather than guessing at a rollback value.
    let priorLifecycleState = null;
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
        priorLifecycleState = {
          generation: current.generation,
          previousGeneration: current.previousGeneration,
          stopAttempts: current.stopAttempts,
          [`${harness}StartedOnce`]: current[`${harness}StartedOnce`],
          [`${harness}PendingContinuation`]: current[`${harness}PendingContinuation`],
        };
        // A confirmed relaunch explicitly opens a new generation with a fresh stop budget,
        // before relaunch() is called: relaunchSession stamps WORKFLOW_GENERATION into the
        // pane env from this same record (runEnv(run, harness)), so the bump must land first
        // or the resumed worker's env disagrees with what the record now claims. Clearing the
        // markers is what makes the first prompt after the relaunch take the first-prompt
        // branch in every harness and confirm the generation just opened here, instead of
        // bumping it a second time. lifecycle.onPrompt's follow-up branch is the only thing
        // that resets stopAttempts, so without this a worker that already exhausted its two
        // stop attempts would relaunch straight back into manual-handoff-required.
        return {
          resumeClaim: { claimedAt },
          generation: current.generation + 1,
          previousGeneration: current.generation,
          stopAttempts: 0,
          [`${harness}StartedOnce`]: false,
          [`${harness}PendingContinuation`]: false,
        };
      });
    }
    let result;
    try {
      result = await relaunch(plan.identity);
    } catch (error) {
      if (canPersist) {
        try {
          await store.update(runId, () => ({ resumeClaim: null, ...(priorLifecycleState ?? {}) }));
        } catch {
          // Best-effort: resumeClaim itself expires on its own after the freshness window, but
          // generation/previousGeneration/stopAttempts and both markers have no such window --
          // a failed restore here leaves them at the new-generation values this same claim update
          // set above, ahead of a worker that never actually started. That is visible in the run
          // record (an operator running `workflow status` would see it) and does not self-heal.
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
