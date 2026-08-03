import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { MUTEX_RETRY_BUDGET_MS } from "../src/workflow/bounded-retry.js";
import { RUN_STATES, transitionRun } from "../src/workflow/run-state.js";
import { createRunStore } from "../src/workflow/run-store.js";

const RUN_ID_1 = "11111111-1111-4111-8111-111111111111";
const RUN_ID_2 = "22222222-2222-4222-8222-222222222222";
const RUN_ID_3 = "33333333-3333-4333-8333-333333333333";
const EVENT_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOCK_OWNER_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-run-store-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function clockSequence(...values) {
  let index = 0;
  return {
    now() {
      return values[index++] ?? values.at(-1);
    },
  };
}

async function fileMode(path) {
  return (await stat(path)).mode & 0o777;
}

async function assertNoPath(path) {
  await assert.rejects(
    () => stat(path),
    (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR",
  );
}

function tracingFs(operations) {
  return {
    ...realFs,
    async open(path, flags, mode) {
      operations.push({ op: "open", path, flags, mode });
      const handle = await realFs.open(path, flags, mode);
      return {
        async writeFile(data, options) {
          operations.push({ op: "writeFile", path, bytes: Buffer.byteLength(String(data)) });
          return handle.writeFile(data, options);
        },
        async appendFile(data, options) {
          operations.push({ op: "appendFile", path, bytes: Buffer.byteLength(String(data)) });
          return handle.appendFile(data, options);
        },
        async sync() {
          operations.push({ op: "sync", path });
          return handle.sync();
        },
        async close() {
          operations.push({ op: "close", path });
          return handle.close();
        },
      };
    },
    async rename(from, to) {
      operations.push({ op: "rename", from, to });
      return realFs.rename(from, to);
    },
  };
}

function plannedInput(overrides = {}) {
  return {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    relatedTickets: [],
    state: RUN_STATES.PLANNED,
    ...overrides,
  };
}

test("creates private run directories and files", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
  });

  const run = await store.create(plannedInput());

  assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(run.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(run.directory, "run.json"))).mode & 0o777, 0o600);
  assert.equal(run.id, RUN_ID_1);
});

test("tightens preexisting state and run directory modes", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const runDirectory = join(stateRoot, RUN_ID_1);
  await mkdir(runDirectory, { recursive: true, mode: 0o755 });
  await chmod(stateRoot, 0o755);
  await chmod(runDirectory, 0o755);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
  });

  await store.create(plannedInput());

  assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
});

test("rejects invalid and path-traversing run IDs", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });

  await assert.rejects(
    () => createRunStore({ stateRoot, randomUUID: () => "../escape" }).create(plannedInput()),
    /run id/i,
  );
  await assert.rejects(() => store.read("../escape"), /run id/i);
  await assert.rejects(() => store.update("nested/run", (run) => run), /run id/i);
  await assert.rejects(() => store.appendEvent("", { type: "launch.output" }), /run id/i);
  await assert.rejects(() => store.writeAssignment("not-a-uuid", "text"), /run id/i);
});

test("rejects duplicate create without overwriting the original", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });

  const original = await store.create(plannedInput({ primaryTicket: "A-1" }));

  await assert.rejects(
    () => store.create(plannedInput({ primaryTicket: "A-2" })),
    /duplicate|already exists/i,
  );
  assert.equal((await store.read(RUN_ID_1)).primaryTicket, original.primaryTicket);
});

test("rejects malformed run JSON without leaking the raw payload", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot });
  const runDirectory = join(stateRoot, RUN_ID_1);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(runDirectory, "run.json"),
    `{"id":"${RUN_ID_1}","secret":"DO-NOT-LEAK"`,
    { mode: 0o600 },
  );

  await assert.rejects(
    () => store.read(RUN_ID_1),
    (error) => {
      assert.match(error.message, /malformed|invalid json|parse/i);
      assert.doesNotMatch(error.message, /DO-NOT-LEAK/);
      assert.ok(error.message.length < 300);
      return true;
    },
  );
});

test("transitionRun enforces the closed state machine and records timestamped history", () => {
  const run = {
    id: RUN_ID_1,
    state: RUN_STATES.PLANNED,
    stateHistory: [{ from: null, to: RUN_STATES.PLANNED, at: "2025-01-01T00:00:00.000Z" }],
    updatedAt: "2025-01-01T00:00:00.000Z",
  };

  const launching = transitionRun(run, RUN_STATES.LAUNCHING, {
    updatedAt: "2025-01-01T00:01:00.000Z",
    agentSessionId: "pi:ocr-A-1",
  });

  assert.equal(launching.state, RUN_STATES.LAUNCHING);
  assert.equal(launching.agentSessionId, "pi:ocr-A-1");
  assert.deepEqual(launching.stateHistory, [
    { from: null, to: RUN_STATES.PLANNED, at: "2025-01-01T00:00:00.000Z" },
    { from: RUN_STATES.PLANNED, to: RUN_STATES.LAUNCHING, at: "2025-01-01T00:01:00.000Z" },
  ]);
  assert.equal(run.state, RUN_STATES.PLANNED);
  assert.equal(run.stateHistory.length, 1);

  assert.throws(() => transitionRun(run, RUN_STATES.COMPLETED, { updatedAt: "2025-01-01T00:02:00.000Z" }), /transition/i);
  assert.throws(() => transitionRun(run, RUN_STATES.PLANNED, { updatedAt: "2025-01-01T00:02:00.000Z" }), /transition/i);
  assert.throws(
    () => transitionRun({ ...run, state: "mystery" }, RUN_STATES.RUNNING, { updatedAt: "2025-01-01T00:02:00.000Z" }),
    /state/i,
  );
});

