# Pi Recovery Lane — Design

> Sub-project #2 of the "finish the workflow with Pi" roadmap. Makes `workflow
> resume` and `workflow close` actually operate against a real interactive Pi
> worker. Builds directly on sub-project #1 (Pi interactive lifecycle, merged),
> which shipped `resume.js`/`close.js` wired to the CLI but non-functional against
> real runs. The follow-ups that motivate this are in
> `docs/superpowers/plans/2026-07-25-pi-interactive-lifecycle-followups.md`.

## Goal

After an interactive `workflow launch`, the run records the exact Pi session
identity, and:

- `workflow resume <run-id>` reconnects to a live session (focus its pane) or, for
  a dead session, reports what it would relaunch and relaunches only on explicit
  confirmation.
- `workflow close <run-id>` gracefully exits an idle Pi session and reports success
  only when the exit was actually requested — never killing a working or
  unconfirmed process.

## Why it does not work today (from the sub-project #1 whole-branch review)

1. **No `transportIdentity` is persisted on a run**, so `resume`/`close` always
   return `no-identity`/`refuse`.
2. **The CLI wires the delegation transport** (`createPiDelegationTransport`,
   identity `kind: "pi-delegation"`), which inspects a directly-spawned child
   process by pid. An interactive worker is a top-level Pi *session* launched by
   Herdr (`agent start --kind pi`) in a pane — the control plane never holds its
   pid. It needs a **session** transport.
3. **`resume.js` only plans** (`planResume` returns focus/relaunch/refuse); there
   is no execute step.
4. **`close.js` hardcodes `{ closed: true }`** on idle and discards the transport
   result; `requestGracefulClose` is a manual-only stub.

## Decisions (from brainstorming)

- **Graceful close** = validate idle via `agent list`, then `herdr agent send-keys`
  the exit (Ctrl-D). Never kill a working process; never `pane close`.
- **Resume of a dead session** = report the plan and relaunch **only on explicit
  confirmation** (`--yes`), never automatically.

## Herdr facts this rests on (verified against Herdr 0.7.5)

- `herdr agent list` returns each agent with `agent_session.value` (the native Pi
  session id), `pane_id`, `tab_id`, `agent_status` (`working`/`idle`), `cwd`,
  `foreground_cwd`.
- `herdr agent send-keys` sends key presses to an agent.
- `herdr pane focus` brings a pane to the foreground.
- `herdr pane process-info` gives a pane's process info (optional robustness).

## Architecture

Five pieces. Only the CLI wiring and the launch touch existing files; the transport
is new and isolated.

```
   workflow launch (interactive)
     └─ execute.js: after agent start, persist run.transportIdentity =
        { kind: "pi-session", runId, sessionId, paneId, tabId, workspaceId, cwd }

   workflow resume <run-id> [--yes]        workflow close <run-id>
     └─ commands.js picks the transport      └─ commands.js picks the transport
        by identity.kind === "pi-session"       by identity.kind === "pi-session"
     └─ resume.js: planResume → focus|relaunch|refuse
        executeResume: focus → herdr pane focus
                       relaunch → (only with --yes) pi --session-id <exact> + exts
     └─ close.js: closeWorker honors requestGracefulClose result

   pi-session-transport.js (new; implements the worker-transport contract via Herdr)
     observeExact(identity) → herdr agent list, match session/pane/cwd →
        active | idle | missing | mismatch | unknown
     requestGracefulClose(identity) → if idle, herdr agent send-keys <exit> →
        { requested: true }; else { requested: false }
```

### Units and responsibilities

1. **Identity capture (`src/workflow/execute.js`, small change).** After a
   successful interactive `agent start`, assemble the `pi-session` identity from
   the started agent (paneId/tabId/workspaceId) plus the run's native `sessionId`
   and `cwd`, and persist it on the run record as `transportIdentity`. Only for
   interactive runs (the supervisor/stream-json path keeps the delegation identity
   it already uses, if any).

2. **`src/workflow/pi-session-transport.js` (new).** Implements the
   `worker-transport` contract (`start`, `observeExact`, `deliverFollowUp`,
   `requestGracefulClose`) over a Herdr adapter, for identities of
   `kind: "pi-session"`:
   - `observeExact({ sessionId, paneId, cwd, … })`: read `herdr agent list`; find
     the agent whose `agent_session.value === sessionId` and `pane_id === paneId`.
     Absent → `missing`. Present with a different `cwd`/session → `mismatch`.
     Present and `agent_status === "idle"` → `idle`; `working` → `active`. Any
     Herdr error → `unknown`. Never reads terminal text.
   - `requestGracefulClose(identity)`: `observeExact`; only if `idle`, send the
     exit keys via `herdr agent send-keys`, return `{ requested: true }`;
     otherwise `{ requested: false }` (working/unknown/missing/mismatch).
   - `deliverFollowUp` / `start`: relaunch a dead session by `agent start` on a
     fresh pane with `pi --session-id <exact>` + extensions (used by resume's
     relaunch path). Follows the same argv/extension wiring sub-project #1 built.

3. **`src/workflow/resume.js` (extend).** Keep `planResume`. Add
   `executeResume({ store, transport, herdr, runId, confirmed })`:
   `focus` → `herdr pane focus <paneId>` and return `{ action: "focused" }`;
   `relaunch` → if `confirmed`, relaunch and return `{ action: "relaunched",
   identity }`, else return `{ action: "needs-confirmation", plan: "relaunch" }`;
   `refuse` → throw.

4. **`src/workflow/close.js` (fix).** `closeWorker` returns
   `{ closed: result.requested === true, reason }` from `requestGracefulClose`,
   instead of hardcoding `closed: true`. Idle-but-not-requested (e.g. send-keys
   failed) → `{ closed: false, reason: "close-not-confirmed" }`.

5. **CLI wiring (`src/workflow/commands.js`, `bin/workflow.js`).** `resumeCommand`
   / `closeCommand` build the `pi-session-transport` (not the delegation transport)
   when `run.transportIdentity.kind === "pi-session"`. `resume` accepts `--yes` to
   confirm a relaunch; without it, a dead session reports the relaunch plan and
   exits without relaunching. `focus` is immediate (read-until-confirmed style; it
   only brings a pane forward). `close` needs no `--yes` (it only ever sends a
   graceful idle exit).

## Data flow

```
Live session:
  workflow resume r1        → planResume: observeExact → idle/active → focus
                            → executeResume: herdr pane focus <pane> → "focused"

