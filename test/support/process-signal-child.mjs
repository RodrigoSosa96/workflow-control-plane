#!/usr/bin/env node
// Support fixture for the Ctrl-C regression test in test/workflow-process.test.js (B1).
//
// The same shape as verify-signal-child.mjs, for the SHARED runner: `process.js` spawns
// `detached: true` so a timeout can signal the child's whole process group, and that same
// detachment takes the child out of this process's own group -- so a terminal's Ctrl-C (delivered
// to the foreground *group*) stops reaching it. Reproducing that needs a real process to interrupt,
// which is why this runs in a process of its own instead of inlined into the test runner: the trap
// under test ends with `process.exit`, and a test that installed it in-process would kill the test
// runner itself.
//
// The command is a plain `sleep` (no shell: this runner keeps `shell: false`), under a `timeoutMs`
// far longer than the test's own window, so the only thing that can end this run inside that window
// is the interrupt trap under test -- never the timeout path, which its own tests cover.
import { createProcessRunner } from "../../src/workflow/process.js";

const [, , seconds] = process.argv;
if (!seconds) {
  console.error("usage: process-signal-child.mjs <sleep-seconds>");
  process.exit(2);
}

createProcessRunner()
  .run("sleep", [seconds], { timeoutMs: 60_000 })
  .then((result) => {
    // Only reached if this process was NOT interrupted first -- printed so a failing run of the
    // test has something to inspect. The test never asserts on this line.
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    console.log(JSON.stringify({ error: error?.message ?? String(error) }));
    process.exit(1);
  });
