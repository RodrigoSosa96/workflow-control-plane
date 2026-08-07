# `workflow archive` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator reclaim a finished run's worktrees and tab — under a preview that says
what would be **lost**, a digest that binds it, and proof that nobody is still working — while
never destroying a commit and never deleting the run's own evidence.

**Architecture:** One new writing git primitive (`removeWorktree`, never `--force`) plus two
read-only loss inspectors, an `archiveCommand` gating on run state, provable lock ownership and
live-agent absence before it removes anything, and a formatter/CLI surface following 2.4's
dry-run → digest → execute grammar.

**Design source:** [`../specs/2026-08-07-workflow-archive-design.md`](../specs/2026-08-07-workflow-archive-design.md).
Read its three measured findings before Task 1 — every one of them contradicts something the
roadmap entry implies, and an implementation that assumes the roadmap's framing gets all three
wrong.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **`shell: false` everywhere.** All git and Herdr calls go through the existing adapters and
  `createProcessRunner`. `src/workflow/verify-runner.js` remains the repo's single documented shell
  departure; add nothing to it.
- **Zero new dependencies.**
- **Never `--force`.** Not on `git worktree remove`, not as a CLI flag, not behind an env var. A
  dirty worktree is a refusal, always. This is the one constraint that has no exception.
- **Never delete a ref, a commit, or a run directory.**
- **Refusals remove nothing** and append nothing — a refusal must never be a partial archive.
- **Fail closed on unknown.** An unreadable `git status`, an `unprovable` lock owner, an
  unresolvable agent: each refuses. Item 0.14's rule, on the most destructive command in the CLI.
- **Removal is not undoable, so the report must be honest about partial completion** rather than
  pretend atomicity. Persistence failures after removals degrade to an error field, never a throw
  (items 2.3 I4 and 2.4).
- **Measure JSON sizes, do not compute them.** The shared limit is 12,000 characters; items 2.1,
  2.3 and 2.4 each shipped a collapse only measurement caught.
- Baseline: **1196 tests, 1196 pass, 0 skips** under `npm run test:ci-like`. Plain `npm test` fails
  7 unrelated tests on this machine (the shell exports `WORKFLOW_PROJECTS_FILE`); use
  `test:ci-like`, or prefix focused runs with a bare `WORKFLOW_PROJECTS_FILE= `.

## Reference: verified facts

All measured against this machine and this code, not inherited:

- **`git worktree remove`**, git 2.43: clean → exit 0; modified **or untracked** files → exit 128
  (`contains modified or untracked files, use --force to delete it`); directory already vanished →
  exit 0, deregistering it; not a worktree → exit 128. It never deletes the branch.
- **3 of 8 real worktrees are dirty**; **7 of 8 hold commits not in `base_branch`** (counts: 1,1,1,
  0,1,3,1,3).
- **Every recorded `tabId` is stale.** Runs record `w2M:t1`, `w2J:t1`, `w2T:t1`, …; Herdr is running
  with workspaces `wD`, `w1V`, `w2W` only. No overlap.
- **`herdr tab close <missing>` returns `{"error":{"code":"tab_not_found"}}` with exit code 0.** The
  adapter's `parseJsonResult` (`herdr.js:44`) already converts that envelope into a `WorkflowError`
  whose `details.code` is `tab_not_found`.
- `workspaceId` is **not** on the run record; `tabId` and `paneId` are (`docs/run-record-fields.md:91-92`).
  One real run (`273432a7`, `failed`) has neither — it died before agent creation.
- Worktree creation is split: ordinary and group-meta via `herdr.ensureNativeWorktree`
  (`execute.js:379`), group children via `git.createWorktree` (`execute.js:986`).
