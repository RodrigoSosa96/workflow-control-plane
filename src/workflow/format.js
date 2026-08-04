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

// Matches relaunchSession's own display shortening of a session id (commands.js): first 8
// characters, display only -- every place that actually needs the full id (--run, result,
// reconcile) still reads it straight off the record, never off this rendering.
function shortRunId(id) {
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
function renderRunsTable(rows) {
  const widths = RUNS_COLUMNS.map((column) => (
    Math.max(column.label.length, ...rows.map((row) => row[column.key].length))
  ));
  const renderRow = (values) => RUNS_COLUMNS
    .map((column, index) => values[column.key].padEnd(widths[index]))
    .join(" | ")
    .trimEnd();
  const header = renderRow(Object.fromEntries(RUNS_COLUMNS.map((column) => [column.key, column.label])));
  return [header, ...rows.map((row) => renderRow(row))];
}

export function formatRuns(value = {}, deps = {}) {
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const runs = list(value.runs);
  const skipped = list(value.skipped);

  // A blank response is indistinguishable from a broken command -- an empty board says so
  // explicitly rather than printing nothing.
  const lines = runs.length === 0
    ? ["Runs: none"]
    : renderRunsTable(runs.map((run) => runRow(run, nowMs)));

  // Crash residue item 0.3's list() skips rather than swallows: named here as a count and the
  // ids, following this file's no-blank-line-between-sections idiom (formatDoctor, formatPlanLike).
  if (skipped.length > 0) {
    const ids = skipped.map((problem) => text(problem.runId)).join(", ");
    lines.push(`Skipped: ${skipped.length} (${ids})`);
  }

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

function boundedJson(command, value) {
  const text = JSON.stringify(normalizeJson(valueForJson(command, value)), null, 2);
  const limit = command === "launch" ? ASSIGNMENT_OUTPUT_LIMIT + OUTPUT_LIMIT : OUTPUT_LIMIT;
  if (text.length <= limit) return text;

  const source = value && typeof value === "object" ? value : {};
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
