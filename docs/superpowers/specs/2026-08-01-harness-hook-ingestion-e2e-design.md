# Harness Hook Ingestion E2E Design

**Date:** 2026-08-01
**Status:** Proposed
**Roadmap item:** 1.6. Closes the hook-ingestion half of review finding D18 and the Herdr placeholder it names.

## Problem

The control plane wires its lifecycle hooks into each harness by *generating configuration that the harness later executes*:

- **Claude:** `buildClaudeWorkerSettings` (`src/workflow/harnesses.js`) produces a settings object whose every hook entry is a command string — `node "<abs>/hooks/claude-lifecycle.mjs" <event>` — written into the run directory and passed as `--settings`.
- **Codex:** `mergeCodexWorkerHooks` (`src/workflow/codex-hooks.js`) merges the same shape — `node "<abs>/hooks/codex-lifecycle.mjs" <event>` — into the shared global `~/.codex/hooks.json`.

Nothing in the suite ever executes those strings. Every hook test calls `main({...})` in-process with injected seams (`test/workflow-claude-lifecycle-hook.test.js`, `test/workflow-codex-lifecycle-hook.test.js`), which exercises the hook body and skips the entire ingestion path: whether the command string resolves to a file that exists, whether the quoting survives a shell, whether the event token lands where `process.argv[2]` is read, whether the JSON is shaped the way the harness expects.

So a generated settings file that is *completely broken* passes all 921 tests. That is D18's "un settings generado roto pasa toda la suite", and it is the last untested seam between this repo and the two harnesses it drives.

### Why exit codes cannot be the assertion

Both hook entrypoints are deliberately total: `hooks/claude-lifecycle.mjs`'s `main` wraps its whole body in `try {} catch {}` and ends with `process.exitCode = 0`, and `hooks/codex-lifecycle.mjs` does the same. That is correct — a bookkeeping hook must never fail a worker's turn — but it means **a hook that does nothing at all is indistinguishable from a hook that worked, by exit code**. Even running the generated command proves nothing unless the test asserts the effect the hook was supposed to have.

This is also why the defect class is invisible in production until someone needs the state: a moved control-plane checkout, a path with a space, a renamed event, all fail silently and leave a worker whose run record simply never advances.

### The fixture bypasses it too

`scripts/smoke-workflow-fixture.js`'s `--fake` mode does not launch anything — it creates a fixture and prints a suggested command line. Its `--real` mode starts an actual harness, requires a TTY, an explicit typed confirmation and `--keep`, and consumes tokens. There is no middle: nothing automated ever drives a harness's hook configuration.

### The Herdr placeholder

`test/workflow-herdr-smoke.test.js` registers one test that is skipped unless `WORKFLOW_RUN_LIVE_HERDR_SMOKE=1`, and whose body is `throw new Error("Live Herdr smoke not implemented in automated suite")`. Enabling it cannot pass. It is the suite's only skip.

## Decision

Add one test file that drives each harness's **generated** hook configuration the way the harness itself would — through a shell, as a subprocess, with the real stdin payload and env — and asserts the effect on a real run store. Delete the Herdr placeholder.

### Execute the generated string, do not import the module

The test reads what the generator produced, extracts the command, and runs it via `/bin/sh -c`, because that is what the generators themselves say they are targeting: both `buildClaudeWorkerSettings` and `mergeCodexWorkerHooks` carry a comment explaining that the absolute script path is double-quoted "so the shell keeps each path a single argument instead of splitting it (which would silently break the hook)". A test that imports `main()` and calls it cannot observe that property at all — quoting, path resolution, and argv placement are precisely the failure class this item exists to cover.

### Assert the run store, never the exit code

Each case creates a real run in a temp state root, runs the generated hook command with the `WORKFLOW_*` env a worker gets, and asserts the run record moved the way the lifecycle says it should. `UserPromptSubmit` is the natural probe: it is the single work-start driver for both harnesses, so a run left in `LAUNCHING` must come back `RUNNING` at generation 1. A broken command string leaves the record untouched, and the assertion fails.

### Drive the config from the generator, not from a literal

The test must not restate the command string. It reads `buildClaudeWorkerSettings(...)`'s output and `mergeCodexWorkerHooks(...)`'s output, walks them the way each harness documents, and executes whatever it finds. That is what makes this an *ingestion* test rather than a fourth copy of the command — if a future change alters the generated shape, the test follows it, and if the change breaks it, the test fails.

For Codex this means going through `ensureCodexWorkerHooks` against a temp `hooks.json` path, so the merge-and-write path is covered too, not just the pure merge.

### Pi is out of scope, with one narrow substitute

