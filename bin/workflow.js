#!/usr/bin/env node
import { spawn as spawnChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, realpath as fsRealpath } from "node:fs/promises";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createProcessRunner } from "../src/workflow/process.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { createHerdrAdapter } from "../src/workflow/herdr.js";
import { ASSIGNMENT_LIMITS } from "../src/workflow/assignment.js";
import { WorkflowError } from "../src/workflow/errors.js";
import {
  closeCommand as defaultCloseCommand,
  delegationGateClearCommand as defaultDelegationGateClearCommand,
  delegationHandoffCommand as defaultDelegationHandoffCommand,
  delegationReconcileCommand as defaultDelegationReconcileCommand,
  delegationReleaseCommand as defaultDelegationReleaseCommand,
  delegationRemediateCommand as defaultDelegationRemediateCommand,
  delegationResultCommand as defaultDelegationResultCommand,
  doctorCommand as defaultDoctorCommand,
  handoffCommand as defaultHandoffCommand,
  inboxCommand as defaultInboxCommand,
  launchCommand as defaultLaunchCommand,
  planCommand as defaultPlanCommand,
  reconcileCommand as defaultReconcileCommand,
  resultCommand as defaultResultCommand,
  resumeCommand as defaultResumeCommand,
  runsCommand as defaultRunsCommand,
  statusCommand as defaultStatusCommand,
  unlockCommand as defaultUnlockCommand,
  verifyCommand as defaultVerifyCommand,
  workerStatusCommand as defaultWorkerStatusCommand,
  workerWatchCommand as defaultWorkerWatchCommand,
} from "../src/workflow/commands.js";
import { executeStart as defaultExecuteStart, executeRuntime as defaultExecuteRuntime } from "../src/workflow/execute.js";
import { ensureCodexWorkerHooks as defaultEnsureCodexWorkerHooks } from "../src/workflow/codex-hooks.js";
import { createDelegationReservationStore } from "../src/workflow/delegation-reservations.js";
import { createOwnOwnershipReader } from "../src/workflow/ownership.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { formatWorkflowResult as defaultFormatWorkflowResult } from "../src/workflow/format.js";
import { inspectExactProcessByPid, psStatusArgv } from "../src/workflow/process-observation.js";
import { createPiDelegationTransport as defaultCreatePiDelegationTransport } from "../src/workflow/pi-delegation-transport.js";
import { loadRegistry as defaultLoadRegistry } from "../src/workflow/registry.js";
import { lookupExecutable, resolveWorkflowProjectsFile } from "../src/workflow/runtime-config.js";

const OUTPUT_LIMIT = 12000;
const LAUNCH_OUTPUT_LIMIT = 256 * 1024;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRegistryPath = join(packageRoot, "projects.yaml");
const HELP = `workflow — deterministic launcher for isolated development environments

Commands:
  workflow doctor [project] [--agent <profile>] [--format compact|json]
  workflow plan <project> <task> [--feature <text>] [--repos <csv>] [--tickets <csv>] [--profile <name>] [--agent <profile>] [--format compact|json]
  workflow start <project> <task> [--feature <text>] [--repos <csv>] [--tickets <csv>] [--agent <profile>] [--format compact|json] [--yes]
  workflow launch <project> <primary-ticket> --prompt-file <path> [--tickets <csv>] [--feature <text>] [--repos <csv>] [--agent <profile>] [--selection-reason <text>] [--origin-session <id>] [--dry-run] [--approval-digest <digest>] [--format compact|json] [--yes]
  workflow result <run-id> [--format compact|json]
  workflow verify <run-id> [--format compact|json]
  workflow reconcile [project] --run <run-id> [--format compact|json]
  workflow runs [project] [--state <state>] [--all] [--format compact|json]
  workflow inbox [project] [--format compact|json]
  workflow resume <run-id> [--yes] [--format compact|json]
  workflow close <run-id> [--format compact|json]
  workflow unlock <run-id> [--yes] [--format compact|json]
  workflow worker status <run-id> [--format compact|json]
  workflow worker watch <run-id> [--format compact|json]
  workflow runtime <project> <task> [--feature <text>] [--repos <csv>] [--tickets <csv>] [--profile <name>] [--format compact|json] [--yes]
  workflow status <project> <task> [--feature <text>] [--repos <csv>] [--tickets <csv>] [--profile <name>] [--agent <profile>] [--format compact|json]
  workflow handoff <run-id> --input <run-dir>/handoff-input.json [--format compact|json]
  workflow delegation result <run-id> <delegation-id> [--format compact|json]
  workflow delegation reconcile <run-id> <delegation-id> [--format compact|json]
  workflow delegation remediate <run-id> <delegation-id> --prompt-file <path> [--dry-run] [--approval-digest <digest>] [--format compact|json] [--yes]
  workflow delegation handoff <run-id> <delegation-id> --input <run-dir>/delegations/<delegation-id>/handoff-input.json [--format compact|json]
  workflow delegation release <run-id> <delegation-id> [--format compact|json] [--yes]
  workflow delegation gate-clear <project> [--format compact|json] [--yes]

Environment:
  WORKFLOW_PROJECTS_FILE   Alternate workflow registry path
  WORKFLOW_STATE_ROOT      Workflow run-state root for handoff`;
const KNOWN_OPTIONS = new Set(["feature", "repos", "tickets", "profile", "agent", "format", "yes", "help", "input", "prompt-file", "selection-reason", "origin-session", "dry-run", "approval-digest", "run", "state", "all"]);

