// Roadmap 1.2's proof test: Tasks 1-3 collapsed the worker lifecycle protocol (generation
// bookkeeping, stop-attempt budget, marker clearing on resume) into one shared core
// (src/workflow/lifecycle.js + hooks/lib/lifecycle-hook-core.mjs) so it could no longer be
// implemented twice and drift the way it did before this item (Pi reused the generation across a
// resume; Claude and Codex incremented it -- D5). This file drives the SAME event sequence
// against all three harnesses and asserts the persisted run record agrees at every step. A future
// harness is one more row in HARNESS_DRIVERS below; a divergence fails that harness's own test,
// not a diff someone has to eyeball across three files.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runLifecycleHook } from "../hooks/lib/lifecycle-hook-core.mjs";
import { createWorkflowWorkerLifecycleExtension } from "../.pi/extensions/workflow-worker-lifecycle.ts";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { executeResume } from "../src/workflow/resume.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

// One fixed, path-safe UUID per harness so each row gets its own run directory under its own
// temp state root; the digits carry no meaning beyond satisfying run-store.js's RUN_ID_RE.
const RUN_IDS = {
  claude: "44444444-4444-4444-8444-444444444441",
  codex: "44444444-4444-4444-8444-444444444442",
  pi: "44444444-4444-4444-8444-444444444443",
};

// The documented sequence from the plan (task-4-brief.md), verbatim:
//   launch (LAUNCHING, generation 1)
//     -> first prompt        -> RUNNING, generation 1
//     -> stop, no handoff    -> continue, stopAttempts 1
//     -> continuation prompt -> generation 1 (reused)
//     -> user follow-up      -> generation 2, stopAttempts 0
//     -> resume              -> generation 3, stopAttempts 0, markers cleared
//     -> first prompt after  -> generation 3 (confirmed, NOT bumped again)
const STEP_LABELS = [
  "launch",
  "first prompt",
  "stop, no handoff",
  "continuation prompt",
  "user follow-up",
  "resume",
  "first prompt after",
];

// Named projection of only the lifecycle-relevant fields on a persisted run record, taken AFTER
// normalizing the harness-prefixed markers (`${harness}StartedOnce` / `${harness}PendingContinuation`)
// to harness-neutral names so the three rows can be compared against one shared expectation.
//
// Deliberately EXCLUDED: telemetry. `telemetry.record` patches the run record in place
// (telemetry-store.js writes `telemetry.workers[id]` through writePrivateFile's updater), and the
// Claude/Codex subprocess hooks always construct a telemetry store (hooks/claude-lifecycle.mjs,
// hooks/codex-lifecycle.mjs) while the Pi adapter passes none -- by design, because Pi's
// lifecycle-phase telemetry comes from a separate extension
// (.pi/extensions/workflow-worker-observability.ts), and wiring a telemetry store into the shared
// core for Pi too would double-write what that extension already records. Comparing whole run
// records would therefore fail this test for a reason that is not a lifecycle divergence: Claude
// and Codex would carry `telemetry` entries Pi does not. That asymmetry is a controller decision,
// not an oversight -- recorded here so a reader can see exactly what is excluded and why, and can
// confirm nothing lifecycle-relevant is hidden behind it. Also excluded, but not because they're
// unwritten -- resume.js does write resumeClaim and transportIdentity on the very "resume" step
// this test drives: resumeClaim, transportIdentity, agentProfile, createdAt/updatedAt,
// stateHistory, and harness/profileName. They're excluded because each is harness-variant by
// construction (agentProfile, harness/profileName) or carries a timestamp/opaque identity with no
// fixed expected value (resumeClaim, transportIdentity, createdAt/updatedAt, stateHistory) -- not
// arithmetic a shared lifecycle expectation can pin.
function lifecycleProjection(run, harness) {
  return {
    state: run.state,
    generation: run.generation,
    previousGeneration: run.previousGeneration ?? null,
    stopAttempts: run.stopAttempts ?? 0,
    startedOnce: run[`${harness}StartedOnce`] ?? false,
    pendingContinuation: run[`${harness}PendingContinuation`] ?? false,
  };
}

