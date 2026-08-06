# `workflow merge` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the arc's last ungoverned step under the same preview → digest → execute envelope
as its first one: an exact, shell-free `git merge` argv per repository, the conflicts it would
produce computed without mutating anything, and execution that only happens against the digest
the preview printed.

**Architecture:** Read-only git preview primitives plus one writing primitive, all in `git.js`
beside every other git argv in this repo; a `mergeCommand` that previews per repository, folds
verification evidence and resolved shas into an approval digest, and on approval merges
sequentially into each base checkout; a formatter and CLI surface following `launch`'s dry-run
grammar and `verify`'s evidence shape.

**Design source:** [`../specs/2026-08-06-workflow-merge-design.md`](../specs/2026-08-06-workflow-merge-design.md).
Read it before Task 1 — in particular "The source branch is read from the worktree, never trusted
from the record", which is the finding that shaped the whole command and which a
record-driven implementation would silently get wrong against every real run on this machine.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner.

## Global Constraints

- **`shell: false` everywhere.** Every git invocation goes through `createProcessRunner`
  (`process.js`). `verify-runner.js` stays the repo's single, documented shell departure and this
  item adds nothing to it. **The argv is what the digest approves**, so it must be exactly what
  runs.
- **Zero new dependencies.**
- **Never report an unverified or partial merge as a success.** A predicted conflict, a dirty
  base checkout, an unreadable `git status`, a `merge-tree` that could not run — each is its own
  named refusal. A group merge that stopped halfway says so.
