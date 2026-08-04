import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as realFs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main, parseArgs } from "../bin/workflow.js";
import { delegationGateClearCommand as defaultDelegationGateClearCommand, delegationRemediateCommand as defaultDelegationRemediateCommand } from "../src/workflow/commands.js";
import { createDelegationReservationStore } from "../src/workflow/delegation-reservations.js";
import { createDelegationServices } from "../src/workflow/delegation-services.js";
import { createDelegationStore } from "../src/workflow/delegation-store.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { createPiDelegationTransport } from "../src/workflow/pi-delegation-transport.js";
import { inspectExactProcessByPid } from "../src/workflow/process-observation.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const mutableChildProcess = require("node:child_process");

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
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";
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

function delegationRemediationPreview(overrides = {}) {
  return {
    command: "delegation-remediate",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    projectAlias: "ocr",
    projectLabel: "ExampleProject",
    role: "code-reviewer",
    mode: "background",
    state: "completed",
    generation: 1,
    resultStatus: "completed",
    approvalDigest: APPROVAL_DIGEST,
    nextActions: ["approve-remediation"],
    ...overrides,
  };
}

const FIXTURE_PROJECT_ALIAS = "fixture";
const FIXTURE_PROJECT_PATH = "/fixture/shared";
const FIXTURE_CWD = "/fixture/review";
const FIXTURE_POLICY = {
  version: 1,
  totalInternal: 4,
  foreground: 3,
  readOnlyBackground: 3,
  writersTotal: 1,
  writersPerCheckout: 1,
  maxDepth: 1,
  remediationTurns: 2,
  allowBackgroundWriters: false,
};
const FIXTURE_REGISTRY = {
  launcher: { delegation: FIXTURE_POLICY },
  projects: {
    [FIXTURE_PROJECT_ALIAS]: {
      label: "Fixture Project",
      path: FIXTURE_PROJECT_PATH,
      delegation: {
        remediationTurns: 2,
      },
    },
  },
};
const FIXTURE_REVIEW_INPUT = Object.freeze({
  role: "code-reviewer",
  mode: "background",
  originSessionId: "pi-origin-1",
  cwd: FIXTURE_CWD,
  brief: "Review only the frozen task. Keep all findings inside scope.",
  task: "Review only the frozen task.",
  budget: { maxRuntimeMs: 60_000, concurrency: 1, maxTurns: 3, maxToolCalls: 12 },
  remediationTurns: 2,
});
const FIXTURE_ROLE_LOADER = Object.freeze({
  async loadDelegationRole({ name }) {
    return Object.freeze({
      name,
      tools: ["read", "bash", "grep", "find", "ls"],
      systemPrompt: "Review only the frozen brief.",
    });
  },
});
// Satisfies withLiveDelegationTransport's `if (liveDependencies.transport) return liveDependencies;`
// short-circuit so tests don't resolve `pi` from the real PATH. Every method throws because these
// tests' injected commands resolve or throw before ever touching the transport; a call here means
// the test stopped exercising what it claims to.
const UNUSED_DELEGATION_TRANSPORT = Object.freeze({
  async start() {
    throw new Error("delegation transport must not run: this test's command resolves before touching it");
  },
  async observeExact() {
    throw new Error("delegation transport must not run: this test's command resolves before touching it");
  },
  async deliverFollowUp() {
    throw new Error("delegation transport must not run: this test's command resolves before touching it");
  },
  async requestGracefulClose() {
    throw new Error("delegation transport must not run: this test's command resolves before touching it");
  },
});

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function fixtureTransportIdentity(stateRoot, runId = RUN_ID, delegationId = DELEGATION_ID) {
  return {
    kind: "pi-delegation",
    runId,
    delegationId,
    sessionPath: join(stateRoot, runId, "delegations", delegationId, "pi-session.jsonl"),
    cwd: FIXTURE_CWD,
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  };
}

function completedDelegationResult(generation, summary = "Review completed") {
  return {
    status: "completed",
    generation,
    summary,
    verification: [{ command: "git diff --check", status: "passed" }],
    concerns: [],
    nextAction: "Return findings to the coordinator",
  };
}

async function createCompletedDelegationCliFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-cli-remediation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID });
  const run = await store.create({
    projectAlias: FIXTURE_PROJECT_ALIAS,
    primaryTicket: "A-1",
    state: RUN_STATES.PLANNED,
    repositories: [{ id: "repository", path: FIXTURE_CWD, branch: "main" }],
  });
  const delegations = createDelegationStore({
    store,
    randomUUID: uuidSequence(DELEGATION_ID),
  });
  const reservations = createDelegationReservationStore({
    stateRoot,
    randomUUID: uuidSequence(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ),
    canonicalPath: async (value) => value,
  });
  const services = createDelegationServices({
    registry: FIXTURE_REGISTRY,
    projectAlias: FIXTURE_PROJECT_ALIAS,
    runStore: store,
    delegations,
    reservations,
    transport: {
      async start() {
        return { identity: fixtureTransportIdentity(stateRoot) };
      },
      async observeExact(identity) {
        return { state: "idle", identity };
      },
      async deliverFollowUp() {
        throw new Error("not used in setup");
      },
      async requestGracefulClose(identity) {
        return { requested: false, manual: true, identity };
      },
    },
    roles: FIXTURE_ROLE_LOADER,
  });
  const preview = await services.createPreview({ runId: run.id, input: FIXTURE_REVIEW_INPUT });
  await services.executeApproved({ preview, approvalDigest: preview.approvalDigest });
  await delegations.recordResult({ runId: run.id, delegationId: DELEGATION_ID, result: completedDelegationResult(1) });
  return { root, stateRoot, store, delegations, reservations };
}

async function remediationApprovalDigest(deps, prompt) {
  const command = await defaultDelegationRemediateCommand({
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    prompt,
    registryPath: "/fixture/projects.yaml",
  }, deps);
  return command.preview.approvalDigest;
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
  assert.match(result.stdout, /workflow runs \[project\] \[--state <state>\] \[--all\]/);
  assert.match(result.stdout, /workflow inbox \[project\]/);
  assert.match(result.stdout, /workflow resume <run-id>/);
  assert.match(result.stdout, /workflow close <run-id>/);
  assert.match(result.stdout, /workflow unlock <run-id>/);
  assert.match(result.stdout, /workflow runtime <project> <task> .*--tickets <csv>/);
  assert.match(result.stdout, /workflow status <project> <task> .*--tickets <csv>/);
  assert.match(result.stdout, /workflow delegation result <run-id> <delegation-id>/);
  assert.match(result.stdout, /workflow delegation reconcile <run-id> <delegation-id>/);
  assert.match(result.stdout, /workflow delegation remediate <run-id> <delegation-id> --prompt-file <path> .*--dry-run.*--approval-digest <digest>.*--yes/);
  assert.match(result.stdout, /workflow delegation handoff <run-id> <delegation-id> --input <run-dir>\/delegations\/<delegation-id>\/handoff-input.json/);
  assert.match(result.stdout, /workflow delegation gate-clear <project>/);
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

  assert.deepEqual(parseArgs(["verify", RUN_ID]), {
    command: "verify",
    runId: RUN_ID,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["verify", RUN_ID, "--format", "json"]), {
    command: "verify",
    runId: RUN_ID,
    format: "json",
  });

  assert.deepEqual(parseArgs(["reconcile", "acme", "--run", RUN_ID, "--format", "json"]), {
    command: "reconcile",
    projectAlias: "acme",
    runId: RUN_ID,
    format: "json",
  });

  assert.deepEqual(parseArgs(["runs"]), {
    command: "runs",
    format: "compact",
  });

  assert.deepEqual(parseArgs(["runs", "acme", "--state", "running", "--all", "--format", "json"]), {
    command: "runs",
    projectAlias: "acme",
    state: "running",
    all: true,
    format: "json",
  });

  assert.deepEqual(parseArgs(["inbox"]), {
    command: "inbox",
    format: "compact",
  });

  assert.deepEqual(parseArgs(["inbox", "acme", "--format", "json"]), {
    command: "inbox",
    projectAlias: "acme",
    format: "json",
  });

  assert.deepEqual(parseArgs(["resume", RUN_ID]), {
    command: "resume",
    runId: RUN_ID,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["resume", RUN_ID, "--yes"]), {
    command: "resume",
    runId: RUN_ID,
    yes: true,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["close", RUN_ID, "--format", "json"]), {
    command: "close",
    runId: RUN_ID,
    format: "json",
  });

  assert.deepEqual(parseArgs(["unlock", RUN_ID]), {
    command: "unlock",
    runId: RUN_ID,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["unlock", RUN_ID, "--yes"]), {
    command: "unlock",
    runId: RUN_ID,
    yes: true,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["worker", "status", RUN_ID, "--format", "json"]), {
    command: "worker-status",
    runId: RUN_ID,
    format: "json",
  });
  assert.deepEqual(parseArgs(["worker", "watch", RUN_ID]), {
    command: "worker-watch",
    runId: RUN_ID,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["handoff", RUN_ID, "--input", "/state/run/handoff-input.json"]), {
    command: "handoff",
    runId: RUN_ID,
    input: "/state/run/handoff-input.json",
    format: "compact",
  });

  assert.deepEqual(parseArgs(["delegation", "result", RUN_ID, DELEGATION_ID, "--format", "json"]), {
    command: "delegation-result",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    format: "json",
  });

  assert.deepEqual(parseArgs(["delegation", "reconcile", RUN_ID, DELEGATION_ID]), {
    command: "delegation-reconcile",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", "/tmp/request.md", "--dry-run"]), {
    command: "delegation-remediate",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    promptFile: "/tmp/request.md",
    dryRun: true,
    format: "compact",
  });

  assert.deepEqual(parseArgs(["delegation", "handoff", RUN_ID, DELEGATION_ID, "--input", "/state/run/delegations/22222222-2222-4222-8222-222222222222/handoff-input.json"]), {
    command: "delegation-handoff",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    input: "/state/run/delegations/22222222-2222-4222-8222-222222222222/handoff-input.json",
    format: "compact",
  });

  assert.deepEqual(parseArgs(["delegation", "gate-clear", "acme"]), {
    command: "delegation-gate-clear",
    projectAlias: "acme",
    format: "compact",
  });

  assert.deepEqual(parseArgs(["delegation", "gate-clear", "acme", "--yes", "--format", "json"]), {
    command: "delegation-gate-clear",
    projectAlias: "acme",
    yes: true,
    format: "json",
  });
});