// The expected projection at every point in STEP_LABELS, harness-neutral. All three rows are
// asserted against this SAME array, which is what makes agreement between them provable rather
// than merely plausible: if any harness's driver produced a different sequence, its own test --
// not a shared "do these match" assertion -- would fail.
const EXPECTED_PROJECTIONS = [
  { state: RUN_STATES.LAUNCHING, generation: 1, previousGeneration: null, stopAttempts: 0, startedOnce: false, pendingContinuation: false },
  { state: RUN_STATES.RUNNING, generation: 1, previousGeneration: null, stopAttempts: 0, startedOnce: true, pendingContinuation: false },
  { state: RUN_STATES.IDLE_AWAITING_HANDOFF, generation: 1, previousGeneration: null, stopAttempts: 1, startedOnce: true, pendingContinuation: true },
  { state: RUN_STATES.RUNNING, generation: 1, previousGeneration: null, stopAttempts: 1, startedOnce: true, pendingContinuation: false },
  { state: RUN_STATES.RUNNING, generation: 2, previousGeneration: 1, stopAttempts: 0, startedOnce: true, pendingContinuation: false },
  { state: RUN_STATES.RUNNING, generation: 3, previousGeneration: 2, stopAttempts: 0, startedOnce: false, pendingContinuation: false },
  { state: RUN_STATES.RUNNING, generation: 3, previousGeneration: 2, stopAttempts: 0, startedOnce: true, pendingContinuation: false },
];

// A structurally-valid worker transport (assertWorkerTransport just checks the four methods
// exist) whose observeExact always reports the session as gone, so planResume takes the
// "relaunch" branch of executeResume -- the branch that bumps the generation and clears markers.
function deadTransport(identity) {
  return {
    start() {},
    deliverFollowUp() {},
    requestGracefulClose() {},
    async observeExact() {
      return { state: "missing", identity };
    },
  };
}

