# Pi Recovery Lane — Known Follow-ups

> Deferred items from the per-task and whole-branch reviews of
> `feat/pi-recovery-lane`. The branch delivers a working recovery lane
> (`resume`/`close` over a real interactive Pi session), reviewed and green
> (564 tests). These are the tracked, non-blocking gaps.

## Acceptable follow-ups (whole-branch review triage)

1. **`pi`-on-PATH coupling for pure pi-session resume/close.** `bin/workflow.js`
   runs `withLiveDelegationTransport` before the resume/close dispatch, which
   resolves `pi` on PATH and throws `PREFLIGHT: Pi executable must resolve … for
   delegation` if absent — even though a live-session `resume` (only needs
   `herdr tab focus`) or an idle `close` (only needs `herdr agent send-keys`) does
   not use `pi`. Pre-existing pattern; fails closed; `pi` is normally present.
   Fix: skip building the delegation transport when the run is `pi-session`, and/or
   correct the misleading "delegation" message for these commands.

2. **`pi-session-transport.js` hardening.** Local `assertIdentity` is looser than
   `pi-delegation-transport.js`'s (no key allowlist / clone / freeze), and the
   defensive fallback branches (bare-array agent list, camelCase field fallbacks,
   `foreground_cwd`) are untested. The identity is always constructed internally
   (never user input), so this is belt-and-suspenders — tighten or drop the dead
   branches.

3. **`execute.js` duplicated `sessionIdentity` literal** between the ordinary and
   group start paths; the acme group-path test asserts `paneId/tabId/cwd` but
   not `sessionId`/`runId`. If the group-path `nativeSessionId` ever regressed to
   null, a coordinator run would silently become non-resumable with no test
   catching it. Extract a shared helper and add the assertion.

4. **Relaunch argv omits model/profile args and uses a synthesized `--name`
   (`resume-<sessionId>`).** Neither the original session name nor model/profile
   args are recoverable from `transportIdentity`. `--session-id` drives the resume
   and the extensions + `WORKFLOW_*` env are reloaded, so this is cosmetic/quality,
   not correctness. To fully match the original launch, persist the profile name
   (or the full launch argv template) on the run and rebuild from it on relaunch.

5. **`sessionMatches` anchors on `<sessionId>.jsonl`, not `_<sessionId>.jsonl`.**
   The probe recommended including the `_` separator. Not exploitable (equal-length
   UUIDs can't be suffixes of one another; the boundary is tested). Robustness nit.

6. **Only `launch` (not `start`) persists the identity.** `workflow start`'s
   execute report emits a `sessionIdentity` but only `launch` writes it to the run
   record — consistent with recovery being scoped to launch runs, but worth a
   comment so a future reader doesn't expect `start`-created runs to be resumable.

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

## Related, still-open (not blocking recovery)

- **Interactive launch can still report `partial`/`failed` though the run succeeds.**
  The post-start bootstrap-pane cleanup (`herdr.closePane`, not wrapped in try) can
  throw and downgrade a successful start, and the run-state write can still lose the
  race. Cosmetic now — the identity is persisted regardless (state-less write) and the
  worker drives the run — but `launchStatus`/the report remain misleading. A full fix
  decouples launch metadata/state the same way the identity write was decoupled.
