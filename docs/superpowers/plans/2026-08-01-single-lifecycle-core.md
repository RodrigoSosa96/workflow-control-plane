# Single Lifecycle Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leave exactly one module owning the worker lifecycle protocol, so all three harnesses produce identical generation arithmetic for identical actions — including across a resume, where they currently disagree by accident.

**Architecture:** `hooks/lib/lifecycle-hook-core.mjs` stops returning Claude's wire format and returns a structured decision instead; the three harness files render it in their own protocol. `.pi/extensions/workflow-worker-lifecycle.ts` becomes a thin adapter over that core, trading its in-memory flags for the persisted markers. `executeResume` explicitly opens a new generation with a fresh stop budget and cleared markers, before the relaunched worker's env is built.

**Design source:** [`../specs/2026-08-01-single-lifecycle-core-design.md`](../specs/2026-08-01-single-lifecycle-core-design.md). Read its "The divergence is observable, and neither behaviour was designed" section before starting — the direction was a decision, not a discovery.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **One module decides; three files render.** After this work no lifecycle *condition* may live outside `hooks/lib/lifecycle-hook-core.mjs`, and no harness wire format may live inside it.
- **Every path stays swallowed.** The Pi adapter runs inside Pi's fire-and-forget `pi.on(...)` dispatch, where a throw is an unhandled rejection on a normal path. Keep the adapter's own outer `try/catch` even though the core has one.
- **Claude and Codex output must not move.** They render the same `{"decision":"block","reason":…}` to stdout, byte-for-byte. Their hook tests assert on stdout (`test/workflow-claude-lifecycle-hook.test.js:80,156`, `test/workflow-codex-lifecycle-hook.test.js:98,161`) and must pass **untouched**.
- **Item 1.6's hook-ingestion tests must pass untouched** (`test/workflow-hook-ingestion.test.js`). They execute the real hook commands end to end and are this item's safety net; if one changes, stop and report it.
- **The resume update lands before `relaunch()`**, or the resumed pane's `WORKFLOW_GENERATION` disagrees with the record.
- Zero new dependencies. Every task ends with its covering tests passing and `npm test` green, still **zero skips**. Baseline before Task 1: **929 tests, 929 pass, 0 skips**.

## Reference: what the code does today

- `runLifecycleHook` (`hooks/lib/lifecycle-hook-core.mjs:81`) returns `JSON.stringify({decision: "block", reason: continuationPrompt(...)})` on a continue action, `undefined` otherwise. `hooks/claude-lifecycle.mjs` and `hooks/codex-lifecycle.mjs` both do `if (typeof output === "string" && output.length > 0) process.stdout.write(output)`.
- `.pi/extensions/workflow-worker-lifecycle.ts` holds `startedOnce`/`pendingContinuation` as closure `let`s, has its own `continuationPrompt` (`:6-8`) and its own exported `handoffExists` (`:102-105`) that compares the bare string `"completed"`.
- The core's markers are `${harness}StartedOnce` / `${harness}PendingContinuation`, persisted via `store.update` (`:101-102`, `:119`, `:123`, `:154`).
- `lifecycle.onPrompt` (`src/workflow/lifecycle.js:29-44`) accepts a generation bump only when `source === "user"`, state is not LAUNCHING, and `generation > current.generation`; that same branch is the only thing that resets `stopAttempts`.
- `executeResume` (`src/workflow/resume.js`) takes a claim update under the run lock **before** calling `relaunch`, and clears `resumeClaim` if `relaunch` throws.
- `relaunchSession` builds the pane env with `runEnv(run, harness)`, which stamps `WORKFLOW_GENERATION` from the record.

## File Structure