function bound(text, limit = OUTPUT_LIMIT) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n");
  if (value.length <= limit) return value;
  const suffix = `\n...[output truncated at ${limit} characters]`;
  return value.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}

function emit(writer, text, { limit = OUTPUT_LIMIT } = {}) {
  writer(bound(text, limit));
}

function consumeOptions(tokens) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    if (!KNOWN_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: --${name}`);
    if (name === "yes" || name === "help" || name === "dry-run" || name === "all") {
      options[name] = true;
      continue;
    }

    const next = tokens[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} requires a value.`);
    options[name] = next;
  }
  return { options, positionals };
}

function validateShape(command, positionals, options, { min = 0, max = min, allowedOptions = [] }) {
  if (positionals.length < min) throw new Error(`${command} requires ${min === 1 ? "an argument" : `${min} arguments`}.`);
  if (positionals.length > max) throw new Error(`${command} received an unexpected argument: ${positionals[max]}`);
  for (const name of Object.keys(options)) {
    if (name !== "format" && !allowedOptions.includes(name)) throw new Error(`${command} does not accept --${name}.`);
  }
}

function parseCsvList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:\//;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertCanonicalHandoffInputSyntax(input) {
  const normalized = String(input ?? "").replace(/\\/gu, "/");
  if (!normalized.includes("/") || !normalized.endsWith("/handoff-input.json") || normalized.includes("/../") || normalized.startsWith("../")) {
    throw new Error("handoff --input must be the canonical <run-directory>/handoff-input.json path.");
  }
}

function assertCanonicalDelegationHandoffInputSyntax(input) {
  const normalized = String(input ?? "").replace(/\\/gu, "/");
  const absolute = normalized.startsWith("/") || WINDOWS_ABSOLUTE_RE.test(normalized);
  const parts = normalized.split("/");
  const delegationIndex = parts.lastIndexOf("delegations");
  const delegationPathId = parts.at(-2);
  const hasEmptySegment = parts.some((part, index) => part.length === 0 && !(index === 0 && normalized.startsWith("/")));
  const hasTraversal = parts.some((part) => part === "." || part === "..");

  if (!absolute || normalized.includes("\0") || hasEmptySegment || hasTraversal || parts.at(-1) !== "handoff-input.json" || delegationIndex < 2 || delegationIndex !== parts.length - 3 || !SAFE_PATH_SEGMENT_RE.test(delegationPathId ?? "")) {
    throw new Error("delegation handoff --input must be the canonical <run-directory>/delegations/<delegation-id>/handoff-input.json path.");
  }
}

function assertPathSafeUuidSyntax(value, context) {
  if (typeof value !== "string" || !SAFE_UUID_RE.test(value)) {
    throw new Error(`${context} must be a path-safe UUID.`);
  }
}

function usageError(message) {
  throw new WorkflowError("USAGE", message, { exitCode: 64 });
}

async function readPromptFile(path) {
  if (typeof path !== "string" || !path.trim()) {
    usageError("launch requires --prompt-file <path>.");
  }
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    usageError(`Prompt file could not be read (${error?.code ?? "FS_ERROR"}).`);
  }
  if (bytes.length > ASSIGNMENT_LIMITS.requestBytes) {
    usageError("Prompt file request exceeds the 64 KiB limit.");
  }
  if (bytes.includes(0)) {
    usageError("Prompt file request contains invalid NUL characters.");
  }
  const request = bytes.toString("utf8");
  if (!Buffer.from(request, "utf8").equals(bytes)) {
    usageError("Prompt file request must be valid UTF-8 text.");
  }
  if (request.trim().length === 0) {
    usageError("Prompt file request is empty.");
  }
  return request;
}

