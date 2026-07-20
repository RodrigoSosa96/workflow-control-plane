# Multi-Harness Launch Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic agent profiles, primary/related ticket bundles, private run state, structured handoffs, and a separately confirmed `workflow launch` path for Pi, Claude Code, and Codex.

**Architecture:** Registry v3 resolves a concrete allowed agent profile and a normalized ticket bundle into the existing pure workflow plan. Focused run-store, handoff, assignment, and harness modules layer on top of existing Git/Herdr adapters; `workflow launch` reuses the environment executor but supplies a profile-specific argv/env factory and persists a non-blocking run.

**Tech Stack:** Node.js 24 ES modules, `node:test`, YAML 2.8, Git CLI, Herdr 0.7.4 JSON CLI, Pi 0.80+, Claude Code 2.1+, Codex CLI 0.144+.

## Global Constraints

- Follow strict red-green-refactor TDD for every production behavior.
- Preserve `workflow start`: it must not deliver an implementation prompt.
- `workflow launch` must be a separate command with exact assignment preview and explicit confirmation.
- A non-interactive mutating launch fails closed without `--yes`; separately previewed launches must supply the recomputed approval digest.
- Preserve the original user request verbatim in the assignment; ticket context is not implementation permission.
- All tickets in one checkout must be explicitly supplied, belong to one project, and use the primary ticket for branch/worktree/session identity.
- Never launch more than one writing agent in the same checkout.
- Never scrape terminal content for result data.
- Use argv arrays and explicit env entries; never execute ticket, prompt, or model output as shell.
- Reject Claude permission bypasses and Codex `danger-full-access`, approval bypasses, and hook-trust bypasses.
- Never fetch, rebase, reset, push, merge, deploy, mutate Asana/production, delete branches/worktrees, close workspaces, or terminate agents automatically.
- Store run data outside target repositories under an absolute XDG-style state root with directories `0700` and files `0600`.
- Do not initialize or modify the real Acme meta-repository.
- Bound diagnostics to 12,000 characters and assignment/result inputs to explicit byte limits.
- Never read or expose `.env`, credentials, auth stores, cookies, unrelated environment variables, or raw credential-bearing Git configuration.
- End every task with focused tests, the full `npm test`, `git diff --check`, a specification review, and a code-quality review before beginning the next task.

---

## Planned File Structure

```text
projects.yaml                         Registry v3 profiles and defaults
bin/workflow.js                       New CLI options and launch/result/handoff commands
src/workflow/
  registry.js                         v2 migration and v3 profile schema
  profiles.js                         Profile selection and forbidden-argument policy
  tickets.js                          Primary/related ticket normalization
  planner.js                          Ticket/profile-aware environment plans
  commands.js                         Profile-aware doctor/plan/status and launch use cases
  run-state.js                        Closed run-state transition rules
  run-store.js                        Private atomic run persistence and locking
  assignment.js                       Verbatim request envelope and approval digest
  handoff.js                          Handoff input/result validation and submission
  harnesses.js                        Pi/Claude/Codex argv and env builders
  launch.js                           Preview and confirmed non-blocking launch coordinator
  execute.js                          Injectable generic agent launch spec
  git.js                              HEAD/status fingerprints
  herdr.js                            Agent env support
  reconcile.js                        Generic harness/process ownership reconciliation
  format.js                           Compact launch/run output

test/
  workflow-profiles.test.js
  workflow-tickets.test.js
  workflow-run-store.test.js
  workflow-handoff.test.js
  workflow-harnesses.test.js
  workflow-launch.test.js
  workflow-cli.test.js                Extended
  workflow-planner.test.js            Extended
  workflow-commands.test.js           Extended
  workflow-execute.test.js            Extended
  workflow-reconcile.test.js          Extended
  workflow-registry.test.js            Extended
```

---

### Task 1: Registry v3 and Safe Agent Profiles

**Files:**
- Create: `src/workflow/profiles.js`
- Create: `test/workflow-profiles.test.js`
- Modify: `src/workflow/registry.js`
- Modify: `test/workflow-registry.test.js`
- Modify: `projects.yaml`

