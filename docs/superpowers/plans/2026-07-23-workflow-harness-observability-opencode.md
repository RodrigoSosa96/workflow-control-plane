# Workflow Harness Observability and OpenCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private, normalized telemetry and operator views for Workflow-launched harnesses, add fixture-gated OpenCode support, and implement disposable fake-worker fixtures before any real harness canary.

**Architecture:** A strict telemetry domain/store accepts only bounded normalized events from harness-specific adapters and writes private snapshots through the existing run store. Read-only CLI views and a Pi-local widget render redacted snapshots. OpenCode is a `fixture-only` profile until generated fixture tests and a separately approved canary prove its structured stream, identity, handoff, and isolation behavior.

**Tech Stack:** Node.js 24 ESM, `node:test`, existing private `createRunStore`, argv-only child process launchers, Pi 0.80 extension/RPC APIs, Claude stream JSON, Codex JSONL, OpenCode JSON stream, Herdr 0.7.4, temporary Git repositories.

## Global Constraints

- Work only in an isolated feature worktree; one writer per checkout.
- Follow strict red-green-refactor TDD; each task ends with focused tests, `npm test`, `npm pack --dry-run`, and `git diff --check` where package files change.
- Telemetry is observational only and never authorizes lifecycle, retry, canonical handoff, permissions, cleanup, or a result state.
- Persist only bounded identifiers, state, timestamps, counts, safe tool names, provider-reported usage/cost, and availability; never prompts, assistant/thinking text, transcripts, tool arguments/output, stdout/stderr, credentials, session IDs/paths in public output, or raw provider events.
- Missing provider metrics are `not-reported`; malformed/unknown stream data is `unknown`; never estimate tokens or cost.
- Consume only official structured output: Pi RPC/JSON, Claude `stream-json`, Codex `exec --json`, OpenCode `run --format json`. Never scrape terminals.
- Do not read global Pi/OpenCode session state, use guessed/recent sessions, install packages, add permission/trust bypasses, use shell interpolation, or write global Pi configuration.
- Never automatically kill, close, clean up, release reservations, deploy, push, merge, or retry a worker.
- `opencode-worker` remains `fixture-only`; no canonical registered project can select it until explicit fixture, canary, and policy gates are completed and reviewed.
- Background writers remain disabled. Real fixture/canary/model/Herdr execution requires a separate explicit user approval and is not part of automated tests.

---

## File Structure

```text
src/workflow/
  telemetry.js                 Pure normalized schema, aggregation, redaction
  telemetry-store.js           Private run-artifact persistence and reads
  telemetry-adapters.js        Strict Pi/Claude/Codex/OpenCode structured-event adapters
  telemetry-watch.js           Read-only snapshot polling iterator
.pi/extensions/
  workflow-worker-observability.ts  Pi worker footer/widget and private updates
scripts/
  workflow-fixture.js          Explicit create/inspect/remove fixture CLI
  smoke-workflow-fixture.js    Opt-in fake/real smoke runner
src/workflow/
  fixture.js                   Disposable Git/registry/ticket topology
  fixture-cleanup.js           Ownership-checked fixture removal
 test/support/
  fake-workflow-agent.js       Deterministic structured fake harness worker
  fake-ticket-provider.js      Static local ticket source
```

Existing `run-store.js` remains the only component that writes private run files. `telemetry-store.js` uses `store.writePrivateFile()` under its existing per-run lock. `commands.js` owns read-only CLI use cases; `bin/workflow.js` owns parsing and process-scoped watch cleanup.

---

### Task 1: Correct Current Command Documentation Before Adding New Commands

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md`
- Modify: `test/workflow-docs.test.js`

**Interfaces:**
- The README command list must contain only commands present in `bin/workflow.js` at this task.
- `workflow hooks doctor`, `workflow resume`, and `workflow close` are described only as future lifecycle work, never runnable current commands.

- [ ] **Step 1: Write failing documentation assertions**

Add a test that extracts the README launcher command block and asserts it contains no current-command lines matching `workflow hooks doctor`, `workflow resume`, or `workflow close`, while the lifecycle plan labels all three as future/unimplemented:

```js
const readme = await readFile(join(root, "README.md"), "utf8");
const lifecycle = await readFile(join(root, "docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md"), "utf8");
assert.doesNotMatch(readme, /^workflow hooks doctor/m);
assert.doesNotMatch(readme, /^workflow resume /m);
assert.doesNotMatch(readme, /^workflow close /m);
assert.match(lifecycle, /future lifecycle work|not implemented/i);
```

- [ ] **Step 2: Run the documentation test to verify RED**

Run:

```bash
node --test test/workflow-docs.test.js
```

Expected: FAIL because the README currently advertises the unavailable commands.

- [ ] **Step 3: Make current documentation truthful**

Remove those three commands from the current launcher example and replace the prose claim with:

```md
Native lifecycle hooks, exact external resume, and explicit close remain planned downstream work. They are not commands available in this release.
```

In the lifecycle plan add an amendment directly below its goal:

```md
**Implementation status:** This document remains a future plan for external hooks/resume/close. The merged adapter supplies internal advisory delegation only; no `workflow hooks`, `workflow resume`, or `workflow close` CLI command exists yet.
```

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
node --test test/workflow-docs.test.js
npm test
git diff --check
```

