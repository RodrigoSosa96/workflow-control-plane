# Resume Approved Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `workflow resume` relaunch a worker under the same permission mode, sandbox, approval policy, model and profile arguments the approval digest covered — instead of a second, hand-assembled argv that has diverged from the first.

**Architecture:** The resolved harness profile is persisted in the run record at launch (`run.agentProfile`), the per-harness "profile → flags" knowledge is extracted so launch and resume share one emitter each, `buildHarnessResume` joins `buildHarnessLaunch` in `harnesses.js`, and `relaunchSession` stops building argv by hand. A run that predates the persisted profile is refused at `planResume` rather than relaunched under an envelope nobody approved.

**Design source:** [`../specs/2026-07-31-resume-approved-envelope-design.md`](../specs/2026-07-31-resume-approved-envelope-design.md) (Approved 2026-07-31). Read its Problem table before starting — the three harnesses diverge differently, and only one of the three is a privilege escalation.

**Tech Stack:** Node.js ESM, zero runtime dependencies, Node test runner, existing `harnesses.js` / `launch.js` / `commands.js` / `resume.js` seams.

## Global Constraints

- **The approved envelope, not the current registry.** Resume must reproduce what the digest covered. Never re-resolve the profile from `projects.yaml` at resume time — the registry can have changed since launch.
- **Refuse, do not degrade.** A run whose envelope cannot be reproduced is refused with a named reason. Falling back to today's argv would knowingly run the escalated envelope this item removes.
- **The refusal is scoped to relaunch.** A run whose session is alive resumes by focusing its pane and builds no argv; that path must keep working with or without `agentProfile`.
- **One emitter per harness.** After this work no harness's profile-derived flags may be written in two places. This is the same single-definition rule items 1.1b, 1.1c and 1.4 enforced for `ps` argv and delegation invariants.
- **Do not touch `run.json`'s `version`.** `agentProfile` is additive and optional; item 1.5 owns the version check.
- **Do not change the approval digest payload.** The profile's content is already covered through `launchSpec.argv` and `selection`; adding a digest field would invalidate every existing preview for no security gain.
- **Do not change any value in `projects.yaml`.**
- Zero new dependencies. Every task ends with its covering tests passing and `npm test` green. Baseline before Task 1: **895 tests, 894 pass, 1 pre-existing skip**.

## Reference: what the code actually does today

Read these before Task 3; the plan's later tasks assume them.

- `buildHarnessLaunch` (`src/workflow/harnesses.js:197`) dispatches to `piArgv` / `claudeArgv` / `codexArgv` / `opencodeArgv` (`:132-195`), each of which appends the profile's flags, then `appendModel`, then `profile.arguments`, then the bootstrap prompt.
- `relaunchSession` (`src/workflow/commands.js:1389-1496`) hand-builds three argvs at `:1453` (claude), `:1467` (codex) and `:1469-1470` (pi).
- `previewHarnessProfile` (`src/workflow/launch.js:119-132`) already normalizes the plan's agent into exactly the profile object `buildHarnessLaunch` consumes. It is the object that produced the approved argv.
- `runInput` (`src/workflow/launch.js:407`) builds the run record from the freshly recomputed preview, which carries `reconciliation` — so `previewHarnessProfile(preview.reconciliation)` is available there with no preview-shape change.
- `planResume` (`src/workflow/resume.js:32-46`) returns `{action: "focus" | "relaunch" | "refuse"}` from the transport observation alone.

## File Structure

- Modify: `src/workflow/harnesses.js` — export `CLAUDE_WORKER_SETTINGS_FILE`, extract per-harness flag emitters, add `buildHarnessResume`.
- Modify: `src/workflow/launch.js` — import the settings-file constant; persist `agentProfile`.
- Modify: `src/workflow/commands.js` — import the settings-file constant; `relaunchSession` consumes `buildHarnessResume`.
- Modify: `src/workflow/resume.js` — fail closed on the relaunch branch.
- Modify: `test/workflow-harnesses.test.js`, `test/workflow-launch.test.js`, `test/workflow-resume-close-commands.test.js`, `test/workflow-resume.test.js`.
- Modify: `ROADMAP.md` — close out 1.3.

---

### Task 1: One definition of `CLAUDE_WORKER_SETTINGS_FILE`

**Files:**
- Modify: `src/workflow/harnesses.js`, `src/workflow/launch.js:11`, `src/workflow/commands.js:1378`
- Test: `test/workflow-harnesses.test.js`

**Interfaces:**

