import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { createSmokeRunner, inspectCanaryCompletion } from "../scripts/smoke-workflow-fixture.js";
import { createWorkflowFixture } from "../src/workflow/fixture.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fakeFixture(root) {
  const sourcePath = join(root, "fixture-single");
  const worktreePath = join(root, "worktrees", "fixture-single", "FIX-101");
  const runDirectory = join(root, "state", "run-1");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDirectory, { recursive: true });

  // The base checkout is never edited; the agent does its work in the per-ticket worktree.
  await writeFile(join(sourcePath, "fixture.js"), 'export const value = "initial";\n');
  await writeFile(join(sourcePath, "test.js"), 'import { value } from "./fixture.js";\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("fixture value matches expectation", () => {\n  assert.equal(value, "initial");\n});\n');
  await writeFile(join(worktreePath, "fixture.js"), 'export const value = "implemented";\n');
  await writeFile(join(worktreePath, "test.js"), 'import { value } from "./fixture.js";\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("fixture value matches expectation", () => {\n  assert.equal(value, "implemented");\n});\n');
  await writeFile(join(runDirectory, "run.json"), JSON.stringify({
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/FIX-101" }],
  }));

  return {
    root,
    registryPath: join(root, "projects.yaml"),
    stateRoot: join(root, "state"),
    packageRoot: "/tmp/fake-package",
    projects: { "fixture-single": { path: sourcePath, tickets: ["FIX-101", "FIX-102"] } },
  };
}

