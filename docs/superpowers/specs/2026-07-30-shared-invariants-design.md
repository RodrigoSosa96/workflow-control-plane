# Shared Invariants Design

**Date:** 2026-07-30
**Status:** Approved (2026-07-30)
**Roadmap item:** 1.4.

## Problem

The review that created this roadmap phase found finding **D17**: the same predicate hand-written four times across layers, with one copy measurably weaker than the others. Two instances were consolidated opportunistically during items 1.1 and 1.1b (`sameOwnerDirectory`, `isPlainMarker`, `psStatusArgv`). Four remain, verified present today:

| Invariant | Copies | Divergence |
|---|---|---|
| Reservation resources + match | `delegation-reservations.js` `resourceList`, `delegation-handoff.js` `expectedReservationResources`+`reservationMatches`, `coordinator-policy.js` `reservationResources`+`reservationAllows` | **Yes.** The coordinator copy omits the `checkout:<digest>` resource entirely and never compares the reservation's `checkoutDigest` against the delegation's cwd — it only checks that *some* `checkout:`-prefixed resource exists. It also does not compare `role`/`mode`, which the handoff copy does. |
| Transport identity shape | `delegation-store.js`, `delegation-services.js`, `delegation-handoff.js`, `pi-delegation-transport.js` | Yes, in strictness: the store enforces an exact key set; the handoff copy checks only `kind`/`runId`/`delegationId`. |
| Claim token digest comparison | `delegation-store.js` (5 sites), `delegation-handoff.js` (1) | No, but the same `digest(token) !== record.…Digest` rule is expressed in two modules. |
| Mutex removal choreography | `run-store.js` `removeLock` (89 lines), `delegation-reservations.js` `clearGate` (75 lines) | No, but it already required one synchronized fix across both files during item 1.1 (`dc55ba4`, preserving ownership evidence when a stray entry blocks the `rmdir`). |

## An honest scoping note

**This item is drift prevention and correctness by construction — it does not close a live hole.** That distinction was verified, not assumed:

The weaker reservation copy has two callers, and only one of them is actually unreached. `delegation-services.executeApproved` genuinely reaches `validateSubagentRequestPolicy` on every approved delegation launch — it is not a dead path — but the reservation it passes was *just created* by that same call with the authoritative `resourceList`, so the weak check is validating something already correct by construction. The other caller, the Pi coordinator extension's `tool_call` gate on the `subagent` tool, is the one that is genuinely unreached: its `getPreparedSubagentContext` is a no-op returning `undefined` by default, so `validateSubagentRequestPolicy` rejects at its first guard before the weak predicate itself ever runs.

So nothing here is exploitable today — not because the check goes unexercised, but because the one caller that does exercise it never hands it a reservation the strict version would have rejected. What is true is that three hand-written copies of one rule **have already drifted**, and the drift landed in the copy that guards a model-facing boundary. The next person to wire that context provider inherits a check weaker than the one the handoff path enforces, with nothing marking it as such. That is the risk this item removes.

The removal choreography carries a sharper version of the same argument: it is not merely duplicated, it has already demanded a synchronized two-file fix once, on the code path that decides whether a mutex may be removed.

## Decision

Two new modules, split by what they are about rather than by which files happen to use them:

- **`src/workflow/delegation-invariants.js`** — the delegation lane's authorization rules: reservation resources, reservation-matches, transport identity shape, claim token comparison. One definition each, imported by every layer that enforces them.
- **`src/workflow/mutex-removal.js`** — the safe-removal algorithm shared by `removeLock` and `clearGate`, parameterized by the store's inspect function, its noun ("lock"/"gate"), and its success shape. It imports `sameOwnerDirectory` from `ownership.js`; `ownership.js` keeps meaning "what an owner marker means", and this module means "how to remove one safely".

### The reservation predicate must get *stronger*, not merely shared

