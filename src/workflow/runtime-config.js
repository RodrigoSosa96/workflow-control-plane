import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const MAX_PATH_BYTES = 4096;
const MAX_NAME_BYTES = 512;

function fail(message) {
  throw new TypeError(message);
}

function ensureString(value, name, limit = MAX_PATH_BYTES) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${name} must be a bounded non-empty string`);
  }
  return value.trim();
}

function ensureAbsolutePath(value, name) {
  const path = ensureString(value, name);
  if (!isAbsolute(path)) fail(`${name} must be an absolute path`);
  return resolve(path);
}

export function resolveWorkflowProjectsFile({ env = process.env, defaultPath } = {}) {
  const configured = env?.WORKFLOW_PROJECTS_FILE;
  if (configured === undefined || configured === null || configured === "") {
    return ensureAbsolutePath(defaultPath, "default workflow registry path");
  }
  return ensureAbsolutePath(configured, "WORKFLOW_PROJECTS_FILE");
}

export async function lookupExecutable(name, { env = process.env, accessFn = access } = {}) {
  const command = ensureString(name, "executable name", MAX_NAME_BYTES);
  if (command.includes("/")) {
    const absolute = ensureAbsolutePath(command, "executable path");
    try {
      await accessFn(absolute, fsConstants.X_OK);
      return absolute;
    } catch {
      return null;
    }
  }

  const pathValue = typeof env?.PATH === "string" ? env.PATH : "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      await accessFn(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}
