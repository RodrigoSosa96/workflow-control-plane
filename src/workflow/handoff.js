import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WorkflowError } from "./errors.js";
import { RUN_STATES } from "./run-state.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RESULT_FILE = "result.json";
const ARCHIVE_DIR = "results";
const HANDOFF_STATUSES = new Set(["completed", "blocked", "needs-input", "failed"]);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "skipped"]);
const STATUS_TO_RUN_STATE = Object.freeze({
  completed: RUN_STATES.COMPLETED,
  blocked: RUN_STATES.BLOCKED,
  "needs-input": RUN_STATES.NEEDS_INPUT,
  failed: RUN_STATES.FAILED,
});
const HANDOFF_ACCEPTING_STATES = new Set([
  RUN_STATES.RUNNING,
  RUN_STATES.IDLE_AWAITING_HANDOFF,
]);

export const HANDOFF_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  summary: 8_000,
  itemText: 4_000,
  tickets: 10,
  changedFiles: 2_000,
  verification: 100,
  evidencePerTicket: 100,
});

let tempCounter = 0;

function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalResultText(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function fail(message, details) {
  throw new WorkflowError("HANDOFF", message, { details });
}

function failLimit(field) {
  fail(`${field} exceeds handoff limit`);
}

function assertPlainObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
}

function boundedText(value, field, limit = HANDOFF_LIMITS.itemText) {
  if (typeof value !== "string") {
    fail(`${field} must be a string`);
  }
  if (value.includes("\0")) {
    fail(`${field} contains invalid characters`);
  }
  if (value.length > limit) {
    failLimit(field);
  }
  const normalized = value.trim();
  if (!normalized) {
    fail(`${field} is required`);
  }
  return normalized;
}

function optionalTextArray(value, field) {
  if (!Array.isArray(value)) {
    fail(`${field} must be an array`);
  }
  return value.map((entry) => boundedText(entry, field));
}

function enforceInputByteLimit(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_error) {
    fail("Handoff input must be JSON serializable");
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > HANDOFF_LIMITS.bytes) {
    fail("Handoff input exceeds byte limit");
  }
}

function normalizeGeneration(value) {
  const generation = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail("Handoff generation must be a positive integer");
  }
  return generation;
}

function normalizeExpectedTickets(tickets) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    fail("Expected tickets are required");
  }
  if (tickets.length > HANDOFF_LIMITS.tickets) {
    failLimit("tickets");
  }

  const seen = new Set();
  return tickets.map((ticket) => {
    const id = boundedText(String(ticket), "ticket id");
    if (seen.has(id)) {
      fail("Duplicate expected ticket");
    }
    seen.add(id);
    return id;
  });
}

function normalizeExpectedRepository(repository) {
  if (typeof repository === "string") {
    return { id: boundedText(repository, "repository id") };
  }
  assertPlainObject(repository, "expected repository");
  const id = boundedText(String(repository.id ?? repository.alias ?? repository.name ?? ""), "repository id");
  const cwd = repository.cwd ?? repository.path ?? repository.worktreePath ?? repository.checkoutPath;
  return cwd === undefined
    ? { id }
    : { id, cwd: boundedText(String(cwd), "repository path") };
}

function normalizeExpectedRepositories(repositories) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    fail("Expected repositories are required");
  }
  const seen = new Set();
  return repositories.map((repository) => {
    const normalized = normalizeExpectedRepository(repository);
    if (seen.has(normalized.id)) {
      fail("Duplicate expected repository");
    }
    seen.add(normalized.id);
    return normalized;
  });
}

function normalizeStatus(value, allowed, field) {
  const status = boundedText(value, `${field} status`, 100);
  if (!allowed.has(status)) {
    fail(`Unknown ${field} status`);
  }
  return status;
}

function normalizeTicketEntry(value) {
  assertPlainObject(value, "ticket");
  const evidence = value.evidence;
  if (!Array.isArray(evidence)) {
    fail("ticket evidence must be an array");
  }
  if (evidence.length > HANDOFF_LIMITS.evidencePerTicket) {
    failLimit("ticket evidence");
  }
  return {
    id: boundedText(value.id, "ticket id"),
    status: normalizeStatus(value.status, HANDOFF_STATUSES, "ticket"),
    evidence: evidence.map((entry) => boundedText(entry, "ticket evidence")),
  };
}

