# Workflow Real Pi Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `--real --agent pi --keep` path in `scripts/smoke-workflow-fixture.js` so it can launch a real Pi harness against a generated fixture, monitor telemetry and result, and preserve all resources for inspection.

**Architecture:** Extend the existing smoke runner with a gated real-mode branch. Reuse `createWorkflowFixture`, the production `launchCommand`, `resultCommand`, and `workerStatusCommand` with a fixture registry override, and add a bounded polling loop. All safety checks happen before any binary resolution or Herdr interaction.

**Tech Stack:** Node.js 24 ESM, `node:test`, existing Workflow commands, Herdr 0.7.4, real Pi CLI.

## Global Constraints

- Real canaries are interactive-only; never run in CI or automated tests.
- `--real` requires `--keep`; real canaries always preserve resources.
- Only `--agent pi` is allowed in this plan; reject `claude`, `codex`, and `opencode` for real mode.
- All fixture/canary resources stay under the generated fixture root.
- No canonical project path or `projects.yaml` is loaded; use `WORKFLOW_PROJECTS_FILE=<fixture-registry>`.
- No automatic cleanup, close, kill, retry, or follow-up of the real worker.
- Telemetry remains observational; no prompts, transcripts, tool arguments, session paths, or credentials are persisted by the smoke runner.
- Fake smoke (`--fake`) must keep passing before any real canary is run.
- Every task ends with focused tests, full `npm test`, `git diff --check`, and a commit.

---

### Task 1: Refactor Smoke Runner for Real-Mode Branching

**Files:**
- Modify: `scripts/smoke-workflow-fixture.js`
- Modify: `test/workflow-real-canary.test.js`

**Interfaces:**
- Extract a `createSmokeRunner()` factory that receives `{ argv, env, stdin, stdout, stderr, now }` so real-mode behavior can be unit-tested without spawning anything.
- Export `main(argv)` as the thin production entry point.

- [ ] **Step 1: Write failing refactor tests**

Add tests proving the runner can be constructed with injected streams/env:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSmokeRunner } from "../scripts/smoke-workflow-fixture.js";

