#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const runDir = process.env.WORKFLOW_RUN_DIR;
const stateRoot = process.env.WORKFLOW_STATE_ROOT;
const runId = process.env.WORKFLOW_RUN_ID;

async function main() {
  if (!runDir || !stateRoot || !runId) {
    console.error("Missing WORKFLOW_RUN_DIR, WORKFLOW_STATE_ROOT, or WORKFLOW_RUN_ID");
    process.exit(1);
  }

  const assignment = await readFile(join(runDir, "assignment.md"), "utf8");

  const runPath = join(runDir, "run.json");
  let runTickets = [];
  try {
    const runData = JSON.parse(await readFile(runPath, "utf8"));
    runTickets = (Array.isArray(runData.tickets) ? runData.tickets : [])
      .map((id) => ({ id, status: "completed", evidence: ["fake-worker-test-passed"] }));
  } catch {
    runTickets = [];
  }

  let repoName = "fixture-single";
  if (assignment.includes("fixture-bundle")) repoName = "fixture-bundle";

  const repoPath = join(runDir, "..", "..", repoName);

  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(join(repoPath, "src", "index.js"), "module.exports = () => 42;\n");

  await mkdir(join(repoPath, "test"), { recursive: true });
  await writeFile(
    join(repoPath, "test", "index.test.js"),
    'const assert = require("assert");\nconst fn = require("../src/index.js");\nassert.equal(fn(), 42);\n',
  );

  console.log(JSON.stringify({ type: "turn_start" }));
  console.log(JSON.stringify({ type: "tool_execution_start", toolName: "edit_file" }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1" }));

  await execFileAsync("node", ["--test"], { cwd: repoPath });

  console.log(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      model: "fake-model",
      usage: { input_tokens: 10, output_tokens: 5, cost: { total: 0.001 } },
    },
  }));
  console.log(JSON.stringify({ type: "agent_settled" }));

  await writeFile(
    join(runDir, "handoff-input.json"),
    JSON.stringify({
      version: 1,
      status: "completed",
      generation: 1,
      summary: "Fake worker completed fixture task",
      tickets: runTickets,
      changedFiles: ["src/index.js", "test/index.test.js"],
      verification: [{ command: "node --test", status: "passed", summary: "tests passed" }],
      concerns: [],
      decisions: [],
      nextAction: "await-coordinator",
    }, null, 2) + "\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
