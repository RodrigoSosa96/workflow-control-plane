const OUTPUT_LIMIT = 12000;
const ASSIGNMENT_OUTPUT_LIMIT = 64 * 1024;

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = normalizeJson(value[key]);
    return result;
  }, {});
}

function bound(text, limit = OUTPUT_LIMIT, marker = "output") {
  const value = String(text);
  if (value.length <= limit) return value;
  const suffix = `\n...[${marker} truncated at ${limit} characters]`;
  return value.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null) : [];
}

function text(value, fallback = "unknown") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function addConflicts(lines, conflicts = []) {
  if (!conflicts.length) return;
  lines.push("Conflicts:");
  for (const conflict of conflicts) {
    lines.push(`- ${conflict.resource}: ${conflict.reason}`);
  }
}

function addPreconditions(lines, preconditions = {}) {
  const checks = Object.values(preconditions).filter((value) => value && typeof value === "object" && value.id && value.status);
  if (!checks.length) return;
  lines.push("Preconditions:");
  for (const check of checks) {
    lines.push(`${check.id} | ${check.status}${check.reason ? ` | ${check.reason}` : ""}`);
  }
}

function formatDoctor(result) {
  const lines = [
    `Doctor: ${result.ok ? "ready" : "needs attention"}`,
  ];
  if (result.project) {
    lines.push(`Project: ${result.project.label} [${result.project.alias}]`);
  }
  for (const check of result.checks ?? []) {
    lines.push(`${check.id} | ${check.status}${check.reason ? ` | ${check.reason}` : ""}`);
  }
  if (Array.isArray(result.agentProfiles) && result.agentProfiles.length > 0) {
    lines.push("Agent profiles:");
    for (const profile of result.agentProfiles) {
      lines.push(`- ${profile.name} | ${profile.harness} | ${profile.command}`);
    }
  }
  return bound(lines.join("\n"));
}

function formatPlanLike(result) {
  const lines = [
    `Project: ${result.project.label} [${result.project.alias}]`,
    `Status: ${result.reconciliation.status}`,
  ];
  addPreconditions(lines, result.preconditions);
  if (result.nextCommand) lines.push(`Next: ${result.nextCommand}`);
  addConflicts(lines, result.conflicts?.length ? result.conflicts : result.reconciliation.conflicts);
  if (result.suggestedManifest) {
    lines.push(`Suggested manifest: ${result.suggestedManifest.path}`);
    lines.push(JSON.stringify(normalizeJson(result.suggestedManifest.payload), null, 2));
  }
  return bound(lines.join("\n"));
}

function identityFrom(value = {}) {
  const reconciliationIdentity = value.reconciliation?.identity ?? {};
  const request = value.request ?? {};
  return {
    projectAlias: value.project?.alias ?? reconciliationIdentity.projectAlias ?? value.projectAlias,
    projectLabel: value.project?.label ?? reconciliationIdentity.projectLabel ?? value.projectLabel,
    primaryTicket: request.task ?? reconciliationIdentity.primaryTicket ?? reconciliationIdentity.task ?? value.primaryTicket ?? value.task,
    relatedTickets: list(request.relatedTickets ?? reconciliationIdentity.relatedTickets ?? value.relatedTickets).map(String),
  };
}

function permissionLine(selection = {}) {
  const permissions = selection.permissions ?? {};
  if (permissions.permission_mode) return String(permissions.permission_mode);
  const entries = Object.entries(permissions)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length ? entries.join(", ") : "default";
}

function writableRootsFor(value = {}) {
  const reconciliation = value.reconciliation ?? {};
  const worktreeRoots = [
    reconciliation.workspace?.path,
    ...list(reconciliation.worktrees).map((worktree) => worktree.path),
    ...list(reconciliation.repositories).map((repository) => repository.worktreePath ?? repository.path),
  ];
  const runRoot = value.runDirectory ?? value.executionInput?.options?.runDirectory ?? value.executionInput?.options?.stateRoot;
  return unique([...worktreeRoots, runRoot]);
}

function assignmentPathFor(value = {}) {
  return value.assignmentPath ?? (value.runDirectory ? `${value.runDirectory}/assignment.md` : null);
}

function formatAssignmentText(assignment, assignmentPath) {
  const value = String(assignment ?? "");
  if (value.length <= ASSIGNMENT_OUTPUT_LIMIT) return value;
  const pathText = assignmentPath ?? "<not saved during dry-run>";
  const suffix = `\n...[assignment truncated at ${ASSIGNMENT_OUTPUT_LIMIT} characters; complete assignment saved at ${pathText}]`;
  return value.slice(0, Math.max(0, ASSIGNMENT_OUTPUT_LIMIT - suffix.length)) + suffix;
}

