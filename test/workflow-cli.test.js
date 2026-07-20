import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WorkflowError } from "../src/workflow/errors.js";
import { main, parseArgs } from "../bin/workflow.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const io = () => {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
};

function planPreview(overrides = {}) {
  return {
    command: "plan",
    project: { alias: "ocr", label: "ExampleProject" },
    preconditions: {
      git: { status: "ready", path: "/usr/bin/git" },
      herdr: { status: "ready", path: "/usr/bin/herdr" },
      pi: { status: "ready", path: "/usr/bin/pi" },
      herdrStatus: { id: "herdr:status", status: "ready" },
      piIntegration: { id: "herdr:integration:pi", status: "ready" },
    },
    reconciliation: {
      status: "incomplete",
      conflicts: [],
      operations: [],
    },
    conflicts: [],
    nextCommand: 'workflow start ocr ASANA-123 --feature "Discovered Docs" --yes',
    ...overrides,
  };
}

function executionReport(overrides = {}) {
  return {
    mode: "ordinary",
    status: "completed",
    operations: [{ id: "worktree", kind: "herdr.worktree.ensure", status: "created" }],
    guidance: [],
    notes: [],
    ...overrides,
  };
}

const RUN_ID = "55555555-5555-4555-8555-555555555555";
const APPROVAL_DIGEST = `sha256:${"1".repeat(64)}`;
const RAW_REQUEST = "Fix `mail` exactly.\n\n$(touch /tmp/no)\nDo not paraphrase this.";

function launchPreview(overrides = {}) {
  return {
    command: "launch",
    project: { alias: "ocr", label: "ExampleProject" },
    request: {
      task: "ASANA-123",
      tickets: ["ASANA-123", "ASANA-140"],
      relatedTickets: ["ASANA-140"],
      feature: null,
      repositories: [],
      runtimeProfile: null,
    },
    selection: {
      profileName: "pi-worker",
      harness: "pi",
      permissions: {},
    },
    reconciliation: {
      identity: {
        projectAlias: "ocr",
        projectLabel: "ExampleProject",
        task: "ASANA-123",
        primaryTicket: "ASANA-123",
        relatedTickets: ["ASANA-140"],
        tickets: ["ASANA-123", "ASANA-140"],
      },
      workspace: { path: "/worktrees/ocr/ASANA-123" },
      worktrees: [{ path: "/worktrees/ocr/ASANA-123" }],
      operations: [],
    },
    executionInput: { options: { stateRoot: "/state/workflow" } },
    approvalDigest: APPROVAL_DIGEST,
    assignmentDigest: `sha256:${"2".repeat(64)}`,
    assignment: `# Assignment\n\nBEGIN ORIGINAL REQUEST\n${RAW_REQUEST}\nEND ORIGINAL REQUEST\n`,
    operations: [],
    conflicts: [],
    ...overrides,
  };
}

function launchReport(overrides = {}) {
  return {
    command: "launch",
    status: "running",
    runId: RUN_ID,
    runDirectory: `/state/workflow/${RUN_ID}`,
    state: "running",
    harness: "pi",
    profileName: "pi-worker",
    workspace: { path: "/worktrees/ocr/ASANA-123" },
    tabId: "tab-1",
    paneId: "pane-1",
    resultCommand: `workflow result ${RUN_ID}`,
    statusCommand: "workflow status ocr ASANA-123 --tickets ASANA-140",
    reconcileCommand: `workflow reconcile --run ${RUN_ID}`,
    fallbackWorkspace: "/worktrees/ocr/ASANA-123",
    operations: [{ id: "agent", kind: "agent.session.start", status: "created", tabId: "tab-1", paneId: "pane-1" }],
    guidance: [`workflow reconcile --run ${RUN_ID}`],
    notes: [],
    ...overrides,
  };
}

