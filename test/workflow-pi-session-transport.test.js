import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiSessionTransport } from "../src/workflow/pi-session-transport.js";

const ID = { kind: "pi-session", runId: "r1", sessionId: "s1", paneId: "w2:p9", tabId: "w2:t1", workspaceId: "w2", cwd: "/wt" };

// Herdr's `agent list` reports agent_session.value as a PATH to the session .jsonl file
// (e.g. ".../2026-07-25T04-14-13-629Z_<sessionId>.jsonl"), not the bare session UUID.
const SESSION_PATH = `/s/2026-07-25T04-14-13-629Z_${ID.sessionId}.jsonl`;

function herdrWith(agents, calls = []) {
  return {
    async listAgents() { return { agents }; },
    async agentSendKeys(a) { calls.push(a); return { sent: true }; },
  };
}

test("observeExact maps agent_status and identity to a state", async () => {
  const idle = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: SESSION_PATH }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }]) });
  assert.equal((await idle.observeExact(ID)).state, "idle");

  const busy = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: SESSION_PATH }, pane_id: "w2:p9", cwd: "/wt", agent_status: "working" }]) });
  assert.equal((await busy.observeExact(ID)).state, "active");

  const gone = createPiSessionTransport({ herdr: herdrWith([]) });
  assert.equal((await gone.observeExact(ID)).state, "missing");

  const reused = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: "/s/2026-07-25T04-14-13-629Z_other.jsonl" }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }]) });
  assert.equal((await reused.observeExact(ID)).state, "mismatch");
});

test("observeExact matches a session path that ends in the sessionId, not the bare UUID (probe regression)", async () => {
  // This is the exact shape Herdr reports: a full path ending in `_<sessionId>.jsonl`.
  // A naive `sessionValue === identity.sessionId` check would wrongly report "mismatch" here.
  const live = createPiSessionTransport({
    herdr: herdrWith([{
      agent_session: { value: "/home/user/.pi/sessions/2026-07-25T04-14-13-629Z_42e7f30d-6196-40ab-9d89-e04a31cb2433.jsonl" },
      pane_id: "w2:p9",
      cwd: "/wt",
      agent_status: "idle",
    }]),
  });
  const idFullSession = { ...ID, sessionId: "42e7f30d-6196-40ab-9d89-e04a31cb2433" };
  assert.equal((await live.observeExact(idFullSession)).state, "idle");

  const activeLive = createPiSessionTransport({
    herdr: herdrWith([{
      agent_session: { value: "/home/user/.pi/sessions/2026-07-25T04-14-13-629Z_42e7f30d-6196-40ab-9d89-e04a31cb2433.jsonl" },
      pane_id: "w2:p9",
      cwd: "/wt",
      agent_status: "working",
    }]),
  });
  assert.equal((await activeLive.observeExact(idFullSession)).state, "active");

  // Boundary check: a path ending in a DIFFERENT (merely prefix-sharing) session id must
  // still be a mismatch — the match is anchored on `<sessionId>.jsonl`, not a bare substring.
  const prefixCollision = createPiSessionTransport({
    herdr: herdrWith([{
      agent_session: { value: "/s/2026-07-25T04-14-13-629Z_s1x.jsonl" },
      pane_id: "w2:p9",
      cwd: "/wt",
      agent_status: "idle",
    }]),
  });
  assert.equal((await prefixCollision.observeExact(ID)).state, "mismatch");
});

test("observeExact reports mismatch when the pane's cwd does not match the identity", async () => {
  const transport = createPiSessionTransport({
    herdr: herdrWith([{ agent_session: { value: SESSION_PATH }, pane_id: "w2:p9", cwd: "/other", agent_status: "idle" }]),
  });
  assert.equal((await transport.observeExact(ID)).state, "mismatch");
});

test("observeExact reports unknown when Herdr errors", async () => {
  const transport = createPiSessionTransport({
    herdr: { async listAgents() { throw new Error("herdr unreachable"); }, async agentSendKeys() { return { sent: true }; } },
  });
  assert.equal((await transport.observeExact(ID)).state, "unknown");
});

test("requestGracefulClose sends exit keys only when idle", async () => {
  const calls = [];
  const idle = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: SESSION_PATH }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }], calls) });
  assert.deepEqual(await idle.requestGracefulClose(ID), { requested: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { target: "w2:p9", keys: ["ctrl+d"] });

  const busyCalls = [];
  const busy = createPiSessionTransport({ herdr: herdrWith([{ agent_session: { value: SESSION_PATH }, pane_id: "w2:p9", cwd: "/wt", agent_status: "working" }], busyCalls) });
  assert.deepEqual(await busy.requestGracefulClose(ID), { requested: false });
  assert.equal(busyCalls.length, 0);

  const missingCalls = [];
  const missing = createPiSessionTransport({ herdr: herdrWith([], missingCalls) });
  assert.deepEqual(await missing.requestGracefulClose(ID), { requested: false });
  assert.equal(missingCalls.length, 0);
});

test("requestGracefulClose honors a custom exitKeys sequence", async () => {
  const calls = [];
  const transport = createPiSessionTransport({
    herdr: herdrWith([{ agent_session: { value: SESSION_PATH }, pane_id: "w2:p9", cwd: "/wt", agent_status: "idle" }], calls),
    exitKeys: ["ctrl+c", "ctrl+d"],
  });
  assert.deepEqual(await transport.requestGracefulClose(ID), { requested: true });
  assert.deepEqual(calls[0], { target: "w2:p9", keys: ["ctrl+c", "ctrl+d"] });
});

test("start and deliverFollowUp are unsupported and throw WorkflowError", async () => {
  const transport = createPiSessionTransport({ herdr: herdrWith([]) });
  await assert.rejects(() => transport.start({}), (error) => error.name === "WorkflowError" && error.category === "pi-session-transport");
  await assert.rejects(() => transport.deliverFollowUp(ID, "hi"), (error) => error.name === "WorkflowError" && error.category === "pi-session-transport");
});

test("observeExact and requestGracefulClose reject a malformed identity", async () => {
  const transport = createPiSessionTransport({ herdr: herdrWith([]) });
  await assert.rejects(() => transport.observeExact({ kind: "pi-session" }), (error) => error.name === "WorkflowError");
  await assert.rejects(() => transport.requestGracefulClose(null), (error) => error.name === "WorkflowError");
});