**Interfaces:**
- Produces `resolveAgentProfile({ registry, project, requestedProfile? }) -> { name, source, profile }`.
- Produces `validateAgentProfile(name, value) -> normalizedProfile` from `registry.js` internals.
- Registry v2 inputs normalize to in-memory version 3 with a generated Pi profile.
- Registry v3 contains `state_root`, `default_agent_profile`, `agent_profiles`, and `max_bundle_tickets`.

- [ ] **Step 1: Write failing profile-policy tests**

Create `test/workflow-profiles.test.js` with a minimal v3 registry and these exact assertions:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRegistry } from "../src/workflow/registry.js";
import { resolveAgentProfile } from "../src/workflow/profiles.js";

function registryValue() {
  return {
    version: 3,
    launcher: {
      worktree_root: "/tmp/worktrees",
      state_root: "/tmp/workflow-state",
      session_template: "{project}-{task}-{slug}",
      default_agent_profile: "pi-worker",
      max_bundle_tickets: 10,
      agent_profiles: {
        "pi-worker": { harness: "pi", command: "pi", mode: "interactive", roles: ["implementer"], arguments: [] },
        "claude-worker": { harness: "claude", command: "claude", mode: "interactive", roles: ["implementer"], permission_mode: "manual", arguments: [] },
        "codex-worker": { harness: "codex", command: "codex", mode: "interactive", roles: ["implementer"], sandbox: "workspace-write", approval_policy: "on-request", arguments: [] },
      },
    },
    projects: {
      app: {
        label: "App", kind: "personal", path: "/repo/app", repository: "single", base_branch: "main",
        default_agent_profile: "pi-worker",
        allowed_agent_profiles: ["pi-worker", "codex-worker"],
        worktree: { branch_template: "feature/{task}/{slug}", path_template: "{worktree_root}/{project}/{task}-{slug}" },
      },
    },
  };
}

test("explicit allowed profile wins over project and global defaults", () => {
  const registry = validateRegistry(registryValue());
  assert.deepEqual(resolveAgentProfile({ registry, project: registry.projects.app, requestedProfile: "codex-worker" }), {
    name: "codex-worker",
    source: "explicit",
    profile: registry.launcher.agent_profiles["codex-worker"],
  });
});

test("rejects dangerous Claude and Codex profiles", () => {
  const claude = registryValue();
  claude.launcher.agent_profiles["claude-worker"].arguments = ["--dangerously-skip-permissions"];
  assert.throws(() => validateRegistry(claude), /dangerously-skip-permissions/i);

  const codex = registryValue();
  codex.launcher.agent_profiles["codex-worker"].sandbox = "danger-full-access";
  assert.throws(() => validateRegistry(codex), /danger-full-access/i);
});
```

Also cover unknown harness/profile fields, empty roles, non-string argv entries, `bypassPermissions`, `--allow-dangerously-skip-permissions`, Codex `approval_policy: never`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, project allowlists, and invalid defaults.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/workflow-profiles.test.js test/workflow-registry.test.js`

Expected: FAIL because version 3 and `profiles.js` are not implemented.

- [ ] **Step 3: Implement v3 normalization and profile selection**

Use closed sets:

```js
const HARNESSES = new Set(["pi", "claude", "codex"]);
const MODES = new Set(["interactive"]);
const CLAUDE_PERMISSION_MODES = new Set(["manual", "acceptEdits", "plan", "auto", "dontAsk"]);
const CODEX_SANDBOXES = new Set(["read-only", "workspace-write"]);
const CODEX_APPROVALS = new Set(["untrusted", "on-request"]);
```

`resolveAgentProfile` must use explicit → project default → global default, reject a requested profile outside `allowed_agent_profiles`, and return frozen registry-owned profile data without mutation.

For a version 2 registry, normalize:

```js
{
  version: 3,
  launcher: {
    worktree_root: old.launcher.worktree_root,
    state_root: join(homedir(), ".local/state/workflow-launcher"),
    session_template: old.launcher.agent.session_template,
    default_agent_profile: "pi-worker",
    max_bundle_tickets: 10,
    agent_profiles: {
      "pi-worker": {
        harness: "pi",
        command: old.launcher.agent.command,
        mode: "interactive",
        roles: ["coordinator", "implementer", "reviewer"],
        model: null,
        arguments: [],
      },
    },
  },
}
```

Do not accept version 1.

- [ ] **Step 4: Migrate the canonical registry**

