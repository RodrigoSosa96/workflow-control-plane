import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// killChild's group branch. Every makeManualChild above leaves `pid` null, which is the direct-kill
// fallback -- so without these two the group signal is only ever exercised through a real process,
// and the fallback path is only ever exercised by accident. `process.kill` is swapped for the
// duration rather than given a real pid: signalling `-1234` for real would hit whatever process
// group happens to own that number on the machine running the suite. node:test runs the tests in
// this file one at a time, so the swap is not visible to anything else.
async function withStubbedProcessKill(stub, body) {
  const original = process.kill;
  const calls = [];
  process.kill = (pid, signal) => {
    calls.push({ pid, signal });
    return stub(pid, signal);
  };
  try {
    return await body(calls);
  } finally {
    process.kill = original;
  }
}

test("a timeout signals the child's process group, not the child alone", { timeout: 10_000 }, async () => {
  const child = makeManualChild({ pid: 4321 });
  const runner = createProcessRunner({ spawnImpl: () => child });

  await withStubbedProcessKill(() => true, async (kills) => {
    const promise = runner.run("git", ["status"], { timeoutMs: 20, killGraceMs: 5000 });
    setTimeout(() => child.emit("close", null, "SIGTERM"), 80);
    await assert.rejects(promise, (error) => error.details.reason === "timeout");

    assert.deepEqual(kills, [{ pid: -4321, signal: "SIGTERM" }], "the negated pid is the process group");
    assert.deepEqual(child.killSignals, [], "the direct kill is a fallback, not the first choice");
  });
});

test("a group signal that fails falls back to killing the child directly", { timeout: 10_000 }, async () => {
  const child = makeManualChild({ pid: 4321 });
  const runner = createProcessRunner({ spawnImpl: () => child });

  await withStubbedProcessKill(
    () => {
      const error = new Error("ESRCH: no such process group");
      error.code = "ESRCH";
      throw error;
    },
    async (kills) => {
      const promise = runner.run("git", ["status"], { timeoutMs: 20, killGraceMs: 5000 });
      setTimeout(() => child.emit("close", null, "SIGTERM"), 80);
      await assert.rejects(promise, (error) => error.details.reason === "timeout");

      assert.deepEqual(kills, [{ pid: -4321, signal: "SIGTERM" }], "the group is tried first");
      assert.deepEqual(child.killSignals, ["SIGTERM"], "and the child directly when that throws");
    },
  );
});

// ---------------------------------------------------------------------------
// Real processes. Everything above proves the wiring; these prove the property, with a real
// process group, a real kernel, and `ps` as the witness that nothing survived.
// ---------------------------------------------------------------------------

const hasRealShell = existsSync("/bin/sh");

// The interrupt tests below send a signal to a process GROUP (`process.kill(-pid, …)`), which is
// POSIX-only -- the one thing in this file that cannot work on Windows at all, where its siblings
// only need `/bin/sh`. CI is ubuntu, so this changes nothing today; it is here so the guard names
// the real requirement instead of borrowing a neighbour's.
const posixGroups = process.platform !== "win32";
const skipWithoutGroups = posixGroups ? false : "process groups are POSIX-only";
const skipWithoutShellAndGroups = hasRealShell
  ? skipWithoutGroups
  : "no /bin/sh on this host";

