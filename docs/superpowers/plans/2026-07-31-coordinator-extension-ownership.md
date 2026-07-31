# Coordinator Extension Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every mutex the Pi coordinator extension takes — the run lock and the reservation gate, including the long hold `launch` keeps across worktree creation, Herdr and agent startup — carry ownership evidence, so `workflow unlock` and `workflow delegation gate-clear` can recover it instead of refusing it as `unprovable` forever.

**Architecture:** One memoized own-ownership reader is built at module scope in `.pi/extensions/workflow-coordinator/index.ts` (exactly as the two Pi worker extensions already do) and threaded into the three places the file builds mutex-taking machinery: the run store, the reservation store, and the launch command's deps. Separately, the file's fourth copy of the `ps` argv is deleted in favour of `ownership.js`'s `spawnPsStatus`, which also closes a stderr-handling divergence. No classification rule, CLI output, or transport identity contract changes.

**Design source:** [`../specs/2026-07-31-coordinator-extension-ownership-design.md`](../specs/2026-07-31-coordinator-extension-ownership-design.md) (Approved 2026-07-31). Read its "The fourth `ps` copy, in the same file" section before Task 1 — the reason for sharing the whole spawn rather than just the argv is a real defect, not tidiness.

**Predecessors:** [`../plans/2026-07-30-hook-owned-lock-ownership.md`](2026-07-30-hook-owned-lock-ownership.md) (item 1.1b) did this for the hooks and worker extensions; its shape is the one to copy.

**Tech Stack:** Node.js ESM (TypeScript file executed via native type stripping, Node >= 22.18), zero runtime dependencies, Node test runner, existing `ownership.js` / `process-observation.js` / coordinator-runtime injection seams.

## Global Constraints

- **Own identity, never the launched worker's.** The process holding the mutex is the coordinator. Recording a worker's identity would make residue from a dead coordinator classify `owner-alive`, so recovery would be refused forever — worse than today's honest `unprovable`.
- **One code path writes and reads `startedAt`.** The classifier compares it for exact string equality. No site may hand-roll a `ps` argv or its spawn.
- **Read before the mutex, never while holding it.** Both `acquireLock` (`run-store.js:478-486`) and `acquireGate` (`delegation-reservations.js:167-180`) call the reader before any mkdir; keep it there.
- **Never throw into the extension.** Any failure resolves `null`, the marker omits `pid`/`startedAt` (keys absent, never empty strings), acquisition proceeds.
- **One reader per process, memoized including failure** — the coordinator runs in-process for a whole Pi session, so this must cost one `ps` per session, not one per event. Constructing the reader must spawn nothing.
- **`readCwd` stays `fs.readlink`** in the coordinator. Swapping it to `realpath` would move the `cwd` string the transport compares against a recorded identity; identity comparison is not what this item touches.
- Zero new dependencies; every existing injection seam stays injectable; existing coordinator and transport tests must pass untouched.
- Every task ends with its covering tests passing and `npm test` green. Baseline before Task 1: **888 tests, 887 pass, 1 pre-existing skip**.

## File Structure

- Modify: `src/workflow/ownership.js` — export `spawnPsStatus` (currently module-private).
- Modify: `.pi/extensions/workflow-coordinator/index.ts` — delete `runPsForPid`, drop the dead `cwdFallback`, add the module-scope reader and thread it into three sites.
- Modify: `test/workflow-pi-extensions.test.js` — coordinator runtime wiring assertions and the real-`ps` identity round-trip.
- Modify: `test/workflow-delegation-reservations.test.js` — the reservation-gate twin of the run-lock ordering test (`test/workflow-hook-ownership.test.js:109`), and a real-reader provable gate marker. Extends `fsCapturingRead` to record chmod modes.
- Modify: `ROADMAP.md` — close out the item.

---

### Task 1: Share the `ps` spawn; delete the fourth copy

**Files:**
- Modify: `src/workflow/ownership.js` (the `spawnPsStatus` declaration, `:91`)
- Modify: `.pi/extensions/workflow-coordinator/index.ts` (`:386-417`, and the two call sites at `:439` and `:453`)
- Test: `test/workflow-pi-extensions.test.js`

**Interfaces:**