Set `projects.yaml` to version 3. Add the three profiles with inherited models (`model: null`), Claude `manual`, and Codex `workspace-write`/`on-request`. Keep Pi as every project's default initially so existing `start` behavior remains unchanged. Preserve every current project path, branch, runtime, and verification command exactly.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/workflow-profiles.test.js test/workflow-registry.test.js test/config.test.js
npm test
```

Expected: all tests pass; existing v2 fixture tests pass through migration.

- [ ] **Step 6: Commit Task 1**

```bash
git add projects.yaml src/workflow/registry.js src/workflow/profiles.js test/workflow-registry.test.js test/workflow-profiles.test.js
git commit -m "feat(workflow): add safe agent profiles"
```

---

### Task 2: Primary and Related Ticket Bundles

**Files:**
- Create: `src/workflow/tickets.js`
- Create: `test/workflow-tickets.test.js`
- Modify: `src/workflow/planner.js`
- Modify: `src/workflow/commands.js`
- Modify: `bin/workflow.js`
- Modify: `test/workflow-planner.test.js`
- Modify: `test/workflow-commands.test.js`
- Modify: `test/workflow-cli.test.js`
- Modify: `test/workflow-acme.test.js`

**Interfaces:**
- Produces `normalizeTicketBundle({ primary, related?, maxTickets }) -> { primary, related, all }`.
- `planWorkflow` accepts `tickets?` and `agentProfile?` while preserving `identity.task` as the primary ticket.
- CLI option `--tickets <csv>` is accepted by `plan`, `start`, `runtime`, and `status`.

- [ ] **Step 1: Write failing bundle tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTicketBundle } from "../src/workflow/tickets.js";

 test("normalizes related tickets without changing primary identity", () => {
  assert.deepEqual(normalizeTicketBundle({
    primary: "SHARY-123",
    related: ["SHARY-152", "SHARY-140", "SHARY-140"],
    maxTickets: 10,
  }), {
    primary: "SHARY-123",
    related: ["SHARY-140", "SHARY-152"],
    all: ["SHARY-123", "SHARY-140", "SHARY-152"],
  });
});

test("rejects the primary in the related set and bounded overflow", () => {
  assert.throws(() => normalizeTicketBundle({ primary: "A-1", related: ["A-1"], maxTickets: 10 }), /primary/i);
  assert.throws(() => normalizeTicketBundle({ primary: "A-1", related: ["A-2", "A-3"], maxTickets: 2 }), /maximum.*2/i);
});
```

Also test empty identifiers, unsafe identifiers through `normalizeTask`, stable sorting, and a max lower than one.

- [ ] **Step 2: Verify RED**

Run: `node --test test/workflow-tickets.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement bundle normalization and planner identity**

Add to every plan identity:

```js
identity: {
  projectAlias,
  projectLabel: project.label,
  projectKind: project.kind,
  task: bundle.primary,
  primaryTicket: bundle.primary,
  relatedTickets: bundle.related,
  tickets: bundle.all,
  feature: feature ?? null,
  slug,
}
```

Continue using only `bundle.primary` in branch templates, paths, labels, and session names. Resolve the selected profile before building `plan.agent`, then add `profileName`, `harness`, `roles`, and a sanitized profile snapshot to `plan.agent`.

- [ ] **Step 4: Extend CLI and command propagation**

Add `tickets` to `KNOWN_OPTIONS`, parse CSV with the same normalization boundary as repositories, and propagate it to `planWorkflow`, `request`, `buildCommand`, and Acme's suggested manifest:

```js
if (options.tickets?.length) parts.push("--tickets", options.tickets.join(","));
```

The manifest payload must contain:

```js
{
  ticket: bundle.primary,
  tickets: bundle.all,
  relatedTickets: bundle.related,
}
```

- [ ] **Step 5: Add ordinary and Acme compatibility tests**

Assert that adding related tickets leaves all worktree paths and branches unchanged, while request/manifest/output includes all tickets. Assert `--repos` still applies once to the full Acme bundle and repository ordering remains deterministic.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/workflow-tickets.test.js test/workflow-planner.test.js test/workflow-commands.test.js test/workflow-cli.test.js test/workflow-acme.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add bin/workflow.js src/workflow/tickets.js src/workflow/planner.js src/workflow/commands.js test/workflow-tickets.test.js test/workflow-planner.test.js test/workflow-commands.test.js test/workflow-cli.test.js test/workflow-acme.test.js
git commit -m "feat(workflow): support primary ticket bundles"
```

