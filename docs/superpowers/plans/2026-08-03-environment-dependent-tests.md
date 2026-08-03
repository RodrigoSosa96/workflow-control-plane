# Environment-Dependent Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `main` green in CI by fixing the four tests that pass only because of what is installed on the developer's machine, and leave behind a one-command way to reproduce CI's environment locally so the class cannot return silently.

**No spec for this one, deliberately.** `ROADMAP.md`'s own rule for this shape of work: direct fixes need tests, not prior design. The diagnosis below is complete and verified; there is nothing to design.

**Architecture:** Two independent root causes, four tests, no production change. Plus a `test:ci-like` npm script that reproduces the stripped environment.

## The verified diagnosis

The first push to `origin/main` ran the CI added in Fase 0 for the first time and it failed: **935 pass, 4 fail**, where the same commit gives 939/939 locally. Reproduced exactly by stripping the harness binaries from `PATH` and setting `CI=true GITHUB_ACTIONS=true`: **935 pass, 4 fail**, the same four. The reproduction is faithful, so the sweep is complete — across 939 tests these four are the only environment-dependent ones.

**Cause A — a real `PATH` lookup runs before the injected command (3 tests, `test/workflow-cli.test.js`).**

`withLiveDelegationTransport` (`bin/workflow.js:612-617`) short-circuits on exactly one condition:

```js
if (liveDependencies.transport) return liveDependencies;   // the only escape
const piCommand = await liveDependencies.lookupExecutable("pi");
if (!piCommand || !isAbsolute(piCommand)) throw new WorkflowError("PREFLIGHT", "Pi executable must resolve to an absolute path for delegation", …);
```

The three tests inject the *command* (`delegationReconcileCommand`, `delegationResultCommand`, `delegationRemediateCommand`) but not `transport`. So the dispatch resolves `pi` from the real `PATH` on the way to the injected command. With `pi` installed the lookup succeeds and a transport is built that is never used — the injected command throws immediately — and the test passes for a reason unrelated to its assertion. Without `pi`, the lookup throws and the injected command never runs.

Failing tests: `maps conflict and preflight workflow errors to stable categories` (`:2176`), `main prints stable exits for delegation result and keeps delegation reconcile read-only`, `delegation remediate dry-run reads only --prompt-file, and execution requires --yes plus the current digest`.

**Cause B — the test asserts a guard that is unreachable in CI by design (1 test, `test/workflow-real-canary.test.js:284`).**

`assertRealModeAllowed` (`scripts/smoke-workflow-fixture.js:51-71`) checks TTY, `--keep`, `--agent`, then:

```js
  if (isCiEnv(env)) throw new Error("Real canaries are interactive-only and cannot run in CI");   // :65-67
  const confirmed = await promptExactHarness(...);
  if (confirmed !== args.agent) throw new Error("Real canary was not confirmed");                 // :69-71
```

`isCiEnv` reads `CI || GITHUB_ACTIONS || GITLAB_CI || BUILDKITE`. The test drives `--real` with a wrong typed confirmation and asserts `/not confirmed/`, but under CI the guard above fires first. Confirmed by reproduction: `CI=true GITHUB_ACTIONS=true node --test test/workflow-real-canary.test.js` fails exactly this test.

**Neither cause is a production defect.** Refusing a Pi delegation command when `pi` is absent is correct; refusing a real canary in CI is correct. Both are tests that do not control their own environment.

**Neither was introduced by recent work** — the four tests date to `c99bd43` and `aa139d4`.

## Global Constraints

- **No production changes.** If a fix seems to require one, stop and report it — that would mean a real defect, not a test defect.
- **Do not weaken an assertion to make it pass.** Each test must still assert what its name says; the fix is to control the environment it runs in, not to lower the bar.
- Every task must leave the suite green **both ways**: normally, and under the CI-like reproduction.
- Zero new dependencies. Baseline: **939 tests, 939 pass, 0 skips** normally; 935/4 under the CI-like environment.

## File Structure

- Modify: `test/workflow-cli.test.js` — inject a transport alongside the injected command in three tests.
- Modify: `test/workflow-real-canary.test.js` — make the canary test control its own CI env.
- Modify: `package.json` — add `test:ci-like`.
- Create: `scripts/test-ci-like.sh` (or equivalent) — the reproduction.
- Modify: `README.md` — one line documenting it.
- Modify: `ROADMAP.md` — record the finding.

---

### Task 1: The three delegation CLI tests control their transport

**Files:**
- Modify: `test/workflow-cli.test.js`
- Test: the same file

**Interfaces:** each failing test already passes a dependencies object to `main([...], {...})`. It gains a `transport` so `withLiveDelegationTransport`'s short-circuit at `bin/workflow.js:613` takes over and no `PATH` lookup happens.

The transport only has to satisfy that short-circuit — it is never used, because the injected command throws or returns first. Use the smallest object that is honest about that, and check whether the file already has a transport stub before writing a new one (`test/workflow-cli.test.js` drives many delegation paths; a suitable fake may exist).

**Steps:**