test("runner accepts injected env and streams", async () => {
  const lines = [];
  const runner = createSmokeRunner({
    argv: ["--fake"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdout: { write: (chunk) => lines.push(chunk) },
    stderr: { write: () => {} },
    stdin: { once: () => {}, isTTY: true },
  });
  assert.equal(typeof runner.run, "function");
});
```

Run:

```bash
node --test test/workflow-real-canary.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `createSmokeRunner`.

- [ ] **Step 2: Refactor the script into a factory and thin entry point**

Move all logic from `main()` into a `createSmokeRunner()` factory and keep `main(argv)` as:

```js
export function createSmokeRunner(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? Date.now;

  return {
    async run() {
      const args = parseArgs(argv);
      // existing fake behavior plus new real branch
      return runSmoke({ args, env, stdin, stdout, stderr, now });
    },
  };
}

async function main(argv) {
  const runner = createSmokeRunner({ argv });
  const { code, error } = await runner.run();
  if (error) {
    console.error(error.message);
  }
  process.exit(code ?? (error ? 1 : 0));
}
```

Update the bottom of the file so production still calls `main(process.argv.slice(2))`.

Run:

```bash
node --test test/workflow-real-canary.test.js
npm test
```

Expected: all existing tests pass; new construct test passes.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-workflow-fixture.js test/workflow-real-canary.test.js
git commit -m "refactor(smoke): make smoke runner injectable for real-mode tests"
```

---

### Task 2: Implement Real-Mode Safety Gates

**Files:**
- Modify: `scripts/smoke-workflow-fixture.js`
- Modify: `test/workflow-real-canary.test.js`

**Interfaces:**
- `assertRealModeAllowed(args, { env, stdin, stdout })` performs TTY, `--keep`, agent, and CI gates before returning `true`.
- `promptExactHarness(expected, { stdin, stdout })` returns the typed confirmation.

- [ ] **Step 1: Write failing gate tests**

Add tests for:

```js
test("--real rejects non-pi agents", async () => {
  const { code, stderr } = await runRunner(["--real", "--agent", "claude", "--keep"], { tty: true });
  assert.equal(code, 1);
  assert.match(stderr, /Real canary for .claude. is not implemented|only .pi. is supported/i);
});

test("--real rejects CI environment", async () => {
  const { code, stderr } = await runRunner(["--real", "--agent", "pi", "--keep"], { tty: true, env: { CI: "true" } });
  assert.equal(code, 1);
  assert.match(stderr, /interactive-only|CI/i);
});
```

Run:

```bash
node --test test/workflow-real-canary.test.js
```

Expected: FAIL because the new gates do not exist.

- [ ] **Step 2: Implement gate functions**

Add to `scripts/smoke-workflow-fixture.js`:

```js
const REAL_ALLOWED_AGENTS = new Set(["pi"]);

function hasTty(stdin, stdout, env) {
  if (env.WORKFLOW_SMOKE_TEST_TTY === "1") return true;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

function isCiEnv(env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE);
}

async function promptExactHarness(expected, { stdin, stdout }) {
  stdout.write(`This is a REAL canary. It will start an actual ${expected} harness and may consume tokens/API quota.\n`);
  stdout.write(`Type the exact harness name to confirm: ${expected}\n> `);
  return new Promise((resolve) => {
    stdin.once("data", (data) => resolve(data.toString().trim()));
  });
}

async function assertRealModeAllowed(args, { env, stdin, stdout }) {
  if (!hasTty(stdin, stdout, env)) {
    throw new Error("Real canaries require a TTY");
  }
  if (!args.keep) {
    throw new Error("Real canaries require --keep");
  }
  if (!args.agent) {
    throw new Error("Real canaries require --agent <harness>");
  }
  if (!REAL_ALLOWED_AGENTS.has(args.agent)) {
    throw new Error(`Real canary for '${args.agent}' is not implemented; only 'pi' is supported`);
  }
  if (isCiEnv(env)) {
    throw new Error("Real canaries are interactive-only and cannot run in CI");
  }
  const confirmed = await promptExactHarness(args.agent, { stdin, stdout });
  if (confirmed !== args.agent) {
    throw new Error("Real canary was not confirmed");
  }
}
```

Update `parseArgs` to leave `args.real` and `args.fake` mutually exclusive; if both are missing, print usage.

In the `runSmoke` body, when `args.real` is true, call `await assertRealModeAllowed(args, { env, stdin, stdout })` before creating the fixture.

Run:

```bash
node --test test/workflow-real-canary.test.js
npm test
```

Expected: new gate tests pass; existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-workflow-fixture.js test/workflow-real-canary.test.js
git commit -m "feat(smoke): add real-mode safety gates for Pi canary"
```

---

### Task 3: Implement Real Pi Fixture, Prompt, and Disclosure

**Files:**
- Modify: `scripts/smoke-workflow-fixture.js`
- Modify: `src/workflow/fixture.js`
- Create: `test/workflow-real-canary-pi-fixture.test.js` (optional; can stay in `workflow-real-canary.test.js`)

**Interfaces:**
- `createCanaryPrompt()` returns the bounded assignment text.
- `printCanaryDisclosure(fixture, args, stdout)` prints root, registry, profile, tickets, assignment, and cost warning.
- Fixture generation reuses `createWorkflowFixture()`; fixture files must contain the expected initial value and test.

- [ ] **Step 1: Write failing fixture-content tests**

Add tests that the generated fixture contains the canary edit target and a local test:

```js
import { createWorkflowFixture } from "../src/workflow/fixture.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("fixture single repo contains canary edit target and test", async () => {
  const fixture = await createWorkflowFixture({
    root: join(tmpdir(), `workflow-canary-target-test-${Date.now()}`),
    packageRoot: new URL("..", import.meta.url).pathname,
  });
  const fixtureJs = await readFile(join(fixture.projects["fixture-single"].path, "fixture.js"), "utf8");
  const testJs = await readFile(join(fixture.projects["fixture-single"].path, "test.js"), "utf8");
  assert.match(fixtureJs, /export const value = "initial"/);
  assert.match(testJs, /assert\.equal\(value, "initial"\)/);
});
```

Run:

```bash
node --test test/workflow-real-canary.test.js
```

Expected: FAIL because fixture files do not exist yet.

- [ ] **Step 2: Implement canary fixture files**

Modify `initFixtureRepo` in `src/workflow/fixture.js` to write:

```js
await writeFile(join(path, "fixture.js"), `export const value = "initial";\n`);
await writeFile(join(path, "test.js"), `import { value } from "./fixture.js";\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("fixture value matches expectation", () => {\n  assert.equal(value, "initial");\n});\n`);
await writeFile(join(path, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
await writeFile(join(path, "AGENTS.md"), "# Fixture-only safety\n\nThis is a disposable Workflow canary fixture. Do not push or reuse.\n");
```

Keep the README write as-is.

Run:

```bash
node --test test/workflow-real-canary.test.js
npm test
```

Expected: fixture-content tests pass.

- [ ] **Step 3: Implement disclosure and prompt helpers**

Add to `scripts/smoke-workflow-fixture.js`:

```js
const CANARY_ASSIGNMENT = `This is a controlled Workflow canary. Perform exactly these steps:

1. Edit fixture.js so the exported value changes from "initial" to "implemented".
2. Update the matching assertion in test.js if needed.
3. Run \`node --test\` in this repository.
4. Submit the required structured workflow handoff for tickets FIX-101 and FIX-102.

Do not push, fetch, access secrets, alter permissions, close the workspace, or clean up resources.
Do not perform any work beyond the edit and test described above.`;

function printCanaryDisclosure(fixture, agent, stdout) {
  stdout.write("=== Workflow Real Canary ===\n");
  stdout.write(`Harness: ${agent}\n`);
  stdout.write(`Fixture root: ${fixture.root}\n`);
  stdout.write(`Registry: ${fixture.registryPath}\n`);
  stdout.write(`State root: ${fixture.stateRoot}\n`);
  stdout.write(`Tickets: FIX-101, FIX-102\n`);
  stdout.write("\nAssignment:\n");
  stdout.write(CANARY_ASSIGNMENT);
  stdout.write("\n\nWARNING: This will start a real Pi harness and may consume API tokens.\n");
  stdout.write("All resources will be preserved (--keep is required).\n\n");
}
```

Ensure the script imports:

```js
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Add `writePromptFile` helper that writes the prompt to a temp file under the fixture root:

```js
async function writePromptFile(root) {
  const promptPath = join(root, "canary-prompt.txt");
  await writeFile(promptPath, CANARY_ASSIGNMENT);
  return promptPath;
}
```

- [ ] **Step 4: Wire disclosure into real-mode path**

After `assertRealModeAllowed`, generate the fixture, print disclosure, and write the prompt file:

```js
if (args.real) {
  await assertRealModeAllowed(args, { env, stdin, stdout });
  const fixture = await createWorkflowFixture({
    root: join(tmpdir(), `workflow-smoke-real-${args.agent}-${Date.now()}-${randomUUID().slice(0, 8)}`),
    packageRoot: new URL("..", import.meta.url).pathname,
  });
  printCanaryDisclosure(fixture, args.agent, stdout);
  const promptPath = await writePromptFile(fixture.root);
  return { fixture, promptPath };
}
```

Run:

```bash
node --test test/workflow-real-canary.test.js
npm test
```

Expected: existing tests pass; new fixture-content tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-workflow-fixture.js src/workflow/fixture.js test/workflow-real-canary.test.js
git commit -m "feat(smoke): generate canary fixture with bounded prompt and disclosure"
```

---

### Task 4: Implement Dry-Run Preview and Approved Launch for Real Pi

**Files:**
- Modify: `scripts/smoke-workflow-fixture.js`
- Modify: `test/workflow-real-canary.test.js`

**Interfaces:**
- `runWorkflowLaunch({ fixture, promptPath, agent, env, execute })` returns the run report from a confirmed launch.
- The smoke runner uses production `launchCommand` with a fixture registry override.

- [ ] **Step 1: Write failing launch-orchestration tests**

Add a test that verifies the runner builds the correct environment and launch options (without actually calling a real launch):

```js
test("real-mode path builds fixture registry launch options", async () => {
  let captured = null;
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: fakeStdin("pi\n"),
    stdout: noopWriter(),
    stderr: noopWriter(),
    createWorkflowFixture: async () => ({
      root: "/tmp/fake-fixture",
      registryPath: "/tmp/fake-fixture/projects.yaml",
      stateRoot: "/tmp/fake-fixture/state",
      packageRoot: "/tmp/fake-package",
      projects: { "fixture-single": { path: "/tmp/fake-fixture/fixture-single", tickets: ["FIX-101", "FIX-102"] } },
    }),
    launchCommand: async (options) => {
      captured = options;
      return {
        preview: { approvalDigest: "sha256:test" },
        execute: async () => ({ status: "running", runId: "11111111-1111-4111-8111-111111111111", runDirectory: "/tmp/run-1" }),
      };
    },
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.equal(captured.projectAlias, "fixture-single");
  assert.equal(captured.task, "FIX-101");
  assert.deepEqual(captured.tickets, ["FIX-102"]);
  assert.equal(captured.agentProfile, "pi-worker");
  assert.equal(captured.registryPath, "/tmp/fake-fixture/projects.yaml");
  assert.equal(captured.stateRoot, "/tmp/fake-fixture/state");
  assert.ok(captured.controlPlaneBin.endsWith("bin/workflow.js"));
});
```

Run:

```bash
node --test test/workflow-real-canary.test.js
```

Expected: FAIL because `launchCommand` injection does not exist.

- [ ] **Step 2: Implement launch orchestration helper**

Add dependencies to the factory:

```js
import { launchCommand as defaultLaunchCommand } from "../src/workflow/commands.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { loadRegistry } from "../src/workflow/registry.js";
import { lookupExecutable } from "../src/workflow/runtime-config.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { createHerdrAdapter } from "../src/workflow/herdr.js";
import { createProcessRunner } from "../src/workflow/process.js";

function createLaunchDeps(fixture, env, overrides = {}) {
  const runner = overrides.runner ?? createProcessRunner();
  const stateRoot = fixture.stateRoot;
  return {
    env,
    runner,
    stateRoot,
    registryPath: fixture.registryPath,
    loadRegistry: overrides.loadRegistry ?? loadRegistry,
    lookupExecutable: overrides.lookupExecutable ?? ((name) => lookupExecutable(name, { env })),
    git: overrides.git ?? createGitAdapter({ runner }),
    herdr: overrides.herdr ?? createHerdrAdapter({ runner }),
    store: overrides.store ?? createRunStore({ stateRoot }),
  };
}

async function runWorkflowLaunch({ fixture, promptPath, agent, env, launchCommand = defaultLaunchCommand }) {
  const deps = createLaunchDeps(fixture, env);
  const command = await launchCommand({
    command: "launch",
    projectAlias: "fixture-single",
    task: "FIX-101",
    tickets: ["FIX-102"],
    agentProfile: `${agent}-worker`,
    promptFile: promptPath,
    registryPath: fixture.registryPath,
    stateRoot: fixture.stateRoot,
    controlPlaneBin: join(fixture.packageRoot, "bin", "workflow.js"),
    dryRun: false,
    yes: true,
    approvalDigest: null,
    format: "json",
  }, deps);

  const preview = command.preview;
  const report = await command.execute({ approvalDigest: preview.approvalDigest });
  return { preview, report };
}
```

Wire it into the real-mode branch:

```js
const { report } = await runWorkflowLaunch({ fixture, promptPath, agent: args.agent, env });
if (report.status !== "running") {
  throw new Error(`Launch did not reach running state: ${report.status}`);
}
stdout.write(`Run created: ${report.runId}\n`);
stdout.write(`Run directory: ${report.runDirectory}\n`);
return { fixture, promptPath, runId: report.runId, runDirectory: report.runDirectory };
```

- [ ] **Step 3: Verify launch wiring with fake launch command**

Run:

```bash
node --test test/workflow-real-canary.test.js
```

Expected: launch-orchestration test passes.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-workflow-fixture.js test/workflow-real-canary.test.js
git commit -m "feat(smoke): wire real-mode launch via production launchCommand"
```

---

### Task 5: Implement Bounded Polling and Completion Criteria

**Files:**
- Modify: `scripts/smoke-workflow-fixture.js`
- Modify: `test/workflow-real-canary.test.js`

**Interfaces:**
- `pollCanaryCompletion({ runId, fixture, env, deadline, stdout })` polls `resultCommand` and `workerStatusCommand` until completion or deadline.
- `inspectCanaryResult({ fixture, runId })` checks the Git diff and telemetry snapshot.

- [ ] **Step 1: Write failing polling tests**

Add tests for the polling loop with injected commands:

```js
test("poll completes on current completed result", async () => {
  const resultCalls = [];
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: fakeStdin("pi\n"),
    stdout: noopWriter(),
    stderr: noopWriter(),
    launchCommand: async () => ({
      preview: { approvalDigest: "sha256:test" },
      execute: async () => ({ status: "running", runId: "run-1", runDirectory: "/tmp/run-1" }),
    }),
    resultCommand: async ({ runId }) => {
      resultCalls.push(runId);
      return { status: "completed", result: { verification: [{ command: "node --test", status: "passed" }] } };
    },
    workerStatusCommand: async () => ({ workers: [{ phase: "settled" }] }),
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.deepEqual(resultCalls, ["run-1"]);
});

test("poll stops on needs-input and preserves fixture", async () => {
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: fakeStdin("pi\n"),
    stdout: noopWriter(),
    stderr: noopWriter(),
    launchCommand: async () => ({
      preview: { approvalDigest: "sha256:test" },
      execute: async () => ({ status: "running", runId: "run-1", runDirectory: "/tmp/run-1" }),
    }),
    resultCommand: async () => ({ status: "needs-input" }),
    workerStatusCommand: async () => ({ workers: [{ phase: "running" }] }),
  });
  const { code } = await runner.run();
  assert.notEqual(code, 0);
});

test("completed canary validates telemetry snapshot is bounded", async () => {
  let inspectedPath = null;
  const runner = createSmokeRunner({
    argv: ["--real", "--agent", "pi", "--keep"],
    env: { WORKFLOW_SMOKE_TEST_TTY: "1" },
    stdin: fakeStdin("pi\n"),
    stdout: noopWriter(),
    stderr: noopWriter(),
    createWorkflowFixture: async () => ({
      root: "/tmp/fake-fixture",
      registryPath: "/tmp/fake-fixture/projects.yaml",
      stateRoot: "/tmp/fake-fixture/state",
      packageRoot: "/tmp/fake-package",
      projects: { "fixture-single": { path: "/tmp/fake-fixture/fixture-single", tickets: ["FIX-101", "FIX-102"] } },
    }),
    launchCommand: async () => ({
      preview: { approvalDigest: "sha256:test" },
      execute: async () => ({ status: "running", runId: "run-1", runDirectory: "/tmp/fake-fixture/state/run-1" }),
    }),
    resultCommand: async () => ({ status: "completed", result: { verification: [{ command: "node --test", status: "passed" }] } }),
    workerStatusCommand: async () => ({ workers: [{ phase: "settled", workerId: "worker-1" }] }),
    readTelemetrySnapshot: async (path) => {
      inspectedPath = path;
      return { phase: "settled", harness: "pi" };
    },
  });
  const { code } = await runner.run();
  assert.equal(code, 0);
  assert.equal(inspectedPath, "/tmp/fake-fixture/state/run-1/telemetry/workers/worker-1.json");
});
```

Run:

```bash
node --test test/workflow-real-canary.test.js
```

Expected: FAIL because polling helpers and telemetry inspection do not exist.

- [ ] **Step 2: Implement polling helpers

Add:

```js
import { resultCommand as defaultResultCommand, workerStatusCommand as defaultWorkerStatusCommand } from "../src/workflow/commands.js";

const CANARY_TIMEOUT_MS = 10 * 60 * 1000;
const CANARY_POLL_INTERVAL_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCanaryCompletion({ runId, fixture, env, stdout, resultCommand = defaultResultCommand, workerStatusCommand = defaultWorkerStatusCommand }) {
  const deps = createLaunchDeps(fixture, env);
  const deadline = Date.now() + CANARY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await resultCommand({ runId, registryPath: fixture.registryPath, stateRoot: fixture.stateRoot }, deps);
    const status = await workerStatusCommand({ runId, registryPath: fixture.registryPath, stateRoot: fixture.stateRoot }, deps);

    const phase = status.workers?.[0]?.phase ?? "unknown";
    stdout.write(`[${new Date().toISOString()}] result=${result.status} worker=${phase}\n`);

    if (result.status === "completed") {
      return { outcome: "completed", result, status };
    }
    if (["needs-input", "manual-handoff-required"].includes(result.status) || ["failed", "unknown", "manual-recovery"].includes(phase)) {
      return { outcome: "terminal", result, status };
    }

    await sleep(CANARY_POLL_INTERVAL_MS);
  }

  return { outcome: "timeout" };
}
```

- [ ] **Step 3: Implement post-completion inspection**

Add helpers that verify the Git diff and the bounded telemetry snapshot:

```js
import { readFile as defaultReadFile } from "node:fs/promises";
import { join } from "node:path";

async function inspectCanaryCompletion({ fixture, readFile = defaultReadFile }) {
  const fixtureJs = await readFile(join(fixture.projects["fixture-single"].path, "fixture.js"), "utf8");
  const testJs = await readFile(join(fixture.projects["fixture-single"].path, "test.js"), "utf8");
  if (!fixtureJs.includes('"implemented"')) {
    throw new Error("Canary did not change fixture.js to 'implemented'");
  }
  if (!testJs.includes('"implemented"')) {
    throw new Error("Canary did not update test.js to expect 'implemented'");
  }
}

async function readTelemetrySnapshot(snapshotPath, { readFile = defaultReadFile }) {
  const text = await readFile(snapshotPath, "utf8");
  const snapshot = JSON.parse(text);
  if (typeof snapshot.phase !== "string") {
    throw new Error("Telemetry snapshot is missing bounded phase field");
  }
  const json = JSON.stringify(snapshot);
  if (json.includes("prompt") || json.includes("sessionPath") || json.includes("toolArguments")) {
    throw new Error("Telemetry snapshot contains disallowed private fields");
  }
  return snapshot;
}

async function inspectCanaryTelemetry({ fixture, runId, workerId, readTelemetrySnapshot: readSnapshot = readTelemetrySnapshot }) {
  const snapshotPath = join(fixture.stateRoot, runId, "telemetry", "workers", `${workerId}.json`);
  await readSnapshot(snapshotPath);
}
```

Wire into the real-mode branch after `pollCanaryCompletion`:

```js
const poll = await pollCanaryCompletion({ runId: report.runId, fixture, env, stdout });
if (poll.outcome !== "completed") {
  throw new Error(`Canary did not complete: ${poll.outcome}`);
}
const workerId = poll.status.workers?.[0]?.workerId;
if (workerId) {
  await inspectCanaryTelemetry({ fixture, runId: report.runId, workerId });
}
await inspectCanaryCompletion({ fixture });
stdout.write("Canary completed successfully.\n");
```

- [ ] **Step 4: Verify polling and telemetry tests pass**

Run:

```bash
node --test test/workflow-real-canary.test.js
npm test
```

Expected: polling and telemetry tests pass; full suite green.

- [ ] **Step 5: Commit"

```bash
git add scripts/smoke-workflow-fixture.js test/workflow-real-canary.test.js
git commit -m "feat(smoke): poll result and worker status for real Pi canary"
```

---

### Task 6: Update Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md`
- Modify: `test/workflow-docs.test.js`

**Interfaces:**
- README documents the real Pi canary command, gates, and inspection commands.
- Existing docs tests assert README does not advertise unavailable commands.

- [ ] **Step 1: Write failing docs assertions**

Add to `test/workflow-docs.test.js`:

```js
const readme = await readFile(join(root, "README.md"), "utf8");
assert.match(readme, /npm run smoke:fixture -- --real --agent pi --keep/);
assert.match(readme, /Real canaries require a TTY/);
assert.match(readme, /Type the exact harness name/);
```

Run:

```bash
node --test test/workflow-docs.test.js
```

Expected: FAIL because README does not yet document real Pi canary.

- [ ] **Step 2: Update README**

Add a new section near the existing workflow launcher docs:

```md
## Real harness canaries (interactive only)

Real canaries start an actual harness session and may consume API tokens. They are never run in CI or by `npm test`.

```bash
# Pi real canary — requires TTY, --keep, and typed confirmation
npm run smoke:fixture -- --real --agent pi --keep
```

Before starting, the script prints the fixture root, registry, tickets, exact assignment, and a token-cost warning. You must type exactly `pi` to confirm. On failure or timeout the fixture root and run directory are preserved for inspection.

Inspection commands for a preserved canary:

```bash
WORKFLOW_PROJECTS_FILE=<fixture-registry> workflow result <run-id>
WORKFLOW_PROJECTS_FILE=<fixture-registry> workflow reconcile --run <run-id>
WORKFLOW_PROJECTS_FILE=<fixture-registry> workflow worker status <run-id>
```

Replace `<fixture-registry>` and `<run-id>` with the paths printed by the script.
```

- [ ] **Step 3: Update canary plan amendment**

Add an amendment to `docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md` after the existing staged gates, marking Pi real canary as implemented and pending explicit execution approval:

```md
**Amendment (2026-07-23):** The real Pi canary command `npm run smoke:fixture -- --real --agent pi --keep` is implemented with TTY, `--keep`, typed-confirmation, and CI-detection gates. It remains opt-in and requires explicit per-run user approval before execution. Claude/Codex/OpenCode real canaries remain future work.
```

- [ ] **Step 4: Run final verification**

```bash
node --test test/workflow-real-canary.test.js test/workflow-docs.test.js
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: 450/451 pass, 1 skip; `git diff --check` clean; `npm pack --dry-run` ok.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md test/workflow-docs.test.js
git commit -m "docs(workflow): document real Pi canary command and gates"
```

---

## Final Verification and Handoff

After all tasks are complete and reviewed, run fresh evidence:

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
git status --short
node bin/workflow.js doctor --format compact
```

Then, before any real Pi canary execution:

1. Confirm the fake smoke still passes: `npm run smoke:fixture -- --fake --keep`.
2. Present the exact command `npm run smoke:fixture -- --real --agent pi --keep`, fixture root, expected assignment, token-cost warning, and preservation policy.
3. Obtain explicit user approval before running the real canary.
4. Run only after approval; preserve all resources with `--keep`.

Do not merge, push, close real workspaces, or remove preserved canary fixtures without a separate explicit decision.