test("installed symlink executes the workflow entry point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-cli-link-"));
  const registryPath = join(dir, "projects.yaml");
  const link = join(dir, "workflow");
  await writeFile(registryPath, `version: 2\nlauncher:\n  worktree_root: /tmp/worktrees\n  agent:\n    command: pi\n    session_template: "{project}-{task}-{slug}"\nprojects:\n  ocr:\n    label: ExampleProject\n    kind: personal\n    path: /tmp/ocr\n    repository: monorepo\n    base_branch: main\n    worktree:\n      branch_template: "feature/{task}/{slug}"\n      path_template: "{worktree_root}/{project}/{task}-{slug}"\n`);
  await symlink(new URL("../bin/workflow.js", import.meta.url), link);
  const result = spawnSync(link, ["help"], {
    encoding: "utf8",
    env: { ...process.env, WORKFLOW_PROJECTS_FILE: registryPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workflow doctor \[project\]/);
  assert.match(result.stdout, /workflow plan <project> <task> .*--tickets <csv>/);
  assert.match(result.stdout, /workflow start <project> <task> .*--tickets <csv>/);
  assert.match(result.stdout, /workflow launch <project> <primary-ticket> .*--prompt-file <path>/);
  assert.match(result.stdout, /workflow result <run-id>/);
  assert.match(result.stdout, /workflow reconcile \[project\] --run <run-id>/);
  assert.match(result.stdout, /workflow runtime <project> <task> .*--tickets <csv>/);
  assert.match(result.stdout, /workflow status <project> <task> .*--tickets <csv>/);
  const doctorLine = result.stdout.split(/\r?\n/u).find((line) => line.includes("workflow doctor"));
  assert.doesNotMatch(doctorLine, /--tickets/);
});

test("parses documented workflow commands and options", () => {
  assert.deepEqual(parseArgs(["doctor", "ocr", "--agent", "codex-worker"]), {
    command: "doctor",
    projectAlias: "ocr",
    agentProfile: "codex-worker",
    format: "compact",
  });

  assert.deepEqual(parseArgs(["plan", "acme", "ASANA-456", "--feature", "Onboarding", "--repos", "backend,panel", "--tickets", "ASANA-499,ASANA-460,ASANA-460", "--format", "json"]), {
    command: "plan",
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["backend", "panel"],
    tickets: ["ASANA-499", "ASANA-460", "ASANA-460"],
    format: "json",
  });

  assert.deepEqual(parseArgs(["start", "ocr", "ASANA-123", "--feature", "Discovered Docs", "--tickets", "ASANA-150,ASANA-140", "--agent", "codex-worker", "--yes"]), {
    command: "start",
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "Discovered Docs",
    tickets: ["ASANA-150", "ASANA-140"],
    agentProfile: "codex-worker",
    yes: true,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["runtime", "ocr", "ASANA-123", "--feature", "Discovered Docs", "--tickets", "ASANA-150,ASANA-140", "--profile", "standard", "--yes"]), {
    command: "runtime",
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "Discovered Docs",
    tickets: ["ASANA-150", "ASANA-140"],
    runtimeProfile: "standard",
    yes: true,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["status", "ocr", "ASANA-123", "--tickets", "ASANA-150,ASANA-140"]), {
    command: "status",
    projectAlias: "ocr",
    task: "ASANA-123",
    tickets: ["ASANA-150", "ASANA-140"],
    format: "compact",
  });

  assert.deepEqual(parseArgs(["launch", "acme", "SHARY-123", "--tickets", "SHARY-140,SHARY-152", "--repos", "backend,panel", "--agent", "claude-worker", "--prompt-file", "/tmp/request.md", "--dry-run", "--format", "json"]), {
    command: "launch",
    projectAlias: "acme",
    task: "SHARY-123",
    tickets: ["SHARY-140", "SHARY-152"],
    repositories: ["backend", "panel"],
    agentProfile: "claude-worker",
    promptFile: "/tmp/request.md",
    dryRun: true,
    format: "json",
  });

  assert.deepEqual(parseArgs(["result", RUN_ID]), {
    command: "result",
    runId: RUN_ID,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["reconcile", "acme", "--run", RUN_ID, "--format", "json"]), {
    command: "reconcile",
    projectAlias: "acme",
    runId: RUN_ID,
    format: "json",
  });

  assert.deepEqual(parseArgs(["handoff", RUN_ID, "--input", "/state/run/handoff-input.json"]), {
    command: "handoff",
    runId: RUN_ID,
    input: "/state/run/handoff-input.json",
    format: "compact",
  });
});

