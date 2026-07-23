import { randomUUID as defaultRandomUUID } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WorkflowError } from "./errors.js";
import { RUN_STATES, isRunState, transitionRun } from "./run-state.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RUN_FILE = "run.json";
const EVENTS_FILE = "events.jsonl";
const ASSIGNMENT_FILE = "assignment.md";
const LOCK_FILE = "run.lock";
const ACTIVE_LOCK_DIR = "active";
const STALE_LOCK_MS = 5 * 60 * 1000;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INITIAL_STATES = new Set([RUN_STATES.PLANNED]);

function fail(category, message, options) {
  throw new WorkflowError(category, message, options);
}

function failStore(message, options) {
  fail("run-store", message, options);
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failStore(`${context} must be an object`);
  }
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) return value;
  failStore("clock must return a timestamp string, Date, or epoch milliseconds");
}

function createClock(clock) {
  if (clock === undefined) return () => new Date().toISOString();
  if (typeof clock === "function") return () => normalizeTimestamp(clock());
  if (clock && typeof clock.now === "function") return () => normalizeTimestamp(clock.now());
  failStore("clock must be a function or expose now()");
}

function resolveStateRoot(stateRoot) {
  if (typeof stateRoot !== "string" || !stateRoot.trim()) {
    failStore("stateRoot is required");
  }
  return resolve(stateRoot);
}

function ensureRunId(value) {
  if (typeof value !== "string" || !RUN_ID_RE.test(value)) {
    failStore("Invalid run ID; expected a path-safe UUID");
  }
  return value.toLowerCase();
}

function validateChildPath(root, child) {
  const rel = relative(root, child);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    failStore("Invalid run ID; expected a path-safe UUID");
  }
}

function validatePrivateRelativePath(directory, value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || isAbsolute(value)) {
    failStore("Private artifact path must be a non-empty relative path");
  }
  const destination = resolve(directory, value);
  const normalized = relative(directory, destination);
  if (!normalized || normalized.startsWith("..") || isAbsolute(normalized)) {
    failStore("Private artifact path must remain inside the run directory");
  }
  return normalized;
}

function sanitizeFsCode(error) {
  if (error && typeof error.code === "string") return error.code;
  return "FS_ERROR";
}

