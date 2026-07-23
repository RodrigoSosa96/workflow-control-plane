import * as defaultFs from "node:fs/promises";
import { join } from "node:path";
import {
  applyTelemetryEvent,
  assertTelemetrySnapshot,
  createTelemetrySnapshot,
  TELEMETRY_HARNESSES,
  TELEMETRY_PHASES,
} from "./telemetry.js";
import { WorkflowError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TELEMETRY_EVENT_LIMIT = 100;
const JOURNAL_EVENT_FIELDS = new Set(["version", "type", "workerId", "harness", "phase", "observability", "at"]);
const OBSERVABILITY_VALUES = new Set(["reported", "not-reported", "unknown"]);

function fail(message) {
  throw new WorkflowError("telemetry", message);
}

function timestamp(clock) {
  const value = typeof clock === "function" ? clock() : new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  fail("Telemetry clock returned an invalid timestamp");
}

function workerId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("Invalid telemetry worker ID");
  return value.toLowerCase();
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function telemetryPath(id) {
  return `telemetry/workers/${id}.json`;
}

function eventRecord(snapshot) {
  return {
    version: 1,
    type: "telemetry",
    workerId: snapshot.workerId,
    harness: snapshot.harness,
    phase: snapshot.phase,
    observability: snapshot.observability,
    at: snapshot.updatedAt,
  };
}

function parseSnapshot(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    fail("Malformed telemetry snapshot");
  }
  try {
    return assertTelemetrySnapshot(value);
  } catch (_error) {
    fail("Invalid telemetry snapshot");
  }
}

function parseEventJournal(text) {
  if (!text) return [];
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (_error) {
      fail("Malformed telemetry event journal");
    }
    if (!plainObject(value) || value.version !== 1 || value.type !== "telemetry") {
      fail("Invalid telemetry event journal");
    }
    for (const key of Object.keys(value)) {
      if (!JOURNAL_EVENT_FIELDS.has(key)) fail("Invalid telemetry event journal");
    }
    workerId(value.workerId);
    if (!TELEMETRY_HARNESSES.has(value.harness) || !TELEMETRY_PHASES.has(value.phase)) {
      fail("Invalid telemetry event journal");
    }
    if (!OBSERVABILITY_VALUES.has(value.observability) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) {
      fail("Invalid telemetry event journal");
    }
    entries.push(value);
  }
  return entries;
}

export function createTelemetryStore({ store, clock, fs = defaultFs } = {}) {
  if (!store || typeof store.read !== "function" || typeof store.writePrivateFile !== "function" || typeof store.appendEvent !== "function") {
    fail("Telemetry store requires a run store");
  }
  if (clock !== undefined && typeof clock !== "function") fail("Telemetry clock must be a function");
  let queue = Promise.resolve();

  function enqueue(operation) {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  async function readPrivateText(path) {
    try {
      await fs.chmod(path, 0o600);
      return await fs.readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      fail("Unable to read telemetry artifact");
    }
  }

  async function readSnapshot(run, id) {
    const text = await readPrivateText(join(run.directory, telemetryPath(id)));
    if (text === null) return null;
    const snapshot = parseSnapshot(text);
    if (snapshot.runId !== run.id || snapshot.workerId !== id) fail("Telemetry snapshot identity does not match run");
    return snapshot;
  }

  async function readJournal(run) {
    const text = await readPrivateText(join(run.directory, "telemetry/events.jsonl"));
    return text === null ? [] : parseEventJournal(text);
  }

  async function record({ runId, workerId: requestedWorkerId, event } = {}) {
    const id = workerId(requestedWorkerId);
    return enqueue(async () => {
      const run = await store.read(runId);
      const current = await readSnapshot(run, id);
      const previousJournal = await readJournal(run);
      if (typeof run.harness !== "string" || typeof run.profileName !== "string") {
        fail("Run does not contain telemetry worker identity");
      }
      if (current && current.harness !== event?.harness) fail("Telemetry event harness does not match worker");
      if (run.harness !== event?.harness) fail("Telemetry event harness does not match run");
      const recordedAt = event?.at ?? timestamp(clock);
      const timedEvent = event?.at ? event : { ...event, at: recordedAt };
      const next = applyTelemetryEvent(
        current ?? createTelemetrySnapshot({
          runId: run.id,
          workerId: id,
          harness: run.harness,
          profileName: run.profileName,
          startedAt: recordedAt,
        }),
        timedEvent,
      );
      const index = {
        harness: next.harness,
        profileName: next.profileName,
        phase: next.phase,
        observability: next.observability,
        updatedAt: next.updatedAt,
      };
      await store.writePrivateFile(run.id, {
        relativePath: telemetryPath(id),
        text: `${JSON.stringify(next)}\n`,
        updater: (storedRun) => {
          const telemetry = storedRun.telemetry === undefined ? {} : storedRun.telemetry;
          if (!plainObject(telemetry) || (telemetry.workers !== undefined && !plainObject(telemetry.workers))) {
            fail("Invalid telemetry run index");
          }
          return {
            telemetry: {
              version: 1,
              ...telemetry,
              workers: { ...(telemetry.workers ?? {}), [id]: index },
            },
          };
        },
      });
      const journal = [...previousJournal, eventRecord(next)].slice(-TELEMETRY_EVENT_LIMIT);
      await store.writePrivateFile(run.id, {
        relativePath: "telemetry/events.jsonl",
        text: journal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
        updater: () => ({}),
      });
      await store.appendEvent(run.id, eventRecord(next));
      return next;
    });
  }

  async function read({ runId, workerId: requestedWorkerId } = {}) {
    const run = await store.read(runId);
    const requestedId = requestedWorkerId === undefined ? null : workerId(requestedWorkerId);
    const indexedWorkers = plainObject(run.telemetry?.workers) ? Object.keys(run.telemetry.workers) : [];
    const ids = requestedId ? [requestedId] : indexedWorkers.map(workerId);
    const snapshots = [];
    for (const id of ids) {
      const snapshot = await readSnapshot(run, id);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots.sort((left, right) => left.workerId.localeCompare(right.workerId));
  }

  return Object.freeze({ record, read });
}