function normalizeTickets(inputTickets, expectedTickets) {
  if (!Array.isArray(inputTickets)) {
    fail("tickets must be an array");
  }
  if (inputTickets.length !== expectedTickets.length) {
    fail("Handoff ticket set does not match expected tickets");
  }

  const expectedSet = new Set(expectedTickets);
  const byId = new Map();
  for (const entry of inputTickets.map(normalizeTicketEntry)) {
    if (!expectedSet.has(entry.id)) {
      fail("Handoff ticket set does not match expected tickets");
    }
    if (byId.has(entry.id)) {
      fail("Duplicate handoff ticket");
    }
    byId.set(entry.id, entry);
  }

  return expectedTickets.map((id) => {
    const entry = byId.get(id);
    if (!entry) {
      fail("Handoff ticket set does not match expected tickets");
    }
    return entry;
  });
}

function normalizeChangedPath(value) {
  const path = boundedText(value, "changed file path");
  if (path.includes("\\") || isAbsolute(path)) {
    fail("Changed file path must be relative and path-safe");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("Changed file path traversal is not allowed");
  }
  return path;
}

function normalizeChangedFiles(value) {
  if (!Array.isArray(value)) {
    fail("changedFiles must be an array");
  }
  return value.map(normalizeChangedPath);
}

function normalizeRepositoryEntry(value) {
  assertPlainObject(value, "repository");
  return {
    id: boundedText(value.id, "repository id"),
    changedFiles: normalizeChangedFiles(value.changedFiles),
  };
}

function normalizeRepositories(input, expectedRepositories) {
  const expectedIds = expectedRepositories.map((repository) => repository.id);
  const expectedSet = new Set(expectedIds);
  let repositories;

  if (Array.isArray(input.repositories)) {
    if (input.repositories.length !== expectedRepositories.length) {
      fail("Handoff repository set does not match expected repositories");
    }
    const seen = new Set();
    const byId = new Map();
    for (const entry of input.repositories.map(normalizeRepositoryEntry)) {
      if (!expectedSet.has(entry.id)) {
        fail("Unknown repository in handoff");
      }
      if (seen.has(entry.id)) {
        fail("Duplicate handoff repository");
      }
      seen.add(entry.id);
      byId.set(entry.id, entry);
    }
    repositories = expectedIds.map((id) => {
      const entry = byId.get(id);
      if (!entry) {
        fail("Handoff repository set does not match expected repositories");
      }
      return entry;
    });
  } else {
    if (expectedRepositories.length !== 1) {
      fail("repositories are required for multi-repository handoffs");
    }
    repositories = [{ id: expectedRepositories[0].id, changedFiles: normalizeChangedFiles(input.changedFiles) }];
  }

  const changedFileCount = repositories.reduce((count, repository) => count + repository.changedFiles.length, 0);
  if (changedFileCount > HANDOFF_LIMITS.changedFiles) {
    failLimit("changed files");
  }
  return repositories;
}

function normalizeVerificationEntry(value) {
  assertPlainObject(value, "verification entry");
  return {
    command: boundedText(value.command, "verification command"),
    status: normalizeStatus(value.status, VERIFICATION_STATUSES, "verification"),
    summary: boundedText(value.summary, "verification summary"),
  };
}

function normalizeVerification(value) {
  if (!Array.isArray(value)) {
    fail("verification must be an array");
  }
  if (value.length > HANDOFF_LIMITS.verification) {
    failLimit("verification");
  }
  return value.map(normalizeVerificationEntry);
}

