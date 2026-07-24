#!/usr/bin/env node
import { createWorkflowFixture as defaultCreateWorkflowFixture } from "../src/workflow/fixture.js";
import { cleanupWorkflowFixture } from "../src/workflow/fixture-cleanup.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir as mkdirAsync } from "node:fs/promises";
import { launchCommand as defaultLaunchCommand, resultCommand as defaultResultCommand, workerStatusCommand as defaultWorkerStatusCommand } from "../src/workflow/commands.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { lookupExecutable } from "../src/workflow/runtime-config.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { createHerdrAdapter } from "../src/workflow/herdr.js";
import { createProcessRunner } from "../src/workflow/process.js";
import { readFile as defaultReadFile } from "node:fs/promises";

const readPromptFile = defaultReadFile;

function parseArgs(argv) {
  const args = { fake: false, real: false, keep: false, agent: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fake") args.fake = true;
    else if (argv[i] === "--real") args.real = true;
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--agent") args.agent = argv[++i];
  }
  return args;
}

async function promptExactHarness(expected, { stdin, stdout }) {
  stdout.write(`This is a REAL canary. It will start an actual ${expected} harness and may consume tokens/API quota.\n`);
  stdout.write(`Type the exact harness name to confirm: ${expected}\n> `);
  return new Promise((resolve) => {
    stdin.once("data", (data) => resolve(data.toString().trim()));
  });
}

function isCiEnv(env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE);
}

async function assertRealModeAllowed(args, { env, stdin, stdout }) {
  const hasTty = env.WORKFLOW_SMOKE_TEST_TTY === "1" || (stdin.isTTY && stdout.isTTY);
  if (!hasTty) {
    throw new Error("Real canaries require a TTY");
  }
  if (!args.keep) {
    throw new Error("Real canaries require --keep");
  }
  if (!args.agent) {
    throw new Error("Real canaries require --agent <harness>");
  }
  if (args.agent !== "pi") {
    throw new Error(`Real canary for '${args.agent}' is not implemented; only 'pi' is supported`);
  }
  if (isCiEnv(env)) {
    throw new Error("Real canaries are interactive-only and cannot run in CI");
  }
  const confirmed = await promptExactHarness(args.agent, { stdin, stdout });
  if (confirmed !== args.agent) {
    throw new Error("Real canary was not confirmed");
  }
}

const CANARY_ASSIGNMENT = `This is a controlled Workflow canary. Perform exactly these steps:

1. Edit fixture.js so the exported value changes from "initial" to "implemented".
2. Update the matching assertion in test.js if needed.
3. Run \`node --test\` in this repository.
4. Submit the required structured workflow handoff for tickets FIX-101 and FIX-102.

Do not push, fetch, access secrets, alter permissions, close the workspace, or clean up resources.
Do not perform any work beyond the edit and test described above.`;

function printCanaryDisclosure(fixture, agent, stdout) {
  stdout.write("=== Workflow Real Canary ===\n");
  stdout.write(`Harness: ${agent}\n`);
  stdout.write(`Fixture root: ${fixture.root}\n`);
  stdout.write(`Registry: ${fixture.registryPath}\n`);
  stdout.write(`State root: ${fixture.stateRoot}\n`);
  stdout.write(`Tickets: FIX-101, FIX-102\n`);
  stdout.write("\nAssignment:\n");
  stdout.write(CANARY_ASSIGNMENT);
  stdout.write("\n\nWARNING: This will start a real Pi harness and may consume API tokens.\n");
  stdout.write("All resources will be preserved (--keep is required).\n\n");
}

async function writePromptFile(root) {
  await mkdirAsync(root, { recursive: true });
  const promptPath = join(root, "canary-prompt.txt");
  await writeFile(promptPath, CANARY_ASSIGNMENT);
  return promptPath;
}

