import { WorkflowError } from "./errors.js";
import { normalizeTask } from "./naming.js";

function fail(category, message, options) {
  throw new WorkflowError(category, message, options);
}

export function normalizeTicketBundle({ primary, related = [], maxTickets } = {}) {
  if (!Number.isInteger(maxTickets) || maxTickets < 1) {
    fail("plan", "Ticket bundle maximum must be a positive integer");
  }
  if (related !== undefined && !Array.isArray(related)) {
    fail("plan", "Related tickets must be an array");
  }

  const normalizedPrimary = normalizeTask(primary);
  const normalizedRelated = [...new Set((related ?? []).map((ticket) => normalizeTask(ticket)))].sort();

  if (normalizedRelated.includes(normalizedPrimary)) {
    fail("plan", "Related tickets must not include the primary ticket");
  }

  const all = [normalizedPrimary, ...normalizedRelated];
  if (all.length > maxTickets) {
    fail("plan", `Ticket bundle exceeds maximum of ${maxTickets} tickets`);
  }

  return {
    primary: normalizedPrimary,
    related: normalizedRelated,
    all,
  };
}