test("transitionRun accepts an omitted patch and still timestamps history", () => {
  const run = {
    id: RUN_ID_1,
    state: RUN_STATES.PLANNED,
    stateHistory: [{ from: null, to: RUN_STATES.PLANNED, at: "2025-01-01T00:00:00.000Z" }],
    updatedAt: "2025-01-01T00:00:00.000Z",
  };

  const launching = transitionRun(run, RUN_STATES.LAUNCHING);

  assert.equal(launching.state, RUN_STATES.LAUNCHING);
  assert.equal(launching.stateHistory.at(-1).from, RUN_STATES.PLANNED);
  assert.equal(launching.stateHistory.at(-1).to, RUN_STATES.LAUNCHING);
  assert.ok(Number.isFinite(Date.parse(launching.stateHistory.at(-1).at)));
});

test("transitionRun permits needs-input and failed runs to become result-stale", () => {
  for (const state of [RUN_STATES.NEEDS_INPUT, RUN_STATES.FAILED]) {
    const run = {
      id: RUN_ID_1,
      state,
      stateHistory: [{ from: RUN_STATES.RUNNING, to: state, at: "2025-01-01T00:00:00.000Z" }],
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    const stale = transitionRun(run, RUN_STATES.RESULT_STALE, {
      updatedAt: "2025-01-01T00:01:00.000Z",
      resultStaleAt: "2025-01-01T00:01:00.000Z",
    });

    assert.equal(stale.state, RUN_STATES.RESULT_STALE);
    assert.equal(stale.resultStaleAt, "2025-01-01T00:01:00.000Z");
    assert.deepEqual(stale.stateHistory.at(-1), {
      from: state,
      to: RUN_STATES.RESULT_STALE,
      at: "2025-01-01T00:01:00.000Z",
    });
  }
});

test("update preserves the original when the updater throws or requests an illegal transition", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });
  const original = await store.create(plannedInput());

  await assert.rejects(() => store.update(RUN_ID_1, () => {
    throw new Error("updater exploded");
  }), /updater exploded/);
  assert.deepEqual(await store.read(RUN_ID_1), original);

  await assert.rejects(() => store.update(RUN_ID_1, () => ({ state: RUN_STATES.COMPLETED })), /transition/i);
  assert.deepEqual(await store.read(RUN_ID_1), original);
});

test("persists run updates through a sibling temp file that is fsynced before rename", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const operations = [];
  const store = createRunStore({
    stateRoot,
    fs: tracingFs(operations),
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });
  const run = await store.create(plannedInput());
  operations.length = 0;

  const updated = await store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING }));

  assert.equal(updated.state, RUN_STATES.LAUNCHING);
  const destination = join(run.directory, "run.json");
  const rename = operations.find((operation) => operation.op === "rename" && operation.to === destination);
  assert.ok(rename, "expected run.json to be installed with rename");
  assert.equal(dirname(rename.from), dirname(rename.to));
  assert.match(basename(rename.from), /^\.run\.json\..+\.tmp$/);

  const tempOpen = operations.find((operation) => operation.op === "open" && operation.path === rename.from);
  assert.equal(tempOpen.flags, "w");
  assert.equal(tempOpen.mode, 0o600);
  const syncIndex = operations.findIndex((operation) => operation.op === "sync" && operation.path === rename.from);
  const renameIndex = operations.indexOf(rename);
  assert.ok(syncIndex >= 0 && syncIndex < renameIndex, "expected fsync before rename");
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test("creates a permanent private lock container and scoped active owner marker", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });

  const run = await store.create(plannedInput());
  const lockContainer = join(run.directory, "run.lock");
  const lockContainerStat = await stat(lockContainer);
  assert.equal(lockContainerStat.isDirectory(), true);
  assert.equal(lockContainerStat.mode & 0o777, 0o700);
  await assertNoPath(join(lockContainer, "active"));

  let observedMarkerName;
  await store.update(RUN_ID_1, async (current) => {
    const activePath = join(current.directory, "run.lock", "active");
    const activeStat = await stat(activePath);
    assert.equal(activeStat.isDirectory(), true);
    assert.equal(activeStat.mode & 0o777, 0o700);
    const markers = await realFs.readdir(activePath);
    assert.equal(markers.length, 1);
    [observedMarkerName] = markers;
    assert.match(observedMarkerName, LOCK_OWNER_TOKEN_RE);
    assert.doesNotMatch(observedMarkerName, /[\\/]/);
    const markerPath = join(activePath, observedMarkerName);
    assert.equal(await fileMode(markerPath), 0o600);
    const markerContent = await readFile(markerPath, "utf8");
    assert.ok(markerContent.length <= 256);
    assert.doesNotMatch(markerContent, /projectAlias|primaryTicket|relatedTickets|Implement OCR/);
    return { state: RUN_STATES.LAUNCHING };
  });

  assert.ok(observedMarkerName);
  await assertNoPath(join(lockContainer, "active"));
  assert.deepEqual(await realFs.readdir(lockContainer), []);
});

test("acquired lock marker is version 2 and carries pid, startedAt, and runId at mode 0600", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    readOwnOwnership: async () => ({ pid: "4242", startedAt: "2024-12-31T00:00:00.000Z" }),
  });
  const run = await store.create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");

  let marker;
  let markerMode;
  await store.update(RUN_ID_1, async () => {
    const [markerName] = await realFs.readdir(activePath);
    const markerPath = join(activePath, markerName);
    markerMode = await fileMode(markerPath);
    marker = JSON.parse(await readFile(markerPath, "utf8"));
    return { state: RUN_STATES.LAUNCHING };
  });

  assert.equal(markerMode, 0o600);
  assert.equal(marker.version, 2);
  assert.equal(marker.runId, RUN_ID_1);
  assert.equal(marker.pid, "4242");
  assert.equal(marker.startedAt, "2024-12-31T00:00:00.000Z");
  assert.match(marker.token, LOCK_OWNER_TOKEN_RE);
});