```js
// src/workflow/harnesses.js — new export, next to CONTROL_PLANE_ROOT and buildClaudeWorkerSettings,
// which is the module that already owns what a Claude worker's settings file is.
export const CLAUDE_WORKER_SETTINGS_FILE = "claude-worker-settings.json";
```

`launch.js` and `commands.js` delete their local `const` and import it. Both already import from `harnesses.js`, so this adds a name to an existing import statement in each.

**Why its own task:** it is the roadmap's own sub-item ("Exportar `CLAUDE_WORKER_SETTINGS_FILE` de un solo lugar"), it is independent of everything else here, and it makes the later diffs smaller. `commands.js:1375-1377`'s comment exists only to warn that the two copies must match — that comment goes away with the copy.

**Steps:**

- [ ] **Step 1: Write the failing test** in `test/workflow-harnesses.test.js`:

```js
// The filename is a contract between three modules: launch.js writes the file, commands.js
// regenerates it on relaunch, and claudeArgv points --settings at it. It had two definitions
// kept in sync by a comment; this pins the single one.
test("CLAUDE_WORKER_SETTINGS_FILE is exported from harnesses.js and is the file claudeArgv points --settings at", () => {
  assert.equal(CLAUDE_WORKER_SETTINGS_FILE, "claude-worker-settings.json");
});
```

- [ ] **Step 2: Run it and verify it fails** — `node --test test/workflow-harnesses.test.js`. Expected: fails at import (the export does not exist).
- [ ] **Step 3: Implement** — add the export to `harnesses.js`; delete the local constants in `launch.js` and `commands.js` and import instead; remove `commands.js:1375-1377`'s now-obsolete "must match" comment, keeping the part that explains *why* the file is regenerated on relaunch.
- [ ] **Step 4: Prove there is one definition** — run `grep -rn "claude-worker-settings.json" src bin hooks .pi scripts test | grep -v node_modules` and confirm the only production definition is the new export. Paste the output into the commit message.
- [ ] **Step 5: Run `node --test test/workflow-harnesses.test.js`, then `npm test`.**
- [ ] **Step 6: Commit.**

```bash
git add src/workflow/harnesses.js src/workflow/launch.js src/workflow/commands.js test/workflow-harnesses.test.js
git commit -m "refactor: give the Claude worker settings filename one definition"
```

---

### Task 2: Persist the resolved profile in the run record

**Files:**
- Modify: `src/workflow/launch.js` (`runInput`, `:407-433`)
- Test: `test/workflow-launch.test.js`

**Interfaces:** `runInput` gains one field:

```js
    // The exact profile object that produced the approved argv: previewHarnessProfile is the same
    // normalization previewLaunchSpec fed to buildHarnessLaunch, applied to the same reconciliation,
    // on a preview whose approvalDigest was just re-verified. Persisted whole rather than as the
    // four security fields alone, so `workflow resume` can reproduce the argv instead of deciding
    // field by field which parts of the envelope mattered.
    //
    // Deliberately NOT added to the approval digest payload: the profile's content is already
    // covered through launchSpec.argv and selection, and a new digest field would invalidate every
    // existing preview for no security gain.
    agentProfile: cloneData(previewHarnessProfile(preview.reconciliation)),
```

`previewHarnessProfile` is already defined in this module (`:119-132`) and is module-private; it stays private.

**Interfaces produced for later tasks:** `run.agentProfile` is `{harness, command, mode, model, arguments, permission_mode?, sandbox?, approval_policy?}` — the optional three appear only for the harness that uses them. This is exactly the shape `assertProfile` (`harnesses.js`) validates.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `test/workflow-launch.test.js` — one per interactive harness, asserting the created run record's `agentProfile` matches the profile that produced the argv. Follow the existing launch-execution tests in that file for fixture shape; do not invent a new one. The claude case must assert `permission_mode`, the codex case `sandbox` and `approval_policy`:

```js
test("the created run record persists the resolved profile that produced the approved argv", async (t) => {
  // …execute a launch with the codex-worker profile, per this file's existing execution fixture…
  assert.deepEqual(created.agentProfile, {
    harness: "codex",
    command: "codex",
    mode: "interactive",
    model: null,
    arguments: [],
    sandbox: "workspace-write",
    approval_policy: "on-request",
  });
});
```

- [ ] **Step 2: Run and verify it fails** — `node --test test/workflow-launch.test.js`. Expected: `agentProfile` is `undefined`.
- [ ] **Step 3: Implement** the one field in `runInput`.
- [ ] **Step 4: Verify the digest did not move** — the approval digest is computed over `preview`, not over the run record, so adding a run-record field must not change any digest. Confirm no existing approval-digest test changed its expected value. If one did, stop and report it: that means the field leaked into the digest payload.
- [ ] **Step 5: Run `node --test test/workflow-launch.test.js`, then `npm test`.**
- [ ] **Step 6: Commit.**