function formatLaunchPreview(value) {
  const identity = identityFrom(value);
  const lines = [
    `Project: ${text(identity.projectLabel)} [${text(identity.projectAlias)}]`,
    `Primary ticket: ${text(identity.primaryTicket)}`,
    `Related tickets: ${identity.relatedTickets.length ? identity.relatedTickets.join(", ") : "none"}`,
    `Agent profile: ${text(value.selection?.profileName)}`,
    `Harness: ${text(value.selection?.harness)}`,
    `Permission mode: ${permissionLine(value.selection)}`,
    `Writable roots: ${writableRootsFor(value).join(", ") || "none"}`,
    `Approval digest: ${text(value.approvalDigest)}`,
    `Launch argv: ${Array.isArray(value.launchSpec?.argv) ? JSON.stringify(value.launchSpec.argv) : "unavailable"}`,
    "Assignment:",
    formatAssignmentText(value.assignment, assignmentPathFor(value)),
  ];
  return lines.join("\n");
}

function commandValue(value, key, fallback) {
  return value[key] ?? value.commands?.[key] ?? fallback;
}

function workspacePath(value = {}) {
  return value.workspace?.path ?? value.workspacePath ?? value.fallbackWorkspace ?? null;
}

function workspaceId(value = {}) {
  return value.workspace?.id ?? value.workspace?.workspaceId ?? value.workspaceId ?? null;
}

function formatLaunchRun(value) {
  const resultCommand = commandValue(value, "resultCommand", value.runId ? `workflow result ${value.runId}` : null);
  const reconcileCommand = commandValue(value, "reconcileCommand", value.runId ? `workflow reconcile --run ${value.runId}` : null);
  const lines = [
    `Run: ${text(value.runId)}`,
    `Launch status: ${text(value.status)}`,
    `State: ${text(value.state ?? value.status)}`,
    `Harness: ${text(value.harness)}`,
    `Agent profile: ${text(value.profileName)}`,
    `Run directory: ${text(value.runDirectory)}`,
    `Workspace: ${text(workspacePath(value))}`,
  ];
  if (workspaceId(value)) lines.push(`Workspace ID: ${workspaceId(value)}`);
  lines.push(`Tab: ${text(value.tabId)}`);
  lines.push(`Pane: ${text(value.paneId)}`);
  if (resultCommand) lines.push(`Result: ${resultCommand}`);
  if (value.statusCommand) lines.push(`Status: ${value.statusCommand}`);
  if (reconcileCommand) lines.push(`Reconcile: ${reconcileCommand}`);
  lines.push(`Fallback workspace: ${text(value.fallbackWorkspace ?? workspacePath(value))}`);
  if (Array.isArray(value.guidance) && value.guidance.length > 0) {
    lines.push("Guidance:");
    for (const item of value.guidance) lines.push(`- ${item}`);
  }
  return bound(lines.join("\n"));
}

function formatLaunch(value) {
  return value && Object.hasOwn(value, "assignment")
    ? formatLaunchPreview(value)
    : formatLaunchRun(value);
}

function formatResult(value) {
  const lines = [
    `Run: ${text(value.runId)}`,
    `Status: ${text(value.status)}`,
  ];
  if (value.state) lines.push(`State: ${value.state}`);
  if (value.result?.summary) lines.push(`Summary: ${value.result.summary}`);
  if (value.resultCommand) lines.push(`Result: ${value.resultCommand}`);
  if (value.statusCommand) lines.push(`Status command: ${value.statusCommand}`);
  if (value.reconcileCommand) lines.push(`Reconcile: ${value.reconcileCommand}`);
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    lines.push("Errors:");
    for (const error of value.errors) lines.push(`- ${error}`);
  }
  if (Array.isArray(value.nextActions) && value.nextActions.length > 0) {
    lines.push("Next actions:");
    for (const action of value.nextActions) lines.push(`- ${action}`);
  }
  return bound(lines.join("\n"));
}

function ageLabel(ageMs) {
  return Number.isFinite(ageMs) ? `${ageMs}ms` : "unknown";
}