```js
// src/workflow/ownership.js — was `function spawnPsStatus(pid)`, now exported.
// Resolves {code, stdout, stderr}; resolves rather than rejects on a non-zero exit
// (inspectExactProcessByPid needs to see exit 1 + empty output to prove a pid gone).
export function spawnPsStatus(pid)
```

```ts
// .pi/extensions/workflow-coordinator/index.ts — runPsForPid is deleted entirely.
async function inspectCoordinatorPid(pid) {
  return await inspectExactProcessByPid(pid, {
    runProcess: spawnPsStatus,
    readCwd: async (path) => await fs.readlink(path),
  });
}
```

Both call sites lose their second argument: `inspectCoordinatorPid(child.pid, cwd)` → `inspectCoordinatorPid(child.pid)`, and `inspectCoordinatorPid(identity.pid, identity.cwd)` → `inspectCoordinatorPid(identity.pid)`. `cwdFallback` is dead — `inspectExactProcessByPid` destructures it as `cwdFallback: _cwdFallback` and discards it (`process-observation.js:59`).

Keep `import { spawn } from "node:child_process"` — `spawnChildProcess` still uses it. Keep `readCwd` as `fs.readlink`.

**What this changes in behaviour, and why it is the point:** the deleted copy passed `stdio: ["ignore", "pipe", "ignore"]`, discarding stderr. `inspectExactProcessByPid` proves a pid absent only when exit code is 1 **and** stdout **and** stderr are empty (`process-observation.js:48-50`), so with stderr permanently `undefined` the coordinator called "`ps` exited 1 while complaining on stderr" proven-absent where every other caller calls it ambiguous. A false `missing` from `observeExact` is the precondition `deliverFollowUp` requires before relaunching a delegation, i.e. a second writer in a checkout that already has one. The shared helper captures stderr, so that outcome becomes ambiguous — `state: "unknown"` — which is the safe direction.

The other difference is benign: the shared helper rejects when `ps` dies by signal where the copy resolved `{code: null}`, which `inspectExactProcessByPid` then rejected as ambiguous anyway. Both land in the same caller-side `catch` → `spawned-but-unverified` / `state: "unknown"`.

**Steps:**

- [ ] **Step 1: Write the failing test** — the coordinator's real default inspector, against the real `ps`, on the test process itself. It reaches the default by capturing what the runtime hands the transport (the runtime passes `inspectProcess` into `createTransportImpl`), so it exercises production wiring rather than a copy of it. Add to `test/workflow-pi-extensions.test.js`:

```js
// The coordinator's own inspector must keep reporting exactly the startedAt string the rest of
// the repo's pid observation produces: the transport records it at spawn (pi-delegation-transport
// launchIdentity) and compares it in observeExact, and a drift there degrades live children to an
// identity mismatch. Swapping runPsForPid for the shared spawnPsStatus must not move that string.
test("the coordinator's default process inspector reports the same startedAt as the shared subprocess ownership reader, for this live process", async (t) => {
  let capturedInspectProcess;
  await createWorkflowCoordinatorRuntime({
    env: { WORKFLOW_STATE_ROOT: "/state/override" },
    lookupExecutableImpl: async () => "/opt/pi/bin/pi",
    loadRegistryImpl: async () => ({ launcher: { state_root: "/state/override" }, projects: {} }),
    createRunStoreImpl: () => ({ async read() { return { id: RUN_ID, projectAlias: "fixture" }; } }),
    createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
    createReservationStoreImpl: () => ({}),
    createDelegationServicesImpl: () => ({}),
    loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
    createTransportImpl: (options) => {
      capturedInspectProcess = options.inspectProcess;
      return { async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} };
    },
  });

  // Degrade, don't silently pass: on a host without a usable `ps` the reader resolves null
  // (ownership.js swallows it by design). Skip with a named reason rather than asserting on nulls.
  const written = await createSubprocessOwnOwnershipReader()();
  if (!written) {
    t.skip("this host cannot report its own process start time via `ps`");
    return;
  }

  const observed = await capturedInspectProcess({ pid: String(process.pid), cwd: process.cwd() });
  assert.equal(observed.pid, String(process.pid));
  assert.equal(observed.startedAt, written.startedAt);
});
```

Do **not** assert on `observed.cwd`: the coordinator reads `/proc/<pid>/cwd` with `readlink`, which resolves symlinks, so it need not equal `process.cwd()` verbatim.