- Modify: `hooks/lib/lifecycle-hook-core.mjs` — return a decision, not a string.
- Modify: `hooks/claude-lifecycle.mjs`, `hooks/codex-lifecycle.mjs` — render the decision.
- Rewrite: `.pi/extensions/workflow-worker-lifecycle.ts` — thin adapter.
- Modify: `src/workflow/resume.js` — the explicit new generation.
- Modify: `test/workflow-pi-lifecycle-extension.test.js`, `test/workflow-hook-debug-log.test.js`, `test/workflow-resume.test.js`.
- Create: `test/workflow-lifecycle-parity.test.js` — the cross-harness proof.
- Modify: `ROADMAP.md`.

---

### Task 1: The core returns a decision, not Claude's wire format

**Files:**
- Modify: `hooks/lib/lifecycle-hook-core.mjs`, `hooks/claude-lifecycle.mjs`, `hooks/codex-lifecycle.mjs`
- Test: `test/workflow-hook-debug-log.test.js` (it calls `runLifecycleHook` directly)

**Interfaces:**

```js
// hooks/lib/lifecycle-hook-core.mjs — the Stop branch's continue case returns this instead of
// a JSON string. Every other path keeps returning undefined.
//   { continuation: { prompt: string } }
```

Each harness file renders it:

```js
// claude + codex (identical): the block decision is Claude's/Codex's own wire format, and it
// belongs in the file that speaks that protocol, not in the module Pi shares.
const decision = await runLifecycleHook({ harness: "...", event, stdinJson, env, store, lifecycle, telemetry });
if (decision?.continuation) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: decision.continuation.prompt }));
}
```

**Why this first:** it is the change that makes a Pi adapter possible at all. Doing it before touching Pi keeps this task's blast radius to a contract both existing harnesses already pass through untouched.

**Steps:**

- [ ] **Step 1: Read the two harness hook files' output handling** (`hooks/claude-lifecycle.mjs` and `hooks/codex-lifecycle.mjs`, in `main()`), and the tests that assert their stdout. Those assertions are your contract: the bytes written must not change.
- [ ] **Step 2: Change the core's Stop-continue return** to `{ continuation: { prompt: continuationPrompt(runId, current.generation) } }`. Leave every other return as `undefined`.
- [ ] **Step 3: Render in both harness files.** Keep the "never throw" posture: a malformed decision must not break `main`.
- [ ] **Step 4: Update `test/workflow-hook-debug-log.test.js`** where it asserts on the core's return value — it tests the core's contract, so it follows the contract. Do not weaken what it asserts; translate it.
- [ ] **Step 5: Run `node --test test/workflow-claude-lifecycle-hook.test.js test/workflow-codex-lifecycle-hook.test.js test/workflow-hook-debug-log.test.js`.** The first two must pass **with no edits**. If either needed one, stop and report it.
- [ ] **Step 6: Run `npm test`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "refactor: the lifecycle core returns a decision, not Claude's wire format"
```

---

### Task 2: Pi becomes a thin adapter

**Files:**
- Rewrite: `.pi/extensions/workflow-worker-lifecycle.ts`
- Test: `test/workflow-pi-lifecycle-extension.test.js`

**Interfaces:** the adapter maps Pi's events onto the core's and renders the decision:

| Pi event | core `event` | render |
|---|---|---|
| `agent_start` | `UserPromptSubmit` | — |
| `agent_settled` | `Stop` | `pi.sendUserMessage(prompt, {deliverAs: "followUp", triggerTurn: true})` |
| `session_shutdown` | `SessionEnd` | — |

Pass `stdinJson: {}`; Pi's events carry no payload the core reads. Pass `env` so the core's `recordDebug` can write to the run's hook debug log — an improvement over today's silent `catch {}`.

**What goes away:** the local `continuationPrompt` (`:6-8`), the exported `handoffExists` (`:102-105`) with its `"completed"` literal, and both closure `let`s. Generation discrimination now comes from `piStartedOnce` / `piPendingContinuation` on the run record.

**Keep:** the inert-return guard when env is missing or the harness is not pi (`:26-27`), the module-scope `createSubprocessOwnOwnershipReader()` and its comment, the injection seams (`env`, `store`, `createRunStore`, `readOwnOwnership`), and an outer `try/catch` per handler.

**The existing tests are the specification of the behaviour you must preserve.** `test/workflow-pi-lifecycle-extension.test.js` has tests for two-continuations-then-fallback, continuation reuses the generation, a user follow-up increments it, session_shutdown, and the swallow-a-throw pair. Those behaviours must survive. The four `handoffExists` tests (`:80-95`) test an export that ceases to exist — check whether the core's own test file already covers the same four cases; if it does, delete them and say so, if it does not, move them there.

**Steps:**

- [ ] **Step 1: Read the existing extension and its test file in full** before writing anything. The tests encode behaviour the spec does not restate.
- [ ] **Step 2: Rewrite the extension** as the adapter.
- [ ] **Step 3: Update the test file** — the behavioural tests stay and must pass; the `handoffExists` tests move or go per the check above. Any test whose *assertion* you weaken is a finding: report it instead.
- [ ] **Step 4: Add a test that the continuation is rendered via `pi.sendUserMessage`** with the core's prompt, and that no JSON is written anywhere.
- [ ] **Step 5: Add a test that the first `agent_start` persists `piStartedOnce`** on the run record — the marker, not a closure variable, is now the discriminator.
- [ ] **Step 6: Run the file, then `npm test`.**
- [ ] **Step 7: Prove there is one definition left** — `grep -rn "continuationPrompt\|handoffExists" src hooks .pi scripts | grep -v node_modules` and confirm each has exactly one definition. Paste the output into the commit message.
- [ ] **Step 8: Commit.**

```bash
git commit -m "refactor: Pi's lifecycle extension is a thin adapter over the shared core"
```

---

### Task 3: `resume` explicitly opens a new generation

**Files:**
- Modify: `src/workflow/resume.js`
- Test: `test/workflow-resume.test.js`

**Interfaces:** `executeResume`'s existing claim update — the one taken under the run lock before `relaunch`, which already validates the transport identity and refuses a concurrent resume — also opens the new generation:

```js
        return {
          resumeClaim: { claimedAt },
          generation: current.generation + 1,
          previousGeneration: current.generation,
          stopAttempts: 0,
          [`${harness}StartedOnce`]: false,
          [`${harness}PendingContinuation`]: false,
        };
