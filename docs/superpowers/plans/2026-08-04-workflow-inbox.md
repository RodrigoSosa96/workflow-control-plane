# `workflow inbox` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command that answers "which of my workers is waiting on me", across projects, without missing a resumed run.

**Architecture:** Herdr's agent-status vocabulary moves out of `reconcile.js` into a shared module; `inboxCommand` starts from `store.list()`, calls `herdr.listAgents()` once, correlates on `transportIdentity.paneId`, and splits runs into `blocked` and `unresolved`; then a compact renderer and the CLI wiring, following the shape item 2.1 established.

**Design source:** [`../specs/2026-08-04-workflow-inbox-design.md`](../specs/2026-08-04-workflow-inbox-design.md). Read its correlation section before Task 2 — the obvious key is stale on resume, and this command is the one where that silently means "nothing needs you".

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **Read-only.** No mutation. Exit 0 in every case, including a non-empty inbox and an unreachable Herdr.
- **Anchored on runs, not agents.** `herdr agent list` returns every agent on the machine, including interactive sessions the control plane never launched. Start from `store.list()` and look up agents for runs we own; a blocked agent with no run behind it is not this command's business.
- **Correlate on `transportIdentity.paneId` first**, falling back to the top-level `paneId` only when there is no transport identity. `executeResume` persists only `{transportIdentity, resumeClaim}` (`src/workflow/resume.js:177`), so the top-level `paneId` names the *dead* pane for every resumed run.
- **Never silently drop a run you could not check.** Unresolvable runs are reported with a reason. An inbox that omits what it could not determine says "nothing needs you", which is the one lie this command must not tell.
- **`reconcile`'s behaviour must not change** when its vocabulary moves. Its existing tests pass untouched.
- **`herdr.listAgents()` is called once**, not per run.
- Zero new dependencies. Baseline: **980 tests, 980 pass, 0 skips**, under both `npm test` and `npm run test:ci-like`.

## Reference: verified facts

- Herdr's agent-status vocabulary is **`idle, working, blocked, done, unknown`** — from `herdr agent wait --help` on the installed binary, which documents `--until` as `[possible values: idle, working, blocked, done, unknown]`.
- `herdr agent list` returns per-agent `{agent, agent_status, pane_id, tab_id, cwd, agent_session:{value}, terminal_title_stripped, workspace_id}`.
- `reconcile.js` already has `agentStatus()` (`:186`), `paneId()` (`:89`), `WRITER_HARNESSES` (`:142`) and `STOPPED_AGENT_STATUSES` (`:143`), all module-private. `blocked` is deliberately **not** in the stopped set.
- `RUN_STATES.BLOCKED` is written only by `handoff.js:16` from a worker's self-reported handoff status — disjoint from a live permission prompt.
- The run record carries `paneId`, `agentId`, `tabId` "only when the launch created the selected agent", and `transportIdentity` whenever the agent operation reported one (`docs/run-record-fields.md`).
- `LIVE_RUN_STATES` (`src/workflow/run-state.js:23`) already defines which states are non-terminal; item 2.1 added it.

## File Structure

- Create: `src/workflow/agent-status.js` — the shared vocabulary.
- Modify: `src/workflow/reconcile.js` — import instead of declare.
- Modify: `src/workflow/commands.js` — `inboxCommand`.
- Modify: `src/workflow/format.js` — `formatInbox`.
- Modify: `bin/workflow.js`, `README.md` — the CLI surface.
- Modify: the corresponding test files.
- Modify: `ROADMAP.md`.

---

### Task 1: Share the agent-status vocabulary

**Files:**
- Create: `src/workflow/agent-status.js`
- Modify: `src/workflow/reconcile.js`
- Test: a new test file for the module; `test/workflow-reconcile.test.js` must pass untouched

**Interfaces:** move `agentStatus`, `paneId`, `WRITER_HARNESSES` and `STOPPED_AGENT_STATUSES` out of `reconcile.js` and export them, plus the vocabulary itself:

```js
// Herdr's own agent-status vocabulary, from `herdr agent wait --help`:
//   [possible values: idle, working, blocked, done, unknown]
// `blocked` deliberately is NOT a stopped status — a blocked agent is alive and waiting.
export const HERDR_AGENT_STATUSES = Object.freeze(new Set(["idle", "working", "blocked", "done", "unknown"]));
```

**This is a pure refactor.** `reconcile.js` must behave identically; its tests are the proof and must not be edited.

**Steps:**

- [ ] **Step 1: Read `reconcile.js`'s helpers and their callers** before moving anything. Some are used in ways a naive move would break.
- [ ] **Step 2: Move and export**, leaving `reconcile.js` importing them.
- [ ] **Step 3: Run `node --test test/workflow-reconcile.test.js`** — must pass with **no edits**. If one needed changing, stop and report which and why.
- [ ] **Step 4: Add tests for the module itself** — the status normalization (case, absent, non-string), the pane-id shapes (`pane_id` vs `paneId`), and that `blocked` is not in the stopped set.
- [ ] **Step 5: Prove one definition** — grep for `STOPPED_AGENT_STATUSES` and `agent_status` and confirm the vocabulary is declared once. Paste the output into the commit message.
- [ ] **Step 6: Run `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "refactor: one definition of Herdr's agent-status vocabulary"
```

