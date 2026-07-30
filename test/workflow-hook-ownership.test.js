// This file exists to prove exactly one property: the startedAt string a hook (or Pi worker
// extension) WRITES via createSubprocessOwnOwnershipReader must be byte-identical to the
// startedAt string `workflow unlock` later READS back via inspectExactProcessByPid (the same
// wiring bin/workflow.js's inspectDelegationPid uses). classifyOwnership (src/workflow/
// ownership.js) compares startedAt for exact string equality -- if the write path and the read
// path ever drift by even a formatting detail, a LIVE owner would be misclassified as
// proven-dead and unlock would remove its lock out from under it. That is the one error this
// whole design must never make, so it gets its own test file where it cannot be diluted into a
// wiring assertion (see the plan at .superpowers/sdd/2026-07-30-hook-owned-lock-ownership/).
//
// Both paths below run the REAL `ps` against this test process's own pid -- no injected seams --
// so drift cannot hide behind a fake. The two calls observe the same already-running process, so
// its start time cannot change between them; that is what makes asserting equality (not just
// "looks like an ISO string") sound without sleeps or retries.
//
// The `ps -p <pid> -o lstart= -o state=` argv observeViaUnlockPath below runs comes from
// process-observation.js's exported psStatusArgv -- the single source ownership.js's
// spawnPsStatus (the write side) and bin/workflow.js's inspectDelegationPid (the read side) also
// route through, so this test can never drift from what production actually runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubprocessOwnOwnershipReader } from "../src/workflow/ownership.js";
import { inspectExactProcessByPid, psStatusArgv } from "../src/workflow/process-observation.js";
import { createProcessRunner } from "../src/workflow/process.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

// The exact runner wiring bin/workflow.js's inspectDelegationPid uses for `workflow unlock`'s
// observation side: the real createProcessRunner, `ps` invoked with allowFailure so a non-zero
// exit resolves (not rejects) -- inspectExactProcessByPid needs to see that outcome to prove a
// pid gone -- and the real node:fs/promises realpath for reading /proc/<pid>/cwd, which is also
// inspectDelegationPid's own readCwd default.
const runner = createProcessRunner();

async function observeViaUnlockPath(pid) {
  return inspectExactProcessByPid(pid, {
    async runProcess(resolvedPid) {
      return runner.run("ps", psStatusArgv(resolvedPid), { allowFailure: true });
    },
    readCwd: realpath,
  });
}

test("a hook's written startedAt is byte-identical to unlock's observed startedAt, for the same live process", async (t) => {
  const written = await createSubprocessOwnOwnershipReader()();

  // Degrade, don't silently pass: an environment where `ps` is unavailable or behaves
  // unexpectedly must skip with a named reason, never fall through to an assertion that
  // vacuously holds (e.g. asserting two nulls are equal) or, worse, pass no assertion at all.
  //
  // This check must run BEFORE observeViaUnlockPath: createSubprocessOwnOwnershipReader swallows
  // a missing `ps` binary and resolves null (see ownership.js's readOwnProcessOwnership), but
  // observeViaUnlockPath calls runner.run("ps", ...) directly -- on a host with no `ps` at all,
  // that rejects with "Failed to start ps" (process.js) regardless of allowFailure, which would
  // make this test error instead of skip. Checking `written` first means a missing `ps` is caught
  // here, before the second call can throw.
  if (!written) {
    t.skip(
      `ps produced no usable output on this machine (written=${JSON.stringify(written)}) -- `
      + "the write/read equality this test exists to prove could not be checked here",
    );
    return;
  }

  const observed = await observeViaUnlockPath(String(process.pid));

  if (!observed) {
    t.skip(
      `ps produced no usable output on this machine (written=${JSON.stringify(written)}, `
      + `observed=${JSON.stringify(observed)}) -- the write/read equality this test exists to `
      + "prove could not be checked here",
    );
    return;
  }

  // The property this whole test file exists for. Deliberately NOT a format check (e.g.
  // asserting an ISO-timestamp shape): a format-only assertion would pass even if the write and
  // read paths produced two different, both-plausible-looking timestamps for the same process --
  // exactly the silent misclassification this test must catch.
  assert.equal(written.startedAt, observed.startedAt);
});

test("createSubprocessOwnOwnershipReader's pid is String(process.pid)", async (t) => {
  const result = await createSubprocessOwnOwnershipReader()();

  if (!result) {
    t.skip("ps produced no usable output on this machine -- cannot observe this process's own pid");
    return;
  }

  assert.equal(result.pid, String(process.pid));
});

// --- ordering: the read must happen before the mutex is acquired, never while held -----------
//
// 1.1's task-2 review deliberately moved the own-ownership read out of acquireLock's/acquireGate's
// critical section: a slow `ps` spawn must never run while the mkdir-based mutex is held, both to
// protect the bounded lock-contention retry budget and to avoid widening the window where the
// active-lock directory exists with no marker yet. Nothing pins that ordering as a checkable
// property -- it is only true because of where the `await readOwnOwnership()` line happens to sit
// in run-store.js's acquireLock (see the comment there). This test makes it a fact a future edit
// cannot silently break: readOwnOwnership records whether the active-lock directory exists at the
// exact moment it is invoked, and the read must observe it does NOT exist yet.

test("readOwnOwnership is invoked before the active lock directory exists (the read precedes acquisition, never runs while the mutex is held)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-hook-ownership-ordering-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const runId = "11111111-1111-4111-8111-111111111111";
  // Mirrors run-store.js's own layout (runDirectoryFor -> resolve(root, id); acquireLock's
  // lockContainer -> join(directory, "run.lock"); activePath -> join(lockContainer, "active") --
  // ACTIVE_LOCK_DIR). Computed independently here, from the fixed stateRoot/runId this test
  // controls, rather than imported from run-store.js's internals.
  const activeLockPath = join(root, runId, "run.lock", "active");

  let activeLockExistedDuringRead;
  const store = createRunStore({
    stateRoot: root,
    randomUUID: () => runId,
    clock: { now: () => "2025-01-01T00:00:00.000Z" },
    async readOwnOwnership() {
      activeLockExistedDuringRead = await pathExists(activeLockPath);
      return { pid: "1", startedAt: "2025-01-01T00:00:00.000Z" };
    },
  });

  await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    relatedTickets: [],
    state: RUN_STATES.PLANNED,
  });

  assert.equal(
    activeLockExistedDuringRead,
    false,
    "readOwnOwnership ran while the active lock directory already existed -- the ownership read "
    + "must complete before the mutex is acquired, not during or after",
  );
});

async function pathExists(path) {
  try {
    await realpath(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}
