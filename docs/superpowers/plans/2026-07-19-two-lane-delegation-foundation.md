# Two-Lane Delegation Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tested, non-agent-running foundation for governed internal Pi delegations: project policy, private delegation state, durable concurrency/writer reservations, prepared-request validation, and a narrow transport contract.

**Architecture:** The existing private run store remains the parent-run authority. A delegation store persists only bounded delegation metadata in the parent run plus private frozen-brief/result artifacts under that run directory. A separate private reservation store serializes project-wide concurrency and writer ownership across parent runs. The first implementation contains only pure policy, persistence, fake transport, and validation code; no package is installed, no hook is written, and no agent process is launched.

**Tech Stack:** Node.js 24 ES modules, `node:test`, `node:crypto`, `node:fs/promises`, existing YAML registry v3 and private run-store locking.

## Scope boundary

This is rollout phase 1 from `docs/superpowers/specs/2026-07-19-two-lane-delegation-governance-design.md`. It intentionally precedes the revised lifecycle/coordinator/package plan and the fixture/canary plan because those pieces must consume these interfaces. Do not add `.pi/settings.json`, invoke `pi install`, write hook configuration, launch Herdr, start a model, or exercise a real package during this plan.

## Global Constraints

- Follow strict red-green-refactor TDD for every production behavior.
- `workflow` remains the authority for assignments, worktrees, lifecycle, reconciliation, and canonical external-worker handoffs.
- Internal delegation output is advisory evidence; it never completes or closes an external run.
- No terminal content, pane capture, transcript, or process name is a result protocol.
- Every persistent state/artifact directory is `0700`; every persistent file is `0600`.
- Persist only bounded metadata, digests, and structured summaries in state; never persist raw prompts, transcripts, credentials, or arbitrary environment data.
- Do not automatically remove a lock, worktree, branch, workspace, run, reservation, or session. A released reservation is retained as audit state.
- One writer per checkout and maximum delegation depth one are invariants, not configurable relaxations.
- Initial project defaults are exactly: `totalInternal: 4`, `foreground: 3`, `readOnlyBackground: 3`, `writersTotal: 1`, `writersPerCheckout: 1`, `maxDepth: 1`, and `remediationTurns: 2`.
- `remediationTurns` accepts only integers from 0 through 2.
- Package-specific async, worktree, scheduling, configuration, and administrative operations remain denied until the later coordinator implementation explicitly allows a prepared request.
- No fetch, rebase, reset, push, merge, deployment, production mutation, destructive migration, or cleanup command.
- End every task with focused tests, `npm test`, `git diff --check`, specification review, and code-quality review.

---

## Planned File Structure

```text
src/workflow/
  delegation-policy.js             Registry policy defaults, validation, resolution, role/mode rules
  delegation-store.js              Frozen brief, bounded delegation state, generation/result transitions
  delegation-reservations.js       Durable policy-budget and writer-checkout reservations
  worker-transport.js              Narrow transport contract and deterministic fake implementation
  coordinator-policy.js            Prepared-request fingerprinting and fail-closed subagent policy
  registry.js                      Accept/normalize launcher and per-project delegation policy
  run-store.js                     Atomic private child-artifact primitive under an existing run lock
projects.yaml                      Explicit global delegation defaults

test/
  workflow-delegation-policy.test.js
  workflow-delegation-store.test.js
  workflow-delegation-reservations.test.js
  workflow-worker-transport.test.js
  workflow-coordinator-policy.test.js
  workflow-registry.test.js        Extended schema/default tests

docs/superpowers/plans/
  2026-07-19-supervised-lifecycle-pi-coordinator.md
  2026-07-19-workflow-fixture-canaries.md
```

## Shared contracts

All digest values use the exact `sha256:<lowercase-hex>` form.