test("rejects unknown, duplicate, and disallowed options", () => {
  assert.throws(() => parseArgs(["doctor", "ocr", "--yes"]), /does not accept --yes/i);
  assert.throws(() => parseArgs(["doctor", "ocr", "--tickets", "ASANA-150"]), /does not accept --tickets/i);
  assert.throws(() => parseArgs(["status", "ocr", "ASANA-123", "--yes"]), /does not accept --yes/i);
  assert.throws(() => parseArgs(["result", RUN_ID, "--yes"]), /result does not accept --yes/i);
  assert.throws(() => parseArgs(["result", RUN_ID, "--prompt-file", "/tmp/request.md"]), /result does not accept --prompt-file/i);
  assert.throws(() => parseArgs(["reconcile", "--run", RUN_ID, "--yes"]), /reconcile does not accept --yes/i);
  assert.throws(() => parseArgs(["launch", "ocr", "ASANA-123", "--prompt", "SECRET-DO-NOT-LEAK"]), /Unknown option: --prompt/i);
  assert.throws(() => parseArgs(["launch", "ocr", "ASANA-123", "--dry-run"]), /prompt-file/i);
  assert.throws(() => parseArgs(["start", "ocr", "ASANA-123", "--profile", "standard"]), /does not accept --profile/i);
  assert.throws(() => parseArgs(["plan", "ocr", "ASANA-123", "--format", "xml"]), /compact or json/i);
  assert.throws(() => parseArgs(["plan", "ocr", "ASANA-123", "--feature", "One", "--feature", "Two"]), /Duplicate option/i);
  assert.throws(() => parseArgs(["plan", "ocr", "ASANA-123", "--bogus"]), /Unknown option: --bogus/i);
  assert.throws(() => parseArgs(["runtime", "ocr", "ASANA-123", "junk"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["doctor", "ocr", "extra"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["handoff", RUN_ID]), /--input|input|required/i);
  assert.throws(() => parseArgs(["handoff", RUN_ID, "--input", "/state/run/not-handoff.json"]), /handoff-input\.json|canonical/i);
});

test("doctor uses the package registry by default and honors WORKFLOW_PROJECTS_FILE", async () => {
  const output = io();
  const seen = [];
  const doctorResult = {
    command: "doctor",
    project: { alias: "ocr", label: "ExampleProject" },
    checks: [],
    ok: true,
  };

  const baseDependencies = {
    ...output,
    doctorCommand: async (options) => {
      seen.push(options.registryPath);
      return doctorResult;
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.ok}`,
  };

  assert.equal(await main(["doctor", "ocr"], baseDependencies), 0);
  assert.equal(seen[0], join(packageRoot, "projects.yaml"));

  assert.equal(await main(["doctor", "ocr"], {
    ...baseDependencies,
    env: { WORKFLOW_PROJECTS_FILE: "/tmp/custom-projects.yaml" },
  }), 0);
  assert.equal(seen[1], "/tmp/custom-projects.yaml");
});

test("main runs the canonical handoff command without mutation confirmation", async () => {
  const output = io();
  const calls = [];
  const runId = RUN_ID;
  const code = await main(["handoff", runId, "--input", "/state/run/handoff-input.json"], {
    ...output,
    env: {
      WORKFLOW_RUN_ID: runId,
      WORKFLOW_RUN_DIR: "/state/run",
      WORKFLOW_STATE_ROOT: "/state",
    },
    handoffCommand: async (options) => {
      calls.push(options);
      return { version: 1, runId, generation: 1, status: "completed" };
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    command: "handoff",
    runId,
    input: "/state/run/handoff-input.json",
    format: "compact",
    registryPath: join(packageRoot, "projects.yaml"),
    env: {
      WORKFLOW_RUN_ID: runId,
      WORKFLOW_RUN_DIR: "/state/run",
      WORKFLOW_STATE_ROOT: "/state",
    },
  }]);
  assert.deepEqual(output.stdout, ["handoff:compact:completed"]);
  assert.deepEqual(output.stderr, []);
});

test("launch dry-run reads only --prompt-file, prints the approved assignment preview, and mutates nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-launch-cli-"));
  const promptFile = join(dir, "request $(touch should-not-run).md");
  await writeFile(promptFile, RAW_REQUEST);
  const output = io();
  const calls = [];

  const code = await main(["launch", "ocr", "ASANA-123", "--tickets", "ASANA-140", "--prompt-file", promptFile, "--dry-run", "--format", "json"], {
    ...output,
    launchCommand: async (options) => {
      calls.push({ kind: "launchCommand", options });
      assert.equal(options.request, RAW_REQUEST);
      assert.equal(options.promptFile, promptFile);
      return {
        preview: launchPreview(),
        async execute() {
          calls.push({ kind: "execute" });
          return launchReport();
        },
      };
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.approvalDigest}\n${value.assignment}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.kind), ["launchCommand"]);
  assert.match(output.stdout[0], new RegExp(APPROVAL_DIGEST));
  assert.match(output.stdout[0], /BEGIN ORIGINAL REQUEST/);
  assert.match(output.stdout[0], /Do not paraphrase this/);
  assert.deepEqual(output.stderr, []);
});

test("launch rejects absent, empty, NUL, and oversized prompt-file input before command mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-launch-invalid-"));
  const emptyFile = join(dir, "empty.md");
  const nulFile = join(dir, "nul.md");
  const invalidUtf8File = join(dir, "invalid-utf8.md");
  const largeFile = join(dir, "large.md");
  await writeFile(emptyFile, "");
  await writeFile(nulFile, "safe prefix\0SECRET-DO-NOT-LEAK");
  await writeFile(invalidUtf8File, Buffer.from([0x66, 0xff, 0x67]));
  await writeFile(largeFile, `SECRET-DO-NOT-LEAK-${"x".repeat(70 * 1024)}`);

  for (const argv of [
    ["launch", "ocr", "ASANA-123", "--dry-run"],
    ["launch", "ocr", "ASANA-123", "--prompt-file", emptyFile, "--dry-run"],
    ["launch", "ocr", "ASANA-123", "--prompt-file", nulFile, "--dry-run"],
    ["launch", "ocr", "ASANA-123", "--prompt-file", invalidUtf8File, "--dry-run"],
    ["launch", "ocr", "ASANA-123", "--prompt-file", largeFile, "--dry-run"],
  ]) {
    const output = io();
    let called = false;
    const code = await main(argv, {
      ...output,
      launchCommand: async () => {
        called = true;
        return { preview: launchPreview(), execute: async () => launchReport() };
      },
    });

    assert.equal(code, 64, argv.join(" "));
    assert.equal(called, false, argv.join(" "));
    assert.match(output.stderr[0], /prompt-file|request|empty|NUL|UTF-8|limit|required/i);
    assert.doesNotMatch(output.stderr[0], /SECRET-DO-NOT-LEAK/);
  }
});

test("launch requires confirmation for mutation and executes with the current approval digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-launch-confirm-"));
  const promptFile = join(dir, "request.md");
  await writeFile(promptFile, RAW_REQUEST);
  const output = io();
  const calls = [];

  const code = await main(["launch", "ocr", "ASANA-123", "--prompt-file", promptFile], {
    ...output,
    isInteractive: () => true,
    launchCommand: async (options) => {
      calls.push({ kind: "launchCommand", options });
      return {
        preview: launchPreview(),
        async execute(executeOptions) {
          calls.push({ kind: "execute", executeOptions });
          assert.equal(executeOptions.approvalDigest, APPROVAL_DIGEST);
          return launchReport();
        },
      };
    },
    confirm: async ({ command, previewText }) => {
      calls.push({ kind: "confirm", command, previewText });
      assert.equal(command, "launch");
      assert.match(previewText, new RegExp(APPROVAL_DIGEST));
      return true;
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.approvalDigest ?? value.status}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.kind), ["launchCommand", "confirm", "execute"]);
  assert.deepEqual(output.stderr, [`launch:compact:${APPROVAL_DIGEST}`]);
  assert.deepEqual(output.stdout, ["launch:compact:running"]);
});

test("launch --yes requires an approval digest and passes it to Task 6 execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-launch-yes-"));
  const promptFile = join(dir, "request.md");
  await writeFile(promptFile, RAW_REQUEST);

  const rejected = io();
  let rejectedCalled = false;
  assert.equal(await main(["launch", "ocr", "ASANA-123", "--prompt-file", promptFile, "--yes"], {
    ...rejected,
    isInteractive: () => false,
    launchCommand: async () => {
      rejectedCalled = true;
      return { preview: launchPreview(), execute: async () => launchReport() };
    },
  }), 64);
  assert.equal(rejectedCalled, false);
  assert.match(rejected.stderr[0], /approval-digest/i);

  const accepted = io();
  const calls = [];
  assert.equal(await main(["launch", "ocr", "ASANA-123", "--prompt-file", promptFile, "--yes", "--approval-digest", APPROVAL_DIGEST], {
    ...accepted,
    isInteractive: () => false,
    launchCommand: async () => ({
      preview: launchPreview(),
      async execute(executeOptions) {
        calls.push(executeOptions);
        return launchReport();
      },
    }),
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status}`,
  }), 0);
  assert.deepEqual(calls, [{ approvalDigest: APPROVAL_DIGEST }]);
  assert.deepEqual(accepted.stdout, ["launch:compact:running"]);
});

