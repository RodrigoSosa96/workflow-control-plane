# External Worker Origin Session Design

**Date:** 2026-07-29  
**Status:** Approved

## Decision

External workflow workers launched from a Pi coordinator will persist the exact Pi session that launched them. Terminal worker events will be delivered only to that origin session.

The existing manual CLI capability remains supported:

```bash
workflow launch <project> <ticket> --prompt-file <path> --origin-session <session-id>
```

A new Pi-owned launch path will set that origin automatically. Launches without an origin remain supported for backward compatibility but are intentionally unclaimed: any active coordinator watcher may display them as generic worker notices.

## Goals

- Eliminate cross-session worker-completion messages for Pi-originated launches.
- Never rely on the model remembering to add a shell argument.
- Preserve existing preview, approval-digest, explicit confirmation, and run-store authority.
- Retain the manual CLI flag for non-Pi launchers and documented automation.
- Keep terminal-event delivery informational; Pi must still read the canonical result before acting on it.

## Non-goals

- Inferring an origin from terminal state, process IDs, environment variables, or a session label.
- Falling back to a globally exported `WORKFLOW_ORIGIN_SESSION` value.
- Automatically accepting, summarizing, or applying the worker handoff.
- Delivering historical events when a coordinator session opens.
- Changing behavior for legacy launches without an origin session.

## Architecture

```text
Pi coordinator session
  |
  | workflow_prepare_launch (binds ctx.sessionManager session ID)
  v
approved launch preview (in-memory, origin bound)
  |
  | workflow_execute_launch (second confirmation)
  v
Workflow launch service / run store
  | persists originSessionId + originHarness=pi
  v
external worker lifecycle/handoff
  | writes terminal event with persisted origin session
  v
workflow event bus
  |
  v
Pi worker watcher (same session only)
```

### Pi tools

The coordinator extension adds two narrow tools:

- `workflow_prepare_launch`: accepts the existing launch inputs except `originSession`. It obtains the current Pi session ID internally and requests the standard dry-run preview from the control-plane launch service.
- `workflow_execute_launch`: accepts only an approved in-memory digest. It renders the frozen preview, requires a second UI confirmation, and executes the approved launch using the same origin identity.

The tools do not expose arbitrary command execution, state-root overrides, custom origin IDs, or direct launch mutation. The approved preview remains session-local and is discarded after execution or session shutdown.

### Origin validation and persistence

The Pi adapter supplies this structured origin object:

```json
{ "harness": "pi", "sessionId": "<ctx session id>" }
```

Existing launch code persists it as `run.originSessionId` and `run.originHarness`. It remains excluded from the approval digest only as volatile caller context; the Pi tool binds it inside its in-memory approved request, so a caller cannot substitute another session between preview and execution.

The CLI continues parsing `--origin-session <id>` and persisting it as `run.originSessionId`. It does not claim to validate that a manually supplied ID represents a live Pi session, and it retains `originHarness: null` for that form.

### Event delivery

The handoff/lifecycle notifier derives every event's origin from the authoritative persisted run record. The coordinator worker watcher only delivers an event when:

- its `originSessionId` exactly equals the current coordinator session ID; or
- the event has no origin session (legacy/unclaimed compatibility path).

Events for a different non-empty origin are ignored. Watchers initialize at the end of `events.jsonl`, so only events written after their session starts are eligible. Run-ID deduplication remains in place.

The Pi follow-up continues to be a bounded readiness notice and contains the canonical `workflow result <run-id>` command. It never contains a full handoff result and never executes that command by itself.

## Error Handling

- Missing, malformed, or unavailable Pi session IDs fail the prepare tool before it creates a preview or run.
- A stale, missing, reused, or cross-session execution digest fails closed without launch mutation.
- A user declining either confirmation discards the approved in-memory launch.
- Runtime/event-bus read failures remain best effort and cannot alter the authoritative run state.
- A manually supplied CLI origin remains caller-owned metadata; it does not weaken run/handoff validation.

## Verification Strategy

Unit and extension tests must prove:

1. the existing CLI accepts and persists a manual `--origin-session` value;
2. Pi prepare binds the active `ctx.sessionManager` ID and exposes no caller-controlled origin field;
3. Pi execute requires the exact approved request and performs no mutation after rejection/cancellation;
4. a Pi-originated run persists `{ originSessionId, originHarness: "pi" }`;
5. the watcher delivers only same-origin events and skips other-session events;
6. unclaimed legacy events retain their compatibility notice behavior;
7. no historical events are delivered at coordinator startup;
8. the full test suite stays green.

## Acceptance Criteria

- A worker launched through Pi's workflow launch tools notifies only the Pi coordinator session that launched it.
- A manual CLI caller can still provide `--origin-session` explicitly.
- No user/model-supplied argument can replace the Pi tool's actual coordinator session identity.
- The notification remains passive and points to the canonical result command.
- Existing runs without an origin keep working without cross-session isolation guarantees.
