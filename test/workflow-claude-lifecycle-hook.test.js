import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runClaudeLifecycleHook } from "../hooks/claude-lifecycle.mjs";
import { renderClaudeStatusLine } from "../hooks/claude-statusline.mjs";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { publicTelemetrySnapshot } from "../src/workflow/telemetry.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";

// Builds a real run store + lifecycle + telemetry over a tmp state root and drives the run
// to LAUNCHING, mirroring a freshly launched interactive Claude worker (as the reviewer did
// empirically). Env carries the harness so the hook is active.
async function realFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-claude-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({ stateRoot: join(root, "state"), randomUUID: () => RUN_ID });
  await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await store.update(RUN_ID, () => ({ state: RUN_STATES.LAUNCHING }));
  const lifecycle = createLifecycle({ store });
  const telemetry = createTelemetryStore({ store });
  const env = { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_HARNESS: "claude" };
  return { root, store, lifecycle, telemetry, env };
}

function fakeStore(run) {
  const calls = [];
  return { calls, async read() { return run; }, async update(id, fn) { calls.push(await fn(run)); return run; } };
}
function fakeLifecycle(rec) {
  return {
    async onPrompt(a) { rec.push(["onPrompt", a]); },
    async onStop(a) { rec.push(["onStop", a]); return { action: rec.stopAction ?? "none" }; },
    async onSessionEnd(a) { rec.push(["onSessionEnd", a]); },
  };
}

test("first UserPromptSubmit calls onPrompt with the current generation, source user", async () => {
  const rec = []; rec.stopAction = "none";
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "launching", generation: 1 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 1, source: "user" }]);
});

test("a subsequent UserPromptSubmit (running) increments the generation", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 2 }), lifecycle: fakeLifecycle(rec) });
  assert.deepEqual(rec[0], ["onPrompt", { runId: "r1", generation: 3, source: "user" }]);
});

test("Stop with action continue emits a block decision on stdout", async () => {
  const rec = []; rec.stopAction = "continue";
  const out = await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: fakeStore({ id: "r1", state: "running", generation: 1 }), lifecycle: fakeLifecycle(rec), hasValidHandoff: async () => false });
  assert.equal(rec[0][0], "onStop");
  assert.match(out ?? "", /"decision":"block"/);
});

test("a store/lifecycle error is swallowed (never throws)", async () => {
  await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env: { WORKFLOW_RUN_ID: "r1", WORKFLOW_HARNESS: "claude" },
    store: { async read() { throw new Error("boom"); }, async update() {} }, lifecycle: fakeLifecycle([]) });
  // no throw = pass
});

test("no-op when WORKFLOW_RUN_ID / harness is absent", async () => {
  const rec = [];
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env: {}, store: fakeStore({}), lifecycle: fakeLifecycle(rec) });
  assert.equal(rec.length, 0);
});

// FINDING 1: against the real lifecycle + store, the sequence must be
// launching → UserPromptSubmit → running/generation 1 → UserPromptSubmit → running/generation 2.
// SessionStart is never wired, so the first real prompt confirms generation 1 (not 2).
test("the real lifecycle sequence keeps generation aligned to the prompt (no off-by-one)", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);

  const launched = await store.read(RUN_ID);
  assert.equal(launched.state, RUN_STATES.LAUNCHING);
  assert.equal(launched.generation ?? 1, 1);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterFirst = await store.read(RUN_ID);
  assert.equal(afterFirst.state, RUN_STATES.RUNNING);
  assert.equal(afterFirst.generation, 1);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  const afterSecond = await store.read(RUN_ID);
  assert.equal(afterSecond.state, RUN_STATES.RUNNING);
  assert.equal(afterSecond.generation, 2);
});

test("SessionStart is a no-op (unwired) and never advances state or generation", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);
  await runClaudeLifecycleHook({ event: "SessionStart", stdinJson: {}, env, store, lifecycle, telemetry });
  const after = await store.read(RUN_ID);
  assert.equal(after.state, RUN_STATES.LAUNCHING);
  assert.equal(after.generation ?? 1, 1);
});

// FINDING 2: after a prompt, the run's telemetry snapshot has a real phase and the statusLine
// renders that phase (not "starting"), proving the interactive lane now produces telemetry.
test("onPrompt records a telemetry phase the statusLine renders (not 'starting')", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);

  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });

  const [raw] = await telemetry.read({ runId: RUN_ID });
  assert.ok(raw, "telemetry snapshot should exist after a prompt");
  const snapshot = publicTelemetrySnapshot(raw);
  assert.equal(snapshot.phase, "running");

  const line = renderClaudeStatusLine({ env, stdinJson: { model: { display_name: "Sonnet" } }, snapshot });
  assert.match(line, /running/);
  assert.doesNotMatch(line, /starting/);
  assert.match(line, /Sonnet/);
});

// FINDING 2: onStop projects the lifecycle action onto a telemetry phase.
test("onStop records 'settled' when the run completes with a valid handoff", async (t) => {
  const { store, lifecycle, telemetry, env } = await realFixture(t);
  await runClaudeLifecycleHook({ event: "UserPromptSubmit", stdinJson: {}, env, store, lifecycle, telemetry });
  await runClaudeLifecycleHook({ event: "Stop", stdinJson: {}, env, store, lifecycle, telemetry, hasValidHandoff: async () => true });

  const [raw] = await telemetry.read({ runId: RUN_ID });
  assert.equal(publicTelemetrySnapshot(raw).phase, "settled");
});