function formatReconcile(value) {
  const lines = [
    `Run: ${text(value.runId)}`,
    `Status: ${text(value.status)}`,
  ];
  if (value.projectAlias) lines.push(`Project: ${value.projectLabel ? `${value.projectLabel} ` : ""}[${value.projectAlias}]`);
  if (value.state) lines.push(`State: ${value.state}`);
  if (value.fallbackWorkspace) lines.push(`Fallback workspace: ${value.fallbackWorkspace}`);
  // Only present when the run's lock is currently held (reconcileCommand omits the field
  // entirely otherwise) -- surfaces the same provable-ownership verdict `workflow unlock` itself
  // classifies against, in the format an operator actually reads by default (compact), not just
  // buried in --format json. Age is shown for context only; it is never grounds for removal.
  if (value.lock) {
    const { ageMs, stale, ownership } = value.lock;
    const reason = ownership?.reason ? ` | ${ownership.reason}` : "";
    lines.push(`Lock: ${text(ownership?.verdict)} | age ${ageLabel(ageMs)} | stale: ${stale ? "yes" : "no"}${reason}`);
  }
  if (Array.isArray(value.nextActions) && value.nextActions.length > 0) {
    lines.push("Next actions:");
    for (const action of value.nextActions) lines.push(`- ${action}`);
  }
  lines.push("Cleanup: none");
  return bound(lines.join("\n"));
}

function formatResume(value) {
  const lines = [`Run: ${text(value.runId)}`, `resume: ${text(value.action)}`];
  if (value.reason) lines.push(`Reason: ${value.reason}`);
  return bound(lines.join("\n"));
}

function formatClose(value) {
  const status = value.closed ? "closed" : "refused";
  const lines = [`Run: ${text(value.runId)}`, `close: ${status}${value.reason ? ` ${value.reason}` : ""}`];
  return bound(lines.join("\n"));
}

function workerMeasurement(value) {
  if (!value || typeof value !== "object") return "unknown";
  return value.availability === "reported" && Number.isFinite(value.value)
    ? String(value.value)
    : text(value.availability, "unknown");
}

function publicWorker(worker = {}) {
  const usage = worker.usage && typeof worker.usage === "object" ? worker.usage : {};
  return {
    workerId: worker.workerId ?? null,
    harness: worker.harness ?? null,
    profileName: worker.profileName ?? null,
    phase: worker.phase ?? "unknown",
    observability: worker.observability ?? "unknown",
    startedAt: worker.startedAt ?? null,
    updatedAt: worker.updatedAt ?? null,
    turns: Number.isInteger(worker.turns) ? worker.turns : 0,
    tools: worker.tools && typeof worker.tools === "object"
      ? { count: Number.isInteger(worker.tools.count) ? worker.tools.count : 0, lastName: worker.tools.lastName ?? null }
      : { count: 0, lastName: null },
    retries: worker.retries && typeof worker.retries === "object"
      ? { attempt: Number.isInteger(worker.retries.attempt) ? worker.retries.attempt : 0, maxAttempts: Number.isInteger(worker.retries.maxAttempts) ? worker.retries.maxAttempts : 0 }
      : { attempt: 0, maxAttempts: 0 },
    model: worker.model ?? null,
    thinking: worker.thinking && typeof worker.thinking === "object"
      ? { availability: worker.thinking.availability ?? "unknown", value: worker.thinking.value ?? null }
      : { availability: "unknown", value: null },
    usage: {
      input: { availability: usage.input?.availability ?? "unknown", value: usage.input?.value ?? null },
      output: { availability: usage.output?.availability ?? "unknown", value: usage.output?.value ?? null },
      cacheRead: { availability: usage.cacheRead?.availability ?? "unknown", value: usage.cacheRead?.value ?? null },
      cacheWrite: { availability: usage.cacheWrite?.availability ?? "unknown", value: usage.cacheWrite?.value ?? null },
      cost: { availability: usage.cost?.availability ?? "unknown", value: usage.cost?.value ?? null },
      context: { availability: usage.context?.availability ?? "unknown", value: usage.context?.value ?? null },
    },
  };
}

function publicWorkerResult(value = {}) {
  return {
    command: value.command,
    runId: value.runId ?? null,
    workers: list(value.workers).map((worker) => publicWorker(worker)),
  };
}

function formatWorkers(value) {
  const result = publicWorkerResult(value);
  if (!result.workers.length) return `Run: ${text(result.runId)}\nWorkers: none`;
  return result.workers.map((worker) => [
    `[${text(worker.harness)} • ${text(worker.workerId)} • ${text(worker.phase)}] model: ${text(worker.model, "not-reported")} | turn ${worker.turns}`,
    `usage: ${workerMeasurement(worker.usage.input)} input / ${workerMeasurement(worker.usage.output)} output | cost: ${workerMeasurement(worker.usage.cost)}`,
  ].join("\n")).join("\n");
}