async function runSmoke({ args, env, stdin, stdout, stderr, createWorkflowFixture, launchCommand, resultCommand, workerStatusCommand, readTelemetrySnapshot }) {
  try {
    if (!args.fake && !args.real) {
    stderr.write("USAGE: smoke-workflow-fixture --fake --keep | --real --agent pi --keep\n");
    return { code: 1 };
  }

  if (args.real) {
    try {
      await assertRealModeAllowed(args, { env, stdin, stdout });
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return { code: 1 };
    }
    const fixture = await createWorkflowFixture({
      root: join(tmpdir(), `workflow-smoke-real-${args.agent}-${Date.now()}-${randomUUID().slice(0, 8)}`),
      packageRoot: new URL("..", import.meta.url).pathname,
    });
    printCanaryDisclosure(fixture, args.agent, stdout);
    const promptPath = await writePromptFile(fixture.root);
    const { report } = await runWorkflowLaunch({ fixture, promptPath, agent: args.agent, env, launchCommand });
    if (report.status !== "running") {
      throw new Error(`Launch did not reach running state: ${report.status}`);
    }
    stdout.write(`Run created: ${report.runId}\n`);
    stdout.write(`Run directory: ${report.runDirectory}\n`);

    const poll = await pollCanaryCompletion({ runId: report.runId, fixture, env, stdout, resultCommand, workerStatusCommand });
    if (poll.outcome !== "completed") {
      throw new Error(`Canary did not complete: ${poll.outcome}`);
    }
    const workerId = poll.status.workers?.[0]?.workerId;
    if (workerId) {
      await inspectCanaryTelemetry({ fixture, runId: report.runId, workerId, readTelemetrySnapshot });
    }
    await inspectCanaryCompletion({ fixture });
    stdout.write("Canary completed successfully.\n");
    return { code: 0, fixture, promptPath, runId: report.runId, runDirectory: report.runDirectory };
  }

  // Fake mode
  const fixture = await createWorkflowFixture({
    root: join(tmpdir(), `workflow-smoke-${Date.now()}`),
    packageRoot: new URL("..", import.meta.url).pathname,
  });

  stdout.write(`Fixture created: ${fixture.root}\n`);
  stdout.write(`Registry: ${fixture.registryPath}\n`);
  stdout.write(`State root: ${fixture.stateRoot}\n`);
  stdout.write(`Projects: ${Object.keys(fixture.projects).join(", ")}\n`);
  stdout.write(
    `WORKFLOW_PROJECTS_FILE=${fixture.registryPath} node ${fixture.packageRoot}/bin/workflow.js launch fixture-single FIX-101 --dry-run\n`,
  );

  if (!args.keep) {
    await cleanupWorkflowFixture(fixture, { confirm: async () => true });
  }

  return { code: 0 };
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return { code: 1, error };
  }
}

function createLaunchDeps(fixture, env, overrides = {}) {
  const runner = overrides.runner ?? createProcessRunner();
  const stateRoot = fixture.stateRoot;
  return {
    env,
    runner,
    stateRoot,
    registryPath: fixture.registryPath,
    lookupExecutable: overrides.lookupExecutable ?? ((name) => lookupExecutable(name, { env })),
    git: overrides.git ?? createGitAdapter({ runner }),
    herdr: overrides.herdr ?? createHerdrAdapter({ runner }),
    store: overrides.store ?? createRunStore({ stateRoot }),
  };
}

async function runWorkflowLaunch({ fixture, promptPath, agent, env, launchCommand = defaultLaunchCommand, readFile = defaultReadFile }) {
  const request = await readFile(promptPath, "utf8");
  const deps = createLaunchDeps(fixture, env);
  const command = await launchCommand({
    command: "launch",
    projectAlias: "fixture-single",
    task: "FIX-101",
    tickets: ["FIX-102"],
    agentProfile: `${agent}-worker`,
    promptFile: promptPath,
    request,
    registryPath: fixture.registryPath,
    stateRoot: fixture.stateRoot,
    controlPlaneBin: join(fixture.packageRoot, "bin", "workflow.js"),
    dryRun: false,
    yes: true,
    approvalDigest: null,
    format: "json",
  }, deps);

  const preview = command.preview;
  const report = await command.execute({ approvalDigest: preview.approvalDigest });
  return { preview, report };
}

