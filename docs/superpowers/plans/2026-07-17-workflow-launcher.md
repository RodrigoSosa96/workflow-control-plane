# Workflow Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic `workflow` CLI that plans, creates, resumes, and inspects isolated Git worktrees, Herdr workspaces/tabs, named Pi sessions, runtime panes, and Acme multi-repository ticket bundles.

**Architecture:** A versioned YAML registry feeds a pure planner. Injected Git and Herdr adapters collect read-only facts and execute an immutable ordered plan; the CLI exposes `doctor`, `plan`, `start`, `runtime`, and `status`. Ordinary repositories use Herdr-native worktree workspaces, while Acme uses a meta-repository worktree containing independent child Git worktrees.

**Tech Stack:** Node.js 24, ES modules, `node:test`, `yaml` npm package, Git CLI, Herdr JSON CLI, Pi CLI.

## Global Constraints

- Follow strict red-green-refactor TDD for every production behavior.
- `workflow plan`, `workflow doctor`, and `workflow status` are read-only.
- `workflow start` and `workflow runtime` require interactive confirmation or `--yes`.
- Never run fetch, rebase, reset, push, merge, worktree removal, branch deletion, deployment, or Asana writes.
- Never infer Acme child repositories without displaying them in the plan.
- Never submit an implementation prompt to Pi automatically.
- Use argv arrays for Git, Herdr, and Pi; ticket text must never become shell command text.
- Commands executed through `herdr pane run` come only from trusted `projects.yaml` runtime configuration.
- Bound subprocess stdout/stderr included in errors to 12,000 characters per stream.
- Security: never read or print `.env`, Asana tokens, auth stores, cookies, Git credential helpers, or unrelated environment variables.
- Do not modify Herdr core or require a third-party Herdr plugin.
- Verification must include unit tests, adapter tests, disposable integration tests, and an opt-in real-Herdr smoke test.
- Do not initialize or modify the real Acme root during this plan; real meta-repository setup requires a separate explicit checkpoint after disposable integration tests pass.

---

## Planned File Structure

```text
bin/
  workflow.js                 CLI parsing, confirmation, dispatch, exit categories
src/workflow/
  errors.js                   Stable typed workflow errors and output bounds
  registry.js                 YAML loading, v2 validation, project resolution
  naming.js                   Sanitization and template expansion
  planner.js                  Pure ordinary/Acme plan construction
  process.js                  Injected argv subprocess executor
  git.js                      Read-only Git facts and safe worktree creation
  herdr.js                    Herdr JSON command adapter
  reconcile.js                Compatible/missing/conflicting resource decisions
  execute.js                  Ordered start/runtime coordinator
  commands.js                 doctor/plan/start/runtime/status use cases
  format.js                   Compact and normalized JSON output

test/
  workflow-registry.test.js
  workflow-planner.test.js
  workflow-process.test.js
  workflow-git.test.js
  workflow-herdr.test.js
  workflow-reconcile.test.js
  workflow-execute.test.js
  workflow-commands.test.js
  workflow-cli.test.js
  workflow-docs.test.js
```

---

### Task 1: Version 2 Registry and Package Entry Point

**Files:**
- Modify: `package.json`
- Modify: `projects.yaml`
- Create: `src/workflow/errors.js`
- Create: `src/workflow/registry.js`
- Create: `test/workflow-registry.test.js`

**Interfaces:**
- Produces `WorkflowError extends Error` with `{ category, exitCode, details? }`.
- Produces `loadRegistry(path, { readFile? }) -> Promise<Registry>`.
- Produces `validateRegistry(value) -> Registry`.
- Produces `resolveProject(registry, alias) -> Project`.
- Registry version is exactly `2` and implements the schema in the approved design.

- [ ] **Step 1: Write failing registry tests**

Create `test/workflow-registry.test.js` with real temporary YAML files. Cover valid ordinary and group projects, `~` expansion, unknown version, unknown placeholders, duplicate runtime process ids, invalid split/ratio, missing group coordination, and unknown alias.

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRegistry, resolveProject } from "../src/workflow/registry.js";