Expected: all tests pass and no current README command is unavailable.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md test/workflow-docs.test.js
git commit -m "docs(workflow): distinguish planned lifecycle commands"
```

---

### Task 2: Define the Bounded Telemetry Domain and Private Store

**Files:**
- Create: `src/workflow/telemetry.js`
- Create: `src/workflow/telemetry-store.js`
- Create: `test/workflow-telemetry.test.js`
- Create: `test/workflow-telemetry-store.test.js`

**Interfaces:**

`telemetry.js` exports:

```js
export const TELEMETRY_HARNESSES = new Set(["pi", "claude", "codex", "opencode"]);
export const TELEMETRY_PHASES = new Set(["starting", "running", "tool", "retrying", "compacting", "settled", "failed", "unknown", "manual-recovery"]);
export function normalizeTelemetryEvent(input) -> NormalizedTelemetryEvent;
export function createTelemetrySnapshot({ runId, workerId, harness, profileName, startedAt }) -> TelemetrySnapshot;
export function applyTelemetryEvent(snapshot, event) -> TelemetrySnapshot;
export function publicTelemetrySnapshot(snapshot) -> PublicTelemetrySnapshot;
```

`telemetry-store.js` exports:

```js
export function createTelemetryStore({ store, clock }) -> {
  record({ runId, workerId, event }): Promise<TelemetrySnapshot>,
  read({ runId, workerId? }): Promise<TelemetrySnapshot[]>,
};
```

Private paths are exactly `telemetry/workers/<worker-id>.json` and `telemetry/events.jsonl`. `workerId` is a path-safe UUID. The store uses `store.writePrivateFile()` for snapshots and `store.appendEvent()` only with a bounded telemetry event reference; it must not append raw payloads.

- [ ] **Step 1: Write failing domain tests**

Add tests for a valid provider-reported event and invalid data:

```js
const snapshot = createTelemetrySnapshot({
  runId: "11111111-1111-4111-8111-111111111111",
  workerId: "22222222-2222-4222-8222-222222222222",
  harness: "pi",
  profileName: "pi-worker",
  startedAt: "2026-07-23T00:00:00.000Z",
});
const next = applyTelemetryEvent(snapshot, normalizeTelemetryEvent({
  type: "usage",
  harness: "pi",
  tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 },
  cost: 0.01,
}));
assert.equal(next.usage.input.value, 10);
assert.equal(next.usage.cost.availability, "reported");
assert.throws(() => normalizeTelemetryEvent({ type: "tool", tool: { command: "cat .env" } }), /unsupported field|tool/i);
assert.deepEqual(publicTelemetrySnapshot(next).identity, undefined);
```

Also test that `not-reported` is the default, raw text/prompt/session-path fields are rejected, `unknown` is terminal for telemetry authorization, and aggregation never decreases a reported counter.

- [ ] **Step 2: Write failing private-store tests**

Use a temporary `createRunStore` run and assert:

```js
const telemetry = createTelemetryStore({ store, clock: () => "2026-07-23T00:00:00.000Z" });
await telemetry.record({ runId, workerId, event: normalized });
const [saved] = await telemetry.read({ runId });
assert.equal(saved.workerId, workerId);
assert.equal(await stat(join(run.directory, "telemetry", "workers", `${workerId}.json`)).mode & 0o777, 0o600);
assert.equal((await readFile(join(run.directory, "events.jsonl"), "utf8")).includes("prompt"), false);
```

Add concurrent `record()` calls and prove the final snapshot is valid, events are bounded, and traversal/duplicate/malformed worker IDs fail without writing outside the run directory.

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/workflow-telemetry.test.js test/workflow-telemetry-store.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for both new modules.

- [ ] **Step 4: Implement strict normalization and aggregation**

Implement exact allowed event shapes. Use values such as:

```js
const EVENT_FIELDS = {
  lifecycle: new Set(["type", "harness", "phase", "at"]),
  tool: new Set(["type", "harness", "toolName", "at"]),
  usage: new Set(["type", "harness", "tokens", "cost", "context", "at"]),
  model: new Set(["type", "harness", "model", "thinking", "at"]),
  retry: new Set(["type", "harness", "attempt", "maxAttempts", "at"]),
};
```

Require finite non-negative numbers, bound tool/model/profile names to 128 UTF-8 bytes, and reject every unrecognized key. Represent each optional measurement as `{ availability, value }`, where availability is exactly `reported`, `not-reported`, or `unknown`.

Implement the store using:

```js
await store.writePrivateFile(runId, {
  relativePath: `telemetry/workers/${workerId}.json`,
  text: `${JSON.stringify(next)}\n`,
  updater: (run) => ({
    telemetry: {
      ...(run.telemetry ?? {}),
      workers: { ...(run.telemetry?.workers ?? {}), [workerId]: { phase: next.phase, updatedAt: next.updatedAt } },
    },
  }),
});
await store.appendEvent(runId, { type: "telemetry", workerId, phase: next.phase, harness: next.harness });
```

Do not place usage values, model text, session identity, or event payloads in `events.jsonl`; that journal entry is only an index/reference.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test test/workflow-telemetry.test.js test/workflow-telemetry-store.test.js
npm test
git diff --check
```

