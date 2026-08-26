#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile as defaultReadFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadToken as defaultLoadToken } from "../src/asana/auth.js";
import { createAsanaClient as defaultCreateClient } from "../src/asana/client.js";
import { loadProjectConfig as defaultLoadConfig, resolveProjectBinding } from "../src/asana/config.js";
import {
  CommandError,
  commentTaskCommand,
  createProjectCommand,
  createTaskCommand,
  downloadAttachmentFile,
  getFullTaskContext,
  moveTaskCommand,
  registerProjectAlias as defaultRegisterProjectAlias,
  resolveProject,
  triageProject,
  updateTaskCommand,
} from "../src/asana/commands.js";
import { formatResult } from "../src/asana/format.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = resolve(packageRoot, "config/asana-projects.json");

const HELP = `asana-workflow — compact Asana reads and confirm-gated writes

Commands:
  auth status
  me [--format compact|json]
  workspaces [--format compact|json]
  projects [--workspace <gid>] [--format compact|json]
  sections --project <alias-or-gid> [--format compact|json]
  triage --project <alias-or-gid> [--sections <csv>] [--assignee me|any|<gid>] [--format compact|json]
  task <gid> [--full] [--format compact|json]
  task create --project <alias-or-gid> --name <text> [--notes <text>|--notes-file <path>] [--section <name>] [--assignee me|<gid>] [--due YYYY-MM-DD] [--confirm]
  task update <gid> [--name <text>] [--notes <text>|--notes-file <path>] [--assignee me|none|<gid>] [--due YYYY-MM-DD|none] [--completed true|false] [--confirm]
  task comment <gid> --text <text> [--confirm]
  task move <gid> --project <alias-or-gid> --section <name> [--confirm]
  project create --workspace <gid> --name <text> --sections <csv> [--register-alias <alias>] [--confirm]
  attachments <task-gid> [--format compact|json]
  attachment download <attachment-gid> --output <path> [--format compact|json]

Write commands are dry-run unless --confirm is supplied.

Environment:
  ASANA_ACCESS_TOKEN   Temporary token (never pass tokens as CLI arguments)
  ASANA_TOKEN_FILE     Alternate token file
  ASANA_PROJECTS_FILE  Alternate project-alias JSON file`;

const KNOWN_OPTIONS = new Set([
  "full", "help", "confirm", "format", "workspace", "project", "sections", "assignee", "output",
  "name", "notes", "notes-file", "section", "due", "completed", "text", "register-alias",
]);