export function parseArgs(argv) {
  if (!argv.length || (argv.length === 1 && ["help", "--help"].includes(argv[0]))) {
    return { command: "help", format: "compact" };
  }

  const [command, ...rest] = argv;
  const { options, positionals } = consumeOptions(rest);
  const format = options.format ?? "compact";
  if (!["compact", "json"].includes(format)) throw new Error("--format must be compact or json.");

  if (command === "doctor") {
    validateShape("doctor", positionals, options, { min: 0, max: 1, allowedOptions: ["agent"] });
    return {
      command,
      projectAlias: positionals[0],
      ...(options.agent ? { agentProfile: options.agent } : {}),
      format,
    };
  }

  if (command === "handoff") {
    validateShape("handoff", positionals, options, { min: 1, max: 1, allowedOptions: ["input"] });
    if (!options.input) throw new Error("handoff requires --input <run-dir>/handoff-input.json.");
    assertCanonicalHandoffInputSyntax(options.input);
    return {
      command,
      runId: positionals[0],
      input: options.input,
      format,
    };
  }

  if (command === "delegation") {
    const subcommand = positionals[0];
    if (subcommand === "result") {
      validateShape("delegation result", positionals.slice(1), options, { min: 2, max: 2, allowedOptions: [] });
      assertPathSafeUuidSyntax(positionals[1], "delegation result run ID");
      assertPathSafeUuidSyntax(positionals[2], "delegation result delegation ID");
      return {
        command: "delegation-result",
        runId: positionals[1],
        delegationId: positionals[2],
        format,
      };
    }
    if (subcommand === "reconcile") {
      validateShape("delegation reconcile", positionals.slice(1), options, { min: 2, max: 2, allowedOptions: [] });
      assertPathSafeUuidSyntax(positionals[1], "delegation reconcile run ID");
      assertPathSafeUuidSyntax(positionals[2], "delegation reconcile delegation ID");
      return {
        command: "delegation-reconcile",
        runId: positionals[1],
        delegationId: positionals[2],
        format,
      };
    }
    if (subcommand === "remediate") {
      validateShape("delegation remediate", positionals.slice(1), options, { min: 2, max: 2, allowedOptions: ["prompt-file", "dry-run", "approval-digest", "yes"] });
      if (!options["prompt-file"]) throw new Error("delegation remediate requires --prompt-file <path>.");
      assertPathSafeUuidSyntax(positionals[1], "delegation remediate run ID");
      assertPathSafeUuidSyntax(positionals[2], "delegation remediate delegation ID");
      return {
        command: "delegation-remediate",
        runId: positionals[1],
        delegationId: positionals[2],
        promptFile: options["prompt-file"],
        ...(options["dry-run"] ? { dryRun: true } : {}),
        ...(options["approval-digest"] ? { approvalDigest: options["approval-digest"] } : {}),
        ...(options.yes ? { yes: true } : {}),
        format,
      };
    }
    if (subcommand === "release") {
      validateShape("delegation release", positionals.slice(1), options, { min: 2, max: 2, allowedOptions: ["yes"] });
      assertPathSafeUuidSyntax(positionals[1], "delegation release run ID");
      assertPathSafeUuidSyntax(positionals[2], "delegation release delegation ID");
      return {
        command: "delegation-release",
        runId: positionals[1],
        delegationId: positionals[2],
        ...(options.yes ? { yes: true } : {}),
        format,
      };
    }
    if (subcommand === "gate-clear") {
      validateShape("delegation gate-clear", positionals.slice(1), options, { min: 1, max: 1, allowedOptions: ["yes"] });
      return {
        command: "delegation-gate-clear",
        projectAlias: positionals[1],
        ...(options.yes ? { yes: true } : {}),
        format,
      };
    }
    if (subcommand === "handoff") {
      validateShape("delegation handoff", positionals.slice(1), options, { min: 2, max: 2, allowedOptions: ["input"] });
      if (!options.input) throw new Error("delegation handoff requires --input <run-dir>/delegations/<delegation-id>/handoff-input.json.");
      assertPathSafeUuidSyntax(positionals[1], "delegation handoff run ID");
      assertPathSafeUuidSyntax(positionals[2], "delegation handoff delegation ID");
      assertCanonicalDelegationHandoffInputSyntax(options.input);
      return {
        command: "delegation-handoff",
        runId: positionals[1],
        delegationId: positionals[2],
        input: options.input,
        format,
      };
    }
    throw new Error(`Unknown command: ${argv.join(" ")}\n\n${HELP}`);
  }

  if (command === "worker") {
    const subcommand = positionals[0];
    if (subcommand !== "status" && subcommand !== "watch") {
      throw new Error(`Unknown command: ${argv.join(" ")}\n\n${HELP}`);
    }
    validateShape(`worker ${subcommand}`, positionals.slice(1), options, { min: 1, max: 1, allowedOptions: [] });
    assertPathSafeUuidSyntax(positionals[1], `worker ${subcommand} run ID`);
    return {
      command: `worker-${subcommand}`,
      runId: positionals[1],
      format,
    };
  }

  if (command === "result") {
    validateShape("result", positionals, options, { min: 1, max: 1, allowedOptions: [] });
    assertPathSafeUuidSyntax(positionals[0], "result run ID");
    return {
      command,
      runId: positionals[0],
      format,
    };
  }

  if (command === "verify") {
    validateShape("verify", positionals, options, { min: 1, max: 1, allowedOptions: [] });
    assertPathSafeUuidSyntax(positionals[0], "verify run ID");
    return {
      command,
      runId: positionals[0],
      format,
    };
  }

  if (command === "reconcile") {
    validateShape("reconcile", positionals, options, { min: 0, max: 1, allowedOptions: ["run"] });
    if (!options.run) throw new Error("reconcile requires --run <run-id>.");
    assertPathSafeUuidSyntax(options.run, "reconcile run ID");
    return {
      command,
      ...(positionals[0] ? { projectAlias: positionals[0] } : {}),
      runId: options.run,
      format,
    };
  }

  if (command === "runs") {
    validateShape("runs", positionals, options, { min: 0, max: 1, allowedOptions: ["state", "all"] });
    return {
      command,
      ...(positionals[0] ? { projectAlias: positionals[0] } : {}),
      ...(options.state ? { state: options.state } : {}),
      ...(options.all ? { all: true } : {}),
      format,
    };
  }

  if (command === "inbox") {
    validateShape("inbox", positionals, options, { min: 0, max: 1, allowedOptions: [] });
    return {
      command,
      ...(positionals[0] ? { projectAlias: positionals[0] } : {}),
      format,
    };
  }

  if (command === "resume") {
    validateShape("resume", positionals, options, { min: 1, max: 1, allowedOptions: ["yes"] });
    assertPathSafeUuidSyntax(positionals[0], "resume run ID");
    return {
      command,
      runId: positionals[0],
      ...(options.yes ? { yes: true } : {}),
      format,
    };
  }

  if (command === "close") {
    validateShape("close", positionals, options, { min: 1, max: 1, allowedOptions: [] });
    assertPathSafeUuidSyntax(positionals[0], "close run ID");
    return {
      command,
      runId: positionals[0],
      format,
    };
  }

  if (command === "unlock") {
    validateShape("unlock", positionals, options, { min: 1, max: 1, allowedOptions: ["yes"] });
    assertPathSafeUuidSyntax(positionals[0], "unlock run ID");
    return {
      command,
      runId: positionals[0],
      ...(options.yes ? { yes: true } : {}),
      format,
    };
  }

  const baseOptions = {
    command,
    projectAlias: positionals[0],
    task: positionals[1],
    ...(options.feature ? { feature: options.feature } : {}),
    ...(options.repos ? { repositories: parseCsvList(options.repos) } : {}),
    ...(options.tickets ? { tickets: parseCsvList(options.tickets) } : {}),
    ...(options.profile ? { runtimeProfile: options.profile } : {}),
    ...(options.agent ? { agentProfile: options.agent } : {}),
    ...(options.yes ? { yes: true } : {}),
    format,
  };

  if (command === "launch") {
    validateShape("launch", positionals, options, { min: 2, max: 2, allowedOptions: ["feature", "repos", "tickets", "agent", "prompt-file", "selection-reason", "origin-session", "dry-run", "approval-digest", "yes"] });
    if (!options["prompt-file"]) throw new Error("launch requires --prompt-file <path>.");
    return {
      command,
      projectAlias: positionals[0],
      task: positionals[1],
      ...(options.feature ? { feature: options.feature } : {}),
      ...(options.repos ? { repositories: parseCsvList(options.repos) } : {}),
      ...(options.tickets ? { tickets: parseCsvList(options.tickets) } : {}),
      ...(options.agent ? { agentProfile: options.agent } : {}),
      promptFile: options["prompt-file"],
      ...(options["selection-reason"] ? { selectionReason: options["selection-reason"] } : {}),
      ...(options["origin-session"] ? { originSession: options["origin-session"] } : {}),
      ...(options["dry-run"] ? { dryRun: true } : {}),
      ...(options["approval-digest"] ? { approvalDigest: options["approval-digest"] } : {}),
      ...(options.yes ? { yes: true } : {}),
      format,
    };
  }

  if (command === "plan") {
    validateShape("plan", positionals, options, { min: 2, max: 2, allowedOptions: ["feature", "repos", "tickets", "profile", "agent"] });
    return baseOptions;
  }
  if (command === "start") {
    validateShape("start", positionals, options, { min: 2, max: 2, allowedOptions: ["feature", "repos", "tickets", "agent", "yes"] });
    return baseOptions;
  }
  if (command === "runtime") {
    validateShape("runtime", positionals, options, { min: 2, max: 2, allowedOptions: ["feature", "repos", "tickets", "profile", "yes"] });
    return baseOptions;
  }
  if (command === "status") {
    validateShape("status", positionals, options, { min: 2, max: 2, allowedOptions: ["feature", "repos", "tickets", "profile", "agent"] });
    return baseOptions;
  }

  throw new Error(`Unknown command: ${argv.join(" ")}\n\n${HELP}`);
}