Expected: snapshots are private/redacted, malformed events fail closed, and the existing suite stays green.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/telemetry.js src/workflow/telemetry-store.js test/workflow-telemetry.test.js test/workflow-telemetry-store.test.js
git commit -m "feat(workflow): persist bounded harness telemetry"
```

---

### Task 3: Add Structured Harness Telemetry Adapters

**Files:**
- Create: `src/workflow/telemetry-adapters.js`
- Create: `test/workflow-telemetry-adapters.test.js`
- Modify: `src/workflow/telemetry.js`

**Interfaces:**

```js
export function createTelemetryAdapter({ harness, version }) -> {
  consume(record): NormalizedTelemetryEvent[],
  capabilities(): { model: boolean, usage: boolean, cost: boolean, context: boolean, session: boolean },
};
```

Adapters receive parsed JSON values, not raw stdout lines. Callers must use a strict LF JSONL decoder; neither this module nor tests read a terminal.

- [ ] **Step 1: Write failing adapter contract tests**

Use fixture JSON objects representing documented public event forms:

```js
const pi = createTelemetryAdapter({ harness: "pi", version: "0.80.10" });
assert.deepEqual(pi.consume({ type: "tool_execution_start", toolName: "edit" })[0], {
  type: "tool", harness: "pi", toolName: "edit",
});

const claude = createTelemetryAdapter({ harness: "claude", version: "2.1.218" });
assert.equal(claude.consume({ type: "assistant", message: { usage: { input_tokens: 12, output_tokens: 3 } } })[0].type, "usage");

const codex = createTelemetryAdapter({ harness: "codex", version: "0.144.3" });
assert.equal(codex.consume({ type: "thread.started", thread_id: "opaque" }).some((event) => event.type === "lifecycle"), true);

const opencode = createTelemetryAdapter({ harness: "opencode", version: "1.0.126" });
assert.equal(opencode.consume({ type: "session.updated", properties: { status: "busy" } })[0].phase, "running");
```

Add cases proving unknown event versions/types yield a single `{ type: "lifecycle", phase: "unknown" }` event without retaining opaque IDs, content, tool arguments, or text. Add a test that `opencode stats` aggregate input is rejected by the per-run adapter.

- [ ] **Step 2: Run RED tests**

Run:

```bash
node --test test/workflow-telemetry-adapters.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `telemetry-adapters.js`.

- [ ] **Step 3: Implement adapter table and strict field extraction**

Implement a frozen adapter table keyed by harness. Each parser must select only explicit primitive fields and call `normalizeTelemetryEvent()`. For example:

```js
function usageEvent(harness, usage = {}) {
  return normalizeTelemetryEvent({
    type: "usage",
    harness,
    tokens: {
      input: usage.input ?? usage.input_tokens,
      output: usage.output ?? usage.output_tokens,
      cacheRead: usage.cacheRead ?? usage.cache_read_input_tokens,
      cacheWrite: usage.cacheWrite ?? usage.cache_creation_input_tokens,
    },
    ...(Number.isFinite(usage.cost?.total) ? { cost: usage.cost.total } : {}),
  });
}
```

Never copy `message.content`, `delta`, `arguments`, command output, session/thread IDs, or provider error bodies. Unsupported version/event combinations return `unknown`, not partial interpretation.

- [ ] **Step 4: Add parser fuzz/regression cases**

Add JSON objects with oversized model/tool strings, arrays where objects are expected, negative/NaN numbers, embedded transcript fields, and unknown nested fields. Assert no adapter result exposes those values or throws raw input text.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test test/workflow-telemetry.test.js test/workflow-telemetry-adapters.test.js
npm test
git diff --check
```

Expected: all harness adapters are strict, bounded, and pure.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/telemetry.js src/workflow/telemetry-adapters.js test/workflow-telemetry.test.js test/workflow-telemetry-adapters.test.js
git commit -m "feat(workflow): normalize structured harness telemetry"
```

---

### Task 4: Add a Fixture-Gated Structured Stream Supervisor

**Files:**
- Create: `src/workflow/harness-supervisor.js`
- Create: `bin/workflow-worker.js`
- Create: `test/workflow-harness-supervisor.test.js`
- Modify: `src/workflow/run-store.js`
- Modify: `src/workflow/execute.js`

**Interfaces:**

The supervisor is the only component that consumes stdout from a fixture worker. It accepts a frozen private launch record, not user-controlled argv:

```js
export function createHarnessSupervisor({ spawn, telemetry, createAdapter, clock }) -> {
  run({ runId, workerId, launch }): Promise<{ pid, startedAt, exitCode }>;
};
```

A launch record is written atomically to `worker-launches/<worker-id>.json` through `store.writePrivateFile()` only after Workflow approval. It contains the exact approved `{ harness, command, argv, cwd, env, version }` and is private because argv may contain the already-private bootstrap assignment. `bin/workflow-worker.js` accepts only:

```text
workflow-worker --run <path-safe-uuid> --worker <path-safe-uuid>
```

