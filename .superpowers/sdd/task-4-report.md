# Task 4 Report: Git Fingerprints and Structured Handoffs

## Status

Implemented Task 4 only: Git worktree fingerprints plus bounded structured handoff validation, canonical result creation, and current/stale result reads.

## Files changed

- `src/workflow/git.js`
- `src/workflow/handoff.js`
- `test/workflow-git.test.js`
- `test/workflow-handoff.test.js`
- `.superpowers/sdd/task-4-report.md`

## RED evidence

### Initial Task 4 RED

Command:

```bash
node --test test/workflow-git.test.js test/workflow-handoff.test.js
```

Observed result before production implementation:

- Focused command failed as expected.
- `test/workflow-git.test.js`: `TypeError: git.fingerprint is not a function`.
- `test/workflow-handoff.test.js`: `ERR_MODULE_NOT_FOUND` for `src/workflow/handoff.js`.
- Summary: `10` pass, `3` fail.

### Self-review regression RED

During self-review, I identified that a current-looking `result.json` could be accepted without store registration and that invalid-state submission needed an explicit pre-artifact guard.

Command:

```bash
node --test --test-name-pattern 'non-running|not registered' test/workflow-handoff.test.js
```

Observed result before the fix:

- `submitHandoff refuses non-running runs without creating result artifacts`: failed with `Missing expected rejection`.
- `readCurrentResult refuses current-looking artifacts that were not registered in the run store`: failed because actual status was `completed` instead of `result-stale`.
- Summary: `0` pass, `2` fail.

## GREEN evidence

### Initial focused GREEN

Command:

```bash
node --test test/workflow-git.test.js test/workflow-handoff.test.js
```

Observed result after initial implementation:

- Summary: `19` pass, `0` fail.

### Regression GREEN

Command:

```bash
node --test --test-name-pattern 'non-running|not registered' test/workflow-handoff.test.js
```

Observed result after the fix:

- Summary: `2` pass, `0` fail.

### Required focused suites

Command:

```bash
node --test test/workflow-git.test.js test/workflow-handoff.test.js test/workflow-run-store.test.js
```

Observed final result:

- Summary: `40` pass, `0` fail.

## Full verification evidence

Command:

```bash
npm test && git diff --check
```

Observed result:

- Full suite: `241` pass, `0` fail.
- `git diff --check`: exit `0` with no output.

After adding new files with intent-to-add so the diff check included them:

```bash
git add -N src/workflow/handoff.js test/workflow-handoff.test.js && git diff --stat && git diff --check
```

Observed result:

- Diff stat: `4 files changed, 1175 insertions(+), 2 deletions(-)`.
- `git diff --check`: exit `0` with no output.

## Implemented

- Added `git.fingerprint({ cwd }) -> { head, branch, dirty, entries, digest }`.
- Fingerprint digest is `sha256:<hex>` over normalized HEAD, branch, dirty flag, sorted porcelain status entries, and `lstat` metadata for dirty paths.
- Fingerprinting resolves dirty paths under the Git worktree, rejects absolute/traversing paths, and never reads file contents.
- Added `src/workflow/handoff.js` with:
  - `HANDOFF_LIMITS`
  - `validateHandoffInput(value, expected)`
  - `submitHandoff({ store, git, runId, generation, input })`
  - `readCurrentResult({ store, git, runId })`
- Handoff validation enforces version, bounded total bytes/strings/arrays/file counts, known statuses, exact expected ticket set, known repository IDs, and relative path-safe changed files.
- `submitHandoff` reads authoritative run/generation/tickets/repositories from the run store, computes current Git fingerprints, ignores caller-supplied identity/fingerprint claims, writes private canonical result artifacts atomically, and updates run metadata/state.
- `readCurrentResult` requires store-registered result metadata and current Git fingerprints; stale or unregistered artifacts return `result-stale` and update run state without deleting archived generation results.

## Self-review

- Scope: no launch, harness, CLI lifecycle, hook, cleanup, fetch/rebase/reset/push/merge/deploy behavior was added.
- Security: no file contents are read for fingerprints; `.env.local` content is covered by tests and is absent from fingerprint output.
- Path safety: Git status paths and handoff changed-file paths reject absolute paths, backslashes, empty segments, `.` segments, and `..` traversal.
- Authority: canonical run ID, generation, ticket set, repository set, and fingerprints come from store/Git, not model input.
- Staleness: `readCurrentResult` never returns `completed` for unregistered or Git-stale artifacts; it records `result-stale` where the state machine permits.
- Atomicity/privacy: `result.json` and `results/generation-<n>.json` are written via private sibling temp files, `sync()`, `rename()`, and `0600` chmod; archive directory is `0700`.
- Error safety: validation and stale errors are bounded and do not include raw handoff strings or artifact contents.

## Concerns / follow-ups

- No blocking concerns for Task 4.
- Future launch/lifecycle tasks should align their persisted repository descriptor shape with the supported handoff fields (`id`/`alias` plus `path`/`cwd`/`worktreePath`).
- Result artifacts and run metadata are separate files, so there is no cross-file transaction; Task 4 mitigates this by requiring an accepting run state before writes and requiring store registration before a result can be current.
