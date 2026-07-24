#!/usr/bin/env node
import { createRunStore } from "../src/workflow/run-store.js";
import { createHarnessSupervisor } from "../src/workflow/harness-supervisor.js";
import { createTelemetryAdapter } from "../src/workflow/telemetry-adapters.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { sha256Digest } from "../src/workflow/launch.js";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { WorkflowError } from "../src/workflow/errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message, details) {
  const error = new WorkflowError("PROCESS", message, { details });
  error.name = "WorkflowWorkerError";
  throw error;
}

export function parseArgs(raw) {
  const args = raw.slice(2);
  const runArg = args.indexOf("--run");
  const workerArg = args.indexOf("--worker");
  if (runArg < 0 || workerArg < 0 || args.length !== 4) {
    fail("USAGE: workflow-worker --run <run-id> --worker <worker-id>");
  }
  const runId = args[runArg + 1];
  const workerId = args[workerArg + 1];
  if (!UUID_PATTERN.test(runId)) fail(`Invalid run-id: ${runId}`);
  if (!UUID_PATTERN.test(workerId)) fail(`Invalid worker-id: ${workerId}`);
  const forbidden = ["--command", "--argv", "--cwd", "--env", "--session"];
  for (const flag of forbidden) {
    if (args.includes(flag)) fail(`Unsupported argument: ${flag}`);
  }
  return { runId, workerId };
}

export async function main(rawArgv = process.argv, { spawn: spawnChild = spawn, env = process.env, createStore = createRunStore, createSupervisor = createHarnessSupervisor, createTelemetry = createTelemetryStore, stdout = process.stdout, stderr = process.stderr } = {}) {
  let runId, workerId;
  try {
    ({ runId, workerId } = parseArgs(rawArgv));
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }

  const stateRoot = env.WORKFLOW_STATE_ROOT;
  if (!stateRoot) {
    stderr.write("Missing WORKFLOW_STATE_ROOT environment variable\n");
    return 1;
  }

  try {
    const store = createStore({ stateRoot });
    const run = await store.read(runId);
    if (!run) fail(`Run ${runId} not found`);
    if (run.fixtureMode !== true) fail(`Run ${runId} is not in fixture mode`);
    const launchMeta = run.workerLaunches?.[workerId];
    if (!launchMeta) fail(`Worker launch ${workerId} not found for run ${runId}`);

    const recordPath = join(run.directory, "worker-launches", `${workerId}.json`);
    if (!existsSync(recordPath)) fail(`Launch record not found at ${recordPath}`);
    const recordText = readFileSync(recordPath, "utf8");
    const digest = sha256Digest(recordText);
    if (digest !== launchMeta.digest) fail(`Launch record digest mismatch for worker ${workerId}`);

    const record = JSON.parse(recordText);
    if (launchMeta.harness && record.harness !== launchMeta.harness) {
      fail(`Launch record harness mismatch: expected ${launchMeta.harness}`);
    }

    const telemetry = createTelemetry({ store });
    const supervisor = createSupervisor({ spawn: spawnChild, telemetry, createAdapter: createTelemetryAdapter });
    const result = await supervisor.run({ runId, workerId, launch: record });
    return result.exitCode ?? 1;
  } catch (error) {
    stderr.write(`workflow-worker: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === process.argv[1]) {
  const code = await main();
  process.exit(code);
}
