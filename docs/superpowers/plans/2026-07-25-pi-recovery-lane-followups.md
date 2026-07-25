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
- **Verified live (via backfilled identity against a real idle Pi session):**
  `resume` live → focused; `close` idle → closed:true (ctrl+d, agent exits);
  `resume` dead (no `--yes`) → needs-confirmation. The transport/resume/close code
  is confirmed against a real Pi.
- **Still pending a fresh e2e:** (a) identity survives to `completed` after the fix;
  (b) `resume --yes` relaunch resumes native history + reloads extensions +
  re-points identity at the new pane; (c) next `resume` focuses the new tab.

## Related, still-open (not blocking recovery)

- **Interactive launch reports `partial`/`failed` though the run succeeds.** Same
  root race, plus the post-start bootstrap-pane cleanup (`herdr.closePane`, not
  wrapped in try) can throw and downgrade a successful start. Cosmetic — the run
  completes and (now) keeps its identity — but the launch report and `launchStatus`
  are misleading. Carried over from the sub-project #1 follow-ups; a full fix
  decouples launch metadata/state the same way the identity write was decoupled.