It loads the record from the exact private run path, never accepts `--command`, `--argv`, `--cwd`, `--env`, `--session`, or a prompt, spawns with `shell: false`, parses strict LF JSONL from stdout, and forwards only normalized adapter events to `createTelemetryStore().record()`.

This supervisor is enabled only when the selected registry has `launcher.fixture_mode: true`. Real project launches keep their existing direct harness behavior until a separate approved canary/policy change; no production worker is silently switched to print/JSON mode in this plan.

- [ ] **Step 1: Write failing supervisor tests**

Use a fake spawn implementation whose stdout emits chunk-split LF JSONL records and whose stderr contains forbidden text:

```js
const result = await supervisor.run({ runId, workerId, launch: {
  harness: "opencode", command: "opencode", argv: ["run", "--format", "json", "fixture"], cwd: fixtureWorktree, env: safeEnv, version: "1.0.126",
} });
assert.equal(result.exitCode, 0);
const [snapshot] = await telemetry.read({ runId });
assert.equal(snapshot.harness, "opencode");
assert.equal(snapshot.phase, "settled");
assert.equal(JSON.stringify(snapshot).includes("forbidden stderr"), false);
```

Assert the decoder accepts only `\n` delimiters, carries a split UTF-8 chunk safely, rejects invalid JSON/oversized lines as `unknown`, never treats stderr or process exit as a canonical result, and rejects a launch record with extra keys or an argv shell string.

- [ ] **Step 2: Write failing private launch-record tests**

Add a run-store test that writes one `worker-launches/<uuid>.json` record with an updater reference and proves path traversal, arbitrary file reads, duplicate worker IDs, missing fixture mode, and changed frozen launch data fail before spawn. Assert the artifact is mode `0600` and no public command can read it.

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/workflow-harness-supervisor.test.js test/workflow-run-store.test.js
```

Expected: FAIL because the supervisor, worker executable, and launch-record behavior do not exist.

- [ ] **Step 4: Implement strict record loading and stream consumption**

Implement a `StringDecoder("utf8")` LF-only parser rather than `readline`. Its handling is:

```js
for (const record of decodeLfJsonl(stdoutChunks)) {
  for (const event of adapter.consume(record)) {
    await telemetry.record({ runId, workerId, event });
  }
}
```

On parser/adapter failure, record a bounded `unknown` lifecycle event and preserve the worker process/result state for manual inspection. Do not read or relay stderr. On child `spawn`, record `starting`/`running`; on clean exit record `settled`; on nonzero exit record `failed`; neither outcome writes a handoff/result.

`workflow-worker` loads registry/state only from the exact run's persisted approved launch record. Verify fixture mode before spawning, verify the record hash stored in run metadata, and use `spawn(command, argv, { cwd, env, shell: false })`.

- [ ] **Step 5: Wire only fixture launches**

In `executeLaunch`, when `registry.launcher.fixture_mode === true` and an approved profile declares `mode: "stream-json"`, write the frozen private launch record and ask Herdr to start `node <absolute-package-bin>/workflow-worker.js --run <runId> --worker <workerId>`. For every canonical registry/profile, preserve the direct existing `buildHarnessLaunch()` argv path. Add regression tests proving an ordinary OCR launch never uses the supervisor.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --test test/workflow-harness-supervisor.test.js test/workflow-run-store.test.js test/workflow-execute.test.js
npm test
git diff --check
```

Expected: only generated fixture registries may stream structured telemetry; stdout/stderr never becomes result truth.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/harness-supervisor.js bin/workflow-worker.js src/workflow/run-store.js src/workflow/execute.js test/workflow-harness-supervisor.test.js test/workflow-run-store.test.js test/workflow-execute.test.js
git commit -m "feat(workflow): supervise fixture harness telemetry streams"
```

---

### Task 5: Expose Redacted Worker Status and Watch Commands

**Files:**
- Create: `src/workflow/telemetry-watch.js`
- Modify: `src/workflow/commands.js`
- Modify: `src/workflow/format.js`
- Modify: `bin/workflow.js`
- Create: `test/workflow-telemetry-watch.test.js`
- Modify: `test/workflow-cli.test.js`
- Modify: `test/workflow-format.test.js`

**Interfaces:**

```text
workflow worker status <run-id> [--format compact|json]
workflow worker watch <run-id> [--format compact|json]
```

Export command use cases:

```js
export async function workerStatusCommand({ runId }, deps) -> { command: "worker-status", workers: PublicTelemetrySnapshot[] };
export function createWorkerWatch({ runId, telemetry, intervalMs, clock, sleep }) -> AsyncIterable<PublicTelemetrySnapshot[]>;
```

`watch` is read-only, process-scoped, and stops on caller abort/EOF. It must not start a daemon, manipulate workers, or use filesystem watcher state outside the requested run.

- [ ] **Step 1: Write failing parser and command tests**

Add parsing assertions:

```js
assert.deepEqual(parseArgs(["worker", "status", runId, "--format", "json"]), {
  command: "worker-status", runId, format: "json",
});
assert.deepEqual(parseArgs(["worker", "watch", runId]), {
  command: "worker-watch", runId, format: "compact",
});
assert.throws(() => parseArgs(["worker", "watch", runId, "--interval", "1"]), /does not accept/i);
```

Inject a fake telemetry store containing two workers. Assert JSON contains phase/model/usage availability but not `sessionPath`, `sessionId`, `pid`, `cwd`, claim token, tool arguments, or raw event data.

- [ ] **Step 2: Write failing watch tests**

Use deterministic `sleep` and a sequence of snapshots:

```js
const watch = createWorkerWatch({ runId, telemetry, intervalMs: 1, clock, sleep });
assert.deepEqual(await watch.next(), { value: [starting], done: false });
assert.deepEqual(await watch.next(), { value: [running], done: false });
await watch.return();
assert.equal(sleepCalls, 1);
```

Assert repeated identical snapshots are suppressed, changed snapshots emit once, abort ends iteration, and no telemetry write method is called.

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/workflow-telemetry-watch.test.js test/workflow-cli.test.js test/workflow-format.test.js
```