Import `createSubprocessOwnOwnershipReader` from `../src/workflow/ownership.js` at the top of the test file if it is not already imported.

- [ ] **Step 2: Run it and watch it pass against the OLD code** — this test passes before the change too; it is a pin, not a red test. Run `node --test test/workflow-pi-extensions.test.js` and record that it passes now, so a failure after the swap is unambiguous evidence the swap moved observable output.

- [ ] **Step 3: Export `spawnPsStatus`** from `src/workflow/ownership.js` and extend its existing doc comment to name the coordinator as its second caller (the comment currently explains only the marker-verdict reason it exists; add that the delegation transport's child identity comparison routes through the same helper so both sides of that comparison can never drift from the parse).

- [ ] **Step 4: Rewrite `inspectCoordinatorPid` and delete `runPsForPid`** in `.pi/extensions/workflow-coordinator/index.ts`, per the Interfaces block above. Import `spawnPsStatus` from `../../../src/workflow/ownership.js`. Update both call sites to drop the `cwdFallback` argument.

- [ ] **Step 5: Run the tests** — `node --test test/workflow-pi-extensions.test.js` and then `npm test`. Expected: the new test still passes; nothing else moves.

- [ ] **Step 6: Prove the copy is gone by grep, not by inspection** — run:

```bash
grep -rn 'lstart' src bin hooks .pi scripts test | grep -v node_modules
```

Expected: `process-observation.js:13` (the `psStatusArgv` definition) plus comment-only mentions and `bin/workflow.js:513` (which runs the shared `psStatusArgv` through the CLI's process runner — a different transport, not a copy). No argv literal in `.pi/`. Paste the actual output into the commit message.

- [ ] **Step 7: Commit.**

```bash
git add src/workflow/ownership.js .pi/extensions/workflow-coordinator/index.ts test/workflow-pi-extensions.test.js
git commit -m "refactor: the coordinator shares the one ps spawn instead of a fourth copy"
```

---

### Task 2: Thread the reader into the coordinator's two stores

**Files:**
- Modify: `.pi/extensions/workflow-coordinator/index.ts` (`:464-486` options list, `:501` run store, `:511` reservation store)
- Test: `test/workflow-pi-extensions.test.js`

**Interfaces:**

```ts
import { createSubprocessOwnOwnershipReader } from "../../../src/workflow/ownership.js";

// One reader per process, built at module scope -- same shape as workflow-worker-lifecycle.ts's
// and workflow-worker-observability.ts's identical defaults. Constructing it spawns nothing; the
// first mutex this session takes pays one `ps`, and createOwnOwnershipReader's memoization (which
// caches a null outcome too) means every later lock and gate in the session is free. That ratio
// is the reason a `ps` spawn inside a long-lived extension is acceptable: this coordinator holds
// the run lock across worktree creation, the Herdr calls and agent startup, the longest hold in
// the system, and residue from an interrupted launch is exactly what `workflow unlock` exists to
// recover.
const defaultReadOwnOwnership = createSubprocessOwnOwnershipReader();

export async function createWorkflowCoordinatorRuntime({
  /* …existing options, unchanged… */
  readOwnOwnership = defaultReadOwnOwnership,
} = {}) {
```

Then:

```ts
  const store = createRunStoreImpl({
    stateRoot,
    onListProblem: (problem: { runId?: string; message?: string }) => { /* unchanged */ },
    readOwnOwnership,
  });
  /* … */
  const reservations = createReservationStoreImpl({
    stateRoot,
    canonicalPath,
    readOwnOwnership,
  });
```

`readOwnOwnership` joins the existing injectable seams so tests never spawn a real `ps`.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `test/workflow-pi-extensions.test.js`. Capture the construction arguments of both store factories from one runtime built with an injected reader, and assert both received it — the *same* function object, not merely a function, because one reader per process is the property that keeps this to one `ps` per session:

```js
test("the coordinator runtime builds both mutex-taking stores with one shared readOwnOwnership reader", async () => {
  const runStoreArgs = [];
  const reservationArgs = [];
  const injectedReader = async () => ({ pid: "4242", startedAt: "2024-12-31T00:00:00.000Z" });

  await createWorkflowCoordinatorRuntime({
    env: { WORKFLOW_STATE_ROOT: "/state/override" },
    readOwnOwnership: injectedReader,
    lookupExecutableImpl: async () => "/opt/pi/bin/pi",
    loadRegistryImpl: async () => ({ launcher: { state_root: "/state/override" }, projects: {} }),
    createRunStoreImpl: (args) => { runStoreArgs.push(args); return { async read() { return { id: RUN_ID, projectAlias: "fixture" }; } }; },
    createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
    createReservationStoreImpl: (args) => { reservationArgs.push(args); return {}; },
    createDelegationServicesImpl: () => ({}),
    createTransportImpl: () => ({ async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} }),
    loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
  });

  assert.equal(runStoreArgs[0].readOwnOwnership, injectedReader);
  assert.equal(reservationArgs[0].readOwnOwnership, injectedReader);
});

// The default must be lazy: building a runtime happens on every Pi session start, and the reader
// is memoized per process, so construction itself must spawn nothing.
test("building a coordinator runtime never invokes the ownership reader", async () => {
  let readerCalls = 0;
  await createWorkflowCoordinatorRuntime({
    env: { WORKFLOW_STATE_ROOT: "/state/override" },
    readOwnOwnership: async () => { readerCalls += 1; return null; },
    lookupExecutableImpl: async () => "/opt/pi/bin/pi",
    loadRegistryImpl: async () => ({ launcher: { state_root: "/state/override" }, projects: {} }),
    createRunStoreImpl: () => ({ async read() { return { id: RUN_ID, projectAlias: "fixture" }; } }),
    createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
    createReservationStoreImpl: () => ({}),
    createDelegationServicesImpl: () => ({}),
    createTransportImpl: () => ({ async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} }),
    loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
  });
  assert.equal(readerCalls, 0);
});
```

- [ ] **Step 2: Run them and verify they fail** — `node --test test/workflow-pi-extensions.test.js`. Expected: the first test fails with `readOwnOwnership` `undefined` on both stores. The second passes already; it is a guard against a future eager reader.

- [ ] **Step 3: Implement** the module-scope reader, the new runtime option, and the two store call sites, per the Interfaces block. Keep the existing `onListProblem` closure and `canonicalPath` exactly as they are.

- [ ] **Step 4: Run the tests** — `node --test test/workflow-pi-extensions.test.js`, then `npm test`.

- [ ] **Step 5: Verify the assertions are load-bearing** — temporarily drop `readOwnOwnership` from the run store construction, re-run the file, confirm the first test fails; restore. Repeat for the reservation store. Record both observations in the commit message.

- [ ] **Step 6: Commit.**

```bash
git add .pi/extensions/workflow-coordinator/index.ts test/workflow-pi-extensions.test.js
git commit -m "fix: the coordinator's run store and reservation gate record provable ownership"
```

---

### Task 3: Give the launch command the store and the reader

**Files:**
- Modify: `.pi/extensions/workflow-coordinator/index.ts` (`:537-551`, the `createLaunchCommand` deps object)
- Test: `test/workflow-pi-extensions.test.js`

**Interfaces:** the deps object gains two keys, mirroring `bin/workflow.js:483-484`:

```ts
      }, {
        registry,
        stateRoot,
        controlPlaneBin,
        git,
        herdr,
        // Both, mirroring bin/workflow.js's live dependencies. launchCommand (commands.js:1778)
        // deliberately does NOT route through storeForCommand -- that bypass was item 1.1's
        // final-review finding 1 -- so without `store` it builds its own, and without
        // `readOwnOwnership` that fallback lands on createRunStore's `async () => null` default.
        // Passing the store means the reader cannot be lost again by a future change to
        // launchCommand's internals, and it hands launch the store whose onListProblem is already
        // wired to this file's bounded noteDiagnostic, so crash residue hit while listing gets
        // reported instead of dropped.
        store,
        readOwnOwnership,
        ensureCodexWorkerHooks: ensureCodexWorkerHooksImpl,
      });
```

**Why this task is separate from Task 2:** it is the highest-value row of the three and the one a reviewer would judge on different grounds — the others are store construction, this one is about which store `launch` uses. `launch` holds the run lock across worktree creation, the Herdr calls and agent startup: the longest hold in the system, and therefore the residue most likely to need `workflow unlock`.

**Steps:**

- [ ] **Step 1: Write the failing test** in `test/workflow-pi-extensions.test.js`:

```js
test("the coordinator hands launch the same run store and the same ownership reader it built, not launchCommand's null-default fallback", async () => {
  const launchCalls = [];
  const injectedReader = async () => ({ pid: "4242", startedAt: "2024-12-31T00:00:00.000Z" });
  const runStore = { async read() { return { id: RUN_ID, projectAlias: "fixture" }; } };

  const runtime = await createWorkflowCoordinatorRuntime({
    env: { WORKFLOW_STATE_ROOT: "/state/override" },
    readOwnOwnership: injectedReader,
    lookupExecutableImpl: async () => "/opt/pi/bin/pi",
    loadRegistryImpl: async () => ({ launcher: { state_root: "/state/override" }, projects: {} }),
    createRunStoreImpl: () => runStore,
    createDelegationStoreImpl: () => ({ async list() { return []; }, async adoptResult() { throw new Error("not used"); } }),
    createReservationStoreImpl: () => ({}),
    createDelegationServicesImpl: () => ({}),
    createTransportImpl: () => ({ async start() {}, async observeExact() {}, async deliverFollowUp() {}, async requestGracefulClose() {} }),
    loadDelegationRoleImpl: async ({ name }) => ({ name, tools: ["read"], systemPrompt: "x" }),
    createLaunchCommandImpl: async (options, dependencies) => {
      launchCalls.push({ options, dependencies });
      return { preview: { approvalDigest: `sha256:${"d".repeat(64)}` } };
    },
  });

  await runtime.createLaunchCommand({ projectAlias: "fixture", task: "ASANA-123", request: "Review launch wiring." });

  assert.equal(launchCalls[0].dependencies.store, runStore);
  assert.equal(launchCalls[0].dependencies.readOwnOwnership, injectedReader);
});
```

- [ ] **Step 2: Run it and verify it fails** — `node --test test/workflow-pi-extensions.test.js`. Expected: both assertions fail with `undefined`.

- [ ] **Step 3: Implement** — add `store` and `readOwnOwnership` to the deps object, with the comment from the Interfaces block.

- [ ] **Step 4: Run the tests** — `node --test test/workflow-pi-extensions.test.js`, then `npm test`. The existing "coordinator live runtime resolves an absolute Pi binary…" test asserts other keys of this same deps object; it must still pass untouched.

- [ ] **Step 5: Verify load-bearing** — drop each of the two keys in turn, confirm the test fails each time, restore.

- [ ] **Step 6: Commit.**

```bash
git add .pi/extensions/workflow-coordinator/index.ts test/workflow-pi-extensions.test.js
git commit -m "fix: coordinator launches inherit the run store and its ownership reader"
```

---

### Task 4: Pin the reservation gate's ownership properties

**Files:**
- Test: `test/workflow-delegation-reservations.test.js` (extend)

**Interfaces:** no production change expected. This task pins two properties of `delegation-reservations.js`'s `acquireGate` that the coordinator wiring has now made reachable from a real, non-CLI caller. If either test reveals the behaviour is actually wrong, that is a real finding: fix it and say so in the review notes rather than adjusting the assertion.

**Why now, and what is honest about it:** the ordering assertion is writable at store level today with an injected reader — the coordinator wiring is not what makes it *possible*. What the wiring changes is that the gate now has a production caller reaching it with a real reader, which is what makes the property worth pinning instead of merely true by inspection. The run lock got exactly this treatment in 1.1b (`test/workflow-hook-ownership.test.js:109`); the gate never did.

**Why this file and not `test/workflow-hook-ownership.test.js`:** every fixture these tests need already lives here — `policy`, `tempStateRoot`, `uuidSequence`, `clockSequence`, `activeGatePathFor` and `fsCapturingRead`. Only the four-line unlock-path observer has to be duplicated from `workflow-hook-ownership.test.js`'s `observeViaUnlockPath`, which is far less duplication than the other direction. That file also states in its header that it exists to prove exactly one property and must not be diluted with wiring assertions; respect that.

**The non-obvious constraint:** a successful `reserve()` **releases the gate before returning**, deleting the marker. There is nothing on disk to inspect afterward. That is why the existing tests at `:349` and `:378` observe the marker through `fsCapturingRead(markerPath)`, which captures the bytes as `releaseGate` reads them immediately before deletion. Use the same helper; do not try to read the file after `reserve()` resolves.

**Steps:**

- [ ] **Step 1: Write the ordering test** — the reservation-gate twin of the run-lock one at `test/workflow-hook-ownership.test.js:109`. `pathExists` does not exist in this file; write the three-line local helper (a `stat` in a `try`/`catch` returning a boolean) or reuse `realFs.stat` inline.

```js
// 1.1's task-2 review deliberately moved the own-ownership read out of acquireGate's critical
// section: a slow `ps` spawn must never run while the mkdir-based gate is held, both to protect
// the bounded retry budget at :191-199 and to avoid widening the window where the active gate
// directory exists with no marker yet. Until the coordinator was wired, no non-CLI caller reached
// this gate with a real reader at all, so the ordering was only ever true by inspection. This
// makes it a fact a future edit cannot silently break.
test("readOwnOwnership is invoked before the active gate directory exists (the gate's read precedes acquisition, never runs while the mutex is held)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const activeGate = activeGatePathFor(stateRoot, "fixture-single");

  let activeGateExistedDuringRead;
  const reservations = createDelegationReservationStore({
    stateRoot,
    randomUUID: uuidSequence(FIRST_ID, SECOND_ID, THIRD_ID),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    canonicalPath: async (value) => value,
    async readOwnOwnership() {
      activeGateExistedDuringRead = await pathExists(activeGate);
      return { pid: "1", startedAt: "2025-01-01T00:00:00.000Z" };
    },
  });

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.equal(reservation.state, "active");
  assert.equal(
    activeGateExistedDuringRead,
    false,
    "readOwnOwnership ran while the active gate directory already existed -- the ownership read "
    + "must complete before the gate mutex is acquired, not during or after",
  );
});
```

- [ ] **Step 2: Run it** — `node --test test/workflow-delegation-reservations.test.js`. Expected: PASS, because `acquireGate:167-180` already reads first.

- [ ] **Step 3: Verify the assertion is load-bearing** — temporarily move the `await readOwnOwnership()` block in `acquireGate` to *after* the `fs.mkdir(paths.activeGate, …)` that takes the gate, re-run, confirm the test fails, restore. A test that passes both ways proves nothing. Record the observation in the commit message.

- [ ] **Step 4: Write the provable-marker test** — a gate acquired with the *real* subprocess reader (the same one the coordinator now uses) produces a marker that classifies, and is written `0600`. Extend `fsCapturingRead` — or add a sibling helper next to it — to also record the `chmod(path, mode)` calls made against the marker path, since the file is gone by the time `reserve()` returns and its mode cannot be stat'd afterward. `writeAtomicJson` opens the temp file with `PRIVATE_FILE_MODE` and then `chmodFile(path)` applies `0o600` to the final path, so the recorded chmod is the honest observation point.

```js
// The coordinator now builds its reservation store with exactly this reader
// (createSubprocessOwnOwnershipReader), so this is the marker a real coordinator writes. The
// verdict assertion is the point: "not unprovable" alone would not distinguish a classifiable
// marker from a broken observation. This process is alive and its start time matches, so the one
// correct verdict is owner-alive.
test("a reservation gate acquired with the real subprocess ownership reader yields a marker classifyOwnership can rule on", async (t) => {
  // Degrade, don't silently pass: the reader swallows a missing/unusable `ps` and resolves null.
  const written = await createSubprocessOwnOwnershipReader()();
  if (!written) {
    t.skip("this host cannot report its own process start time via `ps`");
    return;
  }

  const stateRoot = await tempStateRoot(t);
  const markerPath = join(activeGatePathFor(stateRoot, "fixture-single"), "owner.json");
  const { fs, captured, chmodModes } = fsCapturingRead(markerPath);
  const reservations = createDelegationReservationStore({
    stateRoot,
    fs,
    randomUUID: uuidSequence(FIRST_ID, SECOND_ID, THIRD_ID),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    canonicalPath: async (value) => value,
    readOwnOwnership: createSubprocessOwnOwnershipReader(),
  });

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.equal(reservation.state, "active");
  assert.ok(captured.text, "expected releaseGate to have read the gate owner marker");
  const marker = JSON.parse(captured.text);
  assert.equal(marker.version, 2);
  assert.equal(marker.pid, String(process.pid));
  assert.equal(marker.startedAt, written.startedAt);
  assert.deepEqual(chmodModes, [0o600]);

  const verdict = classifyOwnership(marker, await observeViaUnlockPath(marker.pid));
  assert.equal(verdict.verdict, "owner-alive");
  assert.equal(verdict.removable, false);
});
```

The four-line `observeViaUnlockPath` is copied from `test/workflow-hook-ownership.test.js:38-46` — the real `createProcessRunner`, `ps` with `allowFailure: true` so a non-zero exit resolves, and `realpath` as `readCwd`. It is the exact wiring `bin/workflow.js`'s `inspectDelegationPid` gives `workflow delegation gate-clear`, which is the command whose verdict this test is really about. Add the needed imports: `classifyOwnership` and `createSubprocessOwnOwnershipReader` from `../src/workflow/ownership.js`, `inspectExactProcessByPid` and `psStatusArgv` from `../src/workflow/process-observation.js`, `createProcessRunner` from `../src/workflow/process.js`, and `realpath` from `node:fs/promises`.

- [ ] **Step 5: Run the file, then `npm test`.**

- [ ] **Step 6: Commit.**

```bash
git add test/workflow-delegation-reservations.test.js
git commit -m "test: pin the reservation gate's read-before-mutex order and marker provability"
```

---

### Task 5: Close out the roadmap

**Files:**
- Modify: `ROADMAP.md`

**Interfaces:** documentation only. No code changes; `npm test` must still be green because `test/workflow-docs.test.js` and `test/docs.test.js` read repository docs.

**Steps:**

- [ ] **Step 1: Number the item and mark it done.** The roadmap records this item as having no number yet ("Todavía no tiene número de ítem propio"). Give it **1.1c**, matching the spec header and the 1.1/1.1b sequence. Add it as a `- [x]` entry next to 1.1b in "Próximo paso sugerido", with its commit range.

- [ ] **Step 2: Rewrite the "Pendientes conocidos" entry.** The long bullet describing this gap (the one beginning "**La extensión coordinadora…**") becomes resolved, following exactly the pattern the claim-token bullet above it uses for 1.4: keep the original description, append a **Resuelto por 1.1c:** clause stating what was wired, and state plainly that the `ps` unification went further than the argv the entry names — it removed the whole spawn copy, closing a stderr-handling divergence that made the coordinator call an ambiguous `ps` result proven-absent, and a false proven-absent is what lets `deliverFollowUp` relaunch a live delegation.

- [ ] **Step 3: Add a progress-table row** — date `2026-07-31`, item `1.1c`, the commit range, and the final suite count. Follow the existing rows' level of detail: what was wired, what changed behaviourally, and the test total.

- [ ] **Step 4: Repoint the ordered list.** Item 3 of "Orden sugerido para el resto de la Fase 1" (the coordinator-extension entry) becomes struck through and marked complete, exactly as items 1 and 2 already are. **1.3** becomes the next step.

- [ ] **Step 5: Run `npm test`** — expected green, with a test total of at least 888 + the tests added by Tasks 1-4, and the same single pre-existing skip (plus any host-conditional skips from the real-`ps` guards).

- [ ] **Step 6: Commit.**

```bash
git add ROADMAP.md
git commit -m "docs: close out roadmap 1.1c, ownership in the coordinator extension"
```

---

## Verification

The spec's eleven Verification Strategy items map to these tasks:

| Spec item | Task |
|---|---|
| 1 (run store gets a reader), 2 (reservation store gets a reader) | Task 2 |
| 3 (launch deps get store + reader) | Task 3 |
| 4 (one reader object at all three sites) | Tasks 2 and 3 — same injected object asserted at every site |
| 5 (construction spawns no `ps`) | Task 2 |
| 6 (real-reader gate marker is classifiable) | Task 4 |
| 7 (`acquireGate` reads before it acquires) | Task 4 |
| 8 (one argv definition, proven by grep) | Task 1, step 6 |
| 9 (identity round-trip against the real `ps`) | Task 1, step 1 |
| 10 (`cwdFallback` removal changes nothing) | Task 1 — existing coordinator and transport tests pass untouched |
| 11 (`npm test` green) | every task |

After Task 5, run a final review of the whole branch diff against the spec before merging, as items 1.1, 1.1b and 1.4 each did.