```js
// src/workflow/delegation-policy.js
export const MANAGED_DELEGATION_ROLES = Object.freeze([
  "scout",
  "spec-reviewer",
  "code-reviewer",
  "sdd-implementer",
]);

export function resolveDelegationPolicy({ registry, projectAlias }) {}
export function validateDelegationPolicy(value, context) {}
export function classifyDelegationRole(role) {}

// src/workflow/delegation-store.js
export function createDelegationStore({ store, clock, randomUUID }) {}
// prepare({ runId, input })
// claim({ runId, delegationId })
// recordSession({ runId, delegationId, session })
// recordResult({ runId, delegationId, result })
// beginRemediation({ runId, delegationId, expectedGeneration })
// list({ originSessionId })

// src/workflow/delegation-reservations.js
export function createDelegationReservationStore({ stateRoot, fs, clock, randomUUID, canonicalPath }) {}
// reserve({ projectAlias, delegationId, role, mode, checkoutPath, policy })
// release({ reservation })
// list({ projectAlias })

// src/workflow/worker-transport.js
export function assertWorkerTransport(transport) {}
export function createFakeWorkerTransport({ observations = [] } = {}) {}

// src/workflow/coordinator-policy.js
export function createPreparedDelegationRequest({ delegation, policy }) {}
export function validateSubagentRequestPolicy({ request, prepared, policy, reservation }) {}
```

A prepared delegation request is an immutable normalized object containing only:

```js
{
  delegationId,
  role,
  mode,                 // "foreground" | "background"
  cwd,
  concurrency,
  async,
  worktree,
  taskDigest,           // sha256:<hex>, derived from the exact subagent task text
  requestFingerprint,   // sha256:<hex>
}
```

The fingerprint is calculated from a canonical JSON serialization with lexicographically sorted keys of exactly those fields except `requestFingerprint`. Incoming subagent task text is SHA-256 hashed before comparison; neither the fingerprint input nor persisted state contains a prompt body.

### Task 1: Validate and resolve versioned delegation policy

**Files:**
- Create: `src/workflow/delegation-policy.js`
- Create: `test/workflow-delegation-policy.test.js`
- Modify: `src/workflow/registry.js`
- Modify: `projects.yaml`
- Modify: `test/workflow-registry.test.js`

**Interfaces:**
- Consumes registry v3 launcher/project objects.
- Produces a deeply frozen effective policy via `resolveDelegationPolicy({ registry, projectAlias })`.
- Produces `"read-only"` for scout/reviewer roles and `"writer"` for `sdd-implementer`; rejects every other role.

- [ ] **Step 1: Write failing policy-unit tests**

Create `test/workflow-delegation-policy.test.js` with the exact default and an allowed project tightening:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDelegationPolicy } from "../src/workflow/delegation-policy.js";

const registry = {
  launcher: {
    delegation: {
      version: 1,
      totalInternal: 4,
      foreground: 3,
      readOnlyBackground: 3,
      writersTotal: 1,
      writersPerCheckout: 1,
      maxDepth: 1,
      remediationTurns: 2,
    },
  },
  projects: { demo: { delegation: { totalInternal: 2, foreground: 2, readOnlyBackground: 1 } } },
};

test("resolves project policy by tightening launcher defaults", () => {
  assert.deepEqual(resolveDelegationPolicy({ registry, projectAlias: "demo" }), {
    version: 1,
    totalInternal: 2,
    foreground: 2,
    readOnlyBackground: 1,
    writersTotal: 1,
    writersPerCheckout: 1,
    maxDepth: 1,
    remediationTurns: 2,
    allowBackgroundWriters: false,
  });
});
```

Add negative cases for version other than `1`, zero/non-integer limits, `foreground > totalInternal`, `readOnlyBackground > totalInternal`, `writersTotal > totalInternal`, `writersPerCheckout > writersTotal`, `maxDepth !== 1`, `remediationTurns > 2`, and `allowBackgroundWriters: true` in this rollout.

- [ ] **Step 2: Extend registry-schema tests before implementation**

In `test/workflow-registry.test.js`, add fixtures asserting that a registry without `launcher.delegation` receives the exact defaults, a project may only tighten each concurrency limit, and a project attempting `writersTotal: 2` against launcher `writersTotal: 1` is rejected. Assert no unknown delegation keys survive validation.

- [ ] **Step 3: Verify RED**

Run:

```bash
node --test test/workflow-delegation-policy.test.js test/workflow-registry.test.js
```

Expected: FAIL because `delegation-policy.js` and registry delegation validation do not exist.

- [ ] **Step 4: Implement canonical policy validation**

Create `src/workflow/delegation-policy.js` with immutable defaults and strict normalization:

```js
export const DEFAULT_DELEGATION_POLICY = Object.freeze({
  version: 1,
  totalInternal: 4,
  foreground: 3,
  readOnlyBackground: 3,
  writersTotal: 1,
  writersPerCheckout: 1,
  maxDepth: 1,
  remediationTurns: 2,
  allowBackgroundWriters: false,
});

