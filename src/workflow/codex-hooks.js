import { readFile as defaultReadFile, rename as defaultRename, writeFile as defaultWriteFile } from "node:fs/promises";
import { join } from "node:path";

// The Codex analog of buildClaudeWorkerSettings (see harnesses.js), but merged into Codex's
// GLOBAL ~/.codex/hooks.json rather than written into a fresh per-run settings file: Codex has
// no per-invocation --settings flag, so its lifecycle hooks are wired once into that shared
// file (already the mechanism Herdr uses for its own SessionStart hook). Because the file is
// shared with whatever else has installed hooks there, this merge must be additive — it may
// only add the workflow's own entries and must never remove or replace an entry it doesn't own.
export const CODEX_WORKER_HOOK_EVENTS = Object.freeze(["UserPromptSubmit", "Stop", "SessionEnd"]);

let tempCounter = 0;

function assertString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

// Stable marker identifying the workflow's own entries, independent of the
// control-plane path embedded in the command. Idempotency keyed on the exact
// command string duplicated the hooks whenever the control plane moved (or a
// second checkout launched a Codex worker), and each duplicate invocation
// re-ran the shared hook core, inflating the generation counter.
const WORKFLOW_HOOK_OWNER = "workflow-control-plane:codex-lifecycle";

function workflowHookCommand(controlPlaneRoot, event) {
  const script = join(controlPlaneRoot, "hooks", "codex-lifecycle.mjs");
  // The script path is absolute and per-machine/worktree, so it can contain spaces;
  // double-quote it so the shell keeps it a single argument (mirrors buildClaudeWorkerSettings).
  return `node "${script}" ${event}`;
}

function isWorkflowGroup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  if (group.owner === WORKFLOW_HOOK_OWNER) return true;
  // Entries installed before the owner marker existed are still ours: they run
  // this repo's hooks/codex-lifecycle.mjs, whatever path they were written with.
  return Array.isArray(group.hooks)
    && group.hooks.some((hook) => typeof hook?.command === "string" && hook.command.includes("hooks/codex-lifecycle.mjs"));
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
    // Replace the workflow's own entries (including stale ones pointing at a
    // previous control-plane path) and preserve every entry it does not own.
    const foreignGroups = existingGroups.filter((group) => !isWorkflowGroup(group));
    mergedHooks[event] = [
      ...foreignGroups,
      { owner: WORKFLOW_HOOK_OWNER, hooks: [{ type: "command", command, timeout: 10 }] },
    ];
  }

  return { ...base, hooks: mergedHooks };
}

// Read-merge-write over the real (or injected) filesystem. An ABSENT hooks file is treated as
// an empty {hooks:{}} (a fresh machine simply won't have ~/.codex/hooks.json yet), but a file
// that exists and does not parse is never overwritten: it is a shared file, so replacing
// content this merge cannot read would destroy other tools' entries. The write goes through a
// temp file plus rename so a crash mid-write cannot truncate the shared file. readFile/writeFile
// and rename are injectable so callers (and tests) never touch the real ~/.codex/hooks.json.
export async function ensureCodexWorkerHooks({
  hooksPath,
  controlPlaneRoot,
  readFile = defaultReadFile,
  writeFile = defaultWriteFile,
  rename = defaultRename,
} = {}) {
  assertString(hooksPath, "hooksPath");
  assertString(controlPlaneRoot, "controlPlaneRoot");

  let current = { hooks: {} };
  let raw;
  try {
    raw = await readFile(hooksPath, "utf8");
  } catch (error) {
    // ONLY an absent file may be treated as empty. Any other read failure
    // (EACCES, EIO) means a file exists whose contents we cannot see, and
    // writing then would delete every other tool's hooks.
    if (error?.code !== "ENOENT") {
      throw new TypeError(`Codex hooks file at ${hooksPath} could not be read (${error?.code ?? "FS_ERROR"}); it was left unchanged so other tools' hooks are preserved`);
    }
    raw = null;
  }
  if (typeof raw === "string" && raw.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TypeError(`Codex hooks file at ${hooksPath} is not valid JSON; it was left unchanged so other tools' hooks are preserved`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`Codex hooks file at ${hooksPath} is not a JSON object; it was left unchanged`);
    }
    current = parsed;
  }

  const merged = mergeCodexWorkerHooks(current, controlPlaneRoot);
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  // Per-process unique temp name: two concurrent launches writing one fixed temp
  // path would interleave into a corrupt blob and rename it over the shared file.
  tempCounter += 1;
  const tempPath = `${hooksPath}.workflow-${process.pid}-${tempCounter}.tmp`;
  await writeFile(tempPath, text, { mode: 0o600 });
  await rename(tempPath, hooksPath);
  return merged;
}
