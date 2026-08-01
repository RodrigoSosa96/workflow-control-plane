// Closes roadmap item 1.6: nothing in the suite ever executed the settings/extension strings
// buildClaudeWorkerSettings and its siblings generate -- every existing hook test calls the
// hook's main({...}) in-process with injected seams, so a completely broken generated settings
// file (wrong path, broken quoting, wrong event token) would pass every test that existed before
// this file. This is the safety net roadmap item 1.2 needs before it starts.
//
// hooks/claude-lifecycle.mjs's main() wraps its whole body in try {} catch {} and always ends
// with process.exitCode = 0 -- a hook that silently did nothing is indistinguishable from one
// that worked, by exit code alone. So every test here asserts the EFFECT ON THE RUN RECORD (a
// run left in LAUNCHING must come back RUNNING) and never the subprocess's exit code. The
// negative test is what proves the positive test is not satisfied by a no-op: it points the same
// generated-settings shape at a control-plane root with no hooks/ directory and asserts the run
// record does NOT move -- only the run record tells a working hook apart from a broken one here.
//
// runHookCommand below is written to be reused unchanged by Task 2's Codex analog.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRunStore } from "../src/workflow/run-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";
import { buildClaudeWorkerSettings, CONTROL_PLANE_ROOT, runEnv } from "../src/workflow/harnesses.js";
import { ensureCodexWorkerHooks } from "../src/workflow/codex-hooks.js";

// Run a generated hook command exactly as a harness would: through a shell, so the generators'
// double-quoting of the absolute script path is actually exercised, with the harness's JSON
// payload on stdin and the worker's WORKFLOW_* env. Resolves the captured output regardless of
// exit status -- the hooks always exit 0 by design, so the caller asserts on the run record, and
// the output is only for the failure message.
async function runHookCommand(command, { env, payload, timeoutMs = 20_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify(payload ?? {}));
  });
}

// Degrade, don't lie: a sandboxed or minimal host might have no /bin/sh, or process.execPath
// (the node binary these tests themselves run under) might not resolve as an executable. Either
// one means the shell-invoked hook subprocess this whole file exists to exercise cannot run at
// all here, so every test below skips with a named reason rather than failing -- mirrors the
// t.skip degrade convention in test/workflow-hook-ownership.test.js.
async function canRunShellInvokedHook() {
  try {
    await access("/bin/sh", constants.X_OK);
  } catch {
    return false;
  }
  if (typeof process.execPath !== "string" || process.execPath.length === 0) return false;
  try {
    await access(process.execPath, constants.X_OK);
  } catch {
    return false;
  }
  return true;
}

const SKIP_REASON = "this host cannot run a shell-invoked hook subprocess";

// Stable marker identifying the workflow's own group in the shared ~/.codex/hooks.json --
// see src/workflow/codex-hooks.js's WORKFLOW_HOOK_OWNER. Not exported from that module, so this
// value is hardcoded here rather than imported; it must be kept in sync with the source if it
// ever changes there.
const CODEX_HOOK_OWNER = "workflow-control-plane:codex-lifecycle";

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Proves this suite never mutates the operator's real ~/.codex/hooks.json: if it existed before
// the test it must be byte-for-byte unchanged after (same size and mtime); if it did not exist,
// the test must not have created it either. This is the runtime half of "never touched" -- the
// static half is that every ensureCodexWorkerHooks call in this file below passes an explicit
// hooksPath under a mkdtemp'd temp root, never the default.
function assertRealCodexHooksUntouched(before, after, path) {
  if (before === null) {
    assert.equal(after, null, `ensureCodexWorkerHooks must never create the real ${path}`);
    return;
  }
  assert.ok(after, `the real ${path} existed before this test and is missing after it`);
  assert.equal(after.size, before.size, `the real ${path} changed size during this test`);
  assert.equal(after.mtimeMs, before.mtimeMs, `the real ${path} was modified during this test`);
}