test("a readOwnOwnership that throws still permits acquisition and yields a marker without pid or startedAt", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    readOwnOwnership: async () => {
      throw new Error("ps failed");
    },
  });
  const run = await store.create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");

  let marker;
  const updated = await store.update(RUN_ID_1, async () => {
    const [markerName] = await realFs.readdir(activePath);
    marker = JSON.parse(await readFile(join(activePath, markerName), "utf8"));
    return { state: RUN_STATES.LAUNCHING };
  });

  assert.equal(updated.state, RUN_STATES.LAUNCHING, "a throwing readOwnOwnership must not block acquisition");
  assert.equal(marker.version, 2);
  assert.equal(marker.runId, RUN_ID_1);
  assert.equal("pid" in marker, false);
  assert.equal("startedAt" in marker, false);
});

test("reports bounded active lock contention with injected clock without deleting it", async (t) => {
  const stateRoot = await tempStateRoot(t);
  // A stale lock (crash residue) must fail fast into `workflow unlock` recovery rather than
  // waiting out acquireLockWithRetry's bounded retry budget -- that discrimination lives in
  // shouldRetry: (error) => error?.details?.stale === false. Inject a fake wall clock (sleep
  // advances retryNow, per bounded-retry.js's doc comment) so a regression that retries a stale
  // lock anyway shows up as a non-empty `sleeps` instead of hanging the test until a real
  // 2-second budget elapses.
  const sleeps = [];
  let elapsedMs = 0;
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:10:00.000Z"),
    retryNow: () => elapsedMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      elapsedMs += ms;
    },
  });
  const run = await store.create(plannedInput());
  const lockContainer = join(run.directory, "run.lock");
  const activePath = join(lockContainer, "active");
  const markerPath = join(activePath, "foreign-owner-marker");
  const markerContent = "foreign owner DO-NOT-LEAK";
  await mkdir(activePath, { recursive: true, mode: 0o755 });
  await chmod(lockContainer, 0o755);
  await chmod(activePath, 0o755);
  await writeFile(markerPath, markerContent, { mode: 0o600 });
  const staleTime = new Date("2025-01-01T00:00:00.000Z");
  await utimes(activePath, staleTime, staleTime);

  await assert.rejects(
    () => store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING })),
    (error) => {
      assert.match(error.message, /lock/i);
      assert.match(error.message, /active/i);
      assert.match(error.message, /stale/i);
      assert.match(error.message, /10m/);
      assert.ok(error.message.includes(activePath));
      assert.equal(error.details?.ageMs, 10 * 60 * 1000);
      assert.equal(error.details?.stale, true);
      assert.ok(error.message.length < 500);
      assert.doesNotMatch(error.message, /DO-NOT-LEAK|foreign owner|projectAlias|primaryTicket|relatedTickets/);
      return true;
    },
  );
  assert.equal(await readFile(markerPath, "utf8"), markerContent);
  assert.equal(await fileMode(lockContainer), 0o700);
  assert.equal(await fileMode(activePath), 0o700);
  assert.equal(sleeps.length, 0, "a stale lock must never be retried -- it must fail fast, not wait out the bounded retry budget");
});

test("treats a legacy fixed-file lock as a manual-recovery conflict", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:10:00.000Z"),
  });
  const run = await store.create(plannedInput());
  const lockContainer = join(run.directory, "run.lock");
  const legacyContent = "legacy fixed-file owner DO-NOT-LEAK";
  await realFs.rm(lockContainer, { recursive: true, force: true });
  await writeFile(lockContainer, legacyContent, { mode: 0o600 });
  await chmod(lockContainer, 0o666);

  await assert.rejects(
    () => store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING })),
    (error) => {
      assert.match(error.message, /legacy|container/i);
      assert.match(error.message, /manual/i);
      assert.ok(error.message.includes(lockContainer));
      assert.ok(error.message.length < 500);
      assert.doesNotMatch(error.message, /DO-NOT-LEAK|legacy fixed-file owner/);
      return true;
    },
  );
  assert.equal(await readFile(lockContainer, "utf8"), legacyContent);
  assert.equal(await fileMode(lockContainer), 0o600);
  await assertNoPath(join(lockContainer, "active"));
});

test("read and list tighten preexisting private modes without recreating runs", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
  });
  const run = await store.create(plannedInput());
  const runPath = join(run.directory, "run.json");

  await chmod(stateRoot, 0o755);
  await chmod(run.directory, 0o755);
  await chmod(runPath, 0o644);

  await store.read(RUN_ID_1);

  assert.equal(await fileMode(stateRoot), 0o700);
  assert.equal(await fileMode(run.directory), 0o700);
  assert.equal(await fileMode(runPath), 0o600);

  await chmod(stateRoot, 0o755);
  await chmod(run.directory, 0o755);
  await chmod(runPath, 0o644);

  const listed = await store.list({});

  assert.deepEqual(listed.map((listedRun) => listedRun.id), [RUN_ID_1]);
  assert.equal(await fileMode(stateRoot), 0o700);
  assert.equal(await fileMode(run.directory), 0o700);
  assert.equal(await fileMode(runPath), 0o600);
});

test("update tightens preexisting private modes and a reused temporary run file", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });
  const run = await store.create(plannedInput());
  const runPath = join(run.directory, "run.json");
  const reusedTempPath = join(run.directory, `.run.json.${process.pid}.2.tmp`);
  await writeFile(reusedTempPath, "stale temporary content", { mode: 0o600 });
  await chmod(stateRoot, 0o755);
  await chmod(run.directory, 0o755);
  await chmod(runPath, 0o644);
  await chmod(reusedTempPath, 0o666);

  await store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING }));

  assert.equal(await fileMode(stateRoot), 0o700);
  assert.equal(await fileMode(run.directory), 0o700);
  assert.equal(await fileMode(runPath), 0o600);
});

