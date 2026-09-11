import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, parseArgs } from "../bin/workflow-worker.js";
import { sha256Digest } from "../src/workflow/launch.js";

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

// Drives the real telemetry store and the real launch-record verification, with only the
// run store and the harness spawn faked. Faking the telemetry store too would hide the
// entrypoint constructing it with the wrong arguments, which is invisible until a live
// worker dies in its pane.
test("builds a real telemetry store and hands it to the supervisor", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-worker-entrypoint-"));
  const runDirectory = join(stateRoot, RUN_ID);
  await mkdir(join(runDirectory, "worker-launches"), { recursive: true });

  const recordText = JSON.stringify({
    version: 1,
    harness: "pi",
    command: "pi",
    argv: ["pi", "--name", "fixture", "--print", "--mode", "json"],
    cwd: null,
    env: { WORKFLOW_RUN_ID: RUN_ID },
    harnessVersion: "0.80.10",
  });
  await writeFile(join(runDirectory, "worker-launches", `${WORKER_ID}.json`), recordText);

  const run = {
    id: RUN_ID,
    directory: runDirectory,
    fixtureMode: true,
    workerLaunches: { [WORKER_ID]: { digest: sha256Digest(recordText), harness: "pi" } },
  };
  const store = {
    async read() { return run; },
    async writePrivateFile() {},
    async appendEvent() {},
  };

  let received = null;
  const stderr = collector();
  const code = await main(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID], {
    env: { WORKFLOW_STATE_ROOT: stateRoot },
    stderr,
    spawn: () => {},
    createStore: () => store,
    createSupervisor: (options) => {
      received = options;
      return { async run() { return { exitCode: 0 }; } };
    },
  });

  assert.equal(stderr.text(), "");
  assert.equal(code, 0);
  assert.equal(typeof received.telemetry.record, "function");
});

test("refuses a launch record whose digest does not match the run", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-worker-entrypoint-"));
  const runDirectory = join(stateRoot, RUN_ID);
  await mkdir(join(runDirectory, "worker-launches"), { recursive: true });
  await writeFile(join(runDirectory, "worker-launches", `${WORKER_ID}.json`), JSON.stringify({ harness: "pi" }));

  const stderr = collector();
  let spawned = 0;
  const code = await main(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID], {
    env: { WORKFLOW_STATE_ROOT: stateRoot },
    stderr,
    spawn: () => { spawned += 1; },
    createStore: () => ({
      async read() {
        return {
          id: RUN_ID,
          directory: runDirectory,
          fixtureMode: true,
          workerLaunches: { [WORKER_ID]: { digest: "sha256:0000", harness: "pi" } },
        };
      },
    }),
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /digest mismatch/i);
  assert.equal(spawned, 0);
});

test("a settled worker renames its own pane to name the run and outcome", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-worker-entrypoint-"));
  const runDirectory = join(stateRoot, RUN_ID);
  await mkdir(join(runDirectory, "worker-launches"), { recursive: true });

  const recordText = JSON.stringify({
    version: 1,
    harness: "pi",
    command: "pi",
    argv: ["pi", "--name", "fixture", "--print", "--mode", "json"],
    cwd: null,
    env: { WORKFLOW_RUN_ID: RUN_ID },
    harnessVersion: "0.80.10",
  });
  await writeFile(join(runDirectory, "worker-launches", `${WORKER_ID}.json`), recordText);

  const spawns = [];
  const spawnFn = (command, args) => {
    spawns.push({ command, args });
    return {
      kill() {},
      on(event, handler) {
        if (event === "close") queueMicrotask(handler);
        return this;
      },
    };
  };
  const code = await main(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID], {
    env: { WORKFLOW_STATE_ROOT: stateRoot, WORKFLOW_PANE_ID: "w1:p7" },
    stderr: collector(),
    spawn: spawnFn,
    createStore: () => ({
      async read() {
        return {
          id: RUN_ID,
          directory: runDirectory,
          fixtureMode: true,
          workerLaunches: { [WORKER_ID]: { digest: sha256Digest(recordText), harness: "pi" } },
        };
      },
      async writePrivateFile() {},
      async appendEvent() {},
    }),
    createSupervisor: () => ({ async run() { return { exitCode: 0 }; } }),
  });

  assert.equal(code, 0);
  assert.deepEqual(spawns, [{
    command: "herdr",
    args: ["pane", "rename", "w1:p7", `run ${RUN_ID.slice(0, 8)} — completed`],
  }]);
});

test("a settled worker without a pane id renames nothing", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-worker-entrypoint-"));
  const runDirectory = join(stateRoot, RUN_ID);
  await mkdir(join(runDirectory, "worker-launches"), { recursive: true });

  const recordText = JSON.stringify({
    version: 1,
    harness: "pi",
    command: "pi",
    argv: ["pi", "--name", "fixture"],
    cwd: null,
    env: {},
    harnessVersion: "0.80.10",
  });
  await writeFile(join(runDirectory, "worker-launches", `${WORKER_ID}.json`), recordText);

  let spawned = 0;
  const code = await main(["node", "workflow-worker.js", "--run", RUN_ID, "--worker", WORKER_ID], {
    env: { WORKFLOW_STATE_ROOT: stateRoot },
    stderr: collector(),
    spawn: () => { spawned += 1; },
    createStore: () => ({
      async read() {
        return {
          id: RUN_ID,
          directory: runDirectory,
          fixtureMode: true,
          workerLaunches: { [WORKER_ID]: { digest: sha256Digest(recordText), harness: "pi" } },
        };
      },
      async writePrivateFile() {},
      async appendEvent() {},
    }),
    createSupervisor: () => ({ async run() { return { exitCode: 1 } } }),
  });

  assert.equal(code, 1, "the supervisor's own exit code is preserved");
  assert.equal(spawned, 0, "no pane rename without WORKFLOW_PANE_ID");
});