function throwFs(action, path, error) {
  failStore(`Unable to ${action} at ${path} (${sanitizeFsCode(error)})`);
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "unknown";
  if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))}ms`;
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function attachDirectory(run, directory) {
  return { ...run, directory };
}

function persistableRun(run) {
  const { directory: _directory, ...persisted } = run;
  return persisted;
}

function validateRunRecord(record, expectedRunId, path) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    failStore(`Invalid run record at ${path}`);
  }
  if (record.id !== expectedRunId) {
    failStore(`Invalid run record at ${path}`);
  }
  if (!isRunState(record.state)) {
    failStore(`Invalid run state at ${path}`);
  }
  if (!Array.isArray(record.stateHistory)) {
    failStore(`Invalid run state history at ${path}`);
  }
  return record;
}

function parseRunJson(text, path, expectedRunId) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    failStore(`Malformed run JSON at ${path}; parse failed`);
  }
  return validateRunRecord(parsed, expectedRunId, path);
}

export function createRunStore({ stateRoot, fs = defaultFs, clock, randomUUID = defaultRandomUUID } = {}) {
  const root = resolveStateRoot(stateRoot);
  const now = createClock(clock);
  let tempCounter = 0;
  let eventCounter = 0;
  let lockCounter = 0;

  function runDirectoryFor(runId) {
    const id = ensureRunId(runId);
    const directory = resolve(root, id);
    validateChildPath(root, directory);
    return directory;
  }

  function nextRandom(context) {
    const value = randomUUID();
    if (typeof value !== "string" || !value.trim()) {
      failStore(`${context} generator returned an invalid value`);
    }
    return value;
  }

  function nextRunId(inputRunId) {
    return ensureRunId(inputRunId ?? nextRandom("run ID"));
  }

  function nextEventId() {
    eventCounter += 1;
    return `${eventCounter}-${nextRandom("event ID")}`;
  }

  async function chmodPath(path, mode, context, { missingOk = false } = {}) {
    try {
      await fs.chmod(path, mode);
      return true;
    } catch (error) {
      if (missingOk && error?.code === "ENOENT") return false;
      throwFs(`set private mode on ${context}`, path, error);
    }
  }

  async function chmodPrivateDirectory(directory, context, options) {
    return chmodPath(directory, PRIVATE_DIR_MODE, context, options);
  }

  async function chmodPrivateFile(path, context, options) {
    return chmodPath(path, PRIVATE_FILE_MODE, context, options);
  }

  async function ensureStateRootDirectory() {
    try {
      await fs.mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (error) {
      throwFs("create state root", root, error);
    }
    await chmodPrivateDirectory(root, "state root");
  }

  async function ensureRunDirectory(directory) {
    try {
      await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (error) {
      throwFs("create run directory", directory, error);
    }
    await chmodPrivateDirectory(directory, "run directory");
  }

  async function tightenExistingStateRootDirectory() {
    return chmodPrivateDirectory(root, "state root", { missingOk: true });
  }

  async function tightenExistingRunDirectory(directory) {
    return chmodPrivateDirectory(directory, "run directory", { missingOk: true });
  }

  async function pathExists(path) {
    try {
      await fs.stat(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throwFs("stat path", path, error);
    }
  }

  async function readRunInternal(runId, directory) {
    const path = join(directory, RUN_FILE);
    await chmodPrivateFile(path, "run file", { missingOk: true });
    let text;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        failStore(`Run not found: ${runId}`);
      }
      throwFs("read run file", path, error);
    }
    return parseRunJson(text, path, runId);
  }

  async function ensurePrivateParentDirectories(directory, filename) {
    const destination = resolve(directory, filename);
    const parent = dirname(destination);
    const normalizedParent = relative(directory, parent);
    if (normalizedParent && (normalizedParent.startsWith("..") || isAbsolute(normalizedParent))) {
      failStore("Private artifact path must remain inside the run directory");
    }
    try {
      await fs.mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (error) {
      throwFs("create private artifact parent", parent, error);
    }

    let current = directory;
    for (const segment of normalizedParent.split("/").filter(Boolean)) {
      current = join(current, segment);
      await chmodPrivateDirectory(current, "private artifact parent");
    }
  }

  async function writeAtomicText(directory, filename, text, { exclusive = false } = {}) {
    const normalizedFilename = validatePrivateRelativePath(directory, filename);
    await ensurePrivateParentDirectories(directory, normalizedFilename);
    if (exclusive && await pathExists(join(directory, normalizedFilename))) {
      failStore(`Private artifact already exists and the write is exclusive: ${normalizedFilename}`);
    }
    tempCounter += 1;
    const destination = join(directory, normalizedFilename);
    const tempPath = join(dirname(destination), `.${basename(destination)}.${process.pid}.${tempCounter}.tmp`);
    await chmodPrivateFile(destination, normalizedFilename, { missingOk: true });
    await chmodPrivateFile(tempPath, "temporary file", { missingOk: true });
    let handle;
    try {
      handle = await fs.open(tempPath, "w", PRIVATE_FILE_MODE);
    } catch (error) {
      throwFs("open temporary file", tempPath, error);
    }

    let writeError;
    try {
      await chmodPrivateFile(tempPath, "temporary file");
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } catch (error) {
      writeError = error;
    }

    try {
      await handle.close();
    } catch (error) {
      if (!writeError) writeError = error;
    }

    if (writeError) {
      throwFs("write temporary file", tempPath, writeError);
    }

    try {
      await fs.rename(tempPath, destination);
    } catch (error) {
      throwFs("rename temporary file", destination, error);
    }
    await chmodPrivateFile(destination, normalizedFilename);
  }

  async function writeRun(directory, run) {
    const persisted = persistableRun(run);
    await writeAtomicText(directory, RUN_FILE, `${JSON.stringify(persisted, null, 2)}\n`);
    return attachDirectory(persisted, directory);
  }

  async function appendSynced(path, text) {
    await chmodPrivateFile(path, "append file", { missingOk: true });
    let handle;
    try {
      handle = await fs.open(path, "a", PRIVATE_FILE_MODE);
    } catch (error) {
      throwFs("open append file", path, error);
    }

    let appendError;
    try {
      await chmodPrivateFile(path, "append file");
      await handle.appendFile(text, "utf8");
      await handle.sync();
    } catch (error) {
      appendError = error;
    }

    try {
      await handle.close();
    } catch (error) {
      if (!appendError) appendError = error;
    }

    if (appendError) {
      throwFs("append file", path, appendError);
    }
    await chmodPrivateFile(path, "append file");
  }

  async function activeLockContentionError(activePath) {
    let ageMs = Number.NaN;
    try {
      const activeStat = await fs.stat(activePath);
      ageMs = Math.max(0, Date.parse(now()) - activeStat.mtimeMs);
    } catch (_error) {
      // Keep the recovery message bounded and avoid deleting or inspecting further.
    }
    const stale = Number.isFinite(ageMs) && ageMs >= STALE_LOCK_MS;
    const prefix = stale ? "Stale active run lock" : "Run is locked by an active lock";
    return new WorkflowError(
      "run-lock",
      `${prefix} at ${activePath}; age ${formatAge(ageMs)}. Manual inspection required; active lock was not removed.`,
      { details: { lockPath: activePath, activePath, ageMs: Number.isFinite(ageMs) ? ageMs : null, stale } },
    );
  }

  async function legacyLockContainerError(lockContainer) {
    await chmodPrivateFile(lockContainer, "legacy lock file", { missingOk: true });
    return new WorkflowError(
      "run-lock",
      `Legacy fixed-file run lock at ${lockContainer}; manual recovery required. It was not migrated or removed.`,
      { details: { lockPath: lockContainer, legacy: true } },
    );
  }

  function nextLockOwnerToken() {
    lockCounter += 1;
    return `${process.pid}-${lockCounter}-${defaultRandomUUID()}`;
  }

  function lockOwnershipError(lockPath, reason) {
    return new WorkflowError(
      "run-lock",
      `Run lock ownership could not be verified at ${lockPath}; ${reason}. Manual inspection required; active lock was not removed.`,
      { details: { lockPath, reason } },
    );
  }

  function sameActiveDirectory(left, right) {
    if (
      Number.isFinite(left?.dev) && Number.isFinite(left?.ino)
      && Number.isFinite(right?.dev) && Number.isFinite(right?.ino)
    ) {
      return left.dev === right.dev && left.ino === right.ino;
    }
    return left?.ctimeMs === right?.ctimeMs && left?.mtimeMs === right?.mtimeMs;
  }

  async function ensureLockContainer(directory) {
    const lockContainer = join(directory, LOCK_FILE);
    try {
      await fs.mkdir(lockContainer, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throwFs("create lock container", lockContainer, error);
      }
      let lockStat;
      try {
        lockStat = await fs.stat(lockContainer);
      } catch (statError) {
        throwFs("stat lock container", lockContainer, statError);
      }
      if (!lockStat.isDirectory()) {
        throw await legacyLockContainerError(lockContainer);
      }
    }
    await chmodPrivateDirectory(lockContainer, "lock container");
    return lockContainer;
  }

  async function statOwnedActive(ownership, phase) {
    let activeStat;
    try {
      activeStat = await fs.stat(ownership.activePath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw lockOwnershipError(ownership.activePath, `active lock directory is missing during ${phase}`);
      }
      throw error;
    }
    if (!activeStat.isDirectory()) {
      throw lockOwnershipError(ownership.activePath, `active lock path is not a directory during ${phase}`);
    }
    if (!sameActiveDirectory(activeStat, ownership.activeStat)) {
      throw lockOwnershipError(ownership.activePath, `active lock directory was replaced during ${phase}`);
    }
    return activeStat;
  }

  async function cleanupFailedAcquisition(ownership) {
    try {
      await fs.unlink(ownership.markerPath);
    } catch (_error) {
      // Cleanup best-effort only; the original acquisition error is more useful.
    }
    try {
      await fs.rmdir(ownership.activePath);
    } catch (_error) {
      // Leave any incomplete active lock for manual recovery rather than deleting unknown state.
    }
  }

  async function acquireLock(directory) {
    const lockContainer = await ensureLockContainer(directory);
    const activePath = join(lockContainer, ACTIVE_LOCK_DIR);
    try {
      await fs.mkdir(activePath, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if (error?.code === "EEXIST") {
        await chmodPrivateDirectory(activePath, "active lock", { missingOk: true });
        throw await activeLockContentionError(activePath);
      }
      if (error?.code === "ENOTDIR") {
        throw await legacyLockContainerError(lockContainer);
      }
      throwFs("create active lock", activePath, error);
    }

    await chmodPrivateDirectory(activePath, "active lock");
    const activeStat = await fs.stat(activePath);
    if (!activeStat.isDirectory()) {
      throw lockOwnershipError(activePath, "active lock path is not a directory after acquisition");
    }

    const token = nextLockOwnerToken();
    const markerName = `owner-${token}.json`;
    const markerPath = join(activePath, markerName);
    const ownership = { path: activePath, lockContainer, activePath, activeStat, markerPath, token };
    let handle;
    try {
      handle = await fs.open(markerPath, "wx", PRIVATE_FILE_MODE);
    } catch (error) {
      await cleanupFailedAcquisition(ownership);
      throwFs("create lock owner marker", markerPath, error);
    }

    let markerError;
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, token })}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      markerError = error;
    }

    try {
      await handle.close();
    } catch (error) {
      if (!markerError) markerError = error;
    }

    if (markerError) {
      await cleanupFailedAcquisition(ownership);
      throwFs("write lock owner marker", markerPath, markerError);
    }

    await chmodPrivateFile(markerPath, "lock owner marker");
    return ownership;
  }

  async function releaseLock(ownership) {
    await statOwnedActive(ownership, "release");
    try {
      await fs.unlink(ownership.markerPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw lockOwnershipError(ownership.activePath, "owner marker is missing");
      }
      throw error;
    }

    await statOwnedActive(ownership, "active removal");
    try {
      await fs.rmdir(ownership.activePath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw lockOwnershipError(ownership.activePath, "active lock directory disappeared before removal");
      }
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
        throw lockOwnershipError(ownership.activePath, "active lock directory is nonempty");
      }
      throw error;
    }
  }

  async function withLock(directory, callback) {
    const ownership = await acquireLock(directory);
    let result;
    let callbackError;
    try {
      result = await callback();
    } catch (error) {
      callbackError = error;
    }

    let releaseError;
    try {
      await releaseLock(ownership);
    } catch (error) {
      releaseError = error;
    }

    if (releaseError) {
      if (callbackError) releaseError.cause = callbackError;
      if (releaseError instanceof WorkflowError) throw releaseError;
      throwFs("release lock", ownership.path, releaseError);
    }
    if (callbackError) throw callbackError;
    return result;
  }

  function initialRun(input, runId) {
    assertObject(input, "run input");
    const timestamp = now();
    const {
      id: _id,
      runId: _runId,
      directory: _directory,
      version: _version,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      stateHistory: _stateHistory,
      state: requestedState = RUN_STATES.PLANNED,
      ...fields
    } = input;

    if (!INITIAL_STATES.has(requestedState)) {
      failStore(`Invalid initial run state: ${requestedState}`);
    }

    return {
      version: 1,
      ...fields,
      id: runId,
      state: requestedState,
      createdAt: timestamp,
      updatedAt: timestamp,
      stateHistory: [{ from: null, to: requestedState, at: timestamp }],
    };
  }

  function updatedRun(current, patch) {
    assertObject(patch, "run update");
    const {
      id: _id,
      runId: _runId,
      directory: _directory,
      version: _version,
      createdAt: _createdAt,
      stateHistory: _stateHistory,
      state: requestedState = current.state,
      updatedAt: requestedUpdatedAt,
      ...fields
    } = patch;

    if (!isRunState(requestedState)) {
      failStore("Unknown next run state");
    }

    const timestamp = requestedUpdatedAt && requestedUpdatedAt !== current.updatedAt
      ? normalizeTimestamp(requestedUpdatedAt)
      : now();

    if (requestedState !== current.state) {
      return transitionRun(current, requestedState, { ...fields, updatedAt: timestamp });
    }

    return {
      ...current,
      ...fields,
      state: current.state,
      updatedAt: timestamp,
      stateHistory: current.stateHistory,
    };
  }

  async function create(input) {
    await ensureStateRootDirectory();
    const runId = nextRunId(input?.runId);
    const directory = runDirectoryFor(runId);
    await ensureRunDirectory(directory);

    return withLock(directory, async () => {
      const path = join(directory, RUN_FILE);
      if (await pathExists(path)) {
        failStore(`Run already exists: ${runId}`);
      }
      const run = initialRun(input, runId);
      return writeRun(directory, run);
    });
  }

  async function read(runId) {
    const id = ensureRunId(runId);
    const directory = runDirectoryFor(id);
    await tightenExistingStateRootDirectory();
    await tightenExistingRunDirectory(directory);
    return attachDirectory(await readRunInternal(id, directory), directory);
  }

  async function update(runId, updater) {
    if (typeof updater !== "function") {
      failStore("run updater must be a function");
    }
    const id = ensureRunId(runId);
    const directory = runDirectoryFor(id);
    await tightenExistingStateRootDirectory();
    await tightenExistingRunDirectory(directory);

    return withLock(directory, async () => {
      const current = await readRunInternal(id, directory);
      const patch = await updater(cloneJson(attachDirectory(current, directory)));
      const next = updatedRun(current, patch);
      return writeRun(directory, next);
    });
  }

  async function appendEvent(runId, event) {
    assertObject(event, "event");
    if (typeof event.type !== "string" || !event.type.trim()) {
      failStore("event type is required");
    }
    const id = ensureRunId(runId);
    const directory = runDirectoryFor(id);
    await tightenExistingStateRootDirectory();
    await tightenExistingRunDirectory(directory);

    return withLock(directory, async () => {
      await readRunInternal(id, directory);
      const {
        id: _eventId,
        version: _version,
        runId: _runId,
        timestamp: _timestamp,
        type,
        ...fields
      } = event;
      const record = {
        version: 1,
        id: nextEventId(),
        type,
        runId: id,
        timestamp: now(),
        ...fields,
      };
      await appendSynced(join(directory, EVENTS_FILE), `${JSON.stringify(record)}\n`);
      return record;
    });
  }

  async function list(filters = {}) {
    assertObject(filters, "list filters");
    if (!await tightenExistingStateRootDirectory()) return [];
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throwFs("list state root", root, error);
    }

    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
      const runId = entry.name.toLowerCase();
      const directory = runDirectoryFor(runId);
      await tightenExistingRunDirectory(directory);
      const run = attachDirectory(await readRunInternal(runId, directory), directory);
      if (filters.projectAlias !== undefined && run.projectAlias !== filters.projectAlias) continue;
      if (filters.originSessionId !== undefined && run.originSessionId !== filters.originSessionId) continue;
      if (filters.unconsumed === true && run.consumedAt) continue;
      runs.push(run);
    }

    runs.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
    return runs;
  }

  async function writeAssignment(runId, text) {
    if (typeof text !== "string") {
      failStore("assignment text must be a string");
    }
    const id = ensureRunId(runId);
    const directory = runDirectoryFor(id);
    await tightenExistingStateRootDirectory();
    await tightenExistingRunDirectory(directory);

    return withLock(directory, async () => {
      const current = await readRunInternal(id, directory);
      const writtenAt = now();
      const assignmentPath = join(directory, ASSIGNMENT_FILE);
      await writeAtomicText(directory, ASSIGNMENT_FILE, text);
      await writeRun(directory, {
        ...current,
        assignmentPath,
        assignmentUpdatedAt: writtenAt,
        updatedAt: writtenAt,
      });
      return { runId: id, path: assignmentPath, writtenAt };
    });
  }

  async function writePrivateFile(runId, { relativePath, text, updater, exclusive = false } = {}) {
    if (typeof text !== "string") {
      failStore("writePrivateFile text must be a string");
    }
    if (typeof updater !== "function") {
      failStore("writePrivateFile updater must be a function");
    }
    const id = ensureRunId(runId);
    const directory = runDirectoryFor(id);
    const filename = validatePrivateRelativePath(directory, relativePath);
    await tightenExistingStateRootDirectory();
    await tightenExistingRunDirectory(directory);

    return withLock(directory, async () => {
      const current = await readRunInternal(id, directory);
      const patch = await updater(cloneJson(attachDirectory(current, directory)));
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        failStore("writePrivateFile updater must return an object");
      }
      await writeAtomicText(directory, filename, text, { exclusive });
      const run = await writeRun(directory, updatedRun(current, patch));
      return { run, path: join(directory, filename), writtenAt: run.updatedAt };
    });
  }

  return Object.freeze({ create, read, update, appendEvent, list, writeAssignment, writePrivateFile });
}
