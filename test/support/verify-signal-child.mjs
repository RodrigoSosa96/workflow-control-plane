#!/usr/bin/env node
// Support fixture for the R1 (branch re-review) SIGINT-regression test in
// test/workflow-verify-runner.test.js.
//
// Runs the real runVerifyCommand in a process of its own -- not inlined into the test runner's
// own process -- so the test can send it an actual SIGINT (simulating a terminal's Ctrl-C to this
// process's own foreground process group) without ever touching the real test runner's process.
// Spawned with a timeoutMs far longer than any test needs, so the only thing that can end this run
// inside the test's own window is the interrupt trap under test, not verify-runner.js's own
// timeout path (already covered by the timeout tests in the parent test file).
import { runVerifyCommand } from "../../src/workflow/verify-runner.js";

const [, , command, cwd] = process.argv;
if (!command || !cwd) {
  console.error("usage: verify-signal-child.mjs <command> <cwd>");
  process.exit(2);
}

runVerifyCommand(command, { cwd, timeoutMs: 60_000 }).then((result) => {
  // Only reached if this process was NOT interrupted before the command finished on its own --
  // printed so a failing run of the test itself has something to inspect. The test never asserts
  // on this line: an interrupted run is expected to end via installInterruptTrap's own
  // process.exit(SIGNAL_EXIT_CODES...), never by reaching here.
  console.log(JSON.stringify(result));
  process.exit(0);
});