Expected: FAIL because the `worker` CLI family and watch module do not exist.

- [ ] **Step 4: Implement parsing, commands, formatter, and read-only watch**

Add `worker` as a top-level parser family with only `status` and `watch`; accept only a path-safe run UUID and `--format`. Add exact HELP lines.

Format compact snapshots as:

```js
function formatWorker(snapshot) {
  const usage = snapshot.usage;
  return [
    `[${snapshot.harness} • ${snapshot.workerId} • ${snapshot.phase}] model: ${snapshot.model ?? "not-reported"} | turn ${snapshot.turns}`,
    `usage: ${usage.input.label} input / ${usage.output.label} output | cost: ${usage.cost.label}`,
  ].join("\n");
}
```

Use public/redacted objects only. Implement `watch` with an injected abort signal and `setTimeout`-backed sleep in `main`; on Ctrl+C, stop the local watch iterator without signaling any child process.

- [ ] **Step 5: Add exit/error behavior tests**

Assert missing telemetry returns an empty `workers` list and exit `0`; malformed private telemetry produces a bounded `PREFLIGHT`/manual-recovery error rather than printing a path or raw JSON; `watch` never starts a transport or calls Herdr.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --test test/workflow-telemetry-watch.test.js test/workflow-cli.test.js test/workflow-format.test.js
npm test
npm pack --dry-run
git diff --check
```

Expected: the CLI is read-only and package-safe.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/telemetry-watch.js src/workflow/commands.js src/workflow/format.js bin/workflow.js test/workflow-telemetry-watch.test.js test/workflow-cli.test.js test/workflow-format.test.js
git commit -m "feat(workflow): expose redacted worker telemetry"
```

---

### Task 6: Add Fixture-Only OpenCode Profile and Safe Launch Builder

**Files:**
- Modify: `src/workflow/registry.js`
- Modify: `src/workflow/profiles.js`
- Modify: `src/workflow/harnesses.js`
- Modify: `src/workflow/execute.js`
- Modify: `src/workflow/planner.js`
- Modify: `projects.yaml`
- Modify: `test/workflow-registry.test.js`
- Modify: `test/workflow-profiles.test.js`
- Modify: `test/workflow-harnesses.test.js`
- Modify: `test/workflow-execute.test.js`

**Interfaces:**

Extend profile schema with:

```yaml
opencode-worker:
  harness: opencode
  command: opencode
  mode: stream-json
  roles: [coordinator, implementer, reviewer]
  model: null
  arguments: []
  availability: fixture-only
```

`launcher.fixture_mode: true` is valid only in generated fixture registries. `resolveAgentProfile()` must reject `availability: fixture-only` unless that flag is true. Canonical `projects.yaml` may declare the profile but must not add it to any project `allowed_agent_profiles` or make it a default.

`buildHarnessLaunch()` adds:

```js
function opencodeArgv({ profile, sessionName, run }) {
  const argv = [profile.command, "run", "--format", "json", "--title", sessionName];
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  const bootstrap = runBootstrapPrompt(run);
  if (bootstrap) argv.push(bootstrap);
  return argv;
}
```

The Herdr execution cwd remains the approved worktree. No `--continue`, `--session`, `--agent`, `--command`, `--port`, `--attach`, `--share`, or caller-provided raw override may enter a profile argument list.

- [ ] **Step 1: Write failing registry/profile tests**

Add an OpenCode fixture profile to test registry input and assert it validates only with `fixture_mode: true`:

```js
fixtureRegistry.launcher.fixture_mode = true;
fixtureRegistry.launcher.agent_profiles["opencode-worker"] = opencodeProfile;
assert.equal(validateRegistry(fixtureRegistry).launcher.agent_profiles["opencode-worker"].harness, "opencode");

const realRegistry = structuredClone(fixtureRegistry);
delete realRegistry.launcher.fixture_mode;
assert.throws(() => resolveAgentProfile({ registry: validateRegistry(realRegistry), project, requestedProfile: "opencode-worker" }), /fixture-only/i);
```

Test that raw `--continue`, `-c`, `--session`, `-s`, `--attach`, `--port`, `--share`, `--command`, and NUL-containing arguments are rejected.

- [ ] **Step 2: Write failing launch/execute tests**

