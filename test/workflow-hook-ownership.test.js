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
// The `ps -p <pid> -o lstart= -o state=` argv is written a third time below, in
// observeViaUnlockPath: it already exists, unexported, as ownership.js's spawnPsStatus (the
// write side) and inside bin/workflow.js's inspectDelegationPid (the read side), and neither is
// exported for a test to import instead. Noted in this task's report; a deferred finding already
// tracks the two existing copies.

import assert from "node:assert/strict";
import { test } from "node:test";
import { realpath } from "node:fs/promises";
import { createSubprocessOwnOwnershipReader } from "../src/workflow/ownership.js";
import { inspectExactProcessByPid } from "../src/workflow/process-observation.js";
import { createProcessRunner } from "../src/workflow/process.js";

// The exact runner wiring bin/workflow.js's inspectDelegationPid uses for `workflow unlock`'s
// observation side: the real createProcessRunner, `ps` invoked with allowFailure so a non-zero
// exit resolves (not rejects) -- inspectExactProcessByPid needs to see that outcome to prove a
// pid gone -- and the real node:fs/promises realpath for reading /proc/<pid>/cwd, which is also
// inspectDelegationPid's own readCwd default.
const runner = createProcessRunner();

async function observeViaUnlockPath(pid) {
  return inspectExactProcessByPid(pid, {
    async runProcess(resolvedPid) {
      return runner.run("ps", ["-p", String(resolvedPid), "-o", "lstart=", "-o", "state="], { allowFailure: true });
    },
    readCwd: realpath,
  });
}

test("a hook's written startedAt is byte-identical to unlock's observed startedAt, for the same live process", async (t) => {
  const written = await createSubprocessOwnOwnershipReader()();
  const observed = await observeViaUnlockPath(String(process.pid));

  // Degrade, don't silently pass: an environment where `ps` is unavailable or behaves
  // unexpectedly must skip with a named reason, never fall through to an assertion that
  // vacuously holds (e.g. asserting two nulls are equal) or, worse, pass no assertion at all.
  if (!written || !observed) {
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