- **No run state is terminal** (`run-state.js`'s `ALLOWED`); `LIVE_RUN_STATES` is the existing
  policy set and its complement is exactly `completed`/`failed`/`interrupted`.
- `classifyMarkerOwnership` (`commands.js:2793`) and `mutexOwnerRecoveryFlow` (`:2812`) are 1.1's
  machinery; `inspectExactProcessByPid` returns `null` only on positive proof of absence.
- The digest grammar to mirror is 2.4's `mergeCommand` (`commands.js:2423` region) — its
  `mergeDigestPayload`, its `{preview, execute}` shape, and its recompute-and-compare execute.
- `git.status({cwd})` and `git.resolveHead({cwd})` already exist and are reusable as-is.

## File Structure

- Modify: `src/workflow/git.js` — `removeWorktree` plus the unmerged-commit counter.
- Modify: `src/workflow/herdr.js` — `closeTab`.
- Modify: `src/workflow/commands.js` — `archiveCommand`, and `runsCommand`'s archived handling.
- Modify: `src/workflow/format.js` — `formatArchive` and the JSON projection.
- Modify: `bin/workflow.js`, `README.md`, `docs/run-record-fields.md`.
- Modify/create the corresponding test files.
- Modify: `ROADMAP.md`.

---

### Task 1: The primitives — one writer, two loss inspectors, one tab closer

**Files:**
- Modify: `src/workflow/git.js`, `src/workflow/herdr.js`
- Test: `test/workflow-git.test.js`, `test/workflow-herdr.test.js`

**Interfaces:**

```js
// git.js — the writer. NEVER accepts or passes --force; that is the point.
async removeWorktree({ cwd, path, timeoutMs })
// → { ok, code, stdout, stderr, argv, reason? }
//   Distinguishes the refusal we care about: a nonzero exit whose stderr names modified/untracked
//   files is `reason: "dirty"`, not a generic failure. Never throws.

// git.js — how many commits are on `branch` that `base` does not have.
async countCommitsNotIn({ cwd, base, branch, timeoutMs })
// → number | null   (null = could not be determined; the caller treats it as unknown, never 0)

// herdr.js — best-effort, idempotent tab closure.
async closeTab({ tabId })
// → { closed: true } | { closed: false, reason: "not-found" } | { closed: false, reason: <message> }
//   `tab_not_found` is `not-found`, which callers treat as already-archived, never as failure.
```

`countCommitsNotIn` returning `null` rather than `0` on failure is load-bearing: `0` means "fully
merged, nothing to warn about", and an unreadable repository must never render as that.

**Steps:**

- [ ] **Step 1: Write the failing tests** against injected runners. For `removeWorktree`: a clean
      removal; a dirty refusal classified as `reason: "dirty"` from git's real stderr text (use the
      measured string, not an invented one); a vanished-directory removal reported as success; a
      not-a-worktree failure; and that `--force` appears in **no** argv this function can produce.
      For `countCommitsNotIn`: a real count; `0`; and a failure yielding `null`, not `0`.
      For `closeTab`: success; `tab_not_found` → `reason: "not-found"`; any other `WorkflowError` →
      reported, not thrown.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Real-git tests.** Build a temp repository with three linked worktrees — one clean,
      one with an untracked file only, one whose directory you `rm -rf` — and assert each outcome
      against real git. **The untracked-only case is the one that matters**: it is the shape a
      worker leaves behind (`node_modules`, `.env.local`, logs) and the one an implementer is most
      likely to assume is safe to remove. Then assert the branch and its commits still exist after
      a successful removal.
- [ ] **Step 5: Prove `--force` is unreachable** — `grep -rn "force" src/workflow/git.js` and
      confirm no path can introduce it. Paste the output into the commit message.
- [ ] **Step 6: Run the focused files, then `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: primitives to remove a worktree without ever forcing, and to measure what removing it would lose"
```

---

### Task 2: `archiveCommand` — the gates, the losses, the digest

**Files:**
- Modify: `src/workflow/commands.js`
- Test: new file `test/workflow-archive.test.js`

**Interfaces:**

```js
export async function archiveCommand(options = {}, deps = {})
// → { preview, async execute({ approvalDigest }) }   -- 2.4's shape
```

