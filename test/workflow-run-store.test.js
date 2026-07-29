import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
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

test("reports bounded active lock contention with injected clock without deleting it", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({
    stateRoot,
    randomUUID: () => RUN_ID_1,
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:10:00.000Z"),
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
  const stateRoot = await tempStateRoot(t);
  const sleeps = [];
  const store = createRunStore({
    stateRoot,
    randomUUID: uuidSequence(RUN_ID_1),
    clock: clockSequence("2025-01-01T00:00:00.000Z"),
    sleep: async (ms) => sleeps.push(ms),
  });
  await store.create(plannedInput({ primaryTicket: "A-1" }));
  await mkdir(join(stateRoot, RUN_ID_1, "run.lock", "active"), { recursive: true, mode: 0o700 });

  await assert.rejects(
    () => store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING })),
    (error) => error.category === "run-lock" && error.details?.stale === false,
  );
  // Bounded: exactly two backoffs for three attempts, then the contention error.
  assert.equal(sleeps.length, 2);
});