- **Refusals append nothing** to the run's event log; a merge that did not happen leaves no
  evidence. (`verifyRefusal`'s established shape.)
- **Fail closed on unknown.** Item 0.14's lesson: an unreadable `git status` is a conflict, never
  clean. Same for a `merge-tree` that fails to run.
- **Measure JSON sizes, do not compute them.** The shared limit is 12,000 characters. Items 2.1
  and 2.3 both shipped a collapse that only real measurement caught.
- Baseline: **1086 tests, 1086 pass, 0 skips**, under `npm test` and `npm run test:ci-like`.
  (Note: plain `npm test` fails 7 tests on a machine that exports `WORKFLOW_PROJECTS_FILE`; that
  is the leak `scripts/test-ci-like.sh` exists to neutralize, not a baseline break. Clear the var
  or use `test:ci-like`.)

## Reference: verified facts

Checked against the code and against real data on this machine, not inherited:

- **`git.js` is not read-only.** `createWorktree` (`:250-274`) runs `git worktree add [-b …]`,
  reached from production at `execute.js:986`. What 2.4 adds is not the first git write; it is
  the first write to a *shared, already-checked-out* branch.
- **`repositories[].branch` is a launch-time intention, not a fact.** Real run `0b2612a8`
  (`completed`, three repositories, `sharyco`) records
  `feature/1216110941098331/registro-impl`; that ref **does not exist**. The worktree is on
  `feature/registro-impl`. Two of eight real runs are in this shape.
- **`git merge-tree --write-tree --name-only -z <base> <source>`** is the non-mutating conflict
  oracle. Measured on git 2.43: exit `0` clean, exit `1` conflicted, output is
  `<tree-oid>\0<conflicted-path>\0…\0\0<info records>`. Parse the oid and the paths up to the
  first empty field; ignore the rest. Exit > 1 (or a spawn failure) means **unknown**, which is a
  refusal.
- **Base checkouts are dirty in real life.** Two of the three `sharyco` base checkouts have
  modified files right now. All three are on their configured `base_branch` (`dev`).
- `base_branch` is validated per project (`registry.js:278`) and per repository (`registry.js:294`).
  There is **no** merge-strategy field, and this item does not add one.
- The digest grammar to mirror: `launch.js`'s `approvalDigestFor`/`assertApprovalDigest`/
  `recomputeApprovedPreview`/`staleApprovalDigest` (`:231-356`), and its CLI gate at
  `bin/workflow.js:798-839`.
- `appendEvent(runId, event)` (`run-store.js`) stamps `version`/`id`/`runId`/`timestamp` itself —
  do not pass those. `readLatestVerificationEvidence` (`commands.js:1563`) already reads the
  evidence back; reuse it rather than writing a second reader.
- `VERIFY_EXIT_CODES` (`commands.js:46`) is the exit-code shape to mirror.

## File Structure

- Modify: `src/workflow/git.js` — the preview primitives and the one merge writer.
- Modify: `src/workflow/commands.js` — `mergeCommand` (preview + execute).
- Modify: `src/workflow/format.js` — `formatMerge`, and the JSON projection.
- Modify: `bin/workflow.js`, `README.md` — the CLI surface and its safety documentation.
- Modify: the corresponding test files; add new ones where a module gains a new surface.
- Modify: `ROADMAP.md`.

---

### Task 1: The git primitives — three readers and one writer

**Files:**
- Modify: `src/workflow/git.js`
- Test: `test/workflow-git.test.js`

**Interfaces** (added to the `createGitAdapter` return, beside the existing methods so the whole
git argv surface stays in one auditable module):

```js
// Where the work actually is. Never derived from the run record -- see the spec's
// "The source branch is read from the worktree" and the real-data finding behind it.
async resolveHead({ cwd })
// → { branch: string|null, sha: string }   (branch null when HEAD is detached)

// Is this checkout safe to merge into right now?
async checkoutState({ cwd })
// → { branch: string|null, dirty: boolean|null, statusError?: string }
//   dirty: null means "could not be read" -- item 0.14's direction: the caller treats it as a
//   conflict, never as clean.

// The non-mutating conflict oracle. Touches no ref, no index, no working tree.
async previewMerge({ cwd, base, source })
// → { status: "clean"|"conflicted"|"unknown", tree?: string, conflicts: string[], reason?: string }
//   exit 0 → clean · exit 1 → conflicted (parse paths) · anything else, or a spawn failure →
//   unknown, WITH a reason. Never throws; "unknown" is the fail-closed answer.

// The one writer. shell:false, no editor, no credential prompt, bounded.
async mergeBranch({ cwd, source, timeoutMs })
// → { ok: boolean, code: number, stdout: string, stderr: string, argv: string[] }
//   argv is byte-identical to what the preview advertised: ["git","merge","--no-ff","--no-edit",source]
```

`GIT_TERMINAL_PROMPT=0` in the merge's env so a credential prompt cannot hang a non-interactive
command. `--no-edit` so git never opens an editor there is no terminal for.

**Steps:**

- [ ] **Step 1: Write the failing tests** against an injected runner: `resolveHead` returns branch
      and sha, and returns `branch: null` for a detached HEAD; `checkoutState` reports dirty from
      real `--porcelain=v1 -z` output and returns `dirty: null` plus a reason when `git status`
      throws; `previewMerge` maps exit 0 → `clean`, exit 1 → `conflicted` with the paths parsed
      from the real NUL-separated format (**use the measured fixture in the spec, not an invented
      one**), and exit 2 / a spawn error → `unknown` with a reason and never a throw;
      `mergeBranch` builds exactly `["merge","--no-ff","--no-edit",source]`, passes
      `GIT_TERMINAL_PROMPT=0`, and reports a nonzero exit as `ok: false` rather than throwing.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: One real-git test per direction** — build a temp repository with two divergent
      branches, assert `previewMerge` reports the conflicted path; build one with a clean merge,
      assert `clean`. Then assert, on the conflicted repository, that `previewMerge` changed
      **no ref, no index, and no working-tree file** (capture `rev-parse --all` + `status
      --porcelain` before and after and compare). That non-mutation is the property the whole
      dry-run claim rests on; it must be asserted, not assumed.
- [ ] **Step 5: Confirm `shell: false` still holds** —
      `grep -rn "shell: true\|shell:true" src bin hooks .pi scripts` and confirm `verify-runner.js`'s
      `/bin/sh` remains the only shell use. Paste the output into the commit message.
- [ ] **Step 6: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: git primitives to preview a merge without mutating anything, and to perform one"
```

---

### Task 2: `mergeCommand` — the preview, the digest, the execution

**Files:**
- Modify: `src/workflow/commands.js`
- Test: `test/workflow-commands.test.js` (or a new `test/workflow-merge.test.js` if that file is
  already unwieldy — prefer the new file; this surface is large)

**Interfaces:**

```js
export async function mergeCommand(options = {}, deps = {})
// → { preview, async execute({ approvalDigest }) }   -- the launch.js shape, deliberately
```

The preview, per entry in `run.repositories[]`:

| field | source |
|---|---|
| `repositoryId`, `worktreePath` | the run record |
| `recordedBranch` | `repositories[].branch` — reported, **never used to drive the merge** |
| `sourceBranch`, `sourceSha` | `git.resolveHead({cwd: worktreePath})` |
| `branchMismatch` | `recordedBranch !== sourceBranch` — named, digested, **not** a conflict |
| `basePath`, `baseBranch` | the **current** registry (`repositories.<id>` for a group, the project for a monorepo) |
| `baseBranchCheckedOut`, `baseDirty`, `baseSha` | `git.checkoutState` / `resolveHead` on the base checkout |
| `argv` | `["git","merge","--no-ff","--no-edit",sourceBranch]` |
| `conflicts` | `git.previewMerge` |

Top level: `verification` (from `readLatestVerificationEvidence`, plus `staleRelativeToSource` —
whether the source commit is newer than `verifiedAt`), `runState`, `conflicts[]` aggregated, and
`approvalDigest`.

Refusals (each its own reason, appending nothing): no `repositories[]`; project absent from the
registry; a repository entry with no usable path (**all five shapes item 2.3's C1 enumerated** —
missing field, `null`, `""`, a bare string entry, an empty object); no `base_branch` for a
repository; a worktree whose HEAD cannot be resolved; a resolved sha unreachable from the base
checkout.

Conflicts (block execution, do not refuse the preview — the operator should see the whole picture):
dirty base checkout; `dirty: null`; base checkout not on `base_branch`; `merge-tree` `conflicted`;
`merge-tree` `unknown`.

`execute` mirrors `recomputeApprovedPreview`: recompute the preview, refuse on digest mismatch
naming the fresh digest, then merge **sequentially, stopping at the first failure**, then
`appendEvent` — with the failure of that append degrading to `evidenceError` rather than
discarding a report of merges that have already happened and cannot be undone by re-running.

**Steps:**

- [ ] **Step 1: Write the failing tests.** The load-bearing one first, and it is the real-data
      finding: **a run whose `recordedBranch` does not exist previews and merges the worktree's
      actual branch**, with `branchMismatch: true` surfaced. Then: a three-repository preview
      produces three argvs in order; a predicted conflict blocks execution; a dirty base checkout
      is a conflict; `dirty: null` is a conflict; a base checkout on the wrong branch is a
      conflict; `merge-tree` unknown is a conflict; each refusal reason; the digest changes when
      each of source sha / base sha / dirty / checked-out branch / verification evidence changes;
      a stale digest is refused; a mid-run merge failure reports merged, failed, and
      never-attempted repositories separately; `appendEvent` failing yields `evidenceError` and
      keeps the report.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Prove two things are load-bearing** (controles negativos — break the code on
      purpose, confirm a test fails, restore, record the output):
      1. Drive the merge from `recordedBranch` instead of the resolved head → the real-data test
         must fail. A record-driven implementation is what a reasonable person would write.
      2. Treat `dirty: null` as clean → the unknown-status test must fail.
- [ ] **Step 5: Run the focused file, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 6: Commit.**

```bash
git commit -m "feat: workflow merge previews an exact argv and its conflicts, and executes only against its digest"
```

---

### Task 3: The formatter, the CLI, and the README

**Files:**
- Modify: `src/workflow/format.js`, `bin/workflow.js`, `README.md`
- Test: `test/workflow-format.test.js`, `test/workflow-cli.test.js`

**Interfaces:** `workflow merge <run-id> --dry-run [--format compact|json]` and
`workflow merge <run-id> --yes --approval-digest <digest> [--format compact|json]`.

The compact preview must make four things impossible to miss: the exact argv per repository, the
conflicts, the branch mismatch when there is one, and the verification status. Follow the shape
items 2.1–2.3 established — `renderTable` where a table fits, an explicit line when a section is
empty, reasons on their own lines.

CLI gates, mirroring `launch` (`bin/workflow.js:798-839`): `--yes` without `--approval-digest` is
a usage error; neither `--dry-run` nor `--yes` is a usage error. Add `merge` to the usage block,
and `--dry-run`/`--approval-digest`/`--yes` to its `validateShape` allowlist.

**Steps:**

- [ ] **Step 1: Write the failing tests** — the compact preview renders the argv verbatim, renders
      conflicts distinguishably from a clean preview, names a branch mismatch, and names the
      verification status including when there is none; a refusal renders as a refusal and not as
      an empty success; `main(["merge", runId, "--dry-run"])` exits 0 and mutates nothing;
      `main(["merge", runId, "--yes"])` without a digest is a usage error; the JSON output for a
      **three-repository** preview is measured against the 12,000-character limit and an overflow
      fallback preserves the argv and the conflicts (the two things an operator cannot act
      without) rather than collapsing the whole envelope.
- [ ] **Step 2: Run and verify they fail.**
- [ ] **Step 3: Implement**, including the usage line, `validateShape`, `KNOWN_OPTIONS`, and the
      dispatch.
- [ ] **Step 4: Document in `README.md`** beside `verify`. It must say plainly that `workflow
      merge --yes` is the most consequential mutation this CLI performs — it advances a branch the
      operator's own checkout is on — that it never pushes, and that it never touches the run
      worktree.
- [ ] **Step 5: Run it for real, and this step is not optional.** Build a temp git repository pair
      (base checkout + a linked worktree on a feature branch), a temp state root with a run record
      pointing at it, and a temp registry — then run the real CLI end to end: `--dry-run`, read
      the digest, execute, and confirm with real `git` commands that the base branch advanced,
      that the merge commit exists, and that **the worktree is byte-identical to before**.
      Then repeat against a conflicting pair and confirm nothing moved.

      Paste the real terminal output into your report. Items 2.1, 2.2 and 2.3 each had their most
      important finding at this step and not from a green suite. **If the output misleads, say so
      plainly rather than adjusting it quietly.**
- [ ] **Step 6: Run the focused files, then `npm test` and `npm run test:ci-like`.**
- [ ] **Step 7: Commit.**

```bash
git commit -m "feat: wire workflow merge into the CLI behind its dry-run and approval digest"
```

---

### Task 4: Close out 2.4

**Files:**
- Modify: `ROADMAP.md`

**Steps:**

- [ ] **Step 1: Mark 2.4 done** with its commit range and a progress-table row.
- [ ] **Step 2: Record the two corrected premises** — `git.js` was never read-only
      (`createWorktree` runs `git worktree add`, reached at `execute.js:986`), and 2.4 is not the
      first git write but the first write to a *shared, already-checked-out* branch. Say which
      distinction the digest is actually justified by.
- [ ] **Step 3: Record the real-data finding** — `repositories[].branch` is a launch-time
      intention, stale or nonexistent in two of eight real runs, and the merge is therefore driven
      from the worktree's resolved HEAD with the mismatch surfaced and digested.
- [ ] **Step 4: Record both open decisions and their reasoning** — merge and not rebase (only
      merge has a non-mutating conflict oracle; rebase rewrites the run's own artifact); in the
      base checkout and not the run worktree (that is where `base_branch` is, and git forbids the
      alternative); and evidence folded into the digest rather than gating, with the honest limit
      that an operator who never ran verify can still approve `verification: none`.
- [ ] **Step 5: Record what this does not do** — no push, no cleanup (2.5), no rebase, no conflict
      resolution, no atomicity across repositories.
- [ ] **Step 6: Add the new known-pending entries** to "Pendientes conocidos": partial group
      merges are possible and only reported, not prevented; the preview→execute TOCTOU window that
      `launch` also has; `merge-tree --write-tree` writing collectible loose objects during a
      "dry-run".
- [ ] **Step 7: Repoint the next step** to 2.5.
- [ ] **Step 8: Run `npm run test:ci-like`**, then commit.

---

## Verification

The spec's fifteen Verification Strategy items map to these tasks: 2 (non-mutation), 3 and the
`merge-tree` parsing → Task 1; 1, 3-9, 11-13 → Task 2; 10, 14 → Task 3; 15 → every task.

After Task 4: review the branch adversarially — the 2.3 review found a critical the green suite
did not, and the fix for the 2.3 timeout introduced the next regression, so **re-review after
fixing, not only before**. Then merge, push, and confirm CI is green before closing the item.