function positiveInteger(value, context) {
  if (!Number.isInteger(value) || value < 1) throw new WorkflowError("schema", `${context} must be a positive integer`);
  return value;
}
```

Accept only the documented keys. Require `version === 1`, `maxDepth === 1`, `remediationTurns` in `[0, 2]`, and `allowBackgroundWriters === false`. Merge a project override over launcher defaults only after checking every overridden numeric limit is less than or equal to the launcher value. Return a cloned, recursively frozen effective policy.

Update `registry.js` to validate optional `launcher.delegation` and optional `project.delegation`, install defaults when absent, and retain the normalized values in the frozen registry. Do not change registry version.

- [ ] **Step 5: Add explicit launcher defaults**

Add this block under `launcher:` in `projects.yaml`:

```yaml
  delegation:
    version: 1
    totalInternal: 4
    foreground: 3
    readOnlyBackground: 3
    writersTotal: 1
    writersPerCheckout: 1
    maxDepth: 1
    remediationTurns: 2
    allowBackgroundWriters: false
```

Do not add per-project overrides yet. Existing projects inherit this reviewed global policy.

- [ ] **Step 6: Verify focused and full tests**

Run:

```bash
node --test test/workflow-delegation-policy.test.js test/workflow-registry.test.js
npm test
git diff --check
```

Expected: all tests pass; registry v2 migration remains compatible and v3 policy resolution is deterministic.

- [ ] **Step 7: Review and commit Task 1**

Review that no policy setting can relax writer-per-checkout, depth, remediation cap, or background-writer gate. Then run:

```bash
git add src/workflow/delegation-policy.js src/workflow/registry.js projects.yaml test/workflow-delegation-policy.test.js test/workflow-registry.test.js
git commit -m "feat(workflow): validate delegation policy budgets"
```

### Task 2: Persist frozen delegation state inside the private parent run

**Files:**
- Create: `src/workflow/delegation-store.js`
- Create: `test/workflow-delegation-store.test.js`
- Modify: `src/workflow/run-store.js`
- Modify: `test/workflow-run-store.test.js`

**Interfaces:**
- `runStore.writePrivateFile(runId, { relativePath, text, updater })` writes one private child file and the corresponding run patch while holding the existing run lock.
- `createDelegationStore` creates/claims/updates only delegation records nested under `run.delegations`.
- Delegation IDs are UUIDs; artifact paths are exactly `delegations/<id>/brief.md` and `delegations/<id>/result.json`.

- [ ] **Step 1: Write failing run-store artifact tests**

Add tests in `test/workflow-run-store.test.js` for a `writePrivateFile` call that writes `delegations/<uuid>/brief.md`. Assert the artifact and its intermediate directory have modes `0600` and `0700`, the callback sees the current run, and `run.json` gains only the returned structured patch.

Add failure tests for `/absolute`, `../escape`, empty paths, NUL paths, non-string text, and an updater returning a non-object. Assert no file is created outside the run directory and error messages never include supplied secret text.

- [ ] **Step 2: Write failing delegation lifecycle tests**

Create `test/workflow-delegation-store.test.js` with a temporary real run store. Cover:

```js
const prepared = await delegations.prepare({
  runId,
  input: {
    role: "code-reviewer",
    mode: "background",
    originSessionId: "pi-origin-1",
    cwd: "/fixture/review",
    brief: "Review only the frozen task.",
    task: "Review only the frozen task.",
    budget: { maxRuntimeMs: 60_000, concurrency: 1 },
  },
});
assert.equal(prepared.state, "prepared");
assert.equal(prepared.generation, 1);
```

Assert `run.json` does not contain the brief/task text, `brief.md` is private, a claim is one-time, exact session metadata is bounded, result summaries are bounded, `beginRemediation` increments generation only when the expected current generation matches, and stale/duplicate result writes fail closed. Assert `briefDigest` and `taskDigest` are recomputed SHA-256 values rather than caller-provided metadata.

- [ ] **Step 3: Verify RED**

Run:

```bash
node --test test/workflow-run-store.test.js test/workflow-delegation-store.test.js
```

Expected: FAIL because the private-file primitive and delegation store do not exist.

- [ ] **Step 4: Implement the atomic private-file primitive**

In `src/workflow/run-store.js`, add a `validatePrivateRelativePath` helper that rejects NUL, absolute, empty, and escaping paths. Add `ensurePrivateParentDirectories(directory, relativePath)` that creates only parents under the canonical run directory at `0700`.

Refactor the existing internal `writeAtomicText(directory, filename, text)` so it resolves and validates the destination under `directory`, then creates its temporary file beside that destination. Use this exact path construction and retain fsync-before-rename behavior:

```js
const destination = join(directory, filename);
const tempPath = join(dirname(destination), `.${basename(destination)}.${process.pid}.${tempCounter}.tmp`);
```

This preserves atomic replacement for both `run.json` and nested delegation artifacts.

Implement the public method as:

```js
async function writePrivateFile(runId, { relativePath, text, updater }) {
  if (typeof text !== "string" || typeof updater !== "function") {
    failStore("writePrivateFile requires string text and an updater function");
  }
  const id = ensureRunId(runId);
  const directory = runDirectoryFor(id);
  const filename = validatePrivateRelativePath(directory, relativePath);
  await tightenExistingStateRootDirectory();
  await tightenExistingRunDirectory(directory);
  return await withLock(directory, async () => {
    const current = await readRunInternal(id, directory);
    await ensurePrivateParentDirectories(directory, filename);
    await writeAtomicText(directory, filename, text);
    const patch = await updater(cloneJson(attachDirectory(current, directory)));
    const next = updatedRun(current, patch);
    const run = await writeRun(directory, next);
    return { run, path: join(directory, filename), writtenAt: run.updatedAt };
  });
}
```

On artifact-write failure, do not call the updater or alter `run.json`. If writing `run.json` fails after the artifact is installed, leave the private orphan artifact for inspection and throw; never delete it. Export the method from `createRunStore`.

- [ ] **Step 5: Implement bounded delegation records**

Create `src/workflow/delegation-store.js` with these fixed states:

```js
const DELEGATION_STATES = new Set([
  "prepared", "running", "completed", "blocked", "failed",
  "interrupted", "timed-out", "stale", "manual",
]);
```

`prepare` must validate the managed role, mode, absolute cwd, origin session ID length, one-line bounded budget, and brief/task text no larger than 64 KiB each. It creates a UUID, computes both SHA-256 digests from the exact supplied brief/task text, writes `brief.md`, and stores this metadata only:

```js
{
  id, role, mode, originSessionId, cwd, briefDigest, taskDigest,
  budget, generation: 1, state: "prepared", createdAt, updatedAt,
  briefPath, nativeSession: null, result: null, remediationTurnsUsed: 0,
}
```

`claim` atomically consumes one `prepared` delegation ID and moves it to `running`; the later coordinator extension holds the matching request fingerprint only in its in-memory prepared-request record, so a restart fails closed. `recordSession` accepts only `{ kind, id, path? }` with bounded strings. `recordResult` validates `{ status, generation, summary, verification, concerns, nextAction }`, writes `result.json`, and rejects an old generation. `beginRemediation` requires the expected generation, increments it, clears only current result metadata, increments `remediationTurnsUsed`, and returns the new record. It does not send a prompt or start a process.

- [ ] **Step 6: Verify focused and full tests**

Run:

```bash
node --test test/workflow-run-store.test.js test/workflow-delegation-store.test.js
npm test
git diff --check
```

Expected: all tests pass and artifact/state modes are private.

- [ ] **Step 7: Review and commit Task 2**

Review that state contains no brief/prompt body and that no failed path deletes an artifact. Then run:

```bash
git add src/workflow/run-store.js src/workflow/delegation-store.js test/workflow-run-store.test.js test/workflow-delegation-store.test.js
git commit -m "feat(workflow): persist frozen delegation state"
```

### Task 3: Reserve concurrency and checkout writer ownership durably

**Files:**
- Create: `src/workflow/delegation-reservations.js`
- Create: `test/workflow-delegation-reservations.test.js`

**Interfaces:**
- `reserve` atomically grants or rejects all resource slots for one delegation.
- `release` changes only a verified active reservation into retained released audit state.
- Reservations are stored under `<stateRoot>/delegation-reservations/` with opaque SHA-256 directory names; raw cwd values never become a filename.

- [ ] **Step 1: Write failing reservation tests**

Create `test/workflow-delegation-reservations.test.js` with a temporary state root and deterministic UUID/clock. Test all cases:

```js
const reservation = await reservations.reserve({
  projectAlias: "fixture-single",
  delegationId: "11111111-1111-4111-8111-111111111111",
  role: "code-reviewer",
  mode: "background",
  checkoutPath: "/fixture/source",
  policy,
});
assert.deepEqual(reservation.resources, ["totalInternal", "readOnlyBackground"]);
```

- parallel foreground reviewers cannot exceed `foreground` or `totalInternal`;
- parallel background reviewers cannot exceed `readOnlyBackground` or `totalInternal`;
- a writer consumes `totalInternal`, `foreground`, `writersTotal`, and its checkout resource;
- a second writer for the same canonical checkout is rejected even if other global capacity remains;
- two concurrent reserve calls for one writer slot produce exactly one success;
- `release` requires the exact reservation ID/owner token, preserves a `releasedAt` record, and permits a later valid reservation;
- an existing active gate/lease is never removed automatically, including one old enough to look stale;
- reservation files/directories are private and no raw checkout path appears in filenames or error text.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/workflow-delegation-reservations.test.js
```

