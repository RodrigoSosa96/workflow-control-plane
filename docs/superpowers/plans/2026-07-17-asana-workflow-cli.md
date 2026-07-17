# Asana Workflow CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency, read-only Asana CLI and Pi skill that provide compact discovery and complete ticket context on demand.

**Architecture:** A Node.js ESM package separates credential loading, configuration resolution, HTTP transport, command orchestration, output formatting, and the executable entry point. The Asana client receives an injectable `fetch` implementation so all behavior is tested without live API calls; command functions receive client/config dependencies for the same reason.

**Tech Stack:** Node.js 24, native `fetch`, ES modules, `node:test`, Asana REST API v1.

## Global Constraints

- Runtime dependencies: none.
- The first release is read-only except for explicitly downloading an attachment to a user-selected local path.
- Never accept an Asana token as a CLI argument or include it in output/errors.
- Compact output is the default; normalized JSON is opt-in.
- Do not install the package globally or create credentials during implementation.
- Implement production behavior only after its test has failed for the expected reason.

---

### Task 1: Package, authentication, and alias configuration

**Files:**
- Create: `package.json`
- Create: `src/asana/auth.js`
- Create: `src/asana/config.js`
- Create: `config/asana-projects.json`
- Create: `test/auth.test.js`
- Create: `test/config.test.js`

**Interfaces:**
- Produces: `loadToken({ env, homeDir, stat, readFile })`, returning `{ token, source, warning? }`.
- Produces: `loadProjectConfig(path)` and `resolveProjectBinding(config, alias)`.
- Configuration shape: `{ version: 1, projects: { [alias]: { projectGid?: string, projectName?: string, workspaceGid?: string, activeSections: string[] } } }`.

- [ ] **Step 1: Write failing authentication tests**

Test environment precedence, explicit token-file precedence, default path, missing/empty token errors, and a warning for group/other-readable files. Inject filesystem functions so no real credential is read.

- [ ] **Step 2: Run authentication tests and verify RED**

Run: `node --test test/auth.test.js`
Expected: FAIL because `src/asana/auth.js` does not exist.

- [ ] **Step 3: Implement minimal authentication loader**

Read `ASANA_ACCESS_TOKEN`, then `ASANA_TOKEN_FILE`, then `~/.config/workflows/asana-token`; trim token content, inspect permission bits, and throw stable `AuthError` messages without token values.

- [ ] **Step 4: Run authentication tests and verify GREEN**

Run: `node --test test/auth.test.js`
Expected: all authentication tests pass.

- [ ] **Step 5: Write failing configuration tests**

Test valid JSON loading, unsupported version, unknown alias, unbound alias, direct GID passthrough, and bindings by GID/name.

- [ ] **Step 6: Run configuration tests and verify RED**

Run: `node --test test/config.test.js`
Expected: FAIL because `src/asana/config.js` does not exist.

- [ ] **Step 7: Implement configuration resolution and initial unbound OCR alias**

Use native JSON parsing. Return direct numeric GIDs without config lookup. Reject aliases without `projectGid` or `projectName` with an instruction to run `asana-workflow projects` and update the config.

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run: `node --test test/auth.test.js test/config.test.js`
Expected: all tests pass.

- [ ] **Step 9: Commit Task 1**

```bash
git add package.json src/asana/auth.js src/asana/config.js config/asana-projects.json test/auth.test.js test/config.test.js
git commit -m "feat(asana): add secure auth and project configuration"
```

### Task 2: Asana REST client

**Files:**
- Create: `src/asana/client.js`
- Create: `test/client.test.js`

**Interfaces:**
- Consumes: token string from `loadToken`.
- Produces: `createAsanaClient({ token, fetchImpl, baseUrl, maxPages })` with methods `me`, `workspaces`, `projects`, `sections`, `sectionTasks`, `task`, `stories`, `subtasks`, `dependencies`, `dependents`, `attachments`, `attachment`, and `downloadAttachment`.
- All list methods return arrays with pagination envelopes removed.

