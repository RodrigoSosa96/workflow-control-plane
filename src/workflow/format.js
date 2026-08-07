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

// --- formatResult's claim/proof split (roadmap item 2.3) ---------------------------------------
//
// Two sources, never merged, and no computed verdict about their disagreement (design spec: "A
// design that overwrote the self-report would destroy the more interesting half of the signal"):
//  - the claim: the worker's own self-reported `verification[]` from its handoff (handoff.js),
//    carried on `value.result.verification` exactly as resultCommand already exposes the rest of
//    the worker's result.
//  - the proof: the recorded evidence from the run's event log, resultCommand's own
//    `verifiedEvidence` (`readLatestVerificationEvidence` there) -- absent when `workflow verify`
//    has never successfully completed against this run. A refusal appends nothing to the event
//    log (verifyRefusal's own contract), so "never run" and "always refused" are indistinguishable
//    from the log alone; this renderer does not claim to know which -- it only ever says the
//    evidence is missing, not why.
// Both sections always render, even when empty, so an operator never has to wonder whether a
// missing section means "nothing to report" or "this view forgot to ask" -- the same discipline
// formatRuns/formatInbox apply to an empty board (see their own comments).
function verificationClaimLines(result) {
  const claim = list(result?.verification);
  if (claim.length === 0) return ["Reported by the worker: none"];
  const lines = ["Reported by the worker:"];
  for (const entry of claim) {
    const summary = entry?.summary ? ` — ${entry.summary}` : "";
    lines.push(`- ${text(entry?.command)}: ${text(entry?.status)}${summary}`);
  }
  return lines;
}

function verificationEvidenceLines(evidence, verifyCommandHint) {
  if (!evidence) {
    const hint = verifyCommandHint ? ` (run \`${verifyCommandHint}\`)` : "";
    return [`Verified by workflow verify: no recorded evidence${hint}`];
  }
  const lines = [`Verified by workflow verify (${evidence.passed ? "passed" : "failed"}, ran ${text(evidence.verifiedAt)}):`];
  const results = list(evidence.results);
  if (results.length === 0) {
    lines.push("Results: none");
  } else {
    lines.push(...renderTable(VERIFY_COLUMNS, results.map(verifyRow)));
  }
  return lines;
}

