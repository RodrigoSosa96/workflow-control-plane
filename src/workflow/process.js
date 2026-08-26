import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { WorkflowError } from "./errors.js";
// Shared with verify-runner.js, the other runner in this directory that spawns `detached`. The
// mechanism is common; the interrupt POLICY below deliberately is not -- see process-group.js.
import { killChild, SIGNAL_EXIT_CODES } from "./process-group.js";

// Exported so a parser of a captured stream can say that its input was cut off here, rather
// than repeating the number and drifting from it.
export const OUTPUT_LIMIT = 12000;
const PROCESS_EXIT_CODE = 12;

// How long to wait, after SIGTERM, before escalating to SIGKILL on a command that ignored it.
// Only matters on the timeout path; a command that exits on its own never touches this timer.
// Same default as verify-runner.js, and callers may override it per run.
const DEFAULT_KILL_GRACE_MS = 2000;

// How long the timeout path waits, after it has stopped expecting anything more from the child,
// before settling with whatever output it has. See the `close` vs `exit` discussion above the
// `run` body: this window exists so that data already sitting in the pipe reaches the collector,
// and it is deliberately short because the whole point is not to wait on a writer this process
// cannot close.
const SETTLE_DRAIN_MS = 100;

function appendBounded(current, chunk) {
  if (current.length >= OUTPUT_LIMIT) return current;
  const text = String(chunk);
  const remaining = OUTPUT_LIMIT - current.length;
  return current + text.slice(0, remaining);
}

// Node reports a missing `cwd` and a missing executable with the SAME error: `spawn <cmd> ENOENT`,
// with no field distinguishing them. That collapse is actively misleading for this codebase, whose
// commands run `git` inside operator-supplied directories: `workflow merge` against a run whose
// worktree has been deleted printed "Failed to start git: spawn git ENOENT", which sends an
// operator to check their git installation when what is actually missing is the directory named
// two words earlier in the same refusal. Found running the real CLI (roadmap item 2.4, task 3,
// step 5).
//
// ENOENT is the only code that is ambiguous this way, and the `existsSync` only ever runs on that
// already-failed path -- never in the success path of any spawn. `cwd` is re-checked rather than
// assumed: by the time the error arrives, the directory really is the thing to ask about.
function startFailureMessage(command, cwd, error) {
  if (error?.code === "ENOENT" && typeof cwd === "string" && cwd && !existsSync(cwd)) {
    return `Failed to start ${command}: working directory does not exist: ${cwd}`;
  }
  return `Failed to start ${command}: ${error.message}`;
}

function toProcessError(message, details) {
  return new WorkflowError("PROCESS", message, {
    exitCode: PROCESS_EXIT_CODE,
    details,
  });
}