Dead session:
  workflow resume r1        → planResume: observeExact → missing → relaunch
                            → executeResume (no --yes): "needs-confirmation" (prints plan)
  workflow resume r1 --yes  → executeResume: relaunch pi --session-id <exact> + exts

Close:
  workflow close r1         → observeExact → idle → send-keys exit → { closed: true }
                            → observeExact → active → { closed: false, reason: "working" }
                            → observeExact → missing/mismatch/unknown → { closed: false,
                                                             reason: "identity-unconfirmed" }
```

## Testing

TDD per unit with a fake Herdr adapter (no real Pi, no model):

- **`pi-session-transport`** — `observeExact` maps every `agent list` shape to the
  right state (idle/active/missing/mismatch/unknown); `requestGracefulClose` sends
  keys only when idle and returns `requested` accordingly; never emits
  terminal-derived detail keys.
- **identity capture** — after a fake interactive `agent start`, the run persists a
  well-formed `pi-session` `transportIdentity`; the supervisor path is unaffected.
- **`resume.js`** — `executeResume` focuses a live session, gates relaunch on
  `confirmed`, refuses on `refuse`.
- **`close.js`** — honors `requested`; idle-but-not-requested → not closed.
- **CLI** — resume/close pick the session transport for a `pi-session` identity;
  `resume --yes` relaunches, without it a dead session only reports.

**Manual verification (tipo Task 8, human/TTY), documented as a guided procedure**
— three runtime unknowns the unit tests cannot cover:
1. `herdr agent send-keys` with the exit key actually makes an idle Pi exit
   gracefully (may need a specific key or `/exit`; confirm the exact sequence).
2. `pi --session-id <exact>` relaunches and resumes the native Pi session (with the
   workflow extensions reloaded).
3. The exact Herdr command that brings a live session's pane to the foreground.
   `herdr pane focus` is documented as "focus a *neighboring* pane", which may not
   be focus-by-id; the probe confirms whether pane/tab/workspace activation by id
   exists, and `focus` degrades to a no-op-with-report if it does not (the run is
   still live; the operator can navigate to it).

## Implementation methodology (empirical order)

1. **Probe first (manual):** confirm the exact `send-keys` exit sequence and that
   `pi --session-id` resumes, against real Herdr/Pi. These gate the transport's
   close and relaunch details.
2. `pi-session-transport` (TDD) with the probed facts.
3. Identity capture in `execute.js` (TDD).
4. `resume` execute + `close` fix (TDD).
5. CLI wiring (TDD).
6. Manual end-to-end: launch → kill pane → `resume` reports → `resume --yes`
   relaunches → `close` on idle.

## Risks and open items

- **`send-keys` exit sequence (highest).** Ctrl-D may not cleanly exit Pi in all
  states; the probe (step 1) settles the exact keys, and `requestGracefulClose`
  stays fail-safe (only when idle, report `requested` truthfully).
- **`pi --session-id` resume fidelity.** Must resume the exact native session, not
  start a fresh one; confirm in the probe.
- **Identity staleness.** A pane can be reused by another agent; `observeExact`
  guards with session id + pane id + cwd, returning `mismatch` rather than acting
  on the wrong session.
- **`agent_status` granularity.** `idle` vs `working` drives close/observe; confirm
  Herdr reports it promptly after a turn ends.

## Non-goals

- Claude/Codex recovery (their own later sub-project).
- Changing the delegation transport (it stays for the delegation lane).
- The interactive launch report under-reporting tab/pane (separate cosmetic
  follow-up; may be fixed opportunistically during identity capture since that code
  is adjacent).