---

### Task 3: Private Atomic Run Store

**Files:**
- Create: `src/workflow/run-state.js`
- Create: `src/workflow/run-store.js`
- Create: `test/workflow-run-store.test.js`

**Interfaces:**
- Produces `RUN_STATES` and `transitionRun(run, nextState, patch?)`.
- Produces `createRunStore({ stateRoot, fs?, clock?, randomUUID? })`.
- Store methods: `create(input)`, `read(runId)`, `update(runId, updater)`, `appendEvent(runId, event)`, `list({ projectAlias?, originSessionId?, unconsumed? })`, and `writeAssignment(runId, text)`.

- [ ] **Step 1: Write failing permissions, atomicity, and transition tests**

Use a real `mkdtemp` root and assert with `stat`:

```js
test("creates private run directories and files", async () => {
  const store = createRunStore({ stateRoot, randomUUID: () => "11111111-1111-4111-8111-111111111111" });
  const run = await store.create({ projectAlias: "ocr", primaryTicket: "A-1", relatedTickets: [], state: "planned" });
  assert.equal((await stat(run.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(run.directory, "run.json"))).mode & 0o777, 0o600);
});
```

Cover invalid/path-traversing run IDs, duplicate create, malformed JSON, illegal transitions, updater exceptions leaving the original intact, unique event IDs, bounded lock contention, and stale lock detection that reports but does not delete a lock.

- [ ] **Step 2: Verify RED**

Run: `node --test test/workflow-run-store.test.js`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the closed state machine**

Allowed initial/next states must be explicit. At minimum:

```js
const ALLOWED = {
  planned: new Set(["launching", "failed"]),
  launching: new Set(["running", "failed", "interrupted"]),
  running: new Set(["idle-awaiting-handoff", "needs-input", "completed", "blocked", "failed", "interrupted", "manual-handoff-required", "result-stale"]),
  "idle-awaiting-handoff": new Set(["running", "needs-input", "completed", "blocked", "failed", "interrupted", "manual-handoff-required", "result-stale"]),
  "needs-input": new Set(["running", "interrupted", "result-stale"]),
  completed: new Set(["running", "result-stale"]),
  blocked: new Set(["running", "result-stale"]),
  failed: new Set(["running", "result-stale"]),
  interrupted: new Set(["running"]),
  "manual-handoff-required": new Set(["running"]),
  "result-stale": new Set(["running"]),
};
```

Reject implicit transitions and preserve a timestamped state history.

- [ ] **Step 4: Implement atomic private persistence**

Use these concrete operations: `await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 })`; create the permanent private lock container `<runDirectory>/run.lock/` at `0700`; acquire exclusive ownership with `await fs.mkdir(<run.lock>/active, { mode: 0o700 })`; then create a random owner-marker file under that active directory using `await fs.open(<active>/<owner-token>, "wx", 0o600)`. On release, unlink only that owner-token path and call `rmdir(<run.lock>/active)`; if another valid owner marker exists, `rmdir` fails and must not delete it. Use `await fs.open(tempPath, "w", 0o600)` followed by `handle.sync()` and `fs.rename(tempPath, destinationPath)` for atomic data writes. Never include raw run JSON in error messages. `events.jsonl` is append-only and each event has `version`, `id`, `type`, `runId`, and timestamp.