// --- The interrupt trap -----------------------------------------------------------------------
//
// `detached: true` (see killChild in process-group.js) is what lets a timeout reach a grandchild's
// whole process group -- and the same detachment takes the child OUT of this CLI's own process
// group, so a terminal's Ctrl-C, delivered to the whole *foreground group* and not to this process
// by pid, no longer reaches it. That regression is not hypothetical: item 2.3 shipped exactly this
// fix inside verify-runner.js and had to close the same hole in a re-review. An interrupted CLI
// would otherwise exit while the detached child is reparented to init with no bound at all, because
// the SIGTERM -> grace -> SIGKILL escalation lives inside the process that just died.
//
// So: for exactly as long as at least one child is alive, an interrupt delivered to THIS process
// (SIGINT from a terminal, SIGTERM from e.g. a process manager) reaches every live child's group
// before this process exits, and this process then exits the way an uninterrupted SIGINT/SIGTERM
// would (128 + signal number).
//
// **What that interrupt sends is the third deliberate difference from verify-runner.js, and it is
// the one a copy gets wrong.** That file SIGKILLs, which is right for a verification command --
// nothing it runs cleans up after itself. This runner fronts repository MUTATIONS: `git merge
// --no-ff` (git.js:665), `git worktree add` (:457, :466), `git worktree remove` (:845). SIGKILL
// cannot be caught or handled, so a killed command never runs the cleanup it registered; git
// installs exactly such a handler (`sigchain_push_common`, which removes its tempfiles and
// lockfiles) and it only ever runs for a signal git is allowed to receive. Forwarding is therefore
// strictly better than killing for anything that tidies up after itself, and this runner's callers
// all do.
//
// The review that found this reported a measured case of an interrupted `git commit` leaving
// `.git/index.lock` behind. That specific artifact did NOT reproduce here: probed against git 2.43,
// no `*.lock` exists under `.git` during pre-commit, prepare-commit-msg, commit-msg, post-commit,
// post-merge or post-checkout, nor while a blocking `GIT_EDITOR` is open. The lock window is
// version- and command-dependent; the reason to forward is not, which is why it is stated above as
// the property (an uncatchable signal runs no handler) rather than as a number this file cannot
// stand behind. The tests assert the mechanism -- the child receives a catchable signal -- not a
// lockfile this git never creates.
//
// So the trap FORWARDS the signal it received to each live group, and only then escalates: SIGKILL
// plus `process.exit` from a short timer, which this process is alive to run precisely because it
// owns the handler that is deferring its own exit. A second interrupt while that is pending skips
// the wait -- an operator pressing Ctrl-C twice is asking for exactly that -- and the escalation is
// a hard ceiling, so an ignored signal costs one grace window, never an unbounded hang.
//
// While that shutdown is draining, no run may hand control back to its caller. A child dying of the
// forwarded SIGINT settles like any other signalled child, and an `allowFailure` caller would take
// that as an ordinary nonzero result and march on to its NEXT step -- removing a worktree, say --
// inside a process that is already exiting. `shuttingDown` below is what stops that: settles still
// release their registry slot (so the escalation knows when everything is gone), but the promise is
// left pending and the exit happens on the trap's own schedule.
//
// **This is where it differs from verify-runner.js, and the difference is the reason it is not a
// copy-paste.** That file runs one child at a time, so its comment can say "at most one trap is
// ever active" and install a listener pair per child. This is the SHARED runner: every git and
// Herdr call in the repo goes through it, sequentially and sometimes concurrently. A listener pair
// per child would mean N pairs for N concurrent spawns -- node warns at 10 listeners precisely
// because that pattern is how leaks look -- and any missed teardown would accumulate across the
// hundreds of short spawns a single command makes. Instead there is ONE listener pair over a
// registry of live children: installed when the registry goes from empty to non-empty, removed
// when it goes back to empty. Per child, what is tracked is membership in that registry, released
// in `settle` alongside the timers, exactly once.
//
// Never registered while no child is alive, which matters for more than tidiness: a registered
// SIGINT listener suppresses node's own default termination, so leaving one installed would change
// how the CLI responds to Ctrl-C at every other moment of its life. The one case where it stays
// installed indefinitely is a child that really is still alive: an untimed run whose `close` never
// arrives is never released, so its registry slot -- and the trap -- outlive every later command in
// that process, and a SIGINT handler registered afterwards never runs because this one exits first.
// That is the honest reading of "a child is alive", not a leak, and B2/B3/B4 giving those call
// sites a `timeoutMs` is what removes the case rather than papering over it.
const liveChildren = new Set();
let installedTrap = null;
// Set once an interrupt has been received and never cleared: this process is on its way out, and
// the flag is what keeps a settle from handing control back to a caller in the interim.
let shuttingDown = false;
let interruptSignal = null;

// How long a forwarded interrupt has to work before SIGKILL. Same window as the timeout path's
// escalation, because it answers the same question -- how long a signalled command gets to die on
// its own -- and one number is easier to reason about than two.
const INTERRUPT_ESCALATION_MS = DEFAULT_KILL_GRACE_MS;

function exitFromInterrupt() {
  // A snapshot, because killing is best-effort and a child's own handlers may mutate the registry.
  for (const child of [...liveChildren]) {
    killChild(child, "SIGKILL");
  }
  liveChildren.clear();
  process.exit(SIGNAL_EXIT_CODES[interruptSignal] ?? 1);
}

