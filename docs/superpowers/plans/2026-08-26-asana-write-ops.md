# Asana Write Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `asana-workflow` and `asana-triage` with confirm-gated task writes, comments, moves, and minimal Asana project creation.

**Architecture:** Generalize the existing Asana HTTP client for JSON POST/PUT requests, then expose small command-layer functions that either return a dry-run plan or execute when `confirm` is true. Keep parsing, formatting, documentation, and the skill aligned with that single mutation contract.

**Tech Stack:** Node.js 22+ ESM, built-in `fetch`, `node:test`, JSON project configuration, Markdown skills/docs.

## Global Constraints

- All mutations are dry-run by default and execute only with `--confirm`.
- The skill requires Rodrigo's explicit approval after inspecting the dry-run and before passing `--confirm`.
- Tokens never appear in CLI arguments or output; existing token redaction and same-origin protections remain in force.
- Do not add dependencies.
- Do not implement subtasks, dependency writes, custom-field writes, uploads, tags, templates, bulk operations, or project privacy/team/layout controls beyond the specified defaults.
- Preserve unrelated working-tree changes.

---

### Task 1: JSON write support in the Asana API client

**Files:**
- Modify: `src/asana/client.js`
- Test: `test/client.test.js`

**Interfaces:**
- Produces: `client.createTask(fields)`, `client.updateTask(gid, fields)`, `client.addStory(taskGid, text)`, `client.addTaskToSection(sectionGid, taskGid)`, `client.createProject(fields)`, and `client.createSection(projectGid, name)`.
- Preserves: every existing read and attachment-download method.

- [ ] **Step 1: Write failing write-request tests**

Append tests that capture the outgoing request and assert JSON envelopes:

```js
test("creates and updates tasks with authenticated JSON requests", async () => {
  const requests = [];
  const client = createAsanaClient({ token: "secret", fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return jsonResponse({ data: { gid: "t1", name: "Ticket" } });
  } });

  await client.createTask({ workspace: "w1", name: "Ticket" });
  await client.updateTask("t1", { completed: true });

  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), { data: { workspace: "w1", name: "Ticket" } });
  assert.equal(requests[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[1].options.body), { data: { completed: true } });
  assert.equal(requests[0].options.headers["content-type"], "application/json");
});

test("uses Asana write endpoints for comments, sections, and projects", async () => {
  const requests = [];
  const client = createAsanaClient({ token: "x", fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return jsonResponse({ data: { gid: "created" } });
  } });

  await client.addStory("t1", "Status update");
  await client.addTaskToSection("s1", "t1");
  await client.createProject({ workspace: "w1", name: "Board", default_view: "board", public: true });
  await client.createSection("p1", "Backlog");

  assert.match(requests[0].url, /tasks\/t1\/stories/);
  assert.deepEqual(JSON.parse(requests[0].options.body), { data: { text: "Status update" } });
  assert.match(requests[1].url, /sections\/s1\/add_task/);
  assert.deepEqual(JSON.parse(requests[1].options.body), { data: { task: "t1" } });
  assert.match(requests[2].url, /\/projects\?/);
  assert.match(requests[3].url, /projects\/p1\/sections/);
});
```

