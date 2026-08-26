#!/usr/bin/env node
// Support fixture for the interrupt tests in test/workflow-process.test.js (B1).
//
// `process.js` spawns `detached: true` so a timeout can signal the child's whole process group, and
// that same detachment takes the child out of this process's own group -- so a terminal's Ctrl-C
// (delivered to the foreground *group*) stops reaching it. Reproducing that needs a real process to
// interrupt, which is why this runs in a process of its own instead of inlined into the test
// runner: the trap under test ends with `process.exit`, and a test that installed it in-process
// would kill the test runner itself.
//
// Runs whatever command the test names, under a `timeoutMs` far longer than the test's own window,
// so the only thing that can end this run inside that window is the interrupt trap under test --
// never the timeout path, which has its own tests.
//
//   usage: process-signal-child.mjs <cwd> <command> [args...]
import { writeFileSync } from "node:fs";
import { createProcessRunner } from "../../src/workflow/process.js";

const [, , cwd, command, ...args] = process.argv;
if (!cwd || !command) {
  console.error("usage: process-signal-child.mjs <cwd> <command> [args...]");
  process.exit(2);
}

// When set, this file is written the moment the run settles -- i.e. the moment control comes back
// to a caller. A test that interrupts this process asserts the file is ABSENT: settling during a
// shutdown is what would let a real command march on to its next step inside a process that is
// already exiting. See the `shuttingDown` guard in process.js's `settle`.
const settleWitness = process.env.WORKFLOW_TEST_SETTLE_WITNESS;
const recordSettle = () => {
  if (settleWitness) writeFileSync(settleWitness, "settled\n");
};

// A second, CONCURRENT run, for the test that interrupts while two children are alive: the first
// child answering the forwarded signal must not settle its promise just because the second is
// still draining. Same contract, own witness. JSON because the value is an argv array.
const alsoArgv = process.env.WORKFLOW_TEST_ALSO ? JSON.parse(process.env.WORKFLOW_TEST_ALSO) : null;
const settleWitness2 = process.env.WORKFLOW_TEST_SETTLE_WITNESS_2;
const recordSettle2 = () => {
  if (settleWitness2) writeFileSync(settleWitness2, "settled\n");
};

if (alsoArgv) {
  createProcessRunner()
    .run(alsoArgv[0], alsoArgv.slice(1), { cwd, timeoutMs: 600_000, allowFailure: true })
    .then(() => {
      recordSettle2();
      process.exit(0);
    })
    .catch(() => {
      recordSettle2();
      process.exit(1);
    });
}

createProcessRunner()
  .run(command, args, { cwd, timeoutMs: 600_000, allowFailure: true })
  .then((result) => {
    // Only reached if this process was NOT interrupted first -- printed so a failing run of the
    // test has something to inspect. The tests never assert on this line: an interrupted run is
    // expected to end inside the trap's own `process.exit`, never by reaching here. `allowFailure`
    // keeps a signalled command from turning into a rejection that would exit before the trap does.
    recordSettle();
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    recordSettle();
    console.log(JSON.stringify({ error: error?.message ?? String(error) }));
    process.exit(1);
  });
