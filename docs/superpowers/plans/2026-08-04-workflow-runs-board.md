# `workflow runs` Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One read-only command that answers what is running and what needs input, across every project, without knowing any run id.

**Architecture:** `runsCommand` over the existing `store.list()`, a state filter with a deliberate live-set default, sorting by `updatedAt` descending, a compact table plus full JSON, and skipped crash residue named rather than swallowed. `store.list()` itself is untouched.

**Design source:** [`../specs/2026-08-04-workflow-runs-board-design.md`](../specs/2026-08-04-workflow-runs-board-design.md). Read its "The compact view drops the worktree" section before Task 2 — the roadmap names a field that does not exist.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **Read-only.** No mutation, no `--yes`, no approval digest. Exit code is 0 with runs, without runs, and with skipped records — it is a report, not a check.
- **`store.list()` is unchanged.** Its `createdAt`-ascending sort is right for a store primitive; the board sorts its own output. Other callers may depend on that order.
- **Skipped records stay visible.** Item 0.3 made `list()` skip unreadable directories and report them through `onListProblem` precisely so they would not vanish. The board must name them, and one of them must not empty the board.
- **No worktree column.** There is no worktree field — verified against a real record, the paths live inside `repositories[]` as `{id, path, branch}`, one entry per repository. JSON carries `repositories`; the table does not pretend.
- Follow the CLI's existing conventions exactly: `--format compact|json` on every command, `validateShape` for argument checking, a `USAGE` line, and a per-command formatter in `format.js`.
- Zero new dependencies. Baseline: **959 tests, 959 pass, 0 skips**, under both `npm test` and `npm run test:ci-like`.

## Reference: what exists today

- `store.list(filters)` (`src/workflow/run-store.js:~955`) walks the state root, skips unreadable directories through `onListProblem`, filters by `projectAlias` / `originSessionId` / `unconsumed`, and sorts by `createdAt` then id.
- `bin/workflow.js` holds the `USAGE` text (`:51-70`), `validateShape` per command, and the dispatch. Every command accepts `--format compact|json`.
- `formatWorkflowResult(command, value, format)` (`src/workflow/format.js:364`) dispatches to a per-command formatter, with `boundedJson` for `--format json`.
- `RUN_STATES` (`src/workflow/run-state.js:3-15`) has eleven states. **None is terminal in the state machine** — `completed`, `failed` and `interrupted` can all transition back to `running` via resume — so the board's "live set" is a presentation decision, not a state-machine fact, and must be defined explicitly.
- `storeForCommand` / `stateRootForCommand` (`src/workflow/commands.js`) are how a read-only command gets its store; `reportListProblem` in `bin/workflow.js:428` is the CLI's existing `onListProblem`.

## File Structure

- Modify: `src/workflow/run-state.js` — the live set, next to `RUN_STATES`.
- Modify: `src/workflow/commands.js` — `runsCommand`.
- Modify: `src/workflow/format.js` — `formatRuns`.
- Modify: `bin/workflow.js` — usage line, `validateShape`, dispatch, and capturing skips.
- Modify: `test/workflow-commands.test.js`, `test/workflow-format.test.js`, `test/workflow-cli.test.js`.
- Modify: `README.md` — the command's entry wherever the CLI surface is documented.
- Modify: `ROADMAP.md`.

---

### Task 1: `runsCommand`

**Files:**
- Modify: `src/workflow/run-state.js`, `src/workflow/commands.js`
- Test: `test/workflow-commands.test.js`

**Interfaces:**

```js
// src/workflow/run-state.js — the board's default view, defined next to the states so a new
// state has to be classified deliberately rather than defaulting in or out.
// NOT a state-machine property: completed/failed/interrupted can all transition back to
// running via resume. This is a presentation decision about what an operator wants to see.
export const LIVE_RUN_STATES = Object.freeze(new Set([...]));
```

```js
// src/workflow/commands.js
export async function runsCommand(options = {}, deps = {}) // → { command: "runs", runs, skipped, exitCode: 0 }
```

`options`: `projectAlias` (optional), `state` (optional, validated), `all` (boolean). `deps` supplies the store the same way every other read-only command gets it.

The returned `runs` are full records, sorted by `updatedAt` descending with a stable tiebreak (id) so the output is deterministic. `skipped` is whatever `onListProblem` collected.

**How the command sees skips:** `list()` reports them through the store's `onListProblem`, which the CLI wires to stderr. The command needs them as data. Decide how — the cleanest is for `runsCommand` to build (or wrap) a store whose `onListProblem` collects into an array, following how other commands construct their store. Whatever you choose, **the CLI's existing stderr reporting must keep working for every other command**; do not repurpose the shared one.