test("appendEvent tightens a permissive preexisting events file", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: uuidSequence(RUN_ID_1, EVENT_ID_1),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });
  const run = await store.create(plannedInput());
  const eventsPath = join(run.directory, "events.jsonl");
  await writeFile(eventsPath, "", { mode: 0o600 });
  await chmod(eventsPath, 0o666);

  await store.appendEvent(RUN_ID_1, { type: "launch.output" });

  assert.equal(await fileMode(eventsPath), 0o600);
});

test("writeAssignment tightens a preexisting assignment before a failed atomic overwrite", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });
  const run = await store.create(plannedInput());
  await store.writeAssignment(RUN_ID_1, "original assignment\n");
  const assignmentPath = join(run.directory, "assignment.md");
  await chmod(assignmentPath, 0o666);

  const failingStore = createRunStore({
    stateRoot,
    fs: {
      ...realFs,
      async rename(from, to) {
        if (to === assignmentPath) {
          const error = new Error("forced assignment rename failure");
          error.code = "EIO";
          throw error;
        }
        return realFs.rename(from, to);
      },
    },
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:02:00.000Z"),
  });

  await assert.rejects(
    () => failingStore.writeAssignment(RUN_ID_1, "new assignment\n"),
    /rename temporary file|EIO/,
  );
  assert.equal(await readFile(assignmentPath, "utf8"), "original assignment\n");
  assert.equal(await fileMode(assignmentPath), 0o600);
});

test("release does not unlink a replacement active directory with a different owner marker", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });
  const run = await store.create(plannedInput());
  const lockContainer = join(run.directory, "run.lock");
  const activePath = join(lockContainer, "active");
  const replacementMarker = join(activePath, "replacement-owner-marker");
  const replacementContent = "replacement owner DO-NOT-LEAK";

  await assert.rejects(
    () => store.update(RUN_ID_1, async () => {
      const markers = await realFs.readdir(activePath);
      assert.equal(markers.length, 1);
      await realFs.unlink(join(activePath, markers[0]));
      await realFs.rmdir(activePath);
      await mkdir(activePath, { mode: 0o700 });
      await writeFile(replacementMarker, replacementContent, { mode: 0o600 });
      throw new Error("updater exploded");
    }),
    (error) => {
      assert.match(error.message, /lock ownership|active lock/i);
      assert.ok(error.message.includes(activePath));
      assert.ok(error.message.length < 500);
      assert.doesNotMatch(error.message, /DO-NOT-LEAK|replacement owner|updater exploded/);
      return true;
    },
  );
  assert.equal(await readFile(replacementMarker, "utf8"), replacementContent);
  assert.equal(await fileMode(lockContainer), 0o700);
  assert.equal(await fileMode(activePath), 0o700);
  assert.equal(await fileMode(replacementMarker), 0o600);
});

test("appendEvent appends private JSONL entries with store-assigned unique IDs", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: uuidSequence(RUN_ID_1, EVENT_ID_1, EVENT_ID_2),
    clock: clockSequence(
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:01:00.000Z",
      "2025-01-01T00:02:00.000Z",
    ),
  });
  const run = await store.create(plannedInput());

  const first = await store.appendEvent(RUN_ID_1, { id: "client-supplied", type: "launch.output", payload: { line: 1 } });
  const second = await store.appendEvent(RUN_ID_1, { type: "launch.output", payload: { line: 2 } });

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, "client-supplied");
  const eventsPath = join(run.directory, "events.jsonl");
  const lines = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(({ version, type, runId }) => ({ version, type, runId })), [
    { version: 1, type: "launch.output", runId: RUN_ID_1 },
    { version: 1, type: "launch.output", runId: RUN_ID_1 },
  ]);
  assert.deepEqual(lines.map((event) => event.id), [first.id, second.id]);
  assert.ok(lines.every((event) => typeof event.timestamp === "string" && event.timestamp.length > 0));
  assert.equal((await stat(eventsPath)).mode & 0o777, 0o600);
});

test("writes a nested private artifact and updates the run under one run lock", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
  });
  const run = await store.create(plannedInput());
  const relativePath = `delegations/${RUN_ID_2}/brief.md`;

  const written = await store.writePrivateFile(RUN_ID_1, {
    relativePath,
    text: "frozen brief only",
    updater: (current) => {
      assert.equal(current.id, RUN_ID_1);
      assert.equal(current.directory, run.directory);
      return { delegationBriefPath: relativePath };
    },
  });

  assert.equal(written.path, join(run.directory, relativePath));
  assert.equal(await readFile(written.path, "utf8"), "frozen brief only");
  assert.equal(await fileMode(join(run.directory, "delegations")), 0o700);
  assert.equal(await fileMode(join(run.directory, "delegations", RUN_ID_2)), 0o700);
  assert.equal(await fileMode(written.path), 0o600);
  assert.equal((await store.read(RUN_ID_1)).delegationBriefPath, relativePath);
});

test("exclusive private artifact writes reject a duplicate worker launch record", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());
  const relativePath = `worker-launches/${RUN_ID_2}.json`;

  await store.writePrivateFile(RUN_ID_1, {
    relativePath,
    text: "{\"version\":1}\n",
    exclusive: true,
    updater: () => ({ workerLaunches: { [RUN_ID_2]: { digest: "sha256:one" } } }),
  });

  await assert.rejects(
    () => store.writePrivateFile(RUN_ID_1, {
      relativePath,
      text: "{\"version\":2}\n",
      exclusive: true,
      updater: () => ({}),
    }),
    /already exists|duplicate|exclusive/i,
  );
  assert.equal(await readFile(join(run.directory, relativePath), "utf8"), "{\"version\":1}\n");

  await store.writePrivateFile(RUN_ID_1, {
    relativePath,
    text: "{\"version\":2}\n",
    updater: () => ({}),
  });
  assert.equal(await readFile(join(run.directory, relativePath), "utf8"), "{\"version\":2}\n");
});