Do not remove stale active locks automatically; return a bounded recovery message containing the active-lock path and age.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/workflow-run-store.test.js
npm test
git diff --check
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/workflow/run-state.js src/workflow/run-store.js test/workflow-run-store.test.js
git commit -m "feat(workflow): persist private launch runs"
```

---

### Task 4: Git Fingerprints and Structured Handoffs

**Files:**
- Create: `src/workflow/handoff.js`
- Create: `test/workflow-handoff.test.js`
- Modify: `src/workflow/git.js`
- Modify: `test/workflow-git.test.js`

**Interfaces:**
- Git adapter adds `fingerprint({ cwd }) -> { head, branch, dirty, entries, digest }`.
- Produces `validateHandoffInput(value, expected) -> normalizedInput`.
- Produces `submitHandoff({ store, git, runId, generation, input }) -> validatedResult`.
- Produces `readCurrentResult({ store, git, runId }) -> { status, result?, errors? }`.

- [ ] **Step 1: Write failing fingerprint tests**

Use a disposable Git repository. Assert a stable clean fingerprint, a changed digest after a tracked edit, staged edit, rename, and untracked-file metadata change. Assert returned data contains paths/status but no file contents.

```js
const clean = await git.fingerprint({ cwd: repo });
await writeFile(join(repo, "src.txt"), "changed\n");
const dirty = await git.fingerprint({ cwd: repo });
assert.notEqual(clean.digest, dirty.digest);
assert.equal(JSON.stringify(dirty).includes("changed\\n"), false);
```

- [ ] **Step 2: Write failing handoff tests**

Cover exact run/generation/ticket sets, duplicate or missing tickets, unknown repositories, traversal/absolute changed-file paths, unknown statuses, oversized strings/arrays/files, current fingerprint acceptance, stale fingerprint detection, and atomic `result.json` creation.

Use semantic input without caller-supplied Git hashes:

```js
const input = {
  version: 1,
  status: "completed",
  summary: "Implemented and verified the assignment.",
  tickets: [{ id: "A-1", status: "completed", evidence: ["node --test passed"] }],
  changedFiles: ["src/example.js"],
  verification: [{ command: "node --test", status: "passed", summary: "1 test passed" }],
  decisions: [],
  concerns: [],
  nextAction: "Request code review",
};
```

`submitHandoff` owns repository fingerprints so models do not reproduce an internal digest algorithm.

- [ ] **Step 3: Verify RED**

Run: `node --test test/workflow-git.test.js test/workflow-handoff.test.js`

Expected: FAIL for missing methods/module.

- [ ] **Step 4: Implement bounded fingerprints**

Build the SHA-256 digest from normalized `HEAD`, branch, and sorted porcelain status entries plus file metadata for dirty paths. Do not read `.env*`, credentials, or file contents into Node. Resolve paths under the worktree, reject traversal, and use `lstat` metadata for changed paths. Return only normalized metadata and the digest.

- [ ] **Step 5: Implement handoff validation and submission**

Limits:

```js
export const HANDOFF_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  summary: 8_000,
  itemText: 4_000,
  tickets: 10,
  changedFiles: 2_000,
  verification: 100,
  evidencePerTicket: 100,
});
```

`submitHandoff` must read expected tickets/repositories from `run.json`, compute current fingerprints, construct the canonical result with exact `runId`/`generation`, calculate and persist a SHA-256 digest for its exact canonical bytes, write a temporary file in the run directory, rename to `result.json`, archive the generation result, chmod `0600`, and transition the run. `readCurrentResult` must compare the current artifact bytes against the stored digest before returning any terminal status; a missing, malformed, unregistered, digest-mismatched, or Git-stale artifact returns `result-stale` and atomically updates run state without destroying the archived result. Its stale transition must conditionally verify the observed generation, result digest, and result status inside the store update; if those values changed or the update cannot persist, the read fails closed rather than returning a terminal result.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/workflow-git.test.js test/workflow-handoff.test.js test/workflow-run-store.test.js
npm test
git diff --check
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/workflow/git.js src/workflow/handoff.js test/workflow-git.test.js test/workflow-handoff.test.js
git commit -m "feat(workflow): validate structured run handoffs"
```

---

### Task 5: Harness Adapters and Generic Agent Ownership

**Files:**
- Create: `src/workflow/harnesses.js`
- Create: `test/workflow-harnesses.test.js`
- Modify: `src/workflow/herdr.js`
- Modify: `src/workflow/commands.js`
- Modify: `src/workflow/planner.js`
- Modify: `src/workflow/execute.js`
- Modify: `src/workflow/reconcile.js`
- Modify: `test/workflow-herdr.test.js`
- Modify: `test/workflow-commands.test.js`
- Modify: `test/workflow-execute.test.js`
- Modify: `test/workflow-reconcile.test.js`

**Interfaces:**
- Produces `buildHarnessLaunch({ profileName, profile, sessionName, cwd, run? }) -> { argv, env, expected }`.
- Herdr `startAgent` accepts a validated `env` object and emits repeated `--env KEY=VALUE` argv entries.
- `executeStart(plan, deps, { buildAgentLaunch? })` preserves its public default behavior.
- Reconciliation matches generic `pi|claude|codex` ownership and reports incompatible live writers.

