import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionTransport, SESSION_ADAPTERS } from "../src/workflow/session-transport.js";

const identity = { kind: "claude-session", harness: "claude", runId: "r1", sessionId: "11111111-1111-4111-8111-111111111111", paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", cwd: "/wt" };

function herdrWith(agents) {
  return {
    async listAgents() { return { agents }; },
    async agentSendKeys() { return { type: "ok" }; },
    async focusAgent() {},
  };
}

function recordingHerdr(agents) {
  const calls = [];
  return {
    calls,
    async listAgents() { return { agents }; },
    async sendText(a) { calls.push(["sendText", a]); return { type: "ok" }; },
    async agentSendKeys(a) { calls.push(["agentSendKeys", a]); return { type: "ok" }; },
    async focusAgent() {},
  };
}

const idleClaudeAgent = { agent: "claude", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle",
  agent_session: { kind: "id", value: "11111111-1111-4111-8111-111111111111" } };

test("claude requestGracefulClose types /exit then enter (never ctrl+d) when idle", async () => {
  const herdr = recordingHerdr([idleClaudeAgent]);
  const transport = createSessionTransport({ harness: "claude", herdr });
  assert.deepEqual(await transport.requestGracefulClose(identity), { requested: true });
  assert.deepEqual(herdr.calls, [
    ["sendText", { paneId: "w1:p2", text: "/exit" }],
    ["agentSendKeys", { target: "w1:p2", keys: ["enter"] }],
  ]);
  // ctrl+d must never be sent for a claude close.
  assert.ok(!herdr.calls.some(([, a]) => Array.isArray(a?.keys) && a.keys.includes("ctrl+d")));
});

test("claude requestGracefulClose does nothing when the agent is not idle", async () => {
  const busy = { ...idleClaudeAgent, agent_status: "working" };
  const herdr = recordingHerdr([busy]);
  const transport = createSessionTransport({ harness: "claude", herdr });
  assert.deepEqual(await transport.requestGracefulClose(identity), { requested: false });
  assert.equal(herdr.calls.length, 0);
});

test("claude adapter exposes exitText '/exit' and keeps pi on ctrl+d", () => {
  assert.equal(SESSION_ADAPTERS.claude.exitText, "/exit");
  assert.equal(SESSION_ADAPTERS.pi.exitText, undefined);
  assert.deepEqual(SESSION_ADAPTERS.pi.exitKeys, ["ctrl+d"]);
});

test("claude adapter matches a bare-uuid agent_session value (kind:id), not a path suffix", async () => {
  const transport = createSessionTransport({ harness: "claude", herdr: herdrWith([
    { agent: "claude", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle",
      agent_session: { kind: "id", value: "11111111-1111-4111-8111-111111111111" } },
  ]) });
  const obs = await transport.observeExact(identity);
  assert.equal(obs.state, "idle");
});

test("claude adapter reports mismatch when the bare-uuid session differs", async () => {
  const transport = createSessionTransport({ harness: "claude", herdr: herdrWith([
    { agent: "claude", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle",
      agent_session: { kind: "id", value: "99999999-9999-4999-8999-999999999999" } },
  ]) });
  const obs = await transport.observeExact(identity);
  assert.equal(obs.state, "mismatch");
});

test("SESSION_ADAPTERS expose pi (path-suffix) and claude (bare-id) match rules", () => {
  assert.equal(SESSION_ADAPTERS.claude.sessionMatches("11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"), true);
  assert.equal(SESSION_ADAPTERS.pi.sessionMatches("/x/2026_abc.jsonl", "abc"), true);
  assert.equal(SESSION_ADAPTERS.pi.sessionMatches("abc", "abc"), false);
});

test("codex adapter matches a bare-uuid session and closes via /quit text", async () => {
  const identity = { kind: "codex-session", harness: "codex", runId: "r1", sessionId: "11111111-1111-4111-8111-111111111111", paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", cwd: "/wt" };
  const calls = [];
  const herdr = {
    async listAgents() { return { agents: [{ agent: "codex", pane_id: "w1:p2", cwd: "/wt", agent_status: "idle", agent_session: { kind: "id", value: "11111111-1111-4111-8111-111111111111" } }] }; },
    async sendText(a) { calls.push(["sendText", a]); },
    async agentSendKeys(a) { calls.push(["agentSendKeys", a]); return { type: "ok" }; },
    async focusAgent() {},
  };
  // Inject a no-op sleep so the test doesn't wait the real settle, and record it to assert the
  // settle happens BETWEEN typing /quit and the enter (the fix for Codex's newline-swallow race).
  const t = createSessionTransport({ harness: "codex", herdr, sleep: async (ms) => { calls.push(["sleep", ms]); } });
  assert.equal((await t.observeExact(identity)).state, "idle");
  const r = await t.requestGracefulClose(identity);
  assert.equal(r.requested, true);
  assert.deepEqual(calls[0], ["sendText", { paneId: "w1:p2", text: "/quit" }]);
  assert.deepEqual(calls[1], ["sleep", 1000]);
  assert.deepEqual(calls[2], ["agentSendKeys", { target: "w1:p2", keys: ["enter"] }]);
});

test("SESSION_ADAPTERS.codex exposes a bare-id match rule", () => {
  assert.equal(SESSION_ADAPTERS.codex.sessionMatches("abc", "abc"), true);
  assert.equal(SESSION_ADAPTERS.codex.sessionMatches("/x/abc.jsonl", "abc"), false);
});

test("codex observeExact trusts its pane when the resumed session is not yet reported (empty)", async () => {
  const identity = { kind: "codex-session", harness: "codex", runId: "r1", sessionId: "sess-1", paneId: "w3:p1", tabId: "w3:t1", workspaceId: "w3", cwd: "/wt" };
  const herdrWith = (session, cwd = "/wt") => ({ async listAgents() { return { agents: [{ agent: "codex", pane_id: "w3:p1", cwd, agent_status: "idle", agent_session: session }] }; } });
  // Herdr reports the relaunched agent at our pane but agent_session is still empty → trust it (idle, not mismatch).
  assert.equal((await createSessionTransport({ harness: "codex", herdr: herdrWith({ kind: "id", value: "" }) }).observeExact(identity)).state, "idle");
  assert.equal((await createSessionTransport({ harness: "codex", herdr: herdrWith(undefined) }).observeExact(identity)).state, "idle");
  // A DIFFERENT non-empty session at the pane is still a mismatch.
  assert.equal((await createSessionTransport({ harness: "codex", herdr: herdrWith({ kind: "id", value: "other" }) }).observeExact(identity)).state, "mismatch");
});

test("pi/claude do NOT trust an empty session (no opt-in) — still mismatch", async () => {
  const mk = (harness) => ({ kind: `${harness}-session`, harness, runId: "r1", sessionId: "sess-1", paneId: "w3:p1", tabId: "w3:t1", workspaceId: "w3", cwd: "/wt" });
  const herdrEmpty = { async listAgents() { return { agents: [{ agent: "claude", pane_id: "w3:p1", cwd: "/wt", agent_status: "idle", agent_session: { kind: "id", value: "" } }] }; } };
  assert.equal((await createSessionTransport({ harness: "claude", herdr: herdrEmpty }).observeExact(mk("claude"))).state, "mismatch");
});
