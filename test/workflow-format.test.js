import assert from "node:assert/strict";
import { test } from "node:test";
import { formatInbox, formatRuns, formatWorkflowResult } from "../src/workflow/format.js";

const RUN_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST = `sha256:${"a".repeat(64)}`;

function launchPreview(overrides = {}) {
  return {
    command: "launch",
    project: { alias: "acme", label: "Acme" },
    request: {
      task: "SHARY-123",
      tickets: ["SHARY-123", "SHARY-140", "SHARY-152"],
      relatedTickets: ["SHARY-140", "SHARY-152"],
      repositories: ["backend", "panel"],
    },
    selection: {
      profileName: "claude-worker",
      harness: "claude",
      permissions: { permission_mode: "manual" },
    },
    reconciliation: {
      identity: {
        projectAlias: "acme",
        projectLabel: "Acme",
        task: "SHARY-123",
        primaryTicket: "SHARY-123",
        relatedTickets: ["SHARY-140", "SHARY-152"],
        tickets: ["SHARY-123", "SHARY-140", "SHARY-152"],
      },
      workspace: { path: "/absolute/worktree/path" },
      worktrees: [{ path: "/absolute/worktree/path" }],
      operations: [],
    },
    runDirectory: "/absolute/run-directory/path",
    assignmentPath: "/absolute/run-directory/path/assignment.md",
    approvalDigest: DIGEST,
    launchSpec: { argv: ["claude", "--permission-mode", "manual", "<bootstrap>"] },
    assignment: "# Approved assignment\n\nWorker instructions stay here.",
    ...overrides,
  };
}

test("compact launch preview prints the required deterministic header and complete assignment", () => {
  const compact = formatWorkflowResult("launch", launchPreview(), "compact");

  assert.equal(compact, [
    "Project: Acme [acme]",
    "Primary ticket: SHARY-123",
    "Related tickets: SHARY-140, SHARY-152",
    "Agent profile: claude-worker",
    "Harness: claude",
    "Permission mode: manual",
    "Writable roots: /absolute/worktree/path, /absolute/run-directory/path",
    `Approval digest: ${DIGEST}`,
    'Launch argv: ["claude","--permission-mode","manual","<bootstrap>"]',
    "Assignment:",
    "# Approved assignment",
    "",
    "Worker instructions stay here.",
  ].join("\n"));
});

test("launch JSON keeps the original request only inside the assignment", () => {
  const request = "Fix this exactly: $(do-not-run)";
  const formatted = formatWorkflowResult("launch", launchPreview({
    assignment: `BEGIN ORIGINAL REQUEST\n${request}\nEND ORIGINAL REQUEST`,
    executionInput: { options: { request } },
  }), "json");

  assert.equal(formatted.split(request).length - 1, 1);
  const parsed = JSON.parse(formatted);
  assert.equal(parsed.executionInput.options.request, "[redacted; preserved in assignment]");
});

test("assignment formatting has its own explicit truncation marker and saved path", () => {
  const compact = formatWorkflowResult("launch", launchPreview({
    assignment: "x".repeat(70 * 1024),
  }), "compact");

  assert.ok(compact.length <= 66 * 1024);
  assert.match(compact, /assignment truncated/i);
  assert.match(compact, /complete assignment saved at \/absolute\/run-directory\/path\/assignment\.md/i);
  assert.doesNotMatch(compact, /\.\.\.\[truncated\]$/i);
});