function consumeOptions(tokens) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const name = token.slice(2);
    if (!KNOWN_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: --${name}`);
    if (["full", "help", "confirm"].includes(name)) { options[name] = true; continue; }
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

function requireDate(value, { allowNone = false } = {}) {
  if (allowNone && value === "none") return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("--due must be YYYY-MM-DD" + (allowNone ? " or none." : "."));
}

function requireNotesChoice(options) {
  if (options.notes !== undefined && options["notes-file"] !== undefined) throw new Error("--notes and --notes-file are mutually exclusive.");
}

function requireAssignee(value, { allowNone = false } = {}) {
  const allowed = ["me", ...(allowNone ? ["none"] : [])];
  if (value !== undefined && !allowed.includes(value) && !/^\d+$/.test(value)) {
    throw new Error(`--assignee must be ${allowNone ? "me, none," : "me"} or an Asana GID.`);
  }
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
  if (first === "task" && positionals[0] === "create") {
    validateShape("task create", positionals, options, {
      positionalCount: 1, allowedOptions: ["project", "name", "notes", "notes-file", "section", "assignee", "due", "confirm"],
    });
    if (!options.project) throw new Error("task create requires --project.");
    if (!options.name?.trim()) throw new Error("task create requires --name.");
    requireProjectRef(options.project);
    requireNotesChoice(options);
    requireAssignee(options.assignee);
    if (options.due !== undefined) requireDate(options.due);
    return {
      command: "task-create", project: options.project, name: options.name, notes: options.notes,
      notesFile: options["notes-file"], section: options.section, assignee: options.assignee,
      dueOn: options.due, confirm: options.confirm === true, format,
    };
  }
  if (first === "task" && positionals[0] === "update") {
    validateShape("task update", positionals, options, {
      positionalCount: 2, allowedOptions: ["name", "notes", "notes-file", "assignee", "due", "completed", "confirm"],
    });
    if (!positionals[1]) throw new Error("task update requires a task GID.");
    requireGid(positionals[1], "task");
    requireNotesChoice(options);
    requireAssignee(options.assignee, { allowNone: true });
    if (options.due !== undefined) requireDate(options.due, { allowNone: true });
    if (options.completed !== undefined && !["true", "false"].includes(options.completed)) throw new Error("--completed must be true or false.");
    if (!["name", "notes", "notes-file", "assignee", "due", "completed"].some((name) => options[name] !== undefined)) {
      throw new Error("task update requires at least one field to update.");
    }
    return {
      command: "task-update", gid: positionals[1], name: options.name, notes: options.notes,
      notesFile: options["notes-file"], assignee: options.assignee, dueOn: options.due,
      completed: options.completed === undefined ? undefined : options.completed === "true",
      confirm: options.confirm === true, format,
    };
  }
  if (first === "task" && positionals[0] === "comment") {
    validateShape("task comment", positionals, options, { positionalCount: 2, allowedOptions: ["text", "confirm"] });
    if (!positionals[1]) throw new Error("task comment requires a task GID.");
    requireGid(positionals[1], "task");
    if (!options.text?.trim()) throw new Error("task comment requires --text.");
    return { command: "task-comment", gid: positionals[1], text: options.text, confirm: options.confirm === true, format };
  }
  if (first === "task" && positionals[0] === "move") {
    validateShape("task move", positionals, options, { positionalCount: 2, allowedOptions: ["project", "section", "confirm"] });
    if (!positionals[1]) throw new Error("task move requires a task GID.");
    requireGid(positionals[1], "task");
    if (!options.project) throw new Error("task move requires --project.");
    if (!options.section?.trim()) throw new Error("task move requires --section.");
    requireProjectRef(options.project);
    return { command: "task-move", gid: positionals[1], project: options.project, section: options.section, confirm: options.confirm === true, format };
  }
  if (first === "project" && positionals[0] === "create") {
    validateShape("project create", positionals, options, {
      positionalCount: 1, allowedOptions: ["workspace", "name", "sections", "register-alias", "confirm"],
    });
    if (!options.workspace) throw new Error("project create requires --workspace.");
    requireGid(options.workspace, "workspace");
    if (!options.name?.trim()) throw new Error("project create requires --name.");
    const sections = options.sections?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    if (!sections.length) throw new Error("project create requires at least one section in --sections.");
    if (options["register-alias"] !== undefined) {
      try { requireProjectRef(options["register-alias"]); }
      catch { throw new Error("--register-alias must be a valid alias."); }
    }
    return {
      command: "project-create", workspace: options.workspace, name: options.name, sections,
      registerAlias: options["register-alias"], confirm: options.confirm === true, format,
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
  const readFile = dependencies.readFile ?? defaultReadFile;
  const registerProjectAlias = dependencies.registerProjectAlias ?? defaultRegisterProjectAlias;
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
    const configPath = process.env.ASANA_PROJECTS_FILE || defaultConfigPath;
    const configuredProject = async (reference) => {
      const config = await loadConfig(configPath);
      const binding = resolveProjectBinding(config, reference);
      return { config, binding, project: await resolveProject(client, binding) };
    };
    const commandNotes = async () => {
      if (!args.notesFile) return args.notes;
      try { return await readFile(args.notesFile, "utf8"); }
      catch (error) { throw new CommandError(`Unable to read notes file ${args.notesFile}: ${error.message}`); }
    };
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
      const { binding, project } = await configuredProject(args.project);
      if (args.command === "sections") result = await client.sections(project.gid);
      else result = await triageProject(client, project, {
        sectionNames: args.sections.length ? args.sections : binding.activeSections,
        assignee: args.assignee,
      });
    } else if (args.command === "task-create") {
      const { project } = await configuredProject(args.project);
      result = await createTaskCommand(client, {
        project, name: args.name, notes: await commandNotes(), section: args.section,
        assignee: args.assignee, dueOn: args.dueOn,
      }, { confirm: args.confirm });
      formatCommand = "mutation";
    } else if (args.command === "task-update") {
      result = await updateTaskCommand(client, args.gid, {
        name: args.name, notes: await commandNotes(), assignee: args.assignee,
        dueOn: args.dueOn, completed: args.completed,
      }, { confirm: args.confirm });
      formatCommand = "mutation";
    } else if (args.command === "task-comment") {
      result = await commentTaskCommand(client, args.gid, args.text, { confirm: args.confirm });
      formatCommand = "mutation";
    } else if (args.command === "task-move") {
      const { project } = await configuredProject(args.project);
      result = await moveTaskCommand(client, args.gid, { project, section: args.section }, { confirm: args.confirm });
      formatCommand = "mutation";
    } else if (args.command === "project-create") {
      if (args.registerAlias) {
        const config = await loadConfig(configPath);
        if (Object.hasOwn(config.projects, args.registerAlias)) throw new CommandError(`Asana project alias '${args.registerAlias}' already exists.`);
      }
      result = await createProjectCommand(client, {
        workspaceGid: args.workspace, name: args.name, sections: args.sections,
      }, { confirm: args.confirm });
      if (args.registerAlias && !args.confirm) {
        result = { ...result, details: { ...result.details, register_alias: args.registerAlias } };
      } else if (args.registerAlias) {
        await registerProjectAlias(configPath, args.registerAlias, result.project.gid);
        result = { ...result, alias: args.registerAlias };
      }
      formatCommand = "mutation";
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

let invokedPath;
try { invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined; }
catch { invokedPath = undefined; }
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
