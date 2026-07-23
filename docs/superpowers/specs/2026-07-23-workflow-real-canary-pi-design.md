# Workflow Real Pi Canary Design

**Status:** Proposed — awaiting explicit user approval before any implementation or execution.

**Scope:** Extend `scripts/smoke-workflow-fixture.js` so that `--real --agent pi --keep` launches a real Pi harness against a generated disposable fixture, performs one bounded edit, and verifies the end-to-end real integration while preserving all resources for inspection.

**Depends on:** `feature/workflow-observability-opencode` (merged to `main` at `6b3e340`).

---

## Goal

Provide an opt-in, guarded, preserved real-Pi canary that proves the Workflow launcher, telemetry store, worker status/watch surfaces, and canonical handoff path work with an actual Pi harness and Herdr workspace. The canary must be safe to run, safe to fail, and safe to inspect afterward.

The concrete success signal is:

1. A fixture registry and Git repository are generated under a uniquely marked root.
2. `workflow launch fixture-single FIX-101 --agent pi-worker ...` starts a real Pi session via Herdr in the fixture worktree.
3. Pi receives a single bounded assignment (change `fixture.js` value, update its test, run `node --test`, submit handoff).
4. Telemetry records lifecycle events through the real Pi adapter and reaches a terminal phase.
5. The run result is a current, verified `completed` handoff for `FIX-101` and `FIX-102`.
6. All resources are preserved (`--keep`) for manual inspection.

## Non-goals

- Running the canary as an automated test side effect. `npm test` must continue to skip/avoid any real harness invocation.
- Enabling real canaries for Claude, Codex, or OpenCode in this change. Only Pi is in scope.
- Changing OpenCode's `fixture-only` status or background-writer policy.
- Removing, closing, killing, or cleaning up the real Pi worker automatically.
- Reading terminal/transcript content, scraping stdout/stderr, or deriving results from UI state.
- Estimating token cost when the provider does not report it.
- Using any canonical project from `projects.yaml`; the canary always uses a generated fixture registry.

## Authority and privacy model

- Workflow remains the authority for lifecycle, worktrees, reservations, and canonical external handoffs.
- Telemetry is observational only; a `settled` phase does not by itself make a handoff canonical.
- The canary persists only bounded telemetry identifiers/measurements; it never persists prompts, assistant text, thinking text, tool arguments/output, session paths, or credentials.
- The prompt file contains only the bounded assignment text; no project secrets or Asana context.
- The canary never reads `~/.pi` state, guesses sessions, or uses a recent-session shortcut.

## Canary design

### Entry point

```bash
npm run smoke:fixture -- --real --agent pi --keep
```

`--keep` is mandatory for `--real`. The script refuses to run without it.

### Preconditions and gates (fail-closed)

The script performs these checks in order before resolving any binary, launching Herdr, or writing beyond the fixture root:

1. **TTY gate:** `process.stdin.isTTY` and `process.stdout.isTTY` must both be true, unless an explicit test override env (`WORKFLOW_SMOKE_TEST_TTY=1`) is present. In normal use a non-TTY run exits with code 1 and a clear message.
2. **`--keep` gate:** `--real` requires `--keep`. Exit with code 1 if absent.
3. **Agent gate:** `--agent` must be exactly `pi`. Other real agents are out of scope and are rejected.
4. **Canonical-path gate:** The generated fixture registry path is used via `WORKFLOW_PROJECTS_FILE`. The script never loads `projects.yaml` or any registered project.
5. **Cost/assignment disclosure:** Before confirmation the script prints:
   - fixture root path;
   - fixture registry path;
   - selected harness/profile (`pi-worker`) and inherited model if known;
   - ticket set (`FIX-101`, `FIX-102`);
   - exact assignment text;
   - explicit token-cost warning;
   - preservation policy (`--keep` is always on).
6. **Typed confirmation:** The user must type exactly `pi`. `y`, `yes`, empty input, or any other string is rejected. The script ignores `--yes` for `--real`.
7. **No-CI gate:** If common CI environment variables are detected (`CI`, `GITHUB_ACTIONS`, etc.), the script exits with a message that real canaries are interactive-only.

### Fixture generation

Reuse the existing `createWorkflowFixture()` from `src/workflow/fixture.js` with:

- `root`: a new directory under `os.tmpdir()` named with `workflow-smoke-real-pi-<timestamp>-<random>`.
- `packageRoot`: the package root resolved from `scripts/smoke-workflow-fixture.js`.

