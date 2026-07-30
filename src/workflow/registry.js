import { readFile as defaultReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import { WorkflowError } from "./errors.js";
import { resolveProjectDelegationPolicy, validateDelegationPolicy } from "./delegation-policy.js";

const ALLOWED_SPLITS = new Set(["left", "right", "up", "down"]);
const ALLOWED_TEMPLATE_PLACEHOLDERS = new Set(["worktree_root", "project", "task", "slug"]);
const ALLOWED_CHILD_TEMPLATE_PLACEHOLDERS = new Set(["project", "task", "slug", "repository"]);
const ALLOWED_REPOSITORIES = new Set(["monorepo", "single", "group"]);
const HARNESSES = new Set(["pi", "claude", "codex", "opencode"]);
const MODES_BY_HARNESS = {
  pi: new Set(["interactive"]),
  claude: new Set(["interactive"]),
  codex: new Set(["interactive"]),
  opencode: new Set(["stream-json"]),
};
const CLAUDE_PERMISSION_MODES = new Set(["manual", "acceptEdits", "plan", "auto", "dontAsk"]);
const CODEX_SANDBOXES = new Set(["read-only", "workspace-write"]);
// "never" lets an autonomous worker execute without approval prompts; the sandbox
// (CODEX_SANDBOXES, still validated separately) remains the safety boundary, and the
// FORBIDDEN_ARGUMENTS guard still blocks sneaking approval flags in via `arguments`.
const CODEX_APPROVALS = new Set(["untrusted", "on-request", "never"]);
const COMMON_PROFILE_FIELDS = new Set(["harness", "command", "mode", "roles", "model", "arguments"]);
const PROFILE_FIELDS_BY_HARNESS = {
  pi: COMMON_PROFILE_FIELDS,
  claude: new Set([...COMMON_PROFILE_FIELDS, "permission_mode"]),
  codex: new Set([...COMMON_PROFILE_FIELDS, "sandbox", "approval_policy"]),
  opencode: new Set([...COMMON_PROFILE_FIELDS, "availability"]),
};
const FORBIDDEN_ARGUMENTS = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
];
// Flags the control plane itself generates (or that would replace its generated
// wiring: lifecycle hooks, permission allowlist, session identity). Harness argv
// is last-wins, so a profile argument would silently override the generated
// value the launch approval digest gated.
const CONTROL_PLANE_ARGUMENTS = {
  // Pi's session id and worker extensions are generated per run: overriding them
  // breaks the exact-session-identity contract resume/close/telemetry rely on.
  pi: ["--session-id", "--extension", "--add-dir", "--continue", "--resume"],
  claude: ["--settings", "--mcp-config", "--append-system-prompt", "--session-id", "--resume", "--add-dir"],
  codex: ["--add-dir", "--cd"],
};
const RAW_CONTROL_ARGUMENTS = {
  claude: [{ field: "permission_mode", options: ["--permission-mode"] }],
  codex: [
    { field: "sandbox", options: ["--sandbox", "-s"] },
    { field: "approval_policy", options: ["--ask-for-approval", "-a"] },
    { field: "profile", options: ["--profile", "-p"] },
    { field: "config", options: ["--config", "-c"] },
  ],
  opencode: [
    { field: "continue", options: ["--continue", "-c"] },
    { field: "session", options: ["--session", "-s"] },
    { field: "agent", options: ["--agent"] },
    { field: "command", options: ["--command"] },
    { field: "port", options: ["--port"] },
    { field: "attach", options: ["--attach"] },
    { field: "share", options: ["--share"] },
  ],
};
const LEGACY_STATE_ROOT = join(homedir(), ".local", "state", "workflow-launcher");

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

function validateAbsolutePath(value, context) {
  const normalized = expandHome(validateString(value, context));
  if (!isAbsolute(normalized)) fail("schema", `${context} must be absolute after ~ expansion`);
  return normalized;
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

function validateOptionalString(value, context) {
  if (value === undefined || value === null) return null;
  return validateString(value, context);
}

function validateNonEmptyStringList(values, context) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("schema", `${context} must be a non-empty array`);
  }
  return values.map((value, index) => validateString(value, `${context}[${index}]`));
}

function validateOptionalStringList(values, context) {
  if (values === undefined) return undefined;
  const normalized = validateNonEmptyStringList(values, context);
  const seen = new Set();
  for (const value of normalized) {
    if (seen.has(value)) fail("schema", `${context} must not contain duplicate value ${value}`);
    seen.add(value);
  }
  return normalized;
}

function matchesRawOption(argument, option) {
  return argument === option
    || argument.startsWith(`${option}=`)
    || (/^-[^-]$/.test(option) && argument.startsWith(option) && argument.length > option.length);
}