function formatResult(value) {
  const lines = [
    `Run: ${text(value.runId)}`,
    `Status: ${text(value.status)}`,
  ];
  if (value.state) lines.push(`State: ${value.state}`);
  if (value.result?.summary) lines.push(`Summary: ${value.result.summary}`);
  lines.push(...verificationClaimLines(value.result));
  lines.push(...verificationEvidenceLines(value.verifiedEvidence, value.verifyCommand));
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

// Roadmap item 2.5's board change, reported exactly the way appendSkippedLine reports crash
// residue: a run this board chose not to show is NAMED as a count underneath it, never silently
// dropped. Archived runs are excluded from the default view and from `--all` (that exclusion is the
// relief item 2.1 named when it measured the 12-14 run JSON ceiling), and an operator must be able
// to tell "there is nothing else" from "there are four you are not being shown".
//
// Only ever rendered when something was actually hidden: an unconditional `Archived: 0` would be
// noise on every board this repo has printed to date, and `runsCommand` reports 0 for the common
// case (the default live view can hardly ever contain an archived run, since a live run refuses to
// archive at all).
function appendArchivedLine(lines, archivedHidden) {
  if (!Number.isFinite(archivedHidden) || archivedHidden <= 0) return;
  lines.push(`Archived: ${archivedHidden} hidden (--state <state> still shows them)`);
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
  appendArchivedLine(lines, value.archivedHidden);

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

// --- formatVerify: the compact view for `workflow verify` (roadmap item 2.3) -------------------
//
// verifyCommand's own return shape (commands.js): `{command: "verify", runId, results, passed,
// exitCode}` on a real run, or `{command: "verify", runId, results: [], passed: false, exitCode,
// reason}` on a refusal (no repositories[], unknown project, no verify commands configured) --
// verifyRefusal's own comment there: refusals append nothing to the run's event log because
// nothing was verified, and rendering an empty table for one would read as "verified, and
// everything passed" -- the exact false green this whole item exists to remove. `reason` is the
// refusal's own signal (a real run never carries one), checked here rather than importing
// VERIFY_EXIT_CODES from commands.js -- this file stays dependency-free, matching every other
// renderer in it.
//
// Never renders a result's captured command output in the compact table -- a verify result can
// carry up to several KB of stdout/stderr (verify-runner.js's own per-command cap), and a summary
// table is the wrong place for it regardless of size (the same call formatRuns's own comment makes
// about repositories: "the table cannot honestly render this at all"). `--format json` carries a
// bounded head of it instead -- see boundVerificationResultForJson below. Shared with
// formatResult's own "Verified by workflow verify" section (verificationEvidenceLines above), so
// the compact table for `workflow verify` and the evidence table inside `workflow result` are
// exactly the same rendering, not two copies that could drift.
const VERIFY_COLUMNS = [
  { key: "repo", label: "REPO" },
  { key: "command", label: "COMMAND" },
  { key: "status", label: "STATUS" },
  { key: "exit", label: "EXIT" },
  { key: "duration", label: "DURATION" },
];

// Only "passed" stays lowercase; every other status (failed/timed-out/error) is upper-cased so a
// failing row visually stands out from a passing one at a glance, without leaning on color or
// emoji this file does not use anywhere else in a table cell (RUNS_COLUMNS/INBOX_COLUMNS render
// their status-shaped values verbatim). This is the property the design spec names as the single
// most valuable thing this command can show: a command the worker called passed that the evidence
// shows failing must not blend into the row above it.
function verifyStatusLabel(status) {
  return status === "passed" ? "passed" : text(status).toUpperCase();
}

function verifyRow(result = {}) {
  return {
    repo: text(result.repositoryId),
    command: text(result.command),
    status: verifyStatusLabel(result.status),
    exit: result.exitCode === null || result.exitCode === undefined ? "-" : String(result.exitCode),
    duration: Number.isFinite(result.durationMs) ? `${result.durationMs}ms` : "unknown",
  };
}

// A result only ever carries `reason` for an error or timed-out command (tasks 1/2's own
// contract); named underneath the table rather than folded into it as a sixth column, the same
// layering formatDoctor uses for a check's optional reason.
//
// Carries `cwd` here rather than adding it as a seventh table column (M9, branch review): a cwd
// column would widen every row of every table, including the common all-passed case where it adds
// nothing, to guard against a failure mode -- a repository entry with no usable path -- that is
// now visible a different way (verify-runner.js's checkCwd turns it into an "error" status with
// exactly the reason this line renders, C1's own fix). The Reasons section is where cwd context is
// actually load-bearing: it is attached to every error/timed-out result, i.e. every result where an
// operator might reasonably ask "where did this even run". `--format json` already carries `cwd` on
// every result unconditionally (verifyRow deliberately omits it from the table for the same
// space-cost reason).
function appendVerifyReasons(lines, results) {
  const withReason = results.filter((result) => result?.reason);
  if (withReason.length === 0) return;
  lines.push("Reasons:");
  for (const result of withReason) {
    lines.push(`${text(result.repositoryId)} | ${text(result.command)} (cwd: ${text(result.cwd)}): ${result.reason}`);
  }
}

// R3 (branch re-review): `truncated` is orthogonal to `status` -- verify-runner.js's own
// maxOutputBytes cap can trip on a command that ultimately passes or fails just as easily as one
// that errors or times out, so folding this into appendVerifyReasons above (whose own comment
// notes `reason` "only ever exists for an error or timed-out command") would silently miss the
// common case: a passing or failing result whose full log was capped. A separate, plainly-named
// block instead, appended only when at least one result actually was truncated, so the routine
// all-passed case stays exactly as short as it already is. `--format json` already carries
// `truncated` on every result unconditionally; this is its compact counterpart, so an operator
// reading the table does not mistake a capped log for the command's complete output.
function appendTruncationNotice(lines, results) {
  const withTruncatedOutput = results.filter((result) => result?.truncated);
  if (withTruncatedOutput.length === 0) return;
  lines.push("Truncated output:");
  for (const result of withTruncatedOutput) {
    lines.push(`${text(result.repositoryId)} | ${text(result.command)}: captured output was truncated`);
  }
}

export function formatVerify(value = {}) {
  const lines = [`Run: ${text(value.runId)}`];

  if (value.reason) {
    lines.push(`Verify: refused — ${value.reason}`);
    return bound(lines.join("\n"));
  }

  const results = list(value.results);
  lines.push(`Verify: ${value.passed ? "passed" : "failed"}`);
  if (results.length === 0) {
    lines.push("Results: none");
  } else {
    lines.push(...renderTable(VERIFY_COLUMNS, results.map(verifyRow)));
  }
  appendVerifyReasons(lines, results);
  appendTruncationNotice(lines, results);
  // I4 (branch review): the matrix above already ran and is fully rendered by this point --
  // `evidenceError` only ever means store.appendEvent could not persist it (most commonly another
  // command holding the run lock), never that verification itself failed to run. Named last so it
  // reads as "and one more thing", not folded into `Verify: passed/failed` where it would look like
  // a verdict about the checks themselves.
  if (value.evidenceError) {
    lines.push(`Evidence: ${value.evidenceError}`);
  }

  return bound(lines.join("\n"));
}

// --- formatMerge (roadmap item 2.4's `workflow merge`) ----------------------------------------
//
// Two shapes reach this renderer and the discriminator is structural, never an import from
// commands.js: this file is deliberately dependency-free (nothing here imports MERGE_EXIT_CODES or
// any other command constant), so a preview is recognized by its `repositories[]` and an execution
// report by its `merged`/`failed`/`skipped` lists. A refusal is recognized by `refused` on the
// value, the same way formatVerify recognizes one by `reason`.
//
// The four things this view must never lose (Task 2's own interface notes, and the reason the
// design spec puts a digest in front of this command at all):
//   1. the exact argv per repository -- it is what the approval digest binds, so it is rendered
//      verbatim as JSON rather than shell-joined, exactly as formatLaunchPreview renders its own
//      `Launch argv:` line;
//   2. the conflicts -- and never a shortened list rendered as the complete set;
//   3. the branch mismatch, with the recorded branch and the worktree's actual branch beside each
//      other (the real-data finding: two of the eight real runs on this machine record a branch
//      that no longer exists);
//   4. the verification status, including `none`.

// The last column is `MERGE-TREE`, not `MERGE`, and the name is load-bearing. It answers exactly
// one question -- what `git merge-tree` predicted about CONTENT -- and a repository can be blocked
// by something else entirely one column to its left (a dirty base checkout, a checkout on the wrong
// branch). Under the old `MERGE` header a row reading `dev, DIRTY (2) | clean` invited "the merge
// is clean, so this one is fine", which is a misread the header caused rather than the cell: the
// cell was literally true. Naming the column after the oracle that produced it removes the promise
// the header was making. Deliberately NOT a per-row blocked/ok column: ANY conflict blocks the
// WHOLE run, so a per-row verdict would imply the genuinely-clean repositories are going to merge,
// which is false and worse. The run-level truth lives in the headline and in `Conflicts:`.
const MERGE_COLUMNS = [
  { key: "repo", label: "REPO" },
  { key: "source", label: "SOURCE" },
  { key: "base", label: "BASE" },
  { key: "checkout", label: "BASE CHECKOUT" },
  { key: "merge", label: "MERGE-TREE" },
];

// Same convention verifyStatusLabel established: only the clean case stays lowercase, so anything
// that blocks the merge stands out from the row above it without color or emoji. `baseDirty` is
// tri-state (`true`/`false`/`null`) and only an explicit `false` may read as clean -- item 0.14's
// lesson, applied here at the point where an operator actually reads it. `MID-MERGE` outranks
// `DIRTY` because it is the more specific fact and the one that changes what an operator should
// do about it (see git.js's checkoutState).
function mergeCheckoutLabel(record) {
  const branch = text(record.baseCheckedOutBranch, "DETACHED");
  const onBase = record.baseBranchCheckedOut === true ? branch : `${branch} (NOT ${text(record.baseBranch)})`;
  const dirtyCount = Number.isFinite(record.baseDirtyCount) ? record.baseDirtyCount : list(record.baseDirtyPaths).length;
  const state = record.baseMerging === true
    ? `MID-MERGE (${dirtyCount})`
    : record.baseMerging !== false
      // Tri-state, like `baseDirty`: only an explicit `false` may reach the "clean" branch below.
      // A `null` merge state with a clean status would otherwise render as `clean` -- the false
      // green commands.js now refuses to compute (see its `merging !== false` conflict).
      ? "MERGE STATE UNKNOWN"
      : record.baseDirty === false
        ? "clean"
        : record.baseDirty === true
          ? `DIRTY (${dirtyCount})`
          : "STATUS UNKNOWN";
  return `${onBase}, ${state}`;
}

// `conflictsTruncated` is true for either of two causes the public preview cannot tell apart
// (git's own 12,000-character capture cap, or commands.js's display cap), and under the first one
// `conflictCount` is itself a floor rather than the true total. `900+` is therefore the only
// reading that is correct under both.
function mergeConflictLabel(record) {
  const count = Number.isFinite(record.conflictCount) ? record.conflictCount : list(record.conflicts).length;
  if (record.conflictStatus === "clean") return "clean";
  if (record.conflictStatus === "conflicted") return `CONFLICTED (${count}${record.conflictsTruncated ? "+" : ""})`;
  return text(record.conflictStatus).toUpperCase();
}

function mergeRow(record = {}) {
  return {
    repo: text(record.repositoryId),
    source: text(record.sourceBranch),
    base: text(record.baseBranch),
    checkout: mergeCheckoutLabel(record),
    merge: mergeConflictLabel(record),
  };
}

// Rendered for every repository, blocked or not: an operator reading a refused-to-execute preview
// still wants to see what would have run, and the argv is the thing the digest actually approves.
function appendMergeArgv(lines, repositories) {
  if (repositories.length === 0) {
    lines.push("Argv: none");
    return;
  }
  lines.push("Argv:");
  for (const record of repositories) {
    lines.push(`${text(record.repositoryId)}: ${Array.isArray(record.argv) ? JSON.stringify(record.argv) : "unavailable"}`);
  }
}

// `branchMismatch` is `recordedBranch !== sourceBranch` (commands.js), so a run that recorded no
// branch at all also lands here -- that disagreement is worth naming too. The empty case prints an
// explicit line rather than vanishing, the same discipline formatResult applies to its two
// verification sections: a missing section must never be readable as "this view forgot to ask".
function appendMergeBranchMismatch(lines, repositories) {
  const mismatched = repositories.filter((record) => record.branchMismatch);
  if (mismatched.length === 0) {
    lines.push("Branch mismatch: none");
    return;
  }
  lines.push("Branch mismatch:");
  for (const record of mismatched) {
    lines.push(`${text(record.repositoryId)}: the run recorded ${text(record.recordedBranch, "no branch")}; the worktree ${text(record.worktreePath)} is on ${text(record.sourceBranch)} — the worktree's branch is what would be merged`);
  }
}

// The conflicted paths themselves, per repository. Three cases, and only the first may read as a
// complete list:
//   - conflicted with the whole list present -> the paths, with the total beside them;
//   - conflicted with a shortened list       -> the paths, explicitly marked TRUNCATED. Approving
//     "these 10 conflicts" when there are 900 is the wrong approval, so this must never be
//     silently indistinguishable from the case above;
//   - anything else (`unknown`)              -> named as undetermined with git's own reason. An
//     undetermined conflict list is an EMPTY array; printing it as "none" would be the exact false
//     green this roadmap keeps removing.
function appendMergeConflictFiles(lines, repositories) {
  const affected = repositories.filter((record) => record.conflictStatus !== "clean");
  if (affected.length === 0) return;
  lines.push("Conflicted files:");
  for (const record of affected) {
    const label = text(record.repositoryId);
    if (record.conflictStatus !== "conflicted") {
      lines.push(...reasonBlock(`${label}: NOT DETERMINED`, text(record.conflictReason, "git could not report the conflicts; treated as conflicted, never as clean")));
      continue;
    }
    const shown = list(record.conflicts).map((path) => String(path));
    const count = Number.isFinite(record.conflictCount) ? record.conflictCount : shown.length;
    const suffix = record.conflictsTruncated
      ? ` (showing ${shown.length} of at least ${count}; this list is TRUNCATED, not the complete set)`
      : ` (${count} total)`;
    lines.push(`${label}: ${shown.join(", ") || "none listed"}${suffix}`);
  }
}

// Verification is surfaced and folded into the digest; it gates nothing (design spec, open
// decision 2). Every branch of the tri-state prints something: `staleRelativeToSource` is
// `null` when it could not be determined, and "unknown" must not render as "not stale".
function mergeVerificationLine(verification) {
  if (!verification || typeof verification !== "object") return "Verification: unknown";
  if (verification.status !== "recorded") {
    return "Verification: none recorded (workflow verify has never completed for this run); it is folded into the approval digest and gates nothing";
  }
  const verdict = verification.passed === true ? "passed" : verification.passed === false ? "FAILED" : "UNKNOWN";
  const exitCode = verification.exitCode === null || verification.exitCode === undefined ? "-" : String(verification.exitCode);
  const staleness = verification.staleRelativeToSource === true
    ? "; STALE: the source commit is newer than this evidence"
    : verification.staleRelativeToSource === false
      ? ""
      : "; staleness unknown";
  return `Verification: ${verdict} (exit ${exitCode}, ran ${text(verification.verifiedAt)})${staleness}`;
}

// A merge reason is not a sentence this codebase wrote -- it is git's own stderr (commands.js's
// `mergeFailureText`, capped at 2,000 characters), and git writes multiple lines. Found running
// the real CLI against a base checkout whose `pre-merge-commit` hook rejects the merge: git's
// stderr is two lines, and rendered raw the second one lands in the Reasons section with no
// repository label in front of it, reading as a statement about the whole run. In that exact case
// the orphaned line was git's own advice to *complete* the merge -- sitting unattributed inside a
// report about a merge that failed, which is precisely backwards. Continuation lines are indented
// so every line of a reason is visibly part of one entry, and git's text is preserved verbatim
// rather than collapsed onto one line, which would mangle output an operator has to act on.
// `separator` exists for formatArchive's refusal line, which follows formatMerge's own
// `Merge: refused — <reason>` shape rather than a `label: value` one. Defaulted, so every existing
// caller is unchanged.
function reasonBlock(label, reason, separator = ": ") {
  const [first, ...rest] = String(reason).replace(/\r\n?/g, "\n").split("\n");
  return [`${label}${separator}${first}`, ...rest.map((line) => `    ${line}`)];
}

function appendMergeNextActions(lines, nextActions) {
  const actions = list(nextActions).map((action) => String(action));
  if (actions.length === 0) return;
  lines.push("Next:");
  for (const action of actions) lines.push(`- ${action}`);
}

// `mergeable` is a THIRD input here, not decoration. Deriving the headline from
// `conflicts.length` alone means a value of `{mergeable: false, exitCode: 11, conflicts: []}` --
// a preview the CLI would exit 11 on -- renders as `Merge: mergeable`. Nothing produces that shape
// today (commands.js computes `mergeable` as `conflicts.length === 0`), but a renderer that can
// print "mergeable" over a response that says otherwise is the false-green shape this roadmap
// keeps removing, and agreement costs one comparison. An unset `mergeable` is not read as clean
// either: it gets its own line saying so.
function mergeHeadline(value, conflicts) {
  if (conflicts.length > 0) {
    return `Merge: blocked by ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`;
  }
  if (value.mergeable === true) return "Merge: mergeable";
  return "Merge: NOT MERGEABLE (no conflicts were listed; refusing to read that as clean)";
}

function formatMergePreview(value) {
  const repositories = list(value.repositories);
  const conflicts = list(value.conflicts);
  const lines = [
    `Run: ${text(value.runId)}`,
    `Project: ${text(value.projectAlias)} (run state: ${text(value.runState)})`,
    mergeHeadline(value, conflicts),
    mergeVerificationLine(value.verification),
  ];
  // Above the path-heavy sections, not below them, and for the same reason formatLaunchPreview puts
  // its own `Approval digest:` line before `Assignment:`: everything after this point scales with
  // repository and conflict count, and `bound()` truncates the TAIL. Measured at 6 repositories
  // against the worst-case fixture, the compact view does reach OUTPUT_LIMIT -- with the digest
  // last, the digest was the first thing lost. (That was fail-safe, since no digest means nothing
  // can execute, but "the operator loses the one string they need" is a bad way to be safe.)
  if (value.approvalDigest) lines.push(`Approval digest: ${value.approvalDigest}`);

  if (repositories.length === 0) lines.push("Repositories: none");
  else lines.push(...renderTable(MERGE_COLUMNS, repositories.map(mergeRow)));

  appendMergeArgv(lines, repositories);
  appendMergeBranchMismatch(lines, repositories);
  appendMergeConflictFiles(lines, repositories);

  // The aggregated list -- what actually blocks execution -- with each reason on its own line,
  // the layering formatVerify uses for its own Reasons section.
  if (conflicts.length === 0) lines.push("Conflicts: none");
  else addConflicts(lines, conflicts);

  appendMergeNextActions(lines, value.nextActions);
  return bound(lines.join("\n"));
}

const MERGE_REPORT_COLUMNS = [
  { key: "repo", label: "REPO" },
  { key: "status", label: "STATUS" },
  { key: "base", label: "BASE" },
  { key: "argv", label: "ARGV" },
];

function mergeReportRow(entry = {}, status) {
  return {
    repo: text(entry.repositoryId),
    status,
    base: `${text(entry.basePath)} (${text(entry.baseBranch)})`,
    argv: Array.isArray(entry.argv) ? JSON.stringify(entry.argv) : "unavailable",
  };
}

// There is no cross-repository transaction for a group project, so this report is written to admit
// partial completion rather than to avoid admitting it. One table, three statuses, so a repository
// that was never attempted cannot be mistaken for one that merged -- and the ARGV column carries
// the EXECUTED argv (commands.js reports `result.argv`, not the approved one), which is the audit
// trail for what actually ran.
// Exit 0 from `git merge` does not prove an integration happened -- an already-integrated branch
// exits 0, prints "Already up to date.", and creates no commit. commands.js reads the base HEAD
// back and records `integrated` per repository; this renders that distinction rather than calling
// both of them `merged`, because the design's whole `--no-ff, always` argument is that the merge
// commit IS the audit trail. `null` (the read-back itself failed) is neither outcome and says so.
function mergeReportStatusFor(entry) {
  if (entry?.integrated === false) return "ALREADY UP TO DATE";
  if (entry?.integrated === true) return "merged";
  return "merged (UNCONFIRMED)";
}

function formatMergeReport(value) {
  const merged = list(value.merged);
  const failed = list(value.failed);
  const skipped = list(value.skipped);
  const status = value.status === "merged" ? "merged" : text(value.status).toUpperCase();

  const lines = [
    `Run: ${text(value.runId)}`,
    `Merge: ${status}`,
  ];
  if (value.approvalDigest) lines.push(`Approval digest: ${value.approvalDigest}`);

  const rows = [
    ...merged.map((entry) => mergeReportRow(entry, mergeReportStatusFor(entry))),
    ...failed.map((entry) => mergeReportRow(entry, "FAILED")),
    ...skipped.map((entry) => mergeReportRow(entry, "NOT ATTEMPTED")),
  ];
  if (rows.length === 0) lines.push("Repositories: none");
  else lines.push(...renderTable(MERGE_REPORT_COLUMNS, rows));

  // Explicit empty lines for the two lists whose emptiness is the good news: an operator scanning
  // a report must be able to read "nothing failed" off the page, not infer it from an absence.
  if (merged.length === 0) lines.push("Merged: none");
  if (failed.length === 0) lines.push("Failed: none");
  if (skipped.length === 0) lines.push("Never attempted: none");

  const withReason = [...failed, ...skipped].filter((entry) => entry?.reason);
  if (withReason.length > 0) {
    lines.push("Reasons:");
    for (const entry of withReason) lines.push(...reasonBlock(text(entry.repositoryId), entry.reason));
  }

  // Item 2.3's I4 finding, and it matters more here: by the time this line renders, real merge
  // commits exist in real repositories and rerunning cannot undo them. A persistence failure is
  // named last, as "and one more thing", never folded into the verdict above.
  if (value.evidenceError) lines.push(`Evidence: ${value.evidenceError}`);
  appendMergeNextActions(lines, value.nextActions);
  return bound(lines.join("\n"));
}

export function formatMerge(value = {}) {
  if (value.refused) {
    const lines = [
      `Run: ${text(value.runId)}`,
      `Merge: refused — ${text(value.reason, "no reason recorded")}`,
    ];
    appendMergeNextActions(lines, value.nextActions);
    return bound(lines.join("\n"));
  }
  if (Array.isArray(value.merged) || Array.isArray(value.failed) || Array.isArray(value.skipped)) {
    return formatMergeReport(value);
  }
  return formatMergePreview(value);
}

// --- formatArchive (roadmap item 2.5's `workflow archive`) -------------------------------------
//
// Three shapes reach this renderer, and the discriminator is structural rather than an import from
// commands.js -- this file is deliberately dependency-free, so nothing here reads
// ARCHIVE_EXIT_CODES or any other command constant. A refusal is recognized by `refused` (the same
// way formatMerge recognizes one), an execution report by its `removed`/`kept` lists, and anything
// else is a preview.
//
// What this view exists to make impossible to miss, and the five ways it could quietly lie:
//   1. **`losses[]` leads `repositories[]`.** The design's centre of gravity is "what would be
//      LOST", not "what would be removed": `repositories[]` is an inventory of paths, `losses[]` is
//      the list of work that stops being findable. The headline states the total before any of it.
//   2. **`count: null` is UNKNOWN and must never render as `0`.** `0` means "measured, and fully
//      merged -- nothing to warn about"; `null` means nobody could tell. They are opposite facts,
//      and collapsing them is the exact false green the adapter layer had to have removed from it
//      (git.js's countCommitsNotIn). One `?? 0` here would put it straight back.
//   3. **A partial report mixes losses that HAPPENED with losses that did not** (`removed:
//      true|false`), and telling an operator "nothing will point at this work any more" about a
//      worktree still sitting on disk is a lie about a world that did not occur.
//   4. **`argv` is on `removed[]` only.** A `kept[]` entry -- an `unsafe-path`, a spawn that failed
//      -- has no argv precisely because nothing ran; rendering one would be an audit trail of a
//      command that never executed.
//   5. **`tab` has four distinguishable outcomes and `alreadyGone` is the COMMON one** (every
//      recorded tab id on the machine this was built against is stale). Printing "not closed" for
//      all of them would make the normal case look broken.

// `null` is UNKNOWN, and it is spelled out rather than blanked, so a table cell can never be read
// as a measured zero. Point 2 above, in one function -- every count in this renderer goes through
// it.
function archiveCount(count) {
  return Number.isFinite(count) ? String(count) : "UNKNOWN";
}

// Reads the run's state and lock/agent evidence the same way formatReconcile renders its own lock
// line: the verdict is what decides whether `workflow unlock` even applies. `held: true` with a
// removable verdict is archivable AND will fail persistence (archive does not remove the lock, but
// store.update/appendEvent both take it), which is why this line says so rather than only noting
// that a lock exists.
function archiveLockLine(lock) {
  if (!lock || typeof lock !== "object") return "Lock: not reported";
  if (lock.held !== true) return "Lock: not held";
  const verdict = text(lock.ownership?.verdict);
  const reason = lock.ownership?.reason ? ` — ${lock.ownership.reason}` : "";
  return `Lock: HELD (${verdict}${reason}); archive never removes it, but marking the run archived needs it`;
}

// `checkedPaneIds` is the honest evidence: the correlated pane is what `agent.paneId` means
// everywhere else in the control plane, but the gate asks about EVERY pane the run has named, which
// may be two (a resumed run's original pane can still host a live agent). Naming both is what makes
// "no live agent" a checkable claim rather than an assurance.
// **Corrected against real CLI output (step 5).** This used to render
// `Agent: no live agent (panes checked: none recorded)` for a run that never named a pane -- a
// claim of having checked, immediately contradicted by the parenthetical saying there was nothing
// to check. The two cases are genuinely different evidence and now say so: Herdr was asked about
// specific panes and answered, or Herdr was never asked because the run has no agent to resolve.
function archiveAgentLine(agent) {
  if (!agent || typeof agent !== "object") return "Agent: not reported";
  const checked = list(agent.checkedPaneIds).map((pane) => String(pane));
  if (checked.length === 0) {
    return "Agent: none to resolve (the run never recorded a pane id, so Herdr was not asked)";
  }
  return `Agent: no live agent (Herdr asked about ${checked.join(", ")})`;
}

const ARCHIVE_COLUMNS = [
  { key: "repo", label: "REPO" },
  { key: "worktree", label: "WORKTREE" },
  { key: "branch", label: "BRANCH" },
  { key: "head", label: "HEAD" },
  { key: "base", label: "BASE" },
  { key: "unmerged", label: "UNMERGED" },
];

// Three states this cell must keep apart, and `text()`'s "unknown" fallback would flatten two of
// them into the third: an absent worktree has no branch to read (`-`), a present one on no branch
// is DETACHED (a known fact, not an unknown), and everything else is a branch name.
function archiveBranchCell(record) {
  if (record.present === false) return "-";
  if (record.branch) return String(record.branch);
  return "DETACHED";
}

function archiveRow(record = {}) {
  return {
    repo: text(record.repositoryId),
    // The residue this command exists to reclaim: git deregisters a vanished worktree cleanly, so
    // this is an archivable state rather than an error, and it must be visible as such.
    worktree: `${text(record.worktreePath)}${record.present === false ? " (ALREADY GONE)" : ""}`,
    branch: archiveBranchCell(record),
    head: record.headSha ? String(record.headSha).slice(0, 12) : "-",
    base: text(record.baseBranch, "NONE"),
    unmerged: archiveCount(record.unmergedCommits),
  };
}

// One line per loss, keyed off `kind` -- a closed vocabulary of three -- with the count rendered
// through archiveCount so an unmeasurable loss never borrows a measured one's shape. `detail` goes
// through reasonBlock because it can carry git's own text.
// **Corrected against real CLI output (step 5).** This label used to spell out
// `<count> commit(s) on <branch> not in <baseBranch>`, which is very nearly the opening clause of
// the `detail` printed immediately after it -- so every unmerged loss rendered as
// `backend | 1 commit(s) on feature/x not in dev: 1 commit(s) on feature/x are not in dev; ...`.
// The label's job is to be the SCANNABLE classifier beside a sentence, not a paraphrase of it: the
// count is the number an operator is scanning for, and `UNKNOWN` in the same slot is the fact that
// must never be mistaken for a zero.
function archiveLossLabel(loss = {}) {
  if (loss.kind === "unmerged-commits" || loss.kind === "unmerged-commits-unknown") {
    return `UNMERGED (${archiveCount(loss.count)})`;
  }
  if (loss.kind === "detached-head") return "DETACHED HEAD";
  return text(loss.kind).toUpperCase();
}

// `removed` only exists on an execution report's losses, and there it is the difference between a
// loss that happened and one that did not. On a preview it is absent, and no suffix is added --
// nothing has happened yet, and the whole document is written in the conditional.
function archiveLossOutcome(loss = {}) {
  if (loss.removed === true) return " | LOST";
  if (loss.removed === false) return " | NOT LOST (the worktree is still on disk)";
  return "";
}

function appendArchiveLosses(lines, losses) {
  if (losses.length === 0) {
    lines.push("Losses: none");
    return;
  }
  lines.push("Losses:");
  for (const loss of losses) {
    lines.push(...reasonBlock(
      `${text(loss.repositoryId)} | ${archiveLossLabel(loss)}${archiveLossOutcome(loss)}`,
      text(loss.detail, "no detail recorded"),
    ));
  }
}

// The one line an operator must not be able to skip, and the reason it sits above every path-heavy
// section: `bound()` truncates the TAIL, so a wide group project loses the sections below it before
// it loses this. Unknown-size losses are counted as their own quantity rather than summed as zero
// -- point 2 above, at the level of the total rather than the cell.
function archiveLossHeadline(losses) {
  if (losses.length === 0) {
    return "Would be lost: nothing — every worktree is on a branch, and every branch is fully merged into its base";
  }
  const commits = losses.reduce((sum, loss) => (Number.isFinite(loss.count) ? sum + loss.count : sum), 0);
  const unknown = losses.filter((loss) => !Number.isFinite(loss.count)).length;
  const parts = [];
  if (commits > 0) parts.push(`${commits} unmerged commit(s)`);
  if (unknown > 0) parts.push(`${unknown} loss(es) of UNKNOWN size`);
  const worktrees = new Set(losses.map((loss) => String(loss.worktreePath))).size;
  return `Would be lost: ${losses.length} loss(es) across ${worktrees} worktree(s) — ${parts.join(", ") || "size not reported"}`;
}

// `branchMismatch` is literally `recordedBranch !== branch` (commands.js), so a run that recorded no
// branch at all lands here too -- the same call formatMerge makes, and worth naming for the same
// reason: on the machine this was built against, two of eight real runs record a branch that no
// longer exists. Rendered only for a preview; the execute report has already acted on it.
// **Corrected against real CLI output (step 5), then corrected again in review.** An ALREADY GONE
// worktree has `branch: null`, so `branchMismatch` -- literally `recordedBranch !== branch`
// (commands.js) -- is true for every single one of them. The first correction fixed the entry TEXT
// but left them in the `mismatched` list, so a re-preview of a fully archived run still printed a
// `Branch mismatch:` header with one entry per repository when nothing disagreed with anything: the
// worktrees were simply gone. Fixing the sentence and leaving the heading that frames it is the
// same check-the-clause-not-the-claim mistake one level up.
//
// The two are now separate groups with separate headings, and the empty case of each is stated
// explicitly rather than inferred from an absence (formatMerge's own discipline). A vanished
// worktree is reported as vanished under its own label; only a worktree that is really there can
// disagree with the record about its branch.
function appendArchiveBranchMismatch(lines, repositories) {
  const absent = repositories.filter((record) => record.present === false);
  const mismatched = repositories.filter((record) => record.present !== false && record.branchMismatch);

  if (mismatched.length === 0) {
    lines.push("Branch mismatch: none");
  } else {
    lines.push("Branch mismatch:");
    for (const record of mismatched) {
      lines.push(`${text(record.repositoryId)}: the run recorded ${text(record.recordedBranch, "no branch")}; the worktree ${text(record.worktreePath)} is on ${archiveBranchCell(record)} — the worktree's own state is what was measured`);
    }
  }

  if (absent.length === 0) return;
  lines.push("Branch not readable (worktree already gone):");
  for (const record of absent) {
    lines.push(`${text(record.repositoryId)}: the run recorded ${text(record.recordedBranch, "no branch")}; that worktree is already gone, so no branch could be read from it`);
  }
}

function appendArchiveNextActions(lines, nextActions) {
  const actions = list(nextActions).map((action) => String(action));
  if (actions.length === 0) return;
  lines.push("Next:");
  for (const action of actions) lines.push(`- ${action}`);
}

// **Corrected against real CLI output (step 5).** This used to read
// `Archive: 2 worktree(s) would be removed` for a run whose two worktrees were both ALREADY GONE --
// re-previewing an already-archived run, which is a shape this command produces routinely (it is
// how an operator finishes a partial archive, and re-running after a complete one is the obvious
// thing to try). Nothing would be removed from disk there; git only reclaims the registration. The
// two counts are separated so the headline can never promise a removal that is not going to happen.
function archiveHeadline(repositories) {
  const gone = repositories.filter((record) => record.present === false).length;
  const present = repositories.length - gone;
  if (gone === 0) return `Archive: ${present} worktree(s) would be removed`;
  if (present === 0) return `Archive: nothing left on disk — all ${gone} recorded worktree(s) are already gone; only their git registrations would be reclaimed`;
  return `Archive: ${present} worktree(s) would be removed, and ${gone} already gone (only their git registrations would be reclaimed)`;
}

function formatArchivePreview(value) {
  const repositories = list(value.repositories);
  const losses = list(value.losses);
  const lines = [
    `Run: ${text(value.runId)}`,
    `Project: ${text(value.projectAlias)} (run state: ${text(value.runState)})`,
    archiveHeadline(repositories),
    archiveLossHeadline(losses),
  ];
  // Above everything that scales with repository count, for exactly the reason formatMergePreview
  // puts its own digest there: this is the one string the operator has to copy, and losing it to
  // truncation is a bad way to be safe.
  if (value.approvalDigest) lines.push(`Approval digest: ${value.approvalDigest}`);

  appendArchiveLosses(lines, losses);

  if (repositories.length === 0) lines.push("Repositories: none");
  else lines.push(...renderTable(ARCHIVE_COLUMNS, repositories.map(archiveRow)));

  appendArchiveBranchMismatch(lines, repositories);
  lines.push(archiveLockLine(value.lock));
  lines.push(archiveAgentLine(value.agent));
  lines.push(value.tabId
    ? `Tab: ${value.tabId} (closed after the removals, best-effort; a tab that is already gone is not a failure)`
    : "Tab: none recorded");
  appendArchiveNextActions(lines, value.nextActions);
  return bound(lines.join("\n"));
}

const ARCHIVE_REPORT_COLUMNS = [
  { key: "repo", label: "REPO" },
  { key: "status", label: "STATUS" },
  { key: "worktree", label: "WORKTREE" },
  { key: "branch", label: "BRANCH" },
];

function archiveReportRow(entry = {}, status) {
  return {
    repo: text(entry.repositoryId),
    status,
    worktree: text(entry.worktreePath),
    branch: text(entry.branch, "no branch"),
  };
}

// Point 5 above. Four outcomes, four lines, and the middle two are the ones that must not read as
// failures: nothing was ever asked, and already-gone (which means already archived).
function archiveTabLine(tab) {
  if (!tab || typeof tab !== "object") return "Tab: not reported";
  if (tab.reason === "no-tab-recorded") return "Tab: none recorded (the run never had one to close)";
  const tabId = text(tab.tabId);
  if (tab.closed === true) return `Tab: ${tabId} closed`;
  if (tab.alreadyGone === true) return `Tab: ${tabId} already gone (nothing left to close — this is the normal case, not a failure)`;
  return `Tab: ${tabId} NOT CLOSED — ${text(tab.reason, "no reason recorded")}`;
}

function formatArchiveReport(value) {
  const removed = list(value.removed);
  const kept = list(value.kept);
  const status = value.status === "archived" ? "archived" : text(value.status).toUpperCase();

  const lines = [
    `Run: ${text(value.runId)}`,
    `Archive: ${status}`,
  ];
  if (value.archivedAt) lines.push(`Archived at: ${value.archivedAt}`);
  if (value.approvalDigest) lines.push(`Approval digest: ${value.approvalDigest}`);

  const rows = [
    ...removed.map((entry) => archiveReportRow(entry, "removed")),
    ...kept.map((entry) => archiveReportRow(entry, `KEPT (${text(entry.reason, "unknown")})`)),
  ];
  if (rows.length === 0) lines.push("Repositories: none");
  else lines.push(...renderTable(ARCHIVE_REPORT_COLUMNS, rows));

  // The two explicit empty lines, for the same reason formatMergeReport prints its own: an operator
  // scanning a report has to be able to read "nothing was left behind" off the page rather than
  // infer it from an absence.
  if (removed.length === 0) lines.push("Removed: none");
  if (kept.length === 0) lines.push("Kept: none");

  // Point 4: the EXECUTED argv, and only for removals that actually succeeded. A kept entry carries
  // none by construction (commands.js attaches it on the success side only), and this renderer
  // keys off which list an entry is in rather than off whether an argv happens to be present.
  if (removed.length > 0) {
    lines.push("Removed (executed argv):");
    for (const entry of removed) {
      lines.push(`${text(entry.repositoryId)}: ${Array.isArray(entry.argv) ? JSON.stringify(entry.argv) : "unavailable"}`);
    }
  }
  if (kept.length > 0) {
    lines.push("Kept, with git's own reason:");
    for (const entry of kept) {
      lines.push(...reasonBlock(`${text(entry.repositoryId)} (${text(entry.reason, "unknown")})`, text(entry.detail, "no detail recorded")));
    }
  }

  appendArchiveLosses(lines, list(value.losses));
  lines.push(archiveTabLine(value.tab));

  // Item 2.3's I4 finding, and it matters more here than anywhere it has mattered before: by the
  // time these render, real directories are gone from a real filesystem and rerunning cannot undo
  // it. Named last, as "and one more thing", never folded into the verdict above.
  if (value.recordError) lines.push(`Record: ${value.recordError}`);
  if (value.evidenceError) lines.push(`Evidence: ${value.evidenceError}`);
  appendArchiveNextActions(lines, value.nextActions);
  return bound(lines.join("\n"));
}

export function formatArchive(value = {}) {
  if (value.refused) {
    // A refusal carries `repositories: []` and `losses: []` BY DESIGN, so neither section renders
    // here: "Losses: none" over a refusal would read as "checked, and nothing would be lost", which
    // is the opposite of what happened, and an empty table would read as a completed archive of
    // nothing. `reason` is already capped by commands.js (reasonRepositories x reasonPaths) and is
    // rendered verbatim rather than re-parsed back into a table.
    const lines = [
      `Run: ${text(value.runId)}`,
      ...reasonBlock("Archive: refused", text(value.reason, "no reason recorded"), " — "),
    ];
    // The ownership verdict is what decides whether `workflow unlock` is even applicable, so it is
    // carried onto the refusal that names it -- the same thing formatReconcile does with its own.
    if (value.lock?.held === true) lines.push(archiveLockLine(value.lock));
    appendArchiveNextActions(lines, value.nextActions);
    return bound(lines.join("\n"));
  }
  if (Array.isArray(value.removed) || Array.isArray(value.kept)) {
    return formatArchiveReport(value);
  }
  return formatArchivePreview(value);
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
//   - archivedAt: item 2.5's own field, and the reason it belongs on a BOARD projection rather than
//     only in `workflow result`: this board now hides archived runs from its default view and from
//     `--all`, so a JSON consumer looking at a `--state completed` listing has to be able to tell
//     which of those rows are archived residue from which are still waiting to be dealt with. It is
//     `undefined` on every run that has never been archived, so it costs nothing on the common
//     board (JSON.stringify omits undefined keys entirely) and appears only where it is true.
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
    archivedAt: run.archivedAt,
  };
}

// Verify's own captured command output (verify-runner.js's DEFAULT_MAX_OUTPUT_BYTES, 4000 bytes
// per command) is the bulkiest thing this repo has put in a result: a modest 3-repository,
// 3-command matrix (9 results) can carry up to 36,000 raw bytes of output alone, several times
// over the shared OUTPUT_LIMIT, before counting anything else in the payload. The compact view
// never shows this text at all (verifyRow only ever renders status/exit/duration -- see its own
// comment); `--format json` still carries a head of each command's output (useful to a consumer
// that wants it) but caps it far below the source-side per-command capture limit, on a per-result
// basis -- measured (see the headroom test in test/workflow-format.test.js) to keep a realistic
// matrix comfortably under budget without falling through to the overflow fallback below, which
// drops the evidence's structure entirely, not just its bulk. Shared by both `workflow verify`'s
// own JSON and `workflow result`'s embedded `verifiedEvidence.results` -- one bound, not two.
const VERIFY_JSON_OUTPUT_LIMIT = 500;

function boundVerificationResultForJson(result) {
  if (!result || typeof result !== "object") return result;
  return { ...result, output: bound(result.output ?? "", VERIFY_JSON_OUTPUT_LIMIT, "output") };
}

function boundVerificationResultsForJson(results) {
  return list(results).map(boundVerificationResultForJson);
}

function valueForJson(command, value) {
  if (command === "worker-status" || command === "worker-watch") return publicWorkerResult(value);
  if (command === "runs") {
    if (!value || typeof value !== "object") return value;
    return { ...value, runs: list(value.runs).map(runProjection) };
  }
  if (command === "verify") {
    if (!value || typeof value !== "object") return value;
    return { ...value, results: boundVerificationResultsForJson(value.results) };
  }
  if (command === "result") {
    if (!value || typeof value !== "object" || !value.verifiedEvidence || typeof value.verifiedEvidence !== "object") {
      return value;
    }
    return {
      ...value,
      verifiedEvidence: { ...value.verifiedEvidence, results: boundVerificationResultsForJson(value.verifiedEvidence.results) },
    };
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
    // Carried for the same reason `skippedCount` is: a collapse must not read as "and nothing was
    // hidden either". Item 2.5's archived count is residue this board deliberately did not show,
    // and a degraded response is exactly where an operator is least able to go and check.
    archivedHidden: Number.isFinite(source.archivedHidden) ? source.archivedHidden : 0,
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

// The same collapse `runs`/`inbox` measured at board scale can happen to a SINGLE `workflow
// verify` invocation, because the multiplier here is not run count but repository count x command
// count (see VERIFY_JSON_OUTPUT_LIMIT's own comment) -- and unlike `runs`/`inbox`, this is not just
// an extreme-scale edge case: a real multi-repository project with a handful of verify commands
// each is well within reach of an operator's own registry. The general fallback below was built
// for single-record commands where "rerun narrower" is real advice (`result`/`reconcile` take one
// run id, so a caller can always ask for less); `verify` has no way to ask for fewer repositories
// or commands -- rerunning faces the exact same matrix, still capped the same way -- so its own
// fallback names what actually happened instead of offering advice that does not apply, the same
// fix runsOverflowFallback/inboxOverflowFallback made for their own commands.
//
// **Correction (branch review, M6):** this used to drop the `results` array entirely, keeping only
// `repositoryIds`/`commands` -- which loses every result's status, exit code, and the
// repository<->command pairing, not just the bulky captured output that actually caused the
// overflow. `output` is the one field whose size scales with the matrix (VERIFY_JSON_OUTPUT_LIMIT's
// own comment); status/exitCode do not, so dropping only `output` and keeping
// `{repositoryId, command, status, exitCode}` per result preserves the half of the evidence an
// operator can actually act on -- measured (see the headroom test in test/workflow-format.test.js)
// to stay well under budget even at extreme scale. The stale ROADMAP.md sentence this comment used
// to contradict ("descarta el texto de output por resultado") was actually describing THIS
// behavior, not the one the code had -- both now agree.
function strippedVerifyResult(result) {
  return {
    repositoryId: result?.repositoryId,
    command: result?.command,
    status: result?.status,
    exitCode: result?.exitCode ?? null,
  };
}

function verifyOverflowFallback(command, source, limit) {
  const results = list(source.results);
  const repositoryIds = unique(results.map((result) => result?.repositoryId));
  const commandsRun = unique(results.map((result) => result?.command));
  return {
    command: source.command ?? command,
    runId: source.runId,
    passed: Boolean(source.passed),
    exitCode: source.exitCode,
    resultCount: results.length,
    repositoryIds,
    commands: commandsRun,
    results: results.map(strippedVerifyResult),
    truncated: true,
    truncationMarker: `JSON output truncated at ${limit} characters even after bounding each result's captured output to ${VERIFY_JSON_OUTPUT_LIMIT} characters; every result's captured output was dropped to fit, but repositoryId/command/status/exitCode survive per result in \`results\` below (${results.length} results). The compact view (--format compact, the default) renders the same matrix bounded to ${OUTPUT_LIMIT} characters -- not unbounded, just a different truncation point.`,
  };
}

// The same collapse can happen to `workflow result`'s embedded evidence: `verifiedEvidence.results`
// is the exact same matrix `verify` measures, carried here for the claim/proof split (roadmap item
// 2.3). Unlike `verify`, `result` is a single-record command -- it takes exactly one run id, same
// as `reconcile` -- so the general fallback below looked like the right one when this branch first
// shipped it. It is not: that fallback keeps only `{command, runId, status, truncated,
// truncationMarker}`, and at a realistic evidence size it discarded `result` itself along with it
// -- the worker's own summary/verification claim, the repositories with their fingerprints,
// decisions, and nextAction, none of which scale with the evidence matrix at all. Measured directly
// against this file's own `formatWorkflowResult("result", ..., "json")`, with a realistic envelope
// (the full runOutputBase fields, a canonicalResult-shaped `result` with three repositories'
// fingerprints/decisions/nextAction, and a 3-repository x 5-command evidence matrix at each
// result's real per-command capture cap): the general fallback collapsed this at **n=12** evidence
// results (n=11 = 11,506 characters, 95.9% of budget; n=12 = 227 characters, `result` gone
// entirely) -- well inside a plausible registry (3 repositories x 5 commands = 15). The fix mirrors
// `verify`'s own (see verifyOverflowFallback/strippedVerifyResult above): keep every top-level
// field -- `result`, `status`, and everything else in the envelope -- and degrade only
// `verifiedEvidence.results`, the one field whose size actually scales with the matrix.
function resultOverflowFallback(command, source, limit) {
  const evidence = source.verifiedEvidence && typeof source.verifiedEvidence === "object" ? source.verifiedEvidence : null;
  const evidenceResults = list(evidence?.results);
  const repositoryIds = unique(evidenceResults.map((result) => result?.repositoryId));
  const commandsRun = unique(evidenceResults.map((result) => result?.command));
  const degradedEvidence = evidence
    ? {
      verifiedAt: evidence.verifiedAt,
      passed: evidence.passed,
      exitCode: evidence.exitCode,
      results: evidenceResults.map(strippedVerifyResult),
      resultCount: evidenceResults.length,
      repositoryIds,
      commands: commandsRun,
    }
    : (source.verifiedEvidence ?? null);
  return {
    ...source,
    verifiedEvidence: degradedEvidence,
    truncated: true,
    truncationMarker: `JSON output truncated at ${limit} characters; the verified-evidence matrix (${evidenceResults.length} results) had its captured output dropped to fit, keeping repositoryId/command/status/exitCode per result. \`result\`, \`status\`, and every other field in this response are unabridged. ${source.runId ? `\`workflow verify ${source.runId}\`` : "`workflow verify <run-id>`"} re-runs the same matrix if the full evidence is needed.`,
  };
}

// `merge` needs its own fallback for the same reason `verify` did, and the numbers are worse.
// Measured directly against this file's own `formatWorkflowResult("merge", ..., "json")`, at the
// display caps commands.js already ships (10 conflicted paths, 5 reason paths, and 5 uncommitted
// paths per repository) and realistic sharyco-shaped path lengths (~95 characters):
//
//   clean 3-repository preview                                    3,628
//   3-repository preview at the display caps                     11,763   98.0% of budget
//   4-repository preview at the display caps                        200   COLLAPSED
//
// The 200 is the finding. The general fallback below keeps only `{command, runId, truncated,
// truncationMarker}`, so one repository past the measured worst case turns a preview into a
// response with **no argv and no conflicts in it at all** -- the two things an operator cannot act
// without, and the two things this command exists to show before anything mutates. Three
// repositories is the real sharyco group project; four is not an extreme-scale hypothetical.
//
// What actually scales here is per-path text: the conflicted-path lists, the `conflictReason`
// strings that restate a prefix of those lists, the `baseDirtyPaths` arrays, and the aggregated
// `conflicts[].reason` sentences that restate them a third time. Everything else on a repository
// record -- ids, branches, shas, booleans, and the argv -- is fixed-size. So this degrades exactly
// the text that scales and keeps the rest, including every argv and the aggregated conflict list
// (bounded per reason), the same shape resultOverflowFallback settled on for its own evidence.
//
// `conflictCount` and `conflictsTruncated` are recomputed rather than copied, so shortening a list
// here can only ever make a response MORE truncation-aware, never less: a list this function cut
// down is marked truncated even if the source's own list was complete.
// Two tiers, tried in order, because one tier is not enough and the second one is measured too.
// Tier 1 keeps every field on the envelope and every field on a repository record except the three
// that scale with path text, and shortens the rest. Tier 2 keeps ONLY the fixed-size half of each
// repository record -- the argv above all -- and drops every path list entirely, so a group project
// too wide for tier 1 still answers "which repositories, what would run, how many conflicts each"
// instead of the general fallback's nothing. Measured with the same worst-case fixture, one
// repository at a time (n = repositories, each at the display caps):
//
//   n = 1..3   no fallback needed             (n=1: 4,355 · n=3: 11,763)
//   n = 4..5   tier 1                         (n=4: 9,282 · n=5: 11,228)
//   n = 6..9   tier 2                         (n=6: 8,167 · n=9: 11,422)
//   n >= 10    the general fallback below     (200 characters, no argv, no conflicts)
//
// Every number above is from `worstCaseMergePreview` in test/workflow-format.test.js, so it is
// reproducible rather than a remembered measurement -- and the boundaries are asserted there too
// (`the merge JSON fallback tiers engage where they are documented to`). They ARE fixture-relative:
// shorter repository paths push each boundary out by a repository or so, which is why the tests
// pin the tiers rather than the byte counts.
//
// Two tiers and no third, and the reason is not that a third is impossible -- tier 2 still carries
// plenty a third could take (`basePath`, `sourceSha`, `sourceBranch`, `baseBranch`,
// `baseBranchCheckedOut`, `baseDirty`/`baseMerging`/`baseDirtyCount`, `branchMismatch`, and the
// full aggregated conflicts list with 100-character reasons). It is that each additional tier is
// another distinct response shape a consumer has to handle, bought against a case no data supports:
// ten repositories is three times the largest group project on this machine, with every one of them
// at 900 conflicts. Stopping here is a judgement about diminishing returns, not a claim that the
// budget ran out. What the two tiers do buy is that the shape degrades gradually instead of falling
// off a cliff one repository past a measured number -- exactly what items 2.1 and 2.3 each shipped
// once and had to correct.
//
// The execute report never needed any of this and is measured too, since it flows through the same
// path: three repositories with a failure carrying git's stderr at commands.js's own 2,000-character
// cap is 3,667 characters, and ten repositories is 6,800 -- its per-entry cost is fixed-size and
// there is only ever at most one `failed` entry. The tiers apply to it anyway (bounding each
// entry's `reason`) so a future shape change cannot silently reach the general fallback.
const MERGE_OVERFLOW_TIERS = [
  { conflictPaths: 3, reasonLimit: 240, minimal: false },
  { conflictPaths: 0, reasonLimit: 100, minimal: true },
];

function strippedMergeRepository(record, tier) {
  if (!record || typeof record !== "object") return record;
  const all = list(record.conflicts);
  const conflicts = all.slice(0, tier.conflictPaths);
  const conflictCount = Number.isFinite(record.conflictCount) ? record.conflictCount : all.length;
  const conflictsTruncated = Boolean(record.conflictsTruncated) || conflicts.length < conflictCount;
  if (tier.minimal) {
    return {
      repositoryId: record.repositoryId,
      basePath: record.basePath,
      baseBranch: record.baseBranch,
      baseBranchCheckedOut: record.baseBranchCheckedOut,
      baseDirty: record.baseDirty ?? null,
      // Kept even in the minimal tier: it blocks execution on its own and it is what tells an
      // operator to reach for `git merge --abort` rather than for `git add`.
      baseMerging: record.baseMerging ?? null,
      baseDirtyCount: record.baseDirtyCount ?? 0,
      sourceBranch: record.sourceBranch,
      sourceSha: record.sourceSha,
      branchMismatch: record.branchMismatch,
      argv: record.argv,
      conflictStatus: record.conflictStatus,
      conflicts,
      conflictCount,
      conflictsTruncated,
    };
  }
  const { baseDirtyPaths, conflictReason, ...rest } = record;
  return { ...rest, conflicts, conflictCount, conflictsTruncated };
}

function boundedMergeReason(entry, tier) {
  if (!entry || typeof entry !== "object" || typeof entry.reason !== "string") return entry;
  return { ...entry, reason: bound(entry.reason, tier.reasonLimit, "reason") };
}

function mergeOverflowFallback(command, source, limit, tier) {
  const degraded = {
    ...source,
    ...(Object.hasOwn(source, "repositories")
      ? { repositories: list(source.repositories).map((record) => strippedMergeRepository(record, tier)) }
      : {}),
    ...(Object.hasOwn(source, "conflicts") ? { conflicts: list(source.conflicts).map((entry) => boundedMergeReason(entry, tier)) } : {}),
    // The execute report's own lists carry a per-entry `reason` (git's stderr, already capped at
    // 2,000 characters by commands.js) and the executed argv. Same treatment: the reason is the
    // part that scales, the argv is the part that must survive.
    ...(Object.hasOwn(source, "merged") ? { merged: list(source.merged).map((entry) => boundedMergeReason(entry, tier)) } : {}),
    ...(Object.hasOwn(source, "failed") ? { failed: list(source.failed).map((entry) => boundedMergeReason(entry, tier)) } : {}),
    ...(Object.hasOwn(source, "skipped") ? { skipped: list(source.skipped).map((entry) => boundedMergeReason(entry, tier)) } : {}),
    truncated: true,
  };
  // A marker whose job is to enumerate the drops has to enumerate ALL of them, by field name. The
  // first version of this text omitted `conflictReason` from tier 1 -- and for a repository whose
  // `conflictStatus` is `"unknown"` that string is the ONLY explanation of why the conflicts could
  // not be determined, so its silent disappearance was the one drop most worth naming. Tier 2's
  // list was short by `baseCheckedOutBranch` and `sourceCommittedAt` for the same kind of reason.
  const dropped = tier.minimal
    ? "every repository's conflicted-path list and `baseDirtyPaths` were dropped entirely, together with `conflictReason`, `worktreePath`, `recordedBranch`, `sourceCommittedAt`, `baseCheckedOutBranch`, and `baseSha`"
    : `each repository's conflicted-path list was cut to ${tier.conflictPaths} paths, and \`baseDirtyPaths\` and \`conflictReason\` were dropped`;
  // Scoped to the tier, because the two tiers fire at different sizes and the compact view behaves
  // differently at each. Measured against the same fixture: at the sizes that reach tier 1 (n=4:
  // 8,776 · n=5: 10,865) compact is not truncated at all, so the earlier blanket claim that it
  // "loses `Conflicts:` and `Next:`" was false everywhere tier 1 is emitted. At tier 2 sizes it
  // does hit the limit -- and even there `Conflicts:` is not lost wholesale: the header and the
  // first entries render, and the list is cut mid-entry.
  const compactNote = tier.minimal
    ? `The compact view (--format compact, the default) is not a fuller answer at this size -- it is bounded to ${OUTPUT_LIMIT} characters too and truncates its TAIL, so at a response this wide it loses \`Next:\` and the tail of \`Conflicts:\` while keeping the run header, the approval digest, the table, \`Argv:\`, and the first conflict entries.`
    : `The compact view (--format compact, the default) is bounded to ${OUTPUT_LIMIT} characters too and truncates its TAIL; at the response sizes that reach this tier it has measured under that limit, but it is not an unbounded alternative.`;
  degraded.truncationMarker = `JSON output truncated at ${limit} characters; ${dropped}, and every reason string was bounded to ${tier.reasonLimit} characters. Every repository's \`argv\`, its \`conflictStatus\`/\`conflictCount\`/\`conflictsTruncated\`, its \`baseDirty\`/\`baseMerging\`/\`baseDirtyCount\`, the aggregated \`conflicts\` list, and the approval digest survive: the argv is what the digest approves, so it is never dropped, and a shortened conflict list is always marked \`conflictsTruncated\` rather than presented as complete. ${compactNote}`;
  return degraded;
}

// `archive` needs its own fallback for the same reason `verify` and `merge` did, and the failure
// mode is the one this command can least afford: the general fallback below keeps only
// `{command, runId, status?, truncated, truncationMarker}`, so one repository past the budget turns
// a preview into a response with **no worktree paths and no loss counts in it at all** -- the two
// things the digest is over, and the two things an operator is being asked to approve. A `runs`
// board that collapses is annoying; an archive preview that collapses is an approval request with
// the subject removed.
//
// What scales here is per-path TEXT, and specifically the sentences: every `losses[].detail`
// restates its own worktree path, branch and base branch in prose, `unmergedReason` restates why a
// count is unknown, a `kept[]` entry carries git's own stderr (capped at 2,000 characters by
// commands.js), and a refusal's `reason` restates up to reasonRepositories x reasonPaths paths.
// Everything else -- ids, paths, branches, shas, booleans, counts, and the executed argv -- is
// fixed-size per repository. So this degrades exactly the prose and keeps every field a decision
// rests on.
//
// Two tiers, tried in order, and every number below is MEASURED against exactly one fixture:
// `worstCaseArchivePreview` in test/workflow-format.test.js, called with the `repo-NN` ids its own
// tier test uses. That precision is not pedantry -- these numbers were first published from a
// DIFFERENT id list (`backend`/`panel`/`webapp`/...), and every count was off by 5 x the
// name-length difference while being cited to a fixture that could not reproduce them. The
// boundaries were right under both; the byte counts were unreproducible from the source named.
// n = repositories, each with a full loss entry at realistic sharyco-shaped path lengths
// (~80-character worktree paths):
//
//   n = 1..10   no fallback needed          (n=8: 9,047 · n=10: 11,099)
//   n = 11      tier 1                      (11,533)
//   n = 12..16  tier 2                      (n=12: 9,117 · n=16: 11,501)
//   n >= 17     the general fallback below  (202 characters, no paths, no counts)
//
// The execute report flows through the same tiers and is measured too, with the same ids (a
// successful report, one `removed[]` entry and one loss per repository): no fallback to n=14
// (11,823), tier 1 at n=15 (11,482), tier 2 at n=16..17 (11,243 / 11,846), the general fallback
// from n=18 (226 characters). Every executed `argv` survives through tier 2 and is gone at the
// general one -- which is the whole reason the tiers exist for this command.
//
// The tiers ARE fixture-relative -- shorter worktree paths push every boundary out -- which is why
// the tests pin which tier engages rather than the byte counts. Tier 1 covering exactly one width
// on the preview is not an oversight: the two tiers exist so the shape degrades gradually instead
// of falling off a cliff one repository past a measured number, and the gradual step happens to be
// narrow at these path lengths. The compact view stays under budget considerably longer (measured
// on the same fixture: 11,790 characters at n=21, first truncating at n=22), which is the opposite
// of `merge`, where compact was the first to go.
//
// A first attempt at this shipped ONE tier that bounded each `detail` to 120 characters. Measuring
// it is what caught the defect: the real detail sentence is 119 characters, so `bound()` returned
// it unchanged, the degraded response was byte-for-byte the size of the original, and the command
// fell straight through to the general fallback at every size -- a fallback that existed, was
// wired in, and did nothing. That is exactly the class of collapse items 2.1, 2.3 and 2.4 each
// shipped once, and it was invisible from a green suite because the assertion it would have broken
// is the one measurement added.
//
// Tier 1 drops the prose and keeps every structured field. Tier 2 additionally reduces each record
// to the fields a decision actually rests on. What NEITHER tier ever drops, at any width: every
// `worktreePath` (what would be removed), every `unmergedCommits` and every loss `count` (what
// would be lost -- with `null` still meaning UNKNOWN, never 0), `branch`/`headSha` (what the digest
// binds), the approval digest itself, and every executed `argv` on a report's `removed[]`, which is
// the audit trail of directories that cannot be un-removed.
const ARCHIVE_OVERFLOW_TIERS = [
  { minimal: false, reasonLimit: 600, detailLimit: 240 },
  { minimal: true, reasonLimit: 240, detailLimit: 100 },
];

function strippedArchiveRepository(record, tier) {
  if (!record || typeof record !== "object") return record;
  if (tier.minimal) {
    return {
      repositoryId: record.repositoryId,
      worktreePath: record.worktreePath,
      present: record.present,
      branch: record.branch,
      headSha: record.headSha,
      basePath: record.basePath,
      baseBranch: record.baseBranch,
      // Copied verbatim, never defaulted: `null` here is UNKNOWN and a `?? 0` would turn it into
      // "fully merged, nothing to warn about" -- the opposite fact, and the one false green this
      // whole item exists to remove.
      unmergedCommits: record.unmergedCommits,
    };
  }
  // `unmergedReason` is the per-repository field whose size scales with path text. Dropping it
  // loses WHY a count is unknown; `unmergedCommits: null` still says THAT it is, and the marker
  // names the drop rather than letting it happen quietly.
  const { unmergedReason, ...rest } = record;
  return rest;
}

function strippedArchiveLoss(loss, tier) {
  if (!loss || typeof loss !== "object") return loss;
  if (tier.minimal) {
    return {
      repositoryId: loss.repositoryId,
      kind: loss.kind,
      // The join key back to `repositories[]`, and unique where `repositoryId` may be null on more
      // than one entry -- the same reason archiveReportLosses keys on it in commands.js.
      worktreePath: loss.worktreePath,
      count: loss.count,
      // Only ever present on an execution report, where it is the difference between a loss that
      // happened and one that did not. Preserved exactly, including `false`.
      ...(Object.hasOwn(loss, "removed") ? { removed: loss.removed } : {}),
    };
  }
  const { detail, ...rest } = loss;
  return rest;
}

function boundedArchiveDetail(entry, tier) {
  if (!entry || typeof entry !== "object" || typeof entry.detail !== "string") return entry;
  return { ...entry, detail: bound(entry.detail, tier.detailLimit, "detail") };
}

function archiveOverflowFallback(command, source, limit, tier) {
  const degraded = {
    ...source,
    ...(typeof source.reason === "string" ? { reason: bound(source.reason, tier.reasonLimit, "reason") } : {}),
    ...(Object.hasOwn(source, "repositories") ? { repositories: list(source.repositories).map((record) => strippedArchiveRepository(record, tier)) } : {}),
    ...(Object.hasOwn(source, "losses") ? { losses: list(source.losses).map((loss) => strippedArchiveLoss(loss, tier)) } : {}),
    // `removed[]` carries no `detail` at all and its `argv` is never touched -- it is the record of
    // what actually ran against a filesystem that re-running cannot restore. `kept[]` carries git's
    // own stderr, which is the one entry-level string whose size scales.
    ...(Object.hasOwn(source, "kept") ? { kept: list(source.kept).map((entry) => boundedArchiveDetail(entry, tier)) } : {}),
    truncated: true,
  };
  const dropped = tier.minimal
    ? "every loss's `detail` sentence was dropped, and each repository was reduced to `repositoryId`/`worktreePath`/`present`/`branch`/`headSha`/`basePath`/`baseBranch`/`unmergedCommits` -- `recordedBranch`, `branchMismatch`, `headReachable`, `unmergedReason` and the dirty counts were dropped with it, as were each loss's `branch`/`baseBranch`/`detail`"
    : "every loss's `detail` sentence was dropped and each repository's `unmergedReason` was dropped, so a count that is `null` still says it is UNKNOWN but no longer says why";
  degraded.truncationMarker = `JSON output truncated at ${limit} characters; ${dropped}, any \`kept\` entry's git output was bounded to ${tier.detailLimit} characters, and a refusal's \`reason\` was bounded to ${tier.reasonLimit}. Every repository's \`worktreePath\` and \`unmergedCommits\`, every loss's \`kind\` and \`count\` (\`null\` means UNKNOWN, never 0), every removal's executed \`argv\`, and the approval digest all survive at every tier: the worktree path is what would be removed, the count is what would be lost, and the digest is what binds them. The compact view (--format compact, the default) is bounded to ${OUTPUT_LIMIT} characters too and truncates its TAIL -- it keeps the run header, the "Would be lost" headline and the approval digest, which are printed above every path-heavy section for exactly this reason.`;
  return degraded;
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
  if (command === "verify") {
    return JSON.stringify(normalizeJson(verifyOverflowFallback(command, source, limit)), null, 2);
  }
  if (command === "merge") {
    // Same escalate-then-admit shape resultOverflowFallback uses, with one extra tier: degrading
    // the per-path text is what keeps the argv on the response. If even the minimal tier does not
    // fit, something other than path text is the cause and the general shape below is the honest
    // answer rather than a response that claims to be complete.
    for (const tier of MERGE_OVERFLOW_TIERS) {
      const degraded = JSON.stringify(normalizeJson(mergeOverflowFallback(command, source, limit, tier)), null, 2);
      if (degraded.length <= limit) return degraded;
    }
  }
  if (command === "archive") {
    // Same escalate-then-admit shape `merge` uses above: degrade the text that scales, keep the
    // paths and the counts. If even the minimal tier does not fit, something other than per-record
    // text is the cause and the general shape below is the honest answer rather than a response
    // that claims to be complete.
    for (const tier of ARCHIVE_OVERFLOW_TIERS) {
      const degraded = JSON.stringify(normalizeJson(archiveOverflowFallback(command, source, limit, tier)), null, 2);
      if (degraded.length <= limit) return degraded;
    }
  }
  if (command === "result") {
    const degraded = JSON.stringify(normalizeJson(resultOverflowFallback(command, source, limit)), null, 2);
    // Degrading the evidence is enough for the realistic cause of a result overflow (a wide
    // verify matrix) and is what keeps `result`/`status` on the response -- see
    // resultOverflowFallback's own comment. It is not guaranteed enough on its own: every other
    // field in the envelope, including `result` itself (an operator-authored `summary`, for
    // instance, has no cap of its own here), is carried through unabridged. If it is still over
    // budget after that, something else is the actual cause, and the minimal shape below -- the
    // same one every other command without a dedicated fallback uses -- is the honest answer.
    if (degraded.length <= limit) return degraded;
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
    case "verify":
      return formatVerify(value);
    case "merge":
      return formatMerge(value);
    case "archive":
      return formatArchive(value);
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