export function validateHandoffInput(value, expected = {}) {
  assertPlainObject(value, "handoff input");
  enforceInputByteLimit(value);

  if (value.version !== 1) {
    fail("Handoff version must be 1");
  }

  const expectedTickets = normalizeExpectedTickets(expected.tickets);
  const expectedRepositories = normalizeExpectedRepositories(expected.repositories);
  const normalized = {
    version: 1,
    status: normalizeStatus(value.status, HANDOFF_STATUSES, "handoff"),
    summary: boundedText(value.summary, "summary", HANDOFF_LIMITS.summary),
    tickets: normalizeTickets(value.tickets, expectedTickets),
    repositories: normalizeRepositories(value, expectedRepositories),
    verification: normalizeVerification(value.verification),
    decisions: optionalTextArray(value.decisions, "decisions"),
    concerns: optionalTextArray(value.concerns, "concerns"),
    nextAction: boundedText(value.nextAction, "nextAction"),
  };

  if (expected.runId !== undefined) {
    normalized.runId = boundedText(String(expected.runId), "run ID");
  }
  if (expected.generation !== undefined) {
    normalized.generation = normalizeGeneration(expected.generation);
  }

  return normalized;
}

function ticketsFromRun(run) {
  if (Array.isArray(run.tickets) && run.tickets.length > 0) {
    return run.tickets;
  }
  return [run.primaryTicket, ...(Array.isArray(run.relatedTickets) ? run.relatedTickets : [])].filter(Boolean);
}

function repositoriesFromRun(run) {
  if (Array.isArray(run.repositories) && run.repositories.length > 0) {
    return normalizeExpectedRepositories(run.repositories).map((repository) => {
      if (!repository.cwd) {
        fail("Run repository path is required");
      }
      return repository;
    });
  }

  const cwd = run.repositoryPath ?? run.worktreePath ?? run.checkoutPath ?? run.path;
  if (!cwd) {
    fail("Run repositories are required");
  }
  return [{
    id: boundedText(String(run.repositoryAlias ?? run.projectAlias ?? "repository"), "repository id"),
    cwd: boundedText(String(cwd), "repository path"),
  }];
}

function expectedFromRun(run) {
  assertPlainObject(run, "run");
  return {
    runId: run.id,
    generation: normalizeGeneration(run.generation ?? 1),
    tickets: normalizeExpectedTickets(ticketsFromRun(run)),
    repositories: repositoriesFromRun(run),
  };
}

function assertSameExpectations(left, right) {
  if (left.generation !== right.generation) {
    fail("Handoff generation is not current");
  }
  if (JSON.stringify(left.tickets) !== JSON.stringify(right.tickets)) {
    fail("Run ticket expectations changed during handoff");
  }
  if (JSON.stringify(left.repositories.map(({ id }) => id)) !== JSON.stringify(right.repositories.map(({ id }) => id))) {
    fail("Run repository expectations changed during handoff");
  }
}

function assertRunAcceptsHandoff(run) {
  if (!HANDOFF_ACCEPTING_STATES.has(run.state)) {
    fail("Run state cannot accept a structured handoff");
  }
}

async function fingerprintRepositories(git, repositories) {
  if (!git || typeof git.fingerprint !== "function") {
    fail("Git fingerprint interface is required");
  }
  const fingerprints = new Map();
  for (const repository of repositories) {
    fingerprints.set(repository.id, await git.fingerprint({ cwd: repository.cwd }));
  }
  return fingerprints;
}

function canonicalResult(normalized, repositories, fingerprints) {
  const changedById = new Map(normalized.repositories.map((repository) => [repository.id, repository.changedFiles]));
  return {
    version: 1,
    runId: normalized.runId,
    generation: normalized.generation,
    status: normalized.status,
    summary: normalized.summary,
    tickets: normalized.tickets,
    repositories: repositories.map((repository) => {
      const fingerprint = fingerprints.get(repository.id);
      return {
        id: repository.id,
        head: fingerprint.head,
        branch: fingerprint.branch,
        dirty: fingerprint.dirty,
        entries: fingerprint.entries,
        worktreeFingerprint: fingerprint.digest,
        changedFiles: changedById.get(repository.id) ?? [],
      };
    }),
    verification: normalized.verification,
    decisions: normalized.decisions,
    concerns: normalized.concerns,
    nextAction: normalized.nextAction,
  };
}

function sanitizeFsCode(error) {
  return typeof error?.code === "string" ? error.code : "FS_ERROR";
}

function throwFs(action, path, error) {
  fail(`Unable to ${action} at ${path} (${sanitizeFsCode(error)})`);
}