function createLiveDependencies(dependencies) {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? createProcessRunner();
  const stateRoot = dependencies.stateRoot ?? env.WORKFLOW_STATE_ROOT;
  // list() skips run directories it cannot read (crash residue the no-cleanup
  // policy preserves) instead of failing wholesale. Report each skip on stderr so
  // a run silently vanishing from status/close is visible to the operator.
  const reportListProblem = dependencies.onListProblem ?? ((problem) => {
    process.stderr.write(bound(`WARNING: skipped unreadable run ${problem?.runId ?? "unknown"} (${problem?.message ?? "unreadable"})\n`, 1024));
  });
  // The generic `(pid) => observation|null` process inspector: reused as-is (same `ps -p <pid>
  // -o lstart= -o state=` wiring as the delegation transport paths, see inspectDelegationPid
  // below) both to give the run store's own lock-acquisition marker a provable pid/startedAt
  // (via readOwnOwnership, memoized just below) and to let `workflow unlock` observe an
  // arbitrary lock owner's pid. Constructed exactly once per process, here — never per store,
  // per command, or per unlock invocation.
  //
  // Deliberately NOT named `inspectProcess` on liveDependencies (the bag returned below, which
  // withLiveDelegationTransport and every delegation command spread wholesale): the delegation
  // transport already has its own `inspectProcess` with an INCOMPATIBLE contract --
  // `(identity) => ...` in pi-delegation-transport.js, vs. this one's `(pid) => ...`. Two
  // same-named, different-shaped functions sitting in the same routinely-spread bag would let a
  // future mis-wire (e.g. a command destructuring `deps.inspectProcess` expecting the identity
  // form) fail silently, since transport construction only validates `typeof === "function"`.
  // The distinct name costs nothing; only unlock's own dispatch (bin/workflow.js's `main`)
  // aliases this back to the literal `inspectProcess` key unlockCommand's documented interface
  // expects, and only on the small deps object built for that one call.
  const inspectProcessByPid = dependencies.inspectProcessByPid ?? ((pid) => inspectDelegationPid(pid, { runner }));
  // One reader per process, memoized to a single `ps` call for this process's own pid --
  // createOwnOwnershipReader (not the store) owns that memoization; constructing a fresh reader
  // per store/command would spend a `ps` call on every lock acquisition instead of one per CLI
  // invocation.
  const readOwnOwnership = dependencies.readOwnOwnership ?? createOwnOwnershipReader({ inspectProcess: inspectProcessByPid });
  return {
    env,
    runner,
    stateRoot,
    loadRegistry: dependencies.loadRegistry ?? defaultLoadRegistry,
    lookupExecutable: dependencies.lookupExecutable ?? ((name) => lookupExecutable(name, { env })),
    // doctor-only: reads `<harness binary> --version` so a harness upgrade that
    // silently blanks telemetry (versions are pinned and fail closed) becomes
    // visible. Read-only and bounded; failures degrade to an "unknown" check.
    harnessVersion: dependencies.harnessVersion ?? (async (selectedAgent) => {
      const command = selectedAgent?.profile?.command;
      if (typeof command !== "string" || !command) return null;
      // Resolve through PATH once and exec the absolute path, matching every
      // other exec site: doctor must not run whatever happens to shadow the name.
      const resolved = await lookupExecutable(command, { env });
      if (!resolved) return null;
      const { stdout } = await runner.run(resolved, ["--version"], { timeoutMs: 10_000, allowFailure: true });
      const match = String(stdout ?? "").match(/\d+\.\d+\.\d+/);
      return match ? match[0] : null;
    }),
    git: dependencies.git ?? createGitAdapter({ runner }),
    herdr: dependencies.herdr ?? createHerdrAdapter({ runner }),
    inspectProcessByPid,
    // Exposed so commands.js's storeForCommand/reservationsForCommand can thread this SAME
    // reader through when they build their own store/reservations lazily -- the normal path
    // whenever WORKFLOW_STATE_ROOT is unset (the documented default; state_root then comes from
    // the registry instead, see stateRootForCommand), since `store`/`reservations` below are only
    // pre-built here when `stateRoot` is already known. Without this, that default-configuration
    // path would silently fall back to each store's own `readOwnOwnership: async () => null`.
    readOwnOwnership,
    store: dependencies.store ?? (stateRoot ? createRunStore({ stateRoot, onListProblem: reportListProblem, readOwnOwnership }) : undefined),
    // Real wiring for launch.js's best-effort Codex hook install (see isCodexInteractiveAgent
    // there): only assembled here, at the live-dependency boundary, so that unit tests of
    // launch.js — which exercise the default codex-worker interactive profile pervasively —
    // never get a real, filesystem-touching default and can never write to a developer's
    // actual ~/.codex/hooks.json.
    ensureCodexWorkerHooks: dependencies.ensureCodexWorkerHooks ?? defaultEnsureCodexWorkerHooks,
    transport: dependencies.transport,
    delegations: dependencies.delegations,
    // Same readOwnOwnership reader as `store` above -- constructed exactly once per process, not
    // once per store. Without this, real reservation gate markers carry no pid/startedAt (the
    // store's own default is `readOwnOwnership: async () => null`) and `workflow delegation
    // gate-clear` would report every gate as unprovable, never removable.
    reservations: dependencies.reservations ?? (stateRoot ? createDelegationReservationStore({ stateRoot, readOwnOwnership }) : undefined),
    roles: dependencies.roles,
    createDelegationServices: dependencies.createDelegationServices,
    telemetry: dependencies.telemetry,
    createTelemetryStore: dependencies.createTelemetryStore,
  };
}

