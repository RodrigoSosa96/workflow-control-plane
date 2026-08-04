# Run record fields

Every workflow run is a JSON object (`run.json` inside its run directory, `src/workflow/run-store.js`).
This document lists every top-level field that object can carry, grouped by the module that
writes it, and is checked by `test/workflow-run-record-inventory.test.js`: that test builds a
record through real store operations and a representative slice of the lanes below, then asserts
every key the resulting record carries is named (as inline code) somewhere in this file. **A field
present in that test's record but missing from this document fails the suite.**

## Scope — what this document is, and is not

- **Top-level `run.json` keys only.** Three fields — `agentProfile`, `delegations`, and
  `telemetry` — are themselves structured objects. `agentProfile` mirrors `previewHarnessProfile()`'s shape
  (`src/workflow/launch.js`); `delegations` is a map keyed by delegation id, whose record shape is
  `delegation-store.js`'s concern; `telemetry` is `telemetry.js`/`telemetry-store.js`'s snapshot
  index. This document does not enumerate their internal keys — that would make it a second copy
  of those modules' own field lists, with its own decay problem.
- **`directory` is not a field of this document on purpose.** `store.read()`/`create()`/`update()`
  attach it to the JS object they return (`attachDirectory`), but `persistableRun()` strips it
  before every write — it never reaches `run.json`. Reading the record straight off disk (as the
  test does) never sees it.
- **The "verified by the check" column is honest, not aspirational.** The check builds one record
  by driving: `launch.js`'s real `createLaunchPreview`/`executeLaunch` (with a stubbed
  `planCommand`/`executeStart`, a real `run-store.js` store), `lifecycle.js`'s real
  `onPrompt`/`onStop`, `hooks/lib/lifecycle-hook-core.mjs`'s real `runLifecycleHook` for the `pi`
  harness only, `handoff.js`'s real `submitHandoff`/`readCurrentResult`, `telemetry-store.js`'s
  real `record()`, `delegation-store.js`'s real `prepare()`, and `resume.js`'s real
  `executeResume()` confirmed-relaunch path. A field written only by a lane the check does not
  drive — a failed launch, the fixture stream-json lane, the `claude`/`codex` lifecycle-hook
  markers — is **not** exercised, and is marked `No` below with the writer that would produce it.
  The check cannot see those; this document is the only place they're recorded.
- **The check matches field *names*, not field *shapes* or *writer attribution*.** It confirms
  every key produced by its fixture appears in this file as inline code (`` `fieldName` ``). It does
  not verify a row's "written by" text is accurate, or that a field's documented meaning is
  correct — that's a human review question, same as any other doc.
- **Known gap, not a documented field: `run.consumedAt`.** `run-store.js`'s `list()` filters on it
  (`filters.unconsumed === true && run.consumedAt`), but no production writer ever sets a
  *top-level* `consumedAt` on a run record — only `run.delegations[id].result.consumedAt`
  (`delegation-store.js`), a different field that happens to share a name. See the task-2 report
  for detail; it is intentionally left out of the table below because nothing actually carries it.

## `run-store.js` — structural fields, present on every record

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `version` | Schema version the record was written under. `initialRun` always stamps `1`; `initialRun`/`updatedRun` strip any caller-supplied `version` so it can't be forged. Checked against `SUPPORTED_RUN_VERSION` on every `read()`/`update()` (item 1.5's other half). | Since creation | Yes |
| `id` | The run's UUID, stamped once from the store's own `nextRunId`; never settable via a patch. | Since creation | Yes |
| `state` | Current lifecycle state (`RUN_STATES`, `run-state.js`). Every writer below that owns a transition supplies the next state in its patch; the store computes `updatedAt`/`stateHistory` around whatever state a patch requests. | Since creation | Yes |
| `createdAt` | Creation timestamp, stamped once, immutable after. | Since creation | Yes |
| `updatedAt` | Stamped by the store (`initialRun`/`updatedRun`) on every write, regardless of which module supplied the patch. | Since creation, changes on every write | Yes |
| `stateHistory` | Append-only `{from, to, at}` list, maintained entirely inside `transitionRun` (`run-state.js`); no caller sets entries directly. | Since creation | Yes |

