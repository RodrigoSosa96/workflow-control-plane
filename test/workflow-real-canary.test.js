import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";

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
  assert.match(stderr, /Unknown harness/);
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