```bash
git add src/workflow/launch.js test/workflow-launch.test.js
git commit -m "feat: persist the resolved agent profile in the run record at launch"
```

---

### Task 3: One flag emitter per harness, and `buildHarnessResume`

**Files:**
- Modify: `src/workflow/harnesses.js`
- Test: `test/workflow-harnesses.test.js`

**This is the task the item exists for.** The other five wire it up or clean up around it.

**Interfaces:**

```js
// New export. Same {argv, env} shape buildHarnessLaunch returns, minus `expected` (which
// describes a launch's approval surface and has no resume analogue).
export function buildHarnessResume({ profileName, profile, sessionName, cwd, run, sessionId, settingsPath } = {})
```

The extraction: each harness gets one function that turns a profile into the flags it contributes, called by both the launch argv builder and the resume argv builder. The launch and resume builders then differ **only** in:

| Harness | Launch session form | Resume session form | Bootstrap prompt |
|---|---|---|---|
| pi | `--session-id <id>` | `--session-id <id>` (identical) | launch only |
| claude | `--session-id <id>` | `--resume <id>` | launch only |
| codex | *(none — codex has no session flag at launch)* | `resume <id>` as argv positions 1-2, before any flag | launch only |

Everything else — `--permission-mode`, `--sandbox`, `--ask-for-approval`, `--add-dir`, `--model`, `profile.arguments`, the interactive-only `--extension` / `--settings` / `--dangerously-bypass-hook-trust` wiring — comes from the shared emitter and must be byte-identical between the two.

Both this task's tests and Task 4's need one small helper. It is three lines of pure array logic, so each test file defines its own copy rather than exporting a test utility across files:

```js
// Every value that follows `flag` in an argv. Returns [] when the flag is absent, so a missing
// flag and a flag with a different value produce different failures.
function argvFlagValues(argv, flag) {
  return argv.flatMap((entry, index) => (entry === flag && index + 1 < argv.length ? [argv[index + 1]] : []));
}
```

Two details that are easy to get wrong:

- **Codex's `resume <id>` must precede `-C <cwd>`.** The subcommand and its argument are positional; today's hand-built argv at `commands.js:1467` has the order right (`[command, "resume", id, "-C", cwd, …]`) — preserve it.
- **`opencode` has no resume path.** `relaunchSession` only ever sees `pi`/`claude`/`codex` (it coerces anything else to `pi`, `commands.js:1400`). `buildHarnessResume` should reject an `opencode` profile with a clear error rather than inventing an argv for it.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `test/workflow-harnesses.test.js`. The parity test is the load-bearing one — write it first:

```js
// The defect this whole item exists for: launch and resume derived the same profile into flags
// twice, and drifted. This asserts they cannot drift again — every flag the profile contributes
// to a launch must appear identically in the resume argv. Compared as a filtered list rather
// than whole argvs, because the session form and the bootstrap prompt legitimately differ.
for (const { harness, profile, flags } of PROFILE_FLAG_CASES) {
  test(`launch and resume emit identical profile-derived flags for ${harness}`, () => {
    const launched = buildHarnessLaunch({ /* … */ });
    const resumed = buildHarnessResume({ /* … */ });
    for (const flag of flags) {
      assert.deepEqual(argvFlagValues(resumed.argv, flag), argvFlagValues(launched.argv, flag), flag);
    }
  });
}
```

Define `PROFILE_FLAG_CASES` with the three interactive harnesses and the flags each contributes (`claude`: `--permission-mode`, `--model`, `--add-dir`, `--settings`; `codex`: `--sandbox`, `--ask-for-approval`, `--model`, `--add-dir`; `pi`: `--model`, `--extension`). Give each case a profile that sets `model` and a non-empty `arguments`, so both are actually exercised rather than passing vacuously against today's `null`/`[]`.

Then the resume-form tests: claude uses `--resume` and never `--session-id`; codex has `resume` and the session id at argv positions 1 and 2; pi uses `--session-id`; none of the three carries a bootstrap prompt; an `opencode` profile is rejected.

