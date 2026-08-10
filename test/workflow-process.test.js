import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// B1: the timeout bounds the wall clock instead of only signalling.
//
// Measured against this file's own repro before the fix (see
// .superpowers/sdd/2026-08-09-bounded-spawns/task-1-report.md): `sh -c 'sleep 30'` with
// `timeoutMs: 500` rejected at 30,205ms with the message still reading `timed out after 500ms`,
// and `sh -c '(sleep 30 &) ; echo done'` with the same timeout RESOLVED at 30,201ms. The timeout
// signalled the direct child only and the promise settled on `close`, which waits for every writer
// on the inherited stdio pipes -- including a backgrounded grandchild the signal never reached.
// ---------------------------------------------------------------------------

// A child under this runner's own control, unlike fakeSpawn's: its `kill` records the signal and
// does nothing else, so a test decides exactly which of `exit`/`close` ever arrives. That is the
// distinction under test -- `exit` says the child itself is gone, `close` says every writer on its
// pipes is gone, and only the first of those is something this runner can bring about.
function makeManualChild({ pid = null, onKill } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killSignals.push(signal);
    onKill?.(child, signal);
    return true;
  };
  return child;
}

test("spawns detached so a timeout can signal the child's whole process group", async () => {
  const calls = [];
  const runner = createProcessRunner({ spawnImpl: fakeSpawn(calls) });

  await runner.run("git", ["status"]);

  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, false);
});

// The three tests below carry an explicit per-test `timeout` because the property under test is
// "this settles at all": without it, a regression does not fail the suite, it hangs it -- which is
// exactly what the pre-fix implementation did when this file was first run against it.
test("a timed-out run rejects even when the child's own exit was clean", { timeout: 10_000 }, async () => {
  // The backgrounded-grandchild shape in miniature: the direct child exited 0 with no signal, and
  // `close` only arrives later because something else was holding the pipes. Before the fix this
  // resolved with code 0 long past the deadline; the deadline having passed is what decides.
  const child = makeManualChild();
  const runner = createProcessRunner({ spawnImpl: () => child });

  const promise = runner.run("git", ["status"], { timeoutMs: 20, killGraceMs: 5000 });
  setTimeout(() => child.emit("close", 0, null), 60);

  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.category, "PROCESS");
    assert.equal(error.exitCode, 12);
    assert.equal(error.details.reason, "timeout");
    assert.match(error.message, /timed out after 20ms/);
    return true;
  });
});

test("a timed-out run settles without waiting for every pipe to close", { timeout: 10_000 }, async () => {
  // The child itself is gone (`exit`), but `close` never arrives because a writer this runner does
  // not control still holds the pipes. killGraceMs is set far past the assertion window so that a
  // settle waiting on `close` -- or on the SIGKILL escalation -- cannot pass this by accident.
  const child = makeManualChild({
    onKill: (target, signal) => queueMicrotask(() => target.emit("exit", null, signal)),
  });
  const runner = createProcessRunner({ spawnImpl: () => child });

  const start = Date.now();
  await assert.rejects(
    runner.run("git", ["status"], { timeoutMs: 50, killGraceMs: 10_000 }),
    (error) => {
      assert.equal(error.details.reason, "timeout");
      return true;
    },
  );
  const wall = Date.now() - start;

  assert.ok(wall < 1000, `expected the settle not to wait for close, took ${wall}ms`);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
});

test("a child that never exits at all is still bounded by timeoutMs plus killGraceMs", { timeout: 10_000 }, async () => {
  // Nothing arrives: no `exit`, no `close`, and the signals are swallowed. The wall clock is held
  // up by the escalation and then by the settle that follows it, not by the child.
  const child = makeManualChild();
  const runner = createProcessRunner({ spawnImpl: () => child });

  const start = Date.now();
  await assert.rejects(
    runner.run("git", ["status"], { timeoutMs: 100, killGraceMs: 150 }),
    (error) => {
      assert.equal(error.details.reason, "timeout");
      assert.equal(error.details.code, null);
      return true;
    },
  );
  const wall = Date.now() - start;

  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(wall >= 250, `expected the escalation to run before settling, took ${wall}ms`);
  assert.ok(wall < 2000, `expected timeoutMs + killGraceMs to bound the wall clock, took ${wall}ms`);
});