```js
const spec = buildHarnessLaunch({ profileName: "opencode-worker", profile: opencodeProfile, sessionName: "fixture-fix-101", cwd: "/fixture/worktree", run });
assert.deepEqual(spec.argv.slice(0, 5), ["opencode", "run", "--format", "json", "--title"]);
assert.equal(spec.argv.includes("--continue"), false);
assert.equal(spec.expected.harness, "opencode");
```

Assert generic agent start validation accepts exactly the `opencode` executable for an `opencode` profile and rejects `pi`, `codex`, or arbitrary renamed commands. Assert doctor/preflight reports `fixture-only` as unavailable outside a fixture registry before any Herdr mutation.

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/workflow-registry.test.js test/workflow-profiles.test.js test/workflow-harnesses.test.js test/workflow-execute.test.js
```

Expected: FAIL because `opencode` is unsupported.

- [ ] **Step 4: Implement schema and builder changes**

Add `opencode` to the harness sets shared by registry, harness builder, and execution identity checks. Add the profile-specific field set:

```js
opencode: new Set([...COMMON_PROFILE_FIELDS, "availability"])
```

Validate `mode === "stream-json"` for OpenCode and `availability === "fixture-only"`. Reject every unstructured OpenCode transport/control option listed above, including `--option=value` and split forms. Preserve existing Pi/Claude/Codex validation exactly.

Add `opencodeArgv()` and select it explicitly in `buildHarnessLaunch()`. Keep native session ID `null` until a fixture establishes a stable provider-owned identity; do not invent an ID or use a recent OpenCode session.

- [ ] **Step 5: Keep canonical registry gated**

Add the global `opencode-worker` candidate profile to `projects.yaml` with `availability: fixture-only`; do not add it to any project profile allowlist or defaults. Update docs tests to assert that canonical projects cannot select it.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --test test/workflow-registry.test.js test/workflow-profiles.test.js test/workflow-harnesses.test.js test/workflow-execute.test.js
npm test
git diff --check
```

Expected: OpenCode can be planned only by a fixture registry and existing harness behavior remains unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/registry.js src/workflow/profiles.js src/workflow/harnesses.js src/workflow/execute.js src/workflow/planner.js projects.yaml test/workflow-registry.test.js test/workflow-profiles.test.js test/workflow-harnesses.test.js test/workflow-execute.test.js
git commit -m "feat(workflow): add fixture-gated OpenCode harness"
```

---

### Task 7: Add the Pi Worker Observability Widget

**Files:**
- Create: `.pi/extensions/workflow-worker-observability.ts`
- Modify: `package.json`
- Create: `test/workflow-pi-observability.test.js`
- Modify: `test/workflow-docs.test.js`

**Interfaces:**

The extension loads only when passed explicitly with `--extension <absolute-package-path>`. It recognizes only the existing allowlisted worker environment keys:

```text
WORKFLOW_RUN_ID
WORKFLOW_RUN_DIR
WORKFLOW_GENERATION
WORKFLOW_HARNESS=pi
WORKFLOW_STATE_ROOT
WORKFLOW_CONTROL_PLANE_BIN
```

It imports the telemetry domain/store from the packaged local source and uses:

```ts
pi.on("session_start", async (_event, ctx) => { /* initialize exact run state and widget */ });
pi.on("turn_start", async (_event, ctx) => { /* record running turn */ });
pi.on("tool_execution_start", async (event, ctx) => { /* record safe tool name */ });
pi.on("tool_execution_end", async (_event, ctx) => { /* clear tool phase */ });
pi.on("message_end", async (event, ctx) => { /* record provider usage only */ });
pi.on("agent_settled", async (_event, ctx) => { /* record settled */ });
pi.on("session_shutdown", async () => { /* clear in-memory widget only */ });
```

- [ ] **Step 1: Write failing extension tests**

Use a fake Pi extension API and a temporary private run store. Assert the factory itself creates no timer, watcher, process, or write. Then invoke `session_start` and `turn_start`:

```js
await handlers.session_start({ reason: "startup" }, context);
await handlers.turn_start({ turnIndex: 1 }, context);
assert.match(widgetLines.at(0), /pi.*running.*turn 1/i);
const [snapshot] = await telemetry.read({ runId });
assert.equal(snapshot.phase, "running");
```

Feed an assistant `message_end` with usage and assert token/cost values persist. Feed a tool event containing `{ command: "cat .env" }` and assert only the safe `toolName` survives. Assert invalid/missing env leaves the extension inert. Assert `session_shutdown` clears the widget but does not delete telemetry or signal a process.

- [ ] **Step 2: Run RED tests**

Run:

```bash
node --test test/workflow-pi-observability.test.js
```

Expected: FAIL because the extension does not exist.

- [ ] **Step 3: Implement session-scoped widget and telemetry calls**

Use `ctx.ui.setWidget("workflow-worker-observability", lines)` and `ctx.ui.setStatus("workflow-worker-observability", status)` only in TUI mode. For JSON/RPC/print modes, record the same normalized telemetry but make no TUI calls.

Build widget lines solely from `publicTelemetrySnapshot(snapshot)`. Use `ctx.model` for model/thinking metadata and finalized assistant `usage`; never inspect message content. Start no resource in the factory; no file watcher is needed because the extension owns only its own session state.

- [ ] **Step 4: Package and document explicit loading**

Ensure `.pi/extensions` remains in `package.json.files`. Add README text showing the extension is packaged and explicitly supplied only by Workflow-launched Pi workers; users do not install it globally or trust it automatically.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test test/workflow-pi-observability.test.js test/workflow-docs.test.js
npm test
npm pack --dry-run
git diff --check
```

