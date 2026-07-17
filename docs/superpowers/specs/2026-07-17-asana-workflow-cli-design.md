# Asana Workflow CLI Design

**Date:** 2026-07-17
**Status:** Approved

## Goal

Provide a local, harness-independent, read-only Asana CLI and a Pi skill that can triage Rodrigo's assigned work with substantially less context and tool-schema overhead than an MCP integration.

## Scope

The first version supports discovery and triage only:

- Detect whether Asana authentication is configured without exposing credentials.
- Read the authenticated user and their workspaces.
- List active projects and sections.
- Resolve a configured local project alias such as `ocr` to an Asana project.
- Find tasks assigned to the authenticated user in configured active sections.
- Retrieve complete task context: description, custom fields, comments, subtasks, dependencies, dependents, project memberships, links, and attachment metadata.
- Download an attachment only when explicitly requested.
- Emit compact human-readable output by default and JSON when requested.
- Teach Pi the intended progressive-disclosure triage workflow through a local skill.

The first version will not create, edit, comment on, move, assign, complete, or delete Asana resources. It will not start implementation in target repositories.

## Approaches considered

### 1. Zero-dependency Node.js CLI — selected

Use Node.js 24 built-ins, native `fetch`, ES modules, and `node:test`. Expose a package `bin` entry so Rodrigo can install it from this directory using npm or pnpm after reviewing it.

Advantages:

- No runtime dependencies or supply-chain additions.
- Native to the existing environment.
- Easy deterministic tests with an injected HTTP transport.
- Works from Pi, Claude Code, Codex, Herdr scripts, and a normal shell.
- Structured compact formatting can be tailored to token usage.

Trade-off: argument parsing and API pagination require a small amount of local code.

### 2. Third-party Asana CLI

Install an existing package and wrap it with a skill.

Rejected for the initial version because available tools vary in maintenance, output shape, authentication behavior, and coverage of comments/attachments/dependencies. A generic CLI may produce verbose responses and would require source review before trusting it with an Asana token.

### 3. MCP server through `pi-mcp-adapter`

Rejected for the initial version because it adds an adapter and persistent tool schemas, is less reusable outside MCP-capable harnesses, and gives less control over compact output. MCP remains a possible later adapter over the same Asana client if interactive write operations become valuable.

## Architecture

The implementation is a small ESM package with focused modules:

```text
workflows/
├── package.json
├── bin/
│   └── asana-workflow.js
├── src/asana/
│   ├── auth.js
│   ├── client.js
│   ├── config.js
│   ├── format.js
│   └── commands.js
├── config/
│   └── asana-projects.json
├── .agents/skills/asana-triage/
│   └── SKILL.md
└── test/
    ├── auth.test.js
    ├── client.test.js
    ├── config.test.js
    ├── format.test.js
    └── commands.test.js
```

### Responsibilities

- `bin/asana-workflow.js`: parse CLI input, call command functions, set exit codes, and print sanitized errors.
- `auth.js`: read the token from `ASANA_ACCESS_TOKEN` or the default protected token file. It never prints or returns token content to formatters.
- `client.js`: perform authenticated Asana REST requests, select explicit fields, follow pagination, and normalize API errors.
- `config.js`: load alias and section configuration from JSON and resolve project aliases without adding a YAML dependency.
- `commands.js`: orchestrate discovery, triage, full task retrieval, and attachment downloads.
- `format.js`: produce bounded compact text or JSON output.
- `SKILL.md`: instruct Pi to discover compact candidates first and request full context only for candidates under assessment.

## CLI interface

```text
asana-workflow auth status
asana-workflow me [--format compact|json]
asana-workflow workspaces [--format compact|json]
asana-workflow projects [--workspace <gid>] [--format compact|json]
asana-workflow sections --project <alias-or-gid> [--format compact|json]
asana-workflow triage --project <alias-or-gid> [--sections <csv>] [--format compact|json]
asana-workflow task <gid> [--full] [--format compact|json]
asana-workflow attachments <task-gid> [--format compact|json]
asana-workflow attachment download <attachment-gid> --output <path>
```

`task <gid> --full` aggregates the task, stories/comments, subtasks, dependencies, dependents, and attachments. Without `--full`, it returns the task's core fields only.

## Configuration and project resolution

`config/asana-projects.json` contains non-secret aliases. An alias may specify:

- Asana project GID, when known.
- Workspace GID, when known.
- Exact Asana project name as a discovery fallback.
- Active section names such as `In Progress` and `Next Sprint`.