**Steps:**

- [ ] **Step 1: Write the failing tests** — cross-project listing; `--project` narrowing; the default excluding `completed`/`failed`/`interrupted` and including the rest; `--all`; `--state completed`; an unknown state refused; ordering by `updatedAt` descending; and a skipped record appearing in `skipped` while the readable runs still list. Use a real store over a temp state root — the board's whole job is reading real records.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement** the live set and the command.
- [ ] **Step 4: Confirm `store.list()` is untouched** — `git diff src/workflow/run-store.js` must be empty. If you needed to change it, stop and report why.
- [ ] **Step 5: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 6: Commit.**

```bash
git commit -m "feat: workflow runs answers what is running across every project"
```

---

### Task 2: The compact table

**Files:**
- Modify: `src/workflow/format.js`
- Test: `test/workflow-format.test.js`

**Interfaces:** `formatRuns(value)` renders the compact view; `formatWorkflowResult` dispatches `"runs"` to it. `--format json` needs no work — `boundedJson` already handles it.

Columns: short run id (first 8 chars, matching how `relaunchSession` shortens session ids for display), state, project, ticket, harness, and a relative `updatedAt` ("2h ago"). **No worktree column** — see the spec.

Under the table, when `skipped` is non-empty: a count and the ids. An empty board prints something that says so rather than nothing at all — a blank response is indistinguishable from a broken command.

Read the existing formatters in that file first and match their idiom; do not invent a table style the rest of the CLI does not use.

**Steps:**

- [ ] **Step 1: Write the failing tests** — a populated board renders each run on one line with its columns; an empty board says so; skipped records appear in a footer with their ids; the output carries no worktree path; and column alignment survives realistic values (a long project alias, a long ticket).
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement**, wiring `"runs"` into `formatWorkflowResult`.
- [ ] **Step 4: Check the width** — render a realistic board and confirm the widest plausible line stays within 100 columns. State the measured width in your report.
- [ ] **Step 5: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 6: Commit.**

```bash
git commit -m "feat: the runs board renders a compact table and names skipped residue"
```

---

### Task 3: The CLI surface

**Files:**
- Modify: `bin/workflow.js`, `README.md`
- Test: `test/workflow-cli.test.js`

**Interfaces:** `workflow runs [--project <alias>] [--state <state>] [--all] [--format compact|json]`.

Add the `USAGE` line in the same style as its neighbours, a `validateShape` entry with the allowed options, and the dispatch. The command takes **no positionals**.

Note the existing convention: `reconcile` takes an optional positional project (`workflow reconcile [project] --run <run-id>`). Decide whether `runs` should follow that (`workflow runs [project]`) or use `--project`, and say which and why in your report — consistency with neighbours matters more than either choice in isolation.

**Steps:**

- [ ] **Step 1: Write the failing tests** — `main(["runs"])` returns 0 and emits the board; `--project` and `--state` reach the command; an unknown `--state` exits 64; `--format json` emits parseable JSON carrying `repositories`; an unexpected positional or unknown option is a usage error; exit code is 0 with runs, without runs, and with skipped records.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement** usage, validation and dispatch.
- [ ] **Step 4: Document it in `README.md`** wherever the CLI surface is already described, in the neighbours' style. Read the file first; do not invent a section.
- [ ] **Step 5: Run it for real** against the developer's actual state root and paste the output into your report — this is the first command whose value is only visible against real data:

```bash
node bin/workflow.js runs --all
node bin/workflow.js runs
```

Note anything surprising about how the real 8 runs render.

- [ ] **Step 6: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: wire workflow runs into the CLI"
```

---

### Task 4: Close out 2.1

**Files:**
- Modify: `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Mark 2.1 done** with its commit range, and note it is the first Fase 2 item.
- [ ] **Step 2: Add a progress-table row** — date, item, range, suite count, and what shipped.
- [ ] **Step 3: Record the two design decisions worth carrying forward:** the default view hides `completed`/`failed`/`interrupted` because the control plane cannot distinguish "completed and merged" from "completed and forgotten" — item **2.4** is when to revisit; and there is **no worktree field** (the paths live in `repositories[]`, one per repo), so the roadmap's own column name for 2.1 was describing something that does not exist.
- [ ] **Step 4: Repoint the next step** to the rest of Fase 2.
- [ ] **Step 5: Run `npm test`**, then commit.

---

## Verification

The spec's twelve Verification Strategy items map to these tasks: 1-8, 11 → Task 1 (behaviour) and Task 3 (through the CLI); 9-10 → Task 2 and Task 3; 12 → every task.

After Task 4, review the branch, merge, push, and confirm CI is green.