test("result uses stable non-success exits for pending, stale, and manual cases", async () => {
  const cases = [
    ["pending", 20],
    ["result-stale", 21],
    ["manual-handoff-required", 22],
  ];

  for (const [status, expectedCode] of cases) {
    const output = io();
    const code = await main(["result", RUN_ID], {
      ...output,
      resultCommand: async (options) => ({ command: "result", runId: options.runId, status, exitCode: expectedCode }),
      formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status}`,
    });
    assert.equal(code, expectedCode);
    assert.deepEqual(output.stdout, [`result:compact:${status}`]);
    assert.deepEqual(output.stderr, []);
  }

  const terminal = io();
  assert.equal(await main(["result", RUN_ID], {
    ...terminal,
    resultCommand: async () => ({ command: "result", runId: RUN_ID, status: "completed", exitCode: 0 }),
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status}`,
  }), 0);
  assert.deepEqual(terminal.stdout, ["result:compact:completed"]);
});

test("reconcile is read-only, accepts --run, and emits exact safe next actions", async () => {
  const output = io();
  const calls = [];
  const code = await main(["reconcile", "ocr", "--run", RUN_ID, "--format", "json"], {
    ...output,
    reconcileCommand: async (options) => {
      calls.push(options);
      return {
        command: "reconcile",
        runId: options.runId,
        projectAlias: options.projectAlias,
        status: "pending",
        nextActions: [
          `workflow result ${RUN_ID}`,
          `workflow status ocr ASANA-123 --tickets ASANA-140`,
          `workflow handoff ${RUN_ID} --input /state/workflow/${RUN_ID}/handoff-input.json`,
        ],
      };
    },
    executeStart: async () => {
      throw new Error("reconcile must not launch or repair");
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.nextActions.join(" | ")}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{ command: "reconcile", projectAlias: "ocr", runId: RUN_ID, format: "json", registryPath: join(packageRoot, "projects.yaml") }]);
  assert.match(output.stdout[0], /workflow result/);
  assert.match(output.stdout[0], /workflow status ocr ASANA-123/);
  assert.match(output.stdout[0], /workflow handoff .*handoff-input\.json/);
  assert.deepEqual(output.stderr, []);
});