function runSmoke(args, { stdin, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/smoke-workflow-fixture.js", ...args], {
      env: { ...process.env, NODE_ENV: "test", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("runner accepts injected env and streams", async () => {
  const lines = [];
  const runner = createSmokeRunner({
    argv: ["--fake"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdout: { write: (chunk) => lines.push(chunk) },
    stderr: { write: () => {} },
    stdin: { once: () => {}, isTTY: true },
  });
  assert.equal(typeof runner.run, "function");
});

test("fixture single repo contains canary edit target and test", async () => {
  const fixture = await createWorkflowFixture({
    root: join(tmpdir(), `workflow-canary-target-test-${Date.now()}`),
    packageRoot: new URL("..", import.meta.url).pathname,
  });
  const fixtureJs = await readFile(join(fixture.projects["fixture-single"].path, "fixture.js"), "utf8");
  const testJs = await readFile(join(fixture.projects["fixture-single"].path, "test.js"), "utf8");
  assert.match(fixtureJs, /export const value = "initial"/);
  assert.match(testJs, /assert\.equal\(value, "initial"\)/);
});

test("completion inspection reads the per-ticket worktree, not the untouched source checkout", async () => {
  const root = join(tmpdir(), `workflow-canary-worktree-${Date.now()}`);
  const sourcePath = join(root, "fixture-single");
  const worktreePath = join(root, "worktrees", "fixture-single", "FIX-101");
  const runDirectory = join(root, "state", "run-1");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDirectory, { recursive: true });

  // The base checkout is never edited; the agent works only in its worktree.
  await writeFile(join(sourcePath, "fixture.js"), 'export const value = "initial";\n');
  await writeFile(join(sourcePath, "test.js"), 'assert.equal(value, "initial");\n');
  await writeFile(join(worktreePath, "fixture.js"), 'export const value = "implemented";\n');
  await writeFile(join(worktreePath, "test.js"), 'assert.equal(value, "implemented");\n');
  await writeFile(join(runDirectory, "run.json"), JSON.stringify({
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/FIX-101" }],
  }));

  const fixture = { projects: { "fixture-single": { path: sourcePath } } };

  // Must pass by reading the worktree; reading the source would still say "initial".
  await inspectCanaryCompletion({ fixture, runDirectory });

  await rm(root, { recursive: true, force: true });
});

test("completion inspection fails when the worktree edit is missing", async () => {
  const root = join(tmpdir(), `workflow-canary-worktree-miss-${Date.now()}`);
  const worktreePath = join(root, "worktrees", "fixture-single", "FIX-101");
  const runDirectory = join(root, "state", "run-1");
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(worktreePath, "fixture.js"), 'export const value = "initial";\n');
  await writeFile(join(worktreePath, "test.js"), 'assert.equal(value, "initial");\n');
  await writeFile(join(runDirectory, "run.json"), JSON.stringify({
    repositories: [{ id: "primary", path: worktreePath, branch: "feature/FIX-101" }],
  }));

  await assert.rejects(
    inspectCanaryCompletion({ fixture: { projects: {} }, runDirectory }),
    /did not change fixture\.js/i,
  );

  await rm(root, { recursive: true, force: true });
});

test("--real requires TTY", async () => {
  const { code, stderr } = await runSmoke(["--real", "--agent", "pi", "--keep"]);
  assert.equal(code, 1);
  assert.match(stderr, /TTY/);
});

test("--real requires --keep", async () => {
  const { code, stderr } = await runSmoke(["--real", "--agent", "pi"], { env: { WORKFLOW_SMOKE_TEST_TTY: "1" } });
  assert.equal(code, 1);
  assert.match(stderr, /keep/);
});

test("--real rejects unknown harness", async () => {
  const { code, stderr } = await runSmoke(["--real", "--agent", "unknown", "--keep"], { env: { WORKFLOW_SMOKE_TEST_TTY: "1" } });
  assert.equal(code, 1);
  assert.match(stderr, /only 'pi' is supported|not implemented/i);
});

test("--real rejects non-pi agents", async () => {
  const { code, stderr } = await runSmoke(["--real", "--agent", "claude", "--keep"], { env: { WORKFLOW_SMOKE_TEST_TTY: "1" } });
  assert.equal(code, 1);
  assert.match(stderr, /Real canary for 'claude' is not implemented|only 'pi' is supported/i);
});

test("--real rejects CI environment", async () => {
  const { code, stderr } = await runSmoke(["--real", "--agent", "pi", "--keep"], { env: { WORKFLOW_SMOKE_TEST_TTY: "1", CI: "true" } });
  assert.equal(code, 1);
  assert.match(stderr, /interactive-only|CI/i);
});

test("real-mode path builds fixture registry launch options", async () => {
  let captured = null;
  const fixtureRoot = join(tmpdir(), `workflow-canary-launch-test-${Date.now()}`);
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: { isTTY: true, once: (_event, handler) => handler("pi\n") },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    createWorkflowFixture: async () => fakeFixture(fixtureRoot),
    launchCommand: async (options) => {
      captured = options;
      return {
        preview: { approvalDigest: "sha256:test" },
        execute: async () => ({ status: "running", runId: "11111111-1111-4111-8111-111111111111", runDirectory: join(fixtureRoot, "state", "run-1") }),
      };
    },
    resultCommand: async () => ({ status: "completed", result: { verification: [{ command: "node --test", status: "passed" }] } }),
    workerStatusCommand: async () => ({ workers: [{ phase: "settled", workerId: "worker-1" }] }),
    readTelemetrySnapshot: async () => ({ phase: "settled", harness: "pi" }),
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.equal(captured.projectAlias, "fixture-single");
  assert.equal(captured.task, "FIX-101");
  assert.deepEqual(captured.tickets, ["FIX-102"]);
  assert.equal(captured.agentProfile, "pi-worker");
  assert.equal(captured.registryPath, join(fixtureRoot, "projects.yaml"));
  assert.equal(captured.stateRoot, join(fixtureRoot, "state"));
  assert.ok(captured.controlPlaneBin.endsWith("bin/workflow.js"));
  assert.ok(captured.request);
  assert.match(captured.request, /controlled Workflow canary/);
});

test("poll completes on current completed result", async () => {
  const resultCalls = [];
  const fixtureRoot = join(tmpdir(), `workflow-canary-poll-test-${Date.now()}`);
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: { isTTY: true, once: (_event, handler) => handler("pi\n") },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    createWorkflowFixture: async () => fakeFixture(fixtureRoot),
    launchCommand: async () => ({
      preview: { approvalDigest: "sha256:test" },
      execute: async () => ({ status: "running", runId: "run-1", runDirectory: join(fixtureRoot, "state", "run-1") }),
    }),
    resultCommand: async ({ runId }) => {
      resultCalls.push(runId);
      return { status: "completed", result: { verification: [{ command: "node --test", status: "passed" }] } };
    },
    workerStatusCommand: async () => ({ workers: [{ phase: "settled" }] }),
    readTelemetrySnapshot: async () => ({ phase: "settled", harness: "pi" }),
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.deepEqual(resultCalls, ["run-1"]);
});

test("poll stops on needs-input and preserves fixture", async () => {
  const fixtureRoot = join(tmpdir(), `workflow-canary-needs-input-test-${Date.now()}`);
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: { isTTY: true, once: (_event, handler) => handler("pi\n") },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    createWorkflowFixture: async () => fakeFixture(fixtureRoot),
    launchCommand: async () => ({
      preview: { approvalDigest: "sha256:test" },
      execute: async () => ({ status: "running", runId: "run-1", runDirectory: join(fixtureRoot, "state", "run-1") }),
    }),
    resultCommand: async () => ({ status: "needs-input" }),
    workerStatusCommand: async () => ({ workers: [{ phase: "running" }] }),
  });
  const { code } = await runner.run();
  assert.notEqual(code, 0);
});

