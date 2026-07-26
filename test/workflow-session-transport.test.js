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
