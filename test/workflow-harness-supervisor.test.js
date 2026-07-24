import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createHarnessSupervisor } from "../src/workflow/harness-supervisor.js";
import { createTelemetryAdapter } from "../src/workflow/telemetry-adapters.js";
import { normalizeTelemetryEvent } from "../src/workflow/telemetry.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";

function fixtureLaunch(overrides = {}) {
  return {
    version: 1,
    harness: "opencode",
    command: "opencode",
    argv: ["run", "--format", "json", "fixture"],
    cwd: "/fixture/worktree",
    env: { WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_STATE_ROOT: "/state" },
    harnessVersion: "1.0.126",
    ...overrides,
  };
}

function fakeSpawn({ stdoutChunks = [], exitCode = 0, spawnError } = {}) {
  const calls = [];
  const spawn = (command, argv, options) => {
    calls.push({ command, argv, options });
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.pid = 4321;
    queueMicrotask(() => {
      if (spawnError) {
        child.emit("error", spawnError);
        return;
      }
      child.emit("spawn");
      for (const chunk of stdoutChunks) child.stdout.push(chunk);
      child.stdout.push(null);
      child.exitCode = exitCode;
      child.emit("close", exitCode);
    });
    return child;
  };
  return { calls, spawn };
}

// The real telemetry store normalizes every event and rejects fields outside the schema,
// so a fake that just collects them would let the supervisor emit events that only fail
// against a live worker.
function memoryTelemetry() {
  const events = [];
  return {
    events,
    async record({ event }) {
      const normalized = normalizeTelemetryEvent(event);
      events.push(normalized);
      return normalized;
    },
  };
}

function supervisor({ telemetry, spawn, baseEnv = { PATH: "/usr/bin", HOME: "/home/dev" } }) {
  return createHarnessSupervisor({
    telemetry,
    spawn,
    baseEnv,
    createAdapter: createTelemetryAdapter,
    clock: () => "2026-07-23T00:00:00.000Z",
  });
}