test("output emitted after exit is still captured when close arrives normally", async () => {
  // The cost of the choice above, stated as a test: an untimed run still settles on `close`, so a
  // command whose last chunks land between `exit` and `close` keeps them. Only the timeout path
  // gives that up, and only because the alternative is waiting forever.
  const child = makeManualChild();
  const runner = createProcessRunner({ spawnImpl: () => child });

  const promise = runner.run("git", ["status"]);
  queueMicrotask(() => {
    child.emit("exit", 0, null);
    child.stdout.emit("data", "trailing output");
    child.emit("close", 0, null);
  });

  assert.deepEqual(await promise, { code: 0, stdout: "trailing output", stderr: "" });
});

// ---------------------------------------------------------------------------
// The interrupt trap. `detached: true` above is what lets a timeout reach a backgrounded
// grandchild's process group -- and the same detachment takes the child out of THIS process's
// group, so a terminal's Ctrl-C stops reaching it (the exact regression item 2.3 shipped and then
// had to close inside verify-runner.js). Unlike that one, this runner spawns many children,
// sometimes concurrently, so the accounting is the test: registered while a child is alive, gone
// when none is, and never one listener per child.
// ---------------------------------------------------------------------------

function signalListenerCounts() {
  return {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
}

test("the interrupt trap is registered while a child is alive and gone once it settles", async () => {
  const baseline = signalListenerCounts();
  const child = makeManualChild();
  const runner = createProcessRunner({ spawnImpl: () => child });

  const promise = runner.run("git", ["status"]);
  const during = signalListenerCounts();
  child.emit("close", 0, null);
  await promise;
  const after = signalListenerCounts();

  assert.equal(during.SIGINT, baseline.SIGINT + 1, "a live child must have the trap installed");
  assert.equal(during.SIGTERM, baseline.SIGTERM + 1, "a live child must have the trap installed");
  assert.deepEqual(after, baseline, "no child alive means no trap registered");
});

test("the interrupt trap does not accumulate across sequential or concurrent spawns", async () => {
  const baseline = signalListenerCounts();
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);

  try {
    // Sequential: ten runs, one after another, must leave nothing behind.
    for (let index = 0; index < 10; index += 1) {
      const child = makeManualChild();
      const runner = createProcessRunner({ spawnImpl: () => child });
      const promise = runner.run("git", ["status"]);
      child.emit("close", 0, null);
      await promise;
    }
    assert.deepEqual(signalListenerCounts(), baseline, "sequential spawns must not accumulate listeners");

    // Concurrent: twenty children alive at once -- twice node's own 10-listener warning threshold,
    // which is exactly the leak this asserts against.
    const children = [];
    const promises = [];
    for (let index = 0; index < 20; index += 1) {
      const child = makeManualChild();
      children.push(child);
      promises.push(createProcessRunner({ spawnImpl: () => child }).run("git", ["status"]));
    }
    const during = signalListenerCounts();
    assert.equal(during.SIGINT, baseline.SIGINT + 1, "twenty live children must not mean twenty listeners");
    assert.equal(during.SIGTERM, baseline.SIGTERM + 1, "twenty live children must not mean twenty listeners");
    assert.ok(
      during.SIGINT <= process.getMaxListeners(),
      `expected to stay under node's listener warning threshold, had ${during.SIGINT}`,
    );

    for (const child of children) child.emit("close", 0, null);
    await Promise.all(promises);
    assert.deepEqual(signalListenerCounts(), baseline, "concurrent spawns must not accumulate listeners");
    assert.deepEqual(
      warnings.filter((warning) => warning.name === "MaxListenersExceededWarning"),
      [],
      "no listener-leak warning may be emitted",
    );
  } finally {
    process.removeListener("warning", onWarning);
  }
});

// ---------------------------------------------------------------------------
// Real processes. Everything above proves the wiring; these prove the property, with a real
// process group, a real kernel, and `ps` as the witness that nothing survived.
// ---------------------------------------------------------------------------

const hasRealShell = existsSync("/bin/sh");