Consolidation here is a behavior change for `coordinator-policy.js`, and that is the point: it gains the `checkout:<digest>` resource requirement and the `checkoutDigest`-versus-cwd comparison it lacks. It must be its own task with tests proving a reservation for a *different* checkout is now refused where it previously passed — otherwise "we consolidated" hides "we quietly changed an authorization check".

### Transport identity: the strict shape wins

The four variants differ in strictness. The shared definition takes the strictest (the store's exact-key validation). Any call site that was looser becomes stricter, so each migration needs a test showing a previously-accepted malformed identity is now rejected. Where a caller genuinely needs a weaker check, that is a finding to report, not a reason to keep a second copy.

## Goals

- One definition per invariant, imported everywhere it is enforced.
- The layered defense-in-depth the two-lane spec calls for becomes *the same predicate evaluated at several points*, rather than several approximations of it.
- No call site's error message or control flow changes except where a predicate deliberately gets stricter, and every such change is proven by a test.

## Non-goals

- Changing the two-lane governance model, the reservation policy values, or what any command does.
- Consolidating `.pi/extensions/workflow-coordinator/index.ts`'s own store construction or its `ps` argv copy — that is the separate follow-up already recorded in `ROADMAP.md`'s "Pendientes conocidos".
- Merging `ownership.js` and the two new modules into one grab-bag.

## Known consequences

- **A cwd whose canonical form differs from its raw string (a symlink, a trailing slash) now fails at launch instead of at handoff.** The lease mints its `checkoutDigest` from `canonicalPath(cwd)` (`delegation-reservations.js`'s `reserve`). The coordinator gate, via `reservationMatchesDelegation`, derives its own comparison digest from the *raw* `prepared.cwd` (`delegation-services.js`'s `executeApproved`, through `createPreparedDelegationRequest`) — it has no canonicalizing step of its own to apply. Before this task, `coordinator-policy.js`'s weak predicate never compared `checkoutDigest` at all, so a delegation in this situation passed `executeApproved`'s gate, started a real worker process, and only failed once that worker called handoff (`delegation-handoff.js` has compared digests this way all along). Now the same mismatch is caught at `executeApproved`, before the worker is ever spawned. This is fail-earlier, not a new failure mode, and it is inherent to giving the launch-time gate the same predicate the handoff path already enforced — not something this task's code papers over.

## Error Handling

- Each shared predicate keeps the throwing-versus-returning-false convention of the layer that calls it: the store's validators throw `WorkflowError`, the policy gate returns a rejection object. The shared code exposes both a predicate and, where needed, an asserting wrapper — it must not force one convention on a caller that needs the other.
- `mutex-removal.js` preserves the exact refusal-versus-throw split both removers have today: a refusal returns `{removed:false, reason}` / `{cleared:false, reason}`; only post-commit filesystem anomalies throw.

## Verification Strategy

1. Exactly one definition of each of the four invariants remains; grep proves it.
2. The coordinator policy refuses a reservation whose `checkoutDigest` does not match the delegation's cwd — a case it previously accepted. This is the one deliberate behavior change and needs a test that fails against the old code.
3. Every transport-identity call site rejects a malformed identity that a looser copy previously accepted.
4. `removeLock` and `clearGate` behave identically to before at every branch: each existing refusal reason, the two identity re-verifications, the stray-entry guard, and the `ENOENT`-on-unlink refusal are all still reachable and still produce their current strings.
5. Both stores' existing test files pass **unmodified** — they are the regression net for the removal extraction.
6. The delegation lane's existing tests pass unmodified except where task 2's deliberate strengthening requires an update, and each such update is called out.
7. `npm test` green.

## Acceptance Criteria

- No invariant in the table has more than one definition.
- The reservation predicate that guards the model-facing gate is the same one the handoff path enforces, and a test proves it now catches the case it used to miss.
- The removal choreography exists once, so the next fix like `dc55ba4` lands in one place.
- No behavior changed anywhere except the two deliberate strengthenings, each with a test that fails against the old code.