- [ ] **Step 1: Write failing exact-argv tests**

Assert these shapes without shell strings:

```js
assert.deepEqual(piSpec.argv.slice(0, 5), ["pi", "--name", "ocr-A-1-fix", "--session-id", piSpec.expected.nativeSessionId]);
assert.ok(claudeSpec.argv.includes("--permission-mode"));
assert.ok(claudeSpec.argv.includes("manual"));
assert.ok(claudeSpec.argv.includes("--add-dir"));
assert.deepEqual(codexSpec.argv.slice(0, 3), ["codex", "-C", "/wt/ocr/A-1-fix"]);
assert.ok(codexSpec.argv.includes("workspace-write"));
assert.ok(codexSpec.argv.includes("on-request"));
```

The last argv item for a run is a bounded bootstrap sentence pointing to `assignment.md` and `result.json`; it must not contain the original request. Pi and Claude receive pre-generated UUID session IDs. Codex records `nativeSessionId: null` until lifecycle capture.

- [ ] **Step 2: Write failing ownership and env tests**

Cover Herdr's exact env entry `--env WORKFLOW_RUN_ID=<run-id>`, selected-profile binary preconditions, selected harness integration checks, compatible same harness/run, and conflict when any other live writer exists in the checkout. Ensure launching Codex does not require Claude or Pi readiness.

- [ ] **Step 3: Verify RED**

Run:

```bash
node --test test/workflow-harnesses.test.js test/workflow-herdr.test.js test/workflow-reconcile.test.js test/workflow-execute.test.js test/workflow-commands.test.js
```

Expected: FAIL for missing harness builder/generalization.

- [ ] **Step 4: Implement harness launch specs**

Append profile arguments before the bootstrap prompt, never after it. Only include `--model` when non-null. Run env is exactly the allowlisted workflow keys plus inherited process environment handled by Herdr:

```js
{
  WORKFLOW_RUN_ID: run.id,
  WORKFLOW_RUN_DIR: run.directory,
  WORKFLOW_GENERATION: String(run.generation),
  WORKFLOW_HARNESS: profile.harness,
  WORKFLOW_STATE_ROOT: registry.launcher.state_root,
  WORKFLOW_CONTROL_PLANE_BIN: controlPlaneBin,
}
```

Do not serialize all of `process.env` into plan or run state.

- [ ] **Step 5: Generalize executor and reconciliation**

Replace `pi.session.start` with `agent.session.start` in newly planned operations while accepting old plans during migration. Replace `looksLikePiPane` with an exact expected-harness check. `executeStart` calls the injected launch builder immediately before `herdr.startAgent`; its default builder creates the no-prompt profile start used by `workflow start`.

Reconciliation must collect all live agents/panes in the planned checkout. A planned missing worker is `missing` only when no other live writer owns that checkout; otherwise it is `conflict` with bounded profile/harness evidence.

- [ ] **Step 6: Make doctor profile-specific**

`doctor [project] --agent <profile>` validates Git, Herdr, the selected binary, and only the selected Herdr harness integration. Global doctor lists all profiles as diagnostics but does not expose auth details or fail one selected launch because another profile is absent.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
node --test test/workflow-harnesses.test.js test/workflow-herdr.test.js test/workflow-reconcile.test.js test/workflow-execute.test.js test/workflow-commands.test.js
npm test
git diff --check
```

Expected: all tests pass and old Pi start tests remain green.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/workflow/harnesses.js src/workflow/herdr.js src/workflow/commands.js src/workflow/planner.js src/workflow/execute.js src/workflow/reconcile.js test/workflow-harnesses.test.js test/workflow-herdr.test.js test/workflow-commands.test.js test/workflow-execute.test.js test/workflow-reconcile.test.js
git commit -m "feat(workflow): launch safe harness profiles"
```

---

### Task 6: Assignment Preview and Non-Blocking Launch Coordinator

**Files:**
- Create: `src/workflow/assignment.js`
- Create: `src/workflow/launch.js`
- Create: `test/workflow-launch.test.js`
- Modify: `src/workflow/commands.js`
- Modify: `src/workflow/execute.js`