function processError(message, details) {
  return new WorkflowError("PROCESS", message, { exitCode: 12, details });
}

async function inspectDelegationPid(pid, { runner, cwdFallback, readCwd = fsRealpath } = {}) {
  try {
    return await inspectExactProcessByPid(pid, {
      async runProcess(resolvedPid) {
        return await runner.run("ps", psStatusArgv(resolvedPid), { allowFailure: true });
      },
      readCwd,
      cwdFallback,
    });
  } catch (error) {
    throw processError("Failed to inspect delegated Pi process", {
      pid: String(pid),
      reason: error?.message ?? "inspect",
    });
  }
}

function createDefaultDelegationInspector(liveDependencies, dependencies = {}) {
  return async (identity) => await inspectDelegationPid(identity.pid, {
    runner: liveDependencies.runner,
    cwdFallback: identity.cwd,
    readCwd: dependencies.readDelegationCwd ?? fsRealpath,
  });
}

function createDefaultDelegationSpawner(liveDependencies, dependencies = {}) {
  return async ({ command, argv, cwd, env: launchEnv }) => await new Promise((resolveSpawn, rejectSpawn) => {
    let child;
    let spawned = false;
    let settled = false;
    const resolveAfterSpawnFailure = () => {
      if (settled) return;
      settled = true;
      resolveSpawn({ outcome: "spawned-but-unverified" });
    };
    const rejectBeforeSpawnFailure = (error) => {
      if (settled) return;
      settled = true;
      rejectSpawn(processError(`Failed to start ${command}: ${error.message}`, {
        reason: "spawn",
        command,
        argv,
        cwd,
      }));
    };
    try {
      child = spawnChildProcess(command, argv, {
        cwd,
        env: launchEnv,
        shell: false,
        detached: true,
        stdio: "ignore",
      });
    } catch (error) {
      rejectBeforeSpawnFailure(error);
      return;
    }

    child.once("error", (error) => {
      if (spawned) {
        resolveAfterSpawnFailure();
        return;
      }
      rejectBeforeSpawnFailure(error);
    });

    child.once("spawn", async () => {
      spawned = true;
      child.unref?.();
      try {
        const pid = child.pid;
        if (!Number.isInteger(pid) || pid < 1) {
          resolveAfterSpawnFailure();
          return;
        }
        const inspection = await inspectDelegationPid(pid, {
          runner: liveDependencies.runner,
          cwdFallback: cwd,
          readCwd: dependencies.readDelegationCwd ?? fsRealpath,
        });
        if (!inspection) {
          resolveAfterSpawnFailure();
          return;
        }
        if (settled) return;
        settled = true;
        resolveSpawn({
          pid: String(pid),
          startedAt: inspection.startedAt,
        });
      } catch {
        resolveAfterSpawnFailure();
      }
    });
  });
}