test("the generated Claude settings' UserPromptSubmit hook, run as the harness runs it, drives LAUNCHING to RUNNING", async (t) => {
  if (!(await canRunShellInvokedHook())) {
    t.skip(SKIP_REASON);
    return;
  }

  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-claude-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  const store = createRunStore({ stateRoot });
  const created = await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await store.update(created.id, () => ({ state: RUN_STATES.LAUNCHING }));
  const run = await store.read(created.id);

  const settings = buildClaudeWorkerSettings({ controlPlaneRoot: CONTROL_PLANE_ROOT });
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;

  const result = await runHookCommand(command, {
    env: runEnv({ ...run, stateRoot, controlPlaneBin: join(CONTROL_PLANE_ROOT, "bin", "workflow.js") }, "claude"),
    payload: { session_id: "s-1", hook_event_name: "UserPromptSubmit" },
  });

  const after = await store.read(created.id);
  assert.equal(
    after.state,
    RUN_STATES.RUNNING,
    `the generated settings' hook did not advance the run. command: ${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.equal(after.generation, 1);
});

test("the generated Claude settings' UserPromptSubmit hook, pointed at a control-plane root with no hooks/ directory, leaves the run in LAUNCHING", async (t) => {
  if (!(await canRunShellInvokedHook())) {
    t.skip(SKIP_REASON);
    return;
  }

  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-claude-negative-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  // A control-plane root with no hooks/ subdirectory at all: buildClaudeWorkerSettings still
  // produces a well-formed command string pointing at a script that does not exist there, which
  // is exactly what a broken/misconfigured generator run would look like on disk.
  const missingHooksRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-claude-missing-hooks-"));
  t.after(() => rm(missingHooksRoot, { recursive: true, force: true }));

  const store = createRunStore({ stateRoot });
  const created = await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await store.update(created.id, () => ({ state: RUN_STATES.LAUNCHING }));
  const run = await store.read(created.id);

  const settings = buildClaudeWorkerSettings({ controlPlaneRoot: missingHooksRoot });
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;

  const result = await runHookCommand(command, {
    env: runEnv({ ...run, stateRoot, controlPlaneBin: join(CONTROL_PLANE_ROOT, "bin", "workflow.js") }, "claude"),
    payload: { session_id: "s-1", hook_event_name: "UserPromptSubmit" },
  });

  const after = await store.read(created.id);
  // Deliberately not asserting on result.code: hooks/claude-lifecycle.mjs's main() always sets
  // process.exitCode = 0 when it runs at all, and even node's own "module not found" failure for
  // a missing script is not something this suite may lean on -- only the run record distinguishes
  // "the hook ran and did its job" from "nothing happened here." code/stdout/stderr are captured
  // purely for the failure message.
  assert.equal(
    after.state,
    RUN_STATES.LAUNCHING,
    `expected a hook pointed at a control-plane root with no hooks/ directory to leave the run untouched. command: ${command}\ncode: ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.equal(after.generation, 1);
});

test("a control-plane root path containing a space does not break the generated command's double-quoted script path", async (t) => {
  if (!(await canRunShellInvokedHook())) {
    t.skip(SKIP_REASON);
    return;
  }

  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-claude-quoting-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  // mkdtemp appends its random suffix directly onto the prefix, so a prefix ending mid-word with
  // a trailing space guarantees the resulting directory name contains one.
  const spacedRoot = await mkdtemp(join(tmpdir(), "workflow hook ingestion quoting "));
  t.after(() => rm(spacedRoot, { recursive: true, force: true }));
  assert.ok(spacedRoot.includes(" "), `fixture bug: expected a space in ${spacedRoot}`);
  // Symlinking (rather than copying) the real hooks/ tree under the spaced root is enough to pin
  // the property under test -- the ROOT path containing a space, not the file contents. fs.rm
  // with recursive:true unlinks a symlink itself rather than following it, so cleanup below never
  // touches the real repo's hooks/ directory.
  await symlink(join(CONTROL_PLANE_ROOT, "hooks"), join(spacedRoot, "hooks"));

  const store = createRunStore({ stateRoot });
  const created = await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await store.update(created.id, () => ({ state: RUN_STATES.LAUNCHING }));
  const run = await store.read(created.id);

  const settings = buildClaudeWorkerSettings({ controlPlaneRoot: spacedRoot });
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(command, /"[^"]* [^"]*claude-lifecycle\.mjs"/, `expected the generated command to double-quote a spaced script path. command: ${command}`);

  const result = await runHookCommand(command, {
    env: runEnv({ ...run, stateRoot, controlPlaneBin: join(CONTROL_PLANE_ROOT, "bin", "workflow.js") }, "claude"),
    payload: { session_id: "s-1", hook_event_name: "UserPromptSubmit" },
  });

  const after = await store.read(created.id);
  assert.equal(
    after.state,
    RUN_STATES.RUNNING,
    `a control-plane root path containing a space broke the quoted hook command. command: ${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.equal(after.generation, 1);
});

// Codex analog of the three tests above. The difference is the path in: Codex has no
// per-invocation settings flag, so its hooks are merged into the shared global
// ~/.codex/hooks.json by ensureCodexWorkerHooks rather than written into a fresh per-run file.
// Going through ensureCodexWorkerHooks against a temp hooksPath and reading the result back
// covers the read-merge-write path (mergeCodexWorkerHooks plus the temp-file-and-rename write),
// not just the pure merge function workflow-codex-hooks.test.js already exercises.
test("the merged Codex hooks.json UserPromptSubmit entry, run as the harness runs it, drives LAUNCHING to RUNNING", async (t) => {
  if (!(await canRunShellInvokedHook())) {
    t.skip(SKIP_REASON);
    return;
  }

  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-codex-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  const store = createRunStore({ stateRoot });
  const created = await store.create({ harness: "codex", profileName: "codex-worker", generation: 1 });
  await store.update(created.id, () => ({ state: RUN_STATES.LAUNCHING }));
  const run = await store.read(created.id);

  const hooksPath = join(stateRoot, "codex-home", "hooks.json");
  // hooksPath must live under this test's own temp root -- never the real ~/.codex/hooks.json.
  assert.ok(hooksPath.startsWith(stateRoot), `fixture bug: hooksPath ${hooksPath} escaped the temp root ${stateRoot}`);
  // ensureCodexWorkerHooks writes hooksPath's temp-file-and-rename directly into its parent
  // directory; unlike the real ~/.codex/ (created by Codex itself), a fresh temp root has no
  // codex-home/ subdirectory yet.
  await mkdir(join(stateRoot, "codex-home"), { recursive: true });
  const realHooksPath = join(homedir(), ".codex", "hooks.json");
  const realBefore = await statOrNull(realHooksPath);

  await ensureCodexWorkerHooks({ hooksPath, controlPlaneRoot: CONTROL_PLANE_ROOT });
  const merged = JSON.parse(await readFile(hooksPath, "utf8"));
  // Find the workflow's own group by its owner marker, not by index: mergeCodexWorkerHooks
  // preserves foreign entries (e.g. Herdr's SessionStart hook) ahead of the workflow's own, so
  // index 0 is not guaranteed to be ours.
  const group = merged.hooks.UserPromptSubmit.find((entry) => entry.owner === CODEX_HOOK_OWNER);
  assert.ok(
    group,
    `expected a UserPromptSubmit group owned by ${CODEX_HOOK_OWNER} in the merged file: ${JSON.stringify(merged.hooks.UserPromptSubmit)}`,
  );
  const command = group.hooks[0].command;

  const result = await runHookCommand(command, {
    env: runEnv({ ...run, stateRoot, controlPlaneBin: join(CONTROL_PLANE_ROOT, "bin", "workflow.js") }, "codex"),
    payload: { session_id: "s-1", hook_event_name: "UserPromptSubmit" },
  });

  const after = await store.read(created.id);
  assert.equal(
    after.state,
    RUN_STATES.RUNNING,
    `the merged hooks.json entry did not advance the run. command: ${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.equal(after.generation, 1);

  const realAfter = await statOrNull(realHooksPath);
  assertRealCodexHooksUntouched(realBefore, realAfter, realHooksPath);
});

test("the merged Codex hooks.json UserPromptSubmit entry, pointed at a control-plane root with no hooks/ directory, leaves the run in LAUNCHING", async (t) => {
  if (!(await canRunShellInvokedHook())) {
    t.skip(SKIP_REASON);
    return;
  }

  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-codex-negative-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  // A control-plane root with no hooks/ subdirectory at all: ensureCodexWorkerHooks still merges
  // a well-formed command string pointing at a script that does not exist there, which is exactly
  // what a broken/misconfigured generator run would look like on disk.
  const missingHooksRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-codex-missing-hooks-"));
  t.after(() => rm(missingHooksRoot, { recursive: true, force: true }));

  const store = createRunStore({ stateRoot });
  const created = await store.create({ harness: "codex", profileName: "codex-worker", generation: 1 });
  await store.update(created.id, () => ({ state: RUN_STATES.LAUNCHING }));
  const run = await store.read(created.id);

  const hooksPath = join(stateRoot, "codex-home", "hooks.json");
  assert.ok(hooksPath.startsWith(stateRoot), `fixture bug: hooksPath ${hooksPath} escaped the temp root ${stateRoot}`);
  await mkdir(join(stateRoot, "codex-home"), { recursive: true });
  const realHooksPath = join(homedir(), ".codex", "hooks.json");
  const realBefore = await statOrNull(realHooksPath);

  await ensureCodexWorkerHooks({ hooksPath, controlPlaneRoot: missingHooksRoot });
  const merged = JSON.parse(await readFile(hooksPath, "utf8"));
  const group = merged.hooks.UserPromptSubmit.find((entry) => entry.owner === CODEX_HOOK_OWNER);
  assert.ok(
    group,
    `expected a UserPromptSubmit group owned by ${CODEX_HOOK_OWNER} in the merged file: ${JSON.stringify(merged.hooks.UserPromptSubmit)}`,
  );
  const command = group.hooks[0].command;

  const result = await runHookCommand(command, {
    env: runEnv({ ...run, stateRoot, controlPlaneBin: join(CONTROL_PLANE_ROOT, "bin", "workflow.js") }, "codex"),
    payload: { session_id: "s-1", hook_event_name: "UserPromptSubmit" },
  });

  const after = await store.read(created.id);
  // Deliberately not asserting on result.code -- see the identical comment on the Claude negative
  // test above; only the run record distinguishes "the hook ran and did its job" from "nothing
  // happened here."
  assert.equal(
    after.state,
    RUN_STATES.LAUNCHING,
    `expected a hook pointed at a control-plane root with no hooks/ directory to leave the run untouched. command: ${command}\ncode: ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.equal(after.generation, 1);

  const realAfter = await statOrNull(realHooksPath);
  assertRealCodexHooksUntouched(realBefore, realAfter, realHooksPath);
});