const valid = {
  version: 2,
  launcher: {
    worktree_root: "/tmp/worktrees",
    agent: { command: "pi", session_template: "{project}-{task}-{slug}" },
  },
  projects: {
    ocr: {
      label: "OCR",
      path: "/repo/ocr",
      repository: "monorepo",
      base_branch: "dev",
      worktree: {
        branch_template: "feature/{task}/{slug}",
        path_template: "{worktree_root}/{project}/{task}-{slug}",
      },
      runtime: {
        default_profile: "standard",
        profiles: { standard: { processes: [{ id: "api", cwd: ".", command: "pnpm dev:api" }] } },
      },
    },
  },
};

test("validates a version 2 ordinary project", () => {
  assert.equal(validateRegistry(valid).projects.ocr.base_branch, "dev");
});

test("rejects unknown template placeholders", () => {
  const value = structuredClone(valid);
  value.projects.ocr.worktree.branch_template = "feature/{unknown}";
  assert.throws(() => validateRegistry(value), /unknown placeholder.*unknown/i);
});

test("resolves a registered project and rejects unknown aliases", () => {
  const registry = validateRegistry(valid);
  assert.equal(resolveProject(registry, "ocr").label, "OCR");
  assert.throws(() => resolveProject(registry, "missing"), /Unknown workflow project/);
});
```

- [ ] **Step 2: Run registry tests and verify RED**

Run: `node --test test/workflow-registry.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/workflow/registry.js`.

- [ ] **Step 3: Add the YAML dependency and bin declaration**

Run: `npm install yaml@^2.8.1`

Modify `package.json` to preserve `asana-workflow`, add `workflow`, and retain `node --test`:

```json
{
  "bin": {
    "asana-workflow": "./bin/asana-workflow.js",
    "workflow": "./bin/workflow.js"
  },
  "dependencies": {
    "yaml": "^2.8.1"
  }
}
```

Commit the generated `package-lock.json`; do not use an unpinned manual dependency entry.

- [ ] **Step 4: Implement registry validation**

Implement `WorkflowError`, YAML loading with `parse` from `yaml`, home expansion, exact version checking, placeholder allowlists, project-kind validation, runtime defaults, and immutable normalized output.

```js
export class WorkflowError extends Error {
  constructor(category, message, { exitCode = 1, details } = {}) {
    super(message);
    this.name = "WorkflowError";
    this.category = category;
    this.exitCode = exitCode;
    this.details = details;
  }
}
```

`validateRegistry` must clone input and must not mutate parser-owned objects.

- [ ] **Step 5: Migrate `projects.yaml` to version 2**

Add `launcher`, ordinary worktree templates, structured runtime profiles, and Acme coordination/child branch templates. Preserve all existing project paths and verification commands. Change Acme child base branches to `dev`, matching the currently observed `origin/dev`; add a registry test asserting those values.

- [ ] **Step 6: Run registry and existing tests**

Run: `node --test test/workflow-registry.test.js test/config.test.js test/docs.test.js`
Expected: all selected tests pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add package.json package-lock.json projects.yaml src/workflow/errors.js src/workflow/registry.js test/workflow-registry.test.js
git commit -m "feat(workflow): add versioned project registry"
```

---

### Task 2: Safe Naming and Pure Launch Planning

**Files:**
- Create: `src/workflow/naming.js`
- Create: `src/workflow/planner.js`
- Create: `test/workflow-planner.test.js`

**Interfaces:**
- Produces `slugify(value) -> string`.
- Produces `normalizeTask(value) -> string`.
- Produces `expandTemplate(template, values) -> string`.
- Produces `planWorkflow({ registry, projectAlias, task, feature?, repositories?, runtimeProfile? }) -> LaunchPlan`.
- `LaunchPlan` contains `mode`, `identity`, `repositories`, `worktrees`, `workspace`, `tabs`, `agent`, `runtime`, and ordered `operations`.

- [ ] **Step 1: Write failing naming and ordinary-plan tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify, expandTemplate } from "../src/workflow/naming.js";
import { planWorkflow } from "../src/workflow/planner.js";

