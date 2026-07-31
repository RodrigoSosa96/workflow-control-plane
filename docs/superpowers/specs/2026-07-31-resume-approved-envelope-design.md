# Resume Runs the Approved Security Envelope Design

**Date:** 2026-07-31
**Status:** Proposed
**Roadmap item:** 1.3. Closes review finding D6 ([`../reviews/2026-07-29-multi-agent-deep-review.md`](../reviews/2026-07-29-multi-agent-deep-review.md)).

## Problem

`workflow launch` builds its argv through `buildHarnessLaunch` (`src/workflow/harnesses.js:197`), which is where the registry profile's security fields become command-line flags. That argv enters the approval digest and is persisted verbatim as `run.launchArgv`.

`workflow resume` does not use it. `relaunchSession` (`src/workflow/commands.js:1389-1496`) hand-assembles a second argv per harness, and the two have diverged. Measured against the profiles committed in `projects.yaml` today:

| Harness | `buildHarnessLaunch` emits | `relaunchSession` emits | Divergence |
|---|---|---|---|
| claude | `--permission-mode manual` | *nothing* | approved permission mode dropped; Claude's own default applies |
| codex | `--sandbox workspace-write`, `--ask-for-approval on-request` | `-a never`, no `--sandbox` | **approval policy replaced with a more permissive one**; sandbox dropped |
| pi | `--model`, `profile.arguments` | *nothing* | latent only — both are empty in the committed profiles |

The codex row is the sharp one and it is not a matter of interpretation: `on-request` prompts before acting, `never` does not. A resumed Codex worker auto-approves everything the approved profile would have asked about. That happens on the recovery path — the one an operator reaches for when something already went wrong, and the one nobody re-reviews.

