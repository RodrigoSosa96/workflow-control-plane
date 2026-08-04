import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

// The ONE place in this repo that runs a shell, and the reasoning is in the spec: these are the
// operator's own strings from their own registry, they come from no worker, and they enter no
// approval digest. Everything else keeps shell: false.
//
// Note this does not enable node's own shell option (that would let node itself choose a shell
// and quote argv0 unpredictably across platforms). Instead it spawns `/bin/sh` directly as the
// command, with the operator's string as a single `-c` argument, and passes node's shell option
// as disabled explicitly at the call site — see spawnAndCollect below — so the departure is
// visible there, not implied by omission.
//
// Never throws: a failure, a timeout, a spawn error and a missing cwd are all results, because
// the caller is producing evidence and "the check could not run" is evidence too.

// No number here is specified by the spec; both are conservative defaults for a direct caller
// that omits them. `workflow verify` (task 2) is expected to pass its own values explicitly.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes: enough for a real test suite, not unbounded.
const DEFAULT_MAX_OUTPUT_BYTES = 4000; // "a bounded head of the output" (design doc), not the whole log.

// How long to wait, after SIGTERM, before escalating to SIGKILL on a command that ignored it.
// Only matters on the timeout path (see killChild below); a command that exits or is reaped
// cleanly never touches this timer.
const DEFAULT_KILL_GRACE_MS = 2000;

const SHELL_BINARY = "/bin/sh";

function safeNow(now) {
  try {
    const value = now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

// Bounds captured output as it arrives rather than buffering everything and truncating
// afterward — a chatty test suite can emit megabytes, and the cap exists so that never happens
// even transiently. stdout and stderr both feed the same collector so a command's total captured
// output (not each stream independently) is what's bounded.
function makeOutputCollector(maxOutputBytes) {
  const cap = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
    ? Math.floor(maxOutputBytes)
    : DEFAULT_MAX_OUTPUT_BYTES;
  const chunks = [];
  let total = 0;
  let truncated = false;

  return {
    append(data) {
      if (total >= cap) {
        truncated = true;
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const remaining = cap - total;
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        total = cap;
        truncated = true;
      } else {
        chunks.push(buf);
        total += buf.length;
      }
    },
    result() {
      return { output: Buffer.concat(chunks).toString("utf8"), truncated };
    },
  };
}

async function checkCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    // A non-string or empty cwd is NOT "nothing to validate" -- node's spawn falls back silently
    // to the parent process's own cwd (this CLI's own checkout), and the command would then run
    // there and report whatever it reports there as this repository's result. That is the exact
    // false green this whole item exists to remove: a repository entry with no usable path must
    // be a recorded refusal for that repository, never a silent pass in the wrong directory.
    return "no repository path recorded";
  }
  let stats;
  try {
    stats = await stat(cwd);
  } catch {
    return `cwd not found: ${cwd}`;
  }
  if (!stats.isDirectory()) {
    return `cwd is not a directory: ${cwd}`;
  }
  return null;
}

// Sends a signal to the whole process group `child` leads, not just `child` itself. This is what
// makes a timeout actually bound the wall clock (see the top-of-file discussion this function's
// call site anchors to): `spawnAndCollect` below spawns with `detached: true`, which on POSIX
// makes `child.pid` the leader of its own new process group, so `-child.pid` reaches every
// descendant that hasn't further detached itself -- including a grandchild an operator's own
// command backgrounded with `&`, which `child.kill()` alone never could (it only ever signals
// the direct `/bin/sh` child, and a backgrounded grandchild is reparented away from it well
// before any signal is sent). Falls back to signaling `child` directly when there is no usable
// pid to form a group from (real spawn always provides one; a test double may not) -- same
// best-effort, never-throws posture every other kill site in this file already has.
function killChild(child, signal) {
  if (typeof child.pid === "number" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // No such process group (already gone) or group signaling unavailable -- fall through to a
      // direct kill below rather than assuming the job is done.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best-effort: if the process is already gone, the close handler still settles below.
  }
}

