import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runVerifyCommand } from "../src/workflow/verify-runner.js";

// The runner validates cwd against the real filesystem before spawning (that's the point of the
// "missing cwd" result), so every test that isn't specifically about a missing/invalid cwd needs
// a directory that actually exists.
const REAL_CWD = mkdtempSync(join(tmpdir(), "verify-runner-real-cwd-"));
after(() => rmSync(REAL_CWD, { recursive: true, force: true }));

function makeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    child.killSignals.push(signal);
    child.emit("close", null, signal);
    return true;
  };
  return child;
}

// Mirrors the fakeSpawn helper in test/workflow-process.test.js: records every
// invocation and lets each test script exactly what the fake child does.
function fakeSpawn(calls, scenarios = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = makeChildProcess();
    const scenario = scenarios.shift();
    if (scenario) {
      queueMicrotask(() => scenario(child));
    } else {
      queueMicrotask(() => child.emit("close", 0, null));
    }
    return child;
  };
}

function fakeClock(start = 1000, stepMs = 10) {
  let current = start;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}

test("a zero exit is reported as passed", async () => {
  const calls = [];
  const result = await runVerifyCommand("pnpm typecheck", {
    cwd: REAL_CWD,
    spawnProcess: fakeSpawn(calls, [
      (child) => {
        child.stdout.emit("data", "tsc: no errors\n");
        child.emit("close", 0, null);
      },
    ]),
    now: fakeClock(),
  });

  assert.equal(result.command, "pnpm typecheck");
  assert.equal(result.cwd, REAL_CWD);
  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "tsc: no errors\n");
  assert.equal(result.truncated, false);
  assert.equal(result.durationMs, 10);
  assert.equal(result.reason, undefined);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/bin/sh");
  assert.deepEqual(calls[0].args, ["-c", "pnpm typecheck"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, REAL_CWD);
});