- [ ] **Step 1: Write failing request and pagination tests**

Assert the bearer header, explicit `opt_fields`, query encoding, pagination following, maximum-page failure, malformed envelopes, bounded sanitized HTTP errors, and `Retry-After` handling for 429 responses.

- [ ] **Step 2: Run client tests and verify RED**

Run: `node --test test/client.test.js`
Expected: FAIL because `src/asana/client.js` does not exist.

- [ ] **Step 3: Implement request core and discovery methods**

Use native `URL`/`URLSearchParams`, never serialize request headers into an error, and follow `next_page.uri` only up to `maxPages`.

- [ ] **Step 4: Run client tests and verify GREEN**

Run: `node --test test/client.test.js`
Expected: request and pagination tests pass.

- [ ] **Step 5: Write failing task-context and attachment tests**

Assert each task-related endpoint and explicit fields. Test binary attachment download, missing download URL, and non-success download responses without leaking headers.

- [ ] **Step 6: Run new client tests and verify RED**

Run: `node --test test/client.test.js`
Expected: FAIL because task/attachment methods are absent.

- [ ] **Step 7: Implement task-context and attachment methods**

Add the task, story, subtask, relationship, and attachment methods using the common request core. Return a byte buffer plus safe response metadata for downloads.

- [ ] **Step 8: Run Task 2 tests and verify GREEN**

Run: `node --test test/client.test.js`
Expected: all client tests pass.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/asana/client.js test/client.test.js
git commit -m "feat(asana): add paginated read-only API client"
```

### Task 3: Command orchestration

**Files:**
- Create: `src/asana/commands.js`
- Create: `test/commands.test.js`

**Interfaces:**
- Consumes: Asana client and resolved project binding.
- Produces: `runCommand(name, args, deps)` returning normalized data.
- Produces: `resolveProject(client, binding)` and `getFullTaskContext(client, gid)`.

- [ ] **Step 1: Write failing identity and discovery command tests**

Test `auth status`, `me`, `workspaces`, `projects`, section discovery, exact project-name resolution, and ambiguous-name errors.

- [ ] **Step 2: Run command tests and verify RED**

Run: `node --test test/commands.test.js`
Expected: FAIL because `src/asana/commands.js` does not exist.

- [ ] **Step 3: Implement identity/discovery orchestration**

Return normalized records and use exact case-insensitive matching for configured project names.

- [ ] **Step 4: Run command tests and verify GREEN**

Run: `node --test test/commands.test.js`
Expected: discovery tests pass.

- [ ] **Step 5: Write failing triage and full-context tests**

Test configured section matching, explicit `--sections` overrides, duplicate task removal, authenticated-assignee filtering, compact core task retrieval, concurrent full-context aggregation, and attachment metadata listing.

- [ ] **Step 6: Run new command tests and verify RED**

Run: `node --test test/commands.test.js`
Expected: FAIL because triage/full-context behavior is absent.

- [ ] **Step 7: Implement triage and full-context orchestration**

Fetch selected sections, deduplicate task GIDs, retain only tasks assigned to the authenticated user, and aggregate full context without classifying or summarizing it.

- [ ] **Step 8: Write failing attachment file-safety tests**

Use a temporary directory to verify refusal to overwrite, parent-directory creation, and successful byte-for-byte output.

- [ ] **Step 9: Implement explicit attachment download command**

Resolve fresh metadata, require a download URL, refuse overwrite, create parent directories, and write with an injected filesystem adapter.

- [ ] **Step 10: Run Task 3 tests and verify GREEN**

Run: `node --test test/commands.test.js`
Expected: all command tests pass.

- [ ] **Step 11: Commit Task 3**

```bash
git add src/asana/commands.js test/commands.test.js
git commit -m "feat(asana): add discovery and triage commands"
```

### Task 4: Compact formatting and executable CLI

**Files:**
- Create: `src/asana/format.js`
- Create: `bin/asana-workflow.js`
- Create: `test/format.test.js`
- Create: `test/cli.test.js`

**Interfaces:**
- Consumes: normalized command results.
- Produces: `formatResult(command, value, format)`.
- Produces: `parseArgs(argv)` and `main(argv, deps)`; executable uses real dependencies only when invoked directly.

- [ ] **Step 1: Write failing compact/JSON formatter tests**

Assert deterministic identity, project, section, triage, task context, comment, and attachment output. Ensure absent optional values do not produce `undefined` and JSON contains normalized values only.

- [ ] **Step 2: Run formatter tests and verify RED**

Run: `node --test test/format.test.js`
Expected: FAIL because `src/asana/format.js` does not exist.

- [ ] **Step 3: Implement minimal formatters**

Use stable headings and one-line candidate rows. Preserve full descriptions/comments under labeled sections while omitting empty sections.

- [ ] **Step 4: Run formatter tests and verify GREEN**

Run: `node --test test/format.test.js`
Expected: all formatter tests pass.

- [ ] **Step 5: Write failing parser/main tests**

Test every documented command, required options, format validation, unknown command help, missing auth exit behavior, sanitized failures, and successful output using injected commands.

- [ ] **Step 6: Run CLI tests and verify RED**

Run: `node --test test/cli.test.js`
Expected: FAIL because `bin/asana-workflow.js` does not exist.

- [ ] **Step 7: Implement parser and executable main**

Build the real token/config/client dependencies after parsing. Print normal output to stdout, actionable errors to stderr, and return deterministic exit codes.

- [ ] **Step 8: Run Task 4 tests and verify GREEN**

Run: `node --test test/format.test.js test/cli.test.js`
Expected: all tests pass.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/asana/format.js bin/asana-workflow.js test/format.test.js test/cli.test.js
git commit -m "feat(asana): expose compact workflow CLI"
```

