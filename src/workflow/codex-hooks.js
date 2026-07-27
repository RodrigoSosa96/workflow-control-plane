import { readFile as defaultReadFile, writeFile as defaultWriteFile } from "node:fs/promises";
import { join } from "node:path";

// The Codex analog of buildClaudeWorkerSettings (see harnesses.js), but merged into Codex's
// GLOBAL ~/.codex/hooks.json rather than written into a fresh per-run settings file: Codex has
// no per-invocation --settings flag, so its lifecycle hooks are wired once into that shared
// file (already the mechanism Herdr uses for its own SessionStart hook). Because the file is
// shared with whatever else has installed hooks there, this merge must be additive — it may
// only add the workflow's own entries and must never remove or replace an entry it doesn't own.
export const CODEX_WORKER_HOOK_EVENTS = Object.freeze(["UserPromptSubmit", "Stop", "SessionEnd"]);

function assertString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function workflowHookCommand(controlPlaneRoot, event) {
  const script = join(controlPlaneRoot, "hooks", "codex-lifecycle.mjs");
  // The script path is absolute and per-machine/worktree, so it can contain spaces;
  // double-quote it so the shell keeps it a single argument (mirrors buildClaudeWorkerSettings).
  return `node "${script}" ${event}`;
}

// Pure merge: given the current parsed contents of ~/.codex/hooks.json (or an empty
// {hooks:{}} default) and the control-plane root to embed in the workflow's hook commands,
// returns a new hooks object with one workflow entry appended per CODEX_WORKER_HOOK_EVENTS.
// Any existing event arrays/entries (Herdr's SessionStart, or a workflow entry from a prior
// run of this same merge) are preserved verbatim; the workflow entry is only appended when no
// existing entry for that event already carries the exact same command string, which is what
// makes repeated merges idempotent.
export function mergeCodexWorkerHooks(current, controlPlaneRoot) {
  assertString(controlPlaneRoot, "controlPlaneRoot");
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const currentHooks = base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks) ? base.hooks : {};

  const mergedHooks = { ...currentHooks };
  for (const event of CODEX_WORKER_HOOK_EVENTS) {
    const command = workflowHookCommand(controlPlaneRoot, event);
    const existingGroups = Array.isArray(currentHooks[event]) ? currentHooks[event] : [];
    const alreadyPresent = existingGroups.some(
      (group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => hook?.command === command),
    );
    mergedHooks[event] = alreadyPresent
      ? existingGroups
      : [...existingGroups, { hooks: [{ type: "command", command, timeout: 10 }] }];
  }

  return { ...base, hooks: mergedHooks };
}

// Read-merge-write over the real (or injected) filesystem. A missing or unparseable hooks
// file is treated as an empty {hooks:{}} rather than an error, since a fresh machine simply
// won't have ~/.codex/hooks.json yet. readFile/writeFile are injectable so callers (and tests)
// never have to touch the real ~/.codex/hooks.json.
export async function ensureCodexWorkerHooks({
  hooksPath,
  controlPlaneRoot,
  readFile = defaultReadFile,
  writeFile = defaultWriteFile,
} = {}) {
  assertString(hooksPath, "hooksPath");
  assertString(controlPlaneRoot, "controlPlaneRoot");

  let current = { hooks: {} };
  try {
    const raw = await readFile(hooksPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
  } catch {
    // Absent file or invalid JSON: fall back to the empty default rather than aborting the
    // install — a fresh machine, or a hand-edited file that briefly doesn't parse, must not
    // block launch.
    current = { hooks: {} };
  }

  const merged = mergeCodexWorkerHooks(current, controlPlaneRoot);
  await writeFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