async function chmodPath(fs, path, mode, context, { missingOk = false } = {}) {
  try {
    await fs.chmod(path, mode);
    return true;
  } catch (error) {
    if (missingOk && error?.code === "ENOENT") return false;
    throwFs(`set private mode on ${context}`, path, error);
  }
}

async function ensurePrivateDirectory(fs, directory) {
  try {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    throwFs("create result directory", directory, error);
  }
  await chmodPath(fs, directory, PRIVATE_DIR_MODE, "result directory");
}

async function writeAtomicText(fs, directory, filename, text) {
  tempCounter += 1;
  const destination = join(directory, filename);
  const tempPath = join(directory, `.${filename}.${process.pid}.${tempCounter}.tmp`);
  await chmodPath(fs, destination, PRIVATE_FILE_MODE, filename, { missingOk: true });
  await chmodPath(fs, tempPath, PRIVATE_FILE_MODE, "temporary result file", { missingOk: true });

  let handle;
  try {
    handle = await fs.open(tempPath, "w", PRIVATE_FILE_MODE);
  } catch (error) {
    throwFs("open temporary result file", tempPath, error);
  }

  let writeError;
  try {
    await chmodPath(fs, tempPath, PRIVATE_FILE_MODE, "temporary result file");
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
    throwFs("write temporary result file", tempPath, writeError);
  }

  try {
    await fs.rename(tempPath, destination);
  } catch (error) {
    throwFs("rename temporary result file", destination, error);
  }
  await chmodPath(fs, destination, PRIVATE_FILE_MODE, filename);
}

async function writeResultArtifacts(directory, result, text = canonicalResultText(result), fs = defaultFs) {
  await writeAtomicText(fs, directory, RESULT_FILE, text);
  const archiveDirectory = join(directory, ARCHIVE_DIR);
  await ensurePrivateDirectory(fs, archiveDirectory);
  await writeAtomicText(fs, archiveDirectory, `generation-${result.generation}.json`, text);
}

function resultPaths(directory, generation) {
  return {
    resultPath: join(directory, RESULT_FILE),
    archivePath: join(directory, ARCHIVE_DIR, `generation-${generation}.json`),
  };
}

export async function submitHandoff({ store, git, runId, generation, input } = {}) {
  if (!store || typeof store.read !== "function" || typeof store.update !== "function") {
    fail("Run store interface is required");
  }

  const run = await store.read(runId);
  const expected = expectedFromRun(run);
  assertRunAcceptsHandoff(run);
  const handoffGeneration = normalizeGeneration(generation);
  if (handoffGeneration !== expected.generation) {
    fail("Handoff generation is not current");
  }

  const normalized = validateHandoffInput(input, expected);
  const fingerprints = await fingerprintRepositories(git, expected.repositories);
  const result = canonicalResult(normalized, expected.repositories, fingerprints);
  const resultText = canonicalResultText(result);
  const resultArtifactDigest = sha256Digest(resultText);

  await store.update(runId, async (current) => {
    const currentExpected = expectedFromRun(current);
    assertSameExpectations(expected, currentExpected);
    assertRunAcceptsHandoff(current);
    await writeResultArtifacts(current.directory, result, resultText);
    const paths = resultPaths(current.directory, result.generation);
    return {
      state: STATUS_TO_RUN_STATE[result.status],
      resultGeneration: result.generation,
      resultStatus: result.status,
      resultPath: paths.resultPath,
      resultArchivePath: paths.archivePath,
      resultArtifactDigest,
      resultFingerprints: Object.fromEntries(result.repositories.map((repository) => [
        repository.id,
        repository.worktreeFingerprint,
      ])),
    };
  });

  return result;
}

async function readResultFile(directory, fs = defaultFs) {
  const path = join(directory, RESULT_FILE);
  await chmodPath(fs, path, PRIVATE_FILE_MODE, RESULT_FILE, { missingOk: true });
  let bytes;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { missing: true };
    throwFs("read current result", path, error);
  }

  const artifactDigest = sha256Digest(bytes);
  try {
    return { result: JSON.parse(bytes.toString("utf8")), artifactDigest };
  } catch (_error) {
    return { invalid: true, artifactDigest };
  }
}

