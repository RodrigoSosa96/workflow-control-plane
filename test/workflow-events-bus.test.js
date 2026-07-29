import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendEvent, readEvents } from "../src/workflow/events-bus.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "workflow-events-bus-"));
}

test("appendEvent writes a JSONL line", async () => {
  const dir = await tempDir();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1" } });
  const contents = await readFile(join(dir, "events.jsonl"), "utf8");
  assert.match(contents, /\{"type":"handoff","runId":"r1"\}/);
  await rm(dir, { recursive: true, force: true });
});

test("readEvents returns appended events and next byte cursor", async () => {
  const dir = await tempDir();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1" } });
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r2" } });
  const first = await readEvents({ stateRoot: dir, fromByte: 0 });
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].runId, "r1");
  assert.equal(first.events[1].runId, "r2");
  assert.equal(typeof first.nextByte, "number");
  const second = await readEvents({ stateRoot: dir, fromByte: first.nextByte });
  assert.equal(second.events.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("readEvents returns empty for missing file", async () => {
  const dir = await tempDir();
  const result = await readEvents({ stateRoot: dir, fromByte: 0 });
  assert.deepEqual(result.events, []);
  assert.equal(result.nextByte, 0);
  await rm(dir, { recursive: true, force: true });
});