test("update skips the write when the updater returns an empty patch (a no-op must not bump updatedAt)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  // Distinct create vs. later-write timestamps: any real write on the no-op path would move
  // updatedAt off the create timestamp, so a bumped updatedAt is exactly what this test catches.
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-06-06T00:00:00.000Z"),
  });
  await store.create(plannedInput());
  const before = (await store.read(RUN_ID_1)).updatedAt;

  const result = await store.update(RUN_ID_1, () => ({}));

  assert.equal(result.updatedAt, before, "an empty-patch update must return the unchanged updatedAt");
  assert.equal((await store.read(RUN_ID_1)).updatedAt, before, "an empty-patch update must not rewrite the run file");
});

test("rejects unsafe private artifact paths without writing outside the run", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());

  for (const relativePath of ["", "\0", "/tmp/escape", "../escape", "delegations/../../escape"]) {
    await assert.rejects(
      () => store.writePrivateFile(RUN_ID_1, {
        relativePath,
        text: "SECRET-DO-NOT-LEAK",
        updater: () => ({}),
      }),
      (error) => {
        assert.match(error.message, /private|path|relative/i);
        assert.doesNotMatch(error.message, /SECRET-DO-NOT-LEAK/);
        return true;
      },
    );
  }

  await assert.rejects(
    () => store.writePrivateFile(RUN_ID_1, {
      relativePath: "delegations/valid.md",
      text: "brief",
      updater: () => null,
    }),
    /updater|object/i,
  );
  await assertNoPath(join(stateRoot, "escape"));
  await assertNoPath(join(run.directory, "escape"));
});

test("lists runs with filters and writes private assignments", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: uuidSequence(RUN_ID_1, RUN_ID_2, RUN_ID_3),
    clock: clockSequence(
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:01:00.000Z",
      "2025-01-01T00:02:00.000Z",
      "2025-01-01T00:03:00.000Z",
    ),
  });
  const first = await store.create(plannedInput({ primaryTicket: "A-1", originSessionId: "pi:one" }));
  await store.create(plannedInput({ primaryTicket: "A-2", originSessionId: "pi:one", consumedAt: "2025-01-01T00:10:00.000Z" }));
  await store.create(plannedInput({ projectAlias: "personalProjectB", primaryTicket: "C-1", originSessionId: "pi:two" }));

  const assignment = await store.writeAssignment(RUN_ID_1, "Implement OCR workflow\n");

  assert.equal(assignment.path, join(first.directory, "assignment.md"));
  assert.equal(await readFile(assignment.path, "utf8"), "Implement OCR workflow\n");
  assert.equal((await stat(assignment.path)).mode & 0o777, 0o600);

  const listed = await store.list({ projectAlias: "ocr", originSessionId: "pi:one", unconsumed: true });
  assert.deepEqual(listed.map((run) => run.id), [RUN_ID_1]);
  assert.equal(listed[0].directory, first.directory);
});

test("list skips unreadable run directories and reports them instead of failing wholesale", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const problems = [];
  const store = createRunStore({
    stateRoot,
    randomUUID: uuidSequence(RUN_ID_1),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    onListProblem: (problem) => problems.push(problem),
  });
  const created = await store.create(plannedInput({ primaryTicket: "A-1" }));
  // Crash residue: a run directory without run.json (create() mkdirs before the
  // first write). The no-cleanup policy preserves it; list() must not be poisoned.
  await mkdir(join(stateRoot, RUN_ID_2), { recursive: true, mode: 0o700 });

  const listed = await store.list({});
  assert.deepEqual(listed.map((run) => run.id), [created.id]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].runId, RUN_ID_2);
  assert.equal(problems[0].directory, join(stateRoot, RUN_ID_2));
  assert.match(problems[0].message, /not found/i);

  // Strict reads keep failing loudly for the poisoned run.
  await assert.rejects(() => store.read(RUN_ID_2), /not found/i);
});

test("update retries a fresh lock collision briefly and succeeds once it clears", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const sleeps = [];
  const store = createRunStore({
    stateRoot,
    randomUUID: uuidSequence(RUN_ID_1),
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
      // The colliding writer (a worker lifecycle hook) releases its
      // millisecond-scale lock while we back off.
      await realFs.rm(join(stateRoot, RUN_ID_1, "run.lock", "active"), { recursive: true, force: true });
    },
  });
  await store.create(plannedInput({ primaryTicket: "A-1" }));
  await mkdir(join(stateRoot, RUN_ID_1, "run.lock", "active"), { recursive: true, mode: 0o700 });

  const updated = await store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING }));
  assert.equal(updated.state, RUN_STATES.LAUNCHING);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 25 && sleeps[0] < 100, `backoff must be jittered 25-100ms, got ${sleeps[0]}`);
});

