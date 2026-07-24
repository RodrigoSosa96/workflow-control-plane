import { createHash } from "node:crypto";
import { WorkflowError } from "./errors.js";

const MAX_LABEL_LENGTH = 32;
// Herdr requires agent names to start with a lowercase letter and hold only
// lowercase letters, digits, "-" or "_", within 1-32 characters.
const MAX_AGENT_NAME_LENGTH = 32;
const AGENT_NAME_DIGEST_LENGTH = 6;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const PLACEHOLDER_RE = /\{([^{}]+)\}/g;
const ALLOWED_TEMPLATE_PLACEHOLDERS = new Set(["worktree_root", "project", "task", "slug", "repository"]);

function fail(category, message, options) {
  throw new WorkflowError(category, message, options);
}

function text(value, context) {
  if (typeof value !== "string") fail("naming", `${context} must be a string`);
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
  if (!normalized) fail("naming", `${context} cannot be empty`);
  return normalized;
}

function isAbsolutePath(value) {
  return value.startsWith("/") || value.startsWith("\\") || WINDOWS_ABSOLUTE_RE.test(value);
}

function hasTraversal(value) {
  const parts = value.split(/[\\/]/);
  return parts.some((part) => part === "." || part === "..") || parts.includes("");
}

function ensureSafeSegment(value, context) {
  const segment = text(value, context);
  if (isAbsolutePath(segment)) fail("naming", `${context} cannot be absolute`);
  if (segment === "." || segment === ".." || hasTraversal(segment)) {
    fail("naming", `${context} cannot contain path traversal segments`);
  }
  if (!SAFE_SEGMENT_RE.test(segment)) fail("naming", `${context} must use ASCII letters, numbers, and hyphens only`);
  return segment;
}

function sanitizeSlug(value, context, { preserveCase = false } = {}) {
  const normalized = text(value, context);
  const transformed = normalized
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const result = preserveCase ? transformed : transformed.toLowerCase();
  return ensureSafeSegment(result, context);
}

function boundLabel(value, maxLength = MAX_LABEL_LENGTH) {
  const label = text(value, "label");
  if (label.length <= maxLength) return label;
  const trimmed = label.slice(0, maxLength).replace(/[\s._-]+$/u, "");
  return trimmed || label.slice(0, maxLength);
}

export function slugify(value) {
  return sanitizeSlug(value, "slug");
}

function agentNameDigest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, AGENT_NAME_DIGEST_LENGTH);
}

// Derives the Herdr agent registry name from a session name. Session names stay
// readable and keep their ticket casing; only the Herdr boundary uses this form,
// so it must be deterministic to keep reconciliation matching a running agent.
export function herdrAgentName(sessionName) {
  const normalized = text(sessionName, "sessionName")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/[-_]+$/, "");

  if (!normalized) return `agent-${agentNameDigest(sessionName)}`;
  if (normalized.length <= MAX_AGENT_NAME_LENGTH) return normalized;

  const head = normalized
    .slice(0, MAX_AGENT_NAME_LENGTH - AGENT_NAME_DIGEST_LENGTH - 1)
    .replace(/[-_]+$/, "");
  return `${head}-${agentNameDigest(sessionName)}`;
}

export function normalizeTask(value) {
  const normalized = text(value, "task");
  if (/[\\/]/.test(normalized) || isAbsolutePath(normalized) || normalized === "." || normalized === ".." || hasTraversal(normalized)) {
    fail("naming", "task cannot contain path traversal segments");
  }
  return sanitizeSlug(normalized, "task", { preserveCase: true });
}

export function expandTemplate(template, values = {}) {
  const source = text(template, "template");
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    fail("template", "template values must be an object");
  }

  const expanded = source.replace(PLACEHOLDER_RE, (match, name) => {
    if (!ALLOWED_TEMPLATE_PLACEHOLDERS.has(name)) {
      fail("template", `Unknown placeholder {${name}} in template`);
    }
    if (!(name in values)) {
      fail("template", `Unresolved placeholder {${name}} in template`);
    }
    const value = values[name];
    if (name === "worktree_root") {
      return text(value, `template value {${name}}`);
    }
    return ensureSafeSegment(value, `template value {${name}}`);
  });

  if (/[{}]/.test(expanded)) {
    fail("template", `Template contains unresolved placeholder syntax: ${source}`);
  }
  return expanded;
}

export { boundLabel, ensureSafeSegment };