```

`harness` comes from `plan.identity.harness`. Clearing the markers is what makes the first prompt after a relaunch take the first-prompt branch in *every* harness and confirm the generation the resume already opened, instead of bumping it a second time.

**The rollback must cover it.** `executeResume` already clears `resumeClaim` when `relaunch()` throws. It must now restore the generation, `stopAttempts` and both markers too — capture their prior values before the update. A failed relaunch that left the record claiming a generation whose worker never started is worse than the divergence this item is closing.

**Ordering is load-bearing:** `relaunchSession` builds the pane env with `runEnv(run, harness)`, so this must land before `relaunch()` is called or the resumed worker's `WORKFLOW_GENERATION` disagrees with the record.

**Steps:**

- [ ] **Step 1: Write the failing tests** — a confirmed resume yields `generation: N+1`, `stopAttempts: 0`, both markers `false`; a resume whose `relaunch` throws restores all of them along with the claim; and the update is observed **before** `relaunch` is called (have the injected `relaunch` read the store and assert what it sees).
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement**, including the rollback.
- [ ] **Step 4: Add the test that makes this worth doing** — a run with `stopAttempts` at the limit, resumed, whose next stop yields `continue` rather than `manual`. That is the operator-visible payoff; without it the change is bookkeeping.
- [ ] **Step 5: Confirm the focus path is untouched** — a live session still focuses and opens no new generation. The existing resume tests cover focus; they must pass unedited.
- [ ] **Step 6: Run the file, then `npm test`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "fix: a confirmed resume opens a new generation with a fresh stop budget"
```

---

### Task 4: The cross-harness parity proof

**Files:**
- Create: `test/workflow-lifecycle-parity.test.js`

**Interfaces:** no production change. This is the test the whole item exists to make possible, and it is the one that would have caught D5.

