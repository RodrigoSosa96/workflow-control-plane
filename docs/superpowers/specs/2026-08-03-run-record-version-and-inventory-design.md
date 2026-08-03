# Run Record Version Check and Field Inventory Design

**Date:** 2026-08-03
**Status:** Proposed
**Roadmap item:** 1.5, the last of Fase 1. Closes the remaining half of review finding D18.

## Problem

`run.json` carries `version: 1`. Nothing has ever read it.

`initialRun` (`src/workflow/run-store.js:801`) stamps it, and both `initialRun` and `updatedRun` strip a caller-supplied `version` from their input (`:788`, `:817`), so it cannot be forged and never changes after creation. But `readRunInternal` → `parseRunJson` validates shape without ever consulting it. The field is write-only, exactly as D18 says.

That matters for one concrete scenario, and it is not hypothetical for this repo. `INSTALL.md` documents a global install, and the launcher runs workers out of git worktrees — so a developer can easily have a globally-installed control plane and a worktree checkout pointed at the same `state_root`. The moment those two are at different versions, the older one reads records the newer one wrote and **silently misinterprets them**. A version field exists to make that loud. This one cannot.

### The second half is the one that decays

D18's other complaint: "cada lane agrega markers ad hoc". That is measurably true. A real run record carries 45 keys today, and this session alone added three more — `agentProfile` (item 1.3), `piStartedOnce` and `piPendingContinuation` (item 1.2) — each written by a different module, none of them written down anywhere. Answering "what does a run record contain, and who writes each field?" today means reading `runInput`, `initialRun`, the lifecycle hook core, `resume.js`, the telemetry store and the delegation store.

A prose inventory would answer that question once and then rot, because nothing would stop the next lane from adding a marker without touching it — which is precisely the mechanism that produced the problem.

## Decision

Four choices, each with the evidence behind it.

### 1. Fail closed on an unsupported version, and do not invent a migrator

`registry.js:565-568` is the stated precedent and it is an explicit per-version dispatch: v1 refused by name, v2 migrated, v3 validated, anything else refused with a message naming what was received. The run store gets the same shape and the same honesty.

It does **not** get a migration framework. There is exactly one version and nothing to migrate; building a migrator with no migrations is scaffolding that would have to be redesigned when a real v2 arrives with real constraints. The seam is named in one place so the next person knows where it goes.

### 2. An absent version is refused, not defaulted to 1

`initialRun` always stamps it, so a record without one is corrupt, hand-edited, or foreign. Verified against the real state root: all 8 existing runs carry `version: 1`, so refusing costs nothing today and stays honest later.

This is the same disposition the store already takes for a malformed record — it refuses rather than guessing.

### 3. `read()` refuses; `list()` skips with a warning

This mirrors the strictness split item 0.3 established and must not be flattened. `read()` and `update()` stay strict, because acting on a record you cannot interpret is the dangerous case. `list()` already skips unreadable entries with a bounded warning, so that one future-version record does not brick the cross-project board that item 2.1 will build on top of it.

### 4. The inventory is executable, not prose

The doc lists every field, grouped by the module that writes it. A test then checks the doc against reality, so a new field added without documenting it fails the suite.

That check is the entire value of this half. Without it the inventory is a snapshot that is wrong by the third item that touches the record; with it, "document your field" becomes a thing the suite asks for rather than a thing a reviewer has to remember. Given that D18's complaint is literally about fields accumulating unannounced, an unchecked document would close the ticket without closing the problem.

The check cannot be perfect — a field written only on a rarely-exercised lane may not appear in any record the test builds. So it is scoped honestly: it pins the fields the store itself produces and the fields the suite's own representative runs carry, and the doc marks anything else with its writer. An imperfect check that fails on the common case beats a perfect document nobody updates.

## Goals

- A run record written by a newer control plane is refused with a message naming both versions, not silently misread.
- The refusal cannot brick a listing.
- One place answers "what does a run record contain and who writes each field", and it cannot silently go stale.
- No migration scaffolding that has nothing to migrate.

## Non-goals

- Writing version 2, or changing any field's shape or meaning.
- Versioning the event records (`run-store.js:914` stamps its own `version: 1`); they have the same latent issue and deserve the same treatment, but bundling them here doubles the surface for no added safety today. Record it as the natural follow-up.
- Migrating or backfilling existing records — all 8 are already version 1.
- Changing `list()`'s skip behaviour beyond making a future-version record one of the things it skips.

## Architecture

```text
read(runId) ──> readRunInternal ──> parseRunJson ──> assertSupportedRunVersion
                                                          │
                                    version === 1 ────────┼──> the record
                                    anything else ────────┴──> refuse, naming
                                                               both versions
list() ──> per entry ──> same check ──> on refusal: onListProblem, skip, continue
```

`SUPPORTED_RUN_VERSION` is one exported constant. The refusal message names the record's version, the supported version, and what an operator should do — the same courtesy `registry.js` extends.

The inventory lives in `docs/` as a table: field, writer, when it appears, what it means. The test reads that document and compares it against the key set of run records the suite produces.

## Error Handling

- A record whose `version` is absent, non-integer, or unsupported is refused by `read()`/`update()` through the store's existing failure channel, so every caller's error handling keeps working unchanged.
- `list()` routes the same refusal through `onListProblem` and continues, exactly as it already does for an unreadable record.
- The version check runs **after** JSON parsing and before shape validation: a record that does not parse is already handled, and a record from the future should be refused on its version rather than on whatever shape mismatch its new fields happen to trigger — the second message would send an operator chasing the wrong thing.

## Verification Strategy

1. `read()` accepts `version: 1`.
2. `read()` refuses version 2, and the message names both the found and the supported version.
3. `read()` refuses an absent version, a non-integer version, and version 0.
4. `update()` refuses the same, so a future record cannot be mutated by an older control plane.
5. `list()` skips a future-version record with a bounded warning and still returns the others — one bad record does not brick the board.
6. The version is still stripped from create and update input, so it cannot be forged or changed.
7. The inventory documents every key a representative run record carries, proven by a test that fails when a field is added without documenting it.
8. That test is load-bearing: adding an undocumented field to the record fails it.
9. Existing run-store tests pass untouched.
10. `npm test` and `npm run test:ci-like` green, zero skips.

## Acceptance Criteria

- Two control planes at different versions sharing a state root produce a named refusal instead of a silent misread.
- A single future-version record cannot make `workflow status`-style listings unusable.
- One document answers what a run record contains and who writes each field, and the suite fails if it falls behind.
- No migrator exists until there is something to migrate, and the place it will go is written down.