- [ ] **Step 1: Reproduce the failures first.** Build the CI-like `PATH` and confirm the three fail:

```bash
NODEBIN=$(dirname $(which node)); TMPBIN=$(mktemp -d)
for b in node npm npx; do ln -s "$NODEBIN/$b" "$TMPBIN/$b"; done
PATH="$TMPBIN:/usr/bin:/bin:/usr/sbin:/sbin" npm test 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"
```

Expected: 936 pass, 3 fail. Record the output in your report — this is the red state you are fixing.

- [ ] **Step 2: Add the transport injection** to the three tests.
- [ ] **Step 3: Confirm green under the CI-like PATH** — the same command now gives 939/939.
- [ ] **Step 4: Confirm still green normally** — plain `npm test` gives 939/939.
- [ ] **Step 5: Confirm the fix is load-bearing** — remove the injected transport from one test, re-run under the CI-like PATH, confirm it fails again, restore. A fix that passes either way did not fix anything.
- [ ] **Step 6: Commit.**

```bash
git commit -m "test: delegation CLI tests inject their transport instead of resolving pi from PATH"
```

---

### Task 2: The canary test controls its own CI environment

**Files:**
- Modify: `test/workflow-real-canary.test.js`

**Interfaces:** the test at `:284` drives `runSmoke(["--real", "--agent", "pi", "--keep"], { stdin: "claude\n", env: { WORKFLOW_SMOKE_TEST_TTY: "1" } })` and asserts `/not confirmed/`. It already passes an `env` — it just does not neutralise the CI variables `isCiEnv` reads (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`).

How `runSmoke` builds the child env matters: check whether it spreads `process.env` under the passed `env` or replaces it. The fix must ensure those four variables are absent (or falsy) for **this** test, without disturbing tests that legitimately want them.

**Do not delete the CI guard, and do not stop testing it.** The right outcome is two tests: this one, with CI neutralised, still asserting the typed-confirmation rejection; and a new one asserting that **with** `CI=true` the real canary is refused with the interactive-only message. That guard is a real safety property and nothing currently covers it — which is precisely how it stayed invisible.

**Steps:**

- [ ] **Step 1: Reproduce** — `CI=true GITHUB_ACTIONS=true node --test test/workflow-real-canary.test.js` fails exactly this test. Record it.
- [ ] **Step 2: Neutralise the CI variables** for the existing test.
- [ ] **Step 3: Add the missing guard test** — with `CI=true`, `--real` is refused with the interactive-only message and never prompts.
- [ ] **Step 4: Confirm both pass with and without `CI=true` set in the parent environment.** State both runs in your report.
- [ ] **Step 5: Commit.**

```bash
git commit -m "test: the real-canary tests set their own CI env, and the CI guard is finally covered"
```

---

### Task 3: Make the reproduction a command, and record the finding

**Files:**
- Create: `scripts/test-ci-like.sh`
- Modify: `package.json`, `README.md`, `ROADMAP.md`

**Interfaces:** a script that runs the suite with the harness binaries stripped from `PATH` and the CI variables set, so a developer can check before pushing what CI will say. Wired as `npm run test:ci-like`.

It must build a temp bin directory containing only what the suite genuinely needs (`node`, `npm`, `npx` symlinked from the running node's directory) plus the system paths, and clean it up. It must **not** permanently modify anything, and must exit with the suite's exit code.

**Why this task exists at all:** the two fixes above are worth little without it. The class returns the moment someone adds a test that reaches for an installed binary, and the only thing that caught it this time was a push. A local command makes the check cheap enough to actually run.

**Steps:**

- [ ] **Step 1: Write the script**, and verify it reproduces the *pre-fix* red state by running it against `git stash`-ed fixes — or, if that is awkward, by temporarily reverting one test's fix. It must be demonstrated to catch something, not merely to run.
- [ ] **Step 2: Wire `test:ci-like` in `package.json`.**
- [ ] **Step 3: Document it in one line in `README.md`**, wherever the test commands are already described. Do not invent a new section.
- [ ] **Step 4: Record the finding in `ROADMAP.md`** — Spanish, matching the voice. State: the first push ran the Fase 0 CI for the first time and it was red; the cause was four environment-dependent tests, not a regression; the two distinct root causes; that a full sweep under a faithful CI reproduction found exactly those four out of 939; and that `npm run test:ci-like` now reproduces it locally. Be explicit that neither cause was a production defect.
- [ ] **Step 5: Run both `npm test` and `npm run test:ci-like`** — both green, zero skips.
- [ ] **Step 6: Commit.**

```bash
git commit -m "test: npm run test:ci-like reproduces CI's environment locally"
```

---

## Verification

- The suite is green under `npm test` **and** under `npm run test:ci-like`, both at zero skips.
- Each of the four fixes was shown to fail before it and pass after, under the reproduction.
- No production file changed.
- The CI guard in `assertRealModeAllowed` is covered by a test for the first time.
- `ROADMAP.md` records why CI was red and that it was not a regression.

After Task 3, run a final review of the branch, then push and confirm CI is green — the whole point of this branch is a green `main`, and that cannot be verified locally.
