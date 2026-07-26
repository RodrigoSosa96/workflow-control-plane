import assert from "node:assert/strict";
import { test } from "node:test";
import { renderClaudeStatusLine } from "../hooks/claude-statusline.mjs";

test("renders a workflow status line from a telemetry snapshot", () => {
  const line = renderClaudeStatusLine({ env: { WORKFLOW_RUN_ID: "abc1234567", WORKFLOW_HARNESS: "claude" },
    stdinJson: { model: { display_name: "Sonnet" } },
    snapshot: { phase: "running", observability: "reported" } });
  assert.match(line, /abc12345/);
  assert.match(line, /running/);
  assert.match(line, /claude/);
});

test("returns a safe minimal line on bad input (never throws)", () => {
  const line = renderClaudeStatusLine({ env: {}, stdinJson: null, snapshot: null });
  assert.equal(typeof line, "string");
});
