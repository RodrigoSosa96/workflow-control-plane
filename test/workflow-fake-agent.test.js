import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createWorkflowFixture } from "../src/workflow/fixture.js";

async function tempParent() {
  return await mkdtemp(join(tmpdir(), "workflow-fake-"));
}

test("fake worker emits structured telemetry and writes handoff", async () => {
  const parent = await tempParent();
  const fixture = await createWorkflowFixture({
    root: join(parent, "fixture"),
    packageRoot: "/repo",
  });

  const runId = "11111111-1111-4111-8111-111111111111";
  const stateRoot = fixture.stateRoot;
  const runDir = join(stateRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "assignment.md"), "Edit fixture-single/src/index.js so the test passes.");

  // Pre-create a repo with a failing test
  const repoDir = join(fixture.root, "fixture-single");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.js"), "module.exports = () => 0;\n");
  await mkdir(join(repoDir, "test"), { recursive: true });
  await writeFile(
    join(repoDir, "test", "index.test.js"),
    'const assert = require("assert");\nconst fn = require("../src/index.js");\nassert.equal(fn(), 42);\n',
  );

  const fakeAgentPath = join(import.meta.dirname, "support", "fake-workflow-agent.js");

  const child = spawn(process.execPath, [fakeAgentPath], {
    env: {
      ...process.env,
      WORKFLOW_RUN_ID: runId,
      WORKFLOW_STATE_ROOT: stateRoot,
      WORKFLOW_RUN_DIR: runDir,
      WORKFLOW_HARNESS: "pi",
      WORKFLOW_GENERATION: "1",
      WORKFLOW_CONTROL_PLANE_BIN: "/bin/workflow.js",
    },
    cwd: repoDir,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  if (exitCode !== 0) console.error("FAKE STDERR:", stderr);

  const lines = stdout.trim().split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  assert.ok(events.some((e) => e.type === "turn_start" || e.type === "agent_start"));
  assert.ok(events.some((e) => e.type === "message_end"));
  assert.ok(events.some((e) => e.type === "agent_settled"));

  // No raw assignment text leaked in events
  const payload = JSON.stringify(events);
  assert.equal(payload.includes("Edit fixture-single"), false);

  const handoff = JSON.parse(await readFile(join(runDir, "handoff-input.json"), "utf8"));
  assert.equal(handoff.status, "completed");

  // Verify the file was edited
  const edited = await readFile(join(repoDir, "src", "index.js"), "utf8");
  assert.match(edited, /42/);

  // Verify local tests now pass
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("node", ["--test"], { cwd: repoDir });

  await rm(parent, { recursive: true, force: true });
});
