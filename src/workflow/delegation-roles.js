import * as defaultFs from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MANAGED_DELEGATION_ROLES } from "./delegation-policy.js";
import { WorkflowError } from "./errors.js";

const MANAGED_ROLE_SET = new Set(MANAGED_DELEGATION_ROLES);
const ALLOWED_FIELDS = new Set(["name", "description", "tools", "systemPromptMode", "inheritProjectContext", "inheritSkills", "async", "maxSubagentDepth"]);
const REQUIRED_FIELDS = ["name", "description", "tools", "systemPromptMode", "inheritProjectContext", "inheritSkills", "async", "maxSubagentDepth"];
const TOOL_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_DESCRIPTION_BYTES = 200;
const MAX_PROMPT_BYTES = 64 * 1024;
const REQUIRED_PROMPT_LITERALS = ["frozen brief", "no subagents", "no cleanup", "no deploy", "no push", "bounded report", "configured verification"];
const EXPECTED_TOOLS = Object.freeze({
  scout: Object.freeze(["read", "bash", "grep", "find", "ls"]),
  "spec-reviewer": Object.freeze(["read", "bash", "grep", "find", "ls"]),
  "code-reviewer": Object.freeze(["read", "bash", "grep", "find", "ls"]),
  "sdd-implementer": Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]),
});

function fail(message, details) {
  throw new WorkflowError("HANDOFF", message, { details });
}

function assertString(value, context, limit = MAX_PROMPT_BYTES) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${context} must be a bounded non-empty string`);
  }
  return value.trim();
}

function ensureContained(root, target, context) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rel = relative(normalizedRoot, normalizedTarget);
  if (!rel || rel.startsWith("..") || rel === "" || rel.split("/").includes("..")) {
    fail(`${context} resolves outside the expected agent directory`);
  }
  return normalizedTarget;
}

function parseFrontmatter(text) {
  const normalized = String(text).replace(/\r\n?/gu, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
  if (!match) fail("Delegation role file must contain YAML frontmatter");
  let frontmatter;
  try {
    frontmatter = parseYaml(match[1]);
  } catch {
    fail("Delegation role frontmatter could not be parsed");
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    fail("Delegation role frontmatter must be an object");
  }
  return { frontmatter, body: match[2].trim() };
}

function normalizeTools(value) {
  const tools = Array.isArray(value)
    ? value.map((tool) => String(tool).trim())
    : typeof value === "string"
      ? value.split(",").map((tool) => tool.trim())
      : null;
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => !tool)) {
    fail("Delegation role tools must be a non-empty list");
  }
  for (const tool of tools) {
    if (!TOOL_NAME_RE.test(tool)) fail("Delegation role tools must use simple tool names only");
    if (tool === "subagent") fail("Delegation role tools must not include nested subagents");
  }
  return tools;
}

function validatePrompt(body) {
  const prompt = assertString(body, "delegation role prompt");
  for (const literal of REQUIRED_PROMPT_LITERALS) {
    if (!prompt.toLowerCase().includes(literal)) fail(`Delegation role prompt must include ${literal}`);
  }
  return prompt;
}

function validateRole(frontmatter, body, expectedName) {
  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_FIELDS.has(key)) fail(`Delegation role frontmatter contains unsupported field ${key}`);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(frontmatter, key)) fail(`Delegation role frontmatter is missing required metadata: ${key}`);
  }

  const name = assertString(frontmatter.name, "delegation role name", 128);
  if (!MANAGED_ROLE_SET.has(name)) fail("Unknown managed delegation role");
  if (name !== expectedName) fail("Delegation role does not match the requested name");
  assertString(frontmatter.description, "delegation role description", MAX_DESCRIPTION_BYTES);
  const tools = normalizeTools(frontmatter.tools);
  const expectedTools = EXPECTED_TOOLS[name];
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) fail("Delegation role tools do not match the managed tool profile");
  if (frontmatter.systemPromptMode !== "append") fail("Delegation role systemPromptMode must be append");
  if (frontmatter.inheritProjectContext !== true) fail("Delegation role must inherit project context");
  if (frontmatter.inheritSkills !== true) fail("Delegation role must inherit skills");
  if (frontmatter.async !== false) fail("Delegation role async/background defaults are not allowed");
  if (frontmatter.maxSubagentDepth !== 1) fail("Delegation role maxSubagentDepth must be 1");
  const systemPrompt = validatePrompt(body);
  return Object.freeze({ name, tools: Object.freeze([...tools]), systemPrompt });
}

async function readContainedRoleFile({ name, agentDirectory, fs }) {
  const requested = assertString(name, "delegation role name", 128);
  if (!MANAGED_ROLE_SET.has(requested)) fail("Unknown managed delegation role");
  const directory = assertString(agentDirectory, "delegation agent directory");
  const realDirectory = await fs.realpath(resolve(directory));
  const candidate = ensureContained(realDirectory, join(realDirectory, `${requested}.md`), "Delegation role file");
  const realCandidate = await fs.realpath(candidate);
  ensureContained(realDirectory, realCandidate, "Delegation role file");
  return { requested, directory: realDirectory, path: realCandidate, text: await fs.readFile(realCandidate, "utf8") };
}

async function assertUniqueDeclarations(directory, fs) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = ensureContained(directory, join(directory, entry.name), "Delegation role file");
    const realPath = await fs.realpath(path);
    ensureContained(directory, realPath, "Delegation role file");
    const { frontmatter } = parseFrontmatter(await fs.readFile(realPath, "utf8"));
    const name = assertString(frontmatter.name, "delegation role name", 128);
    if (seen.has(name)) fail(`Delegation role name is duplicated: ${name}`);
    seen.set(name, realPath);
  }
}

export async function loadDelegationRole({ name, agentDirectory, fs = defaultFs } = {}) {
  if (!fs || typeof fs.readFile !== "function" || typeof fs.readdir !== "function" || typeof fs.realpath !== "function") {
    fail("Delegation role loader requires a filesystem interface");
  }
  const roleFile = await readContainedRoleFile({ name, agentDirectory, fs });
  await assertUniqueDeclarations(roleFile.directory, fs);
  const { frontmatter, body } = parseFrontmatter(roleFile.text);
  return validateRole(frontmatter, body, roleFile.requested);
}
