import { WorkflowError } from "./errors.js";

const MAX_LABEL_LENGTH = 32;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const PLACEHOLDER_RE = /\{([^{}]+)\}/g;

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
