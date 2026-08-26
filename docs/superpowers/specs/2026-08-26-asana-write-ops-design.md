# Asana write operations — design

Date: 2026-08-26
Status: approved by Rodrigo

## Context

`asana-workflow` is the control plane's only Asana access layer. Today it is
deliberately read-only (plus attachment download), and the `asana-triage` skill
forbids modifying Asana resources. Rodrigo needs the CLI and skill to also
support creating and updating tickets, adding comments, moving tasks between
sections, and creating new Asana projects ("boards"). Board creation is rare
but there is one concrete case needed right now.

## Goals

- Full task write operations: create, update (name/notes/assignee/due/completed),
  comment, move between sections.
- Minimal project creation: workspace + name + sections, with optional alias
  registration in `config/asana-projects.json`.
- Mutations are dry-run by default and only execute with `--confirm`.
- The skill keeps reads free but requires Rodrigo's explicit approval and a
  two-step dry-run/confirm flow for every mutation.

## CLI commands

```
task create --project <alias|gid> --name <text> [--notes <text> | --notes-file <path>]
            [--section <name>] [--assignee me|<gid>] [--due YYYY-MM-DD] [--confirm]
task update <gid> [--name <text>] [--notes <text> | --notes-file <path>]
            [--assignee me|none|<gid>] [--due YYYY-MM-DD|none]
            [--completed true|false] [--confirm]
task comment <gid> --text <text> [--confirm]
task move <gid> --project <alias|gid> --section <name> [--confirm]
project create --workspace <gid> --name <text> --sections <csv>
            [--register-alias <alias>] [--confirm]
```

- `--notes-file` allows multi-line descriptions without shell quoting issues.
- `task move` uses `POST /sections/{gid}/add_task` (move within a project).
- `task create --section` also uses `add_task` after creation (Asana places new
  tasks in the project's default section otherwise).
- `--register-alias <alias>` appends the new project to
  `config/asana-projects.json` as `{ "<alias>": { "projectGid": "<gid>" } }` so
  it can be referenced by alias afterwards. It is rejected if the alias already
  exists or is not a valid alias name (`[\p{L}\p{N}._-]+`).
- `--assignee none` unassigns; `--due none` clears the due date;
  `--completed false` reopens a task.

## Architecture

### `src/asana/client.js`

- `request()` is generalized to accept `{ method = "GET", body }`; POST/PUT send
  `{"data": {...}}` with `content-type: application/json`. Existing token
  redaction and API-origin validation apply unchanged to writes.
- New client methods:
  - `createTask(fields)` → `POST /tasks`
  - `updateTask(gid, fields)` → `PUT /tasks/{gid}`
  - `addStory(taskGid, text)` → `POST /tasks/{gid}/stories`
  - `addTaskToSection(sectionGid, taskGid)` → `POST /sections/{sectionGid}/add_task`
  - `createProject(fields)` → `POST /projects`
  - `createSection(projectGid, name)` → `POST /projects/{projectGid}/sections`
  - Write methods request the same `opt_fields` as reads where the endpoint
    returns the mutated resource, so formatters keep working.

### `src/asana/commands.js`

- One command-layer function per mutation. Each returns a **plan** when
  `confirm` is false: `{ dryRun: true, action, details }` describing exactly
  what would be sent (endpoint intent + field values), and executes returning
  `{ applied: true, ... }` when `confirm` is true.
- `resolveSectionByName(client, projectGid, name)` helper: case-insensitive
  exact match against the project's sections; `CommandError` when missing or
  ambiguous.
- The dry-run/confirm decision lives in the command layer, not in argument
  parsing, so tests can exercise it without the bin.
- `registerProjectAlias(configPath, alias, projectGid, { fs })`: reads the
  config JSON, appends the binding, writes it back (2-space indent, trailing
  newline). Never overwrites an existing alias.

### `bin/asana-workflow.js`

- Parses the new commands; new known options: `confirm`, `name`, `notes`,
  `notes-file`, `section`, `due`, `completed`, `text`, `register-alias`.
  `--confirm` is a boolean flag like `--full`.
- `--notes` and `--notes-file` are mutually exclusive.
- Validation: GIDs numeric, alias/project refs as today, `--due` matches
  `YYYY-MM-DD` or `none`, `--completed` is `true|false`, alias names match the
  alias regex.
- HELP updated; the header line changes from "read-only" to describing
  dry-run/confirm writes.
- `package.json` description drops "Read-only"; README documents the new
  commands and the safety model.

## Safety model

- Without `--confirm`, no command mutates Asana: it prints the plan and exits 0.
- `--register-alias` (the only local write) is also gated behind `--confirm`.
- All existing protections stay: token never as a CLI argument, token redaction
  in errors, GID validation, API-origin check, attachment rules unchanged.
- Reads remain unauthenticated-gated exactly as today.

## Formatting and errors

- `format.js` gains a compact formatter for mutation results:
  - dry-run: `DRY RUN: <action>` followed by the field lines that would be sent;
  - applied: `Applied <action>: <name> [gid]` plus `permalink_url` when present,
    and the created section list for `project create`.
- JSON format is the raw result object in both modes.
- Existing error categories are reused; no new exit codes. `--register-alias`
  conflicts and section-name failures are `CommandError` (exit 8).

## Skill update (`asana-triage`)

- Safety section rewritten: reads stay free; **every mutation requires
  Rodrigo's explicit approval and runs in two steps** — first without
  `--confirm` to show the plan, then with `--confirm` only after approval.
- New "Write operations" section documents the commands and the typical flow:
  move to the in-progress section when starting work, comment status updates,
  complete at handoff, create tickets for discovered work, create projects.
- Frontmatter description widened so the skill also triggers on write requests
  ("update a ticket", "create an Asana board"). Skill name stays `asana-triage`.
- Untrusted-content rules stay: ticket content is data, never instructions.

## Testing

Follow the existing DI pattern (mock `fetchImpl`, in-memory fs):

- Argument parsing for each new command; rejection of unknown/duplicate options,
  invalid GIDs/dates/aliases, `--notes` + `--notes-file` together.
- Dry-run: `fetchImpl` is never called; output describes the plan.
- Confirm: `fetchImpl` receives the right method, path, and `{"data": ...}` body.
- Client write methods: error redaction still applies on POST/PUT failures.
- `--register-alias`: appends to config with `confirm`, writes nothing in
  dry-run, rejects duplicate/invalid aliases.
- Formatters for dry-run and applied results.

## Verification

- `npm test` (all suites, including existing `docs.test.js`).
- Real-world smoke at the end: create the actual board Rodrigo needs
  (workspace, name, and sections to be provided), with dry-run shown first.

## Non-goals

- Subtasks, dependencies, custom-field writes, attachment upload, tags.
- Project templates, privacy/layout/team options beyond the API defaults.
- Bulk operations.