test("update stays fail-fast when the lock collision persists past the bounded retries", async (t) => {
  // NOTE: this test's shape changed from the pre-fix version. It used to assert `sleeps.length
  // === 2` because the retry was bounded by a fixed attempt count (3 tries). That count-based
  // guarantee is exactly what this fix (bounded-retry.js) replaces with a wall-time budget, so
  // asserting a fixed attempt count no longer describes the contract under test. This version
  // drives a fake wall clock through the same injected `sleep` seam (advancing it by each
  // jittered backoff, never waiting in real time) and asserts the budget-based property instead:
  // retries continue until MUTEX_RETRY_BUDGET_MS of simulated time has elapsed, then the
  // contention error still surfaces.
  const stateRoot = await tempStateRoot(t);
  const sleeps = [];
  let elapsedMs = 0;
  const store = createRunStore({
    stateRoot,
    randomUUID: uuidSequence(RUN_ID_1),
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
    retryNow: () => elapsedMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      elapsedMs += ms;
    },
  });
  await store.create(plannedInput({ primaryTicket: "A-1" }));
  await mkdir(join(stateRoot, RUN_ID_1, "run.lock", "active"), { recursive: true, mode: 0o700 });

  await assert.rejects(
    () => store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING })),
    (error) => error.category === "run-lock" && error.details?.stale === false,
  );
  // Bounded by wall time, not attempt count: more than the old fixed two backoffs, and the
  // simulated elapsed time spent retrying reaches the full budget before giving up.
  assert.ok(sleeps.length > 2, `expected more than the old fixed two backoffs, got ${sleeps.length}`);
  for (const ms of sleeps) {
    assert.ok(ms >= 25 && ms < 100, `backoff must be jittered 25-100ms, got ${ms}`);
  }
  assert.ok(elapsedMs >= MUTEX_RETRY_BUDGET_MS, `expected the retry to spend the full ${MUTEX_RETRY_BUDGET_MS}ms budget, got ${elapsedMs}ms`);
  // The old fixed count also proved an upper bound ("and no more than that"). node --test's
  // default timeout is Infinity, so a genuinely unbounded loop would hang this run rather than
  // fail it -- restore that bound here, sized to the worst case of every backoff landing at the
  // jitter floor (25ms).
  assert.ok(sleeps.length <= Math.ceil(MUTEX_RETRY_BUDGET_MS / 25) + 1, `expected a bounded number of retries, got ${sleeps.length}`);
});

test("inspectLock returns null with no lock, and returns the marker with a stale flag without mutating anything", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:10:00.000Z"),
  });
  const run = await store.create(plannedInput());

  assert.equal(await store.inspectLock(RUN_ID_1), null);

  const lockContainer = join(run.directory, "run.lock");
  const activePath = join(lockContainer, "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = {
    version: 2,
    token: "crashed-token",
    runId: RUN_ID_1,
    pid: "9999",
    startedAt: "2024-12-31T00:00:00.000Z",
  };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activePath, { recursive: true, mode: 0o755 });
  await chmod(lockContainer, 0o755);
  await chmod(activePath, 0o755);
  await writeFile(markerPath, markerContent, { mode: 0o644 });
  const staleTime = new Date("2025-01-01T00:00:00.000Z");
  await utimes(activePath, staleTime, staleTime);

  const inspected = await store.inspectLock(RUN_ID_1);

  assert.equal(inspected.activePath, activePath);
  assert.equal(inspected.markerPath, markerPath);
  assert.deepEqual(inspected.marker, marker);
  assert.equal(inspected.ageMs, 10 * 60 * 1000);
  assert.equal(inspected.stale, true);
  // A single valid marker is the non-ambiguous case: markerAmbiguous must read false here, the
  // complement of the multi-marker test below asserting it true.
  assert.equal(inspected.markerAmbiguous, false);

  // Never mutates: a naive implementation could reuse the tighten-permissions helpers every
  // other read/write path calls; inspectLock must not, so the permissive modes set above (and
  // the marker's exact byte content) must survive untouched.
  assert.equal(await fileMode(lockContainer), 0o755);
  assert.equal(await fileMode(activePath), 0o755);
  assert.equal(await fileMode(markerPath), 0o644);
  assert.equal(await readFile(markerPath, "utf8"), markerContent);
});

test("removeLock removes only when allow returns true, refuses without throwing when the marker changes first, and unblocks the run", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:10:00.000Z"),
  });
  const run = await store.create(plannedInput());
  const lockContainer = join(run.directory, "run.lock");
  const activePath = join(lockContainer, "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = {
    version: 2,
    token: "crashed-token",
    runId: RUN_ID_1,
    pid: "9999",
    startedAt: "2024-12-31T00:00:00.000Z",
  };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });
  // Mark it stale (per the injected clock) so the wedged check below fails fast on the first
  // attempt instead of burning through acquireLockWithRetry's bounded real-time backoff.
  const staleTime = new Date("2025-01-01T00:00:00.000Z");
  await utimes(activePath, staleTime, staleTime);

  // The run is wedged behind the crash-residue lock until it is removed.
  await assert.rejects(() => store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING })), /lock/i);

  // allow() returning false: refuses without throwing, removes nothing.
  const disallowed = await store.removeLock(RUN_ID_1, { allow: () => false });
  assert.equal(disallowed.removed, false);
  assert.match(disallowed.reason, /not permitted/i);
  assert.equal(await readFile(markerPath, "utf8"), markerContent);

  // The marker changes inside the allow() callback (simulating a fresh acquisition racing the
  // removal): removeLock must re-verify byte content immediately before deleting and refuse.
  let allowCalls = 0;
  const racedMarkerContent = `${JSON.stringify({ ...marker, token: "different-token" })}\n`;
  const raced = await store.removeLock(RUN_ID_1, {
    allow: async (seenMarker) => {
      allowCalls += 1;
      assert.deepEqual(seenMarker, marker);
      await writeFile(markerPath, racedMarkerContent, { mode: 0o600 });
      return true;
    },
  });
  assert.equal(allowCalls, 1);
  assert.equal(raced.removed, false);
  assert.match(raced.reason, /marker changed/i);
  assert.equal(await readFile(markerPath, "utf8"), racedMarkerContent, "the race-injected content must survive a refused removal");

  // Restore the stable marker, then a permitting allow() actually removes it.
  await writeFile(markerPath, markerContent, { mode: 0o600 });
  const removed = await store.removeLock(RUN_ID_1, {
    allow: (seenMarker) => {
      assert.deepEqual(seenMarker, marker);
      return true;
    },
  });
  assert.deepEqual(removed, { removed: true, markerPath, activePath });
  await assertNoPath(activePath);
  assert.deepEqual(await realFs.readdir(lockContainer), []);

  // The run accepts writes again.
  const updated = await store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING }));
  assert.equal(updated.state, RUN_STATES.LAUNCHING);
  await store.appendEvent(RUN_ID_1, { type: "launch.output" });
});