test("rejects unknown, duplicate, and disallowed options", () => {
  assert.throws(() => parseArgs(["doctor", "ocr", "--yes"]), /does not accept --yes/i);
  assert.throws(() => parseArgs(["doctor", "ocr", "--tickets", "ASANA-150"]), /does not accept --tickets/i);
  assert.throws(() => parseArgs(["status", "ocr", "ASANA-123", "--yes"]), /does not accept --yes/i);
  assert.throws(() => parseArgs(["result", RUN_ID, "--yes"]), /result does not accept --yes/i);
  assert.throws(() => parseArgs(["result", RUN_ID, "--prompt-file", "/tmp/request.md"]), /result does not accept --prompt-file/i);
  assert.throws(() => parseArgs(["verify", RUN_ID, "--yes"]), /verify does not accept --yes/i);
  assert.throws(() => parseArgs(["verify"]), /verify requires an argument/i);
  assert.throws(() => parseArgs(["verify", "not-a-uuid"]), /path-safe|UUID/i);
  assert.throws(() => parseArgs(["verify", RUN_ID, "extra"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["reconcile", "--run", RUN_ID, "--yes"]), /reconcile does not accept --yes/i);
  assert.throws(() => parseArgs(["runs", "acme", "extra"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["runs", "--yes"]), /runs does not accept --yes/i);
  assert.throws(() => parseArgs(["runs", "--bogus"]), /Unknown option: --bogus/i);
  assert.throws(() => parseArgs(["inbox", "acme", "extra"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["inbox", "--all"]), /inbox does not accept --all/i);
  assert.throws(() => parseArgs(["inbox", "--state", "running"]), /inbox does not accept --state/i);
  assert.throws(() => parseArgs(["inbox", "--bogus"]), /Unknown option: --bogus/i);
  assert.throws(() => parseArgs(["resume", "../not-a-run"]), /path-safe|UUID/i);
  assert.throws(() => parseArgs(["close", RUN_ID, "--yes"]), /close does not accept --yes/i);
  assert.throws(() => parseArgs(["close", "../not-a-run"]), /path-safe|UUID/i);
  assert.throws(() => parseArgs(["unlock"]), /requires an argument/i);
  assert.throws(() => parseArgs(["unlock", RUN_ID, "extra"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["unlock", RUN_ID, "--tickets", "ASANA-150"]), /unlock does not accept --tickets/i);
  assert.throws(() => parseArgs(["unlock", "../not-a-run"]), /path-safe|UUID/i);
  assert.throws(() => parseArgs(["worker", "watch", RUN_ID, "--interval", "1"]), /Unknown option|does not accept/i);
  assert.throws(() => parseArgs(["worker", "status", "../not-a-run"]), /path-safe|UUID/i);
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
  assert.throws(() => parseArgs(["delegation", "result", RUN_ID]), /delegation-id|arguments|required/i);
  assert.throws(() => parseArgs(["delegation", "result", "../not-a-run", DELEGATION_ID]), /path-safe|UUID/i);
  assert.throws(() => parseArgs(["delegation", "reconcile", RUN_ID, "/tmp/project"]), /path-safe|UUID/i);
  assert.throws(() => parseArgs(["delegation", "result", RUN_ID, DELEGATION_ID, "--last"]), /Unknown option: --last/i);
  assert.throws(() => parseArgs(["delegation", "result", RUN_ID, DELEGATION_ID, "--continue"]), /Unknown option: --continue/i);
  assert.throws(() => parseArgs(["delegation", "result", RUN_ID, DELEGATION_ID, "--prompt-file", "/tmp/request.md"]), /does not accept --prompt-file/i);
  assert.throws(() => parseArgs(["delegation", "reconcile", RUN_ID, DELEGATION_ID, "--output", "/tmp/result.json"]), /Unknown option: --output/i);
  assert.throws(() => parseArgs(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt", "SECRET-DO-NOT-LEAK"]), /Unknown option: --prompt/i);
  assert.throws(() => parseArgs(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--mode", "background", "--prompt-file", "/tmp/request.md"]), /Unknown option: --mode/i);
  assert.throws(() => parseArgs(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--cwd", "/tmp/work", "--prompt-file", "/tmp/request.md"]), /Unknown option: --cwd/i);
  assert.throws(() => parseArgs(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--role", "sdd-implementer", "--prompt-file", "/tmp/request.md"]), /Unknown option: --role/i);
  assert.throws(() => parseArgs(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", "/tmp/one.md", "--prompt-file", "/tmp/two.md"]), /Duplicate option/i);
  assert.throws(() => parseArgs(["delegation", "handoff", RUN_ID]), /delegation-id|arguments|required/i);
  assert.throws(() => parseArgs(["delegation", "handoff", RUN_ID, DELEGATION_ID, "--input", "/state/run/not-handoff.json"]), /handoff-input\.json|canonical/i);
  assert.throws(() => parseArgs(["delegation", "handoff", RUN_ID, DELEGATION_ID, "prompt text", "--input", "/state/run/delegations/22222222-2222-4222-8222-222222222222/handoff-input.json"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["delegation", "handoff", RUN_ID, DELEGATION_ID, "--yes", "--input", "/state/run/delegations/22222222-2222-4222-8222-222222222222/handoff-input.json"]), /does not accept --yes|Unknown option: --yes/i);
  assert.throws(() => parseArgs(["delegation", "handoff", RUN_ID, DELEGATION_ID, "--output", "/tmp/result.json", "--input", "/state/run/delegations/22222222-2222-4222-8222-222222222222/handoff-input.json"]), /Unknown option: --output/i);
  assert.throws(() => parseArgs(["delegation", "gate-clear"]), /requires an argument/i);
  assert.throws(() => parseArgs(["delegation", "gate-clear", "acme", "extra"]), /unexpected argument/i);
  assert.throws(() => parseArgs(["delegation", "gate-clear", "acme", "--tickets", "ASANA-150"]), /does not accept --tickets/i);

  for (const input of [
    "state/run/delegations/22222222-2222-4222-8222-222222222222/handoff-input.json",
    "/state/run/delegations/handoff-input.json",
    "/state/run//delegations/22222222-2222-4222-8222-222222222222/handoff-input.json",
    "/state/run/delegations//handoff-input.json",
    "/state/run/delegations/../22222222-2222-4222-8222-222222222222/handoff-input.json",
    "/state/run/delegations/22222222-2222-4222-8222-222222222222/../handoff-input.json",
    "/state/run/delegations/22222222-2222-4222-8222-222222222222/extra/handoff-input.json",
    "/state/run/delegations/22222222-2222-4222-8222-222222222222/result.json",
    "/state/run/delegations/22222222-2222-4222-8222-222222222222/hand\u0000off-input.json",
  ]) {
    assert.throws(
      () => parseArgs(["delegation", "handoff", RUN_ID, DELEGATION_ID, "--input", input]),
      /handoff-input\.json|canonical/i,
      input,
    );
  }
});

test("main dispatches worker status and finite read-only watch output", async () => {
  const output = io();
  const worker = {
    workerId: DELEGATION_ID,
    harness: "pi",
    phase: "running",
    usage: { input: { availability: "not-reported", value: null } },
  };
  const calls = [];
  const common = {
    ...output,
    workerStatusCommand: async (options) => {
      calls.push({ type: "status", options });
      return { command: "worker-status", runId: options.runId, workers: [worker] };
    },
    workerWatchCommand: async () => (async function* finiteWatch() {
      yield [worker];
    }()),
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.workers[0].phase}`,
  };

  assert.equal(await main(["worker", "status", RUN_ID, "--format", "json"], common), 0);
  assert.equal(await main(["worker", "watch", RUN_ID], common), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(output.stdout, ["worker-status:json:running", "worker-watch:compact:running"]);
  assert.deepEqual(output.stderr, []);
});

test("worker watch redacts telemetry failures before printing them", async () => {
  const output = io();
  const exitCode = await main(["worker", "watch", RUN_ID], {
    ...output,
    workerWatchCommand: async () => (async function* failingWatch() {
      throw new WorkflowError("telemetry", "Malformed telemetry at /private/DO-NOT-LEAK");
    }()),
  });

  assert.equal(exitCode, 10);
  assert.deepEqual(output.stdout, []);
  assert.match(output.stderr.join("\n"), /PREFLIGHT.*telemetry.*manual/i);
  assert.doesNotMatch(output.stderr.join("\n"), /DO-NOT-LEAK|\/private/);
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

test("main runs the canonical delegation handoff command with only allowlisted identity env", async () => {
  const output = io();
  const calls = [];
  const runId = RUN_ID;
  const delegationId = DELEGATION_ID;
  const input = `/state/run/delegations/${delegationId}/handoff-input.json`;
  const code = await main(["delegation", "handoff", runId, delegationId, "--input", input], {
    ...output,
    env: {
      WORKFLOW_RUN_ID: runId,
      WORKFLOW_DELEGATION_ID: delegationId,
      WORKFLOW_DELEGATION_GENERATION: "2",
      WORKFLOW_RUN_DIR: "/state/run",
      WORKFLOW_STATE_ROOT: "/state",
      SECRET_TOKEN: "do-not-pass",
    },
    delegationHandoffCommand: async (options) => {
      calls.push(options);
      return { state: "completed", result: { status: "completed" } };
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.state}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    command: "delegation-handoff",
    runId,
    delegationId,
    input,
    format: "compact",
    registryPath: join(packageRoot, "projects.yaml"),
    env: {
      WORKFLOW_RUN_ID: runId,
      WORKFLOW_DELEGATION_ID: delegationId,
      WORKFLOW_DELEGATION_GENERATION: "2",
    },
  }]);
  assert.deepEqual(output.stdout, ["delegation-handoff:compact:completed"]);
  assert.deepEqual(output.stderr, []);
});

test("main prints stable exits for delegation result and keeps delegation reconcile read-only", async () => {
  for (const [status, expectedCode] of [["pending", 20], ["result-stale", 21]]) {
    const output = io();
    const code = await main(["delegation", "result", RUN_ID, DELEGATION_ID], {
      ...output,
      delegationResultCommand: async (options) => ({ command: "delegation-result", runId: options.runId, delegationId: options.delegationId, status, exitCode: expectedCode }),
      formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.status}`,
    });
    assert.equal(code, expectedCode);
    assert.deepEqual(output.stdout, [`delegation-result:compact:${status}`]);
    assert.deepEqual(output.stderr, []);
  }

  const reconcileOutput = io();
  const reconcileCalls = [];
  const reconcileCode = await main(["delegation", "reconcile", RUN_ID, DELEGATION_ID, "--format", "json"], {
    ...reconcileOutput,
    transport: UNUSED_DELEGATION_TRANSPORT,
    delegationReconcileCommand: async (options) => {
      reconcileCalls.push(options);
      return {
        command: "delegation-reconcile",
        runId: options.runId,
        delegationId: options.delegationId,
        role: "code-reviewer",
        mode: "background",
        state: "completed",
        generation: 1,
        resultStatus: "completed",
        nextActions: ["deliver-result", "manual-review"],
      };
    },
    executeStart: async () => {
      throw new Error("delegation reconcile must not start or repair anything");
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.nextActions.join(" | ")}`,
  });

  assert.equal(reconcileCode, 0);
  assert.deepEqual(reconcileCalls, [{ command: "delegation-reconcile", runId: RUN_ID, delegationId: DELEGATION_ID, format: "json", registryPath: join(packageRoot, "projects.yaml") }]);
  assert.match(reconcileOutput.stdout[0], /deliver-result/);
  assert.match(reconcileOutput.stdout[0], /manual-review/);
  assert.deepEqual(reconcileOutput.stderr, []);
});

test("delegation remediate dry-run reads only --prompt-file, and execution requires --yes plus the current digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-delegation-remediate-cli-"));
  const promptFile = join(dir, "remediation $(touch should-not-run).md");
  await writeFile(promptFile, RAW_REQUEST);

  const previewOutput = io();
  const previewCalls = [];
  const previewCode = await main(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", promptFile, "--dry-run", "--format", "json"], {
    ...previewOutput,
    delegationRemediateCommand: async (options) => {
      previewCalls.push({ kind: "command", options });
      assert.equal(options.prompt, RAW_REQUEST);
      assert.equal(options.promptFile, promptFile);
      return {
        preview: delegationRemediationPreview(),
        async execute() {
          previewCalls.push({ kind: "execute" });
          return { state: "running", nextActions: ["await-result"] };
        },
      };
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.approvalDigest ?? value.state}`,
  });
  assert.equal(previewCode, 0);
  assert.deepEqual(previewCalls.map((call) => call.kind), ["command"]);
  assert.match(previewOutput.stdout[0], new RegExp(APPROVAL_DIGEST));
  assert.deepEqual(previewOutput.stderr, []);

  for (const argv of [
    ["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", promptFile],
    ["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", promptFile, "--yes"],
  ]) {
    const output = io();
    let called = false;
    const code = await main(argv, {
      ...output,
      isInteractive: () => false,
      delegationRemediateCommand: async () => {
        called = true;
        return { preview: delegationRemediationPreview(), execute: async () => ({ state: "running" }) };
      },
    });
    assert.equal(code, 64, argv.join(" "));
    assert.equal(called, false, argv.join(" "));
    assert.match(output.stderr[0], /--yes|approval-digest/i);
  }

  const executeOutput = io();
  const executeCalls = [];
  const executeCode = await main(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", promptFile, "--yes", "--approval-digest", APPROVAL_DIGEST], {
    ...executeOutput,
    isInteractive: () => false,
    transport: UNUSED_DELEGATION_TRANSPORT,
    delegationRemediateCommand: async () => ({
      preview: delegationRemediationPreview(),
      async execute(executeOptions) {
        executeCalls.push(executeOptions);
        return { command: "delegation-remediate", state: "running", nextActions: ["await-result"] };
      },
    }),
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.state}`,
  });
  assert.equal(executeCode, 0);
  assert.deepEqual(executeCalls, [{ approvalDigest: APPROVAL_DIGEST }]);
  assert.deepEqual(executeOutput.stdout, ["delegation-remediate:compact:running"]);
});

test("CLI live delegation inspection exact-matches extension identities via the shared processStartedAt format", async () => {
  const extensionInspection = await inspectExactProcessByPid("12345", {
    async runProcess() {
      return { code: 0, stdout: "Wed Jan  1 00:10:00 2025 S\n" };
    },
    async readCwd() {
      return "/fixture/review";
    },
    cwdFallback: "/fixture/review",
  });
  const extensionIdentity = {
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: `/state/workflow/${RUN_ID}/delegations/${DELEGATION_ID}/pi-session.jsonl`,
    cwd: "/fixture/review",
    pid: "12345",
    processStartedAt: extensionInspection.startedAt,
  };
  const psCalls = [];
  let inspectPromise;

  assert.equal(await main(["delegation", "reconcile", RUN_ID, DELEGATION_ID], {
    out() {},
    err() {},
    runner: {
      async run(command, argv, options) {
        psCalls.push({ command, argv, options });
        return { code: 0, stdout: "Wed Jan  1 00:10:00 2025 S\n" };
      },
    },
    readDelegationCwd: async (path) => {
      assert.equal(path, "/proc/12345/cwd");
      return "/fixture/review";
    },
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    lookupExecutable: async () => "/usr/bin/pi",
    createPiDelegationTransport: (options) => {
      inspectPromise = options.inspectProcess(extensionIdentity).then((observed) => {
        assert.deepEqual(observed, {
          pid: "12345",
          startedAt: extensionIdentity.processStartedAt,
          cwd: "/fixture/review",
          active: false,
        });
      });
      return {
        async start() {
          throw new Error("not used");
        },
        async observeExact() {
          return { state: "active", identity: extensionIdentity };
        },
        async deliverFollowUp() {
          throw new Error("not used");
        },
        async requestGracefulClose() {
          return { requested: false, manual: true };
        },
      };
    },
    delegationReconcileCommand: async () => ({
      command: "delegation-reconcile",
      runId: RUN_ID,
      delegationId: DELEGATION_ID,
      role: "code-reviewer",
      mode: "background",
      state: "completed",
      generation: 1,
      resultStatus: "completed",
      nextActions: ["deliver-result"],
    }),
    formatWorkflowResult: () => "ok",
  }), 0);
  await inspectPromise;
  assert.deepEqual(psCalls, [{
    command: "ps",
    argv: ["-p", "12345", "-o", "lstart=", "-o", "state="],
    options: { allowFailure: true },
  }]);
});

test("CLI live delegation inspection reports unknown when proc cwd inspection cannot be verified", async () => {
  const extensionIdentity = {
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: `/state/workflow/${RUN_ID}/delegations/${DELEGATION_ID}/pi-session.jsonl`,
    cwd: "/fixture/review",
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
  };
  let observePromise;

  assert.equal(await main(["delegation", "reconcile", RUN_ID, DELEGATION_ID], {
    out() {},
    err() {},
    runner: {
      async run() {
        return { code: 0, stdout: "Wed Jan  1 00:10:00 2025 S\n" };
      },
    },
    readDelegationCwd: async () => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    lookupExecutable: async () => "/usr/bin/pi",
    createPiDelegationTransport: (options) => {
      const transport = createPiDelegationTransport(options);
      observePromise = transport.observeExact(extensionIdentity).then((observation) => {
        assert.deepEqual(observation, { state: "unknown", identity: extensionIdentity });
      });
      return transport;
    },
    delegationReconcileCommand: async (_options, liveDependencies) => {
      assert.ok(liveDependencies.transport);
      return {
        command: "delegation-reconcile",
        runId: RUN_ID,
        delegationId: DELEGATION_ID,
        role: "code-reviewer",
        mode: "background",
        state: "completed",
        generation: 1,
        resultStatus: "completed",
        nextActions: ["manual-review"],
      };
    },
    formatWorkflowResult: () => "ok",
  }), 0);
  await observePromise;
});

test("main wires the live Pi delegation transport only for live reconcile and approved remediation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-delegation-live-transport-"));
  const promptFile = join(dir, "remediation.md");
  await writeFile(promptFile, RAW_REQUEST);

  const calls = [];
  const fakeTransport = Object.freeze({
    async start() {
      throw new Error("transport start should not run in wiring tests");
    },
    async observeExact() {
      throw new Error("transport observeExact should not run in wiring tests");
    },
    async deliverFollowUp() {
      throw new Error("transport deliverFollowUp should not run in wiring tests");
    },
    async requestGracefulClose() {
      return { requested: false, manual: true };
    },
  });

  const sharedDependencies = {
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    lookupExecutable: async (name) => {
      assert.equal(name, "pi");
      return "/usr/bin/pi";
    },
    spawnDelegationChild: async () => {
      assert.fail("live transport wiring must not spawn Pi");
    },
    inspectDelegationProcess: async () => {
      assert.fail("live transport wiring must not inspect processes");
    },
    createPiDelegationTransport: (options) => {
      calls.push(options);
      return fakeTransport;
    },
    formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.state ?? value.status}`,
  };

  const reconcileOutput = io();
  const reconcileCode = await main(["delegation", "reconcile", RUN_ID, DELEGATION_ID], {
    ...sharedDependencies,
    ...reconcileOutput,
    delegationReconcileCommand: async (_options, liveDependencies) => {
      assert.equal(liveDependencies.transport, fakeTransport);
      return {
        command: "delegation-reconcile",
        runId: RUN_ID,
        delegationId: DELEGATION_ID,
        role: "code-reviewer",
        mode: "background",
        state: "completed",
        generation: 1,
        resultStatus: "completed",
        nextActions: ["deliver-result"],
      };
    },
  });
  assert.equal(reconcileCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].piCommand, "/usr/bin/pi");
  assert.equal(calls[0].stateRoot, "/state/workflow");
  assert.equal(typeof calls[0].controlPlaneBin, "string");
  assert.equal(typeof calls[0].spawnChild, "function");
  assert.equal(typeof calls[0].inspectProcess, "function");

  const remediateOutput = io();
  const remediateCode = await main(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", promptFile, "--yes", "--approval-digest", APPROVAL_DIGEST], {
    ...sharedDependencies,
    ...remediateOutput,
    isInteractive: () => false,
    delegationRemediateCommand: async (_options, liveDependencies) => {
      assert.equal(liveDependencies.transport, fakeTransport);
      return {
        preview: delegationRemediationPreview(),
        async execute() {
          return { command: "delegation-remediate", state: "running", nextActions: ["await-result"] };
        },
      };
    },
  });
  assert.equal(remediateCode, 0);
  assert.equal(calls.length, 2);

  const resultOutput = io();
  assert.equal(await main(["delegation", "result", RUN_ID, DELEGATION_ID], {
    ...sharedDependencies,
    ...resultOutput,
    delegationResultCommand: async (_options, liveDependencies) => {
      assert.equal(liveDependencies.transport, undefined);
      return { command: "delegation-result", runId: RUN_ID, delegationId: DELEGATION_ID, status: "completed", exitCode: 0 };
    },
  }), 0);

  const dryRunOutput = io();
  assert.equal(await main(["delegation", "remediate", RUN_ID, DELEGATION_ID, "--prompt-file", promptFile, "--dry-run"], {
    ...sharedDependencies,
    ...dryRunOutput,
    delegationRemediateCommand: async (_options, liveDependencies) => {
      assert.equal(liveDependencies.transport, undefined);
      return { preview: delegationRemediationPreview() };
    },
  }), 0);
  assert.equal(calls.length, 2);
});

test("live CLI remediation keeps manual recovery when post-spawn identity verification is unknown and blocks a second spawn", async (t) => {
  const fixture = await createCompletedDelegationCliFixture(t);
  const promptFile = join(fixture.root, "remediation.md");
  await writeFile(promptFile, RAW_REQUEST);

  const spawnCalls = [];
  const psCalls = [];
  const cwdReads = [];
  let unrefCount = 0;
  const originalSpawn = mutableChildProcess.spawn;
  mutableChildProcess.spawn = (command, argv, options) => {
    spawnCalls.push({ command, argv, options });
    const child = new EventEmitter();
    child.pid = 67890;
    child.unref = () => {
      unrefCount += 1;
    };
    queueMicrotask(() => {
      child.emit("spawn");
    });
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    mutableChildProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });

  const sharedDependencies = {
    out() {},
    err() {},
    stateRoot: fixture.stateRoot,
    store: fixture.store,
    delegations: fixture.delegations,
    reservations: fixture.reservations,
    roles: FIXTURE_ROLE_LOADER,
    loadRegistry: async () => FIXTURE_REGISTRY,
    lookupExecutable: async () => "/usr/bin/pi",
    runner: {
      async run(command, argv, options) {
        psCalls.push({ command, argv, options });
        return { code: 0, stdout: "Wed Jan  1 00:20:00 2025 S\n" };
      },
    },
    inspectDelegationProcess: async (identity) => {
      assert.equal(identity.pid, "12345");
      return null;
    },
    readDelegationCwd: async (path) => {
      cwdReads.push(path);
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
    createPiDelegationTransport: (options) => createPiDelegationTransport({
      ...options,
      loadDelegationRole: FIXTURE_ROLE_LOADER.loadDelegationRole,
    }),
  };

  const approvalDigest = await remediationApprovalDigest(sharedDependencies, RAW_REQUEST);
  const firstOutput = io();
  assert.equal(await main([
    "delegation",
    "remediate",
    RUN_ID,
    DELEGATION_ID,
    "--prompt-file",
    promptFile,
    "--yes",
    "--approval-digest",
    approvalDigest,
  ], {
    ...sharedDependencies,
    ...firstOutput,
  }), 0);

  const blockedRecord = (await fixture.store.read(RUN_ID)).delegations[DELEGATION_ID];
  assert.equal(blockedRecord.generation, 1);
  assert.equal(blockedRecord.remediation?.state, "manual-recovery");
  assert.equal(blockedRecord.remediation?.reason, "spawned-but-unverified");
  // The claim is retained so only the exact spawned child could still be
  // reconciled — as a digest, never as a readable secret in the run record.
  assert.equal(blockedRecord.remediation?.claimToken, undefined);
  assert.match(blockedRecord.remediation?.claimTokenDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(spawnCalls.length, 1);
  assert.equal(unrefCount, 1);
  assert.deepEqual(psCalls, [{
    command: "ps",
    argv: ["-p", "67890", "-o", "lstart=", "-o", "state="],
    options: { allowFailure: true },
  }]);
  assert.deepEqual(cwdReads, ["/proc/67890/cwd"]);

  const secondOutput = io();
  const secondApprovalDigest = await remediationApprovalDigest(sharedDependencies, RAW_REQUEST);
  assert.equal(await main([
    "delegation",
    "remediate",
    RUN_ID,
    DELEGATION_ID,
    "--prompt-file",
    promptFile,
    "--yes",
    "--approval-digest",
    secondApprovalDigest,
  ], {
    ...sharedDependencies,
    ...secondOutput,
  }), 10);
  assert.match(secondOutput.stderr[0], /claimed|launch|remediation/i);
  assert.equal(spawnCalls.length, 1);
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

test("verify dispatches to verifyCommand and exits per pass, fail, and refused", async () => {
  const cases = [
    [true, 0],
    [false, 1],
  ];

  for (const [passed, expectedCode] of cases) {
    const output = io();
    const code = await main(["verify", RUN_ID], {
      ...output,
      verifyCommand: async (options) => ({ command: "verify", runId: options.runId, results: [], passed, exitCode: expectedCode }),
      formatWorkflowResult: (command, value, format) => `${command}:${format}:${value.passed}`,
    });
    assert.equal(code, expectedCode);
    assert.deepEqual(output.stdout, [`verify:compact:${passed}`]);
    assert.deepEqual(output.stderr, []);
  }

  const refused = io();
  const code = await main(["verify", RUN_ID], {
    ...refused,
    verifyCommand: async (options) => ({
      command: "verify",
      runId: options.runId,
      results: [],
      passed: false,
      exitCode: 10,
      reason: "Project ocr has no verify commands configured.",
    }),
    formatWorkflowResult: (command, value) => `${command}:${value.exitCode}:${value.reason}`,
  });
  assert.equal(code, 10);
  assert.deepEqual(refused.stdout, ["verify:10:Project ocr has no verify commands configured."]);
});

test("verify with no run id is a usage error, not a crash", async () => {
  const output = io();
  const code = await main(["verify"], {
    ...output,
    verifyCommand: async () => {
      throw new Error("verifyCommand must not run without a run id");
    },
  });
  assert.equal(code, 64);
  assert.match(output.stderr[0], /USAGE/i);
  assert.match(output.stderr[0], /verify requires an argument/i);
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

test("main wires reconcile with the same ps-based process inspector unlock and gate-clear use, so its lock diagnostic can actually classify an owner", async () => {
  // reconcileCommand's read-only lock diagnostic expects deps.inspectProcess by that literal
  // name -- same aliasing unlock's and gate-clear's dispatch do (see the naming note where
  // inspectProcessByPid is constructed). Without this wiring, reconcile's lock verdict would be
  // "unprovable" for every held lock in real use, defeating the point of surfacing it at all.
  const output = io();
  const code = await main(["reconcile", "ocr", "--run", RUN_ID, "--format", "json"], {
    ...output,
    reconcileCommand: async (_options, reconcileDeps) => {
      assert.equal(typeof reconcileDeps.inspectProcess, "function");
      assert.equal(reconcileDeps.inspectProcess, reconcileDeps.inspectProcessByPid);
      return { command: "reconcile", runId: RUN_ID, status: "pending", nextActions: [] };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.status}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["reconcile:pending"]);
});

test("runs is read-only and passes the positional project, --state, and --all through to the command", async () => {
  const output = io();
  const calls = [];
  const code = await main(["runs", "acme", "--state", "running", "--format", "json"], {
    ...output,
    runsCommand: async (options) => {
      calls.push(options);
      return { command: "runs", runs: [], skipped: [], exitCode: 0 };
    },
    executeStart: async () => {
      throw new Error("runs must not launch or repair");
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    command: "runs",
    projectAlias: "acme",
    state: "running",
    format: "json",
    registryPath: join(packageRoot, "projects.yaml"),
  }]);
  assert.deepEqual(JSON.parse(output.stdout[0]), { command: "runs", runs: [], skipped: [], exitCode: 0 });
  assert.deepEqual(output.stderr, []);
});

test("runs --all reaches the command with no project narrowing", async () => {
  const output = io();
  const calls = [];
  const code = await main(["runs", "--all"], {
    ...output,
    runsCommand: async (options) => {
      calls.push(options);
      return { command: "runs", runs: [], skipped: [], exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.runs.length}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    command: "runs",
    all: true,
    format: "compact",
    registryPath: join(packageRoot, "projects.yaml"),
  }]);
  assert.deepEqual(output.stdout, ["runs:0"]);
});

test("inbox is read-only, exits 0, and passes the positional project through to the command", async () => {
  const output = io();
  const calls = [];
  const code = await main(["inbox", "acme", "--format", "json"], {
    ...output,
    inboxCommand: async (options) => {
      calls.push(options);
      return { command: "inbox", blocked: [], unresolved: [], herdrAvailable: true, skipped: [], exitCode: 0 };
    },
    executeStart: async () => {
      throw new Error("inbox must not launch or repair");
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    command: "inbox",
    projectAlias: "acme",
    format: "json",
    registryPath: join(packageRoot, "projects.yaml"),
  }]);
  assert.deepEqual(JSON.parse(output.stdout[0]), { command: "inbox", blocked: [], unresolved: [], herdrAvailable: true, skipped: [], exitCode: 0 });
  assert.deepEqual(output.stderr, []);
});

test("inbox with no project narrows nothing, and dispatches to the compact formatter by default", async () => {
  const output = io();
  const calls = [];
  const code = await main(["inbox"], {
    ...output,
    inboxCommand: async (options) => {
      calls.push(options);
      return { command: "inbox", blocked: [], unresolved: [], herdrAvailable: true, skipped: [], exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.blocked.length}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    command: "inbox",
    format: "compact",
    registryPath: join(packageRoot, "projects.yaml"),
  }]);
  assert.deepEqual(output.stdout, ["inbox:0"]);
});

test("workflow runs end-to-end against a real store: renders the board, an empty board, skipped residue, JSON with repositories, and refuses an unknown --state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-runs-cli-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateRoot = join(dir, "state");
  const store = createRunStore({ stateRoot });
  const run = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    state: RUN_STATES.PLANNED,
    repositories: [{ id: "repository", path: "/tmp/ocr", branch: "main" }],
  });
  await store.update(run.id, () => ({ state: RUN_STATES.LAUNCHING }));
  await store.update(run.id, () => ({ state: RUN_STATES.RUNNING }));

  const populated = io();
  assert.equal(await main(["runs"], { ...populated, stateRoot }), 0);
  assert.match(populated.stdout[0], /RUN\s+\| STATE/);
  assert.match(populated.stdout[0], /ocr/);
  assert.match(populated.stdout[0], /A-1/);
  assert.deepEqual(populated.stderr, []);

  const json = io();
  assert.equal(await main(["runs", "--format", "json"], { ...json, stateRoot }), 0);
  const parsed = JSON.parse(json.stdout[0]);
  assert.equal(parsed.runs.length, 1);
  assert.deepEqual(parsed.runs[0].repositories, [{ id: "repository", path: "/tmp/ocr", branch: "main" }]);

  const empty = io();
  assert.equal(await main(["runs", "acme"], { ...empty, stateRoot }), 0);
  assert.deepEqual(empty.stdout, ["Runs: none"]);

  const brokenRunId = "99999999-9999-4999-8999-999999999999";
  await mkdir(join(stateRoot, brokenRunId), { recursive: true, mode: 0o700 });
  await writeFile(join(stateRoot, brokenRunId, "run.json"), "not json", { mode: 0o600 });

  const skipped = io();
  assert.equal(await main(["runs"], { ...skipped, stateRoot }), 0);
  assert.match(skipped.stdout[0], new RegExp(`Skipped: 1 \\(${brokenRunId}\\)`));

  const bogus = io();
  assert.equal(await main(["runs", "--state", "bogus"], { ...bogus, stateRoot }), 64);
  // Same courtesy `--format`'s "must be compact or json." gets (bin/workflow.js:199): name what
  // was rejected AND every value that would have been accepted. A message asserted only against
  // `/Unknown run state/i` would have passed even if the valid states were never named -- which is
  // exactly the regression that shipped and went uncaught.
  assert.match(bogus.stderr[0], /USAGE.*Unknown run state: bogus\./i);
  for (const state of Object.values(RUN_STATES)) {
    assert.ok(bogus.stderr[0].includes(state), `expected the usage error to name valid state "${state}": ${bogus.stderr[0]}`);
  }
});

test("workflow inbox end-to-end against a real store: an empty inbox, a blocked run, an unresolved run, and skipped residue", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-inbox-cli-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateRoot = join(dir, "state");
  const store = createRunStore({ stateRoot });

  const empty = io();
  assert.equal(await main(["inbox"], { ...empty, stateRoot, herdr: { async listAgents() { return { agents: [] }; } } }), 0);
  assert.deepEqual(empty.stdout, ["Nothing waiting on you"]);
  assert.deepEqual(empty.stderr, []);

  const blockedRun = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    state: RUN_STATES.PLANNED,
    repositories: [{ id: "repository", path: "/tmp/ocr", branch: "main" }],
  });
  await store.update(blockedRun.id, () => ({ state: RUN_STATES.LAUNCHING }));
  await store.update(blockedRun.id, () => ({ state: RUN_STATES.RUNNING, paneId: "w1:p1" }));

  const populated = io();
  const herdrWithBlocked = { async listAgents() { return { agents: [{ agent: "pi", pane_id: "w1:p1", agent_status: "blocked", cwd: "/wt" }] }; } };
  assert.equal(await main(["inbox"], { ...populated, stateRoot, herdr: herdrWithBlocked }), 0);
  assert.match(populated.stdout[0], /^RUN\s+\|\s+PROJECT/);
  assert.match(populated.stdout[0], /ocr/);
  assert.match(populated.stdout[0], /A-1/);
  assert.deepEqual(populated.stderr, []);

  const json = io();
  assert.equal(await main(["inbox", "--format", "json"], { ...json, stateRoot, herdr: herdrWithBlocked }), 0);
  const parsed = JSON.parse(json.stdout[0]);
  assert.equal(parsed.blocked.length, 1);
  assert.equal(parsed.blocked[0].runId, blockedRun.id);
  assert.equal(parsed.blocked[0].paneId, "w1:p1");

  const scoped = io();
  assert.equal(await main(["inbox", "acme"], { ...scoped, stateRoot, herdr: herdrWithBlocked }), 0);
  assert.deepEqual(scoped.stdout, ["Nothing waiting on you"], "--project narrows away the ocr run entirely");

  const unresolvedCreate = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-2",
    state: RUN_STATES.PLANNED,
  });
  await store.update(unresolvedCreate.id, () => ({ state: RUN_STATES.LAUNCHING }));
  const unresolvedRun = await store.update(unresolvedCreate.id, () => ({ state: RUN_STATES.RUNNING }));
  const unresolved = io();
  assert.equal(await main(["inbox"], { ...unresolved, stateRoot, herdr: { async listAgents() { throw new Error("herdr unreachable"); } } }), 0);
  assert.match(unresolved.stdout[0], /^Blocked: none$/m);
  assert.match(unresolved.stdout[0], /^Unresolved:$/m);
  assert.match(unresolved.stdout[0], new RegExp(`${blockedRun.id.slice(0, 8)} \\| ocr/A-1 \\| .* \\| Herdr is unavailable`));
  assert.match(unresolved.stdout[0], new RegExp(`${unresolvedRun.id.slice(0, 8)} \\| ocr/A-2 \\| .* \\| Herdr is unavailable`));

  const brokenRunId = "99999999-9999-4999-8999-999999999999";
  await mkdir(join(stateRoot, brokenRunId), { recursive: true, mode: 0o700 });
  await writeFile(join(stateRoot, brokenRunId, "run.json"), "not json", { mode: 0o600 });

  const skipped = io();
  assert.equal(await main(["inbox"], { ...skipped, stateRoot, herdr: herdrWithBlocked }), 0);
  assert.match(skipped.stdout[0], new RegExp(`Skipped: 1 \\(${brokenRunId}\\)`));
});

// This is the one command in the CLI that runs a real shell (verify-runner.js's own documented
// departure) -- "against a real store" here means against a real store AND a real /bin/sh, using
// `true`/`false` as stand-ins for a project's own verify commands so the test proves the actual
// wiring (parseArgs -> verifyCommand -> the bounded shell runner -> store.appendEvent -> formatVerify)
// rather than a mocked slice of it. loadRegistry is still injected -- reading a real projects.yaml
// is registry.js's own concern, already covered elsewhere, and irrelevant to what this test proves.
test("workflow verify end-to-end against a real store and a real shell: passes, fails, refuses, and the evidence lands where workflow result reads it back", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-verify-cli-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateRoot = join(dir, "state");
  const repoPath = join(dir, "repo");
  await mkdir(repoPath, { recursive: true });
  const store = createRunStore({ stateRoot });

  const passingRun = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    repositories: [{ id: "ocr", path: repoPath, branch: "main" }],
  });
  const passingRegistry = async () => ({ projects: { ocr: { verify: ["true"] } } });

  const passed = io();
  assert.equal(await main(["verify", passingRun.id], { ...passed, stateRoot, loadRegistry: passingRegistry }), 0);
  assert.match(passed.stdout[0], /^Verify: passed$/m);
  assert.match(passed.stdout[0], /^ocr\s+\|\s+true\s+\|\s+passed\s+\|\s+0/m);
  assert.deepEqual(passed.stderr, []);

  const failingRun = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-2",
    repositories: [{ id: "ocr", path: repoPath, branch: "main" }],
  });
  const failingRegistry = async () => ({ projects: { ocr: { verify: ["true", "false"] } } });

  const failed = io();
  assert.equal(await main(["verify", failingRun.id], { ...failed, stateRoot, loadRegistry: failingRegistry }), 1);
  assert.match(failed.stdout[0], /^Verify: failed$/m);
  assert.match(failed.stdout[0], /^ocr\s+\|\s+true\s+\|\s+passed\s+\|\s+0/m);
  assert.match(failed.stdout[0], /^ocr\s+\|\s+false\s+\|\s+FAILED\s+\|\s+1/m);

  const json = io();
  assert.equal(await main(["verify", failingRun.id, "--format", "json"], { ...json, stateRoot, loadRegistry: failingRegistry }), 1);
  const parsedFailed = JSON.parse(json.stdout[0]);
  assert.equal(parsedFailed.passed, false);
  assert.equal(parsedFailed.results.length, 2);
  assert.deepEqual(parsedFailed.results.map((result) => result.status), ["passed", "failed"]);

  const refusedRun = await store.create({ projectAlias: "ocr", primaryTicket: "A-3" }); // no repositories[]
  const refused = io();
  assert.equal(await main(["verify", refusedRun.id], { ...refused, stateRoot, loadRegistry: passingRegistry }), 10);
  assert.match(refused.stdout[0], /^Verify: refused/m);
  assert.match(refused.stdout[0], /no repositories/i);

  // The evidence lands where `workflow result` reads it back -- no fake fs, no injected
  // resultCommand, the real one against the same real store.
  const result = io();
  assert.equal(await main(["result", passingRun.id], { ...result, stateRoot }), 20); // pending: no handoff submitted
  assert.match(result.stdout[0], /^Reported by the worker: none$/m);
  assert.match(result.stdout[0], /^Verified by workflow verify \(passed, ran \S+\):$/m);
  assert.match(result.stdout[0], /^ocr\s+\|\s+true\s+\|\s+passed\s+\|\s+0/m);
});

test("resume and close subcommands dispatch to their commands read-only until confirmed, wired with the live Pi delegation transport", async () => {
  const calls = [];
  const output = io();
  const fakeTransport = Object.freeze({
    async start() {
      throw new Error("resume/close wiring must not start a delegation");
    },
    async observeExact() {
      throw new Error("resume/close wiring must not observe directly; the command owns observation");
    },
    async deliverFollowUp() {
      throw new Error("resume/close wiring must not deliver a follow-up");
    },
    async requestGracefulClose() {
      throw new Error("resume/close wiring must not request a graceful close");
    },
  });
  const transportCalls = [];
  const sharedDependencies = {
    ...output,
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    lookupExecutable: async (name) => {
      assert.equal(name, "pi");
      return "/usr/bin/pi";
    },
    spawnDelegationChild: async () => {
      assert.fail("resume/close must not spawn a Pi process");
    },
    inspectDelegationProcess: async () => {
      assert.fail("resume/close must not inspect a process directly");
    },
    createPiDelegationTransport: (options) => {
      transportCalls.push(options);
      return fakeTransport;
    },
    resumeCommand: async (options, deps) => {
      calls.push(["resume", options.runId, options.confirmed]);
      assert.equal(deps.transport, fakeTransport);
      return { command: "resume", runId: options.runId, action: "focus" };
    },
    closeCommand: async (options, deps) => {
      calls.push(["close", options.runId]);
      assert.equal(deps.transport, fakeTransport);
      return { command: "close", runId: options.runId, closed: false, reason: "working" };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action ?? value.reason}`,
  };

  assert.equal(await main(["resume", RUN_ID], sharedDependencies), 0);
  assert.equal(await main(["close", RUN_ID], sharedDependencies), 0);

  assert.deepEqual(calls, [["resume", RUN_ID, false], ["close", RUN_ID]]);
  assert.deepEqual(output.stdout, ["resume:focus", "close:working"]);
  assert.deepEqual(output.stderr, []);
  assert.equal(transportCalls.length, 2);
  assert.equal(transportCalls[0].piCommand, "/usr/bin/pi");
  assert.equal(transportCalls[0].stateRoot, "/state/workflow");
});

test("resume --yes passes confirmed: true through to resumeCommand; without it, confirmed is false", async () => {
  const output = io();
  const confirmedValues = [];
  const sharedDependencies = {
    ...output,
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    lookupExecutable: async () => "/usr/bin/pi",
    createPiDelegationTransport: () => Object.freeze({
      async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {},
    }),
    resumeCommand: async (options) => {
      confirmedValues.push(options.confirmed);
      return { command: "resume", runId: options.runId, action: "needs-confirmation" };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  };

  assert.equal(await main(["resume", RUN_ID], sharedDependencies), 0);
  assert.equal(await main(["resume", RUN_ID, "--yes"], sharedDependencies), 0);

  assert.deepEqual(confirmedValues, [false, true]);
});

test("unlock --yes passes confirmed: true through to unlockCommand; without it, confirmed is false, and no delegation transport is built", async () => {
  const output = io();
  const confirmedValues = [];
  const code1 = await main(["unlock", RUN_ID], {
    ...output,
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    lookupExecutable: async () => {
      assert.fail("unlock must never resolve a delegation transport executable");
    },
    createPiDelegationTransport: () => {
      assert.fail("unlock must never build a delegation transport");
    },
    unlockCommand: async (options) => {
      confirmedValues.push(options.confirmed);
      return { command: "unlock", runId: options.runId, action: "needs-confirmation", exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });
  const code2 = await main(["unlock", RUN_ID, "--yes"], {
    ...output,
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    unlockCommand: async (options) => {
      confirmedValues.push(options.confirmed);
      return { command: "unlock", runId: options.runId, action: "removed", exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });

  assert.equal(code1, 0);
  assert.equal(code2, 0);
  assert.deepEqual(confirmedValues, [false, true]);
  assert.deepEqual(output.stdout, ["unlock:needs-confirmation", "unlock:removed"]);
});

test("unlock propagates a non-zero exitCode (the refused/11 conflict case) from the command report", async () => {
  const output = io();
  const code = await main(["unlock", RUN_ID, "--yes"], {
    ...output,
    loadRegistry: async () => ({ launcher: { state_root: "/state/workflow" }, projects: {} }),
    unlockCommand: async (options) => ({ command: "unlock", runId: options.runId, action: "refused", reason: "the owner process is still running", exitCode: 11 }),
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });
  assert.equal(code, 11);
  assert.deepEqual(output.stdout, ["unlock:refused"]);
});

test("main wires unlock with the real run store and the shared ps-based process inspector, reused (not rebuilt) across store operations, and the reader actually reaches the written lock marker", async () => {
  // Proves three wiring jobs: (1) unlock's process inspector reuses the same `ps -p <pid> -o
  // lstart= -o state=` invocation the delegation transport paths already use, (2) that SAME
  // inspector reaches the constructed run store as readOwnOwnership, memoized to exactly one
  // `ps` call for the whole CLI invocation no matter how many times the store acquires its own
  // lock, and (3) -- the discriminating part a bare ps-call count cannot prove on its own, per
  // Task 5 review round 2 -- that the reader's result actually lands in the marker acquireLock
  // writes: the marker read WHILE the lock is held (inside store.update's own updater, the same
  // hook workflow-run-store.test.js uses to observe it) carries this process's real pid.
  const dir = await mkdtemp(join(tmpdir(), "workflow-unlock-wiring-"));
  const stateRoot = join(dir, "state");
  const psCalls = [];
  const runner = {
    async run(command, argv, options) {
      psCalls.push({ command, argv, options });
      return { code: 0, stdout: "Wed Jan  1 00:10:00 2025 S\n" };
    },
  };

  let observedMarker = null;
  const output = io();
  const code = await main(["unlock", RUN_ID], {
    ...output,
    stateRoot,
    runner,
    unlockCommand: async (_options, unlockDeps) => {
      // unlockCommand's documented interface reads deps.inspectProcess by that literal name --
      // main's unlock dispatch aliases it there from liveDependencies.inspectProcessByPid (kept
      // distinctly named on the widely-shared liveDependencies bag so it never collides with the
      // delegation transport's differently-shaped, identity-based inspectProcess). Both names
      // resolve to the exact same function here.
      assert.equal(typeof unlockDeps.inspectProcess, "function");
      assert.equal(unlockDeps.inspectProcess, unlockDeps.inspectProcessByPid);
      assert.ok(unlockDeps.store);
      // Two independent lock acquisitions through the real, non-overridden store -- if
      // readOwnOwnership were not wired through, acquireLock would never call `ps` at all.
      const run = await unlockDeps.store.create({ runId: RUN_ID, projectAlias: "ocr", task: "ASANA-1" });
      const activePath = join(run.directory, "run.lock", "active");
      await unlockDeps.store.update(RUN_ID, async () => {
        // The lock is held for the duration of this updater -- read the live marker straight off
        // disk, exactly as workflow-run-store.test.js's own "acquired lock marker ... carries
        // pid, startedAt" test does, rather than inferring wiring from a call count alone.
        const [markerName] = await realFs.readdir(activePath);
        observedMarker = JSON.parse(await readFile(join(activePath, markerName), "utf8"));
        return {};
      });
      return { command: "unlock", runId: RUN_ID, action: "no-lock", exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["unlock:no-lock"]);
  // Exactly one `ps` call for the whole invocation (createOwnOwnershipReader's memoization),
  // targeting this process's own real pid, using the exact argv inspectDelegationPid already
  // builds for delegation inspection.
  assert.deepEqual(psCalls, [{
    command: "ps",
    argv: ["-p", String(process.pid), "-o", "lstart=", "-o", "state="],
    options: { allowFailure: true },
  }]);
  // The stronger assertion: if readOwnOwnership were NOT threaded into the store (silently
  // falling back to createRunStore's own `readOwnOwnership: async () => null` default), the
  // marker would carry no pid/startedAt at all and this would fail outright rather than merely
  // under-counting `ps` calls.
  assert.equal(observedMarker.pid, String(process.pid));
  assert.ok(observedMarker.startedAt);
});

test("workflow unlock end-to-end: classifies a proven-missing owner from a real crashed lock and removes it, using the reused ps wiring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-unlock-e2e-"));
  const stateRoot = join(dir, "state");
  const runDirectory = join(stateRoot, RUN_ID);
  const lockContainer = join(runDirectory, "run.lock");
  const activePath = join(lockContainer, "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const deadPid = "999999";
  const marker = { version: 2, token: "crashed-token", runId: RUN_ID, pid: deadPid, startedAt: "2024-12-31T00:00:00.000Z" };
  // Simulate crash residue directly on disk, exactly as workflow-run-store.test.js does: no
  // acquireLock/releaseLock cycle ever completes for a crashed run, so there is no store API
  // that leaves a lock lingering -- only raw fs mirrors what a real crash leaves behind.
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

  const psCalls = [];
  const runner = {
    async run(command, argv, options) {
      psCalls.push({ command, argv, options });
      // `ps -p <deadPid>` finds nothing: exit 1, no output -- proven gone.
      return { code: 1, stdout: "", stderr: "" };
    },
  };

  const output = io();
  const code = await main(["unlock", RUN_ID, "--yes"], { ...output, stateRoot, runner });

  assert.equal(code, 0);
  // unlockCommand classifies the marker twice by design: once up front, and once more inside
  // removeLock's `allow` against whatever marker removeLock itself re-reads (which may differ
  // from the first read) -- so this is two `ps` calls, both against the same real pid here since
  // nothing raced. Every call reuses the exact argv inspectDelegationPid already builds for
  // delegation inspection.
  const expectedPsCall = { command: "ps", argv: ["-p", deadPid, "-o", "lstart=", "-o", "state="], options: { allowFailure: true } };
  assert.deepEqual(psCalls, [expectedPsCall, expectedPsCall]);
  const report = JSON.parse(output.stdout[0]);
  assert.equal(report.action, "removed");
  assert.equal(report.ownership.verdict, "owner-gone");
  assert.equal(report.removed.markerPath, markerPath);
  assert.equal(report.cleanup, "none");
  assert.deepEqual(output.stderr, []);

  // The lock is actually gone from disk -- not just reported as gone.
  await assert.rejects(() => readdir(activePath));
});

test("delegation gate-clear --yes passes confirmed: true through to delegationGateClearCommand; without it, confirmed is false, and no delegation transport is built", async () => {
  const output = io();
  const confirmedValues = [];
  const code1 = await main(["delegation", "gate-clear", FIXTURE_PROJECT_ALIAS], {
    ...output,
    loadRegistry: async () => FIXTURE_REGISTRY,
    lookupExecutable: async () => {
      assert.fail("delegation gate-clear must never resolve a delegation transport executable");
    },
    createPiDelegationTransport: () => {
      assert.fail("delegation gate-clear must never build a delegation transport");
    },
    delegationGateClearCommand: async (options) => {
      confirmedValues.push(options.confirmed);
      return { command: "delegation-gate-clear", projectAlias: options.projectAlias, action: "needs-confirmation", exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });
  const code2 = await main(["delegation", "gate-clear", FIXTURE_PROJECT_ALIAS, "--yes"], {
    ...output,
    loadRegistry: async () => FIXTURE_REGISTRY,
    delegationGateClearCommand: async (options) => {
      confirmedValues.push(options.confirmed);
      return { command: "delegation-gate-clear", projectAlias: options.projectAlias, action: "cleared", exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });

  assert.equal(code1, 0);
  assert.equal(code2, 0);
  assert.deepEqual(confirmedValues, [false, true]);
  assert.deepEqual(output.stdout, ["delegation-gate-clear:needs-confirmation", "delegation-gate-clear:cleared"]);
});

test("delegation gate-clear propagates a non-zero exitCode (the refused/11 conflict case) from the command report", async () => {
  const output = io();
  const code = await main(["delegation", "gate-clear", FIXTURE_PROJECT_ALIAS, "--yes"], {
    ...output,
    loadRegistry: async () => FIXTURE_REGISTRY,
    delegationGateClearCommand: async (options) => ({ command: "delegation-gate-clear", projectAlias: options.projectAlias, action: "refused", reason: "the owner process is still running", exitCode: 11 }),
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });
  assert.equal(code, 11);
  assert.deepEqual(output.stdout, ["delegation-gate-clear:refused"]);
});

test("main wires delegation gate-clear with the real reservation store, sharing (not rebuilding) the run store's own ps-based readOwnOwnership reader", async () => {
  // Proves the wiring the task brief calls out explicitly: bin/workflow.js must construct
  // exactly one readOwnOwnership reader per process and pass that SAME reader to both the run
  // store and the reservation store -- never a second one for reservations.
  //
  // Task 5 review round 2: the original version of this test called store.create() BEFORE
  // reservations.reserve() and only checked the FINAL total (psCalls.length === 1). That does
  // not discriminate the actual failure mode ("reservations silently built with the default
  // null reader instead of the shared one"): a broken reservations reader contributes ZERO `ps`
  // calls, same as a correctly-SHARED (already-memoized) one, so the final total is 1 either
  // way. Reordering to call reservations.reserve() FIRST, alone, closes that gap: a null reader
  // means the assertion right after it fires with 0, not 1.
  const dir = await mkdtemp(join(tmpdir(), "workflow-gate-clear-wiring-"));
  const stateRoot = join(dir, "state");
  const psCalls = [];
  const runner = {
    async run(command, argv, options) {
      psCalls.push({ command, argv, options });
      return { code: 0, stdout: "Wed Jan  1 00:10:00 2025 S\n" };
    },
  };

  const output = io();
  const code = await main(["delegation", "gate-clear", FIXTURE_PROJECT_ALIAS], {
    ...output,
    stateRoot,
    runner,
    loadRegistry: async () => FIXTURE_REGISTRY,
    delegationGateClearCommand: async (_options, gateDeps) => {
      // delegationGateClearCommand's documented interface reads deps.inspectProcess by that
      // literal name -- same aliasing unlock's dispatch does, for the same reason (see the
      // naming note where inspectProcessByPid is constructed).
      assert.equal(typeof gateDeps.inspectProcess, "function");
      assert.equal(gateDeps.inspectProcess, gateDeps.inspectProcessByPid);
      assert.ok(gateDeps.store);
      assert.ok(gateDeps.reservations);

      // Reservations acquires ALONE first: if its own reader were the default null stub instead
      // of the shared one, this spends zero `ps` calls, and the assertion below catches it
      // immediately -- rather than being masked by a `ps` call the run store spends later.
      await gateDeps.reservations.reserve({
        projectAlias: FIXTURE_PROJECT_ALIAS,
        delegationId: DELEGATION_ID,
        role: "code-reviewer",
        mode: "background",
        checkoutPath: FIXTURE_CWD,
        policy: FIXTURE_POLICY,
      });
      assert.equal(psCalls.length, 1, "reservations.reserve alone must spend the one shared ps call");

      // The run store's own acquisition must REUSE that same memoized call, not spend a second
      // one (proving one reader per process, not two).
      await gateDeps.store.create({ runId: RUN_ID, projectAlias: FIXTURE_PROJECT_ALIAS, task: "ASANA-1" });
      assert.equal(psCalls.length, 1, "store.create must reuse the memoized reader, not spend a second ps call");

      return { command: "delegation-gate-clear", projectAlias: FIXTURE_PROJECT_ALIAS, action: "no-gate", exitCode: 0 };
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["delegation-gate-clear:no-gate"]);
  // Exactly one `ps` call for the whole invocation, shared across both mutex acquisitions.
  assert.deepEqual(psCalls, [{
    command: "ps",
    argv: ["-p", String(process.pid), "-o", "lstart=", "-o", "state="],
    options: { allowFailure: true },
  }]);
});

// Wraps fs.readFile to capture the raw bytes of a single target path the first time it is read,
// without altering what the caller sees. Mirrors workflow-delegation-reservations.test.js's own
// fsCapturingRead: used to observe the gate owner marker's exact content while releaseGate reads
// it (immediately before deleting it), since a successful reserve() releases the gate before
// returning and leaves nothing on disk to inspect afterward.
function fsCapturingReadForCliWiring(targetPath) {
  const captured = { text: null };
  const fs = {
    ...realFs,
    async readFile(path, encoding) {
      const text = await realFs.readFile(path, encoding);
      if (path === targetPath && captured.text === null) captured.text = text;
      return text;
    },
  };
  return { fs, captured };
}

test("main resolves the run store and reservation store from the registry's state_root (WORKFLOW_STATE_ROOT unset, the documented default) and still threads the single shared readOwnOwnership reader into both, producing provable owner markers", async () => {
  // Task 5 review round 2, finding 1: bin/workflow.js only pre-builds `store`/`reservations`
  // (with readOwnOwnership) when WORKFLOW_STATE_ROOT is set. That env var is normally UNSET --
  // projects.yaml's launcher.state_root is the documented, normal source (see
  // workflow-resume-close-commands.test.js's "registry-configured path" test for the run-store
  // precedent) -- so in the default configuration, `store`/`reservations` arrive undefined here
  // and commands.js's storeForCommand/reservationsForCommand must build them lazily instead. The
  // two prior wiring tests above never exercise that fallback at all, since they both hand
  // `stateRoot` directly to `main()`, which takes the pre-built branch. This test forces the
  // fallback branch by leaving `stateRoot` out of `main()`'s dependencies entirely and supplying
  // it only via a mocked registry, exactly as the real CLI does when the env var is unset.
  const dir = await mkdtemp(join(tmpdir(), "workflow-gate-clear-registry-wiring-"));
  const stateRoot = join(dir, "state");
  const psCalls = [];
  const runner = {
    async run(command, argv, options) {
      psCalls.push({ command, argv, options });
      return { code: 0, stdout: "Wed Jan  1 00:10:00 2025 S\n" };
    },
  };

  const output = io();
  const code = await main(["delegation", "gate-clear", FIXTURE_PROJECT_ALIAS], {
    ...output,
    env: { WORKFLOW_PROJECTS_FILE: "/tmp/projects.yaml" }, // WORKFLOW_STATE_ROOT deliberately absent
    runner,
    loadRegistry: async () => ({ ...FIXTURE_REGISTRY, launcher: { ...FIXTURE_REGISTRY.launcher, state_root: stateRoot } }),
    delegationGateClearCommand: async (options, gateDeps) => {
      // Confirms this test actually reached the fallback branch, not the pre-built one: with
      // WORKFLOW_STATE_ROOT unset and no dependencies.stateRoot, createLiveDependencies never
      // constructs `store`/`reservations` itself.
      assert.equal(gateDeps.store, undefined);
      assert.equal(gateDeps.reservations, undefined);
      // The fix's other half: bin/workflow.js must still expose the single per-process reader on
      // the deps bag so storeForCommand/reservationsForCommand can thread it through when they
      // build their own store/reservations, exactly the way the pre-built branch already did.
      assert.equal(typeof gateDeps.readOwnOwnership, "function");

      // Mirrors storeForCommand's/reservationsForCommand's own fallback construction call
      // exactly (same two constructor arguments, same public factories) to observe what a
      // marker acquired through THIS reader looks like -- gateDeps.reservations/.store cannot be
      // used directly here since delegationGateClearCommand's real body only ever inspects/clears
      // (never acquires), so there is no other way to observe an acquisition through this exact
      // deps.readOwnOwnership without either invoking the private helpers directly (unexported)
      // or reimplementing their one-line construction, which is what this does.
      const probeStore = createRunStore({ stateRoot, readOwnOwnership: gateDeps.readOwnOwnership });
      const probeRun = await probeStore.create({ runId: RUN_ID, projectAlias: FIXTURE_PROJECT_ALIAS, task: "ASANA-1" });
      let lockMarker = null;
      await probeStore.update(RUN_ID, async () => {
        const activePath = join(probeRun.directory, "run.lock", "active");
        const [markerName] = await realFs.readdir(activePath);
        lockMarker = JSON.parse(await readFile(join(activePath, markerName), "utf8"));
        return {};
      });
      assert.equal(lockMarker.pid, String(process.pid));
      assert.ok(lockMarker.startedAt);

      const { fs: capturingFs, captured } = fsCapturingReadForCliWiring(join(stateRoot, "delegation-reservations", "projects", createHash("sha256").update(FIXTURE_PROJECT_ALIAS, "utf8").digest("hex"), "gate", "active", "owner.json"));
      const probeReservations = createDelegationReservationStore({ stateRoot, fs: capturingFs, readOwnOwnership: gateDeps.readOwnOwnership });
      await probeReservations.reserve({
        projectAlias: FIXTURE_PROJECT_ALIAS,
        delegationId: DELEGATION_ID,
        role: "code-reviewer",
        mode: "background",
        checkoutPath: FIXTURE_CWD,
        policy: FIXTURE_POLICY,
      });
      assert.ok(captured.text, "expected releaseGate to have read the gate owner marker before deleting it");
      const gateMarker = JSON.parse(captured.text);
      assert.equal(gateMarker.pid, String(process.pid));
      assert.ok(gateMarker.startedAt);

      return await defaultDelegationGateClearCommand(options, gateDeps);
    },
    formatWorkflowResult: (command, value) => `${command}:${value.action}`,
  });

  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["delegation-gate-clear:no-gate"]);
  // The one real reader is shared: exactly one `ps` call across both probe acquisitions.
  assert.deepEqual(psCalls, [{
    command: "ps",
    argv: ["-p", String(process.pid), "-o", "lstart=", "-o", "state="],
    options: { allowFailure: true },
  }]);
});

test("workflow delegation gate-clear end-to-end: classifies a proven-missing owner from a real crashed gate and clears it, using the reused ps wiring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-gate-clear-e2e-"));
  const stateRoot = join(dir, "state");
  const projectDigest = createHash("sha256").update(FIXTURE_PROJECT_ALIAS, "utf8").digest("hex");
  const gateContainer = join(stateRoot, "delegation-reservations", "projects", projectDigest, "gate");
  const activePath = join(gateContainer, "active");
  const markerPath = join(activePath, "owner.json");
  const deadPid = "999999";
  const marker = { version: 2, ownerToken: "33333333-3333-4333-8333-333333333333", pid: deadPid, startedAt: "2024-12-31T00:00:00.000Z" };
  // Simulate crash residue directly on disk: no acquireGate/releaseGate cycle ever completes
  // for a crashed operator, so there is no store API that leaves a gate lingering -- only raw
  // fs mirrors what a real crash leaves behind.
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

  const psCalls = [];
  const runner = {
    async run(command, argv, options) {
      psCalls.push({ command, argv, options });
      // `ps -p <deadPid>` finds nothing: exit 1, no output -- proven gone.
      return { code: 1, stdout: "", stderr: "" };
    },
  };

  const output = io();
  const code = await main(["delegation", "gate-clear", FIXTURE_PROJECT_ALIAS, "--yes"], {
    ...output,
    stateRoot,
    runner,
    loadRegistry: async () => FIXTURE_REGISTRY,
  });

  assert.equal(code, 0);
  // delegationGateClearCommand classifies the marker twice by design: once up front, and once
  // more inside clearGate's `allow` against whatever marker clearGate itself re-reads (which may
  // differ from the first read) -- so this is two `ps` calls, both against the same real pid
  // here since nothing raced.
  const expectedPsCall = { command: "ps", argv: ["-p", deadPid, "-o", "lstart=", "-o", "state="], options: { allowFailure: true } };
  assert.deepEqual(psCalls, [expectedPsCall, expectedPsCall]);
  const report = JSON.parse(output.stdout[0]);
  assert.equal(report.action, "cleared");
  assert.equal(report.ownership.verdict, "owner-gone");
  assert.equal(report.cleared.activeGate, activePath);
  assert.equal(report.cleanup, "none");
  assert.deepEqual(output.stderr, []);

  // The gate is actually gone from disk -- not just reported as gone.
  await assert.rejects(() => readdir(activePath));
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

  const delegationService = io();
  assert.equal(await main(["delegation", "reconcile", RUN_ID, DELEGATION_ID], {
    ...delegationService,
    transport: UNUSED_DELEGATION_TRANSPORT,
    delegationReconcileCommand: async () => {
      throw new WorkflowError("delegation-service", "exact worker must be idle");
    },
  }), 10);
  assert.deepEqual(delegationService.stderr, ["PREFLIGHT: exact worker must be idle"]);

  const resume = io();
  assert.equal(await main(["resume", RUN_ID], {
    ...resume,
    transport: UNUSED_DELEGATION_TRANSPORT,
    resumeCommand: async () => {
      throw new WorkflowError("resume", "Run has no exact session identity to resume");
    },
  }), 10);
  assert.deepEqual(resume.stderr, ["PREFLIGHT: Run has no exact session identity to resume"]);

  const close = io();
  assert.equal(await main(["close", RUN_ID], {
    ...close,
    transport: UNUSED_DELEGATION_TRANSPORT,
    closeCommand: async () => {
      throw new WorkflowError("close", "close requires a worker transport");
    },
  }), 10);
  assert.deepEqual(close.stderr, ["PREFLIGHT: close requires a worker transport"]);
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