Expected: FAIL because the reservation store does not exist.

- [ ] **Step 3: Implement private project gates and immutable lease history**

Create `src/workflow/delegation-reservations.js`. Derive opaque identifiers with:

```js
function digestKey(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
```

For a project, use a private directory `delegation-reservations/projects/<projectDigest>/`. Acquire its short critical-section gate with `mkdir("active")`; an already active gate is a bounded conflict and is never removed by this process. Once acquired, read retained reservation JSON records, count only records whose `state === "active"`, validate every policy resource, atomically write one `leases/<reservationId>.json` file, then remove only the gate created and ownership-verified by the current call.

A reservation record contains no prompt/transcript and has this shape:

```js
{
  version: 1,
  id: reservationId,
  ownerToken,
  projectDigest,
  delegationId,
  role,
  mode,
  checkoutDigest,
  resources: ["totalInternal", "foreground"],
  state: "active",
  acquiredAt,
}
```

`release` verifies both owner token and active state under the same project gate, then atomically replaces only that record with `{ ...record, state: "released", releasedAt }`. It does not unlink the lease or its parent directories.

- [ ] **Step 4: Verify race and full suite**

Run:

```bash
node --test test/workflow-delegation-reservations.test.js
npm test
git diff --check
```

Expected: the parallel writer test reports exactly one granted reservation and all repository tests pass.