The claude row is a divergence in the other direction (omitting `--permission-mode` yields Claude's default, not a broader one), but the property that matters is the same: **the argv that runs is not the argv the digest approved**, and nothing in the system notices.

The pi row is the one that shows this is structural rather than a list of three oversights. Nothing is wrong with Pi's resume today only because `model` is `null` and `arguments` is `[]` in the committed profile. Set either, and resume silently drops it. Two builders for one concept will keep diverging as long as there are two.

`relaunchSession`'s own comments already record the gap ("No `--permission-mode`/`--model` either — those live on the registry profile, which the transportIdentity does not carry (known follow-up)", `:1451-1452`; the codex equivalent at `:1462-1464`). This item is that follow-up.

### Why the profile is not available at resume time

`transportIdentity` carries the session identity, not the launch configuration. The run record persists `profileName` and `harness` but not the resolved profile, so `relaunchSession` has the name of the envelope and not its contents. Re-resolving from the registry by name would run whatever `projects.yaml` says *now* — which is not necessarily what was approved then, and is the same defect wearing a different hat.

## Decision

Three changes, and the third is what keeps the first two from decaying.

1. **Persist the resolved profile in the run record at launch.** One field, the whole profile object, so no later reader has to decide which fields matter.
2. **Add a resume variant to `buildHarnessLaunch`** and have `relaunchSession` use it instead of assembling argv by hand.
3. **Give each harness one function that turns a profile into flags**, used by both the launch builder and the resume builder — so a future flag can only be added in a place both paths read.

### Persist the whole profile, not the named subset

The roadmap names four fields (`permission_mode`, `sandbox`, `approval_policy`, `model`). Persisting exactly those would leave `arguments` and `mode` out, so the resume argv still could not be reproduced and every future field would restart the "does this one matter?" conversation.

That conversation is the failure mode this repo has already paid for twice: four copies of the `ps` argv (closed in 1.1b and 1.1c) and four copies of the delegation invariants (closed in 1.4). A subset is a fifth copy waiting to happen. The whole resolved profile goes in one field, `agentProfile`.

### One flag emitter per harness

Today `claudeArgv`, `codexArgv` and `piArgv` (`harnesses.js:132-186`) each know how to turn a profile into flags, and `relaunchSession` knows a second, incomplete version of the same thing. After this change, the per-harness knowledge lives in one place and both builders call it. "Flags" here means everything the profile contributes — permission mode, sandbox, approval policy, model, profile arguments, `--add-dir`, the interactive-only wiring — not only the fields that carry security weight, because the split between "security" and "the rest" is itself a judgment call nobody should have to re-make per flag. `buildHarnessResume` differs from `buildHarnessLaunch` only where the harnesses genuinely differ:

- **pi** resumes through the same `--session-id` flag it launches with; the resume argv is the launch argv without the bootstrap prompt.
- **claude** resumes with `--resume <id>`, where launch uses `--session-id <id>` (`--session-id` *creates* and errors if the session exists — the opposite of Pi).
- **codex** resumes through a `resume <id>` subcommand, which must be argv positions 1-2, not a flag.

Everything else — permission mode, sandbox, approval policy, model, profile arguments, `--add-dir`, the interactive-only wiring — is shared.

### Fail closed for runs that predate the field

The seven runs that already exist in the state root have no `agentProfile`. When `resume` would relaunch such a run, it refuses with an actionable message rather than falling back to today's argv.

Falling back would mean knowingly running the escalated envelope this item exists to remove, and a warning nobody reads is not a control. Refusing is honest: the run's approved envelope cannot be reproduced, so the correct action is a fresh, freshly-approved launch.

The refusal is scoped to the relaunch path only. A run whose session is still alive resumes by focusing its pane and builds no argv at all — those keep working regardless of `agentProfile`. The check therefore belongs in `planResume` (`src/workflow/resume.js:32-46`), on the branch that returns `action: "relaunch"`, so the operator sees the refusal in the read-only preview instead of after Herdr has already created a tab.

### `run.json`'s `version` is not touched

`agentProfile` is additive and optional; a run that lacks it is exactly the case the refusal above handles. Bumping `version` to 2 with no reader that checks it buys nothing, and item 1.5 will design that check whole (fail-closed or migrate, as the registry already does v2→v3). Left alone deliberately.

## Goals

- A resumed worker runs under the same permission mode, sandbox, approval policy, model and profile arguments the approval digest covered.
- The security flags for each harness have exactly one definition, shared by launch and resume.
- A run whose approved envelope cannot be reproduced is refused, visibly, before anything is mutated.
- `CLAUDE_WORKER_SETTINGS_FILE` has one definition (today: `launch.js:11` and `commands.js:1378`).

## Non-goals

- Changing what any profile *means*, or any value in `projects.yaml`.
- Giving `resume` an approval digest or a `--dry-run` argv preview. Resume stays a confirmed mutation with its existing `--yes` gate; extending the digest grammar to recovery is its own item.
- Item 1.5's `run.json` version checking.
- Item 1.2's lifecycle unification, or the generation-arithmetic divergence D5 describes.
- Migrating or backfilling existing run records.

## Architecture

```text
launch:  registry profile ──> buildHarnessLaunch ──> argv ──> approval digest
                │                     │
                │                     └─> harnessFlags(profile)  ← one per harness
                │
                └─────────────────────────> run.agentProfile  (persisted, whole)

resume:  run.agentProfile ──> buildHarnessResume ──> argv
                                      │
                                      └─> harnessFlags(profile)  ← the same one

         run without agentProfile ──> planResume ──> action: "refuse"
```

`buildHarnessResume` takes the persisted profile and the session identity and returns the same `{argv, env}` shape `buildHarnessLaunch` returns, minus `expected` (which describes a launch's approval surface and has no resume analogue).

`relaunchSession` keeps everything it owns that is not argv construction: the Herdr choreography (`createTab` → `splitPane({env})` → `startAgent` → `focusAgent`), the shortened session name, and the Claude settings-file regeneration. Only the three hand-built argv arrays go away.

## Error Handling

- A run reaching the relaunch path without `agentProfile` refuses with a named reason and a next action, through the same `refuse` channel `planResume` already uses for unprovable observations. No partial Herdr state is created.
- A persisted `agentProfile` that fails `assertProfile` refuses the same way rather than being silently repaired: a malformed envelope is not a reproducible one.

**Correction (recorded during the final-review fix):** `assertProfile` was picked as the reproducibility predicate above without checking that it covers what the argv builders actually require. It does not: `assertProfile` (`src/workflow/harnesses.js`) validates only `harness`, `command`, and `arguments`, while `buildHarnessResume` demands strictly more — `profileName`, `cwd`, the harness's security field (`permission_mode` for claude, `sandbox`/`approval_policy` for codex), and, for an interactive claude resume, `settingsPath`. A profile that clears the `assertProfile` gate in `planResume` can still throw inside `buildHarnessResume`, and before this fix that throw landed *after* `relaunchSession` had already called `herdr.createTab`/`herdr.splitPane`, leaving an orphan tab and pane behind it. The final review found this gap by probing four such profile shapes against the real builder; none is reachable for a run this code itself creates (`previewLaunchSpec` would already have thrown at launch time on the same missing field, `runInput` always sets `profileName`, and `execute.js` always writes `cwd` into the identity), so it is hardening rather than a live bug. Fixed by moving the `buildHarnessResume` call (and the `settingsPath` computation it depends on) ahead of every Herdr call in `relaunchSession`, so a builder-level failure now creates no Herdr state either — structurally, not merely because `assertProfile` happens to cover what the builder needs — with a regression test asserting a recording Herdr stub sees zero calls.
- Persisting the profile at launch must not become a new way for launch to fail. It is one more field on a record launch already writes; if the profile were unserializable the launch itself could not have built an argv from it.

## Verification Strategy

1. The run record written at launch carries `agentProfile` equal to the resolved profile, for each of the three interactive harnesses.
2. `buildHarnessResume` emits the approved security flags per harness — asserted against the exact values in the committed profiles: `--permission-mode manual` for claude; `--sandbox workspace-write` and `--ask-for-approval on-request` for codex; `--model` and `profile.arguments` for pi when the profile sets them.
3. **The regression that started this item:** a resumed codex worker's argv contains `--ask-for-approval on-request` and never `-a never`. Assert the absence explicitly, not merely the presence of the correct flag.
4. Launch and resume emit byte-identical security flags for the same profile — one assertion per harness comparing the two builders' output, so a future flag added to one path and not the other fails a test.
5. A resume argv carries no bootstrap prompt, and uses each harness's resume form: `--resume` for claude, the `resume` subcommand at argv 1-2 for codex, `--session-id` for pi.
6. `planResume` returns `refuse` with a named reason for a run with no `agentProfile` whose session is missing, and creates no Herdr state.
7. The same run with a *live* session still returns `focus`, unaffected by the absent profile.
8. A malformed persisted `agentProfile` refuses rather than partially applying.
9. `CLAUDE_WORKER_SETTINGS_FILE` has one definition, proven by grep.
10. Existing resume behavior that is not argv construction is unchanged: the Herdr call sequence, the shortened session name, the Claude settings regeneration, and the returned identity all keep their current tests passing untouched.
11. `npm test` green.

## Acceptance Criteria

- Resuming a Codex worker runs it under `--ask-for-approval on-request` and `--sandbox workspace-write`, where today it runs under `-a never` with no sandbox flag.
- Resuming a Claude worker runs it under `--permission-mode manual`, where today the flag is absent.
- Setting `model` or `arguments` on any profile changes both the launch argv and the resume argv, proven by test rather than by reading both builders.
- A run that predates `agentProfile` cannot be silently resumed under an unapproved envelope; it is refused with a message that says why and what to do instead.
- No harness's security flags are written down in more than one place.
