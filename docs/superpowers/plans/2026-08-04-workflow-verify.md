# `workflow verify` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "verification passed" checkable instead of believable — re-run the project's verify commands in the exact recorded worktree and write structured evidence the operator can read next to the worker's claim.

**Architecture:** A bounded shell runner (the one documented departure from this repo's `shell: false` posture), a `verifyCommand` that runs each `project.verify` entry once per repository and appends structured evidence to the run's event log, and a `result` view that shows the claim and the proof separately.

**Design source:** [`../specs/2026-08-04-workflow-verify-design.md`](../specs/2026-08-04-workflow-verify-design.md). Read its shell section before Task 1 — the departure is deliberate and its reasoning is what keeps it from spreading.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **The shell is confined to one module.** Nothing else in this repo gains a `shell: true`. `src/workflow/process.js` keeps `shell: false` untouched.
- **Bound everything before it reaches the event log.** The log is append-only and shared with the watchers; an unbounded test log landing in it is a durable problem, not a display one.
- **Never report an unverified run as passing.** A missing repository path, a timeout, a project with no verify commands — each has its own recorded reason. Silence is the failure mode this item exists to remove.
- **Do not merge the claim and the proof.** `workflow result` shows the worker's self-reported `verification` and the recorded evidence separately, labelled. A disagreement between them is the most interesting output this command can produce.
- **No confirmation gate**, matching `status`/`result`/`reconcile`.
- Zero new dependencies. Baseline: **1035 tests, 1035 pass, 0 skips**, under both `npm test` and `npm run test:ci-like`.

## Reference: verified facts

- `project.verify` is an array of shell **strings**, validated at `registry.js:281-285` and `:322-326`. Real values: `pnpm typecheck`, `pnpm biome:check`, `pnpm ci:verify`.
- The verify commands are **not** on the run record — checked against a real `run.json`, no `verify`-shaped field exists. The registry is the only source.
- A worker's self-report is `verification: [{command, status, summary}]` (`handoff.js:272-285`), capped at 100 entries (`:31`).
- `src/workflow/format.js` contains **no** reference to `verification` — the compact `result` view never rendered it.
- `appendEvent(runId, event)` (`run-store.js:923`) is the event-log API; it stamps `version`, `id`, `runId` and `timestamp` itself and strips those from the caller's input.
- `run.repositories[]` entries are `{id, path, branch}`. A real Acme run carries three.
- Every spawn in this repo passes `shell: false` (`process.js:32`, `harness-supervisor.js:94`, `ownership.js:101`).

## File Structure

- Create: `src/workflow/verify-runner.js` — the bounded shell runner.
- Modify: `src/workflow/commands.js` — `verifyCommand`, and the `result` command surfacing evidence.
- Modify: `src/workflow/format.js` — render verify results, and the claim/proof split in `result`.
- Modify: `bin/workflow.js`, `README.md` — the CLI surface.
- Modify: the corresponding test files.
- Modify: `ROADMAP.md`.

---

### Task 1: The bounded shell runner

**Files:**
- Create: `src/workflow/verify-runner.js`
- Test: a new test file for it

**Interfaces:**

```js
// The ONE place in this repo that runs a shell, and the reasoning is in the spec: these are the
// operator's own strings from their own registry, they come from no worker, and they enter no
// approval digest. Everything else keeps shell: false.
// Never throws: a failure, a timeout and a missing cwd are all results, because the caller is
// producing evidence and "the check could not run" is evidence too.
export async function runVerifyCommand(command, { cwd, timeoutMs, maxOutputBytes, spawnProcess, now })
// → { command, cwd, status: "passed"|"failed"|"timed-out"|"error", exitCode, output, durationMs, reason? }
```

Bound the captured output as it arrives, not after — a test suite can emit megabytes and buffering it all to truncate later is the same bug with extra memory.

**Steps:**

- [ ] **Step 1: Write the failing tests** with an injected spawn so nothing runs real commands: a zero exit is `passed`; a non-zero exit is `failed` with its code; a timeout is `timed-out`; a spawn error or missing cwd is `error` with a reason; output beyond the cap is truncated **and marked as truncated**; and the function never throws for any of them.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: One real-shell test** — assert `sh -c "echo a && echo b"` produces both lines. This is the property the shell decision exists for and the reason whitespace-splitting was rejected; guard it so a host without `/bin/sh` skips with a named reason rather than failing.
- [ ] **Step 5: Confirm the departure is confined** — `grep -rn "shell: true\|shell:true" src bin hooks .pi scripts` and confirm the only shell use is this module's explicit `/bin/sh` invocation. Paste the output into the commit message.
- [ ] **Step 6: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: a bounded shell runner for the project's own verify commands"
```

---

### Task 2: `verifyCommand`

**Files:**
- Modify: `src/workflow/commands.js`
- Test: `test/workflow-commands.test.js`

**Interfaces:**

```js
export async function verifyCommand(options = {}, deps = {})
// → { command: "verify", runId, results: [...], passed: boolean, exitCode }
```

Each result carries the repository id, the cwd, the command, the status, the exit code, the bounded output and the duration. The matrix is **every `project.verify` command × every `run.repositories[]` entry**.

Refusals, each with its own reason and appending nothing: no `repositories[]`; project absent from the registry; project has no `verify` commands.

Then append the evidence through `appendEvent`. Note it stamps `version`/`id`/`runId`/`timestamp` itself — do not pass those.

**Steps:**

- [ ] **Step 1: Write the failing tests.** The load-bearing one first: a **multi-repository** run runs each command once per repository, with the right cwd each time, and a failure in the second repository is attributed to it. Then: pass and fail statuses; a missing repository path is an error for that repository while the others still run; a timeout does not abort the rest; each refusal reason; the evidence lands in the event log; `passed` and `exitCode` reflect the results.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Prove the per-repository matrix is load-bearing** — change the code to run only in the first repository, confirm the multi-repository test fails, restore. Record the output. A single-repo test cannot catch this and the spec calls it the false green the item exists to remove.
- [ ] **Step 5: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 6: Commit.**

```bash
git commit -m "feat: workflow verify re-runs the project's checks in the recorded worktree"
```

---

### Task 3: The claim beside the proof, and the CLI

**Files:**
- Modify: `src/workflow/format.js`, `src/workflow/commands.js` (the `result` command), `bin/workflow.js`, `README.md`
- Test: `test/workflow-format.test.js`, `test/workflow-cli.test.js`

**Interfaces:** `workflow verify <run-id> [--format compact|json]`, plus `workflow result` gaining two clearly separated sections.

`result` currently renders no `verification` at all. It gains:
- **Reported by the worker** — the handoff's `verification[]`.
- **Verified by `workflow verify`** — the recorded evidence, with when it ran.

Label them so nobody can mistake one for the other, and make a disagreement legible: a command the worker called `passed` that the evidence shows failing is the single most valuable thing this feature can show. Do not compute a verdict about the disagreement — show both and let the operator read it.

Follow the shape items 2.1 and 2.2 established: `renderTable` where a table fits, an explicit line when a section is empty, and the same JSON size discipline (2.1 shipped a projection after full records silently blew a shared 12,000-character limit; check yours rather than assuming).

**Steps:**

- [ ] **Step 1: Write the failing tests** — `verify` renders per-repository results; a failure is visually distinguishable from a pass; `result` shows both sections labelled; a run with a claim but no evidence says the evidence is missing rather than showing nothing; a disagreement is visible in both sections; the JSON stays well under the output limit for a realistic result count; `main(["verify", runId])` exits per pass/fail; a missing run id is a usage error.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement**, including the usage line, `validateShape` and the dispatch.
- [ ] **Step 4: Document in `README.md`** beside `runs` and `inbox`.
- [ ] **Step 5: Run it for real.** This repo is itself a registered-project-shaped thing with real verify commands; construct a run record in a temp state root whose `repositories[]` points at this checkout, and verify against `npm test`-shaped commands — or use a smaller real command. Paste the output into your report.

  Items 2.1 and 2.2 each had their most important finding at this step and not from a green suite. If the output misleads, **say so plainly rather than adjusting it quietly**.

- [ ] **Step 6: Run the focused files, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: wire workflow verify into the CLI and show the claim beside the proof"
```

---

### Task 4: Close out 2.3

**Files:**
- Modify: `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Mark 2.3 done** with its commit range and a progress-table row.
- [ ] **Step 2: Record the shell departure** — one module, `/bin/sh -c`, because these are the operator's own registry strings that enter no digest, and whitespace-splitting would silently mis-run the first command containing `&&` or a pipe. Say that everything else keeps `shell: false`.
- [ ] **Step 3: Record the contrast with 1.3** — verify reads the **current** registry commands, deliberately, where 1.3's security envelope had to reproduce what was approved. Evidence should reflect today's bar; a security envelope must reflect the approved one. Two items, opposite conclusions, both right.
- [ ] **Step 4: Record what this does not do** — it produces evidence and gates nothing. Item 2.4 (`workflow merge`) is where evidence could become a precondition.
- [ ] **Step 5: Repoint the next step** to 2.4.
- [ ] **Step 6: Run `npm test`**, then commit.

---

## Verification

The spec's eleven Verification Strategy items map to these tasks: 3-5 → Task 1; 1-2, 6-8, 10 → Task 2; 9 → Task 3; 11 → every task.

After Task 4, review the branch, merge, push, and confirm CI is green.