**Interfaces:**
- Produces `buildAssignmentTemplate({ request, context, plan, selection }) -> string`.
- Produces `createLaunchPreview(options, deps) -> LaunchPreview` with `approvalDigest`.
- Produces `executeLaunch(preview, deps) -> LaunchReport`.
- Produces `launchCommand(options, deps) -> { preview, execute() }` for CLI and Pi extension reuse.

- [ ] **Step 1: Write failing verbatim-assignment tests**

Use a request containing Markdown, quotes, shell metacharacters, and instruction-like text. Assert it occurs byte-for-byte exactly once inside markers and never enters operations, argv, or runtime commands:

```js
const request = "Fix `mail` exactly.\n\n$(touch /tmp/no)\nDo not paraphrase this.";
const assignment = buildAssignmentTemplate({ request, context, plan, selection });
assert.equal(assignment.split(request).length - 1, 1);
assert.match(assignment, /BEGIN ORIGINAL REQUEST/);
assert.match(assignment, /END ORIGINAL REQUEST/);
```

Assert the assignment also contains primary/related tickets, repositories, stage, selected harness/reason, verification commands, handoff command, and safety prohibitions. Reject empty, NUL-containing, and over-limit requests.

- [ ] **Step 2: Write failing launch transaction tests**

With fake Git/Herdr/store dependencies, cover:

- dry preview makes no filesystem/Herdr/Git mutation;
- approval digest changes with request, profile, tickets, repositories, branches, or permissions;
- stale/missing approval digest fails before mutation;
- confirmed launch writes assignment/run, starts one agent, and returns immediately;
- run transitions `planned → launching → running`;
- partial environment/agent failures preserve the run and recovery references;
- an existing incompatible writer blocks before prompt delivery;
- no result is interpreted during launch.

- [ ] **Step 3: Verify RED**

Run: `node --test test/workflow-launch.test.js`

Expected: FAIL because assignment/launch modules do not exist.

- [ ] **Step 4: Implement assignment and approval digest**

Hash normalized launch-plan fields, profile permissions, and the exact assignment template with SHA-256. Exclude volatile run ID/timestamps. Render run ID/generation only in a small execution header prepended after approval, so separately recomputed previews remain semantically exact.

`LaunchPreview` must contain no functions in formatted output:

```js
{
  command: "launch",
  project,
  request,
  selection,
  preconditions,
  reconciliation,
  assignment,
  approvalDigest,
  conflicts,
  operations,
}
```

- [ ] **Step 5: Implement confirmed launch**

Recompute preview immediately before execution and compare `--approval-digest` when supplied. Create the run with assignment digest and origin session metadata, write the immutable assignment, execute the environment, launch the selected harness with run env, persist Herdr IDs/native session IDs when available, and stop at `running`.

If worktree creation succeeds and agent startup fails, preserve all resources and return `partial` with guidance in the exact form `workflow reconcile --run <run-id>`. Never roll back.

- [ ] **Step 6: Add a structured handoff submission use case**

Expose a command-layer function that reads only `<run-directory>/handoff-input.json`, verifies `WORKFLOW_RUN_ID` when present, calls `submitHandoff`, atomically creates the canonical `<run-directory>/result.json`, and returns that canonical result. It must not accept arbitrary output paths or execute report content. Add the exact assignment instruction: `node "$WORKFLOW_CONTROL_PLANE_BIN" handoff "$WORKFLOW_RUN_ID" --input "$WORKFLOW_RUN_DIR/handoff-input.json"`.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
node --test test/workflow-launch.test.js test/workflow-handoff.test.js test/workflow-execute.test.js
npm test
git diff --check
```

Expected: all tests pass.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/workflow/assignment.js src/workflow/launch.js src/workflow/commands.js src/workflow/execute.js test/workflow-launch.test.js
git commit -m "feat(workflow): coordinate approved agent launches"
```

---

### Task 7: CLI, Result/Reconcile Output, and Core Documentation

**Files:**
- Modify: `bin/workflow.js`
- Modify: `src/workflow/commands.js`
- Modify: `src/workflow/format.js`
- Modify: `test/workflow-cli.test.js`
- Create: `test/workflow-format.test.js`
- Modify: `test/workflow-docs.test.js`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Adds `workflow launch <project> <primary-ticket>`.
- Adds `workflow result <run-id>`.
- Adds `workflow reconcile [project] --run <run-id>`.
- Adds `workflow handoff <run-id> --input <run-directory>/handoff-input.json` for workers.
- Launch options include `--tickets`, `--feature`, `--repos`, `--agent`, `--prompt-file`, `--selection-reason`, `--origin-session`, `--dry-run`, `--approval-digest`, `--format`, and `--yes`.