The generated fixture registry contains the standard `pi-worker` profile with the real `pi` command and a canonical Acme-free `fixture-single` project pointing to the generated repository.

### Assignment and prompt

The prompt file contains exactly:

```text
This is a controlled Workflow canary. Perform exactly these steps:

1. Edit fixture.js so the exported value changes from "initial" to "implemented".
2. Update the matching assertion in test.js if needed.
3. Run `node --test` in this repository.
4. Submit the required structured workflow handoff for tickets FIX-101 and FIX-102.

Do not push, fetch, access secrets, alter permissions, close the workspace, or clean up resources.
Do not perform any work beyond the edit and test described above.
```

### Launch

The script runs the equivalent of:

```bash
WORKFLOW_PROJECTS_FILE=<fixture-registry> \
  node <packageRoot>/bin/workflow.js \
  launch fixture-single FIX-101 --tickets FIX-102 \
  --agent pi-worker --prompt-file <prompt-file> --yes --approval-digest <digest>
```

The approval digest is obtained from a preceding dry-run preview, exactly as the fake smoke does.

### Monitoring and completion criteria

After launch the script polls `workflow result <run-id>` and `workflow worker status <run-id>` using the fixture registry. It stops when any of the following is true:

- `result.status === "completed"` and `result.verification` contains a passed `node --test` entry.
- `result.status === "needs-input"` or `"manual-handoff-required"`.
- `workerStatus.workers[0].phase` is `"failed"`, `"unknown"`, or `"manual-recovery"`.
- A configured wall-clock deadline is reached (suggested: 10 minutes).

On `completed`, the script additionally checks that:

- the fixture Git diff shows only the expected `fixture.js` and `test.js` changes;
- telemetry shows at least `starting`, `running`, and `settled` phases;
- the result is current (not stale) according to `readCurrentResult`.

### Failure handling

On any non-completed terminal state or deadline:

- Stop polling immediately.
- Preserve the fixture root, run directory, and Herdr workspace (`--keep`).
- Print safe inspection commands:
  - `WORKFLOW_PROJECTS_FILE=<registry> workflow result <run-id>`
  - `WORKFLOW_PROJECTS_FILE=<registry> workflow reconcile --run <run-id>`
  - `WORKFLOW_PROJECTS_FILE=<registry> workflow worker status <run-id>`
  - fixture root path.
- Exit with a non-zero code.
- Never send a follow-up, retry, close, kill, or cleanup command automatically.

### Telemetry and widget validation

The canary is also an integration test for the real Pi telemetry adapter and Pi widget. The script should assert that the persisted telemetry snapshot under `<run-dir>/telemetry/workers/<worker-id>.json` exists and contains only bounded, redacted fields. It does not inspect message content or raw provider events.

## Testing strategy

All canary safety gates are tested without invoking a real harness:

- `--real` requires TTY;
- `--real` requires `--keep`;
- `--real --agent pi` rejects wrong typed confirmation;
- `--real --agent claude`/`codex`/`opencode` are rejected as out-of-scope;
- CI env variables block real canaries;
- cost/assignment text is printed before confirmation.

The existing fake smoke (`--fake`) must continue to pass before any real canary is run. Any bug observed during a real canary must first be reproduced as a failing fake-smoke or unit test and fixed there.

## Documentation

Update `docs/superpowers/plans/2026-07-19-workflow-fixture-canaries.md` and `README.md` to document:

- the exact real-Pi canary command;
- the typed-confirmation gate and cost warning;
- the preservation policy;
- inspection commands for preserved failures;
- that real canaries are interactive-only and never run in CI or `npm test`.

## Open questions

1. Should the real-Pi canary default to `--project single`, or should it also support `--project bundle`? (Recommended: keep `single` only for the first real canary; bundle adds multi-repo complexity that is already covered by fake integration.)
2. Should we add an optional `--timeout <minutes>` flag, or hard-code a bounded deadline? (Recommended: hard-code 10 minutes in the first version; expose `--timeout` only after the canary stabilizes.)
3. Do we want to record the canary outcome (run ID, fixture path, result status) in a local, gitignored log file for later review?

## Approval gate

No implementation or execution of this canary may proceed without:

1. User approval of this design document.
2. A separately written and approved implementation plan.
3. Explicit per-run approval before each real-Pi canary execution, including acknowledgement of potential token cost.