## `launch.js` — `runInput()`, written once at `store.create()` time

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `generation` | The run's current follow-up generation, starting at 1. Also written later by `lifecycle.js` (follow-up prompts) and `resume.js` (confirmed relaunch). | At creation | Yes |
| `projectAlias` | The project this run belongs to. | At creation | Yes |
| `projectLabel` | Human-readable project label. | At creation | Yes |
| `task` | The primary task identifier the run was launched for. | At creation | Yes |
| `primaryTicket` | Primary ticket id (defaults to `task`). | At creation | Yes |
| `relatedTickets` | Secondary ticket ids bundled into this run. | At creation | Yes |
| `tickets` | Full ticket set (`[primaryTicket, ...relatedTickets]`, normalized). | At creation | Yes |
| `repositories` | Repositories the run touches: `{id, path, branch}` per entry. | At creation | Yes |
| `request` | The approved launch request payload. | At creation | Yes |
| `profileName` | Selected agent profile name. Re-written by `executeLaunch`'s later patch (same value, second call site). | At creation, re-set during launch | Yes |
| `selectionSource` | How the profile was selected (`explicit`, project default, etc). | At creation | Yes |
| `selectionReason` | Human-readable reason for the selection. | At creation | Yes |
| `harness` | Selected harness (`pi`/`claude`/`codex`/`opencode`). Re-written by `executeLaunch`'s later patch. | At creation, re-set during launch | Yes |
| `stateRoot` | The approved execution environment's state root, persisted for audit — a string value, not the live store's own root. | At creation | Yes |
| `controlPlaneBin` | The approved execution environment's control-plane binary path, persisted for audit. | At creation | Yes |
| `assignmentDigest` | Digest of the rendered assignment text. | At creation | Yes |
| `approvalDigest` | Digest of the approved launch preview. | At creation | Yes |
| `launchArgv` | The exact argv the approved preview covers (see `runInput`'s comment on why this is persisted whole rather than field-by-field). | At creation | Yes |
| `agentProfile` | The exact profile object (`previewHarnessProfile()`'s shape) that produced the approved argv — item 1.3. `resume.js`'s relaunch reads this to reproduce the launch envelope. | At creation | Yes |
| `originSessionId` | The originating session's id, if the launch was requested from one. | At creation | Yes |
| `originHarness` | The originating session's harness, if known. | At creation | Yes |

## `launch.js` — `executeLaunch()`'s own later patches (during/after launch)

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `launchStartedAt` | Timestamp stamped right after creation, before the harness actually starts. | Right after creation | Yes |
| `transportIdentity` | The exact worker session identity, persisted as a dedicated state-less merge the moment the agent operation reports one. Also re-written by `resume.js` after a confirmed relaunch. | Once the agent operation reports a session identity | Yes |
| `launchStatus` | The launch's own status (`completed`/`partial`/etc), separate from run `state`. | After the launch attempt | Yes |
| `launchOperations` | The launch's operation report list. | After the launch attempt | Yes |
| `launchNotes` | Notes accumulated during the launch attempt. | After the launch attempt | Yes |
| `agentId` | Herdr agent id, only when the launch created the selected agent. | After a successful agent creation | Yes |
| `tabId` | Herdr tab id, only when the launch created the selected agent. | After a successful agent creation | Yes |
| `paneId` | Herdr pane id, only when the launch created the selected agent. | After a successful agent creation | Yes |
| `nativeSessionId` | The harness's native session id, from the real `buildHarnessLaunch` expected identity. Present as `null` when nothing supplied one (this check's stubbed `executeStart` always leaves it null). | After a successful agent creation | Yes (value is `null`) |
| `sessionName` | The Herdr session name, same source/caveat as `nativeSessionId`. | After a successful agent creation | Yes (value is `null`) |
| `launchError` | The launch failure's `{name, message}`, only on a partial/failed launch. | Only on launch failure | No — not exercised (this check's fixture only drives a successful launch) |
| `fixtureMode` | `true` on the fixture stream-json lane (`registry.launcher.fixture_mode === true` and a stream-json profile). | Only on the fixture lane | No — not exercised (no registry fixture-mode flag in this check's fixture) |
| `workerLaunches` | Fixture worker-launch records keyed by worker id, same lane as `fixtureMode`. | Only on the fixture lane | No — same as `fixtureMode` |

## `run-store.js`'s `writeAssignment()`, invoked by `launch.js`

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `assignmentPath` | Path to the written `assignment.md`. | After the assignment is written | Yes |
| `assignmentUpdatedAt` | Timestamp of the assignment write. | After the assignment is written | Yes |

## `lifecycle.js` — `createLifecycle().onPrompt()` / `.onStop()` / `.onSessionEnd()`

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `stopAttempts` | Consecutive Stop events without a valid handoff, reset by a follow-up prompt. Also reset to `0` by `resume.js` on a confirmed relaunch. | After the first Stop without a handoff | Yes |
| `previousGeneration` | The generation a follow-up prompt or a relaunch just moved off of. Also written by `resume.js`. | On a follow-up prompt or a relaunch | Yes |

(`state` and `generation` are also written here — see the `run-store.js` and `launch.js` rows above.)

## `hooks/lib/lifecycle-hook-core.mjs` — `runLifecycleHook()`, shared by the Pi extension and the Claude/Codex subprocess hooks

One harness's pair of marker fields appears per run, named after `run.harness` (`${harness}StartedOnce` / `${harness}PendingContinuation`) — a run is single-harness, so the three pairs never collide on the same record. Also reset to `false` by `resume.js` on a confirmed relaunch.

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `piStartedOnce` | Whether the Pi worker's first `UserPromptSubmit` has fired — the subprocess/in-process analog of Pi's own in-memory `startedOnce` flag. | On the first `UserPromptSubmit` for a `pi` run | Yes — this check drives the `pi` lane |
| `piPendingContinuation` | Whether a Stop-hook continuation is expected next, so its `UserPromptSubmit` is recognized as a continuation instead of a follow-up. | On a Stop event whose action is `continue`, for a `pi` run | Yes — this check drives the `pi` lane |
| `claudeStartedOnce` | Same marker, `claude` runs. | Same trigger, `claude` runs | No — same writer, not exercised for this harness |
| `claudePendingContinuation` | Same marker, `claude` runs. | Same trigger, `claude` runs | No — same writer, not exercised for this harness |
| `codexStartedOnce` | Same marker, `codex` runs. | Same trigger, `codex` runs | No — same writer, not exercised for this harness |
| `codexPendingContinuation` | Same marker, `codex` runs. | Same trigger, `codex` runs | No — same writer, not exercised for this harness |

## `resume.js` — `executeResume()`'s confirmed relaunch

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `resumeClaim` | `{claimedAt}` while a relaunch is in flight, `null` once it settles (success or failure) — guards two concurrent `resume --yes` calls from both relaunching the same dead session. | While/after a confirmed relaunch | Yes |

(`resume.js` also re-writes `generation`, `previousGeneration`, `stopAttempts`, `${harness}StartedOnce`/`${harness}PendingContinuation`, and `transportIdentity` — see their rows above.)

## `handoff.js` — `submitHandoff()` and `readCurrentResult()`'s internal `markResultStale()`

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `resultGeneration` | The generation the submitted handoff belongs to. | After a structured handoff is submitted | Yes |
| `resultStatus` | The handoff's status (`completed`/`blocked`/`needs-input`/`failed`). | After a structured handoff is submitted | Yes |
| `resultPath` | Path to the current `result.json`. | After a structured handoff is submitted | Yes |
| `resultArchivePath` | Path to that generation's archived result. | After a structured handoff is submitted | Yes |
| `resultArtifactDigest` | Digest of the written result artifact, used to detect staleness later. | After a structured handoff is submitted | Yes |
| `resultFingerprints` | Per-repository git fingerprint digests recorded with the result. | After a structured handoff is submitted | Yes |
| `resultStaleAt` | Timestamp the result was marked stale, written by the unexported `markResultStale()`, reached through `readCurrentResult()` when the current result no longer matches what's registered (metadata drift or a worktree fingerprint mismatch). | When a read detects the registered result is stale | Yes |

## `telemetry-store.js` — `record()`

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `telemetry` | Structured snapshot index (`{version, workers: {[workerId]: {...}}}`); internal shape is `telemetry.js`/`telemetry-store.js`'s concern, not enumerated here. | After the first telemetry event for the run | Yes |

## `delegation-store.js` — `prepare()`, `claim()`, `recordResult()`, and friends

| Field | Meaning | When it appears | Verified by the check |
| --- | --- | --- | --- |
| `delegations` | Map of delegation id to delegation record; internal record shape (`role`, `state`, `budget`, `result`, `remediation`, ...) is `delegation-store.js`'s concern, not enumerated here. | After the first delegation is prepared | Yes |