function formatDelegation(value) {
  const lines = [
    `Run: ${text(value.runId)}`,
    `Delegation: ${text(value.delegationId)}`,
    `Role: ${text(value.role)}`,
    `Mode: ${text(value.mode)}`,
    `State: ${text(value.state)}`,
    `Generation: ${text(value.generation)}`,
    `Result status: ${text(value.resultStatus)}`,
  ];
  if (value.approvalDigest) lines.push(`Approval digest: ${value.approvalDigest}`);
  if (Array.isArray(value.nextActions) && value.nextActions.length > 0) {
    lines.push("Next actions:");
    for (const action of value.nextActions) lines.push(`- ${action}`);
  }
  return bound(lines.join("\n"));
}

// --- formatRuns: the compact board for `workflow runs` (roadmap item 2.1) ----------------------
//
// No worktree column: verified against a real record, the paths live inside `repositories[]` as
// `{id, path, branch}`, one entry per repository, and a multi-repo run carries several under one
// shared worktree root. A table column cannot honestly render that -- `--format json` carries
// `repositories` in its own documented projection instead (see `runProjection` below -- not the
// raw record; a board-scale JSON dump of every field turned out not to fit the shared output
// budget, see that function's own comment); an operator who needs the paths runs `workflow result
// <run-id>`. So this renderer only ever reads `id`/`state`/`projectAlias`/`primaryTicket`/
// `harness`/`updatedAt` off a run record -- never `repositories`, `runDirectory`, `stateRoot`, or
// anything else that could carry a filesystem path.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Clock is injectable (`deps.now`, defaulting to the real `Date.now`) purely so tests can pin an
// instant instead of asserting against the wall clock. Production callers (formatWorkflowResult,
// and therefore the CLI) never pass one.
function relativeTimeFrom(timestamp, nowMs) {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return "unknown";
  const diffMs = Math.max(0, nowMs - then);
  if (diffMs < MINUTE_MS) return "just now";
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  return `${Math.floor(diffMs / DAY_MS)}d ago`;
}

// First 8 characters of an id, display only -- every place that actually needs the full id
// (--run, result, reconcile) still reads it straight off the record, never off this rendering.
// The slice length matches relaunchSession's own display shortening of a session id
// (commands.js's shortSessionId); the "unknown" fallback does not -- that one falls back to
// "session" because it feeds a Herdr agent name, not a table cell. Also reused by
// hooks/claude-statusline.mjs, which already imports from this module -- one definition instead
// of two copies of the same 8-char-slice-with-fallback concept.
export function shortRunId(id) {
  return String(id ?? "").slice(0, 8) || "unknown";
}

const RUNS_COLUMNS = [
  { key: "run", label: "RUN" },
  { key: "state", label: "STATE" },
  { key: "project", label: "PROJECT" },
  { key: "ticket", label: "TICKET" },
  { key: "harness", label: "HARNESS" },
  { key: "updated", label: "UPDATED" },
];

function runRow(run, nowMs) {
  return {
    run: shortRunId(run.id),
    state: text(run.state),
    project: text(run.projectAlias),
    ticket: text(run.primaryTicket),
    harness: text(run.harness),
    updated: relativeTimeFrom(run.updatedAt, nowMs),
  };
}

// Each column's width is the max of its header label and every row's own value -- recomputed per
// call, never a fixed budget -- so one long project alias or ticket only ever widens its own
// column for this render. It cannot misalign, truncate, or bleed into a neighbour, and it cannot
// affect any other call's output. The trailing `.trimEnd()` only ever removes padding after the
// last column, so it never touches alignment of the columns before it.
//
// Shared by formatRuns (RUNS_COLUMNS) and formatInbox (INBOX_COLUMNS below) -- one table
// implementation, not two copies of the same width/pad/join logic for two different column sets.
function renderTable(columns, rows) {
  const widths = columns.map((column) => (
    Math.max(column.label.length, ...rows.map((row) => row[column.key].length))
  ));
  const renderRow = (values) => columns
    .map((column, index) => values[column.key].padEnd(widths[index]))
    .join(" | ")
    .trimEnd();
  const header = renderRow(Object.fromEntries(columns.map((column) => [column.key, column.label])));
  return [header, ...rows.map((row) => renderRow(row))];
}

