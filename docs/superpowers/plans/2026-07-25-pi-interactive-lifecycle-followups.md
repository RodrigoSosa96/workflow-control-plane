# Pi Interactive Lifecycle — Known Follow-ups

> Deferred items from the per-task and whole-branch reviews of
> `feat/pi-interactive-lifecycle`. The branch delivers the harness-neutral
> lifecycle core, the Pi lifecycle extension, and the CLI surface, all reviewed and
> green (538 tests). These are the tracked gaps to close in a follow-up
> sub-project — mostly the **recovery lane** (resume/close against real runs).

## Recovery lane is not yet functional against real runs

The whole-branch review confirmed `resume`/`close` are wired and unit-correct but
do not work end-to-end on a real interactive run yet. Closing this is its own
brainstorm → spec → plan cycle.

1. **`transportIdentity` is never persisted on a run.** Until launch captures the
   exact Pi session identity into the run record, `resume`/`close` always return
   `no-identity`/`refuse`. Wire identity capture at interactive launch.
2. **Wrong transport kind for an interactive session.** The CLI wires
   `createPiDelegationTransport` (identity `kind:"pi-delegation"`, a delegation
   child under `runDir/delegations/`). An interactive worker is a top-level Pi
   *session* (`kind:"pi-session"`, launched by `piArgv` with `--session-id`).
   Resume/close need a **session** transport, not the delegation transport —
   capturing identity alone will not make them work.
3. **`resume` only plans.** `planResume` returns `focus`/`relaunch`/`refuse` but
   there is no execute step; the design says resume "plans **and executes**". Add
   the execute step (focus a live pane / relaunch `pi --session-id <exact>` with
   the extensions).
4. **`close` misreports success.** `closeWorker` discards the transport's
   `{requested:false, manual:true}` and hardcodes `{closed:true}` on idle. Once a
   real graceful-close transport exists, honor its result (closed only if actually
   requested/terminated); today `requestGracefulClose` is a manual-only stub.

## Surfaced by the Task 8 interactive run (2026-07-25)

- **Launch report says `partial`/`failed` with `Tab: unknown` / `Pane: unknown`
  for an interactive run that actually succeeds.** In the Task 8 autonomous run
  the launch printed `Launch status: partial` / `State: failed` and could not
  resolve the agent tab/pane, yet the run went `planned → launching → running →
  completed` and the handoff was accepted. The interactive `agent start` path
  does not surface the started tab/pane back into the launch report the way the
  supervisor path does, so the launch under-reports success. Fix the interactive
  launch report to record the real tab/pane and not mark the run failed when the
  agent actually started.
- **`observability widget cost/tokens display** — FIXED on this branch
  (`buildObservabilityLines`): the widget printed measurement objects as
  `$[object Object]` and never showed tokens. Kept here for the record.

## Smaller hardening / polish

5. **`lifecycle.js` no-op writes.** `onStop`/`onSessionEnd` call `store.update`
   even on no-op paths, causing a real write + fresh `updatedAt`. Skip the write
   when nothing changes. (No corruption; just wasteful and makes `updatedAt`
   slightly misleading.)
6. **`resume.js` integration test.** No test exercises `planResume` against a real
   throwing store (unit tests use fakes); add one when the recovery lane is wired.
7. **Extension polish.** Redundant `store.read` in the `agent_settled` default
   `hasValidHandoff` path; `readEnv`-allowlist style divergence from the
   observability sibling; `any`-heavy typing (no `Lifecycle`/`Store` interfaces).
   Cosmetic; the un-awaited `sendUserMessage` was already fixed on this branch.

## Runtime assumptions to confirm in Task 8 (interactive e2e)

- `triggerTurn:true` fires `agent_start` synchronously/immediately (the linchpin
  making the `pendingContinuation` latch reliable). Confirmed once by the Task 1
  probe; re-confirm under a real supervised run.
- Real `@earendil-works/pi-coding-agent` `ExtensionAPI` shape (`pi.on`,
  `sendUserMessage`, `ctx`) — the extension relies on Node TS type-stripping plus
  the Task 1 findings, not a compiled type check.
- A `status:"blocked"` handoff followed by Ctrl-D no longer throws (fixed on this
  branch via `canTransition` guards) — worth including in the Task 8 script.
- Pi loading a `.ts` extension from an ABSOLUTE path outside the worktree, whose
  body `import`s relative `.js` modules (`../../src/workflow/*.js`): confirm the
  relative imports resolve at runtime when `--extension /abs/path/...ts` is passed
  and the worker's cwd is the ticket worktree. If they don't, the extension needs
  a different packaging (bundling, or absolute import resolution).
