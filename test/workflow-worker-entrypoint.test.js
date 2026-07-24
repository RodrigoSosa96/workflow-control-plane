import assert from "node:assert/strict";
import { test } from "node:test";
import { main, parseArgs } from "../bin/workflow-worker.js";

// Importing the entrypoint is the point of this file: a missing export in any of its
// imports is a load-time SyntaxError that no other suite would catch, and it leaves the
// supervisor dead in its pane with the launch still reported as running.

const RUN_ID = "dbc7bb3d-f6a2-4e22-a7eb-c1c31e117036";
const WORKER_ID = "6a4711e2-909c-44ae-9a7a-5d448ec84307";

function collector() {
  const chunks = [];
  return { chunks, write: (value) => { chunks.push(value); }, text: () => chunks.join("") };
}

test("parses the exact run and worker identity", () => {
  assert.deepEqual(
    parseArgs(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID]),
    { runId: RUN_ID, workerId: WORKER_ID },
  );
});

test("rejects malformed identities and process-control arguments", () => {
  assert.throws(() => parseArgs(["node", "workflow-worker.js", "--run", "nope", "--worker", WORKER_ID]), /Invalid run-id/);
  assert.throws(() => parseArgs(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", "nope"]), /Invalid worker-id/);
  assert.throws(() => parseArgs(["node", "workflow-worker.js", "--run", RUN_ID]), /USAGE/);
});

test("reports usage without a state root instead of starting a harness", async () => {
  const stderr = collector();
  let spawned = 0;

  const code = await main(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID], {
    env: {},
    stderr,
    spawn: () => { spawned += 1; },
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /WORKFLOW_STATE_ROOT/);
  assert.equal(spawned, 0);
});

test("refuses a run it cannot read without spawning anything", async () => {
  const stderr = collector();
  let spawned = 0;

  const code = await main(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID], {
    env: { WORKFLOW_STATE_ROOT: "/tmp/workflow-worker-entrypoint-missing" },
    stderr,
    spawn: () => { spawned += 1; },
    createStore: () => ({ async read() { return null; } }),
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /not found/i);
  assert.equal(spawned, 0);
});

test("refuses a run that is not in fixture mode", async () => {
  const stderr = collector();

  const code = await main(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID], {
    env: { WORKFLOW_STATE_ROOT: "/tmp/workflow-worker-entrypoint-missing" },
    stderr,
    spawn: () => {},
    createStore: () => ({ async read() { return { id: RUN_ID, fixtureMode: false }; } }),
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /fixture mode/i);
});