- [ ] **Step 2: Run and verify they fail** — `node --test test/workflow-harnesses.test.js`. Expected: fails at import (`buildHarnessResume` does not exist).
- [ ] **Step 3: Extract the shared emitters** — refactor `piArgv`/`claudeArgv`/`codexArgv` so the profile-derived flags come from one function per harness. Do this as a pure refactor first and re-run the existing harness tests: they must pass untouched, because launch behavior does not change in this task.
- [ ] **Step 4: Implement `buildHarnessResume`** on top of those emitters.
- [ ] **Step 5: Run `node --test test/workflow-harnesses.test.js`, then `npm test`.**
- [ ] **Step 6: Verify the parity test is load-bearing** — temporarily drop `--permission-mode` from the claude resume path, re-run, confirm the parity test fails, restore. Record the failing output in the commit message. A parity test that passes against a broken resume proves nothing.
- [ ] **Step 7: Commit.**

```bash
git add src/workflow/harnesses.js test/workflow-harnesses.test.js
git commit -m "feat: buildHarnessResume, sharing one profile-to-flags emitter per harness"
```

---

### Task 4: `relaunchSession` uses the builder

**Files:**
- Modify: `src/workflow/commands.js` (`relaunchSession`, `:1389-1496`)
- Test: `test/workflow-resume-close-commands.test.js`

**Interfaces:** the three hand-built argv arrays are replaced by one `buildHarnessResume` call taking `run.agentProfile`. Everything else `relaunchSession` owns stays exactly as it is: the `createTab` → `splitPane({env})` → `startAgent` → `focusAgent` choreography, the shortened `resume-<8 chars>` session name, the Claude settings-file regeneration through `store.writePrivateFile`, and the returned identity.

The long comments at `:1447-1452` and `:1455-1467` explaining *why* each harness resumes the way it does move with the logic into `harnesses.js` — they document the argv, not the choreography. The follow-up notes they carry ("No `--permission-mode`/`--model` either… (known follow-up)", "Sandbox/approval-policy aren't carried on the transportIdentity… documented follow-up") are now false and must be deleted, not moved.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `test/workflow-resume-close-commands.test.js`. The first one is the regression that started this item — assert the absence explicitly:

```js
// D6: the resumed codex worker auto-approved everything the approved profile would have asked
// about. Presence of the correct flag is not enough — the old argv's hardcoded `-a never` must
// be gone, or a future edit could emit both and the last one would win.
test("a resumed codex worker runs under the approved approval policy and sandbox, never a hardcoded -a never", async (t) => {
  // …resume a run whose agentProfile is the codex-worker profile…
  assert.deepEqual(argvFlagValues(argv, "--ask-for-approval"), ["on-request"]);
  assert.deepEqual(argvFlagValues(argv, "--sandbox"), ["workspace-write"]);
  assert.equal(argv.includes("-a"), false, "the hardcoded -a never must be gone");
  assert.equal(argv.includes("never"), false);
});
```

Then: a resumed claude worker carries `--permission-mode manual`; a resumed pi worker carries the profile's `--model` and `arguments` when set. Use this file's existing resume fixtures — they already stub Herdr and capture `startAgent`'s argv.

- [ ] **Step 2: Run and verify they fail** — `node --test test/workflow-resume-close-commands.test.js`. Expected: the codex test fails on `-a never` still being present; the claude test fails on the missing permission mode.
- [ ] **Step 3: Implement** — replace the three argv branches with the builder call; delete the stale follow-up comments.
- [ ] **Step 4: Verify the choreography is untouched** — the existing tests in this file that assert the Herdr call sequence, the session name, the settings regeneration and the returned identity must pass without modification. If any needed changing, stop and report which and why.
- [ ] **Step 5: Run `node --test test/workflow-resume-close-commands.test.js`, then `npm test`.**
- [ ] **Step 6: Commit.**

```bash
git add src/workflow/commands.js test/workflow-resume-close-commands.test.js
git commit -m "fix: resume relaunches under the approved security envelope"
```

---

### Task 5: Refuse a relaunch whose envelope cannot be reproduced

**Files:**
- Modify: `src/workflow/resume.js` (`planResume`, `:32-46`)
- Test: `test/workflow-resume.test.js`

**Interfaces:** `planResume` already returns `{action: "refuse", identity, reason}` for an unprovable observation. It gains one more refusal, on the `missing` branch only — the branch that becomes `action: "relaunch"`:

```js
    case "missing":
      // A relaunch has to reproduce the argv the approval digest covered, and run.agentProfile is
      // the only record of it (the registry may have changed since launch; transportIdentity does
      // not carry it). Runs created before that field existed cannot be reproduced, so they are
      // refused here rather than relaunched under an envelope nobody approved — the escalation
      // this item removed. Refusing in planResume, not in the relaunch itself, means the operator
      // sees it in the read-only preview instead of after a Herdr tab already exists.
      return resumableProfile(run)
        ? { action: "relaunch", identity }
        : { action: "refuse", identity, reason: "unreproducible-envelope" };
```