The initial `ocr` entry will be intentionally unbound: it will contain the desired active section names but no guessed project GID or name. `asana-workflow projects` provides the exact names and GIDs; Rodrigo then binds `ocr` by adding either value. Running `triage --project ocr` while it is unbound returns that precise setup instruction. Ambiguous project-name matches cause a clear error listing candidate names and GIDs.

## Authentication and security

Authentication precedence:

1. `ASANA_ACCESS_TOKEN`, for temporary shell use.
2. `${ASANA_TOKEN_FILE}`, if set.
3. `~/.config/workflows/asana-token`.

The CLI will reject an empty token file. It will warn when the default token file is readable by group or others. It will never:

- Print the token.
- Accept the token as a CLI argument.
- Include authorization headers in errors.
- Read or display unrelated environment variables.
- Write credentials inside this repository.

Recommended setup after installation:

```bash
mkdir -p ~/.config/workflows
chmod 700 ~/.config/workflows
read -rsp 'Asana token: ' ASANA_TOKEN; echo
printf '%s' "$ASANA_TOKEN" > ~/.config/workflows/asana-token
unset ASANA_TOKEN
chmod 600 ~/.config/workflows/asana-token
```

This command should be entered by Rodrigo directly. The token must not be pasted into Pi or another agent transcript.

## Data flow and token control

1. `triage` resolves the project and configured sections.
2. It requests only compact task fields and filters assignment to the authenticated user.
3. Compact output includes GID, title, section, completion/due state, modified date, assignee, and permalink.
4. Pi invokes `task <gid> --full` for each candidate it must classify.
5. Full output keeps descriptions and comments intact but omits redundant raw Asana metadata.
6. JSON is available for scripts and preserves normalized structures, not HTTP response envelopes.
7. Pagination is followed automatically with a configurable hard safety limit; exceeding the limit fails explicitly rather than silently dropping data.

The CLI will not summarize ticket content itself. Classification remains the agent's responsibility so the original material is available for reasoning.

## Error handling

Errors use stable categories and nonzero exit codes:

- Authentication missing or rejected.
- Configuration missing or invalid.
- Alias, workspace, project, section, task, or attachment not found.
- Ambiguous project name.
- Asana rate limit, including retry guidance when available.
- Network or malformed-response failure.
- Unsafe attachment output path conditions, such as overwriting an existing file without explicit opt-in.

HTTP response bodies are sanitized and bounded before display.

## Attachment handling

`attachments` lists metadata without downloading content. `attachment download` is explicit and:

- Requests fresh attachment metadata.
- Downloads only Asana-hosted attachments that expose a download URL.
- Refuses to overwrite an existing file by default.
- Does not automatically open, execute, upload, or interpret downloaded content.

The Pi skill may ask the user before downloading many or unusually large attachments. Images can then be supplied to a model only when needed for ticket classification.

## Pi skill workflow

The `asana-triage` skill will require this sequence:

1. Run `auth status` and stop with setup instructions if unavailable.
2. Confirm identity with `me`.
3. Run compact `triage` for the requested alias.
4. Retrieve `task --full` for every candidate before classifying it.
5. List attachment metadata and download images only when their content is required.
6. Correlate with the target repository read-only.
7. Return the requested readiness table and wait for ticket selection.

The skill will prohibit modifying Asana or project source during triage.

## Testing strategy

Use `node:test` and dependency injection rather than live Asana calls.

Tests cover:

- Authentication precedence, empty tokens, and insecure file permissions.
- Authorization headers without exposing them in errors.
- Pagination and safety limits.
- Explicit Asana field selection.
- Project alias resolution and ambiguity.
- Section selection and assignee filtering.
- Full task aggregation.
- Compact and JSON output.
- Sanitized API errors and rate limits.
- Attachment download refusal on existing paths.
- CLI argument validation and exit codes.

A final manual smoke test will run `auth status`, `me`, discovery, and `triage` only after Rodrigo installs the CLI and configures the token.

## Installation and handoff

Implementation will leave the package uninstalled. After review, Rodrigo can install it from the repository root with one of:

```bash
npm install --global /home/you/projects/personal/workflows
```

or:

```bash
pnpm add --global /home/you/projects/personal/workflows
```

The README will document setup, discovery, configuration, uninstall, and troubleshooting. No global install or credential creation will be performed by the implementation agent.

## Future extensions

Not part of this version:

- Asana write operations.
- OAuth authorization flow.
- Automatic ticket-to-worktree creation.
- MCP adapter.
- Background synchronization or caching.
- Automatic image understanding.
