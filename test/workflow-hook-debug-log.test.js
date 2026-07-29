import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { hookDebugLogPath, recordHookDebug } from "../hooks/lib/hook-debug-log.mjs";
import { runLifecycleHook } from "../hooks/lib/lifecycle-hook-core.mjs";

const RUN_ID = "55555555-5555-4555-8555-555555555555";

async function tempRunDirectory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-hook-debug-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readLog(runDirectory) {
  const text = await fs.readFile(hookDebugLogPath(runDirectory), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("recordHookDebug appends bounded single-line JSON entries with private permissions", async (t) => {
  const runDirectory = await tempRunDirectory(t);

  assert.equal(await recordHookDebug({
    runDirectory,
    harness: "claude",
    event: "Stop",
    scope: "lifecycle",
    error: new Error("hook payload changed\nsecond line"),
    at: "2026-07-29T00:00:00.000Z",
  }), true);
  assert.equal(await recordHookDebug({
    runDirectory,
    harness: "claude",
    event: "UserPromptSubmit",
    scope: "marker",
    error: "x".repeat(2000),
    at: "2026-07-29T00:00:01.000Z",
  }), true);

  const entries = await readLog(runDirectory);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    at: "2026-07-29T00:00:00.000Z",
    harness: "claude",
    event: "Stop",
    scope: "lifecycle",
    error: "Error: hook payload changed second line",
  });
  // Bounded so a hook failing every turn cannot fill a disk.
  assert.ok(entries[1].error.length <= 512);
  assert.equal((await fs.stat(hookDebugLogPath(runDirectory))).mode & 0o777, 0o600);
});

test("recordHookDebug never throws and never writes without a run directory", async () => {
  assert.equal(await recordHookDebug({ runDirectory: undefined, error: new Error("x") }), false);
  assert.equal(await recordHookDebug({
    runDirectory: "/nonexistent/workflow-run-dir",
    error: new Error("x"),
  }), false);
  assert.equal(await recordHookDebug({
    runDirectory: "/tmp",
    error: new Error("x"),
    appendFile: async () => { throw new Error("EACCES"); },
  }), false);
});

test("a swallowed lifecycle failure is recorded in the run's hook debug log", async (t) => {
  // Hook errors must never break the worker, which used to mean a broken hook
  // contract (a harness upgrade changing payload shapes) degraded invisibly:
  // generations stopped advancing with nothing recording why.
  const runDirectory = await tempRunDirectory(t);
  const env = { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_HARNESS: "claude", WORKFLOW_RUN_DIR: runDirectory };
  const store = {
    async read() {
      throw new Error("run.json shape changed");
    },
    async update() {
      assert.fail("a failed read must not reach a marker write");
    },
  };

  const result = await runLifecycleHook({
    harness: "claude",
    event: "UserPromptSubmit",
    env,
    store,
    lifecycle: { async onPrompt() { assert.fail("lifecycle must not run after a failed read"); } },
  });
  // Still swallowed: the worker is never broken by bookkeeping.
  assert.equal(result, undefined);

  const entries = await readLog(runDirectory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].harness, "claude");
  assert.equal(entries[0].event, "UserPromptSubmit");
  assert.equal(entries[0].scope, "lifecycle");
  assert.match(entries[0].error, /run\.json shape changed/);
});

test("a swallowed marker-write failure is recorded while the prompt still advances", async (t) => {
  const runDirectory = await tempRunDirectory(t);
  const env = { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_HARNESS: "codex", WORKFLOW_RUN_DIR: runDirectory };
  const prompts = [];
  const store = {
    async read() {
      return { id: RUN_ID, generation: 1 };
    },
    async update() {
      // The launcher holds the run lock: exactly the collision that silently
      // dropped a marker and shifted every later generation.
      throw new Error("Run is locked by an active lock");
    },
  };

  await runLifecycleHook({
    harness: "codex",
    event: "UserPromptSubmit",
    env,
    store,
    lifecycle: { async onPrompt(input) { prompts.push(input); } },
  });

  assert.deepEqual(prompts, [{ runId: RUN_ID, generation: 1, source: "user" }]);
  const entries = await readLog(runDirectory);
  assert.deepEqual(entries.map((entry) => entry.scope), ["marker"]);
  assert.match(entries[0].error, /locked/i);
});