Pi's wiring is `--extension <abs path>` flags that Pi loads in-process. There is no way to exercise that without running Pi, so it stays with the `--real` canary. The analogous silent failure — an extension file moved or renamed, leaving `PI_WORKER_EXTENSIONS` pointing at nothing — *is* cheaply testable: assert every path in `PI_WORKER_EXTENSIONS` exists and can be imported. That covers Pi's share of the broken-path class without pretending to cover its ingestion.

### Delete the Herdr placeholder rather than implement it

Implementing it means driving a live Herdr, which needs a running Herdr instance and manual approval, and is what `scripts/smoke-workflow-fixture.js --real` already provides with a TTY gate and a typed confirmation. Keeping a test whose only reachable outcome is a thrown error is worse than having none: it advertises coverage that does not exist and makes the opt-in flag a trap.

The file goes; the smoke script keeps the responsibility, and a line in its own documentation records where live Herdr verification lives. As a side effect the suite drops to zero skips.

## Goals

- A broken generated Claude settings file fails the suite.
- A broken merged Codex `hooks.json` fails the suite.
- Both are proven by the effect on a run record, not by an exit code that is always zero.
- The test executes what the generator produced, so it cannot drift from it.
- `PI_WORKER_EXTENSIONS` cannot silently point at a missing file.
- The suite has no test whose only outcome is failure.

## Non-goals

- Running a real `claude`, `codex` or `pi` binary. That is the `--real` canary's job.
- Covering every hook event. `UserPromptSubmit` proves ingestion; the other events' bodies are already covered in-process.
- Changing any hook's behavior, any generator's output, or the lifecycle state machine.
- Item 1.2's lifecycle unification. This is its safety net, and must land first without anticipating its design.
- Testing `~/.codex/hooks.json` on the developer's real machine — every filesystem touch is under a temp root.

## Architecture

```text
temp state root ──> real run store ──> run in LAUNCHING, generation 1
        │
        ├── claude:  buildClaudeWorkerSettings({controlPlaneRoot})
        │              └─> settings.hooks.UserPromptSubmit[].hooks[].command
        │                    └─> /bin/sh -c "<command>"   ← as the harness runs it
        │                          stdin: harness JSON payload
        │                          env:   WORKFLOW_* for this run
        │
        └── codex:   ensureCodexWorkerHooks({hooksPath: <temp>, controlPlaneRoot})
                       └─> read back hooks.json
                             └─> hooks.UserPromptSubmit[].hooks[].command
                                   └─> /bin/sh -c "<command>"   ← same
        │
        v
   assert run record: state RUNNING, generation 1
```

The env each subprocess receives is the same `WORKFLOW_*` set `runEnv` produces, plus whatever the process needs to run node. `WORKFLOW_STATE_ROOT` points at the temp root, so nothing touches a developer's real state.

## Error Handling

- If `/bin/sh` or `node` cannot be resolved, the test skips with a named reason rather than failing — the same degrade-don't-lie pattern `test/workflow-hook-ownership.test.js` uses for `ps`.
- The subprocess is given a bounded timeout and its stdout/stderr captured. On assertion failure the captured output is included in the message: a hook that swallowed an error prints nothing by design, so the failure message must say what was run and what the record looked like, or the next person cannot diagnose it.
- Every path the test writes to is under a temp directory removed in `t.after`. The Codex case must never read or write the real `~/.codex/hooks.json`; it passes an explicit `hooksPath`.

## Verification Strategy

1. A run in `LAUNCHING` transitions to `RUNNING` at generation 1 after executing the **generated** Claude settings' `UserPromptSubmit` command through a shell.
2. The same for the Codex command read back from a `hooks.json` written by `ensureCodexWorkerHooks`.
3. Both tests fail when the generator is broken: verified by mutation — corrupt the script path in the generated command and confirm each test fails rather than passing on a zero exit code. This is the property the whole item rests on; a test that passes against a broken generator is worse than no test.
4. The Claude case survives a control-plane root containing a space, proving the quoting the generator's comment claims to provide.
5. The Codex case writes only to its temp `hooksPath`; assert the real `~/.codex/hooks.json` is untouched (compare existence/mtime before and after, or assert the path passed is under the temp root).
6. Every path in `PI_WORKER_EXTENSIONS` exists and can be imported.
7. `test/workflow-herdr-smoke.test.js` is deleted, and the suite reports **zero** skips.
8. No existing hook test changes: the in-process tests keep covering the hook bodies, and this file covers only ingestion.
9. `npm test` green.

## Acceptance Criteria

- Breaking the generated Claude settings or the merged Codex hooks fails the suite, where today both pass it.
- The failure is caught through the effect on the run record, so it cannot be defeated by the hooks' deliberate exit-zero-on-everything.
- The tests read the generators' output rather than restating it, so they cannot drift from what production writes.
- No test in the suite has a thrown error as its only reachable outcome, and the suite has no skips.
- Nothing in the test run touches the developer's real `~/.codex/hooks.json` or real state root.
