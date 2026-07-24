import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WorkflowError } from "./errors.js";

const MAX_LINE_LENGTH = 65536;
const ALLOWED_KEYS = ["version", "harness", "command", "argv", "cwd", "env", "harnessVersion"];

function failProcess(reason, details) {
  const error = new WorkflowError("PROCESS", reason, { details });
  error.name = "SupervisorLaunchError";
  throw error;
}

export function validateLaunchRecord(record) {
  if (!record || typeof record !== "object") failProcess("Missing launch record");
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!ALLOWED_KEYS.includes(key)) failProcess(`Unexpected key in launch record: ${key}`);
  }
  if (typeof record.command !== "string" || record.command.trim() === "") {
    failProcess("Launch record must contain a non-empty command string");
  }
  if (!Array.isArray(record.argv)) failProcess("Launch record argv must be an array of strings");
  for (const arg of record.argv) {
    if (typeof arg !== "string") failProcess("Launch record argv must contain only strings");
  }
  if (typeof record.cwd !== "string" || record.cwd.trim() === "") {
    failProcess("Launch record must contain a non-empty cwd string");
  }
  if (typeof record.env !== "object" || record.env === null || Array.isArray(record.env)) {
    failProcess("Launch record env must be an object");
  }
  for (const [k, v] of Object.entries(record.env)) {
    if (typeof v !== "string") failProcess(`Launch record env[${k}] must be a string`);
  }
  if (typeof record.harness !== "string" || record.harness.trim() === "") {
    failProcess("Launch record must contain a non-empty harness string");
  }
  if (typeof record.harnessVersion !== "string") {
    failProcess("Launch record must contain a harnessVersion string");
  }
  if (typeof record.version !== "number" || record.version !== 1) {
    failProcess("Launch record version must be exactly 1");
  }
  return record;
}

async function* decodeLfJsonl(stdout) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stdout) {
    const text = decoder.write(chunk);
    buffer += text;
    let lineEnd;
    while ((lineEnd = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      yield line;
    }
  }
  const final = decoder.end();
  if (final.length > 0) yield final;
}

export function createHarnessSupervisor({ spawn: spawnChild = spawn, telemetry, createAdapter, clock = () => new Date().toISOString(), baseEnv = process.env }) {
  async function run({ runId, workerId, launch }) {
    validateLaunchRecord(launch);

    const startedAt = clock();
    const firstEvent = {
      type: "lifecycle",
      phase: "starting",
      harness: launch.harness,
      version: launch.harnessVersion,
      startedAt,
      runId,
      workerId,
    };
    await telemetry.record({ runId, workerId, event: firstEvent });

    const adapter = createAdapter({ harness: launch.harness, version: launch.harnessVersion });
    const child = spawnChild(launch.command, launch.argv, {
      cwd: launch.cwd,
      // Passing only the workflow variables would replace the environment outright,
      // leaving the harness without PATH, HOME or provider credentials. Inherit the
      // surrounding environment and let the run's own identity take precedence.
      env: { ...baseEnv, ...launch.env },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let pid = null;
    const spawnedPromise = new Promise((resolve) => child.on("spawn", () => {
      pid = child.pid;
      resolve();
    }));
    const spawnErrorPromise = new Promise((_, reject) => child.on("error", (err) => {
      if (child.stdout && typeof child.stdout.destroy === "function") child.stdout.destroy();
      reject(err);
    }));
    const closePromise = new Promise((resolve) => child.on("close", resolve));

    try {
      await Promise.race([spawnedPromise, spawnErrorPromise]);
    } catch (error) {
      await telemetry.record({ runId, workerId, event: {
        type: "lifecycle",
        phase: "failed",
        harness: launch.harness,
        version: launch.harnessVersion,
        runId,
        workerId,
      } });
      throw error;
    }

    const runningPromise = telemetry.record({ runId, workerId, event: {
      type: "lifecycle",
      phase: "running",
      harness: launch.harness,
      version: launch.harnessVersion,
      runId,
      workerId,
    } });

    const streamPromise = (async () => {
      const decodeStream = decodeLfJsonl(child.stdout);
      for await (const line of decodeStream) {
        if (line.length > MAX_LINE_LENGTH) {
          await telemetry.record({ runId, workerId, event: {
            type: "lifecycle",
            phase: "unknown",
            reason: "oversized_line",
            harness: launch.harness,
            version: launch.harnessVersion,
            runId,
            workerId,
          } });
          continue;
        }
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          await telemetry.record({ runId, workerId, event: {
            type: "lifecycle",
            phase: "unknown",
            reason: "invalid_json",
            harness: launch.harness,
            version: launch.harnessVersion,
            runId,
            workerId,
          } });
          continue;
        }
        let events;
        try {
          events = adapter.consume(record);
        } catch {
          await telemetry.record({ runId, workerId, event: {
            type: "lifecycle",
            phase: "unknown",
            reason: "adapter_failure",
            harness: launch.harness,
            version: launch.harnessVersion,
            runId,
            workerId,
          } });
          continue;
        }
        for (const event of events) {
          await telemetry.record({ runId, workerId, event: {
            ...event,
            runId,
            workerId,
            harness: launch.harness,
            version: launch.harnessVersion,
          } });
        }
      }
    })();

    try {
      await Promise.all([runningPromise, streamPromise, closePromise]);
    } catch (error) {
      // Stream or telemetry error; we still wait for close if not already closed
      try {
        await closePromise;
      } catch {}
      throw error;
    }

    const exitCode = await closePromise;
    const phase = exitCode === 0 ? "settled" : "failed";
    await telemetry.record({ runId, workerId, event: {
      type: "lifecycle",
      phase,
      exitCode: exitCode === null ? null : exitCode,
      harness: launch.harness,
      version: launch.harnessVersion,
      runId,
      workerId,
    } });

    return { pid: pid ?? null, startedAt, exitCode };
  }

  return Object.freeze({ run });
}