const CANARY_TIMEOUT_MS = 10 * 60 * 1000;
const CANARY_POLL_INTERVAL_MS = 5000;

function canarySleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCanaryCompletion({ runId, fixture, env, stdout, resultCommand = defaultResultCommand, workerStatusCommand = defaultWorkerStatusCommand }) {
  const deps = createLaunchDeps(fixture, env);
  const deadline = Date.now() + CANARY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await resultCommand({ runId, registryPath: fixture.registryPath, stateRoot: fixture.stateRoot }, deps);
    const status = await workerStatusCommand({ runId, registryPath: fixture.registryPath, stateRoot: fixture.stateRoot }, deps);

    const phase = status.workers?.[0]?.phase ?? "unknown";
    stdout.write(`[${new Date().toISOString()}] result=${result.status} worker=${phase}\n`);

    if (result.status === "completed") {
      return { outcome: "completed", result, status };
    }
    if (["needs-input", "manual-handoff-required"].includes(result.status) || ["failed", "unknown", "manual-recovery"].includes(phase)) {
      return { outcome: "terminal", result, status };
    }

    await canarySleep(CANARY_POLL_INTERVAL_MS);
  }

  return { outcome: "timeout" };
}

async function inspectCanaryCompletion({ fixture, readFile = defaultReadFile }) {
  const fixtureJs = await readFile(join(fixture.projects["fixture-single"].path, "fixture.js"), "utf8");
  const testJs = await readFile(join(fixture.projects["fixture-single"].path, "test.js"), "utf8");
  if (!fixtureJs.includes('"implemented"')) {
    throw new Error("Canary did not change fixture.js to 'implemented'");
  }
  if (!testJs.includes('"implemented"')) {
    throw new Error("Canary did not update test.js to expect 'implemented'");
  }
}

async function defaultReadTelemetrySnapshot(snapshotPath, { readFile = defaultReadFile } = {}) {
  const text = await readFile(snapshotPath, "utf8");
  const snapshot = JSON.parse(text);
  if (typeof snapshot.phase !== "string") {
    throw new Error("Telemetry snapshot is missing bounded phase field");
  }
  const json = JSON.stringify(snapshot);
  if (json.includes("prompt") || json.includes("sessionPath") || json.includes("toolArguments")) {
    throw new Error("Telemetry snapshot contains disallowed private fields");
  }
  return snapshot;
}

async function inspectCanaryTelemetry({ fixture, runId, workerId, readTelemetrySnapshot = defaultReadTelemetrySnapshot }) {
  const snapshotPath = join(fixture.stateRoot, runId, "telemetry", "workers", `${workerId}.json`);
  await readTelemetrySnapshot(snapshotPath);
}

export function createSmokeRunner(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const createWorkflowFixture = deps.createWorkflowFixture ?? defaultCreateWorkflowFixture;
  const launchCommand = deps.launchCommand ?? defaultLaunchCommand;
  const resultCommand = deps.resultCommand ?? defaultResultCommand;
  const workerStatusCommand = deps.workerStatusCommand ?? defaultWorkerStatusCommand;
  const readTelemetrySnapshot = deps.readTelemetrySnapshot ?? defaultReadTelemetrySnapshot;

  return {
    async run() {
      const args = parseArgs(argv);
      return runSmoke({
        args,
        env,
        stdin,
        stdout,
        stderr,
        createWorkflowFixture,
        launchCommand,
        resultCommand,
        workerStatusCommand,
        readTelemetrySnapshot,
      });
    },
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const runner = createSmokeRunner({ argv: args });
  const { code, error } = await runner.run();
  if (error) {
    console.error(error.message);
  }
  process.exit(code ?? (error ? 1 : 0));
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
