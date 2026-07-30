# Provable Owner Recovery — Deferred Findings Triage

**Date:** 2026-07-30
**Source:** final whole-branch review of roadmap item 1.1 (`hardening/fase-1-ownership`, commits `c7d1067..a56b883`).
**Why this file exists:** the plan was executed subagent-driven, and each of the six per-task reviews deliberately deferred its Minor findings rather than widening a fix round. The final review triaged every one of them. That triage lived only in the plan's scratch ledger, which is git-ignored and deleted at merge — so the rulings are recorded here instead.

Related: [`2026-07-30-provable-owner-recovery-design.md`](../specs/2026-07-30-provable-owner-recovery-design.md) (spec), [`2026-07-30-provable-owner-recovery.md`](../plans/2026-07-30-provable-owner-recovery.md) (plan), [`ROADMAP.md`](../../../ROADMAP.md) (item 1.1, and the 1.1b follow-up).

## Won't fix

| Finding | Ruling |
|---|---|
| `ownership.js` `markerField` treats `pid: ""` / `startedAt: ""` as present, not absent | Unreachable from every writer, and fails closed in both directions anyway: `assertPid("")` throws in the inspector, yielding `OBSERVATION_FAILED` → `unprovable`. |
| `acquireLock` does not validate `runId` | The marker's `runId` is informational and never used in classification. Revisit if item 1.5 (run-record versioning) touches marker shapes. |
| Over-broad `/lock/i` matcher in a run-store rejection test | In that test's context the only reachable rejection is the contention error, so the matcher cannot pass for the wrong reason. |
| `inspectGate` no-mutation test uses hand-written residue rather than a live concurrent holder | The mode-and-bytes survival assertions already cover the mutation class; on-disk state is identical either way. |
| `unlock` / `gate-clear` have no `format.js` compact case (fall back to pretty-printed JSON) | Matches the existing precedent for `handoff`, `delegation-handoff`, and `delegation-release`. Revisit in Fase 2's operator-surface work, not here. |
| tmpfs under WSL2 reuses a freed inode immediately, weakening `dev`/`ino` identity comparison | Pre-existing and shared with `releaseLock`; raw marker-byte equality is a second factor; production state roots are not on tmpfs; CI is insulated because the identity tests use a fabricated-`ino` fs wrapper rather than real filesystem behavior. Document it when item 1.4 absorbs `sameOwnerDirectory`. |
| `buildReport`'s no-target/success label ternary written in both report builders | Cosmetic. Fold into item 1.4 only if the shared flow gains a third caller. |
| Same-uid sibling can read another process's `/proc/<pid>/environ` | Correctly deferred to item 4.1 (OS sandboxing). No filesystem secret can defend against it, and nothing in this branch worsens it. |

## Fix later

| Finding | When |
|---|---|
| `removeLock`'s refusal reason conflates "no lock" with "unreadable marker"; `clearGate`'s conflates four states | One message pass alongside item 1.4. Fail-closed today, so cosmetic. |
| A legacy fixed-file `run.lock` reads as "no lock" in `unlock`/`reconcile` while `update` throws the legacy error | Next run-store touch: map the container `ENOTDIR` to a legacy report. Safe today, but the two diagnostics contradict each other. |
| Every `fail(...)` in `delegation-reservations.js` omits `details`, so the thrown error carries no gate path | Next reservations touch. Matters most on the post-unlink `rmdir` failure, where the operator gets a code with no project context. |
| `clearGate` / `removeLock` doc comments claim they only throw after `rmdir` begins — untrue (`EACCES` on the unlink or a stat throws earlier) | Trivial comment correction; ride any next commit to those files. |
| The `workflow-delegation-services.test.js` concurrency test flaked once under full-suite load | Standalone test hardening. Verified to share no code path with this branch (it uses the default null reader and issues no `ps` calls), so its risk is unchanged. |
| The registry is loaded and parsed twice per live invocation | Pre-existing pattern (`loadDelegationContext` does the same). Plumbing cleanup candidate. |
| No on-disk test that an *unconfirmed* `gate-clear` leaves the gate untouched | Cheap. Flow-level proof of no mutation already exists; only the disk-level assertion is missing. |
| `workflow delegation release` mutates shared capacity on `--yes` alone, with no approval digest | If digest grammar is extended to more commands, `release` should get it first: note the asymmetry now runs the other way — `unlock` and `gate-clear` are also `--yes`-only, but they are additionally gated by proof of death, which `release` is not. |

## Resolved during the plan

| Finding | How |
|---|---|
| `sameGateDirectory` duplicated `sameActiveDirectory` byte-for-byte across two modules | Moved to `ownership.js` as `sameOwnerDirectory`, imported by both stores under their original local names; verified a verbatim move with both stores' test files untouched. |
| A third hand-written plain-object guard in `commands.js` | `isPlainMarker` exported from `ownership.js` and reused. |

## Promoted rather than deferred

Two findings a per-task review rated Minor were promoted into a fix round, because cross-task context showed they were functional rather than cosmetic:

- **`inspectLock` picked an arbitrary `readdir` entry** with no `owner-*.json` filter. A stray file (`.DS_Store`, an editor temp) in a real state directory would have made a wedged lock permanently unrecoverable by the very command this plan adds.
- **Both removal paths unlinked the marker before knowing `rmdir` would succeed.** A directory holding the marker plus any stray entry ended up wedged *and* markerless — destroying the ownership evidence the plan exists to produce. Fixed in `removeLock` and `clearGate` together, since the next two tasks built their commands on both.

## Still open, with a design decision attached

**Item 1.1b** (recorded in `ROADMAP.md`): locks acquired by lifecycle hooks and Pi worker extensions carry no ownership evidence, because each of those processes builds its own run store without the reader. Same defect class as the Critical the final review found in `launchCommand`, but fixing it means spawning `ps` inside a fire-and-forget hook that runs on every prompt and stop — the exact critical-section cost a task review had already moved that read away from. The roadmap entry weighs three options; inheriting `{pid, startedAt}` through the env `runEnv` already injects is the most promising, and costs no spawn.