function validateArguments(values, profileName, harness) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) fail("schema", `agent profile ${profileName}.arguments must be an array`);

  const argumentsList = values.map((value, index) => validateString(value, `agent profile ${profileName}.arguments[${index}]`));

  for (const argument of argumentsList) {
    const lower = argument.toLowerCase();
    for (const forbidden of FORBIDDEN_ARGUMENTS) {
      if (matchesRawOption(lower, forbidden)) {
        fail("schema", `agent profile ${profileName} must not include dangerous argument ${argument}`);
      }
    }

    for (const owned of CONTROL_PLANE_ARGUMENTS[harness] ?? []) {
      if (matchesRawOption(lower, owned)) {
        fail("schema", `agent profile ${profileName} must not override control-plane-managed argument ${argument}`);
      }
    }

    for (const control of RAW_CONTROL_ARGUMENTS[harness] ?? []) {
      if (control.options.some((option) => matchesRawOption(lower, option))) {
        fail("schema", `agent profile ${profileName} must not override structured ${control.field} via raw argument ${argument}`);
      }
    }
  }

  return argumentsList;
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

function validateProjectKind(project, projectName) {
  if (typeof project.kind !== "string" || !project.kind.trim()) {
    fail("schema", `${projectName}.kind must be one of work or personal`);
  }
  if (project.kind !== "work" && project.kind !== "personal") {
    fail("schema", `${projectName}.kind must be one of work or personal`);
  }
  return project.kind;
}

function validateProjectAgentSettings(project, projectName) {
  if (project.default_agent_profile !== undefined) {
    project.default_agent_profile = validateString(project.default_agent_profile, `${projectName}.default_agent_profile`);
  }
  if (project.allowed_agent_profiles !== undefined) {
    project.allowed_agent_profiles = validateOptionalStringList(project.allowed_agent_profiles, `${projectName}.allowed_agent_profiles`);
  }
  return project;
}

function validateOrdinaryProject(project, projectName) {
  const normalized = validateProjectAgentSettings(clone(project), projectName);
  normalized.kind = validateProjectKind(normalized, projectName);
  normalized.path = validateAbsolutePath(normalized.path, `${projectName}.path`);
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
  if (normalized.verify !== undefined) {
    if (!Array.isArray(normalized.verify)) {
      fail("schema", `${projectName}.verify must be an array of commands`);
    }
    normalized.verify = normalized.verify.map((command, index) => validateString(command, `${projectName}.verify[${index}]`));
  }
  return normalized;
}

function validateGroupRepository(repository, repositoryName, projectName) {
  if (!isObject(repository)) fail("schema", `${projectName}.repositories.${repositoryName} must be an object`);
  const normalized = clone(repository);
  normalized.path = validateAbsolutePath(normalized.path, `${projectName}.repositories.${repositoryName}.path`);
  normalized.base_branch = validateString(normalized.base_branch, `${projectName}.repositories.${repositoryName}.base_branch`);
  normalized.branch_template = validateTemplate(normalized.branch_template, ALLOWED_CHILD_TEMPLATE_PLACEHOLDERS, `${projectName}.repositories.${repositoryName}.branch_template`);
  return normalized;
}