function fireInterruptTrap(signal) {
  if (shuttingDown) {
    // Interrupted twice. The operator is not asking again, they are asking harder.
    exitFromInterrupt();
    return;
  }
  shuttingDown = true;
  interruptSignal = signal;

  // Forward what the terminal sent, not something stronger: this is the only signal a mutating
  // command can act on to clean up after itself (see the measurement above).
  for (const child of [...liveChildren]) {
    killChild(child, signal);
  }

  if (liveChildren.size === 0) {
    exitFromInterrupt();
    return;
  }

  // A plain timer, not a wait on any stream or child event, so nothing a child does (or stops
  // doing) can extend it: the exit happens on this schedule whether or not anything reports back.
  // `unref` is deliberately NOT used -- this timer keeping the loop alive is the point.
  setTimeout(exitFromInterrupt, INTERRUPT_ESCALATION_MS);
}

function trackChild(child) {
  liveChildren.add(child);
  if (!installedTrap) {
    installedTrap = (signal) => fireInterruptTrap(signal);
    process.on("SIGINT", installedTrap);
    process.on("SIGTERM", installedTrap);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveChildren.delete(child);
    if (shuttingDown) {
      // Every child has now answered the forwarded signal, so there is nothing left to wait for --
      // exit now rather than sitting out the rest of the escalation window. The listeners stay
      // registered on purpose: a second interrupt arriving in this instant must still be caught.
      if (liveChildren.size === 0) exitFromInterrupt();
      return;
    }
    if (liveChildren.size === 0 && installedTrap) {
      process.removeListener("SIGINT", installedTrap);
      process.removeListener("SIGTERM", installedTrap);
      installedTrap = null;
    }
  };
}

