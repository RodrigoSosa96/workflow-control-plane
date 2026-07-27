import { WorkflowError } from "./errors.js";

function fail(harness, message, details) {
  throw new WorkflowError(`${harness}-session-transport`, message, { details });
}

function assertIdentity(harness, identity) {
  if (!identity || typeof identity.kind !== "string" || !identity.kind
    || typeof identity.sessionId !== "string" || !identity.sessionId
    || typeof identity.paneId !== "string" || !identity.paneId) {
    fail(harness, `${harness}-session identity requires kind, sessionId, and paneId`, { identity });
  }
  return identity;
}

function agentList(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.agents) ? value.agents : [];
}

// Herdr's `agent list` reports `agent_session.value` differently per harness:
//   - Pi: a PATH to the session's .jsonl file (e.g. ".../2026-07-25T04-14-13-629Z_<sessionId>.jsonl"),
//     not the bare session UUID that our identity carries. Matching must anchor on the
//     path suffix, never on strict equality against the bare sessionId.
//   - Claude: `{ kind: "id", value: "<bare-uuid>" }` — no path, so strict equality is correct.
export const SESSION_ADAPTERS = Object.freeze({
  pi: Object.freeze({
    sessionMatches(value, id) {
      return typeof value === "string" && value.endsWith(`_${id}.jsonl`);
    },
    exitKeys: Object.freeze(["ctrl+d"]),
  }),
  claude: Object.freeze({
    sessionMatches(value, id) {
      return value === id;
    },
    // Claude Code does not exit on ctrl+d (empirically verified in the human/TTY e2e); the
    // `/exit` slash command does. So the claude close types this text and submits it with a
    // separate `enter`, rather than sending an exit key like pi. exitKeys is kept as a
    // harmless fallback but is unused while exitText is present.
    exitText: "/exit",
    exitKeys: Object.freeze(["ctrl+d"]),
  }),
});

export function createSessionTransport({ herdr, harness = "pi", exitKeys } = {}) {
  const adapter = SESSION_ADAPTERS[harness];
  if (!adapter) {
    fail(harness, `unsupported harness "${harness}" for session transport`, { harness });
  }
  // Only `listAgents` is required up front: `observeExact` (used by both resume and close) needs
  // nothing else. `agentSendKeys` is needed solely by `requestGracefulClose` (close), so it is
  // validated lazily there instead of here — a resume-only caller (e.g. commands.js's
  // transportForRun, built for every resume regardless of whether a relaunch follows) should not
  // have to hand this factory a Herdr adapter capable of sending keys it will never send.
  if (!herdr || typeof herdr.listAgents !== "function") {
    fail(harness, `${harness}-session transport requires a Herdr adapter with listAgents`);
  }
  const resolvedExitKeys = exitKeys ?? adapter.exitKeys;

  async function observeExact(requested) {
    const identity = assertIdentity(harness, requested);
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
    if (!adapter.sessionMatches(sessionValue, identity.sessionId) || (identity.cwd && cwd && cwd !== identity.cwd)) {
      return { state: "mismatch", identity, details: { observedActive: String(onPane.agent_status === "working") } };
    }
    return { state: onPane.agent_status === "working" ? "active" : "idle", identity };
  }

  async function requestGracefulClose(requested) {
    const identity = assertIdentity(harness, requested);
    const observation = await observeExact(identity);
    if (observation.state !== "idle") return { requested: false };
    if (typeof herdr.agentSendKeys !== "function") {
      fail(harness, `${harness}-session transport requires a Herdr adapter with agentSendKeys to close a session`);
    }
    // Some harnesses (Claude) do not exit on an exit key — they need a slash command typed as
    // literal text and then submitted. When the adapter declares `exitText`, type it via
    // `sendText` and submit with `enter`; otherwise send the exit keys directly (pi's ctrl+d).
    if (adapter.exitText) {
      if (typeof herdr.sendText !== "function") {
        fail(harness, `${harness}-session transport requires a Herdr adapter with sendText to close a session`);
      }
      await herdr.sendText({ paneId: identity.paneId, text: adapter.exitText });
      await herdr.agentSendKeys({ target: identity.paneId, keys: ["enter"] });
      return { requested: true };
    }
    await herdr.agentSendKeys({ target: identity.paneId, keys: resolvedExitKeys });
    return { requested: true };
  }

  async function start() { fail(harness, `${harness}-session transport start is handled by resume relaunch, not the transport`); }
  async function deliverFollowUp() { fail(harness, `${harness}-session transport does not deliver follow-ups`); }

  return Object.freeze({ start, observeExact, deliverFollowUp, requestGracefulClose });
}

export function createPiSessionTransport({ herdr, exitKeys } = {}) {
  return createSessionTransport({ herdr, harness: "pi", ...(exitKeys ? { exitKeys } : {}) });
}
