# Workflow Fixture and Real-Agent Canaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide generated disposable single- and multi-repository projects that exercise the complete launcher/lifecycle/coordinator flow with deterministic fake workers and opt-in real Pi, Claude, and Codex canaries.

**Architecture:** A fixture generator creates isolated Git repositories, registry v3, private state, static ticket context, and profile shims under one uniquely marked root. Automated integration uses injected adapters; a real-Herdr smoke launches a fake interactive worker through the production CLI; explicitly confirmed canaries replace only the worker command with a real harness while keeping all Git, tickets, state, and cleanup inside the fixture root.

**Tech Stack:** Node.js 24 ES modules, `node:test`, temporary Git repositories, Herdr 0.7.4, Pi/Claude/Codex CLIs, existing Workflow Launcher and native lifecycle hooks.

> **Amendment — two-lane delegation:** Complete the two-lane foundation and revised lifecycle/coordinator implementation before this plan. Fixtures must validate the same private delegation state, prepared-request guard, reservation capacity, and exact transport contracts used in production paths.

## Global Constraints

- Complete and review both prior implementation plans before starting this plan.
- Follow strict red-green-refactor TDD for fixture behavior and safety checks.
- The fixture must contain no copied project source and no real project path.
- Fixture tickets come from a static local JSON file; never call or mutate Asana.
- Default automated tests make no model/API calls and consume no tokens.
- Real-agent canaries are opt-in, TTY-only, print a token-cost warning, display the exact assignment, and require the user to type the selected harness name.
- Every fixture root has a generated ownership marker and random ID; cleanup refuses any path/resource without both.
- `--keep` always preserves repos, state, worktrees, and Herdr workspace references.
- Any failed assertion preserves all fixture resources and prints exact debugging commands.
- Successful cleanup may remove only the uniquely identified fixture resources created by that invocation, as explicitly approved for this test system.
- Never touch a path from canonical `projects.yaml`; all commands use `WORKFLOW_PROJECTS_FILE` pointing to the generated registry.
- Never fetch, push, deploy, mutate production, initialize real Acme, delete a real branch/worktree, or close a non-fixture Herdr workspace.
- Never use Claude/Codex permission or hook-trust bypasses.
- Fake harnesses must exercise the same assignment, run-store, handoff, generation, Git fingerprint, and Herdr start paths as real harnesses.
- Two-lane fixture gates run in this exact order: deterministic policy/transport fake; read-only foreground and background delegation; one writer in a workflow-owned fixture worktree; then separately approved real harness canaries.
- A read-only background fixture must prove project/role capacity, exact session identity, prepared-request consumption, result delivery, and no terminal-derived result.
- A writer-background fixture must prove one writer per checkout, workflow-owned worktree identity, remediation limit, preserved reservation history, and no automatic cleanup before any real canary is considered.
- Real-agent canaries perform one tiny deterministic edit and local verification only.
- End every task with focused tests, full `npm test`, `git diff --check`, specification review, and code-quality review.

---

## Planned File Structure

```text
src/workflow/
  fixture.js                            Generated repos/registry/tickets lifecycle
  fixture-cleanup.js                    Ownership-checked cleanup helpers
scripts/
  workflow-fixture.js                   Create/inspect/remove manual fixture CLI
  smoke-workflow-fixture.js             Fake/real Herdr smoke runner
test/support/
  fake-workflow-agent.js                Interactive deterministic worker shim
  fake-ticket-provider.js               Static fixture ticket reader
test/
  workflow-fixture.test.js
  workflow-fake-agent.test.js
  workflow-fixture-integration.test.js
  workflow-herdr-smoke.test.js           Opt-in skip unless env enabled
  workflow-real-canary.test.js           Planning/safety only; no model call
README.md
package.json
```

---

### Task 1: Generated Single/Group Git Projects and Local Tickets

**Files:**
- Create: `src/workflow/fixture.js`
- Create: `src/workflow/fixture-cleanup.js`
- Create: `scripts/workflow-fixture.js`
- Create: `test/support/fake-ticket-provider.js`
- Create: `test/workflow-fixture.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces `createWorkflowFixture({ root?, packageRoot, clock?, randomUUID? }) -> FixtureDescriptor`.
- Produces `loadFixtureDescriptor(root) -> FixtureDescriptor`.
- Produces `assertOwnedFixture(root, fixtureId) -> marker`.
- Produces `cleanupWorkflowFixture(descriptor, { herdr? })` with strict ownership checks.
- Manual script supports `create`, `inspect`, and explicit `remove`.

- [ ] **Step 1: Write failing generator tests**

Use a temporary parent and injected UUID. Assert exact topology:

```js
const fixture = await createWorkflowFixture({
  root: join(parent, "workflow-fixture-test"),
  packageRoot,
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
});