test("a non-zero exit is reported as failed with its exit code", async () => {
  const result = await runVerifyCommand("pnpm biome:check", {
    cwd: REAL_CWD,
    spawnProcess: fakeSpawn([], [
      (child) => {
        child.stdout.emit("data", "1 file has lint errors\n");
        child.emit("close", 3, null);
      },
    ]),
    now: fakeClock(),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 3);
  assert.equal(result.output, "1 file has lint errors\n");
});

test("a command that exceeds timeoutMs is reported as timed-out", async () => {
  const calls = [];
  const result = await runVerifyCommand("pnpm ci:verify", {
    cwd: REAL_CWD,
    timeoutMs: 5,
    spawnProcess: fakeSpawn(calls, [() => {}]),
    now: fakeClock(),
  });

  assert.equal(result.status, "timed-out");
  assert.equal(result.exitCode, null);
  assert.match(result.reason, /timed out after 5ms/);
  assert.equal(calls[0].command, "/bin/sh");
});

test("a spawn error is reported as error with a reason", async () => {
  const result = await runVerifyCommand("pnpm typecheck", {
    cwd: REAL_CWD,
    spawnProcess: fakeSpawn([], [
      (child) => child.emit("error", new Error("ENOENT: /bin/sh not found")),
    ]),
    now: fakeClock(),
  });

  assert.equal(result.status, "error");
  assert.equal(result.exitCode, null);
  assert.match(result.reason, /ENOENT: \/bin\/sh not found/);
});

test("a spawnProcess that throws synchronously is reported as error, not thrown", async () => {
  const result = await runVerifyCommand("pnpm typecheck", {
    cwd: REAL_CWD,
    spawnProcess: () => {
      throw new Error("boom");
    },
    now: fakeClock(),
  });

  assert.equal(result.status, "error");
  assert.equal(result.exitCode, null);
  assert.match(result.reason, /boom/);
});

test("a missing cwd is reported as error without invoking spawnProcess", async () => {
  const missingDir = join(tmpdir(), `verify-runner-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assert.equal(existsSync(missingDir), false, "precondition: the directory must not exist");

  const calls = [];
  const result = await runVerifyCommand("pnpm typecheck", {
    cwd: missingDir,
    spawnProcess: fakeSpawn(calls),
    now: fakeClock(),
  });

  assert.equal(result.status, "error");
  assert.equal(result.exitCode, null);
  assert.match(result.reason, /cwd/i);
  assert.equal(calls.length, 0, "spawnProcess must not be invoked for a cwd that does not exist");
});

test("a cwd that is a file, not a directory, is reported as error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-runner-file-"));
  const filePath = join(dir, "not-a-directory");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(filePath, "not a directory");

  try {
    const calls = [];
    const result = await runVerifyCommand("pnpm typecheck", {
      cwd: filePath,
      spawnProcess: fakeSpawn(calls),
      now: fakeClock(),
    });

    assert.equal(result.status, "error");
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output beyond the cap is truncated and marked as truncated", async () => {
  const result = await runVerifyCommand("pnpm ci:verify", {
    cwd: REAL_CWD,
    maxOutputBytes: 100,
    spawnProcess: fakeSpawn([], [
      (child) => {
        child.stdout.emit("data", "a".repeat(80));
        child.stdout.emit("data", "b".repeat(80));
        child.emit("close", 0, null);
      },
    ]),
    now: fakeClock(),
  });

  assert.equal(result.output.length, 100);
  assert.equal(result.output, "a".repeat(80) + "b".repeat(20));
  assert.equal(result.truncated, true);
  // Still reports the real exit status even though output was capped.
  assert.equal(result.status, "passed");
});

test("output under the cap is not marked as truncated", async () => {
  const result = await runVerifyCommand("pnpm ci:verify", {
    cwd: REAL_CWD,
    maxOutputBytes: 100,
    spawnProcess: fakeSpawn([], [
      (child) => {
        child.stdout.emit("data", "short output");
        child.emit("close", 0, null);
      },
    ]),
    now: fakeClock(),
  });

  assert.equal(result.truncated, false);
});

test("stdout and stderr both count toward the same bounded output", async () => {
  const result = await runVerifyCommand("pnpm ci:verify", {
    cwd: REAL_CWD,
    maxOutputBytes: 20,
    spawnProcess: fakeSpawn([], [
      (child) => {
        child.stdout.emit("data", "1234567890");
        child.stderr.emit("data", "1234567890");
        child.stderr.emit("data", "extra that should be dropped");
        child.emit("close", 0, null);
      },
    ]),
    now: fakeClock(),
  });

  assert.equal(result.output.length, 20);
  assert.equal(result.truncated, true);
});

test("a data chunk that cannot be stringified does not crash the run", async () => {
  // Real spawn only ever emits Buffers here, but stdout/stderr listeners run inside the child's
  // own event emission, outside the promise chain runVerifyCommand awaits — so a hostile or
  // buggy chunk must not escape as an uncaught exception. See appendSafely in verify-runner.js.
  const hostileChunk = {
    toString() {
      throw new Error("cannot stringify");
    },
  };

  const result = await runVerifyCommand("pnpm typecheck", {
    cwd: REAL_CWD,
    spawnProcess: fakeSpawn([], [
      (child) => {
        child.stdout.emit("data", hostileChunk);
        child.stdout.emit("data", "still captured after the bad chunk\n");
        child.emit("close", 0, null);
      },
    ]),
    now: fakeClock(),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.output, "still captured after the bad chunk\n");
});

test("never throws for any documented failure mode", async () => {
  const scenarios = [
    { spawnProcess: fakeSpawn([], [(child) => child.emit("error", new Error("spawn failed"))]) },
    { spawnProcess: fakeSpawn([], [() => {}]), timeoutMs: 1 },
    { spawnProcess: () => { throw new Error("sync throw"); } },
    { cwd: "/definitely/does/not/exist/anywhere", spawnProcess: fakeSpawn([]) },
  ];

  for (const options of scenarios) {
    await assert.doesNotReject(async () => {
      const result = await runVerifyCommand("pnpm typecheck", { cwd: REAL_CWD, now: fakeClock(), ...options });
      assert.ok(result && typeof result === "object");
      assert.ok(["passed", "failed", "timed-out", "error"].includes(result.status));
    });
  }
});

// Step 4: this is the property the shell decision exists for. Whitespace-splitting
// "echo a && echo b" would run `echo` with literal args "a", "&&", "echo", "b" and
// never produce the second line; /bin/sh -c is what makes this work. Skips cleanly
// on a host without /bin/sh instead of failing.
const hasRealShell = existsSync("/bin/sh");

test(
  "sh -c runs shell syntax for real: '&&' produces both lines",
  { skip: hasRealShell ? false : "no /bin/sh on this host" },
  async () => {
    const result = await runVerifyCommand("echo a && echo b", { cwd: process.cwd() });

    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.trim(), "a\nb");
  },
);
