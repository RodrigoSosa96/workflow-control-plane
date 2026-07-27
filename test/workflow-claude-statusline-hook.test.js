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

// FINDING 2: the model comes from the stdin payload, so it must surface even when the
// telemetry snapshot is still absent (thin) — previously it was only read after the
// null-snapshot early return.
test("surfaces the model even when the snapshot is absent (thin)", () => {
  const line = renderClaudeStatusLine({ env: { WORKFLOW_RUN_ID: "abc1234567", WORKFLOW_HARNESS: "claude" },
    stdinJson: { model: { display_name: "Sonnet" } },
    snapshot: null });
  assert.match(line, /starting/);
  assert.match(line, /Sonnet/);
});
