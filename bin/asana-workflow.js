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

function consumeOptions(tokens) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const name = token.slice(2);
    if (name === "full" || name === "help") { options[name] = true; continue; }
    const next = tokens[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} requires a value.`);
    options[name] = next;
  }
  return { options, positionals };
}

export function parseArgs(argv) {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") return { command: "help", format: "compact" };
  const [first, ...rest] = argv;
  const { options, positionals } = consumeOptions(rest);
  const format = options.format ?? "compact";
  if (!["compact", "json"].includes(format)) throw new Error("--format must be compact or json.");

  if (first === "auth" && positionals[0] === "status") return { command: "auth-status", format };
  if (["me", "workspaces", "projects"].includes(first)) return { command: first, workspace: options.workspace, format };
  if (first === "sections") {
    if (!options.project) throw new Error("sections requires --project.");
    return { command: "sections", project: options.project, format };
  }
  if (first === "triage") {
    if (!options.project) throw new Error("triage requires --project.");
    return {
      command: "triage", project: options.project,
      sections: options.sections ? options.sections.split(",").map((item) => item.trim()).filter(Boolean) : [],
      assignee: options.assignee ?? "me", format,
    };
  }
  if (first === "task") {
    if (!positionals[0]) throw new Error("task requires a task GID.");
    return { command: "task", gid: positionals[0], full: options.full === true, format };
  }
  if (first === "attachments") {
    if (!positionals[0]) throw new Error("attachments requires a task GID.");
    return { command: "attachments", gid: positionals[0], format };
  }
  if (first === "attachment" && positionals[0] === "download") {
    if (!positionals[1]) throw new Error("attachment download requires an attachment GID.");
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
  try {
    const args = parseArgs(argv);
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
    err(`Error: ${String(error?.message || error).replace(/[\r\n]+/g, "\n").slice(0, 1200)}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