`resumableProfile(run)` returns true only when `run.agentProfile` is present and passes `assertProfile` — a malformed profile refuses the same way, since a malformed envelope is not a reproducible one.

The `focus` branch is untouched: a live session never builds an argv.

**Steps:**

- [ ] **Step 1: Write the failing tests** in `test/workflow-resume.test.js`:
  - a run with no `agentProfile` and a `missing` observation returns `action: "refuse"` with the named reason;
  - the same run with an `active` observation still returns `action: "focus"` — the refusal must not leak into the live path;
  - a run with a malformed `agentProfile` (e.g. `{harness: "claude"}` with no `command`) refuses;
  - a run with a valid `agentProfile` and a `missing` observation still returns `action: "relaunch"`.
- [ ] **Step 2: Run and verify they fail** — `node --test test/workflow-resume.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify no Herdr state is created on the refusal** — assert through `executeResume` with a Herdr stub that records every call: on the refusal path, `createTab` must never be called. This is the property that makes refusing at plan time worth doing.
- [ ] **Step 5: Confirm the operator-facing message is actionable** — the refusal must reach the CLI with a reason that says what happened and what to do instead (relaunch, since the run's envelope cannot be reproduced). Follow how this file's existing `refuse` reasons surface in `resumeCommand`; if the reason string is rendered verbatim, make it a sentence rather than a slug.
- [ ] **Step 6: Run `node --test test/workflow-resume.test.js`, then `npm test`.**
- [ ] **Step 7: Commit.**

```bash
git add src/workflow/resume.js test/workflow-resume.test.js
git commit -m "fix: refuse a relaunch whose approved envelope cannot be reproduced"
```

---

### Task 6: Close out the roadmap

**Files:**
- Modify: `ROADMAP.md`

**Interfaces:** documentation only, in **Spanish** (code identifiers stay in English). Read the 1.1b, 1.4 and 1.1c entries first — they are the model for register and density. `npm test` must stay green (`test/docs.test.js` and `test/workflow-docs.test.js` read repository docs).

**Steps:**

- [ ] **Step 1: Mark 1.3 done** — `- [x]` with its commit range, in the Fase 1 list.
- [ ] **Step 2: Add a progress-table row** — date, item, commit range, final suite count, and what changed: the persisted `agentProfile`, `buildHarnessResume` with one profile-to-flags emitter per harness, and the fail-closed refusal for runs that predate the field.
- [ ] **Step 3: State the measured divergence plainly**, the way the other entries state inconvenient facts: with the profiles committed today, claude resume dropped `--permission-mode manual`, codex resume dropped `--sandbox workspace-write` and substituted `-a never` for the approved `--ask-for-approval on-request` (the only unambiguous escalation of the three), and pi's divergence was latent — nothing was wrong there only because `model` is `null` and `arguments` is `[]`.
- [ ] **Step 4: Record the operator-visible consequence** — runs created before this item cannot be resumed and must be relaunched. That is a real cost of the fix, not a footnote.
- [ ] **Step 5: Repoint the ordered list** — 1.3 struck through and complete; **1.2** becomes the next step, with 1.6 noted as the safety net that should precede it.
- [ ] **Step 6: Run `npm test`**, then commit.

```bash
git add ROADMAP.md
git commit -m "docs: close out roadmap 1.3, resume runs the approved envelope"
```

---

## Verification

The spec's eleven Verification Strategy items map to these tasks:

| Spec item | Task |
|---|---|
| 1 (run record carries `agentProfile`) | Task 2 |
| 2 (resume emits the approved flags per harness) | Tasks 3 and 4 |
| 3 (codex never emits `-a never`) | Task 4 |
| 4 (launch and resume emit identical flags) | Task 3 — the parity test |
| 5 (resume form per harness, no bootstrap) | Task 3 |
| 6 (refuse with a named reason, no Herdr state) | Task 5 |
| 7 (live session still focuses) | Task 5 |
| 8 (malformed profile refuses) | Task 5 |
| 9 (one `CLAUDE_WORKER_SETTINGS_FILE`) | Task 1 |
| 10 (choreography unchanged) | Task 4, step 4 |
| 11 (`npm test` green) | every task |

After Task 6, run a final review of the whole branch diff against the spec before merging, as items 1.1, 1.1b, 1.4 and 1.1c each did.