test("removeLock refuses without throwing when there is no active lock to remove", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  await store.create(plannedInput());

  const result = await store.removeLock(RUN_ID_1, { allow: () => true });

  assert.equal(result.removed, false);
  assert.match(result.reason, /no active lock/i);
});

test("removeLock's refusal is the public {removed:false, reason} shape, not mutex-removal.js's internal {refused} sentinel", async (t) => {
  // removeLock translates removeOwnedMutex's `{refused: true, reason}` into this store's own
  // `{removed: false, reason}` shape. mutex-removal.js's own tests only ever assert the internal
  // sentinel (that is its contract); nothing previously asserted that removeLock actually
  // performs the translation, so a caller that forgot it would go uncaught.
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  await store.create(plannedInput());

  const result = await store.removeLock(RUN_ID_1, { allow: () => true });

  assert.deepEqual(result, { removed: false, reason: "no active lock or the owner marker is unreadable" });
});

test("removeLock rejects a non-function allow before touching the filesystem", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  await store.create(plannedInput());

  await assert.rejects(() => store.removeLock(RUN_ID_1, { allow: "not-a-function" }), /removeLock allow must be a function/);
  await assert.rejects(() => store.removeLock(RUN_ID_1, {}), /removeLock allow must be a function/);
});

test("inspectLock reports stale: false for a freshly created lock", async (t) => {
  // Deliberately no injected clock: the real clock and the real mkdir mtime agree on "now",
  // so ageMs comes out small and deterministic without needing utimes(). This exists because
  // every other inspectLock test here pins a stale (5+ minute) lock, so a hardcoded `stale:
  // true` in the implementation would otherwise pass the whole suite undetected.
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = { version: 2, token: "crashed-token", runId: RUN_ID_1 };
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

  const inspected = await store.inspectLock(RUN_ID_1);

  assert.equal(inspected.stale, false);
  assert.ok(Number.isFinite(inspected.ageMs), "ageMs must be a finite number, not null/NaN, for a normally-stat-able lock");
  assert.ok(inspected.ageMs < 60 * 1000, `expected a fresh lock's age to be well under the 5-minute stale threshold, got ${inspected.ageMs}`);
});

test("inspectLock ignores a stray non-owner file and still finds the real marker", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = { version: 2, token: "crashed-token", runId: RUN_ID_1 };
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  // Sorts before "owner-..." alphabetically: a naive "first readdir entry" implementation
  // would pick this stray file instead of the real marker.
  await writeFile(join(activePath, ".DS_Store"), "not a marker", { mode: 0o600 });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

  const inspected = await store.inspectLock(RUN_ID_1);

  assert.deepEqual(inspected.marker, marker);
  assert.equal(inspected.markerPath, markerPath);
});

test("inspectLock and removeLock treat more than one owner marker as unreadable instead of guessing", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");
  const markerA = { version: 2, token: "token-a", runId: RUN_ID_1 };
  const markerB = { version: 2, token: "token-b", runId: RUN_ID_1 };
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(join(activePath, "owner-token-a.json"), `${JSON.stringify(markerA)}\n`, { mode: 0o600 });
  await writeFile(join(activePath, "owner-token-b.json"), `${JSON.stringify(markerB)}\n`, { mode: 0o600 });

  const inspected = await store.inspectLock(RUN_ID_1);
  assert.equal(inspected.marker, null);
  assert.equal(inspected.markerPath, null);
  // A stray-file false negative and a genuine multi-marker ambiguity both surface as
  // marker: null in the public shape; the age/stale fields must still be reported.
  assert.equal(inspected.activePath, activePath);
  assert.ok(Number.isFinite(inspected.ageMs));
  // Final-review finding 5: markerAmbiguous distinguishes THIS case (more than one owner marker)
  // from a merely absent/corrupt one, so a caller (commands.js's unlockCommand) can surface the
  // specific reason instead of the generic "unreadable" one on the read-only path.
  assert.equal(inspected.markerAmbiguous, true);

  const result = await store.removeLock(RUN_ID_1, { allow: () => true });
  assert.equal(result.removed, false);
  assert.match(result.reason, /more than one|multiple/i);
  // Neither marker was touched: removeLock refused before ever calling allow() on a guess.
  assert.equal(await readFile(join(activePath, "owner-token-a.json"), "utf8"), `${JSON.stringify(markerA)}\n`);
  assert.equal(await readFile(join(activePath, "owner-token-b.json"), "utf8"), `${JSON.stringify(markerB)}\n`);
});

// Fabricates a different `ino` for the Nth fs.stat(path) call, deterministically simulating
// "this is a different directory now" without depending on how eagerly the underlying
// filesystem reuses a freed inode after rmdir+mkdir — observed to be immediate on this
// environment's tmpfs, which made a real rmdir+mkdir replacement indistinguishable from the
// original directory via dev/ino and made the two tests below flaky/silently-passing.
function fsWithFabricatedIdentityOnNthStat(targetPath, targetCallNumber) {
  let calls = 0;
  return {
    ...realFs,
    async stat(path) {
      const real = await realFs.stat(path);
      if (path !== targetPath) return real;
      calls += 1;
      if (calls !== targetCallNumber) return real;
      return { ...real, ino: (real.ino ?? 0) + 999999, isDirectory: () => real.isDirectory() };
    },
  };
}