- [ ] **Step 1: Write failing parser/help tests**

Add exact parse assertions:

```js
assert.deepEqual(parseArgs([
  "launch", "acme", "SHARY-123",
  "--tickets", "SHARY-140,SHARY-152",
  "--repos", "backend,panel",
  "--agent", "claude-worker",
  "--prompt-file", "/tmp/request.md",
  "--dry-run",
  "--format", "json",
]), {
  command: "launch",
  projectAlias: "acme",
  task: "SHARY-123",
  tickets: ["SHARY-140", "SHARY-152"],
  repositories: ["backend", "panel"],
  agentProfile: "claude-worker",
  promptFile: "/tmp/request.md",
  dryRun: true,
  format: "json",
});
```

Reject prompt text in argv (`--prompt` must remain unknown), launch without prompt file, `--yes` without current in-process preview or `--approval-digest` in non-interactive mode, mutation flags on read-only commands, and handoff input outside the run directory.

- [ ] **Step 2: Verify RED**

Run: `node --test test/workflow-cli.test.js test/workflow-format.test.js test/workflow-docs.test.js`

Expected: FAIL because commands/help are absent.

- [ ] **Step 3: Implement CLI dispatch and stable exits**

`launch --dry-run` prints the full assignment and digest, then exits 0 without mutation. Interactive launch prints the preview to stderr and calls one confirmation. `--yes --approval-digest` recomputes before execution. `result` exits 0 for valid terminal/current results and a documented non-success code for pending/stale/manual handoff states. `reconcile` is read-only.

Use a separate assignment output limit up to 64 KiB while keeping ordinary diagnostics at 12,000 characters. Never truncate silently: include an explicit truncation marker and saved assignment path when applicable.

- [ ] **Step 4: Implement compact and JSON formatters**

Compact launch preview must show this shape, replacing bracketed values with actual computed values and printing the complete approved assignment below the header:

```text
Project: Acme [acme]
Primary ticket: SHARY-123
Related tickets: SHARY-140, SHARY-152
Agent profile: claude-worker
Harness: claude
Permission mode: manual
Writable roots: /absolute/worktree/path, /absolute/run-directory/path
Approval digest: sha256:<64-lowercase-hex-digest>
Assignment:
<complete approved assignment, or explicit bounded-output marker plus its saved path>
```

Run output includes run ID, state, harness, workspace/tab/pane, exact result/status/reconcile commands, and fallback workspace reference. JSON remains normalized and machine-readable.

- [ ] **Step 5: Update docs and package scripts**

Document profile selection precedence, bundle semantics, separate `start`/`launch`, preview/approval digest, private state location, handoff command, fallback terminal access, no-cleanup policy, and examples for all harnesses. Do not document native hooks/resume as available yet; label them as the next implementation stage.

- [ ] **Step 6: Verify complete core behavior**

Run:

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
node bin/workflow.js doctor --format compact
node bin/workflow.js launch ocr EXAMPLE-1 --agent pi-worker --prompt-file /dev/null --dry-run --format json
```

Expected:

- all tests pass;
- package includes new source files and bin entry;
- doctor output is bounded;
- empty prompt dry-run fails closed without mutation.

- [ ] **Step 7: Commit Task 7**

```bash
git add bin/workflow.js src/workflow/commands.js src/workflow/format.js test/workflow-cli.test.js test/workflow-format.test.js test/workflow-docs.test.js README.md package.json package-lock.json
git commit -m "feat(workflow): expose multi-harness launch runs"
```

---

## Stage 1 Completion Gate

Before beginning the lifecycle/coordinator plan:

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
git status --short
```

Then perform:

1. A fresh specification-compliance review against `docs/superpowers/specs/2026-07-19-multi-harness-workflow-coordinator-design.md`.
2. A fresh code-quality/security review focused on argv, permissions, run-store modes, one-writer enforcement, assignment fidelity, and false-completion risks.
3. Fix and re-review every material finding.
4. Record the exact commit and test count in the stage handoff.

Do not install `pi-subagents`, user hooks, or run real Pi/Claude/Codex canaries in this stage.