Expected: package contains the extension but no generated session/telemetry artifacts.

- [ ] **Step 6: Commit**

```bash
git add .pi/extensions/workflow-worker-observability.ts package.json README.md test/workflow-pi-observability.test.js test/workflow-docs.test.js
git commit -m "feat(workflow): show Pi worker telemetry widget"
```

---

### Task 8: Build Ownership-Marked Disposable Fixtures and Fake Structured Workers

**Files:**
- Create: `src/workflow/fixture.js`
- Create: `src/workflow/fixture-cleanup.js`
- Create: `scripts/workflow-fixture.js`
- Create: `test/support/fake-ticket-provider.js`
- Create: `test/support/fake-workflow-agent.js`
- Create: `test/workflow-fixture.test.js`
- Create: `test/workflow-fake-agent.test.js`
- Modify: `package.json`

**Interfaces:**

```js
export async function createWorkflowFixture({ root, packageRoot, clock, randomUUID }) -> FixtureDescriptor;
export async function loadFixtureDescriptor(root) -> FixtureDescriptor;
export async function assertOwnedFixture(root, fixtureId) -> FixtureMarker;
export async function cleanupWorkflowFixture(descriptor, { herdr, confirm }) -> void;
```

The generated registry has `launcher.fixture_mode: true`, all roots under its generated root, static local tickets, fake Pi/Claude/Codex/OpenCode profiles, and no canonical `projects.yaml` path. It includes `fixture-single` (`FIX-101`, `FIX-102`) and `fixture-bundle` (`FIX-201`, `FIX-202`, `FIX-203`) repositories.

- [ ] **Step 1: Write failing fixture generator tests**

```js
const fixture = await createWorkflowFixture({
  root: join(parent, "workflow-fixture-test"),
  packageRoot,
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
});
assert.equal(fixture.id, "11111111-1111-4111-8111-111111111111");
assert.equal((await readJson(join(fixture.root, ".workflow-fixture.json"))).ownedBy, "workflow-launcher-fixture-v1");
assert.equal(fixture.registry.launcher.fixture_mode, true);
assert.equal(fixture.registry.launcher.agent_profiles["opencode-worker"].availability, "fixture-only");
```

Assert each generated repository has one initial commit and a local `node --test` command; all registry/state/worktree paths remain under the fixture root; no `.env`, credentials, remote URL, canonical project path, or copied source exists. Test cleanup refusal for `/tmp`, root mismatch, symlink escape, missing/wrong marker, mismatched UUID, and non-fixture Herdr workspace.

- [ ] **Step 2: Write failing fake-worker tests**

Make the fake worker consume a harness-specific structured input and emit only synthetic official-shaped telemetry objects. Cover Pi RPC, Claude stream JSON, Codex JSONL, and OpenCode `run --format json` forms:

```js
const result = await runFakeWorker({ harness: "opencode", fixture, run, prompt: "fixture request" });
assert.equal(result.edits, 1);
assert.equal(result.handoff.status, "completed");
assert.equal(result.events.some((event) => event.type === "usage"), true);
assert.equal(result.events.some((event) => JSON.stringify(event).includes("fixture request")), false);
```

Assert each fake edits exactly one fixture file, runs local tests, records telemetry through the real adapter/store, submits the production structured handoff, and produces no network/model request.

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/workflow-fixture.test.js test/workflow-fake-agent.test.js
```

Expected: FAIL because fixture/fake modules do not exist.

- [ ] **Step 4: Implement fixture creation and guarded removal**

Use argv-only Git commands:

```text
git init --initial-branch main <path>
git -C <path> config user.name Workflow Fixture
git -C <path> config user.email workflow-fixture@example.invalid
git -C <path> add --all
git -C <path> commit -m "test: initialize workflow fixture"
```

Create `.workflow-fixture.json` with exact UUID and `ownedBy: "workflow-launcher-fixture-v1"`. Before any removal, resolve real paths, require marker/UUID/ownership, verify every target is under the root, and require an explicit confirmation callback. `--keep` always wins. Never initialize, fetch, push, or inspect a canonical project repository.

- [ ] **Step 5: Implement fake worker and manual fixture CLI**

The fake worker must call the same assignment/run-store/handoff/telemetry interfaces as production code. It may not fabricate a successful result by writing `result.json` directly.

Add package scripts:

```json
{
  "fixture:create": "node scripts/workflow-fixture.js create --keep",
  "fixture:inspect": "node scripts/workflow-fixture.js inspect",
  "smoke:fixture": "node scripts/smoke-workflow-fixture.js"
}
```

`workflow-fixture create` prints only the generated root, registry path, fixture ticket IDs, state root, and a copy-paste `WORKFLOW_PROJECTS_FILE=... node bin/workflow.js launch ... --dry-run` command.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --test test/workflow-fixture.test.js test/workflow-fake-agent.test.js
npm test
npm pack --dry-run
git diff --check
```

