import { WorkflowError } from "./errors.js";

function fail(message, details) {
  throw new WorkflowError("pi-session-transport", message, { details });
}

function assertIdentity(identity) {
  if (!identity || identity.kind !== "pi-session" || typeof identity.sessionId !== "string" || !identity.sessionId
    || typeof identity.paneId !== "string" || !identity.paneId) {
    fail("pi-session identity requires kind, sessionId, and paneId", { identity });
  }
  return identity;
}

function agentList(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.agents) ? value.agents : [];
}

// Herdr's `agent list` reports `agent_session.value` as a PATH to the session's .jsonl
// file (e.g. ".../2026-07-25T04-14-13-629Z_<sessionId>.jsonl"), not the bare session UUID
// that our identity carries. The probe (Task 1) confirmed this — matching must anchor on
// the path suffix, never on strict equality against the bare sessionId.
function sessionMatches(sessionValue, sessionId) {
  return typeof sessionValue === "string" && sessionValue.endsWith(`${sessionId}.jsonl`);
}

export function createPiSessionTransport({ herdr, exitKeys = ["ctrl+d"] } = {}) {
  if (!herdr || typeof herdr.listAgents !== "function" || typeof herdr.agentSendKeys !== "function") {
    fail("pi-session transport requires a Herdr adapter with listAgents and agentSendKeys");
  }

  async function observeExact(requested) {
    const identity = assertIdentity(requested);
    let agents;
    try {
      agents = agentList(await herdr.listAgents());
    } catch {
      return { state: "unknown", identity };
    }
    const onPane = agents.find((a) => (a?.pane_id ?? a?.paneId) === identity.paneId);
    if (!onPane) return { state: "missing", identity };
    const sessionValue = onPane.agent_session?.value ?? onPane.agentSession?.value;
    const cwd = onPane.cwd ?? onPane.foreground_cwd;
    if (!sessionMatches(sessionValue, identity.sessionId) || (identity.cwd && cwd && cwd !== identity.cwd)) {
      return { state: "mismatch", identity, details: { observedActive: String(onPane.agent_status === "working") } };
    }
    return { state: onPane.agent_status === "working" ? "active" : "idle", identity };
  }

  async function requestGracefulClose(requested) {
    const identity = assertIdentity(requested);
    const observation = await observeExact(identity);
    if (observation.state !== "idle") return { requested: false };
    await herdr.agentSendKeys({ target: identity.paneId, keys: exitKeys });
    return { requested: true };
  }

  async function start() { fail("pi-session transport start is handled by resume relaunch, not the transport"); }
  async function deliverFollowUp() { fail("pi-session transport does not deliver follow-ups"); }

  return Object.freeze({ start, observeExact, deliverFollowUp, requestGracefulClose });
}