Three gates, **all evaluated before any inspection of worktrees**, each its own refusal:

1. **Run state** must be outside `LIVE_RUN_STATES` (i.e. `completed`/`failed`/`interrupted`).
   Reuse that constant; do not write a second classification.
2. **The run lock**, if held, must classify as removable-grade ownership via
   `classifyMarkerOwnership`. Owner alive or `unprovable` → refuse, naming `workflow unlock`.
   Archive must **not** remove the lock itself.
3. **The agent** must not resolve live in Herdr. Correlate `transportIdentity.paneId` first, then
   the top-level `paneId` — the order `workflow inbox` established, because `executeResume` leaves
   the top-level one stale.

Then per `run.repositories[]` entry: the worktree path, its branch, whether it is dirty (and which
files), and how many commits are not in `base_branch` (resolved from the current registry the same
way `mergeCommand`'s `baseCheckoutFor` does — group projects key on `repositories[id]`, ordinary
projects use `project.path`/`project.base_branch`).

**Any dirty worktree refuses the whole run.** A group project archives whole or not at all.

The digest binds: run state, tab id, and per repository the worktree path, branch, dirty flag,
dirty file count, and unmerged-commit count. Display caps must not leak into digested values —
2.4's `mergeDigestPayload`/`publicMergeRepository` split is the pattern.

`execute` recomputes the preview, refuses on digest mismatch naming the fresh one, then removes
worktrees sequentially, closes the tab best-effort, marks the record, and appends the event.

**Steps:**

- [ ] **Step 1: Write the failing tests.** The safety-critical one first: **a dirty worktree
      refuses and removes nothing, including from the other repositories of the same run.** Then:
      each live state refuses by name; a live lock owner refuses naming `workflow unlock`; an
      `unprovable` verdict refuses; a live agent refuses; a vanished worktree archives cleanly;
      unmerged commits are counted, digested, and do **not** refuse; the five no-path entry shapes
      refuse; the digest changes for each material field; a stale digest is refused; a partial
      failure reports removed vs kept; the record is marked and the event appended; a persistence
      failure degrades to an error field without discarding the report.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Three negative controls** — break the code on purpose, confirm a test fails, restore,
      record the output:
      1. Pass `--force` to `removeWorktree` → the dirty-refusal test must fail.
      2. Treat an `unprovable` lock verdict as removable → that test must fail.
      3. Refuse on unmerged commits instead of warning → the unmerged-is-archivable test must fail.
- [ ] **Step 5: Run the focused file, then `npm run test:ci-like`.**
- [ ] **Step 6: Commit.**

```bash
git commit -m "feat: workflow archive reclaims a finished run's worktrees behind proof, a preview of what would be lost, and a digest"
```

---

### Task 3: The formatter, the CLI, the board, and the docs

**Files:**
- Modify: `src/workflow/format.js`, `src/workflow/commands.js` (`runsCommand`), `bin/workflow.js`,
  `README.md`, `docs/run-record-fields.md`
- Test: `test/workflow-format.test.js`, `test/workflow-cli.test.js`, `test/workflow-commands.test.js`

**Interfaces:** `workflow archive <run-id> --dry-run [--format compact|json]` and
`workflow archive <run-id> --yes --approval-digest <digest> [--format compact|json]`.

The compact preview must make **what would be lost** impossible to miss — dirty files and unmerged
commit counts are the point, not the paths being removed. A refusal renders as a refusal, never as
an empty success.

**The board change**, which is the relief item 2.1 named when it measured the 12–14 run ceiling:
archived runs are excluded from `workflow runs --all`, still shown by an explicit `--state`, and the
count of hidden archived runs is named in the compact footer. Do not silently drop them — item 2.1
established that skipped residue gets named under the table.

CLI gates mirror `merge` (`bin/workflow.js:907-919`): `--yes` without `--approval-digest` is a usage
error; neither `--dry-run` nor `--yes` is a usage error.

