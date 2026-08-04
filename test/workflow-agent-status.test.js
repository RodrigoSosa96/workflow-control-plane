import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentStatus,
  HERDR_AGENT_STATUSES,
  paneId,
  STOPPED_AGENT_STATUSES,
  WRITER_HARNESSES,
} from "../src/workflow/agent-status.js";

test("HERDR_AGENT_STATUSES matches Herdr's documented vocabulary exactly", () => {
  assert.deepEqual([...HERDR_AGENT_STATUSES].sort(), ["blocked", "done", "idle", "unknown", "working"]);
});

test("HERDR_AGENT_STATUSES is frozen", () => {
  // Object.freeze on a Set only locks its own properties, not Set.prototype.add's internal
  // slot mutation — so this documents intent (do not reassign/extend this export) rather
  // than a runtime guarantee against .add()/.delete().
  assert.equal(Object.isFrozen(HERDR_AGENT_STATUSES), true);
});

test("agentStatus reads Herdr's snake_case agent_status", () => {
  assert.equal(agentStatus({ agent_status: "working" }), "working");
});

test("agentStatus reads a camelCase agentStatus", () => {
  assert.equal(agentStatus({ agentStatus: "idle" }), "idle");
});

test("agentStatus falls back to a generic status field", () => {
  assert.equal(agentStatus({ status: "blocked" }), "blocked");
});

test("agentStatus prefers agent_status over agentStatus and status", () => {
  assert.equal(agentStatus({ agent_status: "done", agentStatus: "idle", status: "working" }), "done");
});

test("agentStatus lowercases the value", () => {
  assert.equal(agentStatus({ agent_status: "WORKING" }), "working");
  assert.equal(agentStatus({ agent_status: "Blocked" }), "blocked");
});

test("agentStatus returns null when the field is absent", () => {
  assert.equal(agentStatus({}), null);
  assert.equal(agentStatus(null), null);
  assert.equal(agentStatus(undefined), null);
});

test("agentStatus returns null for a non-string status", () => {
  assert.equal(agentStatus({ agent_status: 42 }), null);
  assert.equal(agentStatus({ agent_status: true }), null);
  assert.equal(agentStatus({ agent_status: { value: "working" } }), null);
  assert.equal(agentStatus({ agent_status: null }), null);
});

test("paneId reads Herdr's snake_case pane_id", () => {
  assert.equal(paneId({ pane_id: "pane-1" }), "pane-1");
});

test("paneId reads a camelCase paneId", () => {
  assert.equal(paneId({ paneId: "pane-2" }), "pane-2");
});

test("paneId prefers pane_id over paneId when both are present", () => {
  assert.equal(paneId({ pane_id: "pane-1", paneId: "pane-2" }), "pane-1");
});

test("paneId returns null when neither shape is present", () => {
  assert.equal(paneId({}), null);
  assert.equal(paneId(null), null);
  assert.equal(paneId(undefined), null);
});

test("blocked is not a stopped status: a blocked agent is alive and waiting", () => {
  assert.equal(STOPPED_AGENT_STATUSES.has("blocked"), false);
});

test("STOPPED_AGENT_STATUSES holds the harness- and launcher-reported terminal states", () => {
  assert.deepEqual([...STOPPED_AGENT_STATUSES].sort(), ["completed", "dead", "done", "exited", "failed", "stopped"]);
});

test("WRITER_HARNESSES holds exactly the interactive writer harnesses", () => {
  assert.deepEqual([...WRITER_HARNESSES].sort(), ["claude", "codex", "pi"]);
});
