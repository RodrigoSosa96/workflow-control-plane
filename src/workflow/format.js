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

function formatReconcile(value) {
  const lines = [
    `Run: ${text(value.runId)}`,
    `Status: ${text(value.status)}`,
  ];
  if (value.projectAlias) lines.push(`Project: ${value.projectLabel ? `${value.projectLabel} ` : ""}[${value.projectAlias}]`);
  if (value.state) lines.push(`State: ${value.state}`);
  if (value.fallbackWorkspace) lines.push(`Fallback workspace: ${value.fallbackWorkspace}`);
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

function valueForJson(command, value) {
  if (command === "worker-status" || command === "worker-watch") return publicWorkerResult(value);
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