function psSnapshot() {
  try {
    return execFileSync("ps", ["-eo", "pid,cmd"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

// Excluding the fixture is load-bearing, not tidiness. The fixture takes the command to run as its
// own argv, so `ps` shows `node process-signal-child.mjs <cwd> sh -c '… sleep <marker>'` alongside
// the real child -- and a precondition that waits for the marker to APPEAR was satisfied by the
// fixture itself, before it had spawned anything or installed the trap. The interrupt then landed
// on a process with no trap, node's default SIGINT killed it outright, and the tests failed
// claiming the child had been SIGKILLed. Caught by those failures, not by review.
const FIXTURE_SCRIPT = "process-signal-child.mjs";

function markerPids(marker) {
  return psSnapshot()
    .split("\n")
    .filter((line) => line.includes(`sleep ${marker}`) && !line.includes(FIXTURE_SCRIPT))
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

// A real subprocess standing in for the CLI, spawned as the leader of its own process group so that
// signalling `-child.pid` reproduces what a terminal does on Ctrl-C: it signals the whole foreground
// group, never one pid.
function spawnInterruptibleCli(cwd, command, ...args) {
  const { env, commandArgs } = typeof cwd === "object" && cwd !== null
    ? { env: cwd.env, commandArgs: [cwd.cwd, command, ...args] }
    : { env: undefined, commandArgs: [cwd, command, ...args] };
  const scriptPath = join(import.meta.dirname, "support", "process-signal-child.mjs");
  const child = spawn(process.execPath, [scriptPath, ...commandArgs], {
    detached: true,
    stdio: "ignore",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const state = { exited: false, code: null, signal: null };
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
  });
  return { child, state };
}

function killCli(child, state) {
  if (state.exited) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

test(
  "an interrupt (SIGINT) to the CLI's own process group kills the running child too, not just the CLI",
  { skip: skipWithoutGroups, timeout: 30_000 },
  async () => {
    // Without the trap, the detached child is reparented to init and outlives the interrupted CLI
    // with no bound at all -- the timeout that would have killed it lives inside the process that
    // just exited.
    const marker = "194904";
    const { child, state } = spawnInterruptibleCli(import.meta.dirname, "sleep", marker);

    try {
      assert.ok(
        await waitUntil(() => markerPids(marker).length > 0),
        "precondition: the sleep must actually be running before the interrupt is sent",
      );

      const start = Date.now();
      process.kill(-child.pid, "SIGINT");

      const cliExited = await waitUntil(() => state.exited, { timeoutMs: 5000 });
      assert.ok(cliExited, `expected the CLI subprocess to exit after SIGINT; still running after ${Date.now() - start}ms`);

      const orphanGone = await waitUntil(() => markerPids(marker).length === 0, { timeoutMs: 5000 });
      assert.ok(orphanGone, `expected the sleep to be gone once the CLI handled SIGINT; still present after ${Date.now() - start}ms`);
    } finally {
      killCli(child, state);
      killMarker(marker);
    }
  },
);

// R2 (review): the trap used to send SIGKILL, which is uncatchable -- so an interrupted `git` never
// ran its own cleanup and left `.git/index.lock` behind. These three cover the corrected policy:
// forward what was received, escalate only if that is ignored, and let a second interrupt skip the
// wait. The lockfile test further down is the property they exist for.
test(
  "an interrupt forwards the signal it received, so the command can still clean up after itself",
  { skip: skipWithoutShellAndGroups, timeout: 30_000 },
  async (t) => {
    const marker = "194905";
    const scratch = await mkdtemp(join(tmpdir(), "workflow-process-signal-"));
    t.after(async () => {
      await rm(scratch, { recursive: true, force: true });
    });
    const witness = join(scratch, "caught-int");

    // A command that can only produce this file if it received a CATCHABLE signal. SIGKILL cannot
    // be trapped, so an empty scratch directory at the end is exactly the old behaviour.
    const { child, state } = spawnInterruptibleCli(
      scratch,
      "sh",
      "-c",
      `trap 'echo caught > ${witness}; exit 0' INT; sleep ${marker}`,
    );

    try {
      assert.ok(
        await waitUntil(() => markerPids(marker).length > 0),
        "precondition: the command must be running before the interrupt is sent",
      );

      process.kill(-child.pid, "SIGINT");

      assert.ok(await waitUntil(() => state.exited, { timeoutMs: 8000 }), "expected the CLI subprocess to exit");
      assert.ok(existsSync(witness), "expected the child to receive SIGINT itself, not an uncatchable SIGKILL");
      assert.ok(await waitUntil(() => markerPids(marker).length === 0), "expected no orphan to survive the interrupt");
    } finally {
      killCli(child, state);
      killMarker(marker);
    }
  },
);

test(
  "a run interrupted mid-flight never hands control back to its caller",
  { skip: skipWithoutShellAndGroups, timeout: 30_000 },
  async (t) => {
    // The child exits cleanly the instant it is interrupted, which is exactly the case that used to
    // settle the promise: a caller would take that ordinary-looking result and start its NEXT step
    // -- removing a worktree, say -- inside a process already on its way out. The fixture writes
    // the witness file the moment its run settles, so an absent file is the assertion.
    const marker = "194909";
    const scratch = await mkdtemp(join(tmpdir(), "workflow-process-settle-"));
    t.after(async () => {
      await rm(scratch, { recursive: true, force: true });
    });
    const settleWitness = join(scratch, "settled");

    const { child, state } = spawnInterruptibleCli(
      { cwd: scratch, env: { WORKFLOW_TEST_SETTLE_WITNESS: settleWitness } },
      "sh",
      "-c",
      `trap 'exit 0' INT; sleep ${marker}`,
    );

    try {
      assert.ok(
        await waitUntil(() => markerPids(marker).length > 0),
        "precondition: the command must be running before the interrupt is sent",
      );

      process.kill(-child.pid, "SIGINT");

      assert.ok(await waitUntil(() => state.exited, { timeoutMs: 8000 }), "expected the CLI subprocess to exit");
      assert.equal(state.code, 130, "the process must exit through the trap (128 + SIGINT), not through a settled run");
      assert.equal(existsSync(settleWitness), false, "a run must not settle into its caller while a shutdown is draining");
    } finally {
      killCli(child, state);
      killMarker(marker);
    }
  },
);

test(
  "an interrupt with two runs in flight hands control back to neither caller",
  { skip: skipWithoutShellAndGroups, timeout: 30_000 },
  async (t) => {
    // The single-child case above is saved by `process.exit` preempting the settle from inside
    // `releaseChild`. With TWO children alive that preemption does not fire for the first one to
    // die -- the registry is not empty yet -- so without the `shuttingDown` guard in `settle` its
    // promise resolves mid-shutdown and the fixture exits 0 from that `.then`, witness written.
    // Here the first command exits on the forwarded SIGINT while the second ignores it: only the
    // escalation (a full grace window later) can end the run, which is also what makes the timing
    // assertion meaningful.
    const markerA = "194910";
    const markerB = "194911";
    const scratch = await mkdtemp(join(tmpdir(), "workflow-process-settle2-"));
    t.after(async () => {
      await rm(scratch, { recursive: true, force: true });
    });
    const witnessA = join(scratch, "settled-a");
    const witnessB = join(scratch, "settled-b");

    const { child, state } = spawnInterruptibleCli(
      {
        cwd: scratch,
        env: {
          WORKFLOW_TEST_SETTLE_WITNESS: witnessA,
          WORKFLOW_TEST_ALSO: JSON.stringify(["sh", "-c", `trap '' INT; sleep ${markerB}`]),
          WORKFLOW_TEST_SETTLE_WITNESS_2: witnessB,
        },
      },
      "sh",
      "-c",
      `trap 'exit 0' INT; sleep ${markerA}`,
    );

    try {
      assert.ok(
        await waitUntil(() => markerPids(markerA).length > 0 && markerPids(markerB).length > 0),
        "precondition: both commands must be running before the interrupt is sent",
      );

      const start = Date.now();
      process.kill(-child.pid, "SIGINT");

      assert.ok(await waitUntil(() => state.exited, { timeoutMs: 10_000 }), "expected the CLI subprocess to exit");
      const wall = Date.now() - start;
      assert.equal(state.code, 130, "the process must exit through the trap (128 + SIGINT), never through a settled run");
      assert.ok(
        wall >= 1500,
        `expected the run to sit out the escalation window (~2s) because one child ignored SIGINT; exited after ${wall}ms, which means something settled early`,
      );
      assert.equal(existsSync(witnessA), false, "the first run to die must not settle while the second is still draining");
      assert.equal(existsSync(witnessB), false, "the interrupted run must not settle either");
      assert.ok(await waitUntil(() => markerPids(markerA).length === 0 && markerPids(markerB).length === 0), "expected no orphan to survive");
    } finally {
      killCli(child, state);
      killMarker(markerA);
      killMarker(markerB);
    }
  },
);

test(
  "an interrupt still escalates to SIGKILL when the forwarded signal is ignored",
  { skip: skipWithoutShellAndGroups, timeout: 30_000 },
  async () => {
    // `trap '' INT` is inherited across exec, so the `sleep` ignores SIGINT too: nothing in this
    // group can be ended by the forwarded signal, and only the escalation can end the run.
    const marker = "194906";
    const { child, state } = spawnInterruptibleCli(import.meta.dirname, "sh", "-c", `trap '' INT; sleep ${marker}`);

    try {
      assert.ok(
        await waitUntil(() => markerPids(marker).length > 0),
        "precondition: the command must be running before the interrupt is sent",
      );

      const start = Date.now();
      process.kill(-child.pid, "SIGINT");

      const cliExited = await waitUntil(() => state.exited, { timeoutMs: 10_000 });
      const wall = Date.now() - start;
      assert.ok(cliExited, `expected the escalation to end the CLI subprocess; still running after ${wall}ms`);
      assert.ok(wall < 8000, `expected the escalation to bound the wall clock, took ${wall}ms`);
      assert.ok(
        await waitUntil(() => markerPids(marker).length === 0),
        "expected SIGKILL to reach the group that ignored the interrupt",
      );
    } finally {
      killCli(child, state);
      killMarker(marker);
    }
  },
);

test(
  "a second interrupt does not wait out the escalation window",
  { skip: skipWithoutShellAndGroups, timeout: 30_000 },
  async () => {
    const marker = "194908";
    const { child, state } = spawnInterruptibleCli(import.meta.dirname, "sh", "-c", `trap '' INT; sleep ${marker}`);

    try {
      assert.ok(
        await waitUntil(() => markerPids(marker).length > 0),
        "precondition: the command must be running before the interrupt is sent",
      );

      process.kill(-child.pid, "SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const start = Date.now();
      process.kill(-child.pid, "SIGINT");

      const cliExited = await waitUntil(() => state.exited, { timeoutMs: 10_000 });
      const wall = Date.now() - start;
      assert.ok(cliExited, `expected the CLI subprocess to exit; still running after ${wall}ms`);
      // The escalation window is 2s. A second interrupt must not sit through the rest of it.
      assert.ok(wall < 1500, `expected the second interrupt to exit immediately, took ${wall}ms`);
      assert.ok(await waitUntil(() => markerPids(marker).length === 0), "expected no orphan to survive");
    } finally {
      killCli(child, state);
      killMarker(marker);
    }
  },
);

// The policy above exists because this runner fronts repository MUTATIONS (`git merge --no-ff`,
// `git worktree add`, `git worktree remove`), where a command that cannot run its own cleanup leaves
// state behind. This is that case with real git rather than a shell trap: an interrupted `git` must
// be reached by the interrupt itself and must leave the repository in a state the next git command
// accepts.
//
// It deliberately does NOT assert on `.git/index.lock`. The review that found this reported a
// measured table where an interrupted `git commit` held `index.lock` across a slow `pre-commit`
// hook; probed here against git 2.43, no `*.lock` exists anywhere under `.git` during pre-commit,
// prepare-commit-msg, commit-msg, post-commit, post-merge or post-checkout, nor while a blocking
// `GIT_EDITOR` is open -- this git releases the index lock before handing control to any of them.
// Asserting a lock that this git never creates would be a test that passes for the wrong reason, so
// what is asserted is the property that does hold everywhere: the signal reaches git, and the
// repository is left usable.
test(
  "an interrupt during a real git command reaches git and leaves the repository usable",
  { skip: skipWithoutShellAndGroups, timeout: 30_000 },
  async (t) => {
    const marker = "194907";
    const root = await mkdtemp(join(tmpdir(), "workflow-process-git-"));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const repoPath = join(root, "repo");
    const git = (...args) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
    execFileSync("git", ["init", "--initial-branch=main", repoPath], { encoding: "utf8" });
    git("config", "user.name", "Workflow Tests");
    git("config", "user.email", "workflow@example.test");
    git("config", "commit.gpgsign", "false");
    // Neutralises a global core.hooksPath, which would otherwise stop the hook below from running
    // and turn this test's precondition into a confusing failure on a developer machine.
    git("config", "core.hooksPath", join(repoPath, ".git", "hooks"));
    await writeFile(join(repoPath, "README.md"), "hello\n");
    git("add", "README.md");
    git("commit", "-m", "initial");

    // A hook slow enough to hold the commit open while the interrupt is delivered, so the signal
    // lands on a git that is genuinely mid-operation rather than one that already finished.
    await writeFile(join(repoPath, ".git", "hooks", "pre-commit"), `#!/bin/sh\nsleep ${marker}\n`, { mode: 0o755 });
    await writeFile(join(repoPath, "README.md"), "changed\n");
    git("add", "README.md");

    const { child, state } = spawnInterruptibleCli(repoPath, "git", "commit", "-m", "held by the hook");

    try {
      assert.ok(
        await waitUntil(() => markerPids(marker).length > 0, { timeoutMs: 10_000 }),
        "precondition: git must be mid-commit, held by its own hook, before the interrupt is sent",
      );

      process.kill(-child.pid, "SIGINT");

      assert.ok(await waitUntil(() => state.exited, { timeoutMs: 10_000 }), "expected the CLI subprocess to exit");
      assert.ok(
        await waitUntil(() => markerPids(marker).length === 0),
        "expected the interrupt to reach git's own hook child, not just the CLI",
      );

      // The repository still answers, and the interrupted commit did not land.
      const log = git("log", "--format=%s");
      assert.equal(log.trim(), "initial", "the interrupted commit must not have been created");
      assert.equal(git("status", "--porcelain=v1").includes("README.md"), true, "the staged change must still be staged");
    } finally {
      killCli(child, state);
      killMarker(marker);
    }
  },
);