test("launch run output includes run IDs, state, harness locations, exact commands, and fallback workspace", () => {
  const compact = formatWorkflowResult("launch", {
    command: "launch",
    status: "running",
    runId: RUN_ID,
    runDirectory: `/state/workflow/${RUN_ID}`,
    state: "running",
    harness: "codex",
    profileName: "codex-worker",
    workspace: { id: "workspace-1", path: "/worktrees/ocr/A-1" },
    tabId: "tab-1",
    paneId: "pane-1",
    resultCommand: `workflow result ${RUN_ID}`,
    statusCommand: "workflow status ocr A-1 --tickets A-2",
    reconcileCommand: `workflow reconcile --run ${RUN_ID}`,
    fallbackWorkspace: "/worktrees/ocr/A-1",
  }, "compact");

  for (const expected of [
    `Run: ${RUN_ID}`,
    "State: running",
    "Harness: codex",
    "Agent profile: codex-worker",
    "Workspace: /worktrees/ocr/A-1",
    "Workspace ID: workspace-1",
    "Tab: tab-1",
    "Pane: pane-1",
    `Result: workflow result ${RUN_ID}`,
    "Status: workflow status ocr A-1 --tickets A-2",
    `Reconcile: workflow reconcile --run ${RUN_ID}`,
    "Fallback workspace: /worktrees/ocr/A-1",
  ]) {
    assert.match(compact, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("worker telemetry formatting exposes safe measurements without private identity", () => {
  const value = {
    command: "worker-status",
    runId: RUN_ID,
    workers: [{
      workerId: "22222222-2222-4222-8222-222222222222",
      harness: "pi",
      profileName: "pi-worker",
      phase: "running",
      turns: 2,
      model: "gpt-5",
      usage: {
        input: { availability: "reported", value: 12 },
        output: { availability: "reported", value: 3 },
        cost: { availability: "not-reported", value: null },
      },
      identity: { sessionPath: "/private/session.jsonl" },
      rawEvents: [{ prompt: "DO-NOT-LEAK" }],
    }],
  };
  const compact = formatWorkflowResult("worker-status", value, "compact");
  assert.match(compact, /pi.*running.*turn 2/i);
  assert.match(compact, /12 input.*3 output.*cost: not-reported/i);
  assert.doesNotMatch(compact, /DO-NOT-LEAK|\/private/);

  const json = formatWorkflowResult("worker-status", value, "json");
  assert.doesNotMatch(json, /DO-NOT-LEAK|\/private/);
});

test("oversized ordinary JSON output remains parseable with an explicit bounded envelope", () => {
  const formatted = formatWorkflowResult("result", {
    command: "result",
    runId: RUN_ID,
    status: "completed",
    result: { summary: "x".repeat(20_000) },
  }, "json");

  assert.ok(formatted.length <= 12_000);
  const parsed = JSON.parse(formatted);
  assert.equal(parsed.command, "result");
  assert.equal(parsed.runId, RUN_ID);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.truncated, true);
  assert.match(parsed.truncationMarker, /truncated/i);
});

test("result and reconcile compact output are bounded and machine JSON stays deterministic", () => {
  const result = formatWorkflowResult("result", {
    command: "result",
    runId: RUN_ID,
    status: "result-stale",
    state: "result-stale",
    resultCommand: `workflow result ${RUN_ID}`,
    reconcileCommand: `workflow reconcile --run ${RUN_ID}`,
    errors: ["Git fingerprint differs from current worktree state"],
  }, "compact");
  assert.match(result, new RegExp(`Run: ${RUN_ID}`));
  assert.match(result, /Status: result-stale/);
  assert.match(result, /Reconcile: workflow reconcile --run/);

  const reconcile = formatWorkflowResult("reconcile", {
    z: 1,
    command: "reconcile",
    runId: RUN_ID,
    status: "pending",
    nextActions: [`workflow result ${RUN_ID}`, "workflow status ocr A-1"],
  }, "compact");
  assert.match(reconcile, /Next actions:/);
  assert.match(reconcile, /workflow result/);
  assert.ok(reconcile.length <= 12000);

  assert.equal(
    formatWorkflowResult("reconcile", { z: 1, a: { y: 2, x: 1 } }, "json"),
    '{\n  "a": {\n    "x": 1,\n    "y": 2\n  },\n  "z": 1\n}',
  );
});

test("reconcile compact output has no Lock line when no lock field is present", () => {
  const compact = formatWorkflowResult("reconcile", {
    command: "reconcile",
    runId: RUN_ID,
    status: "pending",
    nextActions: [`workflow result ${RUN_ID}`],
  }, "compact");
  assert.doesNotMatch(compact, /^Lock:/m);
});

test("reconcile compact output renders the lock's verdict, age, and staleness for each ownership verdict -- this is the operator's default view, not just --format json", () => {
  const ownerGone = formatWorkflowResult("reconcile", {
    command: "reconcile",
    runId: RUN_ID,
    status: "pending",
    lock: {
      ageMs: 999999,
      stale: true,
      ownership: {
        verdict: "owner-gone",
        reason: "the owner process is proven gone: no matching process exists",
        pid: "9090",
        startedAt: "2026-07-29T09:00:00.000Z",
        removable: true,
      },
    },
    nextActions: [`workflow result ${RUN_ID}`, `workflow unlock ${RUN_ID} --yes`],
  }, "compact");
  assert.match(ownerGone, /^Lock: owner-gone \| age 999999ms \| stale: yes \| the owner process is proven gone: no matching process exists$/m);

  const ownerAlive = formatWorkflowResult("reconcile", {
    command: "reconcile",
    runId: RUN_ID,
    status: "pending",
    lock: {
      ageMs: 1200,
      stale: false,
      ownership: {
        verdict: "owner-alive",
        reason: "the owner process is still running with a matching start time",
        pid: "4242",
        startedAt: "2026-07-29T10:00:00.000Z",
        removable: false,
      },
    },
    nextActions: [`workflow result ${RUN_ID}`],
  }, "compact");
  assert.match(ownerAlive, /^Lock: owner-alive \| age 1200ms \| stale: no \| the owner process is still running with a matching start time$/m);

  const unprovable = formatWorkflowResult("reconcile", {
    command: "reconcile",
    runId: RUN_ID,
    status: "pending",
    lock: {
      ageMs: 45000,
      stale: false,
      ownership: {
        verdict: "unprovable",
        reason: "owner liveness could not be verified because process inspection failed",
        pid: "9090",
        startedAt: "2026-07-29T09:00:00.000Z",
        removable: false,
      },
    },
    nextActions: [`workflow result ${RUN_ID}`],
  }, "compact");
  assert.match(unprovable, /^Lock: unprovable \| age 45000ms \| stale: no \| owner liveness could not be verified because process inspection failed$/m);

  // The unlock suggestion only ever appears in nextActions (reconcileCommand's own job); the
  // Lock line itself never renders a suggested command, only the verdict it was computed from.
  assert.match(ownerGone, new RegExp(`workflow unlock ${RUN_ID} --yes`));
  assert.doesNotMatch(ownerAlive, /workflow unlock/);
});

test("resume and close compact output render a short human line; JSON output is untouched", () => {
  const focusResume = formatWorkflowResult("resume", {
    command: "resume",
    runId: RUN_ID,
    action: "focus",
    identity: { paneId: "pane-1" },
  }, "compact");
  assert.match(focusResume, new RegExp(`Run: ${RUN_ID}`));
  assert.match(focusResume, /resume: focus/);

  const refuseResume = formatWorkflowResult("resume", {
    command: "resume",
    runId: RUN_ID,
    action: "refuse",
    reason: "dead",
  }, "compact");
  assert.match(refuseResume, /resume: refuse/);
  assert.match(refuseResume, /Reason: dead/);

  const closedResult = formatWorkflowResult("close", {
    command: "close",
    runId: RUN_ID,
    closed: true,
  }, "compact");
  assert.match(closedResult, new RegExp(`Run: ${RUN_ID}`));
  assert.match(closedResult, /close: closed/);
  assert.doesNotMatch(closedResult, /close: closed \S/);

  const refusedResult = formatWorkflowResult("close", {
    command: "close",
    runId: RUN_ID,
    closed: false,
    reason: "working",
  }, "compact");
  assert.match(refusedResult, /close: refused working/);

  const resumeValue = { command: "resume", runId: RUN_ID, action: "relaunch", identity: { paneId: "pane-9" } };
  assert.deepEqual(JSON.parse(formatWorkflowResult("resume", resumeValue, "json")), resumeValue);

  const closeValue = { command: "close", runId: RUN_ID, closed: false, reason: "identity-unconfirmed" };
  assert.deepEqual(JSON.parse(formatWorkflowResult("close", closeValue, "json")), closeValue);
});

// --- formatRuns (roadmap item 2.1's compact board) -------------------------------------------
//
// Real records only ever carry projectAlias/primaryTicket/harness/id/state/updatedAt/directory
// (`directory` is attached by run-store.js's own `attachDirectory`, not persisted -- see
// docs/run-record-fields.md) -- no `worktree` field exists, so every fixture below that stands
// in for "leaks a path" carries `repositories`/`directory`/`runDirectory` deliberately, the way a
// real record does, and every test asserting no leak checks against those exact values.

const NOW = "2026-08-04T12:00:00.000Z";
const fixedNow = () => Date.parse(NOW);

function runRecord(overrides = {}) {
  const id = overrides.id ?? "11111111-1111-4111-8111-111111111111";
  return {
    id,
    state: "running",
    projectAlias: "ocr",
    primaryTicket: "A-1",
    harness: "pi",
    updatedAt: "2026-08-04T10:00:00.000Z", // exactly 2h before NOW
    repositories: [{ id: "backend", path: "/worktrees/ocr/A-1/backend", branch: "feature/A-1" }],
    directory: `/state/workflow/${id}`,
    runDirectory: `/state/workflow/${id}`,
    ...overrides,
  };
}

test("formatRuns renders a populated board with each run on one line, its columns, and no worktree path", () => {
  const value = {
    command: "runs",
    runs: [
      runRecord(),
      runRecord({
        id: "22222222-2222-4222-8222-222222222222",
        state: "blocked",
        projectAlias: "acme",
        primaryTicket: "B-2",
        harness: "codex",
        updatedAt: "2026-08-04T11:59:30.000Z", // 30s before NOW
        repositories: [{ id: "panel", path: "/worktrees/acme/B-2/panel", branch: "feature/B-2" }],
        runDirectory: "/state/workflow/22222222-2222-4222-8222-222222222222",
      }),
    ],
    skipped: [],
    exitCode: 0,
  };

  const compact = formatRuns(value, { now: fixedNow });
  const lines = compact.split("\n");

  assert.equal(lines.length, 3, "one header line plus one line per run, nothing else");
  assert.match(lines[0], /^RUN\s+\|\s+STATE\s+\|\s+PROJECT\s+\|\s+TICKET\s+\|\s+HARNESS\s+\|\s+UPDATED$/);
  assert.match(lines[1], /^11111111\s+\|\s+running\s+\|\s+ocr\s+\|\s+A-1\s+\|\s+pi\s+\|\s+2h ago$/);
  assert.match(lines[2], /^22222222\s+\|\s+blocked\s+\|\s+acme\s+\|\s+B-2\s+\|\s+codex\s+\|\s+just now$/);

  assert.doesNotMatch(compact, /\/worktrees\//);
  assert.doesNotMatch(compact, /\/state\/workflow\//);
  assert.doesNotMatch(compact, /repositories/i);
});

test("an empty board says so rather than printing nothing", () => {
  const compact = formatRuns({ command: "runs", runs: [], skipped: [], exitCode: 0 }, { now: fixedNow });
  assert.equal(compact, "Runs: none");

  const dispatched = formatWorkflowResult("runs", { command: "runs", runs: [], skipped: [], exitCode: 0 }, "compact");
  assert.equal(dispatched, "Runs: none");
});

test("skipped records are named under the table with a count and their ids, never swallowed", () => {
  const skipped = [
    { runId: "99999999-9999-4999-8999-999999999999", directory: "/state/workflow/99999999-9999-4999-8999-999999999999", message: "malformed run.json" },
    { runId: "88888888-8888-4888-8888-888888888888", directory: "/state/workflow/88888888-8888-4888-8888-888888888888", message: "malformed run.json" },
  ];

  const emptyBoard = formatRuns({ command: "runs", runs: [], skipped }, { now: fixedNow });
  assert.equal(emptyBoard, [
    "Runs: none",
    "Skipped: 2 (99999999-9999-4999-8999-999999999999, 88888888-8888-4888-8888-888888888888)",
  ].join("\n"));

  const populatedBoard = formatRuns({ command: "runs", runs: [runRecord()], skipped }, { now: fixedNow });
  assert.match(populatedBoard, /Skipped: 2 \(99999999-9999-4999-8999-999999999999, 88888888-8888-4888-8888-888888888888\)$/);
  // The skip footer follows the table directly; it never removes the readable run above it.
  assert.match(populatedBoard, /^11111111\s+\|\s+running/m);
});

test("column alignment survives a long project alias and a long ticket without breaking other columns or truncating either", () => {
  const value = {
    command: "runs",
    runs: [
      runRecord(),
      runRecord({
        id: "33333333-3333-4333-8333-333333333333",
        state: "needs-input",
        projectAlias: "a-very-long-project-alias-that-stretches-the-column",
        primaryTicket: "SHARY-1234567890-extra-long-ticket-identifier",
        harness: "claude",
        updatedAt: "2026-08-04T11:00:00.000Z",
      }),
    ],
    skipped: [],
  };

  const compact = formatRuns(value, { now: fixedNow });
  const lines = compact.split("\n");
  assert.equal(lines.length, 3);

  // Every column before the last (UPDATED, which is never padded past its own content) must
  // occupy the identical character span on every line -- header included -- regardless of how
  // long one row's project alias or ticket is. A misaligned line would report a different total
  // length for its first five padded cells.
  const leadingSpan = (line) => line.split(" | ").slice(0, 5).reduce((total, cell) => total + cell.length + 3, 0);
  const spans = lines.map(leadingSpan);
  assert.equal(new Set(spans).size, 1, `expected identical column spans, got ${JSON.stringify(spans)}`);

  assert.match(compact, /a-very-long-project-alias-that-stretches-the-column/);
  assert.match(compact, /SHARY-1234567890-extra-long-ticket-identifier/);
});

test("the widest realistic board line stays within 100 columns", () => {
  const value = {
    command: "runs",
    runs: [
      runRecord({
        id: "44444444-4444-4444-8444-444444444444",
        state: "manual-handoff-required", // longest real state (run-state.js), 23 chars
        projectAlias: "workflows-control-plane", // realistic long alias, 24 chars
        primaryTicket: "CTRLPLANE-45231", // realistic long ticket, 15 chars
        harness: "opencode", // longest real harness (harnesses.js), 8 chars
        updatedAt: "2026-07-23T12:00:00.000Z", // 12 days before NOW
      }),
    ],
    skipped: [],
  };

  const compact = formatRuns(value, { now: fixedNow });
  const widest = Math.max(...compact.split("\n").map((line) => line.length));
  assert.ok(widest <= 100, `widest line was ${widest} columns`);
});

test("formatWorkflowResult dispatches \"runs\" to the compact board", () => {
  const value = { command: "runs", runs: [runRecord()], skipped: [], exitCode: 0 };
  const compact = formatWorkflowResult("runs", value, "compact");
  assert.match(compact, /^RUN\s+\|\s+STATE\s+\|\s+PROJECT\s+\|\s+TICKET\s+\|\s+HARNESS\s+\|\s+UPDATED$/m);
  assert.match(compact, /^11111111\s+\|\s+running\s+\|\s+ocr\s+\|\s+A-1\s+\|\s+pi\s+\|/m);
  assert.doesNotMatch(compact, /\/worktrees\//);
});

test("--format json for runs projects each run to its documented field list, including repositories, and drops the rest", () => {
  const value = {
    command: "runs",
    runs: [runRecord({
      // Fields a real record carries that the projection must NOT emit -- see runProjection's
      // own comment in format.js for why "machines get complete records" was the wrong call.
      stateHistory: [{ from: null, to: "running", at: "2026-08-04T09:00:00.000Z" }],
      request: { task: "A-1" },
      launchArgv: ["--foo", "bar"],
      telemetry: { workers: [] },
    })],
    skipped: [{ runId: "99999999-9999-4999-8999-999999999999", directory: "/x", message: "malformed run.json" }],
    exitCode: 0,
  };
  const json = formatWorkflowResult("runs", value, "json");
  const parsed = JSON.parse(json);

  assert.deepEqual(Object.keys(parsed.runs[0]).sort(), [
    "directory", "harness", "id", "primaryTicket", "projectAlias", "repositories", "state", "updatedAt",
  ]);
  assert.equal(parsed.runs[0].repositories[0].path, "/worktrees/ocr/A-1/backend");
  assert.equal(parsed.runs[0].id, "11111111-1111-4111-8111-111111111111");
  assert.equal(parsed.runs[0].directory, "/state/workflow/11111111-1111-4111-8111-111111111111");
  assert.equal(parsed.runs[0].state, "running");
  assert.equal(parsed.runs[0].projectAlias, "ocr");
  assert.equal(parsed.runs[0].primaryTicket, "A-1");
  assert.equal(parsed.runs[0].harness, "pi");
  assert.equal(parsed.runs[0].updatedAt, "2026-08-04T10:00:00.000Z");
  assert.equal(parsed.runs[0].stateHistory, undefined);
  assert.equal(parsed.runs[0].request, undefined);
  assert.equal(parsed.runs[0].launchArgv, undefined);
  assert.equal(parsed.runs[0].telemetry, undefined);

  assert.equal(parsed.skipped[0].runId, "99999999-9999-4999-8999-999999999999");
  assert.equal(parsed.command, "runs");
});

// The regression this projection exists to fix: a board-scale `--format json` call must not just
// be *valid JSON* -- a truncated `{command, truncated, truncationMarker}` fallback is valid JSON
// too, and was exactly what shipped before this fix (see runProjection's comment in format.js for
// the measured numbers: 53,791 characters for 8 real runs against a 12,000-character shared
// OUTPUT_LIMIT). So this asserts both halves: the output stays comfortably under the limit AND
// every run's identifying data actually made it through -- a test asserting only "it parses as
// JSON" would have passed against the broken version too (the truncation fallback is valid JSON).
test("--format json for runs stays well under OUTPUT_LIMIT and still carries every run's data at realistic board scale", () => {
  // Mirrors what a real run record actually weighs (measured against this developer's real
  // records: ~5.3 KB/record, 44 fields -- stateHistory, telemetry, launchOperations, launchArgv,
  // request, digests, delegations, ...). Every one of these extra fields must be dropped by the
  // projection for this test to be meaningful; a fixture built only from the projected fields
  // would pass even with no fix at all.
  //
  // Corrected (branch review): this fixture used to inherit runRecord()'s single 26-character
  // repository path, so its bulk sat entirely in the fields the projection strips, and its
  // projected size (466 chars/run, measured) came out at roughly half a real three-repo run's
  // (949 chars/run per the review's standalone-vs-in-array remeasurement) -- overstating real
  // headroom by about 2x and feeding a wrong "high teens to twenties" estimate into ROADMAP.md
  // and the design spec. Real records skew three-repo (6 of the developer's 8), each entry a
  // `{id, path, branch}` under one shared Herdr worktree root, e.g.
  // `/home/<user>/.herdr/worktrees/<project>/<ticket>-<slug>/repos/<repo>`. This fixture now
  // matches that shape and depth instead of a single short path.
  function heavyRunRecord(index) {
    const worktreeRoot = `/home/user/.herdr/worktrees/ocr/A-${index}-some-feature-slug/repos`;
    return {
      ...runRecord({
        id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
        primaryTicket: `TICKET-${index}`,
        updatedAt: "2026-08-04T09:00:00.000Z",
        repositories: [
          { id: "backend", path: `${worktreeRoot}/backend`, branch: `feature/A-${index}` },
          { id: "panel", path: `${worktreeRoot}/panel`, branch: `feature/A-${index}` },
          { id: "webapp", path: `${worktreeRoot}/webapp`, branch: `feature/A-${index}` },
        ],
      }),
      stateHistory: Array.from({ length: 12 }, (_, i) => ({ from: `state-${i}`, to: `state-${i + 1}`, at: "2026-08-01T00:00:00.000Z" })),
      telemetry: { workers: Array.from({ length: 6 }, (_, i) => ({ id: `worker-${i}`, status: "idle", detail: "x".repeat(120) })) },
      launchOperations: Array.from({ length: 8 }, (_, i) => ({ step: `op-${i}`, status: "completed", detail: "y".repeat(120) })),
      launchArgv: Array.from({ length: 40 }, (_, i) => `--flag-${i}=value-${i}`),
      request: { body: "z".repeat(2000) },
      delegations: Object.fromEntries(Array.from({ length: 4 }, (_, i) => (
        [`delegation-${i}`, { status: "completed", evidence: "w".repeat(300) }]
      ))),
      assignmentDigest: `sha256:${"a".repeat(64)}`,
      approvalDigest: `sha256:${"b".repeat(64)}`,
    };
  }

  // 12: 50% growth over the 8 real runs that broke this in production, not "double" -- measured
  // (this test file, driving formatWorkflowResult directly) against this corrected fixture: 14
  // heavy three-repo runs is the last count that still fits (11,833 characters, 98.6% of budget);
  // 15 collapses. 12 keeps real margin against that boundary while still proving the fix holds up
  // past today's exact count, not just at it -- runs accumulate forever (no cleanup until item
  // 2.5). See ROADMAP.md's 2.1 closeout and the design spec's correction paragraph for the
  // corrected "roughly 12-14 runs" headroom figure this measurement produced.
  const RUN_COUNT = 12;
  const runs = Array.from({ length: RUN_COUNT }, (_, index) => heavyRunRecord(index));
  const value = { command: "runs", runs, skipped: [], exitCode: 0 };

  // Sanity check on the fixture itself: without the projection, this many full heavy records
  // must actually exceed OUTPUT_LIMIT -- otherwise this test wouldn't be exercising the failure
  // mode at all, the same trap a "just assert valid JSON" test would fall into.
  const unprojectedLength = JSON.stringify(value, null, 2).length;
  assert.ok(unprojectedLength > 12000, `fixture is too small to prove anything: ${RUN_COUNT} unprojected heavy runs were only ${unprojectedLength} characters, not over OUTPUT_LIMIT`);

  const json = formatWorkflowResult("runs", value, "json");
  // 90%, not the old 75%: measured real headroom is finite (the fixture collapses at 15), so a
  // margin promise has to fit inside that boundary, not assume generous slack that doesn't exist.
  assert.ok(json.length < 12000 * 0.9, `projected JSON for ${RUN_COUNT} heavy runs was ${json.length} characters, expected comfortably under 90% of OUTPUT_LIMIT`);

  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, undefined, "the projection must fit without ever engaging the truncation fallback");
  assert.equal(parsed.runs.length, RUN_COUNT);
  assert.deepEqual(parsed.runs.map((run) => run.primaryTicket).sort(), runs.map((run) => run.primaryTicket).sort());
  for (const run of parsed.runs) {
    assert.equal(run.stateHistory, undefined);
    assert.equal(run.telemetry, undefined);
    assert.equal(run.launchOperations, undefined);
    assert.equal(run.launchArgv, undefined);
    assert.equal(run.request, undefined);
    assert.equal(run.delegations, undefined);
  }
});

// Finding 3 (branch review): at realistic board scale (see the test above), `--format json` can
// still collapse -- and the general boundedJson fallback (built for single-record commands like
// `result`/`reconcile`, which always have a runId to fall back to) was never right for `runs`: it
// has neither `runId` nor `status`, so the fallback degraded to `{command, truncated,
// truncationMarker}` with no `runs` key at all -- absent, not empty. `result.runs.length` throws;
// `result.runs?.length ?? 0` silently reports "no runs", the opposite of "the board overflowed".
// No test covered this path for `runs` before this fix. This one forces the collapse directly
// (many heavy runs, well past any board-scale count) and asserts the corrected shape: `runs`
// present as `[]`, a `runCount` and `runIds` a consumer can act on one run at a time, a
// `skippedCount` so a collapse does not also erase 0.3's crash-residue visibility, and a
// truncationMarker that names the actual constraint (no --limit) instead of advice that doesn't
// apply to this command.
test("--format json for runs names the overflow instead of silently dropping run data", () => {
  function overflowRunRecord(index) {
    return {
      id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      state: "running",
      projectAlias: "ocr",
      primaryTicket: `TICKET-${index}`,
      harness: "pi",
      updatedAt: "2026-08-04T09:00:00.000Z",
      directory: `/state/workflow/${index}`,
      repositories: Array.from({ length: 3 }, (_, i) => ({
        id: `repo-${i}`,
        path: `/home/user/.herdr/worktrees/ocr/A-${index}-some-feature-slug/repos/repo-${i}`,
        branch: `feature/A-${index}`,
      })),
    };
  }

  const RUN_COUNT = 40; // well past the ~14-run realistic-scale boundary measured above
  const runs = Array.from({ length: RUN_COUNT }, (_, index) => overflowRunRecord(index));
  const skipped = [
    { runId: "99999999-9999-4999-8999-999999999999", directory: "/state/workflow/broken", message: "malformed run.json" },
  ];
  const value = { command: "runs", runs, skipped, exitCode: 0 };

  const json = formatWorkflowResult("runs", value, "json");
  const parsed = JSON.parse(json);

  assert.equal(parsed.command, "runs");
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.runs, [], "runs stays a present empty array, never absent -- absent is indistinguishable from a genuinely empty board");
  assert.equal(parsed.runCount, RUN_COUNT);
  assert.equal(parsed.skippedCount, 1, "collapsing must not also erase 0.3's crash-residue visibility");
  assert.deepEqual(
    parsed.runIds.slice().sort(),
    runs.map((run) => run.id).sort(),
    "every dropped run's full id survives -- not shortRunId's 8-character display slice, which workflow result does not accept",
  );
  assert.doesNotMatch(parsed.truncationMarker, /rerun with a narrower result query/, "the single-record fallback's advice does not apply to a command with no --limit");
  assert.match(parsed.truncationMarker, /--limit/);
  assert.match(parsed.truncationMarker, /--state/);
  assert.match(parsed.truncationMarker, /workflow result/);
});

// --- formatInbox (roadmap item 2.2's compact view) ------------------------------------------
//
// inboxCommand's own entry shape (commands.js's inboxEntry): {runId, projectAlias, primaryTicket,
// harness, paneId}, plus a `reason` string on unresolved entries. Built directly here rather than
// through a shared fixture helper -- the two lists differ by exactly the `reason` field, and both
// are small enough that spelling them out is clearer than a builder with a `withReason` flag.

function blockedEntry(overrides = {}) {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    projectAlias: "ocr",
    primaryTicket: "A-1",
    harness: "pi",
    paneId: "w1:p1",
    ...overrides,
  };
}

function unresolvedEntry(overrides = {}) {
  return {
    ...blockedEntry(),
    reason: "No live Herdr agent found for pane w1:p1",
    ...overrides,
  };
}

test("formatInbox renders a populated inbox with one line per blocked run, its columns, and no leaked reason text", () => {
  const value = {
    command: "inbox",
    blocked: [
      blockedEntry(),
      blockedEntry({
        runId: "22222222-2222-4222-8222-222222222222",
        projectAlias: "acme",
        primaryTicket: "B-2",
        harness: "codex",
        paneId: "w2:p9",
      }),
    ],
    unresolved: [],
    herdrAvailable: true,
    skipped: [],
    exitCode: 0,
  };

  const compact = formatInbox(value);
  const lines = compact.split("\n");

  assert.equal(lines.length, 3, "one header line plus one line per blocked run, nothing else");
  assert.match(lines[0], /^RUN\s+\|\s+PROJECT\s+\|\s+TICKET\s+\|\s+HARNESS\s+\|\s+PANE$/);
  assert.match(lines[1], /^11111111\s+\|\s+ocr\s+\|\s+A-1\s+\|\s+pi\s+\|\s+w1:p1$/);
  assert.match(lines[2], /^22222222\s+\|\s+acme\s+\|\s+B-2\s+\|\s+codex\s+\|\s+w2:p9$/);
});

test("an empty inbox says nothing is waiting rather than printing nothing", () => {
  const value = { command: "inbox", blocked: [], unresolved: [], herdrAvailable: true, skipped: [], exitCode: 0 };
  assert.equal(formatInbox(value), "Nothing waiting on you");
  assert.equal(formatWorkflowResult("inbox", value, "compact"), "Nothing waiting on you");
});

test("unresolved entries are named underneath with their reasons, and an all-unresolved inbox does not falsely claim nothing is waiting", () => {
  const value = {
    command: "inbox",
    blocked: [],
    unresolved: [
      unresolvedEntry(),
      unresolvedEntry({
        runId: "33333333-3333-4333-8333-333333333333",
        projectAlias: "acme",
        primaryTicket: "B-3",
        harness: "claude",
        paneId: null,
        reason: "Run has no pane id recorded",
      }),
    ],
    herdrAvailable: true,
    skipped: [],
    exitCode: 0,
  };

  const compact = formatInbox(value);
  assert.equal(compact, [
    "Blocked: none",
    "Unresolved:",
    "11111111 | ocr/A-1 | pi | No live Herdr agent found for pane w1:p1",
    "33333333 | acme/B-3 | claude | Run has no pane id recorded",
  ].join("\n"));
  assert.doesNotMatch(compact, /Nothing waiting on you/, "some runs' status is unknown, not confirmed clear -- reassurance here would be a lie");
});

test("unresolved entries appear underneath a populated blocked table, not instead of it", () => {
  const value = {
    command: "inbox",
    blocked: [blockedEntry()],
    unresolved: [unresolvedEntry({
      runId: "44444444-4444-4444-8444-444444444444",
      primaryTicket: "A-4",
      reason: "Herdr is unavailable",
    })],
    herdrAvailable: false,
    skipped: [],
    exitCode: 0,
  };

  const compact = formatInbox(value);
  assert.match(compact, /^RUN\s+\|\s+PROJECT/m);
  assert.match(compact, /^11111111\s+\|\s+ocr\s+\|\s+A-1/m);
  assert.match(compact, /^Unresolved:$/m);
  assert.match(compact, /^44444444 \| ocr\/A-4 \| pi \| Herdr is unavailable$/m);
});

test("skipped records are named under the inbox the same way runs reports them", () => {
  const skipped = [
    { runId: "99999999-9999-4999-8999-999999999999", directory: "/state/workflow/99999999-9999-4999-8999-999999999999", message: "malformed run.json" },
  ];

  const emptyInbox = formatInbox({ command: "inbox", blocked: [], unresolved: [], skipped, exitCode: 0 });
  assert.equal(emptyInbox, [
    "Nothing waiting on you",
    "Skipped: 1 (99999999-9999-4999-8999-999999999999)",
  ].join("\n"));

  const populatedInbox = formatInbox({ command: "inbox", blocked: [blockedEntry()], unresolved: [], skipped, exitCode: 0 });
  assert.match(populatedInbox, /Skipped: 1 \(99999999-9999-4999-8999-999999999999\)$/);
  assert.match(populatedInbox, /^11111111\s+\|\s+ocr/m);
});

test("formatWorkflowResult dispatches \"inbox\" to the compact view", () => {
  const value = { command: "inbox", blocked: [blockedEntry()], unresolved: [], herdrAvailable: true, skipped: [], exitCode: 0 };
  const compact = formatWorkflowResult("inbox", value, "compact");
  assert.match(compact, /^RUN\s+\|\s+PROJECT\s+\|\s+TICKET\s+\|\s+HARNESS\s+\|\s+PANE$/m);
  assert.match(compact, /^11111111\s+\|\s+ocr\s+\|\s+A-1\s+\|\s+pi\s+\|\s+w1:p1$/m);
});

test("--format json for inbox carries blocked, unresolved, herdrAvailable, and skipped unchanged", () => {
  const value = {
    command: "inbox",
    blocked: [blockedEntry()],
    unresolved: [unresolvedEntry({ runId: "55555555-5555-4555-8555-555555555555", reason: "Herdr is unavailable" })],
    herdrAvailable: false,
    skipped: [{ runId: "99999999-9999-4999-8999-999999999999", directory: "/x", message: "malformed run.json" }],
    exitCode: 0,
  };

  const parsed = JSON.parse(formatWorkflowResult("inbox", value, "json"));
  assert.equal(parsed.command, "inbox");
  assert.equal(parsed.herdrAvailable, false);
  assert.deepEqual(parsed.blocked, value.blocked);
  assert.deepEqual(parsed.unresolved, value.unresolved);
  assert.equal(parsed.skipped[0].runId, "99999999-9999-4999-8999-999999999999");
});

// This command's entries carry only {runId, projectAlias, primaryTicket, harness, paneId[,
// reason]} -- no repositories, no telemetry, none of the ~44 fields runProjection's own comment
// names -- so there is no separate projection step to prove correct. What still needs proving,
// the same way runProjection's own headroom test proved it for `runs`: this stays comfortably
// under OUTPUT_LIMIT at a scale an operator could plausibly reach (several projects each with a
// handful of concurrently open runs), not just at the 1-2 entry scale a hand-written test would
// otherwise exercise -- a test asserting only "it is valid JSON" would have passed against a
// truncation fallback carrying zero entries too (see the overflow test below for that failure
// mode measured directly).
test("--format json for inbox stays well under OUTPUT_LIMIT at a realistic combined count and still carries every entry's data", () => {
  function realisticEntry(index, extra = {}) {
    return {
      runId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      projectAlias: "workflows-control-plane", // realistic long alias, matches runs' own headroom fixture
      primaryTicket: `CTRLPLANE-${45000 + index}`,
      harness: "opencode", // longest real harness
      paneId: `w${index}:pane-${index}-abcdefgh`,
      ...extra,
    };
  }

  // 20 combined entries: several projects each with several concurrently open runs -- generous
  // for a single operator's live workload, well short of the ~44-entry point measured (via this
  // same JSON.stringify) to first cross OUTPUT_LIMIT at this fixture's field lengths.
  const ENTRY_COUNT = 20;
  const blocked = Array.from({ length: ENTRY_COUNT / 2 }, (_, index) => realisticEntry(index));
  const unresolved = Array.from({ length: ENTRY_COUNT / 2 }, (_, index) => realisticEntry(index + 1000, {
    reason: `No live Herdr agent found for pane w${index + 1000}:pane-${index + 1000}-abcdefgh`,
  }));
  const value = { command: "inbox", blocked, unresolved, herdrAvailable: true, skipped: [], exitCode: 0 };

  const json = formatWorkflowResult("inbox", value, "json");
  assert.ok(json.length < 12000 * 0.75, `realistic-scale inbox JSON was ${json.length} characters, expected comfortably under 75% of OUTPUT_LIMIT`);

  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, undefined, "realistic scale must not engage the truncation fallback");
  assert.equal(parsed.blocked.length, ENTRY_COUNT / 2);
  assert.equal(parsed.unresolved.length, ENTRY_COUNT / 2);
  assert.deepEqual(parsed.blocked.map((entry) => entry.runId).sort(), blocked.map((entry) => entry.runId).sort());
  assert.deepEqual(parsed.unresolved.map((entry) => entry.runId).sort(), unresolved.map((entry) => entry.runId).sort());
});

// The regression this guards against is the same one `runs` shipped and then fixed: the general
// boundedJson fallback (`{command, runId?, status?, truncated, truncationMarker}`) was built for
// single-record commands and `inbox` has neither `runId` nor `status`, so without a dedicated
// fallback this collapses to `{command, truncated, truncationMarker}` -- `blocked`/`unresolved`
// absent, not empty, and a consumer reading `result.blocked?.length ?? 0` silently reports "no
// blocked workers" on the one command whose entire job is to not miss that. Forces the collapse
// directly (well past the ~44-entry point measured above) and asserts the corrected shape.
test("--format json for inbox names the overflow instead of silently dropping blocked/unresolved data", () => {
  function overflowEntry(index, extra = {}) {
    return {
      runId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      projectAlias: "workflows-control-plane",
      primaryTicket: `CTRLPLANE-${45000 + index}`,
      harness: "opencode",
      paneId: `w${index}:pane-${index}-abcdefgh`,
      ...extra,
    };
  }

  const ENTRY_COUNT = 80; // well past the ~44-entry realistic-scale boundary measured above
  const blocked = Array.from({ length: ENTRY_COUNT / 2 }, (_, index) => overflowEntry(index));
  const unresolved = Array.from({ length: ENTRY_COUNT / 2 }, (_, index) => overflowEntry(index + 1000, {
    reason: `No live Herdr agent found for pane w${index + 1000}:pane-${index + 1000}-abcdefgh`,
  }));
  const skipped = [{ runId: "99999999-9999-4999-8999-999999999999", directory: "/state/workflow/broken", message: "malformed run.json" }];
  const value = { command: "inbox", blocked, unresolved, herdrAvailable: true, skipped, exitCode: 0 };

  // Sanity check on the fixture itself, the same discipline runs's own overflow test applies.
  const unboundedLength = JSON.stringify(value, null, 2).length;
  assert.ok(unboundedLength > 12000, `fixture is too small to prove anything: ${ENTRY_COUNT} entries were only ${unboundedLength} characters, not over OUTPUT_LIMIT`);

  const json = formatWorkflowResult("inbox", value, "json");
  const parsed = JSON.parse(json);

  assert.equal(parsed.command, "inbox");
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.blocked, [], "blocked stays a present empty array, never absent -- absent is indistinguishable from a genuinely empty inbox");
  assert.deepEqual(parsed.unresolved, [], "unresolved stays present too, for the same reason");
  assert.equal(parsed.blockedCount, ENTRY_COUNT / 2);
  assert.equal(parsed.unresolvedCount, ENTRY_COUNT / 2);
  assert.equal(parsed.skippedCount, 1, "collapsing must not also erase 0.3's crash-residue visibility");
  assert.deepEqual(parsed.blockedRunIds.slice().sort(), blocked.map((entry) => entry.runId).sort());
  assert.deepEqual(parsed.unresolvedRunIds.slice().sort(), unresolved.map((entry) => entry.runId).sort());
  assert.doesNotMatch(parsed.truncationMarker, /rerun with a narrower result query/, "the single-record fallback's advice does not apply to a command with no --limit");
  assert.match(parsed.truncationMarker, /--project/);
  assert.match(parsed.truncationMarker, /workflow result/);
});