test("removeLock's pre-unlink recheck refuses a same-content replacement lock via directory identity, not marker bytes", async (t) => {
  // If sameActiveDirectory were deleted from removeLock's pre-unlink recheck, this test would
  // fail: the fabricated identity below leaves the marker's path and byte content completely
  // untouched, so only a dev/ino (directory identity) comparison can distinguish "the same
  // lock we inspected" from "a replacement that happens to look identical".
  const stateRoot = await tempStateRoot(t);
  const run = await createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 }).create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = { version: 2, token: "crashed-token", runId: RUN_ID_1 };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });

  // removeLock's own fs.stat(activePath) call sequence is: 1) inspectLockInternal for
  // `initial`, 2) inspectLockInternal for `recheck` (this is the one under test — fabricate a
  // different identity for it).
  const fs = fsWithFabricatedIdentityOnNthStat(activePath, 2);
  const store = createRunStore({ stateRoot, fs, randomUUID: () => RUN_ID_1 });

  let allowCalls = 0;
  const result = await store.removeLock(RUN_ID_1, {
    allow: async (seenMarker) => {
      allowCalls += 1;
      assert.deepEqual(seenMarker, marker);
      return true;
    },
  });

  assert.equal(allowCalls, 1);
  assert.equal(result.removed, false);
  assert.match(result.reason, /replaced/i);
  // The lock must survive completely untouched: proof removeLock never unlinked it.
  assert.equal(await readFile(markerPath, "utf8"), markerContent);
  await assert.doesNotReject(() => stat(activePath));
});

test("removeLock's pre-rmdir recheck refuses a same-content replacement lock via directory identity, not marker bytes", async (t) => {
  // Targets the second, later identity check that runs after the marker has already been
  // unlinked and immediately before rmdir. If that check were deleted, this test would fail:
  // the fabricated identity below leaves everything else (path, marker bytes) untouched, so
  // only a fresh dev/ino comparison right before rmdir can catch it.
  const stateRoot = await tempStateRoot(t);
  const run = await createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 }).create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = { version: 2, token: "crashed-token", runId: RUN_ID_1 };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });

  // Calls 1 and 2 (the initial and recheck inspections) must see a consistent, real identity
  // so removeLock actually proceeds to unlink; call 3 is removeLock's own postUnlinkStat,
  // taken right after the unlink and immediately before rmdir — fabricate a different identity
  // there specifically.
  const fs = fsWithFabricatedIdentityOnNthStat(activePath, 3);
  const store = createRunStore({ stateRoot, fs, randomUUID: () => RUN_ID_1 });

  const result = await store.removeLock(RUN_ID_1, { allow: () => true });

  assert.equal(result.removed, false);
  assert.match(result.reason, /replaced/i);
  // The marker was legitimately unlinked (that part of removal did commit), but the directory
  // itself must survive: proof removeLock refused to rmdir once the identity check caught the
  // fabricated mismatch, rather than rmdir-ing a directory it never re-verified.
  await assertNoPath(markerPath);
  await assert.doesNotReject(() => stat(activePath));
});

test("removeLock refuses without throwing when the marker disappears at the final unlink", async (t) => {
  // Targets the exact judgment call from the previous review round: treating ENOENT on the
  // final unlink as a graceful refusal, not a throw. This is the path that stops removeLock
  // from ever reaching rmdir on a directory it never re-inspected. Simulated by making the
  // marker disappear (via another actor, in effect) right as removeLock's own unlink call
  // fires — a window the earlier recheck cannot observe because it already ran.
  const stateRoot = await tempStateRoot(t);
  const injection = { markerPath: null, fired: false };
  const fs = {
    ...realFs,
    async unlink(path) {
      if (!injection.fired && injection.markerPath && path === injection.markerPath) {
        injection.fired = true;
        await realFs.unlink(path);
        const error = new Error("ENOENT: no such file or directory, unlink");
        error.code = "ENOENT";
        throw error;
      }
      return realFs.unlink(path);
    },
  };
  const store = createRunStore({ stateRoot, fs, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = { version: 2, token: "crashed-token", runId: RUN_ID_1 };
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  injection.markerPath = markerPath;

  const result = await store.removeLock(RUN_ID_1, { allow: () => true });

  assert.equal(result.removed, false);
  assert.match(result.reason, /disappeared/i);
  await assertNoPath(markerPath);
  // The active directory itself must be left alone: a buggy implementation that pressed on to
  // rmdir despite the refused unlink would make this stat reject with ENOENT.
  await assert.doesNotReject(() => stat(activePath));
});

test("removeLock refuses to unlink the marker when a stray entry would make rmdir fail, preserving the ownership evidence", async (t) => {
  // If removeLock unlinked the marker first and only then discovered the stray entry (via
  // rmdir's ENOTEMPTY), the lock would end up wedged with NO marker at all: every later
  // removeLock/inspectLock would see "no active lock or the owner marker is unreadable" and the
  // pid/startedAt evidence this whole mechanism exists to preserve would be gone for good. This
  // test proves removeLock checks first and refuses before deleting anything.
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());
  const activePath = join(run.directory, "run.lock", "active");
  const markerPath = join(activePath, "owner-crashed-token.json");
  const marker = { version: 2, token: "crashed-token", runId: RUN_ID_1, pid: "9999", startedAt: "2024-12-31T00:00:00.000Z" };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activePath, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });
  // A stray file inspectLock already tolerates when identifying the marker (see the
  // "ignores a stray non-owner file" test above) — but it would make a naive rmdir fail.
  await writeFile(join(activePath, ".DS_Store"), "not a marker", { mode: 0o600 });

  let allowCalls = 0;
  const result = await store.removeLock(RUN_ID_1, {
    allow: async (seenMarker) => {
      allowCalls += 1;
      assert.deepEqual(seenMarker, marker);
      return true;
    },
  });

  assert.equal(allowCalls, 1);
  assert.equal(result.removed, false);
  assert.match(result.reason, /entries besides|evidence/i);
  // The marker must survive completely untouched — this is the actual evidence-preservation
  // guarantee under test: a buggy implementation that unlinked first and only discovered the
  // stray entry at rmdir would fail this exact assertion (the marker would already be gone).
  assert.equal(await readFile(markerPath, "utf8"), markerContent);
  // The stray file and the active lock directory itself must also survive: nothing was touched.
  assert.equal(await readFile(join(activePath, ".DS_Store"), "utf8"), "not a marker");
  await assert.doesNotReject(() => stat(activePath));
});