assert.equal(fixture.id, "11111111-1111-4111-8111-111111111111");
assert.equal((await readJson(join(fixture.root, ".workflow-fixture.json"))).ownedBy, "workflow-launcher-fixture-v1");
assert.equal((await gitBranch(fixture.single.repository)), "main");
assert.deepEqual(Object.keys(fixture.bundle.repositories), ["backend", "frontend"]);
```

Assert:

- every repository has one initial commit and local test command;
- bundle meta/backend/frontend have different Git common dirs;
- registry paths/state/worktree roots are all under fixture root;
- registry has fake and real profiles but no canonical project paths;
- tickets JSON contains primary/related ready tickets for both projects;
- no `.env`, credentials, remote URL, Asana ID/token, or copied source exists;
- creation refuses an existing unmarked/non-empty root;
- cleanup refuses root, `/tmp`, symlink escapes, missing/wrong marker, mismatched UUID, and any Herdr workspace not carrying the fixture label/path.

- [ ] **Step 2: Verify RED**

Run: `node --test test/workflow-fixture.test.js`

Expected: FAIL because fixture modules do not exist.

- [ ] **Step 3: Implement repository generation**

Use the existing argv process runner for Git:

```text
git init --initial-branch main <path>
git -C <path> config user.name Workflow Fixture
git -C <path> config user.email workflow-fixture@example.invalid
git -C <path> add --all
git -C <path> commit -m "test: initialize workflow fixture"
```

Generated Node project contents are minimal and original:

```text
package.json      { "type": "module", "scripts": { "test": "node --test" } }
fixture.js        export const value = "initial";
test.js           asserts value === expected fixture value
AGENTS.md         fixture-only safety and handoff instructions
```

The group meta repo contains only a fixture README/marker; backend/frontend are independent source repos and later become child worktrees under `repos/`.

- [ ] **Step 4: Generate registry and tickets**

Registry projects:

- `fixture-single`: ordinary repository, primary `FIX-101`, related `FIX-102`.
- `fixture-bundle`: group repository, primary `FIX-201`, related `FIX-202`/`FIX-203`, child aliases backend/frontend.

Use absolute paths and set `launcher.worktree_root`/`state_root` under the root. Fake profiles use committed `test/support/fake-workflow-agent.js` as command and profile arguments identifying the emulated harness; real profiles use `pi`, `claude`, and `codex` with inherited models and safe permissions.

Static tickets contain `id`, `project`, `title`, `description`, `ready`, and `acceptanceCriteria`. `fake-ticket-provider.js` accepts only this path and performs no network calls.

- [ ] **Step 5: Implement ownership-checked cleanup**

Before any removal:

1. Resolve root with `realpath`.
2. Require marker filename, schema, exact UUID, and `ownedBy` constant.
3. Require every resource path to be equal to/under root.
4. List Herdr workspaces and close only exact path plus label prefix `workflow-fixture-<id>`.
5. Refuse on any mismatch; never broaden cleanup.

Automated unit tests may remove their own temporary roots in test teardown. Manual `remove` requires fixture ID and interactive confirmation or `--yes`.

- [ ] **Step 6: Add package scripts and manual CLI**

```json
{
  "scripts": {
    "fixture:create": "node scripts/workflow-fixture.js create --keep",
    "fixture:inspect": "node scripts/workflow-fixture.js inspect",
    "smoke:fixture": "node scripts/smoke-workflow-fixture.js"
  }
}
```

`create` prints root, registry, ticket IDs, state root, and copy-paste commands in the exact form `WORKFLOW_PROJECTS_FILE=<fixture-registry> workflow launch fixture-single FIX-101 --tickets FIX-102 --agent fake-pi --prompt-file <fixture-request-file> --dry-run`. It never launches an agent.

- [ ] **Step 7: Run focused and full tests**

```bash
node --test test/workflow-fixture.test.js
npm test
git diff --check
```

Expected: all tests pass and no Herdr/model process starts.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/workflow/fixture.js src/workflow/fixture-cleanup.js scripts/workflow-fixture.js test/support/fake-ticket-provider.js test/workflow-fixture.test.js package.json package-lock.json
git commit -m "test(workflow): generate disposable project fixtures"
```

