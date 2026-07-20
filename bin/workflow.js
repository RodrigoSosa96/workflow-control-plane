#!/usr/bin/env node
import { realpathSync, constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
import { createProcessRunner } from "../src/workflow/process.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { createHerdrAdapter } from "../src/workflow/herdr.js";
import { ASSIGNMENT_LIMITS } from "../src/workflow/assignment.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { doctorCommand as defaultDoctorCommand, handoffCommand as defaultHandoffCommand, launchCommand as defaultLaunchCommand, planCommand as defaultPlanCommand, reconcileCommand as defaultReconcileCommand, resultCommand as defaultResultCommand, statusCommand as defaultStatusCommand } from "../src/workflow/commands.js";
import { executeStart as defaultExecuteStart, executeRuntime as defaultExecuteRuntime } from "../src/workflow/execute.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { formatWorkflowResult as defaultFormatWorkflowResult } from "../src/workflow/format.js";
import { loadRegistry as defaultLoadRegistry } from "../src/workflow/registry.js";

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
  workflow reconcile [project] --run <run-id> [--format compact|json]
  workflow runtime <project> <task> [--feature <text>] [--repos <csv>] [--tickets <csv>] [--profile <name>] [--format compact|json] [--yes]
  workflow status <project> <task> [--feature <text>] [--repos <csv>] [--tickets <csv>] [--profile <name>] [--agent <profile>] [--format compact|json]
  workflow handoff <run-id> --input <run-dir>/handoff-input.json [--format compact|json]

Environment:
  WORKFLOW_PROJECTS_FILE   Alternate workflow registry path
  WORKFLOW_STATE_ROOT      Workflow run-state root for handoff`;
const KNOWN_OPTIONS = new Set(["feature", "repos", "tickets", "profile", "agent", "format", "yes", "help", "input", "prompt-file", "selection-reason", "origin-session", "dry-run", "approval-digest", "run"]);

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
    if (name === "yes" || name === "help" || name === "dry-run") {
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

function assertCanonicalHandoffInputSyntax(input) {
  const normalized = String(input ?? "").replace(/\\/gu, "/");
  if (!normalized.includes("/") || !normalized.endsWith("/handoff-input.json") || normalized.includes("/../") || normalized.startsWith("../")) {
    throw new Error("handoff --input must be the canonical <run-directory>/handoff-input.json path.");
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

  if (command === "result") {
    validateShape("result", positionals, options, { min: 1, max: 1, allowedOptions: [] });
    return {
      command,
      runId: positionals[0],
      format,
    };
  }

  if (command === "reconcile") {
    validateShape("reconcile", positionals, options, { min: 0, max: 1, allowedOptions: ["run"] });
    if (!options.run) throw new Error("reconcile requires --run <run-id>.");
    return {
      command,
      ...(positionals[0] ? { projectAlias: positionals[0] } : {}),
      runId: options.run,
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

async function lookupExecutable(name, env = process.env) {
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function createLiveDependencies(dependencies) {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? createProcessRunner();
  const stateRoot = dependencies.stateRoot ?? env.WORKFLOW_STATE_ROOT;
  return {
    stateRoot,
    loadRegistry: dependencies.loadRegistry ?? defaultLoadRegistry,
    lookupExecutable: dependencies.lookupExecutable ?? ((name) => lookupExecutable(name, env)),
    git: dependencies.git ?? createGitAdapter({ runner }),
    herdr: dependencies.herdr ?? createHerdrAdapter({ runner }),
    store: dependencies.store ?? (stateRoot ? createRunStore({ stateRoot }) : undefined),
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
    if (error.category === "PREFLIGHT") return { category: "PREFLIGHT", exitCode: 10 };
    if (error.category === "HANDOFF") return { category: "HANDOFF", exitCode: 10 };
    if (error.category === "PROCESS" || error.category === "HERDR") return { category: "PROCESS", exitCode: 12 };
    return { category: "CONFIG", exitCode: 3 };
  }
  return { category: "INTERNAL", exitCode: 1 };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;
  const env = dependencies.env ?? process.env;
  const formatWorkflowResult = dependencies.formatWorkflowResult ?? defaultFormatWorkflowResult;
  const doctorCommand = dependencies.doctorCommand ?? defaultDoctorCommand;
  const planCommand = dependencies.planCommand ?? defaultPlanCommand;
  const statusCommand = dependencies.statusCommand ?? defaultStatusCommand;
  const launchCommand = dependencies.launchCommand ?? defaultLaunchCommand;
  const resultCommand = dependencies.resultCommand ?? defaultResultCommand;
  const reconcileCommand = dependencies.reconcileCommand ?? defaultReconcileCommand;
  const handoffCommand = dependencies.handoffCommand ?? defaultHandoffCommand;
  const executeStart = dependencies.executeStart ?? defaultExecuteStart;
  const executeRuntime = dependencies.executeRuntime ?? defaultExecuteRuntime;
  const confirm = dependencies.confirm ?? defaultConfirm;
  const isInteractive = dependencies.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stderr.isTTY));
  const liveDependencies = createLiveDependencies(dependencies);

  let phase = "parse";
  try {
    const args = parseArgs(argv);
    const registryPath = env.WORKFLOW_PROJECTS_FILE || defaultRegistryPath;
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

      const report = await command.execute({ approvalDigest });
      emit(out, formatWorkflowResult("launch", report, args.format));
      if (report.status === "partial") return 13;
      if (report.status === "failed") return 12;
      return 0;
    }

    if (args.command === "result") {
      const result = await resultCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("result", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "reconcile") {
      const result = await reconcileCommand(options, liveDependencies);
      emit(out, formatWorkflowResult("reconcile", result, args.format));
      return Number.isInteger(result.exitCode) ? result.exitCode : 0;
    }

    if (args.command === "handoff") {
      const result = await handoffCommand({ ...options, env }, liveDependencies);
      emit(out, formatWorkflowResult("handoff", result, args.format));
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