**Steps:**

- [ ] **Step 1: Write the failing tests** — compact preview names dirty files and unmerged counts;
      a refusal renders as a refusal; `main(["archive", id, "--dry-run"])` mutates nothing;
      `--yes` without a digest is a usage error; `runs --all` excludes archived and names how many;
      `runs --state completed` still shows them; JSON for a realistic three-repository archive is
      **measured** against the 12,000-character limit with a fallback preserving the paths and the
      loss counts.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement**, including usage line, `validateShape`, `KNOWN_OPTIONS`, dispatch, and
      the new run-record field documented in `docs/run-record-fields.md` (its test fails otherwise).
- [ ] **Step 4: Document in `README.md`.** It must state plainly that this is the second exception
      to the no-cleanup policy, what it removes, what it preserves (run directory, branch, commits),
      and that it never forces. Update the no-cleanup bullets in **both** near-duplicate safety
      lists and the prose section. **Read each finished paragraph end to end before committing** —
      that passage produced a factual defect in four consecutive rounds during item 2.4, every time
      from checking the edited clause instead of the sentence it landed in.
- [ ] **Step 5: Run it for real, and this step is not optional.** Build a temp git repository with
      linked worktrees, a temp state root with a real run record, and a temp registry; drive the
      **real CLI** end to end: `--dry-run`, read the digest, execute, and confirm with real `git`
      that the worktrees are gone, the **branch and its commits still exist**, and the run directory
      is intact. Then repeat against a dirty worktree and confirm nothing was removed.

      Paste the real terminal output into your report. Items 2.1 through 2.4 each had their most
      important finding at this step and not from a green suite. **If the output misleads, say so
      plainly rather than adjusting it quietly.**
- [ ] **Step 6: Run the focused files, then `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: wire workflow archive into the CLI and let the board forget archived runs"
```

---

### Task 4: Close out 2.5

**Files:**
- Modify: `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Mark 2.5 done** with its commit range and a progress-table row.
- [ ] **Step 2: Record the three measured findings** — every recorded `tabId` on this machine is
      already stale (so the worktree, not the tab, is the durable residue, which inverts the
      roadmap entry's framing); worktree creation is split between Herdr and `git worktree add`, so
      removal could not assume one mechanism; and `git worktree remove` refuses a dirty worktree,
      with 3 of 8 real worktrees dirty and 7 of 8 holding unmerged commits.
- [ ] **Step 3: Record the deliberate asymmetry** — uncommitted changes refuse, unmerged commits
      only warn — and that the line is recoverability, not severity.
- [ ] **Step 4: Record why this is digest-gated where `unlock` is not**: `unlock` removes
      proven-dead evidence, `archive` removes a working tree that may hold the only copy of
      uncommitted work.
- [ ] **Step 5: Record what it does not do** — no `--force`, no ref/commit/run-directory deletion,
      no lock removal, no bulk archiving, no workspace closing, no pruning of other runs' residue.
- [ ] **Step 6: Note the effect on 2.1's measured ceiling**, honestly: archived runs leaving
      `--all` relieves it, and by how much on this machine.
- [ ] **Step 7: Add new "Pendientes conocidos" entries**, including the two `prunable`
      registrations and the empty worktree-root directories this command deliberately leaves behind.
- [ ] **Step 8: Repoint the next step** to 2.6, the last item of Fase 2.
- [ ] **Step 9: Run `npm run test:ci-like`**, then commit.

---

## Verification

The spec's twelve Verification Strategy items map to these tasks: 2 (partly), 7 → Task 1; 1-7, 9-11
→ Task 2; 8, and the measured JSON → Task 3; 12 → every task.

After Task 4: review the branch adversarially, **and re-review after fixing, not only before** —
item 2.3's timeout fix opened the next hole, and item 2.4's README fix introduced a fresh false
claim twice. Then merge, push, and confirm CI is green before closing the item.
