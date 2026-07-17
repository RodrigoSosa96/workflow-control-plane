const OUTPUT_LIMIT = 12000;

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = normalizeJson(value[key]);
    return result;
  }, {});
}

function bound(text) {
  const value = String(text);
  if (value.length <= OUTPUT_LIMIT) return value;
  const suffix = "\n...[truncated]";
  return value.slice(0, OUTPUT_LIMIT - suffix.length) + suffix;
}

function addConflicts(lines, conflicts = []) {
  if (!conflicts.length) return;
  lines.push("Conflicts:");
  for (const conflict of conflicts) {
    lines.push(`- ${conflict.resource}: ${conflict.reason}`);
  }
}

function formatDoctor(result) {
  const lines = [
    `Doctor: ${result.ok ? "ready" : "needs attention"}`,
    `Project: ${result.project.label} [${result.project.alias}]`,
  ];
  for (const check of result.checks) {
    lines.push(`${check.id} | ${check.status}${check.reason ? ` | ${check.reason}` : ""}`);
  }
  return bound(lines.join("\n"));
}

function formatPlanLike(result) {
  const lines = [
    `Project: ${result.project.label} [${result.project.alias}]`,
    `Status: ${result.reconciliation.status}`,
  ];
  if (result.nextCommand) lines.push(`Next: ${result.nextCommand}`);
  addConflicts(lines, result.conflicts?.length ? result.conflicts : result.reconciliation.conflicts);
  return bound(lines.join("\n"));
}

export function formatWorkflowResult(command, value, format = "compact") {
  if (format === "json") {
    return JSON.stringify(normalizeJson(value), null, 2);
  }

  switch (command) {
    case "doctor":
      return formatDoctor(value);
    case "plan":
    case "status":
      return formatPlanLike(value);
    default:
      return bound(JSON.stringify(normalizeJson(value), null, 2));
  }
}