test("sanitizes user text before branch and path expansion", () => {
  assert.equal(slugify("Discovered Docs / Filters $(touch bad)"), "discovered-docs-filters-touch-bad");
  assert.equal(expandTemplate("feature/{task}/{slug}", {
    task: "ASANA-123", slug: "discovered-docs", project: "ocr", worktree_root: "/wt",
  }), "feature/ASANA-123/discovered-docs");
});

test("plans an ordinary native Herdr worktree", () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  assert.equal(plan.mode, "ordinary");
  assert.equal(plan.worktrees[0].branch, "feature/ASANA-123/discovered-docs");
  assert.equal(plan.agent.sessionName, "ocr-ASANA-123-discovered-docs");
  assert.deepEqual(plan.tabs.map((tab) => tab.label), ["agent", "runtime"]);
});
```

Also test bounded labels, empty slug rejection, path traversal rejection, runtime profile resolution, and that task text never appears in runtime command strings.

- [ ] **Step 2: Run planner tests and verify RED**

Run: `node --test test/workflow-planner.test.js`
Expected: FAIL because naming/planner modules do not exist.

- [ ] **Step 3: Implement naming helpers**

Use Unicode normalization followed by an ASCII-safe allowlist. Reject results that are empty, `.`/`..`, absolute, or contain traversal segments. `expandTemplate` must replace only validated placeholders and throw when any braces remain.

- [ ] **Step 4: Implement ordinary planning**

Return plain JSON-compatible data with no functions or subprocess handles. Include explicit operations such as:

```js
{
  id: "worktree",
  kind: "herdr.worktree.ensure",
  cwd: project.path,
  branch,
  base: project.base_branch,
  path: worktreePath,
  label: workspaceLabel,
}
```

The runtime tab belongs in the plan but its operations have phase `runtime`; `start` must execute only phase `start`.

- [ ] **Step 5: Add Acme plan tests and implementation**

Test one, two, and three selected child repositories; missing `--repos`; unknown repository alias; deterministic repository ordering; meta worktree plus nested `repos/<alias>` paths; and repository-specific base/branch values.

```js
test("plans a synchronized Acme backend and panel bundle", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["panel", "backend"],
  });
  assert.equal(plan.mode, "group");
  assert.deepEqual(plan.repositories.map((repo) => repo.alias), ["backend", "panel"]);
  assert.match(plan.repositories[0].worktreePath, /repos\/backend$/);
  assert.deepEqual(plan.tabs.map((tab) => tab.label), ["coordinator", "backend", "panel", "runtime"]);
});
```

Implement group planning without filesystem mutation.

- [ ] **Step 6: Run planner tests and verify GREEN**

Run: `node --test test/workflow-planner.test.js`
Expected: all planner tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/workflow/naming.js src/workflow/planner.js test/workflow-planner.test.js
git commit -m "feat(workflow): plan isolated project environments"
```

---

### Task 3: Bounded Process and Git Adapters

**Files:**
- Create: `src/workflow/process.js`
- Create: `src/workflow/git.js`
- Create: `test/workflow-process.test.js`
- Create: `test/workflow-git.test.js`

**Interfaces:**
- Produces `createProcessRunner({ spawnImpl? })` with `run(command, args, options)`.
- `run` returns `{ code, stdout, stderr }` and supports `cwd`, `env`, `timeoutMs`, and `allowFailure`.
- Produces `createGitAdapter({ runner })` with `inspectRepository`, `listWorktrees`, `refExists`, `status`, and `createWorktree`.

- [ ] **Step 1: Write and fail process-runner tests**

Test argv preservation with malicious-looking text, bounded output, timeout categorization, spawn errors, and nonzero exits.

```js
test("passes arguments without shell interpolation", async () => {
  const calls = [];
  const runner = createProcessRunner({ spawnImpl: fakeSpawn(calls) });
  await runner.run("git", ["check-ref-format", "branch", "$(touch /tmp/bad)"]);
  assert.deepEqual(calls[0].args, ["check-ref-format", "branch", "$(touch /tmp/bad)"]);
  assert.equal(calls[0].options.shell, false);
});
```