async function stateRootForTransport(options, liveDependencies) {
  if (liveDependencies.stateRoot) return liveDependencies.stateRoot;
  const registry = await liveDependencies.loadRegistry(options.registryPath);
  return registry.launcher.state_root;
}

async function withLiveDelegationTransport(options, liveDependencies, dependencies) {
  if (liveDependencies.transport) return liveDependencies;
  const createPiDelegationTransport = dependencies.createPiDelegationTransport ?? defaultCreatePiDelegationTransport;
  const piCommand = await liveDependencies.lookupExecutable("pi");
  if (!piCommand || !isAbsolute(piCommand)) {
    throw new WorkflowError("PREFLIGHT", "Pi executable must resolve to an absolute path for delegation", { exitCode: 10 });
  }
  const stateRoot = await stateRootForTransport(options, liveDependencies);
  const inspectProcess = dependencies.inspectDelegationProcess ?? createDefaultDelegationInspector(liveDependencies, dependencies);
  const spawnChild = dependencies.spawnDelegationChild ?? createDefaultDelegationSpawner(liveDependencies, dependencies);
  return {
    ...liveDependencies,
    stateRoot,
    transport: createPiDelegationTransport({
      piCommand,
      spawnChild,
      inspectProcess,
      stateRoot,
      controlPlaneBin: fileURLToPath(import.meta.url),
    }),
  };
}

function mutationCommand(command) {
  return command === "start" || command === "runtime";
}

function requiredPreconditions(command, preconditions = {}) {
  if (command === "runtime") return ["git", "herdr", "herdrStatus"];
  if (command !== "start") return [];
  const generic = Object.hasOwn(preconditions, "agent") || Object.hasOwn(preconditions, "agentIntegration");
  return generic
    ? ["git", "herdr", "agent", "herdrStatus", "agentIntegration"]
    : ["git", "herdr", "pi", "herdrStatus", "piIntegration"];
}

function assertPreconditions(command, preview) {
  for (const name of requiredPreconditions(command, preview?.preconditions ?? {})) {
    const check = preview?.preconditions?.[name];
    if (!check || typeof check !== "object" || typeof check.status !== "string") {
      throw new WorkflowError("PREFLIGHT", `Missing or malformed required precondition: ${name}`, { exitCode: 10 });
    }
    if (check.status !== "ready") {
      throw new WorkflowError("PREFLIGHT", check.reason ?? `${command} requires ready ${check.id ?? name}`, { exitCode: 10 });
    }
  }

  if ((preview?.conflicts?.length ?? 0) > 0 || preview?.reconciliation?.status === "conflict") {
    const first = preview.conflicts?.[0];
    throw new WorkflowError("CONFLICT", first ? `${first.resource}: ${first.reason}` : "Workflow plan has conflicts", { exitCode: 11 });
  }
}