// Crash residue item 0.3's list() skips rather than swallows: named as a count and the ids,
// following this file's no-blank-line-between-sections idiom (formatDoctor, formatPlanLike).
// Shared by formatRuns and formatInbox below -- both boards report the same skip shape
// (`{runId, ...}`) the same way, and this repo is sensitive to letting that drift into two
// copies (see renderTable's own comment for the same reasoning applied to the table itself).
function appendSkippedLine(lines, skipped) {
  if (skipped.length === 0) return;
  const ids = skipped.map((problem) => text(problem.runId)).join(", ");
  lines.push(`Skipped: ${skipped.length} (${ids})`);
}

export function formatRuns(value = {}, deps = {}) {
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const runs = list(value.runs);
  const skipped = list(value.skipped);

  // A blank response is indistinguishable from a broken command -- an empty board says so
  // explicitly rather than printing nothing.
  const lines = runs.length === 0
    ? ["Runs: none"]
    : renderTable(RUNS_COLUMNS, runs.map((run) => runRow(run, nowMs)));

  appendSkippedLine(lines, skipped);

  return bound(lines.join("\n"));
}

// --- formatInbox: the compact view for `workflow inbox` (roadmap item 2.2) ---------------------
//
// Deliberately reuses formatRuns's shape rather than inventing a second board style (see that
// function's own comment): a table for the actionable entries -- here, blocked runs instead of
// every run -- an explicit line when there is nothing to report, and residue named underneath
// rather than folded into the table or dropped. `inboxCommand`'s entries (`{runId, state,
// projectAlias, primaryTicket, harness, paneId[, reason]}`, commands.js's `inboxEntry`) are
// already as small as `runs --format json`'s own projection, so there is no separate projection
// step here the way runProjection exists for `runs` -- `--format json` below carries them
// unchanged.
//
// Three lists, not two -- **correction, recorded after running this command against the
// developer's real state root** (see the correction paragraph in
// docs/superpowers/specs/2026-08-04-workflow-inbox-design.md): a run in `manual-handoff-required`,
// `needs-input`, or self-reported `blocked` (`RUN_STATES.BLOCKED`, added by the branch-review I3
// fix -- a worker's own "I am stuck" is exactly as unambiguous as the other two) whose worker
// already exited is not a diagnostic, it is the run doing exactly what that state means. `blocked`
// (a live pane, sitting at a prompt right now, per Herdr's `agent_status`) and `waiting` (the
// run's own state already means it needs the operator, decided by `AWAITS_OPERATOR_STATES` in
// commands.js independent of whether the agent even resolved -- see the C1 fix) are both
// actionable "this needs you" sections; `unresolved` stays a genuine diagnostic, covering an
// *active* run (running/launching/idle-awaiting-handoff/result-stale) whose agent could not be
// confirmed live or classified into a recognized status -- that one really is surprising, because
// an active run's worker is supposed to still be there.

// No STATE column here, unlike RUNS_COLUMNS -- a deliberate call, made explicit during the branch
// review (M10 finding). Every entry the compact `blocked` table renders shares one identical
// actionable meaning regardless of the run's underlying `state`: a live agent is confirmed sitting
// at a permission prompt right now, and the operator's move is the same either way -- attach, or
// `herdr agent send-keys` by pane. The `waiting`/`unresolved` sections below already surface state
// where it changes what to do (their `reason` text literally names the state, e.g. "Waiting on you
// (manual-handoff-required)"), and `--format json` carries `state` on every entry unconditionally
// (inboxEntry, commands.js) for a consumer that wants it. Revisit if a future bucket ever needs the
// distinction to decide an action, not just to satisfy curiosity the JSON already answers.
const INBOX_COLUMNS = [
  { key: "run", label: "RUN" },
  { key: "project", label: "PROJECT" },
  { key: "ticket", label: "TICKET" },
  { key: "harness", label: "HARNESS" },
  { key: "pane", label: "PANE" },
];

function inboxRow(entry) {
  return {
    run: shortRunId(entry.runId),
    project: text(entry.projectAlias),
    ticket: text(entry.primaryTicket),
    harness: text(entry.harness),
    pane: text(entry.paneId),
  };
}

