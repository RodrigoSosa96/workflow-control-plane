// Process-group signalling, shared by the two runners in this directory that spawn `detached`.
//
// Extracted in review after `process.js` grew a byte-identical copy of `verify-runner.js`'s
// `killChild` and `SIGNAL_EXIT_CODES`. This repo has paid to collapse duplicated logic five times
// (the `ps` argv, the delegation invariants, mutex removal, the lifecycle protocol, bounded retry);
// this is the sixth and it is here instead.
//
// **What is shared is the mechanism, not the policy.** Both runners spawn with `detached: true` and
// therefore need the same two things: a way to signal a child's whole process group, and the
// shell's own exit-code convention for dying of a signal. What they must NOT share is what signal
// an interrupt sends:
//
//   - `verify-runner.js` runs verification commands (a test suite, a typecheck). Nothing it runs
//     owns a lock or a half-written repository, so its interrupt trap goes straight to SIGKILL --
//     the fastest way to guarantee nothing is left behind.
//   - `process.js` fronts repository MUTATIONS: `git merge --no-ff`, `git worktree add`,
//     `git worktree remove`. SIGKILL is uncatchable, so a killed `git` never runs the cleanup it
//     registered for the signals it is allowed to receive (`sigchain_push_common`, which removes
//     its tempfiles and lockfiles). Its trap therefore forwards the received signal first and only
//     escalates after a grace window.
//
// That divergence is deliberate and is recorded in each trap's own comment. Anything added here
// must be true for both callers.

// Sends a signal to the whole process group `child` leads, not just `child` itself. On POSIX,
// spawning with `detached: true` makes `child.pid` the leader of its own new process group, so
// `-child.pid` reaches every descendant that has not further detached itself -- including a
// grandchild the command backgrounded with `&`, which `child.kill()` alone never could (it signals
// the direct child, and a backgrounded grandchild is reparented away from it well before any signal
// is sent).
//
// Measured before `process.js` adopted this: `sh -c 'sleep 30'` with `timeoutMs: 500` settled at
// 30,205ms, because `sh` forked `sleep` rather than exec'ing it -- the SIGTERM reached only `sh`,
// while `sleep` kept the inherited stdio pipes (and therefore `close`) open for its full duration.
//
// Falls back to signalling `child` directly when there is no usable pid to form a group from (a
// real spawn always provides one; a test double may not), and never throws: a process that is
// already gone is not an error at any call site here.
export function killChild(child, signal) {
  if (typeof child.pid === "number" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // No such process group (already gone) or group signalling unavailable -- fall through to a
      // direct kill below rather than assuming the job is done.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best-effort: if the process is already gone, the caller's own settle path still runs.
  }
}

// Exit code convention for a process that dies of a signal (128 + signal number) -- the same number
// a shell reports for the same event, so a caller inspecting this process's own exit code sees the
// familiar value rather than an arbitrary one.
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
