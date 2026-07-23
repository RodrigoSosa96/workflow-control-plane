import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { createSmokeRunner } from "../scripts/smoke-workflow-fixture.js";
import { createWorkflowFixture } from "../src/workflow/fixture.js";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: { isTTY: true, once: (_event, handler) => handler("pi\n") },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    createWorkflowFixture: async () => ({
      root: "/tmp/fake-fixture",
      registryPath: "/tmp/fake-fixture/projects.yaml",
      stateRoot: "/tmp/fake-fixture/state",
      packageRoot: "/tmp/fake-package",
      projects: { "fixture-single": { path: "/tmp/fake-fixture/fixture-single", tickets: ["FIX-101", "FIX-102"] } },
    }),
    launchCommand: async (options) => {
      captured = options;
      return {
        preview: { approvalDigest: "sha256:test" },
        execute: async () => ({ status: "running", runId: "11111111-1111-4111-8111-111111111111", runDirectory: "/tmp/run-1" }),
      };
    },
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.equal(captured.projectAlias, "fixture-single");
  assert.equal(captured.task, "FIX-101");
  assert.deepEqual(captured.tickets, ["FIX-102"]);
  assert.equal(captured.agentProfile, "pi-worker");
  assert.equal(captured.registryPath, "/tmp/fake-fixture/projects.yaml");
  assert.equal(captured.stateRoot, "/tmp/fake-fixture/state");
  assert.ok(captured.controlPlaneBin.endsWith("bin/workflow.js"));
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