function validateGroupProject(project, projectName) {
  const normalized = validateProjectAgentSettings(clone(project), projectName);
  normalized.kind = validateProjectKind(normalized, projectName);
  normalized.path = validateAbsolutePath(normalized.path, `${projectName}.path`);
  normalized.repository = validateString(normalized.repository, `${projectName}.repository`);
  if (normalized.repository !== "group") {
    fail("schema", `${projectName}.repository must be group`);
  }
  normalized.worktree = validateWorktree(normalized.worktree, projectName);
  normalized.coordination = isObject(normalized.coordination) ? {
    ...clone(normalized.coordination),
    meta_repository: validateAbsolutePath(normalized.coordination.meta_repository, `${projectName}.coordination.meta_repository`),
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
  if (normalized.verify !== undefined) {
    if (!Array.isArray(normalized.verify)) {
      fail("schema", `${projectName}.verify must be an array of commands`);
    }
    normalized.verify = normalized.verify.map((command, index) => validateString(command, `${projectName}.verify[${index}]`));
  }
  return normalized;
}

function validateLauncherV2(launcher) {
  if (!isObject(launcher)) fail("schema", "launcher must be an object");
  const normalized = clone(launcher);
  normalized.worktree_root = validateAbsolutePath(normalized.worktree_root, "launcher.worktree_root");
  if (!isObject(normalized.agent)) fail("schema", "launcher.agent must be an object");
  normalized.agent = {
    ...clone(normalized.agent),
    command: validateString(normalized.agent.command, "launcher.agent.command"),
    session_template: validateTemplate(normalized.agent.session_template, ALLOWED_TEMPLATE_PLACEHOLDERS, "launcher.agent.session_template"),
  };
  return normalized;
}

function validateLauncherV3(launcher) {
  if (!isObject(launcher)) fail("schema", "launcher must be an object");
  const normalized = clone(launcher);
  normalized.worktree_root = validateAbsolutePath(normalized.worktree_root, "launcher.worktree_root");
  normalized.state_root = validateAbsolutePath(normalized.state_root, "launcher.state_root");
  normalized.session_template = validateTemplate(normalized.session_template, ALLOWED_TEMPLATE_PLACEHOLDERS, "launcher.session_template");
  normalized.default_agent_profile = validateString(normalized.default_agent_profile, "launcher.default_agent_profile");
  normalized.delegation = validateDelegationPolicy(normalized.delegation, "launcher.delegation");
  if (normalized.fixture_mode !== undefined && normalized.fixture_mode !== true) {
    fail("schema", "launcher.fixture_mode may only be true for a generated fixture registry");
  }
  if (!Number.isInteger(normalized.max_bundle_tickets) || normalized.max_bundle_tickets <= 0) {
    fail("schema", "launcher.max_bundle_tickets must be a positive integer");
  }
  if (!isObject(normalized.agent_profiles) || Object.keys(normalized.agent_profiles).length === 0) {
    fail("schema", "launcher.agent_profiles must contain at least one profile");
  }

  const agentProfiles = {};
  for (const [profileName, profileValue] of Object.entries(normalized.agent_profiles)) {
    validateString(profileName, "launcher.agent_profiles key");
    agentProfiles[profileName] = validateAgentProfile(profileName, profileValue, { fixtureMode: normalized.fixture_mode === true });
  }

  if (!agentProfiles[normalized.default_agent_profile]) {
    fail("schema", `launcher.default_agent_profile ${normalized.default_agent_profile} does not match any profile`);
  }

  normalized.agent_profiles = agentProfiles;
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

function validateProjectAgentReferences(projects, launcher) {
  const profileNames = new Set(Object.keys(launcher.agent_profiles));
  const globalDefault = launcher.default_agent_profile;

  for (const [projectName, project] of Object.entries(projects)) {
    if (project.default_agent_profile !== undefined && !profileNames.has(project.default_agent_profile)) {
      fail("schema", `${projectName}.default_agent_profile ${project.default_agent_profile} does not match any launcher agent profile`);
    }
    if (project.allowed_agent_profiles !== undefined) {
      for (const profileName of project.allowed_agent_profiles) {
        if (!profileNames.has(profileName)) {
          fail("schema", `${projectName}.allowed_agent_profiles contains unknown profile ${profileName}`);
        }
      }
      const effectiveDefault = project.default_agent_profile ?? globalDefault;
      if (!project.allowed_agent_profiles.includes(effectiveDefault)) {
        fail("schema", `${projectName}.default_agent_profile ${effectiveDefault} must be included in ${projectName}.allowed_agent_profiles`);
      }
    }
  }
}

function normalizeProjectDelegationPolicies(projects, launcher) {
  const normalized = {};
  for (const [projectName, project] of Object.entries(projects)) {
    normalized[projectName] = {
      ...project,
      delegation: resolveProjectDelegationPolicy(
        launcher.delegation,
        project.delegation,
        `projects.${projectName}.delegation`,
      ),
    };
  }
  return normalized;
}

function addLegacyLauncherAgent(launcher) {
  const defaultProfile = launcher.agent_profiles[launcher.default_agent_profile];
  return {
    ...launcher,
    agent: {
      command: defaultProfile.command,
      session_template: launcher.session_template,
    },
  };
}

function migrateV2Registry(value) {
  const registry = clone(value);
  const launcher = validateLauncherV2(registry.launcher);
  const projects = validateProjects(registry.projects);
  const normalized = {
    ...registry,
    version: 3,
    launcher: {
      worktree_root: launcher.worktree_root,
      state_root: LEGACY_STATE_ROOT,
      session_template: launcher.agent.session_template,
      default_agent_profile: "pi-worker",
      max_bundle_tickets: 10,
      agent_profiles: {
        "pi-worker": {
          harness: "pi",
          command: launcher.agent.command,
          mode: "interactive",
          roles: ["coordinator", "implementer", "reviewer"],
          model: null,
          arguments: [],
        },
      },
    },
    projects,
  };
  const validatedLauncher = validateLauncherV3(normalized.launcher);
  const normalizedProjects = normalizeProjectDelegationPolicies(projects, validatedLauncher);
  validateProjectAgentReferences(normalizedProjects, validatedLauncher);
  return {
    ...normalized,
    launcher: addLegacyLauncherAgent(validatedLauncher),
    projects: normalizedProjects,
  };
}

function validateV3Registry(value) {
  const registry = clone(value);
  const launcher = validateLauncherV3(registry.launcher);
  const projects = normalizeProjectDelegationPolicies(validateProjects(registry.projects), launcher);
  validateProjectAgentReferences(projects, launcher);
  return {
    ...registry,
    version: 3,
    launcher: addLegacyLauncherAgent(launcher),
    projects,
  };
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

export function validateAgentProfile(name, value, { fixtureMode = false } = {}) {
  if (!isObject(value)) fail("schema", `agent profile ${name} must be an object`);
  const normalized = clone(value);
  if (Object.hasOwn(normalized, "bypassPermissions")) {
    fail("schema", `agent profile ${name} must not set bypassPermissions`);
  }

  normalized.harness = validateString(normalized.harness, `agent profile ${name}.harness`);
  if (!HARNESSES.has(normalized.harness)) {
    fail("schema", `agent profile ${name}.harness must be one of ${[...HARNESSES].join(", ")} (received ${normalized.harness})`);
  }

  for (const key of Object.keys(normalized)) {
    if (!PROFILE_FIELDS_BY_HARNESS[normalized.harness].has(key)) {
      fail("schema", `agent profile ${name} contains unknown field ${key}`);
    }
  }

  normalized.command = validateString(normalized.command, `agent profile ${name}.command`);
  normalized.mode = validateString(normalized.mode, `agent profile ${name}.mode`);
  const supportedModes = fixtureMode
    ? new Set([...MODES_BY_HARNESS[normalized.harness], "stream-json"])
    : MODES_BY_HARNESS[normalized.harness];
  if (!supportedModes.has(normalized.mode)) {
    fail("schema", `agent profile ${name}.mode must be one of ${[...supportedModes].join(", ")} for ${normalized.harness}`);
  }
  normalized.roles = validateNonEmptyStringList(normalized.roles, `agent profile ${name}.roles`);
  normalized.model = validateOptionalString(normalized.model, `agent profile ${name}.model`);
  normalized.arguments = validateArguments(normalized.arguments, name, normalized.harness);

  if (normalized.harness === "claude") {
    normalized.permission_mode = validateString(normalized.permission_mode, `agent profile ${name}.permission_mode`);
    if (!CLAUDE_PERMISSION_MODES.has(normalized.permission_mode)) {
      fail("schema", `agent profile ${name}.permission_mode must be one of ${[...CLAUDE_PERMISSION_MODES].join(", ")} (received ${normalized.permission_mode})`);
    }
  }

  if (normalized.harness === "opencode") {
    normalized.availability = validateString(normalized.availability, `agent profile ${name}.availability`);
    if (normalized.availability !== "fixture-only") {
      fail("schema", `agent profile ${name}.availability must be fixture-only`);
    }
  }

  if (normalized.harness === "codex") {
    normalized.sandbox = validateString(normalized.sandbox, `agent profile ${name}.sandbox`);
    if (!CODEX_SANDBOXES.has(normalized.sandbox)) {
      fail("schema", `agent profile ${name}.sandbox must be one of ${[...CODEX_SANDBOXES].join(", ")} (received ${normalized.sandbox})`);
    }
    normalized.approval_policy = validateString(normalized.approval_policy, `agent profile ${name}.approval_policy`);
    if (!CODEX_APPROVALS.has(normalized.approval_policy)) {
      fail("schema", `agent profile ${name}.approval_policy must be one of ${[...CODEX_APPROVALS].join(", ")} (received ${normalized.approval_policy})`);
    }
  }

  return normalized;
}

export function validateRegistry(value) {
  const registry = clone(value);
  if (!isObject(registry)) fail("schema", "Registry must be an object");
  if (registry.version === 1) fail("schema", "Registry version 1 is not supported");
  if (registry.version === 2) return deepFreeze(migrateV2Registry(registry));
  if (registry.version === 3) return deepFreeze(validateV3Registry(registry));
  fail("schema", `Registry must use version 2 or 3 (received ${registry.version ?? "unknown"})`);
}

export function resolveProject(registry, alias) {
  const project = registry?.projects?.[alias];
  if (!project) fail("lookup", `Unknown workflow project: ${alias}`, { exitCode: 2, details: { alias } });
  return project;
}