Also make the existing sanitization test exercise a failed write and assert that the bearer token is absent from the error.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test test/client.test.js`

Expected: FAIL because the six write methods do not exist.

- [ ] **Step 3: Generalize `request` and add the methods**

Use this request shape:

```js
async function request(path, query = {}, { method = "GET", body } = {}) {
  const options = { method, headers: { ...apiHeaders } };
  if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify({ data: body });
  }
  // Existing fetch, parseError, envelope validation, and redaction follow unchanged.
}
```

Add methods to `client`:

```js
createTask: async (fields) => (await request("tasks", { opt_fields: TASK_FIELDS }, { method: "POST", body: fields })).data,
updateTask: async (gid, fields) => (await request(`tasks/${gid}`, { opt_fields: TASK_FIELDS }, { method: "PUT", body: fields })).data,
addStory: async (gid, text) => (await request(`tasks/${gid}/stories`, { opt_fields: STORY_FIELDS }, { method: "POST", body: { text } })).data,
addTaskToSection: async (sectionGid, taskGid) => (await request(`sections/${sectionGid}/add_task`, {}, { method: "POST", body: { task: taskGid } })).data,
createProject: async (fields) => (await request("projects", { opt_fields: PROJECT_FIELDS }, { method: "POST", body: fields })).data,
createSection: async (projectGid, name) => (await request(`projects/${projectGid}/sections`, { opt_fields: SECTION_FIELDS }, { method: "POST", body: { name } })).data,
```

- [ ] **Step 4: Run focused tests**

Run: `node --test test/client.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/asana/client.js test/client.test.js
git commit -m "feat: add Asana API write methods"
```

---

### Task 2: Confirm-gated mutation command layer

**Files:**
- Modify: `src/asana/commands.js`
- Test: `test/commands.test.js`

**Interfaces:**
- Consumes: Task 1 client methods.
- Produces: `resolveSectionByName`, `createTaskCommand`, `updateTaskCommand`, `commentTaskCommand`, `moveTaskCommand`, `createProjectCommand`, and `registerProjectAlias`.
- Every command receives an options object with `confirm`; false returns `{ dryRun: true, action, details }` without invoking a write method.

- [ ] **Step 1: Write failing dry-run and confirmed-write tests**

Add tests proving dry-runs do no writes and confirmations do:

```js
test("task commands are dry-run by default and execute only when confirmed", async () => {
  let writes = 0;
  const client = {
    me: async () => ({ gid: "u1" }),
    sections: async () => [{ gid: "s1", name: "Doing" }],
    createTask: async (fields) => { writes += 1; return { gid: "t1", name: fields.name }; },
    addTaskToSection: async () => { writes += 1; },
    updateTask: async (gid, fields) => { writes += 1; return { gid, ...fields }; },
  };

  const dry = await createTaskCommand(client, {
    project: { gid: "p1" }, name: "Ticket", section: "Doing", assignee: "me", dueOn: "2026-09-01",
  }, { confirm: false });
  assert.equal(dry.dryRun, true);
  assert.equal(writes, 0);

  const applied = await createTaskCommand(client, {
    project: { gid: "p1" }, name: "Ticket", section: "Doing", assignee: "me", dueOn: "2026-09-01",
  }, { confirm: true });
  assert.equal(applied.task.gid, "t1");
  assert.equal(writes, 2);
});
```

Cover update clearing (`assignee: "none"`, `dueOn: "none"`), comment, move, project creation with ordered sections, missing/ambiguous sections, and alias registration with an in-memory or temporary config.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/commands.test.js`

Expected: FAIL on missing exports.

- [ ] **Step 3: Add section resolution and mutation functions**

Implement exact case-insensitive section resolution and flat plan details. Field translation must be:

```js
const fields = {
  ...(name !== undefined ? { name } : {}),
  ...(notes !== undefined ? { notes } : {}),
  ...(assignee !== undefined ? { assignee: assignee === "none" ? null : assignee } : {}),
  ...(dueOn !== undefined ? { due_on: dueOn === "none" ? null : dueOn } : {}),
  ...(completed !== undefined ? { completed } : {}),
};
```

Resolve `assignee: "me"` through `client.me()` before planning or applying. `createTaskCommand` sends `projects: [project.gid]`, then adds the task to the selected section after creation. `createProjectCommand` sends:

```js
{ workspace: workspaceGid, name, default_view: "board", public: true }
```

and creates each requested section sequentially to preserve order.

- [ ] **Step 4: Add safe alias registration**

Implement:

```js
export async function registerProjectAlias(
  configPath,
  alias,
  projectGid,
  { readFileImpl = readFile, writeFileImpl = writeFile } = {},
) { /* validate version/projects, reject existing alias, write 2-space JSON + newline */ }
```

