import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { renderClaudeStatusLine } from "../hooks/claude-statusline.mjs";
import { createRunStore } from "../src/workflow/run-store.js";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";

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

// --- Task 3: does this hook's store construction ever need a readOwnOwnership reader? ------
//
// Task 3's brief calls this out explicitly: wire readOwnOwnership into every subprocess hook's
// run store UNLESS a given site never actually acquires the lock, in which case wiring it would
// be speculative. hooks/claude-statusline.mjs's main() only ever reads (loadSnapshot() ->
// telemetry.read() -> store.read()); it never calls store.update/create/appendEvent/
// writeAssignment/writePrivateFile, which are the only run-store entry points that call
// withLock. This test proves that claim directly against the real store + telemetry store,
// mirroring the exact call the hook makes: if a future change ever made this path acquire the
// lock, readOwnOwnershipCalls would go non-zero and this test would fail, which is the signal
// that hooks/claude-statusline.mjs would then need the same wiring as the lifecycle hooks.
// hooks/claude-statusline.mjs itself is therefore left unmodified by this task.
test("the statusline hook's telemetry read path never acquires the run lock, so no readOwnOwnership wiring is needed there", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-claude-statusline-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const RUN_ID = "77777777-7777-4777-8777-777777777777";

  let readOwnOwnershipCalls = 0;
  const store = createRunStore({
    stateRoot: join(root, "state"),
    randomUUID: () => RUN_ID,
    readOwnOwnership: async () => { readOwnOwnershipCalls += 1; return null; },
  });
  // Creating the run acquires its own lock (readOwnOwnershipCalls goes to 1 here); reset the
  // counter so only the read path under test -- the one loadSnapshot() actually exercises -- is
  // measured below.
  await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  readOwnOwnershipCalls = 0;

  const telemetry = createTelemetryStore({ store });
  await telemetry.read({ runId: RUN_ID }); // mirrors claude-statusline.mjs's loadSnapshot()

  assert.equal(readOwnOwnershipCalls, 0, "reading telemetry for the statusline must never take the run lock");
});