---

### Task 2: Deterministic Interactive Fake Worker and Full Integration

**Files:**
- Create: `test/support/fake-workflow-agent.js`
- Create: `test/workflow-fake-agent.test.js`
- Create: `test/workflow-fixture-integration.test.js`
- Modify: `src/workflow/fixture.js`
- Modify: `src/workflow/reconcile.js`
- Modify: `test/workflow-reconcile.test.js`

**Interfaces:**
- Fake worker accepts real Pi/Claude/Codex-shaped argv, reads only workflow env/run assignment, emits lifecycle callbacks, edits one fixture file, runs local tests, submits handoff, then remains interactive.
- Process reconciliation safely recognizes an interpreter-backed profile command when its exact script path appears in argv.

- [ ] **Step 1: Write failing fake-worker unit tests**

Spawn the worker in a temporary fixture with piped stdin/stdout and a fake lifecycle callback. Cover:

- parses Pi `--session-id/--name/-e` argv;
- parses Claude `--session-id/--name/--settings/--add-dir` argv;
- parses Codex `-C/--profile/--sandbox/--ask-for-approval/--add-dir` argv;
- validates `WORKFLOW_RUN_ID`, directory, harness, generation, and checkout;
- emits SessionStart then initial UserPromptSubmit;
- performs exactly one allowed edit and `node --test`;
- writes semantic handoff through production `submitHandoff`;
- emits Stop and waits for another input line;
- a follow-up line emits UserPromptSubmit, increments generation, changes fixture output, and writes a fresh result;
- EOF/SIGTERM emits SessionEnd and exits;
- no env/run mismatch produces an edit.

- [ ] **Step 2: Write failing production integration tests with fake adapters**

Create both generated projects and run production command/use-case functions end-to-end with fake Herdr but real Git/run store:

1. Dry-run bundle with `FIX-201` + related tickets.
2. Confirm with approval digest.
3. Create meta and child worktrees.
4. Launch fake Claude profile.
5. Wait for result file.
6. Reconcile current completion.
7. Send follow-up and observe `result-stale → running → completed generation 2`.
8. End worker and reconcile closed-with-result.

Also test closing before handoff yields interrupted/manual state and preserves repositories.

- [ ] **Step 3: Verify RED**

```bash
node --test test/workflow-fake-agent.test.js test/workflow-fixture-integration.test.js
```

Expected: FAIL because fake worker/integration support is absent.

- [ ] **Step 4: Implement the worker protocol**

The fake worker must never infer a target path from prompt text. It reads expected checkout/tickets from `run.json`, assignment for audit only, and changes only `fixture.js`/its fixture test. It runs the configured local verification and constructs:

```js
{
  version: 1,
  status: "completed",
  summary: `Fake ${harness} completed generation ${generation}`,
  tickets: run.tickets.map((id) => ({ id, status: "completed", evidence: ["node --test passed"] })),
  changedFiles: ["fixture.js", "test.js"],
  verification: [{ command: "node --test", status: "passed", summary: "fixture test passed" }],
  decisions: [],
  concerns: [],
  nextAction: "Return to the Pi coordinator",
}
```

Call production `submitHandoff`; do not duplicate fingerprint logic.

- [ ] **Step 5: Harden interpreter-backed process identity**

Permit compatibility only when process argv contains the exact canonical planned command/script path in the expected position and cwd/harness/run env also match. Do not accept basename-only script matching or arbitrary `node` processes. Add negative tests for a different same-name script and wrong run ID.

- [ ] **Step 6: Run focused and full tests**

```bash
node --test test/workflow-fake-agent.test.js test/workflow-fixture-integration.test.js test/workflow-reconcile.test.js
npm test
git diff --check
```

Expected: all tests pass with no real Herdr/model call.

- [ ] **Step 7: Commit Task 2**

```bash
git add test/support/fake-workflow-agent.js test/workflow-fake-agent.test.js test/workflow-fixture-integration.test.js src/workflow/fixture.js src/workflow/reconcile.js test/workflow-reconcile.test.js
git commit -m "test(workflow): exercise launches with a fake worker"
```

---

### Task 3: Real Herdr Smoke with Fake Harness

**Files:**
- Create: `scripts/smoke-workflow-fixture.js`
- Create: `test/workflow-herdr-smoke.test.js`
- Modify: `src/workflow/fixture-cleanup.js`
- Modify: `src/workflow/herdr.js`
- Modify: `test/workflow-herdr.test.js`
- Modify: `package.json`