- [ ] **Step 5: Review and commit Task 3**

Review that the release operation preserves audit history and every active-gate conflict requires manual inspection. Then run:

```bash
git add src/workflow/delegation-reservations.js test/workflow-delegation-reservations.test.js
git commit -m "feat(workflow): reserve delegation budgets and writers"
```

### Task 4: Define the narrow worker transport contract with deterministic fakes

**Files:**
- Create: `src/workflow/worker-transport.js`
- Create: `test/workflow-worker-transport.test.js`

**Interfaces:**
- A valid transport exposes exactly `start`, `observeExact`, `deliverFollowUp`, and `requestGracefulClose` functions.
- The fake transport records calls and serves scripted structured observations without starting a process.

- [ ] **Step 1: Write failing transport tests**

Create `test/workflow-worker-transport.test.js` with the contract assertions:

```js
const transport = createFakeWorkerTransport({
  observations: [{ state: "idle", identity: { kind: "herdr", paneId: "pane-1", processId: "pid-1" } }],
});
assert.deepEqual(await transport.observeExact({ kind: "herdr", paneId: "pane-1", processId: "pid-1" }), {
  state: "idle",
  identity: { kind: "herdr", paneId: "pane-1", processId: "pid-1" },
});
```

Assert `assertWorkerTransport` rejects missing/non-function methods, `deliverFollowUp` rejects a missing identity or a prompt larger than 64 KiB/NUL, fake calls preserve the supplied identity exactly, observations cannot include terminal text, and `requestGracefulClose` only records a request rather than deleting or killing anything.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/workflow-worker-transport.test.js
```

Expected: FAIL because the transport module does not exist.

- [ ] **Step 3: Implement contract validation and fake behavior**

Create `src/workflow/worker-transport.js`:

```js
const METHODS = ["start", "observeExact", "deliverFollowUp", "requestGracefulClose"];

