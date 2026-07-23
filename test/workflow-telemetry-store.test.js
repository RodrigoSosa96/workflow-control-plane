import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createRunStore } from "../src/workflow/run-store.js";
import { normalizeTelemetryEvent } from "../src/workflow/telemetry.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";

async function createFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-telemetry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({
    stateRoot: join(root, "state"),
    randomUUID: () => RUN_ID,
    clock: () => "2026-07-23T00:00:00.000Z",
  });
  const run = await store.create({
    projectAlias: "fixture",
    primaryTicket: "FIX-101",
    harness: "pi",
    profileName: "pi-worker",
  });
  return {
    run,
    store,
    telemetry: createTelemetryStore({
      store,
      clock: () => "2026-07-23T00:00:01.000Z",
    }),
  };
}

async function fileMode(path) {
  return (await fs.stat(path)).mode & 0o777;
}

test("persists bounded worker snapshots and only safe telemetry event references", async (t) => {
  const { run, telemetry } = await createFixture(t);
  const saved = await telemetry.record({
    runId: run.id,
    workerId: WORKER_ID,
    event: normalizeTelemetryEvent({
      type: "usage",
      harness: "pi",
      tokens: { input: 10, output: 2 },
      cost: 0.01,
    }),
  });

  assert.equal(saved.workerId, WORKER_ID);
  assert.equal(saved.usage.input.value, 10);
  const snapshotPath = join(run.directory, "telemetry", "workers", `${WORKER_ID}.json`);
  const telemetryEventsPath = join(run.directory, "telemetry", "events.jsonl");
  const eventIndexPath = join(run.directory, "events.jsonl");
  assert.equal(await fileMode(snapshotPath), 0o600);
  assert.equal(await fileMode(telemetryEventsPath), 0o600);
  assert.equal(await fileMode(eventIndexPath), 0o600);

  const [read] = await telemetry.read({ runId: run.id });
  assert.deepEqual(read, saved);
  const eventIndex = await fs.readFile(eventIndexPath, "utf8");
  assert.match(eventIndex, /"type":"telemetry"/);
  assert.equal(eventIndex.includes("prompt"), false);
  assert.equal(eventIndex.includes("input"), false);
  assert.equal(eventIndex.includes("cost"), false);
});

test("tightens existing telemetry snapshot permissions before reading", async (t) => {
  const { run, telemetry } = await createFixture(t);
  await telemetry.record({
    runId: run.id,
    workerId: WORKER_ID,
    event: normalizeTelemetryEvent({ type: "lifecycle", harness: "pi", phase: "running" }),
  });
  const snapshotPath = join(run.directory, "telemetry", "workers", `${WORKER_ID}.json`);
  await fs.chmod(snapshotPath, 0o666);

  await telemetry.read({ runId: run.id, workerId: WORKER_ID });

  assert.equal(await fileMode(snapshotPath), 0o600);
});

test("serializes concurrent updates without decreasing telemetry measurements", async (t) => {
  const { run, telemetry } = await createFixture(t);
  await Promise.all([
    telemetry.record({
      runId: run.id,
      workerId: WORKER_ID,
      event: normalizeTelemetryEvent({ type: "usage", harness: "pi", tokens: { input: 10 } }),
    }),
    telemetry.record({
      runId: run.id,
      workerId: WORKER_ID,
      event: normalizeTelemetryEvent({ type: "usage", harness: "pi", tokens: { output: 5 } }),
    }),
  ]);

  const [saved] = await telemetry.read({ runId: run.id, workerId: WORKER_ID });
  assert.equal(saved.usage.input.value, 10);
  assert.equal(saved.usage.output.value, 5);
});