**Interfaces:**
- `npm run smoke:fixture -- --agent pi|claude|codex [--project single|bundle] [--keep]` uses Herdr real and worker fake by default.
- Smoke returns a structured report and preserves resources on any failure.

- [ ] **Step 1: Write failing smoke orchestration tests with a fake CLI runner**

Assert command order and safety:

```text
create fixture
workflow hooks doctor --agent fake-pi --format json
workflow launch fixture-single FIX-101 --tickets FIX-102 --agent fake-pi --prompt-file <fixture-request-file> --dry-run --format json
workflow launch fixture-single FIX-101 --tickets FIX-102 --agent fake-pi --prompt-file <fixture-request-file> --yes --approval-digest <previewed-digest> --format json
workflow result <run-id> --format json
workflow reconcile --run <run-id> --format json
```

Assert every workflow invocation has generated `WORKFLOW_PROJECTS_FILE`. Assert no canonical project aliases/paths, no `--dangerously-*`, no `danger-full-access`, no `--last`, and no automatic cleanup on failure/`--keep`.

- [ ] **Step 2: Add an opt-in node:test wrapper**

`test/workflow-herdr-smoke.test.js` skips unless `WORKFLOW_RUN_LIVE_HERDR_SMOKE=1`. When enabled, it invokes the script with fake Pi on the single project and a bounded timeout. A skip is success in normal CI/default tests.

- [ ] **Step 3: Verify RED**

```bash
node --test test/workflow-herdr-smoke.test.js test/workflow-herdr.test.js
```

Expected: smoke test skips by default; orchestration unit tests fail until script exists.

- [ ] **Step 4: Implement real-Herdr fake smoke**

For one selected harness/project:

1. Verify `herdr status --json` and matching integration readiness.
2. Generate fixture and print descriptor.
3. Build request from static tickets.
4. Run/print dry-run JSON and approval digest.
5. Execute confirmed launch against generated registry.
6. Poll run-store/result with an absolute bounded deadline.
7. Assert expected worktree(s), Herdr workspace/tab/pane, run identity, ticket set, passing verification, and Git fingerprint.
8. Send one follow-up through production resume for generation 2 and validate stale/current transition.
9. Gracefully close fake worker and validate closed-with-result.
10. On success and without `--keep`, close only fixture workspace and remove the owned root.

Never use terminal output as completion evidence. The script may print recent bounded fake-worker diagnostics only after a failure and label them non-authoritative.

- [ ] **Step 5: Run the real fake-harness smoke**

Run first with preservation:

```bash
npm run smoke:fixture -- --agent pi --project single --keep
```

Inspect the printed workspace, run state, result, and generated repository. Then run cleanup-enabled:

```bash
npm run smoke:fixture -- --agent pi --project bundle
```

After Pi passes, repeat fake Claude and fake Codex. These invoke no model APIs because profile commands point to the fake worker.

Expected: each run reaches generation 2 completion; `--keep` resources remain; cleanup run removes only its owned fixture.

- [ ] **Step 6: Diagnose and fix live-contract mismatches with TDD**

For any Herdr 0.7.4 mismatch, first add a failing adapter/integration test reproducing the observed JSON/argv contract, then implement the minimal correction. Do not patch Herdr or weaken process identity globally.

- [ ] **Step 7: Run full verification and commit**

```bash
npm test
npm pack --dry-run
git diff --check
git status --short
```

Then:

```bash
git add scripts/smoke-workflow-fixture.js test/workflow-herdr-smoke.test.js src/workflow/fixture-cleanup.js src/workflow/herdr.js test/workflow-herdr.test.js package.json package-lock.json
git commit -m "test(workflow): smoke full lifecycle in real Herdr"
```

---

### Task 4: Opt-In Real Pi, Claude, and Codex Canaries

**Files:**
- Create: `test/workflow-real-canary.test.js`
- Modify: `scripts/smoke-workflow-fixture.js`
- Modify: `README.md`
- Modify: `test/workflow-docs.test.js`
- Modify: `package.json`

**Interfaces:**
- `npm run smoke:fixture -- --real --agent <pi|claude|codex> --keep` launches the real selected harness only after typed confirmation.
- Automated tests verify canary safety/planning but never invoke a model.

- [ ] **Step 1: Write failing real-canary safety tests**

With fake prompt/runner dependencies, assert:

- `--real` fails when stdin/stderr are not TTYs;
- confirmation requires typing exactly `pi`, `claude`, or `codex`, not `y`;
- warning states token/API cost and generated-project scope;
- exact assignment is printed before confirmation;
- selected profile maps to the matching real command and safe permissions;
- cancellation makes no Herdr/Git/run mutation beyond the generated fixture root and preserves that root for inspection;
- timeout/failure always implies keep;
- success honors explicit `--keep`;
- no CI environment can accidentally acknowledge confirmation;
- prompt requests only one tiny fixture edit, tests, and structured handoff.

- [ ] **Step 2: Verify RED**

Run: `node --test test/workflow-real-canary.test.js`

Expected: FAIL because `--real` behavior is incomplete.

- [ ] **Step 3: Implement real profile switching and typed confirmation**

Real canary assignment:

```text
Change the generated fixture's exported value from "initial" to "implemented".
Update only its matching fixture test.
Run `node --test`.
Submit the required structured workflow handoff for every listed fixture ticket.
Do not push, deploy, access the network, read secrets, alter permissions, close the workspace, or clean resources.
```

Before launch print:

- fixture root/registry;
- selected harness/profile/model inheritance;
- sandbox/permission/approval mode;
- ticket set and writable roots;
- exact assignment and approval digest;
- explicit possible token cost;
- preservation policy.

Require typed harness. Ignore `--yes` for real canaries.

- [ ] **Step 4: Add bounded completion and debugging behavior**

Poll structured run state only. On terminal current result, verify tests/fingerprint/tickets. On `needs-input`, `manual-handoff-required`, timeout, process close, stale result, or invalid result:

- stop waiting;
- preserve everything;
- print `workflow result`, `workflow reconcile`, `herdr agent focus`, and exact fixture paths;
- never send an unapproved retry/follow-up;
- never close the real worker automatically.

- [ ] **Step 5: Document real and fake commands**

README must separate:

```bash
# No model/API call
npm run smoke:fixture -- --agent pi --keep

# Real model/API call; typed confirmation required
npm run smoke:fixture -- --real --agent pi --keep
npm run smoke:fixture -- --real --agent claude --keep
npm run smoke:fixture -- --real --agent codex --keep
```

Document how to inspect preserved failures and how to explicitly remove an owned fixture later. State that these commands never use registered projects or Asana.

- [ ] **Step 6: Run fake checks before any real canary**

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
npm run smoke:fixture -- --agent pi --project single --keep
```

Expected: all pass. Inspect the kept fake fixture and then explicitly remove it using its printed ID.

- [ ] **Step 7: Run real canaries sequentially with checkpoints**

Never run these concurrently. For each harness:

1. Show the command and obtain explicit user approval for token use.
2. Run with `--keep`.
3. Inspect run/result/reconcile, Git diff, tests, and Herdr worker.
4. Record native hook/session behavior and any manual prompt.
5. Fix any bug through a failing automated/fake smoke test first.
6. Re-run that harness only after review.

Commands:

```bash
npm run smoke:fixture -- --real --agent pi --keep
npm run smoke:fixture -- --real --agent claude --keep
npm run smoke:fixture -- --real --agent codex --keep
```

A real canary that asks for permission may wait for the user in its Herdr workspace. Never auto-approve. A missing handoff must fall back to `manual-handoff-required`, not terminal scraping.

- [ ] **Step 8: Commit Task 4**

```bash
git add scripts/smoke-workflow-fixture.js test/workflow-real-canary.test.js README.md test/workflow-docs.test.js package.json package-lock.json
git commit -m "test(workflow): add opt-in real harness canaries"
```

Do not commit generated fixture roots, run state, sessions, hook trust state, or canary output.

---

## Final Acceptance and Handoff

Run with fresh evidence:

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
node bin/workflow.js doctor --format compact
node bin/workflow.js hooks doctor --format compact
pi list
```

Then complete:

1. Real-Herdr fake-worker smoke for ordinary and group projects.
2. Sequential real Pi/Claude/Codex canaries, each separately approved and preserved for inspection.
3. Fresh specification-compliance review of all three implementation stages.
4. Fresh code-quality/security review emphasizing prompts, permissions, hooks, state modes, process identity, cleanup ownership, and false success.
5. Review the complete diff from the pre-feature base commit.
6. Record test count, versions, canary run IDs, preserved fixture paths, known limitations, and next action.

Do not merge, push, close real workspaces, delete feature worktrees/branches, or remove preserved canary fixtures without a separate explicit decision.