function spawnAndCollect({ command, cwd, timeoutMs, maxOutputBytes, killGraceMs, spawnProcess, now, startedAt }) {
  return new Promise((resolve) => {
    let child;
    try {
      // detached: true puts `child` at the head of its own process group (POSIX) instead of
      // this Node process's -- see killChild above for why the timeout path needs that.
      child = spawnProcess(SHELL_BINARY, ["-c", command], { cwd, shell: false, detached: true });
    } catch (error) {
      resolve({
        command,
        cwd,
        status: "error",
        exitCode: null,
        output: "",
        truncated: false,
        durationMs: safeNow(now) - startedAt,
        reason: `failed to start: ${error?.message ?? String(error)}`,
      });
      return;
    }

    const collector = makeOutputCollector(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;

    // `build` runs synchronously inside an EventEmitter's listener callback (a "close"/"error"
    // event on `child`), not inside the `await` chain that `runVerifyCommand`'s own try/catch
    // guards — a throw here would propagate out of `child.emit(...)`, not out of a promise, and
    // an async function's try/catch does not see it. Guarded here for the same "never throws"
    // guarantee, one level down.
    const settle = (build) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      let outcome;
      try {
        outcome = build();
      } catch (error) {
        outcome = {
          command,
          cwd,
          status: "error",
          exitCode: null,
          output: "",
          truncated: false,
          durationMs: safeNow(now) - startedAt,
          reason: `unexpected failure while collecting the result: ${error?.message ?? String(error)}`,
        };
      }
      resolve(outcome);
    };

    // Same reasoning: a "data" event runs the listener synchronously inside the stream's own
    // emit, outside any promise chain, so append's bookkeeping is guarded here rather than left
    // to propagate. Confirmed load-bearing: without this guard, a chunk whose stringification
    // throws aborts the emitting scenario mid-flight — the run's own "close" event never fires,
    // so the returned promise never settles. That is worse than a throw, and this is why the
    // whole event-handler surface (not just the outer async function) has to be try/catch'd.
    const appendSafely = (chunk) => {
      try {
        collector.append(chunk);
      } catch {
        // Best-effort capture; losing one chunk must not crash the run whose evidence this is.
      }
    };
    child.stdout?.on("data", appendSafely);
    child.stderr?.on("data", appendSafely);

    child.on("error", (error) => {
      settle(() => {
        const { output, truncated } = collector.result();
        return {
          command,
          cwd,
          status: "error",
          exitCode: null,
          output,
          truncated,
          durationMs: safeNow(now) - startedAt,
          reason: `failed to start: ${error?.message ?? String(error)}`,
        };
      });
    });

    child.on("close", (code, signal) => {
      settle(() => {
        const { output, truncated } = collector.result();
        const durationMs = safeNow(now) - startedAt;

        if (timedOut) {
          return {
            command,
            cwd,
            status: "timed-out",
            exitCode: code ?? null,
            output,
            truncated,
            durationMs,
            reason: `timed out after ${timeoutMs}ms`,
          };
        }

        if (signal) {
          return {
            command,
            cwd,
            status: "error",
            exitCode: code ?? null,
            output,
            truncated,
            durationMs,
            reason: `terminated by signal ${signal}`,
          };
        }

        const exitCode = code ?? 1;
        if (exitCode === 0) {
          return { command, cwd, status: "passed", exitCode, output, truncated, durationMs };
        }
        return { command, cwd, status: "failed", exitCode, output, truncated, durationMs };
      });
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild(child, "SIGTERM");
        // A command (or something it backgrounded) that ignores SIGTERM would otherwise hold
        // this promise open exactly as long as it likes -- the property the timeout exists to
        // rule out. This grace window is the escalation: if `close` still hasn't arrived once it
        // elapses, SIGKILL cannot be caught or ignored, so the wall clock stays bounded by
        // `timeoutMs + killGraceMs` even against a command that traps SIGTERM.
        killTimer = setTimeout(() => {
          if (settled) return;
          killChild(child, "SIGKILL");
        }, Number.isFinite(killGraceMs) && killGraceMs > 0 ? killGraceMs : DEFAULT_KILL_GRACE_MS);
      }, timeoutMs);
    }
  });
}

async function runOnce({ command, cwd, timeoutMs, maxOutputBytes, killGraceMs, spawnProcess, now, startedAt }) {
  const cwdError = await checkCwd(cwd);
  if (cwdError) {
    return {
      command,
      cwd,
      status: "error",
      exitCode: null,
      output: "",
      truncated: false,
      durationMs: safeNow(now) - startedAt,
      reason: cwdError,
    };
  }

  return await spawnAndCollect({ command, cwd, timeoutMs, maxOutputBytes, killGraceMs, spawnProcess, now, startedAt });
}

/**
 * Runs one project verify command in one worktree, through a real shell, and returns evidence —
 * never a thrown error. A failure, a timeout, a spawn error and a missing cwd are all valid
 * results: the caller is producing evidence that a check ran (or could not run), not asserting
 * success.
 *
 * @param {string} command - a shell string from the operator's own registry (e.g. `pnpm typecheck`).
 * @param {object} [options]
 * @param {string} [options.cwd] - the worktree to run the command in.
 * @param {number} [options.timeoutMs] - kill the command after this many milliseconds.
 * @param {number} [options.maxOutputBytes] - cap combined stdout+stderr at this many bytes.
 * @param {number} [options.killGraceMs] - how long to wait after SIGTERM (sent to the command's
 *   whole process group, so a backgrounded grandchild is reached too) before escalating to
 *   SIGKILL on a timed-out command. Only ever matters on the timeout path.
 * @param {Function} [options.spawnProcess] - injectable in place of node:child_process spawn.
 * @param {Function} [options.now] - injectable clock (ms) for computing durationMs.
 * @returns {Promise<{command: string, cwd: string|undefined, status: "passed"|"failed"|"timed-out"|"error", exitCode: number|null, output: string, truncated: boolean, durationMs: number, reason?: string}>}
 */
export async function runVerifyCommand(command, options = {}) {
  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    spawnProcess = spawn,
    now = Date.now,
  } = options ?? {};

  const startedAt = safeNow(now);

  try {
    return await runOnce({ command, cwd, timeoutMs, maxOutputBytes, killGraceMs, spawnProcess, now, startedAt });
  } catch (error) {
    return {
      command,
      cwd,
      status: "error",
      exitCode: null,
      output: "",
      truncated: false,
      durationMs: safeNow(now) - startedAt,
      reason: `unexpected failure: ${error?.message ?? String(error)}`,
    };
  }
}
