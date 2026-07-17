import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createProcessRunner } from "../src/workflow/process.js";
import { WorkflowError } from "../src/workflow/errors.js";

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

test("passes arguments without shell interpolation", async () => {
  const calls = [];
  const runner = createProcessRunner({ spawnImpl: fakeSpawn(calls) });

  const result = await runner.run("git", ["check-ref-format", "branch", "$(touch /tmp/bad)"]);

  assert.deepEqual(calls[0].args, ["check-ref-format", "branch", "$(touch /tmp/bad)"]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
});

test("forwards cwd and env while keeping shell disabled", async () => {
  const calls = [];
  const runner = createProcessRunner({ spawnImpl: fakeSpawn(calls) });
  const env = { PATH: "/tmp/bin", WORKFLOW_TEST: "1" };

  await runner.run("git", ["status"], {
    cwd: "/tmp/repo",
    env,
  });

  assert.equal(calls[0].options.cwd, "/tmp/repo");
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.shell, false);
});

test("bounds collected stdout and stderr to 12000 characters", async () => {
  const calls = [];
  const runner = createProcessRunner({
    spawnImpl: fakeSpawn(calls, [
      (child) => {
        child.stdout.emit("data", "a".repeat(15000));
        child.stderr.emit("data", "b".repeat(14000));
        child.emit("close", 0, null);
      },
    ]),
  });

  const result = await runner.run("git", ["status"]);

  assert.equal(result.stdout.length, 12000);
  assert.equal(result.stderr.length, 12000);
  assert.equal(result.stdout, "a".repeat(12000));
  assert.equal(result.stderr, "b".repeat(12000));
});

test("throws a PROCESS error with timeout diagnostics", async () => {
  const calls = [];
  const runner = createProcessRunner({
    spawnImpl: fakeSpawn(calls, [() => {}]),
  });

  await assert.rejects(
    runner.run("git", ["status"], { timeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PROCESS");
      assert.match(error.message, /timed out/i);
      assert.equal(error.details.reason, "timeout");
      assert.equal(calls[0].command, "git");
      return true;
    },
  );
});

test("throws a PROCESS error when spawn emits an error", async () => {
  const runner = createProcessRunner({
    spawnImpl: fakeSpawn([], [
      (child) => child.emit("error", new Error("spawn exploded")),
    ]),
  });

  await assert.rejects(
    runner.run("git", ["status"]),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PROCESS");
      assert.match(error.message, /spawn exploded/);
      assert.equal(error.details.reason, "spawn");
      return true;
    },
  );
});

test("throws a PROCESS error for nonzero exits unless allowFailure is enabled", async () => {
  const runner = createProcessRunner({
    spawnImpl: fakeSpawn([], [
      (child) => {
        child.stdout.emit("data", "ok");
        child.stderr.emit("data", "problem");
        child.emit("close", 7, null);
      },
    ]),
  });

  await assert.rejects(
    runner.run("git", ["status"]),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PROCESS");
      assert.match(error.message, /exit code 7/i);
      assert.equal(error.details.code, 7);
      assert.equal(error.details.stdout, "ok");
      assert.equal(error.details.stderr, "problem");
      return true;
    },
  );
});

test("returns nonzero exits when allowFailure is enabled", async () => {
  const runner = createProcessRunner({
    spawnImpl: fakeSpawn([], [
      (child) => {
        child.stderr.emit("data", "problem");
        child.emit("close", 7, null);
      },
    ]),
  });

  const result = await runner.run("git", ["status"], { allowFailure: true });

  assert.deepEqual(result, { code: 7, stdout: "", stderr: "problem" });
});
