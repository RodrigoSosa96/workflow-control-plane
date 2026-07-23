import { WorkflowError } from "./errors.js";

export const DEFAULT_DELEGATION_POLICY = Object.freeze({
  version: 1,
  totalInternal: 4,
  foreground: 3,
  readOnlyBackground: 3,
  writersTotal: 1,
  writersPerCheckout: 1,
  maxDepth: 1,
  remediationTurns: 2,
  allowBackgroundWriters: false,
});

export const MANAGED_DELEGATION_ROLES = Object.freeze([
  "scout",
  "spec-reviewer",
  "code-reviewer",
  "sdd-implementer",
]);

const READ_ONLY_ROLES = new Set(["scout", "spec-reviewer", "code-reviewer"]);
const NUMERIC_FIELDS = Object.freeze([
  "totalInternal",
  "foreground",
  "readOnlyBackground",
  "writersTotal",
  "writersPerCheckout",
]);
const FIELDS = new Set([
  "version",
  ...NUMERIC_FIELDS,
  "maxDepth",
  "remediationTurns",
  "allowBackgroundWriters",
]);

function fail(message) {
  throw new WorkflowError("schema", message);
}

function assertObject(value, context) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value;
}

function positiveInteger(value, context) {
  if (!Number.isInteger(value) || value < 1) {
    fail(`${context} must be a positive integer`);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  return Object.freeze(value);
}

function validateCompletePolicy(policy, context) {
  if (policy.version !== 1) fail(`${context}.version must be 1`);

  for (const field of NUMERIC_FIELDS) positiveInteger(policy[field], `${context}.${field}`);

  if (policy.foreground > policy.totalInternal) {
    fail(`${context}.foreground must not exceed ${context}.totalInternal`);
  }
  if (policy.readOnlyBackground > policy.totalInternal) {
    fail(`${context}.readOnlyBackground must not exceed ${context}.totalInternal`);
  }
  if (policy.writersTotal > policy.totalInternal) {
    fail(`${context}.writersTotal must not exceed ${context}.totalInternal`);
  }
  if (policy.writersPerCheckout > policy.writersTotal) {
    fail(`${context}.writersPerCheckout must not exceed ${context}.writersTotal`);
  }
  if (policy.maxDepth !== 1) fail(`${context}.maxDepth must be 1`);
  if (!Number.isInteger(policy.remediationTurns) || policy.remediationTurns < 0 || policy.remediationTurns > 2) {
    fail(`${context}.remediationTurns must be an integer from 0 through 2`);
  }
  if (policy.allowBackgroundWriters !== false) {
    fail(`${context}.allowBackgroundWriters must remain false until the writer fixture gate is approved`);
  }

  return freeze(policy);
}

export function validateDelegationPolicy(value, context = "delegation policy") {
  const supplied = assertObject(value, context);
  for (const key of Object.keys(supplied)) {
    if (!FIELDS.has(key)) fail(`${context} contains unknown delegation policy field ${key}`);
  }
  return validateCompletePolicy({ ...clone(DEFAULT_DELEGATION_POLICY), ...clone(supplied) }, context);
}

export function resolveProjectDelegationPolicy(launcherPolicy, value, context = "project.delegation") {
  const launcher = validateDelegationPolicy(launcherPolicy, "launcher.delegation");
  const supplied = assertObject(value, context);
  for (const key of Object.keys(supplied)) {
    if (!FIELDS.has(key)) fail(`${context} contains unknown delegation policy field ${key}`);
  }

  const effective = { ...launcher, ...clone(supplied) };
  for (const field of NUMERIC_FIELDS) {
    if (supplied[field] !== undefined && effective[field] > launcher[field]) {
      fail(`${context}.${field} must not exceed launcher.delegation.${field}`);
    }
  }
  if (supplied.remediationTurns !== undefined && effective.remediationTurns > launcher.remediationTurns) {
    fail(`${context}.remediationTurns must not exceed launcher.delegation.remediationTurns`);
  }
  if (supplied.maxDepth !== undefined && effective.maxDepth !== 1) {
    fail(`${context}.maxDepth must remain 1`);
  }
  if (supplied.version !== undefined && effective.version !== 1) {
    fail(`${context}.version must be 1`);
  }
  if (supplied.allowBackgroundWriters !== undefined && effective.allowBackgroundWriters !== false) {
    fail(`${context}.allowBackgroundWriters must remain false until the writer fixture gate is approved`);
  }

  return validateCompletePolicy(effective, context);
}

export function resolveDelegationPolicy({ registry, projectAlias } = {}) {
  if (!registry || typeof registry !== "object") fail("registry is required to resolve delegation policy");
  const project = registry.projects?.[projectAlias];
  if (!project || typeof project !== "object") fail(`Unknown workflow project ${projectAlias}`);
  return resolveProjectDelegationPolicy(registry.launcher?.delegation, project.delegation, `projects.${projectAlias}.delegation`);
}

export function classifyDelegationRole(role) {
  if (READ_ONLY_ROLES.has(role)) return "read-only";
  if (role === "sdd-implementer") return "writer";
  fail("Unknown managed delegation role");
}
