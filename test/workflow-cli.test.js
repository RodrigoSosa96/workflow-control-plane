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
  assert.match(result.stdout, /workflow runtime <project> <task> .*--tickets <csv>/);
  assert.match(result.stdout, /workflow status <project> <task> .*--tickets <csv>/);
  const doctorLine = result.stdout.split(/\r?\n/u).find((line) => line.includes("workflow doctor"));
  assert.doesNotMatch(doctorLine, /--tickets/);
});

test("parses documented workflow commands and options", () => {
  assert.deepEqual(parseArgs(["doctor", "ocr"]), {
    command: "doctor",
    projectAlias: "ocr",
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

  assert.deepEqual(parseArgs(["start", "ocr", "ASANA-123", "--feature", "Discovered Docs", "--tickets", "ASANA-150,ASANA-140", "--yes"]), {
    command: "start",
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "Discovered Docs",
    tickets: ["ASANA-150", "ASANA-140"],
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
});

test("rejects unknown, duplicate, and disallowed options", () => {
  assert.throws(() => parseArgs(["doctor", "ocr", "--yes"]), /does not accept --yes/i);
  assert.throws(() => parseArgs(["doctor", "ocr", "--tickets", "ASANA-150"]), /does not accept --tickets/i);
  assert.throws(() => parseArgs(["status", "ocr", "ASANA-123", "--yes"]), /does not accept --yes/i);
  assert.throws(() => parseArgs(["start", "ocr", "ASANA-123", "--profile", "standard"]), /does not accept --profile/i);
  assert.throws(() => parseArgs(["plan", "ocr", "ASANA-123", "--format", "xml"]), /compact or json/i);
  assert.throws(() => parseArgs(["plan", "ocr", "ASANA-123", "--feature", "One", "--feature", "Two"]), /Duplicate option/i);
  assert.throws(() => parseArgs(["plan", "ocr", "ASANA-123", "--bogus"]), /Unknown option: --bogus/i);
  assert.throws(() => parseArgs(["runtime", "ocr", "ASANA-123", "junk"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["doctor", "ocr", "extra"]), /unexpected argument/i);
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