The function must reject aliases outside `/^[\p{L}\p{N}._-]+$/u`, malformed config, and existing aliases without writing.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/commands.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/asana/commands.js test/commands.test.js
git commit -m "feat: add confirm-gated Asana mutation commands"
```

---

### Task 3: Parse and dispatch write commands

**Files:**
- Modify: `bin/asana-workflow.js`
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: Task 2 command functions.
- Produces CLI commands exactly as documented in the design spec.
- Uses injected `dependencies.readFile` for `--notes-file` tests; defaults to `node:fs/promises.readFile`.

- [ ] **Step 1: Write failing parser tests**

Assert representative parsed structures:

```js
assert.deepEqual(parseArgs([
  "task", "create", "--project", "ocr", "--name", "Ticket", "--section", "Backlog", "--confirm",
]), {
  command: "task-create", project: "ocr", name: "Ticket", notes: undefined,
  notesFile: undefined, section: "Backlog", assignee: undefined, dueOn: undefined,
  confirm: true, format: "compact",
});

assert.deepEqual(parseArgs([
  "project", "create", "--workspace", "123", "--name", "Board",
  "--sections", "Backlog,Doing,Done", "--register-alias", "board",
]), {
  command: "project-create", workspace: "123", name: "Board",
  sections: ["Backlog", "Doing", "Done"], registerAlias: "board",
  confirm: false, format: "compact",
});
```

Add rejection tests for missing required values, invalid GIDs/dates/booleans/aliases, no fields on `task update`, and simultaneous `--notes` plus `--notes-file`.

- [ ] **Step 2: Run parser tests and verify failure**

Run: `node --test test/cli.test.js`

Expected: FAIL because write syntax is unknown.

- [ ] **Step 3: Extend option consumption and validation**

Add value options `name`, `notes`, `notes-file`, `section`, `due`, `completed`, `text`, and `register-alias`; add boolean `confirm`. Preserve all current command shapes, especially `task <gid> [--full]`.

Validation rules:

- Date is `/^\d{4}-\d{2}-\d{2}$/` or `none` where clearing is supported.
- `completed` is exactly `true` or `false`, converted to boolean.
- `workspace`, task, and attachment GIDs are digits only.
- `project` and alias refs use the existing Unicode-safe alias/GID rule.
- `--notes` and `--notes-file` are mutually exclusive.

- [ ] **Step 4: Write failing dispatch tests**

Use injected clients to prove dry-run dispatch does not call writes, confirmed dispatch does, `--notes-file` uses the injected reader, and confirmed project creation registers the alias at the configured path.

- [ ] **Step 5: Dispatch through command functions**

Resolve project aliases with the existing config path and helpers for task create/move. Read notes files only after authentication and report read failures as `CommandError`. Set `formatCommand = "mutation"` for every write command. Register a project alias only after confirmed project creation succeeds.

- [ ] **Step 6: Update CLI help text**

Change the heading to `compact Asana reads and confirm-gated writes`, list all new commands, and explain: `Write commands are dry-run unless --confirm is supplied.`

- [ ] **Step 7: Run focused tests**

Run: `node --test test/cli.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bin/asana-workflow.js test/cli.test.js
git commit -m "feat: expose Asana write commands in the CLI"
```

---

### Task 4: Mutation output and documentation contract

**Files:**
- Modify: `src/asana/format.js`
- Modify: `test/format.test.js`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 result shapes and Task 3 `formatCommand = "mutation"`.
- Produces compact dry-run/applied text and unchanged raw JSON output.

- [ ] **Step 1: Write failing formatter tests**

Test compact output contains `DRY RUN`, action/details, and re-run guidance; applied output contains task/project/story GIDs, permalink when present, created section names, and registered alias. Confirm JSON mode exactly serializes the object.

- [ ] **Step 2: Run formatter tests and verify failure**

Run: `node --test test/format.test.js`

Expected: FAIL because `mutation` has no formatter.

- [ ] **Step 3: Implement `formatMutation`**

Dry-run output starts with `DRY RUN: <action>`, prints each detail on its own indented line (arrays comma-separated), and ends `Re-run with --confirm to apply.` Applied output starts with `Applied: <action>` and renders whichever of `task`, `story`, `project`, `section`, `sections`, and `alias` exists.

- [ ] **Step 4: Update README and package metadata**

Change the feature bullet to `Asana triage and confirm-gated write CLI with secure token handling.` Change the Asana section introduction to explain reads plus dry-run/confirm writes. Add a `Write operations` subsection containing every command from the spec and this invariant:

> Every write command is a dry-run unless `--confirm` is supplied. Agent workflows must show the dry-run to Rodrigo and obtain explicit approval before rerunning with `--confirm`.

Change `package.json` description to `Asana and multi-harness workflow control-plane CLIs.`

- [ ] **Step 5: Run focused tests**

Run: `node --test test/format.test.js test/docs.test.js`

Expected: PASS; the existing skill remains compatible until Task 5 changes it and its assertion together.

- [ ] **Step 6: Commit the formatter and CLI docs**

```bash
git add src/asana/format.js test/format.test.js README.md package.json
git commit -m "docs: document confirm-gated Asana writes"
```

---

### Task 5: Expand the `asana-triage` skill safely

**Files:**
- Modify: `.agents/skills/asana-triage/SKILL.md`
- Test: `test/docs.test.js`

**Interfaces:**
- Consumes: the final CLI syntax from Task 3.
- Produces: skill instructions requiring dry-run, explicit approval, and confirmed execution for every mutation.

- [ ] **Step 1: Write the failing skill-contract assertions**

Rename the Asana skill test to reflect approved writes and assert that the skill contains `--confirm`, `explicit approval`, and all five write command families while retaining the full-triage assertions. Run `node --test test/docs.test.js`; expect FAIL until the skill is updated.

- [ ] **Step 2: Update skill frontmatter and safety rules**

Keep `name: asana-triage`. Expand the description to trigger on inspecting, creating, commenting on, moving, completing, or updating Asana tickets and creating projects/boards.

Replace the read-only statement with rules that include these exact constraints:

- Reads and attachment downloads follow the existing triage flow.
- Do not modify or write Asana resources without Rodrigo's explicit approval.
- Run every mutation first without `--confirm`, show the exact dry-run output, wait for approval, then rerun unchanged with `--confirm`.
- One approval covers only the displayed mutation plan; changed fields or targets require a new dry-run and approval.

- [ ] **Step 3: Add write-operation examples**

Document all five command families from the spec, including `--notes-file`, clearing assignee/due date with `none`, project section CSV, and optional alias registration. State that creating a project is a real Asana mutation and does not authorize implementation work in any repository.

- [ ] **Step 4: Run documentation tests**

Run: `node --test test/docs.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/asana-triage/SKILL.md test/docs.test.js
git commit -m "feat: expand Asana triage skill with approved writes"
```

---

### Task 6: Full verification and real-board handoff

**Files:**
- No code changes expected.

**Interfaces:**
- Verifies all previous tasks together.

- [ ] **Step 1: Run all Asana-focused tests**

Run:

```bash
node --test test/auth.test.js test/client.test.js test/commands.test.js test/config.test.js test/format.test.js test/cli.test.js test/docs.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the full repository suite**

Run: `npm test`

Expected: PASS with zero failures. If unrelated pre-existing workflow tests fail because of the preserved dirty work, report them separately and rerun the Asana-focused set as the bounded verification.

- [ ] **Step 3: Inspect the diff**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -8
```

Expected: no whitespace errors; only planned Asana/docs files changed in this feature branch.

- [ ] **Step 4: Prepare the actual board creation**

Ask Rodrigo for workspace GID, project name, sections, and optional alias. Run:

```bash
asana-workflow project create --workspace <gid> --name <name> --sections <csv> [--register-alias <alias>]
```

Show the dry-run and wait for explicit approval. Only then rerun the exact command with `--confirm`.