Run: `node --test test/workflow-process.test.js`
Expected: FAIL because `src/workflow/process.js` is missing.

- [ ] **Step 2: Implement and verify the process runner**

Use `spawn`, collect buffers up to 12,000 characters per stream, kill on timeout, and throw `WorkflowError("PROCESS", ...)` with bounded diagnostics.

Run: `node --test test/workflow-process.test.js`
Expected: all process tests pass.

- [ ] **Step 3: Write and fail Git adapter tests**

Use a fake runner for argv assertions and temporary real repositories for porcelain parsing. Cover normal checkout versus linked worktree, branch/path occupancy, local ref existence, dirty state, and child worktree creation.

Run: `node --test test/workflow-git.test.js`
Expected: FAIL because `src/workflow/git.js` is missing.

- [ ] **Step 4: Implement the Git adapter**

Use:

```text
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git worktree list --porcelain -z
git show-ref --verify --quiet refs/heads/<branch>
git rev-parse --verify --quiet <base>^{commit}
git status --porcelain=v1 -z
git worktree add <path> <existing-branch>
git worktree add -b <branch> <path> <base>
```

Never invoke remote commands. Before `createWorktree`, require the caller's reconciliation result to be `missing`.

- [ ] **Step 5: Run adapter and full tests**

Run: `node --test test/workflow-process.test.js test/workflow-git.test.js`
Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/workflow/process.js src/workflow/git.js test/workflow-process.test.js test/workflow-git.test.js
git commit -m "feat(workflow): add safe git process adapters"
```

---

### Task 4: Herdr JSON Adapter

**Files:**
- Create: `src/workflow/herdr.js`
- Create: `test/workflow-herdr.test.js`

**Interfaces:**
- Produces `createHerdrAdapter({ runner, binary? })`.
- Methods: `status`, `integrationStatus`, `listWorkspaces`, `getWorkspace`, `listTabs`, `listPanes`, `listAgents`, `ensureNativeWorktree`, `createTab`, `renameTab`, `renamePane`, `splitPane`, `runInPane`, and `startAgent`.
- Creation methods return IDs parsed from Herdr JSON and never derive IDs from labels.

- [ ] **Step 1: Write failing Herdr parsing tests**

Test JSON success envelopes, API error envelopes, malformed output, native worktree `created`, `opened`, and `already_open` responses, and extraction of workspace/tab/root pane IDs.

```js
test("returns IDs from a native worktree response", async () => {
  const herdr = createHerdrAdapter({ runner: fixtureRunner({
    result: {
      type: "worktree_created",
      workspace: { workspace_id: "w2", cwd: "/wt/task" },
      tab: { tab_id: "w2:t1" },
      root_pane: { pane_id: "w2:p1" },
    },
  }) });
  const result = await herdr.ensureNativeWorktree(planOp);
  assert.deepEqual(result, { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", disposition: "created" });
});
```

- [ ] **Step 2: Run Herdr tests and verify RED**

Run: `node --test test/workflow-herdr.test.js`
Expected: FAIL because `src/workflow/herdr.js` is missing.

- [ ] **Step 3: Implement read-only and creation wrappers**

Every invocation uses `herdr <area> <command> ...`; process-launching options explicitly pass `--focus` or `--no-focus`. `runInPane` accepts only a registry-sourced command and calls `herdr pane run <pane> <command>`.

- [ ] **Step 4: Implement native worktree ensure behavior**

The coordinator provides the prior reconciliation decision. On `missing`, call `herdr worktree create --cwd ... --branch ... --base ... --path ... --label ... --json`. On `closed`, call `herdr worktree open --cwd ... --path ... --label ... --json`. On `open`, return discovered IDs without mutation.

- [ ] **Step 5: Run Herdr and existing tests**

Run: `node --test test/workflow-herdr.test.js test/workflow-process.test.js`
Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/workflow/herdr.js test/workflow-herdr.test.js
git commit -m "feat(workflow): add Herdr orchestration adapter"
```

---

### Task 5: Reconciliation, Doctor, Plan, and Status

**Files:**
- Create: `src/workflow/reconcile.js`
- Create: `src/workflow/commands.js`
- Create: `src/workflow/format.js`
- Create: `test/workflow-reconcile.test.js`
- Create: `test/workflow-commands.test.js`

**Interfaces:**
- Produces `reconcilePlan(plan, { git, herdr }) -> ReconciledPlan`.
- Every resource is classified `missing`, `compatible`, `incomplete`, or `conflict` with a concrete reason.
- Produces `doctorCommand`, `planCommand`, and `statusCommand`.
- Produces `formatWorkflowResult(command, value, format)`.

- [ ] **Step 1: Write and fail reconciliation tests**

Cover compatible existing worktree, same branch at wrong path, wrong repository at planned path, closed Herdr workspace, missing runtime tab, duplicate runtime process, and Acme child mismatch.

Run: `node --test test/workflow-reconcile.test.js`
Expected: FAIL because reconciliation module is missing.

- [ ] **Step 2: Implement reconciliation**

Use Git common directory + branch + canonical path as worktree identity. Use Herdr cwd + optional worktree provenance as workspace identity. Labels are presentation only and cannot establish compatibility.

- [ ] **Step 3: Write and fail command tests**

Inject registry loader, Git adapter, Herdr adapter, and executable lookup. Assert:

- `doctor` reports every prerequisite without mutation.
- `plan` returns ordered operations and conflicts.
- `status` reports actual state and a safe next command.
- Compact output is bounded and JSON output is normalized.

Run: `node --test test/workflow-commands.test.js`
Expected: FAIL because command/format modules are missing.

- [ ] **Step 4: Implement read-only commands and formatting**

`doctor` must check the Herdr Pi integration only for agent launch readiness; `plan` remains usable when Pi is absent and reports that precondition. `status` never attempts repair.

- [ ] **Step 5: Run Task 5 tests**

Run: `node --test test/workflow-reconcile.test.js test/workflow-commands.test.js`
Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/workflow/reconcile.js src/workflow/commands.js src/workflow/format.js test/workflow-reconcile.test.js test/workflow-commands.test.js
git commit -m "feat(workflow): inspect and reconcile launch plans"
```

---

### Task 6: Ordinary Worktree and Named Pi Session Execution

**Files:**
- Create: `src/workflow/execute.js`
- Create: `test/workflow-execute.test.js`

**Interfaces:**
- Produces `executeStart(reconciledPlan, { git, herdr }) -> ExecutionReport`.
- Execution reports ordered operation dispositions and recovery guidance.
- Compatible completed operations are reused; conflicts prevent all mutation.

- [ ] **Step 1: Write and fail ordinary execution tests**

Test fresh create, already-open reuse, closed workspace reopen, failure after worktree before tab preparation, rerun recovery, conflict refusal before mutation, and that no Pi prompt is sent.

```js
test("creates native worktree and starts a named Pi session without a prompt", async () => {
  const calls = [];
  const report = await executeStart(reconciledPlan, fakeAdapters(calls));
  assert.deepEqual(calls.map((call) => call.kind), [
    "herdr.worktree.create", "herdr.tab.rename", "herdr.agent.start", "herdr.pane.close",
  ]);
  const launch = calls.find((call) => call.kind === "herdr.agent.start");
  assert.deepEqual(launch.argv, ["pi", "--name", "ocr-ASANA-123-discovered-docs"]);
  assert.doesNotMatch(JSON.stringify(calls), /start-feature|implement/i);
  assert.equal(report.operations.at(-1).status, "created");
});
```

- [ ] **Step 2: Run execution tests and verify RED**

Run: `node --test test/workflow-execute.test.js`
Expected: FAIL because `src/workflow/execute.js` is missing.

- [ ] **Step 3: Implement ordered start execution**

Before mutation, reject any conflict. Ensure the native worktree workspace, rename the initial tab to `agent`, then call `herdr agent start <session-name> --tab <tab-id> -- pi --name <session-name>` so Pi receives argv without shell interpolation. After Herdr returns the new agent pane, close the original bootstrap shell pane only when it is still the untouched idle root pane and the Pi pane is confirmed present. If that safety check fails, retain the shell pane instead of risking the agent tab.

Use Herdr's returned workspace/tab/pane IDs. On any failure, retain successful resources and return inspection/rerun guidance.

- [ ] **Step 4: Run execution tests and full suite**

Run: `node --test test/workflow-execute.test.js`
Expected: all execution tests pass.

Run: `npm test`
Expected: all repository tests pass.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/workflow/execute.js test/workflow-execute.test.js
git commit -m "feat(workflow): launch isolated Pi workspaces"
```

---

### Task 7: Opt-In Runtime Tabs and Process Recovery

**Files:**
- Modify: `src/workflow/execute.js`
- Modify: `src/workflow/reconcile.js`
- Modify: `test/workflow-execute.test.js`
- Modify: `test/workflow-reconcile.test.js`

**Interfaces:**
- Produces `executeRuntime(reconciledPlan, { herdr, observeMs? }) -> ExecutionReport`.
- Uses `herdr pane process-info` to compare expected executable/command evidence.

- [ ] **Step 1: Add failing runtime tests**

Cover creating the runtime tab, deterministic splits, explicit cwd, labels, command launch, existing expected process reuse, stopped pane reporting, mismatched live process refusal, immediate exit, and one process failing while successful siblings remain.

```js
test("creates runtime panes from trusted registry commands", async () => {
  const calls = [];
  await executeRuntime(runtimePlan, fakeAdapters(calls));
  assert.equal(calls.find((call) => call.kind === "herdr.tab.create").cwd, runtimePlan.worktreePath);
  assert.deepEqual(calls.filter((call) => call.kind === "herdr.pane.run").map((call) => call.command), [
    "pnpm dev:api", "pnpm dev:front",
  ]);
});
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `node --test --test-name-pattern="runtime" test/workflow-execute.test.js test/workflow-reconcile.test.js`
Expected: FAIL because runtime execution/reconciliation is absent.

- [ ] **Step 3: Implement runtime reconciliation and execution**

Create or reuse the `runtime` tab. Create pane splits in registry order with planned directions/ratios/cwd. After `pane run`, wait a bounded observation period and inspect the pane process. Never replace a mismatched live process automatically.

- [ ] **Step 4: Run runtime and full tests**

Run: `node --test --test-name-pattern="runtime" test/workflow-execute.test.js test/workflow-reconcile.test.js`
Expected: runtime tests pass.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/workflow/execute.js src/workflow/reconcile.js test/workflow-execute.test.js test/workflow-reconcile.test.js
git commit -m "feat(workflow): launch isolated runtime layouts"
```

---

### Task 8: Acme Composite Bundle Execution

**Files:**
- Modify: `src/workflow/execute.js`
- Modify: `src/workflow/commands.js`
- Create: `test/workflow-acme.test.js`

**Interfaces:**
- Group start ensures the meta worktree through Herdr, then child worktrees through the Git adapter under `<meta-worktree>/repos/<alias>`.
- Produces a machine-local execution report; it does not commit runtime IDs.
- V1 starts only the coordinator Pi session.

- [ ] **Step 1: Write and fail disposable Acme bundle tests**

Create four temporary repositories: one meta repository and backend/panel/webapp children. Test selected two-repo creation, three-repo creation, deterministic order, existing child reuse, failure in the second child with recovery on rerun, wrong-child-repository conflict, coordinator/repository/runtime tabs, and coordinator-only Pi launch.

```js
test("creates selected child worktrees inside one Acme task workspace", async () => {
  const report = await executeStart(reconciledGroupPlan, adapters);
  assert.equal(await gitBranch(join(metaWorktree, "repos/backend")), "feature/ASANA-456/onboarding");
  assert.equal(await gitBranch(join(metaWorktree, "repos/panel")), "feature/ASANA-456/onboarding");
  assert.equal(await pathExists(join(metaWorktree, "repos/webapp")), false);
  assert.deepEqual(report.repositories.map((repo) => repo.alias), ["backend", "panel"]);
});
```

- [ ] **Step 2: Run Acme tests and verify RED**

Run: `node --test test/workflow-acme.test.js`
Expected: FAIL because group execution is not implemented.

- [ ] **Step 3: Implement composite execution**

Use Herdr native worktree creation for the meta repository. Use `git.createWorktree` for each selected child. Create repository tabs rooted at child worktrees. Rename the initial tab to `coordinator`, launch the named Pi coordinator there, and leave child tabs as shells. Do not initialize a missing meta repository; return `PREFLIGHT` with setup instructions.

- [ ] **Step 4: Add and verify a cross-repository coordination template**

Have planning expose a suggested manifest payload containing ticket, selected repositories, branches, integration order, and verification commands. Do not write or commit the manifest automatically in v1; print its target path and payload for the coordinator to review.

Run: `node --test test/workflow-acme.test.js test/workflow-planner.test.js`
Expected: all Acme tests pass.

- [ ] **Step 5: Run full suite and commit Task 8**

Run: `npm test`
Expected: all tests pass.

```bash
git add src/workflow/execute.js src/workflow/commands.js test/workflow-acme.test.js test/workflow-planner.test.js
git commit -m "feat(workflow): coordinate Acme ticket bundles"
```

---

### Task 9: CLI, Confirmation, Installation, and Documentation

**Files:**
- Create: `bin/workflow.js`
- Create: `test/workflow-cli.test.js`
- Create: `test/workflow-docs.test.js`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.pi/prompts/start-feature.md`
- Modify: `.pi/prompts/resume-feature.md`

**Interfaces:**
- CLI parser accepts commands from the approved design and options `--repos`, `--profile`, `--feature`, `--format compact|json`, and `--yes` only where applicable.
- Stable exit categories: `USAGE=64`, `CONFIG=3`, `PREFLIGHT=10`, `CONFLICT=11`, `PROCESS=12`, `PARTIAL=13`.

- [ ] **Step 1: Write failing CLI tests**

Test exact parsing, unknown/duplicate options, Acme CSV repositories, compact/JSON output, `--yes` rejection on read-only commands, interactive confirmation decline, noninteractive refusal without `--yes`, error categories, bounded output, and executable symlink invocation.

```js
test("requires explicit approval for mutation", async () => {
  const output = io();
  const code = await main(["start", "ocr", "ASANA-123", "--feature", "Discovered Docs"], {
    ...output,
    isInteractive: () => false,
  });
  assert.equal(code, 64);
  assert.match(output.stderr[0], /--yes/);
});
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `node --test test/workflow-cli.test.js`
Expected: FAIL because `bin/workflow.js` is missing.

- [ ] **Step 3: Implement CLI dispatch**

Load `projects.yaml` relative to the package root unless `WORKFLOW_PROJECTS_FILE` selects another registry. Confirmation displays the reconciled plan before accepting. The CLI calls only read-only commands until confirmation succeeds.

- [ ] **Step 4: Run CLI tests and verify GREEN**

Run: `node --test test/workflow-cli.test.js`
Expected: all CLI tests pass.

- [ ] **Step 5: Write failing documentation tests**

Assert README documents `doctor`, dry-run planning, ordinary start, runtime opt-in, Acme `--repos`, safety boundaries, and the separate real meta-repository checkpoint. Assert workflow stages include Plan between Design and Isolation.

- [ ] **Step 6: Update documentation and prompts**

Document:

```text
workflow doctor ocr
workflow plan ocr ASANA-123 --feature "Discovered Docs"
workflow start ocr ASANA-123 --feature "Discovered Docs" --yes
workflow runtime ocr ASANA-123 --feature "Discovered Docs" --profile standard --yes
workflow status ocr ASANA-123 --feature "Discovered Docs"
workflow plan acme ASANA-456 --feature Onboarding --repos backend,panel
```

Update prompts to invoke `workflow plan` only after approved design/plan, request confirmation before `start`, and use `status` for recovery. Do not make prompts auto-approve with `--yes`.

- [ ] **Step 7: Run docs and full tests**

Run: `node --test test/workflow-docs.test.js test/docs.test.js`
Expected: documentation tests pass.

Run: `npm test`
Expected: all repository tests pass with zero failures.

- [ ] **Step 8: Commit Task 9**

```bash
git add bin/workflow.js test/workflow-cli.test.js test/workflow-docs.test.js README.md AGENTS.md .pi/prompts/start-feature.md .pi/prompts/resume-feature.md
git commit -m "feat(workflow): expose deterministic launcher CLI"
```

---

### Task 10: Disposable Real-Herdr Smoke Test and Handoff

**Files:**
- Modify only if failures require TDD fixes to files already listed.
- Do not modify `/home/you/projects/work/acme` in this task.

**Interfaces:**
- Validates the installed Herdr `0.7.x` CLI and Pi integration against disposable Git repositories.

- [ ] **Step 1: Run all static verification**

```bash
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: tests pass; both bins, runtime sources, lockfile, docs, prompts, and skills are included as intended; no whitespace errors; only intended changes remain.

- [ ] **Step 2: Create disposable repositories outside project trees**

Create temporary ordinary/meta/backend/panel repositories under `mktemp -d`, each with one committed file and the configured base branch. Never copy real project source or credentials.

- [ ] **Step 3: Run read-only commands against a temporary registry**

```bash
WORKFLOW_PROJECTS_FILE=/tmp/.../projects.yaml workflow doctor disposable
WORKFLOW_PROJECTS_FILE=/tmp/.../projects.yaml workflow plan disposable TEST-1 --feature smoke
```

Expected: doctor succeeds and plan reports one native worktree workspace plus agent tab, with no mutation before `start`.

- [ ] **Step 4: Start and recover an ordinary environment**

Run `workflow start ... --yes`, inspect with `herdr worktree list`, `herdr tab list`, and `herdr agent list`, then run the same start command again.

Expected: first run creates; second run reuses; Pi has the planned name and receives no initial implementation prompt.

- [ ] **Step 5: Start and recover a disposable Acme-style bundle**

Use the temporary meta/backend/panel repositories and `--repos backend,panel`.

Expected: one Herdr meta child workspace contains coordinator/backend/panel/runtime tabs; child Git worktrees are nested under `repos`; rerun reuses all compatible resources.

- [ ] **Step 6: Verify cleanup remains manual**

Run `workflow status` and inspect the handoff. Close/remove disposable resources manually with Herdr/Git only after confirming their paths are inside the temporary directory. Confirm the CLI itself never exposes a remove operation.

- [ ] **Step 7: Request code review and apply only verified fixes**

Invoke `superpowers:requesting-code-review` against the complete branch diff. For every accepted issue, write a failing regression test, verify RED, implement the fix, and verify GREEN.

- [ ] **Step 8: Final verification commit if needed**

If review fixes changed files:

```bash
git add bin/workflow.js src/workflow test README.md AGENTS.md .pi/prompts package.json package-lock.json projects.yaml
git commit -m "fix(workflow): address launcher review"
```

Then rerun `npm test`, `npm pack --dry-run`, and `git diff --check` before branch handoff.

---

## Separate Post-Implementation Checkpoint: Real Acme Meta-Repository

After Task 10 passes and Rodrigo explicitly approves modifying the work project, create a separate spec/plan or tightly scoped setup checklist for `/home/you/projects/work/acme` that:

1. Audits and protects existing dirty/untracked child repository files.
2. Creates a parent `.gitignore` that excludes all three child checkouts and generated bundle paths before any `git add`.
3. Initializes the meta-repository without submodules.
4. Adds only shared `AGENTS.md`, `README.md`, registry, and coordination-document structure.
5. Verifies each child remains an independent repository with unchanged remotes and status.
6. Configures a private remote only with explicit approval.
7. Validates one real approved cross-repository ticket with `workflow plan` before creating worktrees.

This checkpoint is intentionally not executed as part of the launcher code branch.
