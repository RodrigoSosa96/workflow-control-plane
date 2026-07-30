# Hook-Owned Lock Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make run locks acquired by lifecycle hooks and Pi worker extensions carry ownership evidence, so `workflow unlock` can recover them instead of refusing them as `unprovable` forever.

**Architecture:** One new export in `src/workflow/ownership.js` packages the memoized own-identity reader for a process that has no injected runner, using the same `ps` invocation `inspectExactProcessByPid` reads back. Five production sites plus one script pass it to their store construction. Nothing else changes: the stores already accept `readOwnOwnership`, and no classification rule moves.

**Design source:** [`../specs/2026-07-30-hook-owned-lock-ownership-design.md`](../specs/2026-07-30-hook-owned-lock-ownership-design.md) (Approved). Read its "Why the process's own identity, and not the worker's" section before starting — the obvious-looking alternative is actively wrong.

**Tech Stack:** Node.js ESM, zero runtime dependencies, Node test runner, existing `ownership.js` / `process-observation.js` / hook / Pi-extension seams.

## Global Constraints

- **Own identity, never the worker's.** The process that holds the lock is the hook. Recording the worker's identity would make residue from a dead hook classify `owner-alive`, so `unlock` would refuse it — a false negative that blocks recovery permanently, worse than today's honest `unprovable`.
- **One code path writes and reads `startedAt`.** The classifier compares it for exact string equality, so the value a hook writes must be produced by the same `ps` invocation `inspectExactProcessByPid` uses to read it back. No site may hand-roll its own `ps` argv, and no derivation from `/proc/self/stat` (see the spec's rejected alternative).
- **Read before the mutex, never while holding it.** Item 1.1's task-2 review moved this read out of the critical section to protect the lock-contention retry budget; keep it out.
- **Never throw into a hook.** Any failure resolves `null`, the marker omits `pid`/`startedAt` (never empty strings), and acquisition proceeds — today's behavior for these sites.
- **Memoize including failure**, so a broken environment costs one attempt per process rather than one per lock.
- Zero new dependencies; existing injection seams stay injectable; hooks keep swallowing their own errors.
- Every task ends with its covering tests passing and `npm test` green.

## File Structure

- Modify: `src/workflow/ownership.js` — add `createSubprocessOwnOwnershipReader`.
- Modify: `test/workflow-ownership.test.js` — unit coverage for it.
- Create: `test/workflow-hook-ownership.test.js` — the cross-path equality test and the hook-acquired-marker test.
- Modify: `hooks/claude-lifecycle.mjs`, `hooks/codex-lifecycle.mjs`, `hooks/claude-statusline.mjs`, `.pi/extensions/workflow-worker-lifecycle.ts`, `.pi/extensions/workflow-worker-observability.ts`, `scripts/workflow-fixture.js`-adjacent `scripts/smoke-workflow-fixture.js`.
- Modify: the tests covering those sites (`test/workflow-claude-lifecycle-hook.test.js`, `test/workflow-codex-lifecycle-hook.test.js`, `test/workflow-claude-statusline-hook.test.js`, `test/workflow-pi-lifecycle-extension.test.js`, `test/workflow-pi-observability.test.js`).
- Modify: `ROADMAP.md` — mark 1.1b done.

---

### Task 1: `createSubprocessOwnOwnershipReader`

**Files:**
- Modify: `src/workflow/ownership.js`
- Test: `test/workflow-ownership.test.js`

**Interfaces:**

```js
// Memoized own-ownership reader for a process with no injected runner (hooks,
// Pi extensions, scripts). Defaults do the real work so callers write
// createSubprocessOwnOwnershipReader() with no arguments; both seams are
// injectable for tests.
export function createSubprocessOwnOwnershipReader({ spawnProcess, readCwd } = {})
```

Returns the same shape `createOwnOwnershipReader` returns: a memoized `async () => {pid, startedAt} | null` that never throws.

`spawnProcess` defaults to an implementation that runs `ps -p <pid> -o lstart= -o state=` through `node:child_process` and resolves `{code, stdout, stderr}` — the exact shape `inspectExactProcessByPid`'s `runProcess` contract expects, and the exact argv `bin/workflow.js` already uses at its `inspectDelegationPid` wiring. `readCwd` defaults to `node:fs/promises`'s `realpath`.

Build it by composing the existing pieces: `createOwnOwnershipReader({ inspectProcess })` where `inspectProcess = (pid) => inspectExactProcessByPid(pid, { runProcess, readCwd })`. Do **not** reimplement the inspection or the memoization.

**Steps:**
- [ ] Write tests: returns `{pid, startedAt}` for a healthy injected spawn; invokes the spawn exactly once across many calls; resolves `null` (never rejects) for a spawn that throws, a non-zero exit, empty stdout, unparseable stdout, and a rejecting `readCwd`; memoizes the `null` outcome too.
- [ ] Implement in `src/workflow/ownership.js`.
- [ ] Run `node --test test/workflow-ownership.test.js`, then `npm test`.
- [ ] Commit.

---

### Task 2: Prove the written and observed `startedAt` are identical

**Files:**
- Create: `test/workflow-hook-ownership.test.js`

**Why this is its own task:** the entire design rests on the value a hook writes being byte-identical to the value `unlock` reads back. Everything else in this plan is wiring; this is the property that makes the wiring worth anything. It gets its own test file so it cannot be diluted into a wiring assertion.

**Interfaces:** no production code changes. Uses the real `ps` (no injected seams) against the test process's own pid.

**Steps:**
- [ ] Test: `createSubprocessOwnOwnershipReader()` with **no arguments** (real `ps`) and `inspectExactProcessByPid(String(process.pid), …)` with the same real invocation produce **equal** `startedAt` strings for this process. Assert equality, not format — a format-only assertion would pass while the design was broken.
- [ ] Test: the reader's `pid` is `String(process.pid)`.
- [ ] Guard the file so it degrades rather than failing where `ps` is unavailable: if the reader resolves `null`, skip with a clear reason (`t.skip`) instead of asserting. Do not silently pass.
- [ ] Run the file, then `npm test`.
- [ ] Commit.

---

### Task 3: Thread the reader into the three subprocess hooks

**Files:**
- Modify: `hooks/claude-lifecycle.mjs`, `hooks/codex-lifecycle.mjs`, `hooks/claude-statusline.mjs`
- Test: `test/workflow-claude-lifecycle-hook.test.js`, `test/workflow-codex-lifecycle-hook.test.js`, `test/workflow-claude-statusline-hook.test.js`

**Interfaces:** each site currently reads `createRunStore({ stateRoot: env.WORKFLOW_STATE_ROOT })`. It becomes `createRunStore({ stateRoot: env.WORKFLOW_STATE_ROOT, readOwnOwnership })` where `readOwnOwnership` comes from **one** `createSubprocessOwnOwnershipReader()` per process — construct it at module scope or once per entrypoint invocation, never per store call.

Keep each hook's existing error swallowing exactly as it is.

**Steps:**
- [ ] Per site, add a test asserting the store is constructed with a `readOwnOwnership` function, and verify it fails when the argument is removed. Use each file's existing injection seam if it has one; if a file has no seam for store construction, add the minimal one its siblings already use rather than inventing a new pattern.
- [ ] Add one test proving a lock acquired through the shared lifecycle-hook core produces a marker with `pid`/`startedAt` at mode `0600`, and that `classifyOwnership` returns a non-`unprovable` verdict for it.
- [ ] Add one test proving a reader whose spawn fails still permits acquisition, with the marker's `pid`/`startedAt` keys **absent** (use `"pid" in marker === false`, not `=== undefined`).
- [ ] Implement.
- [ ] Run the three test files, then `npm test`.
- [ ] Commit.

---

### Task 4: Thread the reader into the two Pi worker extensions and the fixture script

**Files:**
- Modify: `.pi/extensions/workflow-worker-lifecycle.ts`, `.pi/extensions/workflow-worker-observability.ts`, `scripts/smoke-workflow-fixture.js`
- Test: `test/workflow-pi-lifecycle-extension.test.js`, `test/workflow-pi-observability.test.js`

**Interfaces:** same change as Task 3. These two extensions run **in-process for the whole Pi session**, so the memoization means one `ps` per session rather than per event — note that in a comment where the reader is constructed, because it is the reason the cost is acceptable here.

`.pi/extensions/workflow-worker-lifecycle.ts:17` already accepts an injected store (`injectedStore ?? createRunStore(...)`); preserve that seam and only extend the fallback construction.

`scripts/smoke-workflow-fixture.js` is test tooling; wire it the same way for consistency, but it needs no new test of its own beyond the suite staying green.

**Steps:**
- [ ] Per extension, add a test asserting the fallback store construction receives a `readOwnOwnership` function, and that an injected store still bypasses it entirely.
- [ ] Implement, including the one-`ps`-per-session comment.
- [ ] Run the two test files, then `npm test`.
- [ ] Commit.

---

### Task 5: Prove the read stays outside the critical section, and close out the roadmap

**Files:**
- Test: `test/workflow-hook-ownership.test.js` (extend)
- Modify: `ROADMAP.md`

**Interfaces:** no production change expected — this task verifies an ordering property the stores already guarantee, and records completion. If the test reveals the ordering is wrong at any of the newly wired sites, that is a real finding: fix it and say so.

**Steps:**
- [ ] Test: with a store whose `readOwnOwnership` records whether the active-lock directory exists at the moment it is invoked, assert the directory does **not** yet exist — i.e. the read precedes acquisition. Item 1.1's task-2 review moved this read out of the critical section deliberately; this pins it.
- [ ] Update `ROADMAP.md`: mark **1.1b** `- [x]` with its commit range, add a progress-table row, and repoint "próximo paso" at **1.4** (whose corrected framing is already recorded there).
- [ ] Run the file, then `npm test`.
- [ ] Commit.

---

## Verification

The spec's nine Verification Strategy items map to these tasks: 1-2 → Task 1; 3 → Task 2; 4 → Tasks 3 and 4; 5-6 → Task 3; 7 → Task 5; 8 → Tasks 3 and 4 (existing hook tests untouched); 9 → every task.
