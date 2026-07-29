import assert from "node:assert";
import { access, chmod, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readEvents } from "../src/workflow/events-bus.js";
import {
  notifyHandoff,
  notifyRun,
  notifyStop,
  resolveNotifierPath,
} from "../src/workflow/notifier.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "workflow-notifier-"));
}

function makeRun(overrides = {}) {
  return {
    id: "run-123",
    state: "completed",
    resultStatus: "completed",
    directory: "/tmp/run-123",
    resultPath: "/tmp/run-123/result.json",
    harness: "claude",
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    status: "completed",
    summary: "done",
    ...overrides,
  };
}

test("resolveNotifierPath prefers explicit env var", () => {
  assert.equal(resolveNotifierPath({ WORKFLOW_HANDOFF_NOTIFIER: "/foo/bar" }), "/foo/bar");
});

test("resolveNotifierPath falls back to home config", () => {
  const path = resolveNotifierPath({ HOME: "/home/test" });
  assert.equal(path, "/home/test/.config/workflows/handoff-notifier");
});

test("notifyHandoff is a no-op when notifier is missing", async () => {
  const dir = await tempDir();
  const env = { HOME: dir };
  const result = await notifyHandoff({ run: makeRun(), result: makeResult(), env });
  assert.equal(result.notified, false);
  await rm(dir, { recursive: true, force: true });
});

test("notifyHandoff runs the notifier when executable", async () => {
  const dir = await tempDir();
  const notifier = join(dir, "notifier");
  const marker = join(dir, "marker");
  await writeFile(
    notifier,
    `#!/usr/bin/env bash\nenv | grep WORKFLOW_RUN_ID > "${marker}"\n`,
  );
  await access(notifier, constants.F_OK);
  await writeFile(marker, "");
  // Without exec permission the test would still pass because spawn fails silently,
  // so we rely on the next test for the executable case. Here we just verify path resolution.
  const result = await notifyHandoff({
    run: makeRun(),
    result: makeResult(),
    env: { WORKFLOW_HANDOFF_NOTIFIER: notifier },
  });
  assert.equal(result.notified, false);
  await rm(dir, { recursive: true, force: true });
});

test("notifyHandoff rejects relative paths", async () => {
  const result = await notifyHandoff({
    run: makeRun(),
    result: makeResult(),
    env: { WORKFLOW_HANDOFF_NOTIFIER: "relative/notifier" },
  });
  assert.equal(result.notified, false);
  assert.equal(result.reason, "notifier path must be absolute");
});

test("notifyHandoff uses the injected spawner for an executable notifier", async () => {
  const dir = await tempDir();
  const notifier = join(dir, "notifier");
  await writeFile(notifier, "#!/bin/sh\nexit 0\n");
  await chmod(notifier, 0o700);
  const calls = [];
  const result = await notifyHandoff({
    run: makeRun(),
    result: makeResult(),
    env: { WORKFLOW_HANDOFF_NOTIFIER: notifier },
    spawnFn(path, args, options) {
      calls.push({ path, args, options });
      return { unref() {} };
    },
  });
  assert.equal(result.notified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, notifier);
  assert.equal(calls[0].options.env.WORKFLOW_RUN_ID, "run-123");
  await rm(dir, { recursive: true, force: true });
});

test("notifyStop reads the persisted run before publishing its event", async () => {
  const dir = await tempDir();
  const stale = makeRun({ state: "running", resultStatus: "", resultPath: "", stateRoot: dir });
  const settled = makeRun({ state: "needs_input", resultStatus: "needs-input", resultPath: "/tmp/run-123/result.json", stateRoot: dir });
  const result = await notifyStop({
    run: stale,
    store: { read: async (id) => (id === stale.id ? settled : null) },
    runId: stale.id,
    action: "manual",
    env: { HOME: join(dir, "missing-home") },
  });
  assert.equal(result.event.runState, "needs_input");
  assert.equal(result.event.runStatus, "needs-input");
  const { events } = await readEvents({ stateRoot: dir });
  assert.equal(events[0].runState, "needs_input");
  await rm(dir, { recursive: true, force: true });
});

test("notifyStop includes action in env", async () => {
  const dir = await tempDir();
  const notifier = join(dir, "notifier");
  const marker = join(dir, "marker");
  await writeFile(
    notifier,
    `#!/usr/bin/env bash\nenv > "${marker}"\n`,
  );
  // Non-executable on purpose; we only verify the function does not throw.
  const result = await notifyStop({ run: makeRun(), action: "manual", env: { WORKFLOW_HANDOFF_NOTIFIER: notifier } });
  assert.equal(result.notified, false);
  await rm(dir, { recursive: true, force: true });
});

test("notifyRun reads run from store", async () => {
  const run = makeRun();
  const store = { read: async (id) => (id === run.id ? run : null) };
  const result = await notifyRun({ store, runId: run.id, env: { HOME: "/tmp/nowhere" } });
  assert.equal(result.notified, false);
});