### Task 5: Pi skill, documentation, and complete verification

**Files:**
- Create: `.agents/skills/asana-triage/SKILL.md`
- Modify: `README.md`
- Modify: `.pi/prompts/triage-asana.md`
- Test: all files under `test/`

**Interfaces:**
- Skill invokes `asana-workflow` commands and enforces complete-context-before-classification.
- README provides installation, secure token setup, alias binding, usage, uninstall, and troubleshooting.

- [ ] **Step 1: Write a failing documentation contract test**

Add `test/docs.test.js` that verifies the skill frontmatter, required command sequence, read-only gate, token-file path, install command, and the prompt's explicit skill reference.

- [ ] **Step 2: Run docs test and verify RED**

Run: `node --test test/docs.test.js`
Expected: FAIL because the skill and required documentation are absent.

- [ ] **Step 3: Write the skill and documentation**

Document discovery before binding, full retrieval for every candidate, attachment handling, repository correlation, readiness categories, secure setup, and local global-install commands. Keep credentials out of agent-visible commands.

- [ ] **Step 4: Run all tests and verify GREEN**

Run: `npm test`
Expected: all tests pass with no warnings.

- [ ] **Step 5: Run static and CLI smoke checks**

Run:

```bash
node --check bin/asana-workflow.js
node bin/asana-workflow.js --help
node bin/asana-workflow.js auth status
```

Expected: syntax succeeds, help is displayed, and auth status reports unconfigured without exposing a credential.

- [ ] **Step 6: Review final diff and secret scan**

Run:

```bash
git diff --check
git grep -nE 'ASANA_ACCESS_TOKEN=.+' -- ':!docs/superpowers' || true
git status --short
```

Expected: no whitespace errors, no embedded token assignment, and only intended files changed.

- [ ] **Step 7: Commit Task 5**

```bash
git add .agents/skills/asana-triage/SKILL.md README.md .pi/prompts/triage-asana.md test/docs.test.js
git commit -m "docs(asana): add triage skill and setup guide"
```
