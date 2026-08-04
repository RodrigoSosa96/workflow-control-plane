// Herdr's own agent-status vocabulary, from `herdr agent wait --help`:
//   [possible values: idle, working, blocked, done, unknown]
// `blocked` deliberately is NOT a stopped status — a blocked agent is alive and waiting.
export const HERDR_AGENT_STATUSES = Object.freeze(new Set(["idle", "working", "blocked", "done", "unknown"]));

// The one member of HERDR_AGENT_STATUSES that means "alive and sitting at a permission prompt
// right now" -- the fact `workflow inbox`'s `blocked` bucket exists to surface. A named export,
// not a bare "blocked" string literal at the comparison site, so a caller checks membership in
// the vocabulary first and only then asks "is it this one" -- an unrecognized or renamed status
// lands as a reported unresolved, not a silent, forever-empty non-match.
export const HERDR_BLOCKED_STATUS = "blocked";

// Harnesses whose agent registration in Herdr is trustworthy evidence of a live writer
// touching the checkout. Anything else (e.g. a bare shell pane) is not considered a writer.
export const WRITER_HARNESSES = new Set(["pi", "claude", "codex"]);

// Statuses that mean the agent process is no longer occupying its pane. This is a distinct,
// narrower vocabulary than HERDR_AGENT_STATUSES above: reconciliation also sees harness- and
// launcher-reported terminal states ("completed", "exited", "stopped", "dead", "failed")
// alongside Herdr's own "done", so the two sets are not interchangeable.
// `blocked` is deliberately absent — a blocked agent is alive and waiting on the operator,
// not stopped, and the next task (workflow inbox) depends on that distinction to find it.
export const STOPPED_AGENT_STATUSES = new Set(["done", "completed", "exited", "stopped", "dead", "failed"]);

// Reads a pane/agent id from either Herdr's snake_case wire shape or a camelCase one used
// internally by planned/launched agent records.
export function paneId(pane) {
  return pane?.pane_id ?? pane?.paneId ?? null;
}

// Reads and normalizes an agent status from any of the shapes reconciliation encounters:
// Herdr's `agent_status`, a camelCase `agentStatus`, or a generic `status` field. Always
// lowercased so callers can compare against HERDR_AGENT_STATUSES / STOPPED_AGENT_STATUSES
// without worrying about case; returns null when absent or not a string.
export function agentStatus(value) {
  const status = value?.agent_status ?? value?.agentStatus ?? value?.status ?? null;
  return typeof status === "string" ? status.toLowerCase() : null;
}

// Herdr's listAgents()/listWorkspaces()/listTabs()/listPanes() wire shape is `{<key>: [...]}`,
// but some call sites (and test doubles) hand back a bare array. Was three private, byte-identical
// three-line copies -- commands.js, reconcile.js, execute.js -- before this module (already the
// shared home for the same wire-shape normalization concern, `agentStatus`/`paneId` above) picked
// it up as an eighth collapsed duplication.
export function listValue(value, key) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : [];
}
