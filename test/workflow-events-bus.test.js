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

test("readEvents leaves a torn trailing line for the next read", async () => {
  const dir = await tempDir();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1" } });
  const tornLine = JSON.stringify({ type: "handoff", runId: "r2" }) + "\n";
  const { appendFile } = await import("node:fs/promises");
  // Simulate a writer caught mid-append: only part of the line is on disk.
  await appendFile(join(dir, "events.jsonl"), tornLine.slice(0, 10));
  const first = await readEvents({ stateRoot: dir, fromByte: 0 });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].runId, "r1");
  // The cursor must stop at the last complete line, not after the torn bytes.
  await appendFile(join(dir, "events.jsonl"), tornLine.slice(10));
  const second = await readEvents({ stateRoot: dir, fromByte: first.nextByte });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].runId, "r2");
  await rm(dir, { recursive: true, force: true });
});

test("readEvents returns no progress when only a torn line exists", async () => {
  const dir = await tempDir();
  await appendEvent({ stateRoot: dir, event: { type: "handoff", runId: "r1" } });
  const first = await readEvents({ stateRoot: dir, fromByte: 0 });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(dir, "events.jsonl"), '{"type":"handoff"');
  const second = await readEvents({ stateRoot: dir, fromByte: first.nextByte });
  assert.deepEqual(second.events, []);
  assert.equal(second.nextByte, first.nextByte);
  await rm(dir, { recursive: true, force: true });
});