// Builds a real run store over a fresh temp state root (removed in t.after -- no stubs, the
// assertions below are on what actually got persisted to disk) and a run seeded with a
// reproducible envelope (transportIdentity + agentProfile), the two fields planResume/executeResume
// require to take the relaunch path the resume step below drives.
async function setupRun(t, harness) {
  const root = await fs.mkdtemp(join(tmpdir(), `workflow-lifecycle-parity-${harness}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = RUN_IDS[harness];
  const store = createRunStore({ stateRoot: join(root, "state"), randomUUID: () => runId });
  const identity = { kind: `${harness}-session`, sessionId: "s1", paneId: "p1", tabId: "t1", harness };
  await store.create({
    harness,
    profileName: `${harness}-worker`,
    generation: 1,
    transportIdentity: identity,
    agentProfile: { harness, command: harness, arguments: [] },
  });
  await store.update(runId, () => ({ state: RUN_STATES.LAUNCHING }));
  const lifecycle = createLifecycle({ store });
  // Claude and Codex's real subprocess hooks always construct a telemetry store (see
  // hooks/claude-lifecycle.mjs's / hooks/codex-lifecycle.mjs's main()); Pi's adapter never does
  // (see the projection helper's comment above). Mirroring that asymmetry here, rather than
  // giving every row the same telemetry wiring, is what makes the projection's exclusion of
  // telemetry an actual proof instead of a no-op.
  const telemetry = harness === "pi" ? undefined : createTelemetryStore({ store });
  return { root, runId, store, lifecycle, telemetry, identity };
}

// The resume step is not a hook event -- it is executeResume's claim update (src/workflow/resume.js),
// which Task 3 made responsible for opening the new generation and clearing both harness markers
// before relaunch() runs. Driven here through the real executeResume (not a hand-applied patch),
// with an injected `relaunch` standing in for the real Herdr/tmux relaunch -- exactly the seam
// Task 3's own tests use. This is shared by all three harness drivers below: the resume step
// itself is harness-agnostic production code, not part of any one adapter.
async function driveResume(ctx) {
  await executeResume({
    store: ctx.store,
    transport: deadTransport(ctx.identity),
    runId: ctx.runId,
    confirmed: true,
    relaunch: async () => ({ identity: ctx.identity }),
  });
}

// Drives the documented sequence for Claude/Codex directly through runLifecycleHook, the same
// harness-agnostic core the real per-event subprocess hooks (hooks/claude-lifecycle.mjs,
// hooks/codex-lifecycle.mjs) call.
async function driveHookHarness(harness, ctx) {
  const env = { WORKFLOW_RUN_ID: ctx.runId, WORKFLOW_HARNESS: harness };
  const projections = [];
  const snap = async () => projections.push(lifecycleProjection(await ctx.store.read(ctx.runId), harness));
  const runHook = (event) => runLifecycleHook({
    harness, event, stdinJson: {}, env, store: ctx.store, lifecycle: ctx.lifecycle, telemetry: ctx.telemetry,
  });

  await snap(); // launch

  await runHook("UserPromptSubmit");
  await snap(); // first prompt

  await runHook("Stop");
  await snap(); // stop, no handoff

  await runHook("UserPromptSubmit"); // the queued continuation's own UserPromptSubmit
  await snap(); // continuation prompt

  await runHook("UserPromptSubmit"); // a genuine user follow-up
  await snap(); // user follow-up

  await driveResume(ctx);
  await snap(); // resume

  await runHook("UserPromptSubmit");
  await snap(); // first prompt after

  return projections;
}

// The fake `pi` object, copied from test/workflow-pi-lifecycle-extension.test.js's own fakePi(),
// so the extension is driven the exact way that file already established as faithful to Pi's
// real pi.on(...) dispatch (agent_start / agent_settled / session_shutdown handlers registered
// via pi.on, continuations delivered via pi.sendUserMessage).
function fakePi() {
  return {
    handlers: {},
    sent: [],
    on(name, fn) { this.handlers[name] = fn; },
    sendUserMessage(msg, opts) { this.sent.push({ msg, opts }); },
  };
}

// Drives the same documented sequence for Pi through the real adapter
// (.pi/extensions/workflow-worker-lifecycle.ts), which is itself a thin wrapper over the same
// runLifecycleHook core the claude/codex driver above calls directly -- agent_start maps to
// UserPromptSubmit, agent_settled maps to Stop (rendering a continuation via
// pi.sendUserMessage instead of the claude/codex block-decision JSON).
async function drivePi(ctx) {
  const env = { WORKFLOW_RUN_ID: ctx.runId, WORKFLOW_HARNESS: "pi", WORKFLOW_STATE_ROOT: ctx.root };
  const pi = fakePi();
  createWorkflowWorkerLifecycleExtension({ env, store: ctx.store, lifecycle: ctx.lifecycle })(pi);
  const projections = [];
  const snap = async () => projections.push(lifecycleProjection(await ctx.store.read(ctx.runId), "pi"));

  await snap(); // launch

  await pi.handlers.agent_start({}, {});
  await snap(); // first prompt

  await pi.handlers.agent_settled({}, {});
  await snap(); // stop, no handoff

  await pi.handlers.agent_start({}, {}); // the queued continuation's own agent_start
  await snap(); // continuation prompt

  await pi.handlers.agent_start({}, {}); // a genuine user follow-up
  await snap(); // user follow-up

  await driveResume(ctx);
  await snap(); // resume

  await pi.handlers.agent_start({}, {});
  await snap(); // first prompt after

  return projections;
}

const HARNESS_DRIVERS = {
  claude: (ctx) => driveHookHarness("claude", ctx),
  codex: (ctx) => driveHookHarness("codex", ctx),
  pi: drivePi,
};

for (const harness of Object.keys(HARNESS_DRIVERS)) {
  test(`${harness}: the shared lifecycle sequence produces the documented arithmetic at every step`, async (t) => {
    const ctx = await setupRun(t, harness);
    const projections = await HARNESS_DRIVERS[harness](ctx);
    assert.equal(projections.length, EXPECTED_PROJECTIONS.length);
    for (let i = 0; i < EXPECTED_PROJECTIONS.length; i += 1) {
      assert.deepEqual(projections[i], EXPECTED_PROJECTIONS[i], `step "${STEP_LABELS[i]}" (${harness})`);
    }
  });
}