function psSnapshot() {
  try {
    return execFileSync("ps", ["-eo", "pid,cmd"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

// Matches on `sleep <marker>` rather than the bare marker so the fixture subprocess that carries
// the same number on its own command line is never mistaken for the child under test.
function markerPids(marker) {
  return psSnapshot()
    .split("\n")
    .filter((line) => line.includes(`sleep ${marker}`))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// Last-resort cleanup so a failing assertion cannot leave a multi-day `sleep` behind on the
// machine that ran the suite. Never a substitute for the assertion itself: the tests below assert
// the marker is gone BEFORE this runs.
function killMarker(marker) {
  for (const pid of markerPids(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return predicate();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test(
  "a real command that outlives its timeout is bounded by the wall clock, not just signalled",
  { skip: hasRealShell ? false : "no /bin/sh on this host", timeout: 30_000 },
  async () => {
    // Distinctive sleep duration so a `ps` match cannot collide with an unrelated sleep this
    // machine happens to be running, and long enough that only the timeout under test can end it.
    const marker = "194901";
    const runner = createProcessRunner();

    try {
      const start = Date.now();
      await assert.rejects(
        runner.run("sh", ["-c", `sleep ${marker}`], { timeoutMs: 500 }),
        (error) => {
          assert.equal(error.details.reason, "timeout");
          assert.match(error.message, /timed out after 500ms/);
          return true;
        },
      );
      const wall = Date.now() - start;

      assert.ok(wall < 4000, `expected the deadline to bound the wall clock, took ${wall}ms`);
      assert.ok(await waitUntil(() => markerPids(marker).length === 0), `expected no orphan sleep ${marker} to survive`);
    } finally {
      killMarker(marker);
    }
  },
);

test(
  "a real command that backgrounds a child and exits no longer holds the wall clock open",
  { skip: hasRealShell ? false : "no /bin/sh on this host", timeout: 30_000 },
  async () => {
    // The measured shape: the direct `sh` exits immediately, the backgrounded `sleep` inherits its
    // stdio and holds `close` open for its own full duration. Before the fix this RESOLVED with
    // code 0 at 30,201ms under a 500ms timeout.
    const marker = "194902";
    const runner = createProcessRunner();

    try {
      const start = Date.now();
      await assert.rejects(
        runner.run("sh", ["-c", `(sleep ${marker} &) ; echo done`], { timeoutMs: 500 }),
        (error) => {
          assert.equal(error.details.reason, "timeout");
          return true;
        },
      );
      const wall = Date.now() - start;

      assert.ok(wall < 4000, `expected the deadline to bound the wall clock, took ${wall}ms`);
      assert.ok(await waitUntil(() => markerPids(marker).length === 0), `expected no orphan sleep ${marker} to survive`);
    } finally {
      killMarker(marker);
    }
  },
);

test(
  "a real command that ignores SIGTERM is still bounded by timeoutMs plus killGraceMs",
  { skip: hasRealShell ? false : "no /bin/sh on this host", timeout: 30_000 },
  async () => {
    const marker = "194903";
    const runner = createProcessRunner();

    try {
      const start = Date.now();
      await assert.rejects(
        runner.run("sh", ["-c", `trap '' TERM; sleep ${marker}`], { timeoutMs: 300, killGraceMs: 400 }),
        (error) => {
          assert.equal(error.details.reason, "timeout");
          return true;
        },
      );
      const wall = Date.now() - start;

      assert.ok(wall < 4000, `expected the SIGKILL escalation to bound the wall clock, took ${wall}ms`);
      assert.ok(await waitUntil(() => markerPids(marker).length === 0), `expected no orphan sleep ${marker} to survive`);
    } finally {
      killMarker(marker);
    }
  },
);

test(
  "an interrupt (SIGINT) to the CLI's own process group kills the running child too, not just the CLI",
  { timeout: 30_000 },
  async () => {
    // A real subprocess standing in for the CLI, spawned as the leader of its own process group so
    // that signalling `-child.pid` reproduces what a terminal does on Ctrl-C: it signals the whole
    // foreground group, never one pid. Without the trap, the detached `sleep` is reparented to init
    // and outlives the interrupted CLI with no bound at all -- the timeout that would have killed
    // it lives inside the process that just exited.
    const marker = "194904";
    const scriptPath = join(import.meta.dirname, "support", "process-signal-child.mjs");
    const child = spawn(process.execPath, [scriptPath, marker], { detached: true, stdio: "ignore" });

    let childExited = false;
    child.once("exit", () => {
      childExited = true;
    });

    try {
      assert.ok(
        await waitUntil(() => markerPids(marker).length > 0),
        "precondition: the sleep must actually be running before the interrupt is sent",
      );

      const start = Date.now();
      process.kill(-child.pid, "SIGINT");

      const cliExited = await waitUntil(() => childExited, { timeoutMs: 5000 });
      assert.ok(cliExited, `expected the CLI subprocess to exit after SIGINT; still running after ${Date.now() - start}ms`);

      const orphanGone = await waitUntil(() => markerPids(marker).length === 0, { timeoutMs: 5000 });
      assert.ok(orphanGone, `expected the sleep to be gone once the CLI handled SIGINT; still present after ${Date.now() - start}ms`);
    } finally {
      if (!childExited) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      killMarker(marker);
    }
  },
);