// Shared by the `waiting` and `unresolved` sections below -- both are `inboxEntry` plus a
// `reason`, and both render the same way: run, project/ticket, harness, then the reason. The two
// sections' *reason text* differs in framing (commands.js's `awaitsOperatorReason` vs. the
// verbatim diagnostic cause), not in shape, so one line renderer covers both. A `waiting` reason
// deliberately does not repeat the vanished-pane detail `unresolved`'s does (e.g. "No live Herdr
// agent found for pane w1:p1") -- see AWAITS_OPERATOR_STATES's comment in commands.js for why
// that framing is exactly what `waiting` exists to avoid.
function reasonLine(entry) {
  return `${shortRunId(entry.runId)} | ${text(entry.projectAlias)}/${text(entry.primaryTicket)} | ${text(entry.harness)} | ${text(entry.reason)}`;
}

export function formatInbox(value = {}) {
  const blocked = list(value.blocked);
  const waiting = list(value.waiting);
  const unresolved = list(value.unresolved);
  const skipped = list(value.skipped);

  // "Nothing waiting on you" is only honest when nothing is blocked, nothing is waiting on the
  // operator by its own state, AND nothing is uncertain -- an unresolved run's status is unknown,
  // not confirmed clear, so it might in fact be blocked. Reassuring the operator in that case
  // would be exactly the false negative this whole command exists to avoid (see the design spec's
  // "reported, not dropped" section). A board with nothing blocked but something waiting or
  // unresolved instead says "Blocked: none" and lets the sections underneath speak for themselves
  // -- never silence, following formatRuns's own "a blank response is indistinguishable from a
  // broken command" reasoning.
  const lines = blocked.length === 0 && waiting.length === 0 && unresolved.length === 0
    ? ["Nothing waiting on you"]
    : blocked.length === 0
      ? ["Blocked: none"]
      : renderTable(INBOX_COLUMNS, blocked.map(inboxRow));

  // `waiting` before `unresolved`: both need the operator's attention, but `waiting` already
  // names what to do (`workflow result <run-id>`) while `unresolved` is still an open question --
  // the actionable section comes first.
  if (waiting.length > 0) {
    lines.push("Waiting on you:");
    for (const entry of waiting) lines.push(reasonLine(entry));
  }

  if (unresolved.length > 0) {
    lines.push("Unresolved:");
    for (const entry of unresolved) lines.push(reasonLine(entry));
  }

  // Crash residue, reported the same way formatRuns reports it -- appendSkippedLine, not a second
  // copy of the count-and-ids logic.
  appendSkippedLine(lines, skipped);

  return bound(lines.join("\n"));
}

// The projection roadmap item 2.1's design spec promised ("machines get complete records") was
// wrong at board scale, and the wrongness is measured, not theoretical: against the 8 real runs
// on the machine that first ran this command, whole records serialize to 53,791 characters for
// `--all` and 11,895 for the (2-record) default view -- both against the one shared
// OUTPUT_LIMIT (12000 characters, this file's top). `--all` already lost: boundedJson's overflow
// fallback keeps only `{command, runId?, status?, truncated, truncationMarker}`, and a `runs`
// result has neither `runId` nor `status` for it to preserve, so the fallback degrades to zero
// run data. The default view was 105 bytes from the same fate. Runs accumulate forever -- there
// is no cleanup until item 2.5 -- so both numbers only grow.
//
// A board is a summary; emitting every field of a run record (~44 of them --
// docs/run-record-fields.md -- stateHistory, telemetry, launchOperations, launchArgv, request,
// digests, delegations, ...) was never the right shape for "what is running". This projects each
// run down to what a board's consumer needs, and nothing else. See this spec's correction
// paragraph: docs/superpowers/specs/2026-08-04-workflow-runs-board-design.md.
//
// Field-by-field:
//   - id, directory: what makes a run addressable. `id` is what `workflow result <id>` and every
//     other run-scoped command take; `directory` is the run's own location on disk -- neither the
//     compact table renders it (runRow's own comment says why), so JSON is the only place a
//     consumer gets it.
//   - state, projectAlias, primaryTicket, harness, updatedAt: the board's own compact columns
//     (RUNS_COLUMNS above), carried unabbreviated -- e.g. the full id rather than shortRunId's
//     8-character display slice.
//   - repositories: the one field the compact table CANNOT honestly render at all -- a multi-repo
//     run has one `{id, path, branch}` entry per repository, not a single "worktree" column could
//     hold (see formatRuns's own comment on why the table drops it) -- and therefore the specific
//     reason the design spec promised `--format json` would carry more than the table. This is
//     the field a tool consuming the board actually wants.
// Everything else stays out on purpose. An operator or script that needs the rest already has the
// tool sized for exactly that: `workflow result <run-id>` returns one run's full record.
function runProjection(run) {
  if (!run || typeof run !== "object") return run;
  return {
    id: run.id,
    directory: run.directory,
    state: run.state,
    projectAlias: run.projectAlias,
    primaryTicket: run.primaryTicket,
    harness: run.harness,
    updatedAt: run.updatedAt,
    repositories: run.repositories,
  };
}