test("streams chunk-split LF JSONL into normalized telemetry and settles on exit 0", async () => {
  const telemetry = memoryTelemetry();
  const json = JSON.stringify({ type: "session.updated", properties: { status: "busy" } });
  const bytes = Buffer.from(`${json}\n{"type":"session.updated","properties":{"status":"idle"}}\n`, "utf8");
  const { calls, spawn } = fakeSpawn({
    stdoutChunks: [bytes.subarray(0, 7), bytes.subarray(7, bytes.length - 5), bytes.subarray(bytes.length - 5)],
  });

  const result = await supervisor({ telemetry, spawn }).run({ runId: RUN_ID, workerId: WORKER_ID, launch: fixtureLaunch() });

  assert.equal(result.exitCode, 0);
  assert.equal(result.pid, 4321);
  assert.deepEqual(calls[0].options, {
    cwd: "/fixture/worktree",
    env: { PATH: "/usr/bin", HOME: "/home/dev", WORKFLOW_RUN_ID: RUN_ID, WORKFLOW_STATE_ROOT: "/state" },
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.equal(telemetry.events[0].phase, "starting");
  assert.equal(telemetry.events.some((event) => event.phase === "running"), true);
  assert.equal(telemetry.events.at(-1).phase, "settled");
  assert.equal(JSON.stringify(telemetry.events).includes("forbidden stderr"), false);
});

test("carries a split multibyte UTF-8 sequence safely", async () => {
  const telemetry = memoryTelemetry();
  const json = JSON.stringify({ type: "session.updated", properties: { status: "busy", label: "busy —" } });
  const bytes = Buffer.from(`${json}\n`, "utf8");
  const splitPoint = bytes.length - 3;
  const { spawn } = fakeSpawn({ stdoutChunks: [bytes.subarray(0, splitPoint), bytes.subarray(splitPoint)] });

  const result = await supervisor({ telemetry, spawn }).run({ runId: RUN_ID, workerId: WORKER_ID, launch: fixtureLaunch() });

  assert.equal(result.exitCode, 0);
  const unknown = telemetry.events.filter((event) => event.phase === "unknown");
  assert.equal(unknown.length, 0);
});

test("records bounded unknown telemetry for invalid JSON and oversized lines without touching results", async () => {
  const telemetry = memoryTelemetry();
  const oversized = `{"type":"session.updated","properties":{"status":"busy","pad":"${"x".repeat(70 * 1024)}"}}`;
  const { spawn } = fakeSpawn({ stdoutChunks: [Buffer.from(`not-json\n${oversized}\n`)] });

  const result = await supervisor({ telemetry, spawn }).run({ runId: RUN_ID, workerId: WORKER_ID, launch: fixtureLaunch() });

  assert.equal(result.exitCode, 0);
  const unknown = telemetry.events.filter((event) => event.phase === "unknown");
  assert.equal(unknown.length >= 2, true);
  assert.equal(JSON.stringify(telemetry.events).includes("not-json"), false);
  assert.equal(JSON.stringify(telemetry.events).includes("xxx"), false);
});

test("an oversized benign event does not pin the snapshot to unknown", async () => {
  const telemetry = memoryTelemetry();
  // Pi emits the full accumulated message on each delta, so a long assistant message makes
  // message_update exceed the line cap. It must be ignored, not degraded, or the rest of
  // the run's telemetry is lost.
  const oversized = `{"type":"message_update","assistantMessageEvent":{"delta":"${"x".repeat(70 * 1024)}"}}`;
  const bytes = Buffer.from(`{"type":"agent_start"}\n${oversized}\n{"type":"agent_settled"}\n`, "utf8");
  const { spawn } = fakeSpawn({ stdoutChunks: [bytes] });

  const result = await supervisor({ telemetry, spawn }).run({
    runId: RUN_ID,
    workerId: WORKER_ID,
    launch: fixtureLaunch({ harness: "pi", command: "pi", argv: ["--print", "--mode", "json"], harnessVersion: "0.81.1" }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(telemetry.events.some((event) => event.phase === "unknown"), false);
  assert.equal(telemetry.events.at(-1).phase, "settled");
  assert.equal(JSON.stringify(telemetry.events).includes("xxx"), false);
});

test("an oversized unrecognized event still degrades to unknown, fail-closed", async () => {
  const telemetry = memoryTelemetry();
  const oversized = `{"type":"mystery_event","pad":"${"x".repeat(70 * 1024)}"}`;
  const { spawn } = fakeSpawn({ stdoutChunks: [Buffer.from(`{"type":"agent_start"}\n${oversized}\n`, "utf8")] });

  await supervisor({ telemetry, spawn }).run({
    runId: RUN_ID,
    workerId: WORKER_ID,
    launch: fixtureLaunch({ harness: "pi", command: "pi", argv: ["--print", "--mode", "json"], harnessVersion: "0.81.1" }),
  });

  assert.equal(telemetry.events.some((event) => event.phase === "unknown"), true);
  assert.equal(JSON.stringify(telemetry.events).includes("xxx"), false);
});

test("records failed on nonzero exit and on spawn error, and never writes a handoff", async () => {
  const telemetry = memoryTelemetry();
  const { spawn } = fakeSpawn({ exitCode: 7 });
  const result = await supervisor({ telemetry, spawn }).run({ runId: RUN_ID, workerId: WORKER_ID, launch: fixtureLaunch() });
  assert.equal(result.exitCode, 7);
  assert.equal(telemetry.events.at(-1).phase, "failed");

  const errorTelemetry = memoryTelemetry();
  const { spawn: errorSpawn } = fakeSpawn({ spawnError: new Error("spawn EACCES") });
  await assert.rejects(
    () => supervisor({ telemetry: errorTelemetry, spawn: errorSpawn }).run({ runId: RUN_ID, workerId: WORKER_ID, launch: fixtureLaunch() }),
    /EACCES/,
  );
  assert.equal(errorTelemetry.events.at(-1).phase, "failed");
});

test("rejects malformed frozen launch records before spawning", async () => {
  const telemetry = memoryTelemetry();
  const { calls, spawn } = fakeSpawn();
  const run = supervisor({ telemetry, spawn });

  for (const launch of [
    fixtureLaunch({ extra: true }),
    fixtureLaunch({ argv: "run --format json" }),
    fixtureLaunch({ command: "" }),
    fixtureLaunch({ cwd: "" }),
  ]) {
    await assert.rejects(
      () => run.run({ runId: RUN_ID, workerId: WORKER_ID, launch }),
      /launch|record|harness|argv|command|cwd/i,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(telemetry.events.length, 0);
});

test("the harness inherits the surrounding environment so it can resolve its binary and credentials", async () => {
  const telemetry = memoryTelemetry();
  const { calls, spawn } = fakeSpawn({ stdoutChunks: [] });

  await supervisor({
    telemetry,
    spawn,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/dev", ANTHROPIC_API_KEY: "secret", WORKFLOW_RUN_ID: "stale-run" },
  }).run({ runId: RUN_ID, workerId: WORKER_ID, launch: fixtureLaunch() });

  const env = calls[0].options.env;
  // Replacing the environment outright leaves the harness without PATH, HOME or any
  // provider credentials, so it cannot even be resolved, let alone authenticate.
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/dev");
  assert.equal(env.ANTHROPIC_API_KEY, "secret");
  // The run's own identity still wins over anything inherited from the shell.
  assert.equal(env.WORKFLOW_RUN_ID, RUN_ID);
  assert.equal(env.WORKFLOW_STATE_ROOT, "/state");
});