async function defaultConfirm({ prompt = "Proceed? [y/N] " } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(prompt);
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

function categorizeError(error) {
  if (error instanceof WorkflowError) {
    if (error.category === "USAGE") return { category: "USAGE", exitCode: 64 };
    if (error.category === "CONFLICT") return { category: "CONFLICT", exitCode: 11 };
    if (["PREFLIGHT", "delegation", "delegation-reservation", "delegation-service", "resume", "close"].includes(error.category)) {
      return { category: "PREFLIGHT", exitCode: 10 };
    }
    if (error.category === "HANDOFF") return { category: "HANDOFF", exitCode: 10 };
    if (error.category === "PROCESS" || error.category === "HERDR") return { category: "PROCESS", exitCode: 12 };
    return { category: "CONFIG", exitCode: 3 };
  }
  return { category: "INTERNAL", exitCode: 1 };
}

function pickDelegationIdentityEnv(env = {}) {
  const picked = {};
  for (const key of ["WORKFLOW_RUN_ID", "WORKFLOW_DELEGATION_ID", "WORKFLOW_DELEGATION_GENERATION"]) {
    if (env[key] !== undefined) picked[key] = env[key];
  }
  return picked;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;
  const env = dependencies.env ?? process.env;
  const formatWorkflowResult = dependencies.formatWorkflowResult ?? defaultFormatWorkflowResult;
  const doctorCommand = dependencies.doctorCommand ?? defaultDoctorCommand;
  const planCommand = dependencies.planCommand ?? defaultPlanCommand;
  const statusCommand = dependencies.statusCommand ?? defaultStatusCommand;
  const workerStatusCommand = dependencies.workerStatusCommand ?? defaultWorkerStatusCommand;
  const workerWatchCommand = dependencies.workerWatchCommand ?? defaultWorkerWatchCommand;
  const launchCommand = dependencies.launchCommand ?? defaultLaunchCommand;
  const resultCommand = dependencies.resultCommand ?? defaultResultCommand;
  const verifyCommand = dependencies.verifyCommand ?? defaultVerifyCommand;
  const reconcileCommand = dependencies.reconcileCommand ?? defaultReconcileCommand;
  const runsCommand = dependencies.runsCommand ?? defaultRunsCommand;
  const inboxCommand = dependencies.inboxCommand ?? defaultInboxCommand;
  const resumeCommand = dependencies.resumeCommand ?? defaultResumeCommand;
  const closeCommand = dependencies.closeCommand ?? defaultCloseCommand;
  const unlockCommand = dependencies.unlockCommand ?? defaultUnlockCommand;
  const delegationResultCommand = dependencies.delegationResultCommand ?? defaultDelegationResultCommand;
  const delegationReconcileCommand = dependencies.delegationReconcileCommand ?? defaultDelegationReconcileCommand;
  const delegationRemediateCommand = dependencies.delegationRemediateCommand ?? defaultDelegationRemediateCommand;
  const delegationGateClearCommand = dependencies.delegationGateClearCommand ?? defaultDelegationGateClearCommand;
  const handoffCommand = dependencies.handoffCommand ?? defaultHandoffCommand;
  const delegationHandoffCommand = dependencies.delegationHandoffCommand ?? defaultDelegationHandoffCommand;
  const executeStart = dependencies.executeStart ?? defaultExecuteStart;
  const executeRuntime = dependencies.executeRuntime ?? defaultExecuteRuntime;
  const confirm = dependencies.confirm ?? defaultConfirm;
  const isInteractive = dependencies.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stderr.isTTY));
  const liveDependencies = createLiveDependencies(dependencies);

  let phase = "parse";
  try {
    const args = parseArgs(argv);
    const registryPath = resolveWorkflowProjectsFile({ env, defaultPath: defaultRegistryPath });
    const options = { ...args, registryPath };
    phase = "runtime";

    if (args.command === "help") {
      emit(out, HELP);
      return 0;
    }

    if (args.command === "doctor") {
      const result = await doctorCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("doctor", result, args.format));
      return result.ok ? 0 : 10;
    }

    if (args.command === "plan") {
      const result = await planCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("plan", result, args.format));
      return result.reconciliation?.status === "conflict" ? 11 : 0;
    }

    if (args.command === "status") {
      const result = await statusCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("status", result, args.format));
      return result.reconciliation?.status === "conflict" ? 11 : 0;
    }

    if (args.command === "launch") {
      if (args.yes && !args.approvalDigest) {
        emit(err, "USAGE: launch --yes requires --approval-digest from the current dry-run preview.");
        return 64;
      }
      if (!args.dryRun && !args.yes && !isInteractive()) {
        emit(err, "USAGE: launch requires interactive confirmation or --yes with --approval-digest.");
        return 64;
      }

      const request = await readPromptFile(args.promptFile);
      const command = await launchCommand({
        ...options,
        request,
        controlPlaneBin: fileURLToPath(import.meta.url),
      }, liveDependencies);

      if (args.dryRun) {
        emit(out, formatWorkflowResult("launch", command.preview, args.format), { limit: LAUNCH_OUTPUT_LIMIT });
        return 0;
      }

      let approvalDigest = args.approvalDigest;
      if (!args.yes) {
        const previewText = formatWorkflowResult("launch", command.preview, "compact");
        emit(err, previewText, { limit: LAUNCH_OUTPUT_LIMIT });
        const approved = await confirm({
          command: "launch",
          preview: command.preview,
          previewText,
          prompt: "Proceed with workflow launch? [y/N] ",
        });
        if (!approved) {
          emit(err, "USAGE: Confirmation declined; no changes were made.");
          return 64;
        }
        approvalDigest = command.preview.approvalDigest;
      }

      // The execute report gets the same budget as the previews: launch JSON is
      // sized up to ~77KiB by format.js, and emitting it with the default limit
      // would truncate it mid-JSON for machine callers.
      const report = await command.execute({ approvalDigest });
      emit(out, formatWorkflowResult("launch", report, args.format), { limit: LAUNCH_OUTPUT_LIMIT });
      if (report.status === "partial") return 13;
      if (report.status === "failed") return 12;
      return 0;
    }

    if (args.command === "worker-status") {
      const result = await workerStatusCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("worker-status", result, args.format));
      return 0;
    }

    if (args.command === "worker-watch") {
      const controller = new AbortController();
      const signal = dependencies.workerWatchSignal ?? controller.signal;
      const onInterrupt = () => controller.abort();
      if (!dependencies.workerWatchSignal) process.once("SIGINT", onInterrupt);
      try {
        const watch = await workerWatchCommand(options, { ...liveDependencies, workerWatchSignal: signal });
        for await (const workers of watch) {
          emit(out, formatWorkflowResult("worker-watch", { command: "worker-watch", runId: args.runId, workers }, args.format));
        }
      } finally {
        if (!dependencies.workerWatchSignal) process.removeListener("SIGINT", onInterrupt);
      }
      return 0;
    }

    if (args.command === "result") {
      const result = await resultCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("result", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "verify") {
      const result = await verifyCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("verify", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "reconcile") {
      // reconcileCommand's read-only lock diagnostic expects deps.inspectProcess by that literal
      // name, same aliasing unlock's and gate-clear's dispatch do below for the same reason (see
      // the naming note where inspectProcessByPid is constructed): it stays off liveDependencies
      // itself so it never collides with the delegation transport's differently-shaped,
      // identity-based inspectProcess.
      const result = await reconcileCommand(
        options,
        { ...liveDependencies, inspectProcess: liveDependencies.inspectProcessByPid },
      );
      emit(out, formatWorkflowResult("reconcile", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "runs") {
      const result = await runsCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("runs", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "inbox") {
      const result = await inboxCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("inbox", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "resume") {
      const commandDependencies = await withLiveDelegationTransport(options, liveDependencies, dependencies);
      const result = await resumeCommand({ ...options, confirmed: Boolean(options.yes) }, commandDependencies);
      emit(out, formatWorkflowResult("resume", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "close") {
      const commandDependencies = await withLiveDelegationTransport(options, liveDependencies, dependencies);
      const result = await closeCommand(options, commandDependencies);
      emit(out, formatWorkflowResult("close", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "unlock") {
      // No delegation transport is needed: unlock only inspects/removes a run lock, via
      // liveDependencies' store and inspectProcessByPid (the same generic ps-based inspector the
      // store's own readOwnOwnership uses, wired once per process above). unlockCommand's
      // documented interface expects deps.inspectProcess by that literal name; the alias is
      // built fresh here, scoped to this one call, rather than exposing `inspectProcess` on
      // liveDependencies itself (see the naming note where inspectProcessByPid is constructed).
      const result = await unlockCommand(
        { ...options, confirmed: Boolean(options.yes) },
        { ...liveDependencies, inspectProcess: liveDependencies.inspectProcessByPid },
      );
      emit(out, formatWorkflowResult("unlock", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "delegation-result") {
      const result = await delegationResultCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("delegation-result", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "delegation-reconcile") {
      const commandDependencies = await withLiveDelegationTransport(options, liveDependencies, dependencies);
      const result = await delegationReconcileCommand(options, commandDependencies);
      emit(out, formatWorkflowResult("delegation-reconcile", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "delegation-release") {
      const delegationReleaseCommand = dependencies.delegationReleaseCommand ?? defaultDelegationReleaseCommand;
      const result = await delegationReleaseCommand({ ...options, confirmed: Boolean(options.yes) }, liveDependencies);
      emit(out, formatWorkflowResult("delegation-release", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "delegation-gate-clear") {
      // No delegation transport is needed: gate-clear only inspects/removes a project
      // reservation gate, via liveDependencies' reservations and inspectProcessByPid -- the same
      // wiring unlock uses for the run lock (see the naming note above on why inspectProcess is
      // aliased fresh here rather than exposed on liveDependencies itself).
      const result = await delegationGateClearCommand(
        { ...options, confirmed: Boolean(options.yes) },
        { ...liveDependencies, inspectProcess: liveDependencies.inspectProcessByPid },
      );
      emit(out, formatWorkflowResult("delegation-gate-clear", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "delegation-remediate") {
      if (!args.dryRun && (!args.yes || !args.approvalDigest)) {
        emit(err, "USAGE: delegation remediate requires --yes with --approval-digest from the current dry-run preview.");
        return 64;
      }

      const prompt = await readPromptFile(args.promptFile);
      const commandDependencies = args.dryRun
        ? liveDependencies
        : await withLiveDelegationTransport(options, liveDependencies, dependencies);
      const command = await delegationRemediateCommand({
        ...options,
        prompt,
      }, commandDependencies);

      if (args.dryRun) {
        emit(out, formatWorkflowResult("delegation-remediate", command.preview, args.format));
        return 0;
      }

      const report = await command.execute({ approvalDigest: args.approvalDigest });
      emit(out, formatWorkflowResult("delegation-remediate", report, args.format));
      return Number.isInteger(report.exitCode) ? report.exitCode : 0;
    }

    if (args.command === "handoff") {
      const result = await handoffCommand({ ...options, env }, liveDependencies);
      emit(out, formatWorkflowResult("handoff", result, args.format));
      return 0;
    }

    if (args.command === "delegation-handoff") {
      const result = await delegationHandoffCommand({ ...options, env: pickDelegationIdentityEnv(env) }, liveDependencies);
      emit(out, formatWorkflowResult("delegation-handoff", result, args.format));
      return 0;
    }

    if (!args.yes && !isInteractive()) {
      emit(err, `USAGE: ${args.command} requires interactive confirmation or --yes.`);
      return 64;
    }

    const preview = await planCommand({ ...options, command: "plan" }, liveDependencies);
    assertPreconditions(args.command, preview);

    if (!args.yes) {
      const previewText = formatWorkflowResult("plan", preview, "compact");
      emit(err, previewText);
      const approved = await confirm({
        command: args.command,
        preview,
        previewText,
        prompt: `Proceed with workflow ${args.command}? [y/N] `,
      });
      if (!approved) {
        emit(err, "USAGE: Confirmation declined; no changes were made.");
        return 64;
      }
    }

    const execution = args.command === "runtime"
      ? await executeRuntime(preview.reconciliation, liveDependencies)
      : await executeStart(preview.reconciliation, liveDependencies);

    emit(out, formatWorkflowResult(args.command, execution, args.format));
    if (execution.status === "partial") return 13;
    if (execution.status === "failed") return 12;
    return 0;
  } catch (error) {
    let message = String(error?.message || error);
    if (phase === "parse") {
      emit(err, `USAGE: ${message}`);
      return 64;
    }

    if (error instanceof WorkflowError && error.category === "telemetry") {
      emit(err, "PREFLIGHT: Worker telemetry is malformed or unavailable; manual recovery required");
      return 10;
    }
    const { category, exitCode } = categorizeError(error);
    emit(err, `${category}: ${message}`);
    return exitCode;
  }
}

let invokedPath;
try {
  invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined;
} catch {
  invokedPath = undefined;
}
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
