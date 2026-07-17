#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { loadToken as defaultLoadToken } from "../src/asana/auth.js";
import { createAsanaClient as defaultCreateClient } from "../src/asana/client.js";
import { loadProjectConfig as defaultLoadConfig, resolveProjectBinding } from "../src/asana/config.js";
import { downloadAttachmentFile, getFullTaskContext, resolveProject, triageProject } from "../src/asana/commands.js";
import { formatResult } from "../src/asana/format.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = resolve(packageRoot, "config/asana-projects.json");

const HELP = `asana-workflow — compact read-only Asana access

Commands:
  auth status
  me [--format compact|json]
  workspaces [--format compact|json]
  projects [--workspace <gid>] [--format compact|json]
  sections --project <alias-or-gid> [--format compact|json]
  triage --project <alias-or-gid> [--sections <csv>] [--assignee me|any|<gid>] [--format compact|json]
  task <gid> [--full] [--format compact|json]
  attachments <task-gid> [--format compact|json]
  attachment download <attachment-gid> --output <path> [--format compact|json]

Environment:
  ASANA_ACCESS_TOKEN   Temporary token (never pass tokens as CLI arguments)
  ASANA_TOKEN_FILE     Alternate token file
  ASANA_PROJECTS_FILE  Alternate project-alias JSON file`;

const KNOWN_OPTIONS = new Set(["full", "help", "format", "workspace", "project", "sections", "assignee", "output"]);

function consumeOptions(tokens) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const name = token.slice(2);
    if (!KNOWN_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: --${name}`);
    if (name === "full" || name === "help") { options[name] = true; continue; }
    const next = tokens[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} requires a value.`);
    options[name] = next;
  }
  return { options, positionals };
}

function validateShape(command, positionals, options, { positionalCount, allowedOptions = [] }) {
  if (positionals.length > positionalCount) throw new Error(`${command} received an unexpected argument: ${positionals[positionalCount]}`);
  for (const name of Object.keys(options)) {
    if (name !== "format" && !allowedOptions.includes(name)) throw new Error(`${command} does not accept --${name}.`);
  }
}

function requireGid(value, label) {
  if (!/^\d+$/.test(value || "")) throw new Error(`${label} must be a valid Asana GID.`);
}

function requireProjectRef(value) {
  if (!/^[\p{L}\p{N}._-]+$/u.test(value || "")) throw new Error("--project must be a valid alias or Asana GID.");
}

