# Pi Recovery Lane — Known Follow-ups

> Deferred items from the per-task and whole-branch reviews of
> `feat/pi-recovery-lane`. The branch delivers a working recovery lane
> (`resume`/`close` over a real interactive Pi session), reviewed and green
> (564 tests). These are the tracked, non-blocking gaps.

## Acceptable follow-ups (whole-branch review triage)

> Hardening sweep 2026-07-27 (branch `fix/recovery-lane-hardening`) closed items 2, 3,
> 5, and 6. Items 1 and 4 are intentionally deferred (see below) — each is a behaviour
> change bigger than a nit and wants its own focused change plus a live check.

1. **`pi`-on-PATH coupling for pure pi-session resume/close — DEFERRED.**
   `bin/workflow.js` runs `withLiveDelegationTransport` before the resume/close
   dispatch, which resolves `pi` on PATH and throws `PREFLIGHT: Pi executable must
   resolve … for delegation` if absent — even though a live-session `resume` (only
   needs `herdr tab focus`) or an idle `close` (only needs `herdr agent send-keys`)
   does not use `pi`. Pre-existing pattern; fails closed; `pi` is normally present.
   Fix: skip building the delegation transport when the run is `pi-session`, and/or
   correct the misleading "delegation" message for these commands. Deferred from the
   hardening sweep: it changes the CLI's preflight behaviour, so it needs its own
   change + a live check rather than a blind edit.

2. **`pi-session-transport.js` hardening — DONE.** The defensive fallback branches
   (bare-array agent list, camelCase field fallbacks, `foreground_cwd`) are now
   pinned by tests in `test/workflow-session-transport.test.js`, so they are covered
   rather than dead code and a refactor cannot silently drop one. `assertIdentity`
   was intentionally left as-is (not tightened to a strict allowlist/clone/freeze):
   the identity is always constructed internally, and a strict allowlist risks
   rejecting a legitimately extended identity for no real gain.

3. **`execute.js` duplicated `sessionIdentity` literal — DONE.** Extracted a shared
   `resolveSessionIdentity` helper used by both the ordinary and group/coordinator
   start paths (the two copies can no longer drift), and added a acme group-path
   test that asserts the coordinator identity carries the native `sessionId`, guarding
   the exact "regressed to null → non-resumable coordinator" scenario.

4. **Relaunch argv omits model/profile args and uses a synthesized `--name`
   (`resume-<sessionId>`) — DEFERRED.** Neither the original session name nor
   model/profile args are recoverable from `transportIdentity`. `--session-id` drives
   the resume and the extensions + `WORKFLOW_*` env are reloaded, so this is
   cosmetic/quality, not correctness. To fully match the original launch, persist the
   profile name (or the full launch argv template) on the run and rebuild from it on
   relaunch. Deferred from the hardening sweep: this is a run-record schema + launch +
   relaunch change (a small feature), not a nit.

5. **`sessionMatches` anchors on `<sessionId>.jsonl`, not `_<sessionId>.jsonl` — DONE.**
   Verified: `SESSION_ADAPTERS.pi.sessionMatches` already anchors on
   `` `_${id}.jsonl` `` (the `_` separator is included), so the robustness nit is
   already satisfied in the generalized transport.

6. **Only `launch` (not `start`) persists the identity — DONE (documented).** A
   comment on `resolveSessionIdentity` in `execute.js` now states that only `launch`
   persists the identity (as the run's `transportIdentity`) and that a bare
   `workflow start` emits it in the report but never writes it, so start-created runs
   are intentionally not resumable — recovery is scoped to launch runs.

## Runtime verification (Task 7, in progress 2026-07-25)

The first real e2e found and fixed a launch bug, and verified most of the lane:

- **FIXED (`88289fe`) — launch dropped `transportIdentity` on a race.** The
  interactive worker's lifecycle extension advances the run state concurrently with
  the launcher, so the launcher's combined state+identity `updateRun` could lose the
  race, throw an illegal transition, and be swallowed — leaving the run with
  `transportIdentity: null` even after it completed, which made `resume`/`close`
  return `no-identity`. Now the identity is persisted first via a state-less merge.
  See `docs/superpowers/verification/pi-recovery-lane.md` for the full diagnosis.
- **FIXED (`d761d85`) — resume focused the wrong pane.** `tab focus` raised the tab
  but left the retained bootstrap shell pane (above Pi) active. Switched to
  `herdr agent focus <paneId>`, which focuses Pi's own pane.
- **FIXED (`5c491cc`) — `resume --yes` opened an empty pane.** The relaunch agent name
  `resume-<full sessionId>` was 43 chars; Herdr caps agent names at 32, so
  `agent start` failed and Pi never started. Named it `resume-<sessionId first block>`.
- **Full cycle verified live (run `ff81022c`):** launch → identity survives to
  completed → resume focuses Pi → close idle → resume dead → `resume --yes` resumes
  the **real session with full history** (confirmed via `herdr pane read`) → resume
  focuses the new pane. The recovery lane works end-to-end. Details in
  `docs/superpowers/verification/pi-recovery-lane.md`.

## Also fixed during Task 7 re-test

- **FIXED (`5c5e89f`) — readiness-timeout under load dropped the run + identity.**
  `herdr agent start` blocks up to a readiness timeout; under load an interactive Pi
  exceeded the old 30s, so Herdr returned "timed out waiting for agent startup" even
  though Pi started — the agent op became `failed` (no `sessionIdentity`) and the run
  went `partial/failed` with `transportIdentity: null`. Raised the timeout to 90s and
  added recovery: on that timeout, consult `agent list` and, if the agent is in the
  pane we started it in, treat it as started so the identity is captured.

## Related

- **Interactive launch reporting `partial`/`failed` though the run succeeds — FIXED**
  (branch `fix/interactive-launch-partial-report`). The concrete trigger — the post-start
  bootstrap-pane cleanup (`herdr.closePane`) not being wrapped in try, so a cleanup failure
  degraded a successful start to `partial` — is fixed: `closePane` failures are now a note,
  never a partial (matching `verifyCloseSafety`'s handling). The earlier `partial`/`Tab:
  unknown` reports were the readiness-timeout / identity-race path, already resolved by the
  recovery lane's `recoverStartedAgent` + state-less identity write; recent Claude/Codex
  launches report `running` cleanly with real tab/pane. Genuine agent-start failures still
  correctly report `partial`.
