import { readFile as defaultReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parse } from "yaml";
import { WorkflowError } from "./errors.js";

const ALLOWED_SPLITS = new Set(["left", "right", "up", "down"]);
const ALLOWED_TEMPLATE_PLACEHOLDERS = new Set(["worktree_root", "project", "task", "slug"]);
const ALLOWED_CHILD_TEMPLATE_PLACEHOLDERS = new Set(["project", "task", "slug", "repository"]);
const ALLOWED_REPOSITORIES = new Set(["monorepo", "single", "group"]);

function fail(category, message, options) {
  throw new WorkflowError(category, message, options);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}${value.slice(1)}`;
  if (value.startsWith("~\\")) return `${homedir()}${value.slice(1)}`;
  return value;
}

function validateString(value, context) {
  if (typeof value !== "string" || !value.trim()) fail("schema", `${context} must be a non-empty string`);
  return value;
}

function validateTemplate(template, allowedPlaceholders, context) {
  const value = validateString(template, context);
  const placeholders = [...value.matchAll(/\{([^{}]+)\}/g)];
  const stripped = value.replace(/\{[^{}]+\}/g, "");
  if (/[{}]/.test(stripped)) {
    fail("template", `${context} contains unresolved or malformed placeholder syntax`);
  }
  for (const match of placeholders) {
    const placeholder = match[1];
    if (!allowedPlaceholders.has(placeholder)) {
      fail("template", `${context} contains unknown placeholder ${placeholder}`);
    }
  }
  return value;
}

function validateRuntimeProcess(process, index, profileName) {
  if (!isObject(process)) fail("schema", `runtime profile ${profileName} process ${index + 1} must be an object`);
  const normalized = clone(process);
  normalized.id = validateString(normalized.id, `runtime profile ${profileName} process ${index + 1}.id`);
  normalized.command = validateString(normalized.command, `runtime profile ${profileName} process ${index + 1}.command`);
  normalized.cwd = normalized.cwd === undefined ? "." : validateString(normalized.cwd, `runtime profile ${profileName} process ${index + 1}.cwd`);
  normalized.split = normalized.split === undefined ? "right" : validateString(normalized.split, `runtime profile ${profileName} process ${index + 1}.split`);
  if (!ALLOWED_SPLITS.has(normalized.split)) {
    fail("schema", `runtime profile ${profileName} process ${index + 1}.split must be one of ${[...ALLOWED_SPLITS].join(", ")}`);
  }
  if (normalized.ratio !== undefined) {
    if (typeof normalized.ratio !== "number" || !Number.isFinite(normalized.ratio) || normalized.ratio <= 0 || normalized.ratio >= 1) {
      fail("schema", `runtime profile ${profileName} process ${index + 1}.ratio must be a number between 0 and 1`);
    }
  }
  return normalized;
}

function validateRuntime(runtime) {
  if (runtime === undefined) return undefined;
  if (!isObject(runtime)) fail("schema", "runtime must be an object");
  const normalized = clone(runtime);
  normalized.default_profile = validateString(normalized.default_profile, "runtime.default_profile");
  if (!isObject(normalized.profiles)) fail("schema", "runtime.profiles must be an object");

  const profiles = {};
  for (const [profileName, profileValue] of Object.entries(normalized.profiles)) {
    if (!isObject(profileValue)) fail("schema", `runtime profile ${profileName} must be an object`);
    const profile = clone(profileValue);
    if (!Array.isArray(profile.processes) || profile.processes.length === 0) {
      fail("schema", `runtime profile ${profileName} must define at least one process`);
    }
    const seenIds = new Set();
    const seenCommands = new Set();
    profile.processes = profile.processes.map((process, index) => {
      const normalizedProcess = validateRuntimeProcess(process, index, profileName);
      if (seenIds.has(normalizedProcess.id)) {
        fail("schema", `duplicate runtime process id ${normalizedProcess.id} in profile ${profileName}`);
      }
      if (seenCommands.has(normalizedProcess.command)) {
        fail("schema", `duplicate runtime process command ${normalizedProcess.command} in profile ${profileName}`);
      }
      seenIds.add(normalizedProcess.id);
      seenCommands.add(normalizedProcess.command);
      return normalizedProcess;
    });
    profiles[profileName] = profile;
  }

  if (!profiles[normalized.default_profile]) {
    fail("schema", `runtime.default_profile ${normalized.default_profile} does not match any profile`);
  }

  normalized.profiles = profiles;
  return normalized;
}

function validateWorktree(worktree, projectName) {
  if (!isObject(worktree)) fail("schema", `${projectName}.worktree must be an object`);
  const normalized = clone(worktree);
  normalized.branch_template = validateTemplate(normalized.branch_template, ALLOWED_TEMPLATE_PLACEHOLDERS, `${projectName}.worktree.branch_template`);
  normalized.path_template = validateTemplate(normalized.path_template, ALLOWED_TEMPLATE_PLACEHOLDERS, `${projectName}.worktree.path_template`);
  return normalized;
}

function validateOrdinaryProject(project, projectName) {
  const normalized = clone(project);
  normalized.path = expandHome(validateString(normalized.path, `${projectName}.path`));
  normalized.repository = validateString(normalized.repository, `${projectName}.repository`);
  if (!ALLOWED_REPOSITORIES.has(normalized.repository)) {
    fail("schema", `${projectName}.repository must be one of ${[...ALLOWED_REPOSITORIES].join(", ")}`);
  }
  if (normalized.repository === "group") {
    fail("schema", `${projectName} must not use repository=group without group coordination`);
  }
  normalized.base_branch = validateString(normalized.base_branch, `${projectName}.base_branch`);
  normalized.worktree = validateWorktree(normalized.worktree, projectName);
  normalized.runtime = validateRuntime(normalized.runtime);
  if (normalized.verify !== undefined && !Array.isArray(normalized.verify)) {
    fail("schema", `${projectName}.verify must be an array of commands`);
  }
  return normalized;
}

function validateGroupRepository(repository, repositoryName, projectName) {
  if (!isObject(repository)) fail("schema", `${projectName}.repositories.${repositoryName} must be an object`);
  const normalized = clone(repository);
  normalized.path = expandHome(validateString(normalized.path, `${projectName}.repositories.${repositoryName}.path`));
  normalized.base_branch = validateString(normalized.base_branch, `${projectName}.repositories.${repositoryName}.base_branch`);
  normalized.branch_template = validateTemplate(normalized.branch_template, ALLOWED_CHILD_TEMPLATE_PLACEHOLDERS, `${projectName}.repositories.${repositoryName}.branch_template`);
  return normalized;
}

function validateGroupProject(project, projectName) {
  const normalized = clone(project);
  normalized.path = expandHome(validateString(normalized.path, `${projectName}.path`));
  normalized.repository = validateString(normalized.repository, `${projectName}.repository`);
  if (normalized.repository !== "group") {
    fail("schema", `${projectName}.repository must be group`);
  }
  normalized.worktree = validateWorktree(normalized.worktree, projectName);
  normalized.coordination = isObject(normalized.coordination) ? {
    ...clone(normalized.coordination),
    meta_repository: expandHome(validateString(normalized.coordination.meta_repository, `${projectName}.coordination.meta_repository`)),
    repos_directory: validateString(normalized.coordination.repos_directory, `${projectName}.coordination.repos_directory`),
  } : fail("schema", `${projectName}.coordination must be an object`);
  if (!isObject(normalized.repositories) || !Object.keys(normalized.repositories).length) {
    fail("schema", `${projectName}.repositories must contain at least one repository`);
  }
  const repositories = {};
  for (const [repositoryName, repository] of Object.entries(normalized.repositories)) {
    repositories[repositoryName] = validateGroupRepository(repository, repositoryName, projectName);
  }
  normalized.repositories = repositories;
  normalized.runtime = validateRuntime(normalized.runtime);
  if (normalized.verify !== undefined && !Array.isArray(normalized.verify)) {
    fail("schema", `${projectName}.verify must be an array of commands`);
  }
  return normalized;
}

function validateLauncher(launcher) {
  if (!isObject(launcher)) fail("schema", "launcher must be an object");
  const normalized = clone(launcher);
  normalized.worktree_root = expandHome(validateString(normalized.worktree_root, "launcher.worktree_root"));
  if (!isObject(normalized.agent)) fail("schema", "launcher.agent must be an object");
  normalized.agent = {
    ...clone(normalized.agent),
    command: validateString(normalized.agent.command, "launcher.agent.command"),
    session_template: validateTemplate(normalized.agent.session_template, ALLOWED_TEMPLATE_PLACEHOLDERS, "launcher.agent.session_template"),
  };
  return normalized;
}

function validateProjects(projects) {
  if (!isObject(projects)) fail("schema", "projects must be an object");
  const normalized = {};
  for (const [projectName, project] of Object.entries(projects)) {
    if (!isObject(project)) fail("schema", `project ${projectName} must be an object`);
    if (!project.repository) fail("schema", `project ${projectName} must define repository`);
    normalized[projectName] = project.repository === "group"
      ? validateGroupProject(project, projectName)
      : validateOrdinaryProject(project, projectName);
  }
  return normalized;
}

export async function loadRegistry(path, { readFile = defaultReadFile } = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail("io", `Unable to load workflow registry at ${path}: ${error.message}`, { details: { path } });
  }

  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    fail("parse", `Unable to parse workflow registry at ${path}: ${error.message}`, { details: { path } });
  }

  return validateRegistry(parsed);
}

export function validateRegistry(value) {
  const registry = clone(value);
  if (!isObject(registry)) fail("schema", "Registry must be an object");
  if (registry.version !== 2) fail("schema", "Registry must use version 2");
  const launcher = validateLauncher(registry.launcher);
  const projects = validateProjects(registry.projects);
  return deepFreeze({ ...registry, version: 2, launcher, projects });
}

export function resolveProject(registry, alias) {
  const project = registry?.projects?.[alias];
  if (!project) fail("lookup", `Unknown workflow project: ${alias}`, { exitCode: 2, details: { alias } });
  return project;
}