---

### Task 2: `inboxCommand`

**Files:**
- Modify: `src/workflow/commands.js`
- Test: `test/workflow-commands.test.js`

**Interfaces:**

```js
export async function inboxCommand(options = {}, deps = {})
// → { command: "inbox", blocked: [...], unresolved: [...], herdrAvailable: boolean, skipped: [...], exitCode: 0 }
```

`options`: `projectAlias` (optional). `deps` supplies the store and the Herdr adapter the way other commands get them — reuse item 2.1's `runsStoreForCommand` if it fits, since this command needs `list()`'s skipped records for the same reason.

Each entry carries enough to act: run id, project, ticket, harness, the pane id it correlated on, and for `unresolved`, **why**.

**The correlation is the whole task.** `transportIdentity.paneId ?? paneId`. Write the reason down where the code does it, not only in the spec — the next reader will otherwise "simplify" it back to the stale field.

**Steps:**

- [ ] **Step 1: Write the failing tests.** The load-bearing one first: a **resumed** run whose `transportIdentity.paneId` differs from its top-level `paneId`, where only the transport identity's pane is blocked — assert it appears. Then: blocked appears; working/idle do not; a blocked agent with no run does not appear; a non-terminal run with no pane id is `unresolved` with a reason; Herdr throwing puts everything in `unresolved` with `herdrAvailable: false` and exits 0; terminal runs never appear; `--project` narrows; and `listAgents` is called exactly once for many runs.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Prove the correlation test is load-bearing** — change the code to read the top-level `paneId` first, confirm the resumed-run test fails, restore. Record the output. This is the design's central claim; a test that passes either way proves nothing.
- [ ] **Step 5: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 6: Commit.**

```bash
git commit -m "feat: workflow inbox reports the workers waiting on you"
```

---

### Task 3: The compact view and the CLI

**Files:**
- Modify: `src/workflow/format.js`, `bin/workflow.js`, `README.md`
- Test: `test/workflow-format.test.js`, `test/workflow-cli.test.js`

**Interfaces:** `workflow inbox [project] [--format compact|json]` — positional project, matching `runs`, `doctor` and `reconcile`.

Follow item 2.1's shape exactly: a table for the blocked runs, `unresolved` named underneath with reasons, an explicit line when the inbox is empty ("Nothing waiting on you"), and `skipped` reported the way `runs` reports it. Read `formatRuns` first and match it rather than inventing a second board style.

**Watch the JSON size.** Item 2.1 shipped a projection because full run records blew a shared 12,000-character limit and the overflow fallback silently dropped every record. This command's entries are already small by construction — keep them that way, and add the same kind of size assertion `runs` has rather than assuming.

**Steps:**

- [ ] **Step 1: Write the failing tests** — a populated inbox renders one line per blocked run; an empty inbox says so; unresolved entries show their reason; the JSON stays well under the output limit for a realistic count and still carries data; `main(["inbox"])` exits 0; `--project` reaches the command; an unexpected positional or unknown option is a usage error.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement** the formatter, the usage line, `validateShape` and the dispatch.
- [ ] **Step 4: Document it in `README.md`** beside `runs`, in the neighbours' style.
- [ ] **Step 5: Run it for real** and paste the output into your report:

```bash
WORKFLOW_STATE_ROOT=$HOME/.local/state/workflow-launcher node bin/workflow.js inbox
```

The developer's 8 real runs are all terminal or `manual-handoff-required` with no live agents, so expect an empty or all-unresolved inbox — **that is a valid result and the point is to see how it reads**. Item 2.1's most important finding came from exactly this step; if the output is confusing or misleading, say so plainly rather than adjusting it quietly.

- [ ] **Step 6: Run the focused files, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: wire workflow inbox into the CLI"
```

---

### Task 4: Close out 2.2

**Files:**
- Modify: `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Mark 2.2 done** with its commit range and a progress-table row.
- [ ] **Step 2: Record the three things this item verified rather than inherited:** Herdr's vocabulary really is `idle/working/blocked/done/unknown` (the roadmap's premise held, unlike several recent ones); `runs --state blocked` does **not** answer this question, because `RUN_STATES.BLOCKED` is written only by `handoff.js` from a worker's self-report; and `events.jsonl`, which the roadmap named as a source, was deliberately not used — the live pane state answers it directly and the event log only replays transitions the control plane already wrote.
- [ ] **Step 3: Record the defect this item found and did not fix** — `executeResume` persists only `{transportIdentity, resumeClaim}`, so the top-level `paneId` names the dead pane for every resumed run. Put it in `Pendientes conocidos`, with the note that `inbox` works around it by correlating on the transport identity and that item **4.4** (`herdr pane report-agent` with runId metadata) is what would make the correlation exact rather than inferential.
- [ ] **Step 4: Repoint the next step** to 2.3.
- [ ] **Step 5: Run `npm test`**, then commit.

---

## Verification

The spec's twelve Verification Strategy items map to these tasks: 10-11 → Task 1; 1-9 → Task 2 (behaviour) and Task 3 (through the CLI); 12 → every task.

After Task 4, review the branch, merge, push, and confirm CI is green.