export function parseArgs(argv) {
  if (!argv.length || (argv.length === 1 && ["--help", "help"].includes(argv[0]))) return { command: "help", format: "compact" };
  const [first, ...rest] = argv;
  const { options, positionals } = consumeOptions(rest);
  const format = options.format ?? "compact";
  if (!["compact", "json"].includes(format)) throw new Error("--format must be compact or json.");

  if (first === "auth" && positionals[0] === "status") {
    validateShape("auth status", positionals, options, { positionalCount: 1 });
    return { command: "auth-status", format };
  }
  if (["me", "workspaces", "projects"].includes(first)) {
    validateShape(first, positionals, options, { positionalCount: 0, allowedOptions: first === "projects" ? ["workspace"] : [] });
    return { command: first, workspace: options.workspace, format };
  }
  if (first === "sections") {
    validateShape("sections", positionals, options, { positionalCount: 0, allowedOptions: ["project"] });
    if (!options.project) throw new Error("sections requires --project.");
    requireProjectRef(options.project);
    return { command: "sections", project: options.project, format };
  }
  if (first === "triage") {
    validateShape("triage", positionals, options, { positionalCount: 0, allowedOptions: ["project", "sections", "assignee"] });
    if (!options.project) throw new Error("triage requires --project.");
    requireProjectRef(options.project);
    const assignee = options.assignee ?? "me";
    if (!["me", "any"].includes(assignee) && !/^\d+$/.test(assignee)) throw new Error("assignee must be me, any, or an Asana GID.");
    return {
      command: "triage", project: options.project,
      sections: options.sections ? options.sections.split(",").map((item) => item.trim()).filter(Boolean) : [],
      assignee, format,
    };
  }
  if (first === "task") {
    validateShape("task", positionals, options, { positionalCount: 1, allowedOptions: ["full"] });
    if (!positionals[0]) throw new Error("task requires a task GID.");
    requireGid(positionals[0], "task");
    return { command: "task", gid: positionals[0], full: options.full === true, format };
  }
  if (first === "attachments") {
    validateShape("attachments", positionals, options, { positionalCount: 1 });
    if (!positionals[0]) throw new Error("attachments requires a task GID.");
    requireGid(positionals[0], "task");
    return { command: "attachments", gid: positionals[0], format };
  }
  if (first === "attachment" && positionals[0] === "download") {
    validateShape("attachment download", positionals, options, { positionalCount: 2, allowedOptions: ["output"] });
    if (!positionals[1]) throw new Error("attachment download requires an attachment GID.");
    requireGid(positionals[1], "attachment");
    if (!options.output) throw new Error("attachment download requires --output.");
    return { command: "attachment-download", gid: positionals[1], output: options.output, format };
  }
  throw new Error(`Unknown command: ${argv.join(" ")}\n\n${HELP}`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;
  const loadToken = dependencies.loadToken ?? defaultLoadToken;
  const createClient = dependencies.createClient ?? defaultCreateClient;
  const loadConfig = dependencies.loadConfig ?? defaultLoadConfig;
  let sensitiveToken;
  let phase = "parse";
  try {
    const args = parseArgs(argv);
    phase = "runtime";
    if (args.command === "help") { out(HELP); return 0; }
    if (args.command === "auth-status") {
      try {
        const auth = await loadToken();
        out(formatResult("auth-status", { configured: true, source: auth.source }));
        if (auth.warning) err(`Warning: ${auth.warning}`);
      } catch {
        out(formatResult("auth-status", { configured: false, message: "not configured" }));
      }
      return 0;
    }

    const auth = await loadToken();
    sensitiveToken = auth.token;
    if (auth.warning) err(`Warning: ${auth.warning}`);
    const client = createClient({ token: auth.token });
    let result;
    let formatCommand = args.command;

    if (args.command === "me") result = await client.me();
    else if (args.command === "workspaces") result = await client.workspaces();
    else if (args.command === "projects") {
      if (args.workspace) result = await client.projects(args.workspace);
      else {
        const user = await client.me();
        const groups = await Promise.all((user.workspaces ?? []).map((workspace) => client.projects(workspace.gid)));
        result = groups.flat();
      }
    } else if (["sections", "triage"].includes(args.command)) {
      const configPath = process.env.ASANA_PROJECTS_FILE || defaultConfigPath;
      const config = await loadConfig(configPath);
      const binding = resolveProjectBinding(config, args.project);
      const project = await resolveProject(client, binding);
      if (args.command === "sections") result = await client.sections(project.gid);
      else result = await triageProject(client, project, {
        sectionNames: args.sections.length ? args.sections : binding.activeSections,
        assignee: args.assignee,
      });
    } else if (args.command === "task") {
      result = args.full ? await getFullTaskContext(client, args.gid) : await client.task(args.gid);
      formatCommand = args.full ? "task-full" : "task";
    } else if (args.command === "attachments") result = await client.attachments(args.gid);
    else if (args.command === "attachment-download") result = await downloadAttachmentFile(client, args.gid, args.output);

    out(formatResult(formatCommand, result, args.format));
    return 0;
  } catch (error) {
    let message = String(error?.message || error);
    if (sensitiveToken) message = message.split(sensitiveToken).join("[REDACTED]");
    let category = "INTERNAL";
    let exitCode = 1;
    if (phase === "parse") { category = "USAGE"; exitCode = 64; }
    else if (error?.name === "AuthError") { category = "AUTH"; exitCode = 2; }
    else if (error?.name === "ConfigError") { category = "CONFIG"; exitCode = 3; }
    else if (error?.name === "AsanaApiError" && error.kind === "api" && [401, 403].includes(error.status)) { category = "AUTH"; exitCode = 2; }
    else if (error?.name === "AsanaApiError" && error.status === 429) { category = "RATE_LIMIT"; exitCode = 4; }
    else if (error?.name === "AsanaApiError" && error.status === 404) { category = "NOT_FOUND"; exitCode = 7; }
    else if (error?.name === "AsanaApiError" && /network failure/i.test(message)) { category = "NETWORK"; exitCode = 5; }
    else if (error?.name === "AsanaApiError" && error.kind === "attachment") { category = "ATTACHMENT"; exitCode = 9; }
    else if (error?.name === "AsanaApiError") { category = "API"; exitCode = 6; }
    else if (error?.name === "CommandError") { category = "COMMAND"; exitCode = 8; }
    err(`${category}: ${message.replace(/[\r\n]+/g, "\n").slice(0, 1200)}`);
    return exitCode;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