function valueForJson(command, value) {
  if (command === "worker-status" || command === "worker-watch") return publicWorkerResult(value);
  if (command === "runs") {
    if (!value || typeof value !== "object") return value;
    return { ...value, runs: list(value.runs).map(runProjection) };
  }
  if (command !== "launch" || !value || typeof value !== "object" || !Object.hasOwn(value, "assignment")) {
    return value;
  }
  const executionInput = value.executionInput && typeof value.executionInput === "object"
    ? {
      ...value.executionInput,
      options: value.executionInput.options && typeof value.executionInput.options === "object"
        ? {
          ...value.executionInput.options,
          ...(Object.hasOwn(value.executionInput.options, "request") ? { request: "[redacted; preserved in assignment]" } : {}),
        }
        : value.executionInput.options,
    }
    : value.executionInput;
  return {
    ...value,
    executionInput,
    assignment: formatAssignmentText(value.assignment, assignmentPathFor(value)),
    assignmentTruncated: String(value.assignment ?? "").length > ASSIGNMENT_OUTPUT_LIMIT,
  };
}

// The general fallback below (`{command, runId?, status?, truncated, truncationMarker}`) was built
// for single-record commands, where "rerun narrower" is real advice: `result`/`reconcile` take one
// run id, so a caller can always ask for less. `runs` broke that assumption in two ways, found
// measuring this board against real data (see runProjection's own comment above for the numbers):
// first, a `runs` result has neither `runId` nor `status`, so the general fallback degrades to
// `{command, truncated, truncationMarker}` -- a consumer doing `result.runs.length` throws, and one
// doing `result.runs?.length ?? 0` silently reports "no runs", the opposite of "the board
// overflowed". Second, the general marker's "rerun with a narrower result query" is not actionable
// for this command: there is no `--limit`, and the default view (the live-state set) is already
// the narrowest query this command has -- `--state <state>` can narrow further only when more than
// one live state is actually present, so it is offered, not promised.
//
// The fix: keep `runs` present (as `[]`, never absent) so "empty" and "overflowed" stay
// distinguishable by more than a missing key, and preserve every run's full id -- not
// `shortRunId`'s 8-character display slice, which is not what `workflow result <run-id>` accepts
// (see shortRunId's own comment) -- so the response an overflow returns is still actionable one run
// at a time. `skippedCount` is carried too, for the same reason `formatRuns` never drops skipped
// residue on the compact side: a collapse must not read as "no crash residue either".
function runsOverflowFallback(command, source, limit) {
  const droppedRuns = list(source.runs);
  // runCount counts every dropped run, even a malformed one missing `id`; runIds can only ever
  // carry the ones that had a usable id to preserve -- so the two are allowed to disagree, and
  // runCount is the one that must equal what actually overflowed.
  const runIds = droppedRuns.map((run) => run?.id).filter((id) => typeof id === "string" && id.length > 0);
  return {
    command: source.command ?? command,
    runs: [],
    runCount: droppedRuns.length,
    runIds,
    skippedCount: list(source.skipped).length,
    truncated: true,
    truncationMarker: `JSON output truncated at ${limit} characters; ${droppedRuns.length} runs did not fit and were dropped from this response (their ids are in runIds). There is no --limit flag for this command; --state <state> narrows further if more than one live state is present, and \`workflow result <run-id>\` inspects one run at a time.`,
  };
}