export function createProcessRunner({ spawnImpl = spawn } = {}) {
  return {
    /**
     * Runs one command and captures its output.
     *
     * @param {string} command
     * @param {string[]} [args]
     * @param {object} [options]
     * @param {string} [options.cwd]
     * @param {object} [options.env]
     * @param {number} [options.timeoutMs] - the wall-clock bound. On expiry the command's whole
     *   process group is signalled, escalating to SIGKILL after `killGraceMs`, and the promise
     *   settles without waiting for writers this process cannot close.
     * @param {number} [options.killGraceMs] - how long to wait after SIGTERM before SIGKILL.
     *   Only ever matters on the timeout path.
     * @param {boolean} [options.allowFailure] - resolve, rather than reject, on a nonzero exit.
     */
    async run(command, args = [], options = {}) {
      const { cwd, env, timeoutMs, killGraceMs, allowFailure = false } = options;

      return await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnImpl(command, args, {
            cwd,
            env,
            shell: false,
            // detached: true puts `child` at the head of its own process group (POSIX) instead of
            // this process's -- see killChild above for why the timeout needs that, and the
            // interrupt trap above for what it costs and how that cost is paid.
            detached: true,
          });
        } catch (error) {
          reject(toProcessError(startFailureMessage(command, cwd, error), {
            reason: "spawn",
            command,
            args,
            cwd,
            stdout: "",
            stderr: "",
          }));
          return;
        }

        // Tracked from the moment the spawn succeeds, released in `settle` below -- so the trap is
        // never registered around a spawn that never produced a child.
        const releaseChild = trackChild(child);

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let exited = false;
        let exitCode = null;
        let exitSignal = null;
        let timer = null;
        let killTimer = null;
        let drainTimer = null;

        const settle = (callback) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (drainTimer) clearTimeout(drainTimer);
          releaseChild();
          // An interrupt is draining (see the trap above). `releaseChild` has already recorded that
          // this child is done -- which is what lets the shutdown exit as soon as the last one
          // answers -- but the promise is deliberately left pending: resolving or rejecting here
          // would hand a caller mid-shutdown an ordinary-looking result (an `allowFailure` caller
          // reads a signalled child as just another nonzero code) and let it start its next step
          // inside a process that is already on its way out. With ONE child `releaseChild` exits
          // the process before this line is ever reached; the guard is what makes the same true
          // with two or more, where the first child to answer the forwarded signal empties
          // nothing.
          if (shuttingDown) return;
          callback();
        };

        // The settle body, reachable from `close` (the ordinary path) and from the timeout path's
        // own drain (below) when `close` is never coming.
        const finish = (code, signal) => {
          settle(() => {
            const result = { code: code ?? 1, stdout, stderr };

            // `timedOut` is checked BEFORE `signal`, and that ordering is the fix, not a detail. A
            // command that backgrounds a child and exits produces `close(0, null)`: the direct
            // child's own exit was clean, and only the grandchild holding the pipes kept this
            // promise open. Deciding on `signal` alone reported that as SUCCESS -- measured at
            // 30,201ms under a 500ms timeout. Past the deadline the run is a timeout regardless of
            // how the direct child happened to exit. The `signal`-without-timeout case below is
            // unchanged.
            if (timedOut) {
              reject(toProcessError(`${command} timed out after ${timeoutMs}ms`, {
                reason: "timeout",
                command,
                args,
                cwd,
                code,
                signal,
                stdout,
                stderr,
              }));
              return;
            }

            if (signal) {
              reject(toProcessError(`${command} exited with signal ${signal}`, {
                reason: "signal",
                command,
                args,
                cwd,
                code,
                signal,
                stdout,
                stderr,
              }));
              return;
            }

            if (result.code !== 0 && !allowFailure) {
              reject(toProcessError(`${command} failed with exit code ${result.code}`, {
                reason: "exit",
                command,
                args,
                cwd,
                code: result.code,
                stdout,
                stderr,
              }));
              return;
            }

            resolve(result);
          });
        };

        // `close` vs `exit`, and what each one costs.
        //
        // `close` fires once every stdio stream is closed, which means every writer on the pipes is
        // gone -- including a grandchild that inherited them and is not this runner's to end.
        // verify-runner.js settles on `close` on purpose, because its job is capturing a
        // verification command's complete output and it can afford to wait. HERE, waiting on
        // `close` is the defect: it is what turned a 500ms timeout into a 30-second wall clock.
        //
        // `exit` fires when the child itself is gone, and guarantees nothing about output still in
        // flight -- node may not have emitted every buffered `data` event yet. So this runner keeps
        // `close` as the ordinary settle (an untimed run loses nothing, and a chunk arriving between
        // `exit` and `close` is still captured), and gives it up only on the timeout path, where
        // the alternative is waiting forever. The cost, stated plainly: a timed-out command's last
        // chunks can be missing from `stdout`/`stderr` if they had not been read by the time the
        // drain window elapsed. That is the price of a bound, and it is only ever paid by a run
        // that already failed its deadline.
        const armDrainSettle = () => {
          if (settled || drainTimer) return;
          drainTimer = setTimeout(() => finish(exitCode, exitSignal), SETTLE_DRAIN_MS);
        };

        child.stdout?.on("data", (chunk) => {
          stdout = appendBounded(stdout, chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr = appendBounded(stderr, chunk);
        });

        child.on("error", (error) => {
          settle(() => reject(toProcessError(startFailureMessage(command, cwd, error), {
            reason: "spawn",
            command,
            args,
            cwd,
            stdout,
            stderr,
          })));
        });

        child.on("exit", (code, signal) => {
          exited = true;
          exitCode = code;
          exitSignal = signal;
          // Only on the timeout path. Otherwise the ordinary `close` settle stands, output and all.
          if (timedOut) armDrainSettle();
        });

        child.on("close", (code, signal) => {
          finish(code ?? exitCode, signal ?? exitSignal);
        });

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            killChild(child, "SIGTERM");
            // A test double can settle synchronously inside that kill; nothing below applies then.
            if (settled) return;

            if (exited) {
              // The direct child is already gone and `close` still has not arrived, so what is
              // holding the pipes open is something the command left behind. There is no one left
              // to be graceful toward -- the grace window exists to let the command itself handle
              // SIGTERM and exit -- so the group goes straight to SIGKILL rather than leaving an
              // orphan alive for another `killGraceMs`, and the drain settles this run without
              // waiting on a pipe that may never close.
              killChild(child, "SIGKILL");
              armDrainSettle();
              return;
            }

            killTimer = setTimeout(() => {
              if (settled) return;
              // A command (or something it backgrounded) that ignores SIGTERM would otherwise hold
              // this promise open exactly as long as it likes -- the property the timeout exists to
              // rule out. SIGKILL cannot be caught or ignored, so the wall clock stays bounded by
              // `timeoutMs + killGraceMs` (plus the short drain) even against a command that traps
              // SIGTERM.
              killChild(child, "SIGKILL");
              armDrainSettle();
            }, Number.isFinite(killGraceMs) && killGraceMs > 0 ? killGraceMs : DEFAULT_KILL_GRACE_MS);
          }, timeoutMs);
        }
      });
    },
  };
}