Drive the **same event sequence** against all three harnesses and assert the run record is identical at every step:

```text
launch (LAUNCHING, generation 1)
  → first prompt        → RUNNING, generation 1
  → stop, no handoff    → continue, stopAttempts 1
  → continuation prompt → generation 1 (reused)
  → user follow-up      → generation 2, stopAttempts 0
  → resume              → generation 3, stopAttempts 0, markers cleared
  → first prompt after  → generation 3 (confirmed, NOT bumped again)
```

For claude and codex, drive `runLifecycleHook` directly with the harness name. For pi, drive the adapter through a fake `pi` object — follow `test/workflow-pi-lifecycle-extension.test.js`'s existing fake. Use a real run store over a temp state root so the assertions are on persisted records, not on stubs.

**Write it table-driven over the three harnesses**, so a future harness is one row and a divergence is one failing row rather than three files to compare by eye.

**Steps:**

- [ ] **Step 1: Write it for claude and codex first** and confirm they agree.
- [ ] **Step 2: Add the pi row.** If it disagrees, that is the item's whole point — fix the adapter, not the test.
- [ ] **Step 3: Prove it would have caught the old divergence** — temporarily give the pi row the pre-1.2 behaviour (skip the resume's marker clearing so the first post-resume prompt bumps a second time), confirm the parity test fails, restore. Record the failing output in the commit message.
- [ ] **Step 4: Run the file, then `npm test`.**
- [ ] **Step 5: Commit.**

```bash
git commit -m "test: pin identical lifecycle arithmetic across all three harnesses"
```

---

### Task 5: Close out the roadmap

**Files:**
- Modify: `ROADMAP.md`

**Interfaces:** documentation only, **Spanish** (code identifiers stay in English). Read the 1.3 and 1.6 entries first. `npm test` must stay green.

**Steps:**

- [ ] **Step 1: Mark 1.2 done** with its commit range.
- [ ] **Step 2: Add a progress-table row** — date, item, range, final suite count, and what changed: one core owning the protocol, the core returning a decision rather than Claude's wire format, Pi as a thin adapter on persisted markers, and resume explicitly opening a new generation.
- [ ] **Step 3: State the behaviour change plainly.** Pi's post-resume arithmetic changed: it used to reuse the generation and keep the stop budget, now it opens a new generation with a fresh budget like the other two. Say that neither old behaviour was designed — one came from a fresh process, the other from a surviving marker — and that the direction was chosen because the generation bump is the only thing that resets `stopAttempts`, so under Pi's old semantics resuming an exhausted worker accomplished nothing.
- [ ] **Step 4: Record the drift this closed** — Pi's `handoffExists` compared a bare `"completed"` literal where the core used `RUN_STATES.COMPLETED`, so a change to that constant would have silently stopped Pi recognising handoffs.
- [ ] **Step 5: Repoint the ordered list** — 1.2 complete; **1.5** becomes the last remaining Fase 1 item. Note the un-numbered follow-up 1.3 left open (three normalizations of `plan.agent → profile`) if the file still carries it.
- [ ] **Step 6: Run `npm test`**, then commit.

---

## Verification

The spec's eleven Verification Strategy items map to these tasks:

| Spec item | Task |
|---|---|
| 1 (Pi marker-driven arithmetic) | Task 2 |
| 2 (Pi renders via sendUserMessage) | Task 2 |
| 3 (Claude/Codex stdout unchanged) | Task 1 — their tests pass untouched |
| 4 (one definition each, no literal) | Task 2, step 7 |
| 5 (the divergence is closed) | Task 4 |
| 6, 7 (resume opens the generation, before the env) | Task 3 |
| 8 (rollback on relaunch failure) | Task 3 |
| 9 (exhausted worker gets a fresh budget) | Task 3, step 4 |
| 10 (1.6's ingestion tests untouched) | every task |
| 11 (`npm test` green, zero skips) | every task |

After Task 5, run a final review of the whole branch diff against the spec before merging.