// `inbox` entries are far smaller than a full run record (see formatInbox's own comment), but
// they are not immune to the same collapse `runs` measured. Measured directly against this file's
// own `formatWorkflowResult("inbox", ..., "json")`, the same way the `runs` numbers above were
// measured, at this fixture's field lengths (a realistic-looking combination of long project
// aliases, tickets, and pane ids -- see test/workflow-format.test.js's `realisticEntry`):
// **correction, re-measured during branch review** (the original comment here said "~45 combined
// ... entries", stated as measured but off by about 20% for the composition it actually
// described) -- an even three-way split across blocked/waiting/unresolved (`waiting` and
// `unresolved` entries also carry a `reason` string the `blocked` ones do not) first exceeds
// OUTPUT_LIMIT at **n=37** (n=36 = 11,908 characters, 99.2% of budget; n=37 collapses to the
// overflow fallback below); a blocked-only inbox (no `reason` field on any entry, so each entry
// costs less) does not cross until **n=47** (n=46 = 11,758 characters). "~45" was only ever right
// for the blocked-heavy case; a mixed inbox -- the composition this comment actually described --
// overflows about 20% earlier. Both numbers only ever shrink further as the fixture's field
// lengths shrink, so they are upper bounds on how much headroom an operator actually has, not
// promises of at least this many. All three lists inbox accumulates from -- non-terminal runs, and
// the `no cleanup until item 2.5` growth `runs`'s own comment names -- only grow while an operator
// lets runs sit open. `inbox` also has neither `runId` nor `status`, so the
// general fallback below would degrade exactly the way it did for `runs` before that fix: a bare
// `{command, truncated, truncationMarker}` with the blocked/waiting/unresolved data gone and no
// way to tell "quiet" from "overflowed" apart. Same fix, same shape: `blocked`/`waiting`/
// `unresolved` stay present as `[]`, counts and ids survive so a consumer can still act one run at
// a time, `skippedCount` preserves 0.3's crash-residue visibility, and the marker names this
// command's actual affordance (`--project`, not a `--limit` or `--state` this command does not
// have).
function inboxOverflowFallback(command, source, limit) {
  const droppedBlocked = list(source.blocked);
  const droppedWaiting = list(source.waiting);
  const droppedUnresolved = list(source.unresolved);
  const idsOf = (entries) => entries.map((entry) => entry?.runId).filter((id) => typeof id === "string" && id.length > 0);
  return {
    command: source.command ?? command,
    blocked: [],
    waiting: [],
    unresolved: [],
    blockedCount: droppedBlocked.length,
    blockedRunIds: idsOf(droppedBlocked),
    waitingCount: droppedWaiting.length,
    waitingRunIds: idsOf(droppedWaiting),
    unresolvedCount: droppedUnresolved.length,
    unresolvedRunIds: idsOf(droppedUnresolved),
    herdrAvailable: Boolean(source.herdrAvailable),
    skippedCount: list(source.skipped).length,
    truncated: true,
    truncationMarker: `JSON output truncated at ${limit} characters; ${droppedBlocked.length + droppedWaiting.length + droppedUnresolved.length} inbox entries did not fit and were dropped from this response (their ids are in blockedRunIds/waitingRunIds/unresolvedRunIds). There is no --limit flag for this command; --project narrows if more than one project has live runs, and \`workflow result <run-id>\` inspects one run at a time.`,
  };
}

function boundedJson(command, value) {
  const text = JSON.stringify(normalizeJson(valueForJson(command, value)), null, 2);
  const limit = command === "launch" ? ASSIGNMENT_OUTPUT_LIMIT + OUTPUT_LIMIT : OUTPUT_LIMIT;
  if (text.length <= limit) return text;

  const source = value && typeof value === "object" ? value : {};
  if (command === "runs") {
    return JSON.stringify(normalizeJson(runsOverflowFallback(command, source, limit)), null, 2);
  }
  if (command === "inbox") {
    return JSON.stringify(normalizeJson(inboxOverflowFallback(command, source, limit)), null, 2);
  }
  return JSON.stringify(normalizeJson({
    command: source.command ?? command,
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.status ? { status: source.status } : {}),
    truncated: true,
    truncationMarker: `JSON output truncated at ${limit} characters; rerun with a narrower result query.`,
  }), null, 2);
}

export function formatWorkflowResult(command, value, format = "compact") {
  if (format === "json") {
    return boundedJson(command, value);
  }

  switch (command) {
    case "doctor":
      return formatDoctor(value);
    case "plan":
    case "status":
      return formatPlanLike(value);
    case "launch":
      return formatLaunch(value);
    case "result":
      return formatResult(value);
    case "reconcile":
      return formatReconcile(value);
    case "resume":
      return formatResume(value);
    case "close":
      return formatClose(value);
    case "runs":
      return formatRuns(value);
    case "inbox":
      return formatInbox(value);
    case "worker-status":
    case "worker-watch":
      return bound(formatWorkers(value));
    case "delegation-result":
    case "delegation-reconcile":
    case "delegation-remediate":
      return formatDelegation(value);
    default:
      return bound(JSON.stringify(normalizeJson(value), null, 2));
  }
}