export function assertWorkerTransport(transport) {
  for (const name of METHODS) {
    if (typeof transport?.[name] !== "function") throw new TypeError(`Worker transport requires ${name}()`);
  }
  return transport;
}
```

Normalize observations to `{ state: "active" | "idle" | "missing" | "mismatch", identity, details? }`; reject any other state and reject `details` keys named `terminal`, `paneText`, `transcript`, `stdout`, or `stderr`. The fake returns queued observations, retains an immutable call log, and performs no filesystem/process mutation. Its `start` result must include only a caller-supplied exact identity.

- [ ] **Step 4: Verify focused and full tests**

Run:

```bash
node --test test/workflow-worker-transport.test.js
npm test
git diff --check
```

Expected: all tests pass without a Herdr or model invocation.

- [ ] **Step 5: Review and commit Task 4**

Review that the contract cannot accidentally make terminal content a result field. Then run:

```bash
git add src/workflow/worker-transport.js test/workflow-worker-transport.test.js
git commit -m "feat(workflow): define exact worker transport contract"
```

### Task 5: Reject unprepared or unsafe Pi-subagent requests in pure policy code

**Files:**
- Create: `src/workflow/coordinator-policy.js`
- Create: `test/workflow-coordinator-policy.test.js`

**Interfaces:**
- `createPreparedDelegationRequest` derives one immutable, initially unconsumed fingerprint from a claimed delegation record and effective policy.
- `validateSubagentRequestPolicy` returns `{ allowed: true, fingerprint }` or `{ allowed: false, reason }`; it does not mutate, launch, reserve, consume, or rewrite a request. The later Pi extension atomically consumes the in-memory prepared request only after this validation and store claim succeed.

- [ ] **Step 1: Write failing prepared-request policy tests**

Create `test/workflow-coordinator-policy.test.js`. Use a frozen code-reviewer delegation and policy defaults. Assert a matching request is allowed:

```js
const prepared = createPreparedDelegationRequest({ delegation, policy });
const accepted = validateSubagentRequestPolicy({
  request: {
    agent: "code-reviewer",
    task: "Review the frozen brief.",
    async: true,
    worktree: false,
    cwd: "/fixture/review",
    concurrency: 1,
  },
  prepared,
  policy,
  reservation: { state: "active", delegationId: delegation.id },
});
assert.equal(accepted.allowed, true);
```

Add tests that reject: no prepared request; changed task digest/fingerprint; stale claimed state; reused/consumed prepared request; unknown agent; nested `tools: ["subagent"]`; `worktree: true`; a cwd different from the frozen brief; concurrency `0` or above policy; background implementer while `allowBackgroundWriters` is false; package actions `status` with fleet/transcript, `wait`, `resume`, `interrupt`, `schedule`, `config`, or agent management; and a writer without an active matching writer reservation.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/workflow-coordinator-policy.test.js
```

Expected: FAIL because coordinator policy functions do not exist.

- [ ] **Step 3: Implement canonical fingerprinting and fail-closed validation**

Create `src/workflow/coordinator-policy.js`. `createPreparedDelegationRequest` must copy the claimed delegation's persisted `taskDigest`, derive the allowed mode/concurrency from its policy-approved budget, set `consumed: false`, and hash normalized `{ delegationId, role, mode, cwd, concurrency, async, worktree, taskDigest }`. `validateSubagentRequestPolicy` derives `taskDigest` from incoming task text before comparison and never includes that text in a returned reason. It rejects `prepared.consumed === true`; it never flips that flag itself. Normalize no user-provided request into a safer form. Compare an incoming request only after rejecting unknown keys/actions that could enable async administration or child fanout.

Implement role rules exactly:

