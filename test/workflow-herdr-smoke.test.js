import { test } from "node:test";

const enabled = process.env.WORKFLOW_RUN_LIVE_HERDR_SMOKE === "1";

if (!enabled) {
  console.log("Skipping Herdr smoke tests. Set WORKFLOW_RUN_LIVE_HERDR_SMOKE=1 to enable.");
}

test("live Herdr smoke is opt-in and skipped by default", { skip: !enabled }, async () => {
  // Placeholder: real Herdr smoke requires manual approval and is never run in automated tests.
  throw new Error("Live Herdr smoke not implemented in automated suite");
});