test("timestamps successive untimestamped telemetry events with the store clock", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-telemetry-clock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({ stateRoot: join(root, "state"), randomUUID: () => RUN_ID });
  const run = await store.create({ projectAlias: "fixture", primaryTicket: "FIX-101", harness: "pi", profileName: "pi-worker" });
  const times = ["2026-07-23T00:00:01.000Z", "2026-07-23T00:00:02.000Z"];
  const telemetry = createTelemetryStore({ store, clock: () => times.shift() });

  await telemetry.record({ runId: run.id, workerId: WORKER_ID, event: normalizeTelemetryEvent({ type: "lifecycle", harness: "pi", phase: "running" }) });
  const saved = await telemetry.record({ runId: run.id, workerId: WORKER_ID, event: normalizeTelemetryEvent({ type: "usage", harness: "pi", tokens: { input: 1 } }) });

  assert.equal(saved.startedAt, "2026-07-23T00:00:01.000Z");
  assert.equal(saved.updatedAt, "2026-07-23T00:00:02.000Z");
});

test("rejects unsafe or conflicting worker identities without writing outside the run", async (t) => {
  const { run, telemetry } = await createFixture(t);
  const event = normalizeTelemetryEvent({ type: "lifecycle", harness: "pi", phase: "running" });
  await telemetry.record({ runId: run.id, workerId: WORKER_ID, event });

  for (const workerId of ["", "../escape", "22222222-2222-4222-8222-22222222222z"]) {
    await assert.rejects(
      () => telemetry.record({ runId: run.id, workerId, event }),
      /worker|uuid|telemetry/i,
    );
  }
  await assert.rejects(
    () => telemetry.record({
      runId: run.id,
      workerId: WORKER_ID,
      event: normalizeTelemetryEvent({ type: "lifecycle", harness: "claude", phase: "running" }),
    }),
    /harness|worker|telemetry/i,
  );
  await assert.rejects(() => fs.stat(join(run.directory, "escape")), /ENOENT/);
});

test("fails closed rather than retaining raw fields in a persisted telemetry journal", async (t) => {
  const { run, telemetry } = await createFixture(t);
  const event = normalizeTelemetryEvent({ type: "lifecycle", harness: "pi", phase: "running" });
  await telemetry.record({ runId: run.id, workerId: WORKER_ID, event });
  const [before] = await telemetry.read({ runId: run.id, workerId: WORKER_ID });
  const journalPath = join(run.directory, "telemetry", "events.jsonl");
  await fs.writeFile(journalPath, `${JSON.stringify({
    version: 1,
    type: "telemetry",
    workerId: WORKER_ID,
    harness: "pi",
    phase: "running",
    observability: "reported",
    at: "2026-07-23T00:00:01.000Z",
    prompt: "DO-NOT-RETAIN",
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    () => telemetry.record({
      runId: run.id,
      workerId: WORKER_ID,
      event: normalizeTelemetryEvent({ type: "usage", harness: "pi", tokens: { input: 1 } }),
    }),
    (error) => {
      assert.match(error.message, /telemetry|journal|event/i);
      assert.doesNotMatch(error.message, /DO-NOT-RETAIN/);
      return true;
    },
  );
  assert.match(await fs.readFile(journalPath, "utf8"), /DO-NOT-RETAIN/);
  assert.deepEqual(await telemetry.read({ runId: run.id, workerId: WORKER_ID }), [before]);
});

test("fails closed when a persisted telemetry snapshot is malformed", async (t) => {
  const { run, telemetry } = await createFixture(t);
  const snapshotPath = join(run.directory, "telemetry", "workers", `${WORKER_ID}.json`);
  await fs.mkdir(join(run.directory, "telemetry", "workers"), { recursive: true, mode: 0o700 });
  await fs.writeFile(snapshotPath, '{"secret":"DO-NOT-LEAK"', { mode: 0o600 });

  await assert.rejects(
    () => telemetry.read({ runId: run.id, workerId: WORKER_ID }),
    (error) => {
      assert.match(error.message, /telemetry|snapshot|malformed/i);
      assert.doesNotMatch(error.message, /DO-NOT-LEAK/);
      return true;
    },
  );
});
