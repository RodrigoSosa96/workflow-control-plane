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

test("reports bounded lock contention and stale locks without deleting them", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID_1 });
  const run = await store.create(plannedInput());
  const lockPath = join(run.directory, "run.lock");
  await writeFile(lockPath, "held by another writer", { mode: 0o600 });
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lockPath, staleTime, staleTime);

  await assert.rejects(
    () => store.update(RUN_ID_1, () => ({ state: RUN_STATES.LAUNCHING })),
    (error) => {
      assert.match(error.message, /lock/i);
      assert.match(error.message, /stale/i);
      assert.match(error.message, /age/i);
      assert.ok(error.message.includes(lockPath));
      assert.ok(error.message.length < 500);
      assert.doesNotMatch(error.message, /projectAlias|primaryTicket|relatedTickets/);
      return true;
    },
  );
  assert.equal(await readFile(lockPath, "utf8"), "held by another writer");
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