test("main prints compact and json output for read-only commands", async () => {
  const output = io();
  const calls = [];
  const doctorResult = {
    command: "doctor",
    project: { alias: "ocr", label: "ExampleProject" },
    checks: [],
    ok: true,
  };

  const code = await main(["doctor", "ocr", "--format", "json"], {
    ...output,
    doctorCommand: async (options) => {
      calls.push(options);
      return doctorResult;
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.ok}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["doctor:json:true"]);
  assert.deepEqual(output.stderr, []);
  assert.equal(calls[0].command, "doctor");
});

test("requires explicit approval for mutation", async () => {
  const output = io();
  const code = await main(["start", "ocr", "ASANA-123", "--feature", "Discovered Docs"], {
    ...output,
    isInteractive: () => false,
  });
  assert.equal(code, 64);
  assert.match(output.stderr[0], /--yes/);
});

test("shows the reconciled plan before an interactive confirmation and stops on decline", async () => {
  const output = io();
  const calls = [];
  const code = await main(["start", "ocr", "ASANA-123", "--feature", "Discovered Docs"], {
    ...output,
    isInteractive: () => true,
    planCommand: async (options) => {
      calls.push(["plan", options]);
      return planPreview();
    },
    confirm: async ({ command, previewText }) => {
      calls.push(["confirm", command, previewText]);
      return false;
    },
    executeStart: async () => {
      calls.push(["execute"]);
      return executionReport();
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.reconciliation?.status ?? value.status}`,
  });

  assert.equal(code, 64);
  assert.deepEqual(calls.map((entry) => entry[0]), ["plan", "confirm"]);
  assert.deepEqual(output.stdout, []);
  assert.deepEqual(output.stderr, [
    "plan:compact:incomplete",
    "USAGE: Confirmation declined; no changes were made.",
  ]);
});

test("start executes with --yes and maps partial execution to a stable exit code", async () => {
  const output = io();
  const calls = [];
  const code = await main(["start", "ocr", "ASANA-123", "--feature", "Discovered Docs", "--yes"], {
    ...output,
    planCommand: async () => {
      calls.push("plan");
      return planPreview();
    },
    executeStart: async (plan) => {
      calls.push(plan.status ?? plan.reconciliation?.status ?? "execute");
      return executionReport({ status: "partial" });
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status ?? value.reconciliation?.status}`,
  });

  assert.equal(code, 13);
  assert.deepEqual(calls, ["plan", "incomplete"]);
  assert.deepEqual(output.stdout, ["start:compact:partial"]);
});

test("start fails closed before mutation when any required preview precondition is missing", async () => {
  for (const missing of ["git", "herdr", "pi", "herdrStatus", "piIntegration"]) {
    const output = io();
    let executed = false;
    const preview = planPreview();
    delete preview.preconditions[missing];

    const code = await main(["start", "ocr", "ASANA-123", "--yes"], {
      ...output,
      planCommand: async () => preview,
      executeStart: async () => {
        executed = true;
        return executionReport();
      },
    });

    assert.equal(code, 10, `expected missing ${missing} to fail preflight`);
    assert.equal(executed, false, `expected missing ${missing} to block executor`);
    assert.match(output.stderr[0], new RegExp(`missing or malformed required precondition: ${missing}`, "i"));
  }
});

test("runtime fails closed before mutation when any required preview precondition is missing", async () => {
  for (const missing of ["git", "herdr", "herdrStatus"]) {
    const output = io();
    let executed = false;
    const preview = planPreview();
    delete preview.preconditions[missing];

    const code = await main(["runtime", "ocr", "ASANA-123", "--yes"], {
      ...output,
      planCommand: async () => preview,
      executeRuntime: async () => {
        executed = true;
        return executionReport();
      },
    });

    assert.equal(code, 10, `expected missing ${missing} to fail preflight`);
    assert.equal(executed, false, `expected missing ${missing} to block executor`);
    assert.match(output.stderr[0], new RegExp(`missing or malformed required precondition: ${missing}`, "i"));
  }
});

test("start fails closed on malformed required preconditions without leaking oversized payloads", async () => {
  const output = io();
  let executed = false;
  const preview = planPreview({
    preconditions: {
      ...planPreview().preconditions,
      herdrStatus: { id: "herdr:status", detail: "x".repeat(20000) },
    },
  });

  const code = await main(["start", "ocr", "ASANA-123", "--yes"], {
    ...output,
    planCommand: async () => preview,
    executeStart: async () => {
      executed = true;
      return executionReport();
    },
  });

  assert.equal(code, 10);
  assert.equal(executed, false);
  assert.match(output.stderr[0], /missing or malformed required precondition: herdrStatus/i);
  assert.doesNotMatch(output.stderr[0], /x{100}/i);
  assert.ok(output.stderr[0].length < 200);
});

test("start blocks before mutation when Herdr or Pi launch preconditions are not ready", async () => {
  const herdrOutput = io();
  let herdrExecuted = false;
  const herdrCode = await main(["start", "ocr", "ASANA-123", "--yes"], {
    ...herdrOutput,
    planCommand: async () => planPreview({
      preconditions: {
        ...planPreview().preconditions,
        herdrStatus: { id: "herdr:status", status: "conflict", reason: "Herdr server is not ready" },
      },
    }),
    executeStart: async () => {
      herdrExecuted = true;
      return executionReport();
    },
  });

  assert.equal(herdrCode, 10);
  assert.equal(herdrExecuted, false);
  assert.match(herdrOutput.stderr[0], /Herdr server is not ready/);

  const piOutput = io();
  let piExecuted = false;
  const piCode = await main(["start", "ocr", "ASANA-123", "--yes"], {
    ...piOutput,
    planCommand: async () => planPreview({
      preconditions: {
        ...planPreview().preconditions,
        piIntegration: { id: "herdr:integration:pi", status: "missing", reason: "Pi integration is not installed" },
      },
    }),
    executeStart: async () => {
      piExecuted = true;
      return executionReport();
    },
  });

  assert.equal(piCode, 10);
  assert.equal(piExecuted, false);
  assert.match(piOutput.stderr[0], /Pi integration is not installed/);
});

test("runtime requires compatible Herdr server but not Pi integration", async () => {
  const blocked = io();
  let blockedExecuted = false;
  const blockedCode = await main(["runtime", "ocr", "ASANA-123", "--yes"], {
    ...blocked,
    planCommand: async () => planPreview({
      preconditions: {
        ...planPreview().preconditions,
        herdrStatus: { id: "herdr:status", status: "conflict", reason: "Herdr server is not ready" },
        piIntegration: { id: "herdr:integration:pi", status: "missing", reason: "Pi integration is not installed" },
      },
    }),
    executeRuntime: async () => {
      blockedExecuted = true;
      return executionReport();
    },
  });

  assert.equal(blockedCode, 10);
  assert.equal(blockedExecuted, false);
  assert.match(blocked.stderr[0], /Herdr server is not ready/);

  const allowed = io();
  let allowedExecuted = false;
  const allowedCode = await main(["runtime", "ocr", "ASANA-123", "--yes"], {
    ...allowed,
    planCommand: async () => planPreview({
      preconditions: {
        ...planPreview().preconditions,
        piIntegration: { id: "herdr:integration:pi", status: "missing", reason: "Pi integration is not installed" },
      },
    }),
    executeRuntime: async () => {
      allowedExecuted = true;
      return executionReport();
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status ?? value.reconciliation?.status}`,
  });

  assert.equal(allowedCode, 0);
  assert.equal(allowedExecuted, true);
  assert.deepEqual(allowed.stdout, ["runtime:compact:completed"]);
});

test("start accepts selected generic agent readiness without Pi or Claude checks", async () => {
  const output = io();
  let executed = false;
  const code = await main(["start", "ocr", "ASANA-123", "--agent", "codex-worker", "--yes"], {
    ...output,
    planCommand: async (options) => {
      assert.equal(options.agentProfile, "codex-worker");
      return planPreview({
        preconditions: {
          git: { id: "binary:git", status: "ready", path: "/usr/bin/git" },
          herdr: { id: "binary:herdr", status: "ready", path: "/usr/bin/herdr" },
          herdrStatus: { id: "herdr:status", status: "ready" },
          agent: { id: "binary:codex", status: "ready", path: "/usr/bin/codex", harness: "codex", profileName: "codex-worker" },
          agentIntegration: { id: "herdr:integration:codex", status: "ready", harness: "codex", profileName: "codex-worker" },
        },
      });
    },
    executeStart: async () => {
      executed = true;
      return executionReport();
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status ?? value.reconciliation?.status}`,
  });

  assert.equal(code, 0);
  assert.equal(executed, true);
  assert.deepEqual(output.stdout, ["start:compact:completed"]);
});

test("maps conflict and preflight workflow errors to stable categories", async () => {
  const conflict = io();
  assert.equal(await main(["plan", "ocr", "ASANA-123"], {
    ...conflict,
    planCommand: async () => {
      throw new WorkflowError("CONFLICT", "branch already exists", { exitCode: 11 });
    },
  }), 11);
  assert.deepEqual(conflict.stderr, ["CONFLICT: branch already exists"]);

  const preflight = io();
  assert.equal(await main(["runtime", "ocr", "ASANA-123", "--yes"], {
    ...preflight,
    planCommand: async () => {
      throw new WorkflowError("PREFLIGHT", "runtime workspace is not open", { exitCode: 10 });
    },
  }), 10);
  assert.deepEqual(preflight.stderr, ["PREFLIGHT: runtime workspace is not open"]);
});

test("bounds formatted output before printing", async () => {
  const output = io();
  const code = await main(["doctor", "ocr"], {
    ...output,
    doctorCommand: async () => ({
      command: "doctor",
      project: { alias: "ocr", label: "ExampleProject" },
      checks: [],
      ok: true,
    }),
    formatWorkflowResult: () => "x".repeat(15000),
  });

  assert.equal(code, 0);
  assert.equal(output.stdout.length, 1);
  assert.ok(output.stdout[0].length <= 12000);
});