```js
const READ_ONLY_ROLES = new Set(["scout", "spec-reviewer", "code-reviewer"]);
const WRITER_ROLE = "sdd-implementer";
```

A read-only background request needs `delegation.mode === "background"`, `async === true`, `worktree === false`, and an active matching reservation. A foreground request needs `async === false`. The implementer needs `async === false` while `allowBackgroundWriters` is false and always needs an active matching writer reservation. Return a bounded reason; never echo task text.

- [ ] **Step 4: Verify focused and full tests**

Run:

```bash
node --test test/workflow-coordinator-policy.test.js
npm test
git diff --check
```

Expected: all valid/invalid policy cases are deterministic with no package installation.

- [ ] **Step 5: Review and commit Task 5**

Review that a direct request cannot become allowed merely because it resembles a role. Then run:

```bash
git add src/workflow/coordinator-policy.js test/workflow-coordinator-policy.test.js
git commit -m "feat(workflow): validate prepared subagent requests"
```

### Task 6: Amend downstream plans and verify the foundation handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md`
- Modify: `docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md`
- Modify: `README.md`
- Create: `.superpowers/sdd/two-lane-foundation-handoff.md`

**Interfaces:**
- The supervised lifecycle plan consumes the five foundation modules before package installation.
- The fixture plan recognizes read-only background and writer-background as separate gates.
- README describes the policy as not yet operational until the later coordinator/package stage.

- [ ] **Step 1: Write failing documentation assertions**

Modify `test/workflow-docs.test.js` so it asserts README names all policy invariants without claiming the package is installed:

```js
assert.match(readme, /one writer per checkout/i);
assert.match(readme, /background reviewers/i);
assert.match(readme, /workflow-owned worktree/i);
assert.match(readme, /not.*install.*pi-subagents/i);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/workflow-docs.test.js
```

Expected: FAIL because the documented two-lane foundation boundary is absent.

- [ ] **Step 3: Amend the downstream implementation plans**

At the beginning of `2026-07-19-supervised-lifecycle-pi-coordinator.md`, add an amendment note naming this foundation plan as a prerequisite. Replace its fixed `foreground-only`/`concurrency above 3` restriction with the effective-policy rules from this plan, preserving the permanent prohibition on internal package worktrees and package internals. Insert a prerequisite task before lifecycle hooks that wires `delegation-store`, `delegation-reservations`, `worker-transport`, and `coordinator-policy` into later lifecycle/coordinator work.

In `2026-07-19-workflow-fixture-canaries.md`, add fixture gates in this order: deterministic policy fake; read-only foreground/background delegation; one workflow-owned worktree writer; then separately approved real harness canaries. Preserve all resource ownership/cleanup constraints.

- [ ] **Step 4: Document the intentional non-operational boundary**

Update README with a short two-lane policy table. State exactly that this foundation does not install `pi-subagents`, register hooks, launch agents, or enable background writers; those require the subsequent reviewed lifecycle/coordinator and fixture gates.

- [ ] **Step 5: Verify documentation and full suite**

Run:

```bash
node --test test/workflow-docs.test.js
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: all tests pass; package contents contain no `.pi/npm`, session data, reservations, or generated artifacts.

- [ ] **Step 6: Review and commit Task 6**

Review that the amended plans preserve explicit manual Codex trust, no terminal scraping, no automatic cleanup, and no real project canary. Then run:

```bash
git add README.md test/workflow-docs.test.js docs/superpowers/plans/2026-07-19-supervised-lifecycle-pi-coordinator.md docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md .superpowers/sdd/two-lane-foundation-handoff.md
git commit -m "docs(workflow): sequence two-lane delegation rollout"
```

## Foundation completion gate

Before starting the revised lifecycle/coordinator implementation:

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
git status --short
```

Then inspect the private-state tests specifically for mode, path traversal, active-reservation preservation, and prompt/transcript non-persistence. Record the exact test count and commit IDs in `.superpowers/sdd/two-lane-foundation-handoff.md`.

Do not install `pi-subagents`, write hook profiles, trust Codex hooks, launch Pi/Claude/Codex, start Herdr, or create a fixture during this plan. The next plan consumes this foundation to implement lifecycle hooks, the concrete Herdr transport, the coordinator extension, managed roles, and package installation.