Expected: generated fixtures are disposable and automated tests launch no real model or Herdr process.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/fixture.js src/workflow/fixture-cleanup.js scripts/workflow-fixture.js test/support/fake-ticket-provider.js test/support/fake-workflow-agent.js test/workflow-fixture.test.js test/workflow-fake-agent.test.js package.json
git commit -m "test(workflow): create disposable harness fixtures"
```

---

### Task 9: Exercise Full Fake Integration, Writer Gates, and Opt-In Canary Planning

**Files:**
- Create: `scripts/smoke-workflow-fixture.js`
- Create: `test/workflow-fixture-integration.test.js`
- Create: `test/workflow-herdr-smoke.test.js`
- Create: `test/workflow-real-canary.test.js`
- Modify: `src/workflow/reconcile.js`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md`
- Modify: `test/workflow-docs.test.js`

**Interfaces:**

```text
npm run smoke:fixture -- --fake --keep
npm run smoke:fixture -- --real --agent pi --keep
npm run smoke:fixture -- --real --agent claude --keep
npm run smoke:fixture -- --real --agent codex --keep
npm run smoke:fixture -- --real --agent opencode --keep
```

`--real` must require TTY, print exact assignment and a token-cost warning, require the user to type the exact selected harness name, and refuse without `--keep`. It is never invoked by `npm test`.

- [ ] **Step 1: Write failing full integration tests**

Use generated fixtures, fake Herdr adapters, production launch commands, run store, handoff, reconciliation, and telemetry adapters. Cover all four harnesses in a table-driven test:

```js
for (const agentProfile of ["pi-worker", "claude-worker", "codex-worker", "opencode-worker"]) {
  const preview = await launchCommand({ projectAlias: "fixture-single", task: "FIX-101", agentProfile, dryRun: true, request: "fixture edit" }, deps);
  const run = await launchCommand({ ...preview.executionInput.options, approvalDigest: preview.approvalDigest, yes: true }, deps);
  await fakeWorker.complete(run, { harness: preview.selection.harness });
  assert.equal((await resultCommand({ runId: run.id }, deps)).status, "completed");
  assert.equal((await workerStatusCommand({ runId: run.id }, deps)).workers[0].phase, "settled");
}
```

Add a read-only background delegation fixture proving capacity, exact session identity, prepared request consumption, result delivery, and no terminal-derived data. Add a writer fixture proving exactly one writer per fixture checkout, rejected competitor, remediation cap of two, preserved reservation history, and no cleanup.

- [ ] **Step 2: Write failing smoke/canary safety tests**

Assert `smoke-workflow-fixture.js` rejects `--real` without TTY, missing `--keep`, wrong typed harness confirmation, unknown harness, and canonical registry paths before any spawn. Assert `npm test` cannot execute a real canary: the test only verifies commands/guards and contains no model invocation.

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/workflow-fixture-integration.test.js test/workflow-herdr-smoke.test.js test/workflow-real-canary.test.js
```

Expected: FAIL because smoke runner and integration fixtures do not exist.

- [ ] **Step 4: Implement fake integration and smoke runner**

Implement fake mode using only generated registry/ticket paths and fake Herdr. `--fake --keep` preserves resources and prints safe inspection commands. Use the existing reconcile behavior to ensure current external handoff remains canonical and telemetry stays observational.

For real mode, perform all safety checks before resolving a binary or starting Herdr:

```js
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Real canaries require a TTY");
if (!args.keep) throw new Error("Real canaries require --keep");
const confirmed = await promptExactHarness(args.agent);
if (confirmed !== args.agent) throw new Error("Real canary was not confirmed");
```

Real mode may be implemented but not executed. It creates only a generated fixture root and always sets `WORKFLOW_PROJECTS_FILE` to its generated registry.

- [ ] **Step 5: Update gate documentation**

Document the exact progression:

```text
artifact checks → fake policy/transport → read-only delegation fixture → one-writer fixture → real-Herdr fake-worker smoke → individually approved Pi → Claude → Codex → OpenCode canaries → policy review
```

State that OpenCode remains fixture-only until its own canary passes and is reviewed. State that background writers remain disabled regardless of a successful canary until a separately reviewed policy change.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --test test/workflow-fixture-integration.test.js test/workflow-herdr-smoke.test.js test/workflow-real-canary.test.js test/workflow-docs.test.js
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: all automated checks pass without fixture/canary/model/Herdr activity outside temporary fake adapters.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-workflow-fixture.js test/workflow-fixture-integration.test.js test/workflow-herdr-smoke.test.js test/workflow-real-canary.test.js src/workflow/reconcile.js README.md docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md test/workflow-docs.test.js package.json
git commit -m "test(workflow): gate harness fixtures and canaries"
```

---

## Final Verification and Handoff

After every task review is clean, run with fresh evidence:

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
git status --short
node bin/workflow.js doctor --format compact
```

Do not run `workflow hooks doctor`: it is documented as future work and is not an implemented command.

Before any real smoke or canary, present the exact command, fixture root, harness, token/cost warning, preservation behavior, and required confirmation to the user. Do not run it until explicitly approved. A successful automated suite, fake fixture, or real canary does not by itself enable OpenCode for a canonical project or enable background writers.