function collectResultShapeErrors(result, expected, run, artifactDigest) {
  const errors = [];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return ["Current result is not a valid object"];
  }
  if (result.version !== 1) errors.push("Current result has an invalid version");
  if (result.runId !== expected.runId) errors.push("Current result run ID is stale");
  if (result.generation !== expected.generation) errors.push("Current result generation is stale");
  if (!HANDOFF_STATUSES.has(result.status)) errors.push("Current result status is invalid");

  const expectedTickets = expected.tickets;
  const resultTicketIds = Array.isArray(result.tickets) ? result.tickets.map((ticket) => ticket?.id) : [];
  if (JSON.stringify(resultTicketIds) !== JSON.stringify(expectedTickets)) {
    errors.push("Current result ticket set is stale");
  }

  const expectedRepositoryIds = expected.repositories.map((repository) => repository.id);
  const resultRepositoryIds = Array.isArray(result.repositories) ? result.repositories.map((repository) => repository?.id) : [];
  if (JSON.stringify(resultRepositoryIds) !== JSON.stringify(expectedRepositoryIds)) {
    errors.push("Current result repository set is stale");
  }

  const registeredFingerprints = run.resultFingerprints;
  const registeredArtifactDigest = typeof run.resultArtifactDigest === "string" ? run.resultArtifactDigest.trim() : "";
  const registered = run.resultGeneration === result.generation
    && run.resultStatus === result.status
    && registeredArtifactDigest
    && registeredFingerprints !== null
    && typeof registeredFingerprints === "object"
    && !Array.isArray(registeredFingerprints);
  if (!registered) {
    errors.push("Current result is not registered in the run store");
  } else {
    if (registeredArtifactDigest !== artifactDigest) {
      errors.push("Current result artifact digest is stale");
    }
    if (Array.isArray(result.repositories)) {
      for (const repository of result.repositories) {
        if (registeredFingerprints[repository.id] !== repository.worktreeFingerprint) {
          errors.push("Current result fingerprint registration is stale");
          break;
        }
      }
    }
  }

  return errors;
}

async function markResultStale(store, runId) {
  if (!store || typeof store.update !== "function") {
    fail("Run store update interface is required to mark stale results");
  }
  const resultStaleAt = new Date().toISOString();
  await store.update(runId, (current) => {
    if (current.state === RUN_STATES.RESULT_STALE) {
      return { resultStaleAt };
    }
    return {
      state: RUN_STATES.RESULT_STALE,
      resultStaleAt,
    };
  });
}

async function returnResultStale(store, runId, result, errors) {
  await markResultStale(store, runId);
  const response = { status: RUN_STATES.RESULT_STALE, errors };
  if (result !== undefined) response.result = result;
  return response;
}

export async function readCurrentResult({ store, git, runId } = {}) {
  if (!store || typeof store.read !== "function") {
    fail("Run store interface is required");
  }

  const run = await store.read(runId);
  const current = await readResultFile(run.directory);
  if (current.missing) {
    return returnResultStale(store, runId, undefined, ["No current result"]);
  }
  if (current.invalid) {
    return returnResultStale(store, runId, undefined, ["Current result is invalid"]);
  }

  const expected = expectedFromRun(run);
  const result = current.result;
  const errors = collectResultShapeErrors(result, expected, run, current.artifactDigest);
  if (run.state === RUN_STATES.RESULT_STALE) {
    errors.push("Current result was already marked stale");
  }

  if (errors.length === 0) {
    const fingerprints = await fingerprintRepositories(git, expected.repositories);
    const byId = new Map(result.repositories.map((repository) => [repository.id, repository]));
    for (const repository of expected.repositories) {
      const currentFingerprint = fingerprints.get(repository.id);
      const resultRepository = byId.get(repository.id);
      if (resultRepository?.worktreeFingerprint !== currentFingerprint.digest) {
        errors.push("Git fingerprint differs from current worktree state");
        break;
      }
    }
  }

  if (errors.length > 0) {
    return returnResultStale(store, runId, result, errors);
  }

  return { status: result.status, result };
}