test("poll continues through unknown worker phase", async () => {
  const fixtureRoot = join(tmpdir(), `workflow-canary-unknown-phase-test-${Date.now()}`);
  let calls = 0;
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: { isTTY: true, once: (_event, handler) => handler("pi\n") },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    createWorkflowFixture: async () => fakeFixture(fixtureRoot),
    launchCommand: async () => ({
      preview: { approvalDigest: "sha256:test" },
      execute: async () => ({ status: "running", runId: "run-1", runDirectory: join(fixtureRoot, "state", "run-1") }),
    }),
    resultCommand: async () => {
      calls += 1;
      return { status: calls >= 2 ? "completed" : "pending" };
    },
    workerStatusCommand: async () => ({ workers: [{ phase: "unknown" }] }),
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.ok(calls >= 2);
});

test("completed canary validates telemetry snapshot is bounded", async () => {
  let inspectedPath = null;
  const fixtureRoot = join(tmpdir(), `workflow-canary-telemetry-test-${Date.now()}`);
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: { isTTY: true, once: (_event, handler) => handler("pi\n") },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    createWorkflowFixture: async () => fakeFixture(fixtureRoot),
    launchCommand: async () => ({
      preview: { approvalDigest: "sha256:test" },
      execute: async () => ({ status: "running", runId: "run-1", runDirectory: join(fixtureRoot, "state", "run-1") }),
    }),
    resultCommand: async () => ({ status: "completed", result: { verification: [{ command: "node --test", status: "passed" }] } }),
    workerStatusCommand: async () => ({ workers: [{ phase: "settled", workerId: "worker-1" }] }),
    readTelemetrySnapshot: async (path) => {
      inspectedPath = path;
      return { phase: "settled", harness: "pi" };
    },
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.equal(inspectedPath, join(fixtureRoot, "state", "run-1", "telemetry", "workers", "worker-1.json"));
});

test("--real rejects wrong typed harness confirmation", async () => {
  const { code, stderr } = await runSmoke(["--real", "--agent", "pi", "--keep"], { stdin: "claude\n", env: { WORKFLOW_SMOKE_TEST_TTY: "1" } });
  assert.equal(code, 1);
  assert.match(stderr, /not confirmed/);
});

test("--fake creates a fixture and cleans up without --keep", async () => {
  const { code, stdout } = await runSmoke(["--fake"]);
  assert.equal(code, 0);
  assert.match(stdout, /Fixture created:/);
  assert.match(stdout, /Registry:/);

  const match = stdout.match(/Fixture created:\s*(\S+)/);
  assert.ok(match, "expected fixture root path in stdout");
  const fixtureRoot = match[1];
  await assert.rejects(
    () => access(fixtureRoot),
    /ENOENT/,
    "fixture root should have been cleaned up",
  );
});

test("--fake --keep preserves the fixture", async () => {
  const { code, stdout } = await runSmoke(["--fake", "--keep"]);
  assert.equal(code, 0);
  const match = stdout.match(/Fixture created:\s*(\S+)/);
  assert.ok(match);
  const fixtureRoot = match[1];
  await assert.doesNotReject(() => access(fixtureRoot));
  // Clean up after verifying --keep behavior.
  await rm(fixtureRoot, { recursive: true, force: true });
});
