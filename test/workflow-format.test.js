import assert from "node:assert/strict";
import { test } from "node:test";
import { formatInbox, formatRuns, formatVerify, formatWorkflowResult } from "../src/workflow/format.js";
// The display caps that actually ship, read from commands.js rather than copied here. The
// worst-case fixture below is built FROM them, so raising one there makes the size assertions
// in this file measure the payload that would really be emitted -- which is the whole point of
// the worst-case test, and was not true when the counts were hardcoded.
import { ARCHIVE_DISPLAY_LIMITS, MERGE_DISPLAY_LIMITS } from "../src/workflow/commands.js";

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

// Roadmap item 2.5's board change, and the same discipline the skip footer above established:
// residue this board chose not to show is NAMED underneath it, never silently dropped. Archived
// runs are excluded from `--all` (that is the relief item 2.1 named when it measured the 12-14 run
// JSON ceiling), and an operator has to be able to tell "there are no other runs" from "there are
// four you are not being shown".
test("archived runs hidden from the board are counted under the table, never silently dropped", () => {
  const withHidden = formatRuns({ command: "runs", runs: [runRecord()], skipped: [], archivedHidden: 4 }, { now: fixedNow });
  assert.match(withHidden, /^Archived: 4 hidden \(--state <state> still shows them\)$/m);
  assert.match(withHidden, /^11111111\s+\|\s+running/m, "the visible runs are untouched by the footer");

  // Nothing hidden means no footer at all: an unconditional "Archived: 0" would be noise on every
  // board this repo has ever printed.
  const nothingHidden = formatRuns({ command: "runs", runs: [runRecord()], skipped: [], archivedHidden: 0 }, { now: fixedNow });
  assert.doesNotMatch(nothingHidden, /Archived:/);
  assert.doesNotMatch(formatRuns({ command: "runs", runs: [runRecord()], skipped: [] }, { now: fixedNow }), /Archived:/);

  // An empty board whose emptiness is entirely archived runs must say so, or it reads as "you have
  // nothing", which is the opposite of the truth.
  const allHidden = formatRuns({ command: "runs", runs: [], skipped: [], archivedHidden: 3 }, { now: fixedNow });
  assert.equal(allHidden, ["Runs: none", "Archived: 3 hidden (--state <state> still shows them)"].join("\n"));
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
// inboxCommand's own entry shape (commands.js's inboxEntry): {runId, state, projectAlias,
// primaryTicket, harness, paneId}, plus a `reason` string on waiting/unresolved entries. Built
// directly here rather than through a shared fixture helper -- the three lists differ by exactly
// the `state`/`reason` fields, and all are small enough that spelling them out is clearer than a
// builder with flags for each variant.

function blockedEntry(overrides = {}) {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    state: "running",
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

// A `waiting` entry, unlike `unresolved`, carries a state that inherently awaits a human
// (manual-handoff-required, needs-input): its `reason` is the actionable framing
// `awaitsOperatorReason` builds in commands.js, not the vanished-pane diagnostic text.
function waitingEntry(overrides = {}) {
  return {
    ...blockedEntry(),
    state: "manual-handoff-required",
    reason: "Waiting on you (manual-handoff-required): run `workflow result 11111111-1111-4111-8111-111111111111`",
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

// --- formatInbox: the `waiting` bucket (branch review 3b) -----------------------------------
//
// Added after running `workflow inbox` against the developer's real state root: a run in
// manual-handoff-required/needs-input has no live pane by definition (its worker already exited),
// and reporting that under "Unresolved" read as a diagnostic about missing infrastructure rather
// than what it actually is -- the run doing exactly what that state means. See the design spec's
// correction paragraph.

test("an inbox with only waiting entries names them under their own header, not folded into unresolved, and does not falsely claim nothing is waiting", () => {
  const value = {
    command: "inbox",
    blocked: [],
    waiting: [waitingEntry()],
    unresolved: [],
    herdrAvailable: true,
    skipped: [],
    exitCode: 0,
  };

  const compact = formatInbox(value);
  assert.equal(compact, [
    "Blocked: none",
    "Waiting on you:",
    "11111111 | ocr/A-1 | pi | Waiting on you (manual-handoff-required): run `workflow result 11111111-1111-4111-8111-111111111111`",
  ].join("\n"));
  assert.doesNotMatch(compact, /Nothing waiting on you/, "a waiting run needs the operator just as much as a blocked one -- reassurance here would be a lie");
  assert.doesNotMatch(compact, /^Unresolved:/m, "nothing here is an unresolved diagnostic");
});

test("blocked, waiting, and unresolved all render together, in that order, when every bucket is non-empty", () => {
  const value = {
    command: "inbox",
    blocked: [blockedEntry()],
    waiting: [waitingEntry({
      runId: "22222222-2222-4222-8222-222222222222",
      projectAlias: "acme",
      primaryTicket: "B-2",
      state: "needs-input",
      reason: "Waiting on you (needs-input): run `workflow result 22222222-2222-4222-8222-222222222222`",
    })],
    unresolved: [unresolvedEntry({
      runId: "33333333-3333-4333-8333-333333333333",
      primaryTicket: "A-3",
      reason: "No live Herdr agent found for pane w1:p1",
    })],
    herdrAvailable: true,
    skipped: [],
    exitCode: 0,
  };

  const compact = formatInbox(value);
  const lines = compact.split("\n");

  // The blocked table comes first, then Waiting (actionable, names what to do), then Unresolved
  // (still an open question) -- see formatInbox's own comment for why that order, not alphabetical
  // or insertion order.
  assert.match(lines[0], /^RUN\s+\|\s+PROJECT/);
  assert.match(lines[1], /^11111111\s+\|\s+ocr\s+\|\s+A-1/);
  assert.equal(lines[2], "Waiting on you:");
  assert.match(lines[3], /^22222222 \| acme\/B-2 \| pi \| Waiting on you \(needs-input\)/);
  assert.equal(lines[4], "Unresolved:");
  assert.match(lines[5], /^33333333 \| ocr\/A-3 \| pi \| No live Herdr agent found for pane w1:p1$/);
  assert.equal(lines.length, 6);
});

test("a waiting reason names the state and workflow result, and does not repeat the vanished-pane diagnostic", () => {
  const value = {
    command: "inbox",
    blocked: [],
    waiting: [waitingEntry()],
    unresolved: [],
    herdrAvailable: true,
    skipped: [],
    exitCode: 0,
  };

  const compact = formatInbox(value);
  assert.match(compact, /manual-handoff-required/);
  assert.match(compact, /workflow result 11111111-1111-4111-8111-111111111111/);
  assert.doesNotMatch(compact, /No live Herdr agent found/, "waiting's whole point is not to lead with the vanished-pane diagnostic");
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

test("--format json for inbox carries blocked, waiting, unresolved, herdrAvailable, and skipped unchanged", () => {
  const value = {
    command: "inbox",
    blocked: [blockedEntry()],
    waiting: [waitingEntry({ runId: "66666666-6666-4666-8666-666666666666" })],
    unresolved: [unresolvedEntry({ runId: "55555555-5555-4555-8555-555555555555", reason: "Herdr is unavailable" })],
    herdrAvailable: false,
    skipped: [{ runId: "99999999-9999-4999-8999-999999999999", directory: "/x", message: "malformed run.json" }],
    exitCode: 0,
  };

  const parsed = JSON.parse(formatWorkflowResult("inbox", value, "json"));
  assert.equal(parsed.command, "inbox");
  assert.equal(parsed.herdrAvailable, false);
  assert.deepEqual(parsed.blocked, value.blocked);
  assert.deepEqual(parsed.waiting, value.waiting);
  assert.deepEqual(parsed.unresolved, value.unresolved);
  assert.equal(parsed.skipped[0].runId, "99999999-9999-4999-8999-999999999999");
});

// This command's entries carry only {runId, state, projectAlias, primaryTicket, harness,
// paneId[, reason]} -- no repositories, no telemetry, none of the ~44 fields runProjection's own
// comment names -- so there is no separate projection step to prove correct. What still needs
// proving, the same way runProjection's own headroom test proved it for `runs`: this stays
// comfortably under OUTPUT_LIMIT at a scale an operator could plausibly reach (several projects
// each with a handful of concurrently open runs, spread across all three buckets now that
// `waiting` exists), not just at the 1-2 entry scale a hand-written test would otherwise exercise
// -- a test asserting only "it is valid JSON" would have passed against a truncation fallback
// carrying zero entries too (see the overflow test below for that failure mode measured
// directly).
test("--format json for inbox stays well under OUTPUT_LIMIT at a realistic combined count and still carries every entry's data", () => {
  function realisticEntry(index, extra = {}) {
    return {
      runId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      state: "running",
      projectAlias: "workflows-control-plane", // realistic long alias, matches runs' own headroom fixture
      primaryTicket: `CTRLPLANE-${45000 + index}`,
      harness: "opencode", // longest real harness
      paneId: `w${index}:pane-${index}-abcdefgh`,
      ...extra,
    };
  }

  // 21 combined entries, 7 per bucket: several projects each with several concurrently open runs
  // -- generous for a single operator's live workload, well short of the n=37 point measured (via
  // this same formatWorkflowResult call, see format.js's inboxOverflowFallback comment for the
  // full re-measurement) to first cross OUTPUT_LIMIT for this three-way-split composition at this
  // fixture's field lengths.
  const PER_BUCKET = 7;
  const blocked = Array.from({ length: PER_BUCKET }, (_, index) => realisticEntry(index));
  const waiting = Array.from({ length: PER_BUCKET }, (_, index) => realisticEntry(index + 2000, {
    state: "manual-handoff-required",
    reason: `Waiting on you (manual-handoff-required): run \`workflow result ${String(index + 2000).padStart(8, "0")}-0000-4000-8000-000000000000\``,
  }));
  const unresolved = Array.from({ length: PER_BUCKET }, (_, index) => realisticEntry(index + 1000, {
    reason: `No live Herdr agent found for pane w${index + 1000}:pane-${index + 1000}-abcdefgh`,
  }));
  const value = { command: "inbox", blocked, waiting, unresolved, herdrAvailable: true, skipped: [], exitCode: 0 };

  const json = formatWorkflowResult("inbox", value, "json");
  assert.ok(json.length < 12000 * 0.75, `realistic-scale inbox JSON was ${json.length} characters, expected comfortably under 75% of OUTPUT_LIMIT`);

  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, undefined, "realistic scale must not engage the truncation fallback");
  assert.equal(parsed.blocked.length, PER_BUCKET);
  assert.equal(parsed.waiting.length, PER_BUCKET);
  assert.equal(parsed.unresolved.length, PER_BUCKET);
  assert.deepEqual(parsed.blocked.map((entry) => entry.runId).sort(), blocked.map((entry) => entry.runId).sort());
  assert.deepEqual(parsed.waiting.map((entry) => entry.runId).sort(), waiting.map((entry) => entry.runId).sort());
  assert.deepEqual(parsed.unresolved.map((entry) => entry.runId).sort(), unresolved.map((entry) => entry.runId).sort());
});

// The regression this guards against is the same one `runs` shipped and then fixed: the general
// boundedJson fallback (`{command, runId?, status?, truncated, truncationMarker}`) was built for
// single-record commands and `inbox` has neither `runId` nor `status`, so without a dedicated
// fallback this collapses to `{command, truncated, truncationMarker}` -- `blocked`/`unresolved`
// absent, not empty, and a consumer reading `result.blocked?.length ?? 0` silently reports "no
// blocked workers" on the one command whose entire job is to not miss that. Forces the collapse
// directly (well past the n=37 three-way-split crossing point measured above) and asserts the
// corrected shape.
test("--format json for inbox names the overflow instead of silently dropping blocked/waiting/unresolved data", () => {
  function overflowEntry(index, extra = {}) {
    return {
      runId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      state: "running",
      projectAlias: "workflows-control-plane",
      primaryTicket: `CTRLPLANE-${45000 + index}`,
      harness: "opencode",
      paneId: `w${index}:pane-${index}-abcdefgh`,
      ...extra,
    };
  }

  const ENTRY_COUNT = 81; // well past the n=37 three-way-split boundary measured above, 27 per bucket
  const PER_BUCKET = ENTRY_COUNT / 3;
  const blocked = Array.from({ length: PER_BUCKET }, (_, index) => overflowEntry(index));
  const waiting = Array.from({ length: PER_BUCKET }, (_, index) => overflowEntry(index + 2000, {
    state: "manual-handoff-required",
    reason: `Waiting on you (manual-handoff-required): run \`workflow result ${String(index + 2000).padStart(8, "0")}-0000-4000-8000-000000000000\``,
  }));
  const unresolved = Array.from({ length: PER_BUCKET }, (_, index) => overflowEntry(index + 1000, {
    reason: `No live Herdr agent found for pane w${index + 1000}:pane-${index + 1000}-abcdefgh`,
  }));
  const skipped = [{ runId: "99999999-9999-4999-8999-999999999999", directory: "/state/workflow/broken", message: "malformed run.json" }];
  const value = { command: "inbox", blocked, waiting, unresolved, herdrAvailable: true, skipped, exitCode: 0 };

  // Sanity check on the fixture itself, the same discipline runs's own overflow test applies.
  const unboundedLength = JSON.stringify(value, null, 2).length;
  assert.ok(unboundedLength > 12000, `fixture is too small to prove anything: ${ENTRY_COUNT} entries were only ${unboundedLength} characters, not over OUTPUT_LIMIT`);

  const json = formatWorkflowResult("inbox", value, "json");
  const parsed = JSON.parse(json);

  assert.equal(parsed.command, "inbox");
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.blocked, [], "blocked stays a present empty array, never absent -- absent is indistinguishable from a genuinely empty inbox");
  assert.deepEqual(parsed.waiting, [], "waiting stays present too, for the same reason");
  assert.deepEqual(parsed.unresolved, [], "unresolved stays present too, for the same reason");
  assert.equal(parsed.blockedCount, PER_BUCKET);
  assert.equal(parsed.waitingCount, PER_BUCKET);
  assert.equal(parsed.unresolvedCount, PER_BUCKET);
  assert.equal(parsed.skippedCount, 1, "collapsing must not also erase 0.3's crash-residue visibility");
  assert.deepEqual(parsed.blockedRunIds.slice().sort(), blocked.map((entry) => entry.runId).sort());
  assert.deepEqual(parsed.waitingRunIds.slice().sort(), waiting.map((entry) => entry.runId).sort());
  assert.deepEqual(parsed.unresolvedRunIds.slice().sort(), unresolved.map((entry) => entry.runId).sort());
  assert.doesNotMatch(parsed.truncationMarker, /rerun with a narrower result query/, "the single-record fallback's advice does not apply to a command with no --limit");
  assert.match(parsed.truncationMarker, /--project/);
  assert.match(parsed.truncationMarker, /workflow result/);
});

// --- formatVerify (roadmap item 2.3's `workflow verify`) -------------------------------------
//
// verifyCommand's own return shape (commands.js): `{command: "verify", runId, results, passed,
// exitCode}` on a real run; `{..., results: [], reason}` on a refusal, which appends nothing to
// the run's event log and must not be rendered as an empty (and therefore falsely reassuring)
// table.

function verifyResult(overrides = {}) {
  return {
    repositoryId: "backend",
    cwd: "/repo/acme/backend",
    command: "pnpm typecheck",
    status: "passed",
    exitCode: 0,
    output: "",
    truncated: false,
    durationMs: 1200,
    ...overrides,
  };
}

test("formatVerify renders a per-repository, per-command table, and a failure is visually distinguishable from a pass", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    passed: false,
    exitCode: 1,
    results: [
      verifyResult(),
      verifyResult({ repositoryId: "panel", cwd: "/repo/acme/panel", command: "pnpm test", status: "failed", exitCode: 1, durationMs: 340 }),
    ],
  };

  const compact = formatVerify(value);
  const lines = compact.split("\n");
  assert.match(lines[0], new RegExp(`Run: ${RUN_ID}`));
  assert.match(lines[1], /^Verify: failed$/);
  assert.match(lines[2], /^REPO\s+\|\s+COMMAND\s+\|\s+STATUS\s+\|\s+EXIT\s+\|\s+DURATION$/);
  assert.match(lines[3], /^backend\s+\|\s+pnpm typecheck\s+\|\s+passed\s+\|\s+0\s+\|\s+1200ms$/);
  assert.match(lines[4], /^panel\s+\|\s+pnpm test\s+\|\s+FAILED\s+\|\s+1\s+\|\s+340ms$/);
  assert.equal(lines.length, 5);

  const dispatched = formatWorkflowResult("verify", value, "compact");
  assert.equal(dispatched, compact);
});

test("formatVerify names a repository whose command errored or timed out underneath the table, not silently", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    passed: false,
    exitCode: 1,
    results: [
      verifyResult({ repositoryId: "gone", cwd: "/repo/acme/gone", status: "error", exitCode: null, reason: "cwd not found: /repo/acme/gone" }),
      verifyResult({ repositoryId: "backend", command: "pnpm test", status: "timed-out", exitCode: null, durationMs: 300000, reason: "timed out after 300000ms" }),
    ],
  };

  const compact = formatVerify(value);
  assert.match(compact, /^Reasons:$/m);
  assert.match(compact, /^gone \| pnpm typecheck \(cwd: \/repo\/acme\/gone\): cwd not found: \/repo\/acme\/gone$/m);
  assert.match(compact, /^backend \| pnpm test \(cwd: \/repo\/acme\/backend\): timed out after 300000ms$/m);
});

// M9 (branch review): a result with no usable cwd at all -- C1's own repro shape -- must still
// name that explicitly in the Reasons line rather than rendering an empty parenthetical.
test("formatVerify names an absent cwd explicitly in the Reasons line, not as an empty parenthetical", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    passed: false,
    exitCode: 1,
    results: [
      verifyResult({ repositoryId: "ocr", cwd: undefined, status: "error", exitCode: null, reason: "no repository path recorded" }),
    ],
  };

  const compact = formatVerify(value);
  assert.match(compact, /^ocr \| pnpm typecheck \(cwd: unknown\): no repository path recorded$/m);
});

// R3 (branch re-review): `truncated` used to have no compact-view rendering at all -- a result
// whose captured output was capped by verify-runner.js's own maxOutputBytes looked identical to
// one whose full output fit, in both the table (which never renders output) and the Reasons: line
// (which only ever fires for an error/timed-out result -- see appendVerifyReasons's own comment --
// so a *passing* result with truncated output, the common real case, had nothing point at it
// anywhere). Covers a truncated pass specifically, not just a truncated failure, since that is the
// shape the old code missed entirely.
test("formatVerify names a result whose captured output was truncated, even when the command itself passed", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    passed: true,
    exitCode: 0,
    results: [
      verifyResult({ truncated: true }),
      verifyResult({ repositoryId: "panel", command: "pnpm test", truncated: false }),
    ],
  };

  const compact = formatVerify(value);
  assert.match(compact, /^Truncated output:$/m);
  assert.match(compact, /^backend \| pnpm typecheck: captured output was truncated$/m);
  // The untruncated result must not be named here -- only the one whose output was actually capped.
  assert.doesNotMatch(compact, /^panel \| pnpm test: captured output was truncated$/m);
});

test("formatVerify says nothing about truncation when no result's output was capped", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    passed: true,
    exitCode: 0,
    results: [verifyResult()],
  };

  const compact = formatVerify(value);
  assert.doesNotMatch(compact, /Truncated output:/);
});

test("a refusal says why instead of rendering an empty table that would read as a pass", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    results: [],
    passed: false,
    exitCode: 10,
    reason: "Project ocr has no verify commands configured.",
  };

  const compact = formatVerify(value);
  assert.equal(compact, [
    `Run: ${RUN_ID}`,
    "Verify: refused — Project ocr has no verify commands configured.",
  ].join("\n"));
  assert.doesNotMatch(compact, /Verify: passed|Verify: failed|REPO\s+\|/);
});

test("formatWorkflowResult dispatches \"verify\" to the compact per-repository table", () => {
  const value = { command: "verify", runId: RUN_ID, passed: true, exitCode: 0, results: [verifyResult()] };
  const compact = formatWorkflowResult("verify", value, "compact");
  assert.match(compact, /^Verify: passed$/m);
  assert.match(compact, /^REPO\s+\|\s+COMMAND/m);
});

// I4 (branch review): a matrix that ran to completion but whose evidence could not be persisted
// (a held run lock, most commonly) must still show the operator the full table -- the whole point
// of the fix is that the work is not thrown away -- with the persistence failure named separately
// from the pass/fail verdict, not folded into it.
test("formatVerify renders the full table plus a separate note when the evidence could not be persisted", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    results: [verifyResult()],
    passed: true,
    exitCode: 0,
    evidenceError: "evidence could not be persisted: Run is locked by an active lock at /state/run.lock/active; age 0ms.",
  };

  const compact = formatVerify(value);
  assert.match(compact, /^Verify: passed$/m);
  assert.match(compact, /^REPO\s+\|\s+COMMAND/m);
  assert.match(compact, /^backend\s+\|\s+pnpm typecheck\s+\|\s+passed/m);
  assert.match(compact, /^Evidence: evidence could not be persisted: Run is locked by an active lock/m);

  const json = formatWorkflowResult("verify", value, "json");
  const parsed = JSON.parse(json);
  assert.match(parsed.evidenceError, /evidence could not be persisted/i);
  assert.equal(parsed.results.length, 1);
});

// --- formatResult's claim/proof split (roadmap item 2.3) -------------------------------------
//
// resultCommand's own new field, `verifiedEvidence`: `{verifiedAt, passed, exitCode, results}` or
// `null` when `workflow verify` has never successfully completed against this run (a refusal
// appends nothing, so "never run" and "always refused" are indistinguishable from the event log
// alone -- this renderer does not claim to know which).

function workerClaim() {
  return [
    { command: "pnpm typecheck", status: "passed", summary: "clean" },
    { command: "pnpm test", status: "passed", summary: "47 passed" },
  ];
}

test("formatResult renders the worker's claim and the recorded evidence as two labeled, unmerged sections", () => {
  const value = {
    command: "result",
    runId: RUN_ID,
    status: "completed",
    result: { status: "completed", summary: "Done", verification: workerClaim() },
    verifiedEvidence: {
      verifiedAt: "2026-08-04T12:00:00.000Z",
      passed: true,
      exitCode: 0,
      results: [
        verifyResult({ command: "pnpm typecheck" }),
        verifyResult({ command: "pnpm test", durationMs: 5000 }),
      ],
    },
  };

  const compact = formatWorkflowResult("result", value, "compact");
  assert.match(compact, /^Reported by the worker:$/m);
  assert.match(compact, /^- pnpm typecheck: passed — clean$/m);
  assert.match(compact, /^- pnpm test: passed — 47 passed$/m);
  assert.match(compact, /^Verified by workflow verify \(passed, ran 2026-08-04T12:00:00\.000Z\):$/m);
  assert.match(compact, /^REPO\s+\|\s+COMMAND\s+\|\s+STATUS/m);
  assert.match(compact, /^backend\s+\|\s+pnpm typecheck\s+\|\s+passed/m);
});

test("a claim with no recorded evidence says the evidence is missing, not nothing", () => {
  const value = {
    command: "result",
    runId: RUN_ID,
    status: "completed",
    result: { status: "completed", verification: workerClaim() },
    verifiedEvidence: null,
    verifyCommand: `workflow verify ${RUN_ID}`,
  };

  const compact = formatWorkflowResult("result", value, "compact");
  assert.match(compact, /^Reported by the worker:$/m);
  assert.match(compact, new RegExp(`^Verified by workflow verify: no recorded evidence \\(run \`workflow verify ${RUN_ID}\`\\)$`, "m"));
  assert.doesNotMatch(compact, /^Verified by workflow verify:\s*$/m, "must not read as an empty section with nothing to say");
});

test("no worker claim and no evidence still names both sections explicitly", () => {
  const value = { command: "result", runId: RUN_ID, status: "pending", verifiedEvidence: null };
  const compact = formatWorkflowResult("result", value, "compact");
  assert.match(compact, /^Reported by the worker: none$/m);
  assert.match(compact, /^Verified by workflow verify: no recorded evidence$/m);
});

test("a disagreement between the worker's claim and the recorded evidence is visible in both sections, with no computed verdict", () => {
  const value = {
    command: "result",
    runId: RUN_ID,
    status: "completed",
    result: {
      status: "completed",
      verification: [{ command: "pnpm test", status: "passed", summary: "all green" }],
    },
    verifiedEvidence: {
      verifiedAt: "2026-08-04T12:00:00.000Z",
      passed: false,
      exitCode: 1,
      results: [verifyResult({ command: "pnpm test", status: "failed", exitCode: 1, output: "1 failing" })],
    },
  };

  const compact = formatWorkflowResult("result", value, "compact");
  assert.match(compact, /^- pnpm test: passed — all green$/m);
  assert.match(compact, /^backend\s+\|\s+pnpm test\s+\|\s+FAILED\s+\|\s+1/m);

  // The disagreement is left for the operator to read, not computed or named by this renderer --
  // no "mismatch"/"disagreement"/"conflict" verdict word anywhere in the output.
  assert.doesNotMatch(compact, /mismatch|disagree|conflict|discrepanc/i);
});

// --- JSON size discipline for verify's own results, and result's embedded evidence -----------
//
// verify-runner.js's own per-command capture cap is 4000 bytes (DEFAULT_MAX_OUTPUT_BYTES); a
// modest 3-repository x 3-command matrix -- a real multi-repo project's realistic scale, see the
// design doc's own Acme example -- can carry up to 36,000 raw bytes of captured output alone,
// several times over the shared 12,000-character OUTPUT_LIMIT before counting anything else in
// the payload. This is the scale the brief names explicitly: "the bulkiest thing this repo has
// put in a result yet."

function heavyVerifyResult(repositoryId, command, overrides = {}) {
  return verifyResult({
    repositoryId,
    cwd: `/repo/acme/${repositoryId}`,
    command,
    output: "x".repeat(4000), // the runner's own real per-command cap
    ...overrides,
  });
}

test("--format json for verify stays well under OUTPUT_LIMIT for a realistic multi-repository matrix, even at each command's full captured-output cap", () => {
  const repositories = ["backend", "panel", "docs"];
  const commands = ["pnpm typecheck", "pnpm biome:check", "pnpm ci:verify"];
  const results = repositories.flatMap((repositoryId) => commands.map((command) => heavyVerifyResult(repositoryId, command)));
  const value = { command: "verify", runId: RUN_ID, passed: true, exitCode: 0, results };

  // Sanity check on the fixture: unbounded, this really would overflow -- otherwise the test
  // proves nothing about the bounding this task adds (the same discipline runs/inbox's own
  // headroom tests apply, see their own comments).
  const unboundedLength = JSON.stringify(value, null, 2).length;
  assert.ok(unboundedLength > 12000, `fixture too small to prove anything: ${unboundedLength} characters unbounded`);

  const json = formatWorkflowResult("verify", value, "json");
  assert.ok(json.length < 12000 * 0.9, `verify JSON for a 3x3 matrix at full output was ${json.length} characters`);

  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, undefined, "a realistic matrix must not engage the overflow fallback");
  assert.equal(parsed.results.length, 9);
  for (const result of parsed.results) {
    assert.ok(result.output.length < 4000, "each result's output must be bounded well below the runner's own capture cap");
  }
});

test("--format json for verify names the overflow instead of silently dropping the matrix at extreme scale", () => {
  const repositories = Array.from({ length: 10 }, (_, i) => `repo-${i}`);
  const commands = Array.from({ length: 6 }, (_, i) => `command-${i}`);
  const results = repositories.flatMap((repositoryId) => commands.map((command) => heavyVerifyResult(repositoryId, command)));
  const value = { command: "verify", runId: RUN_ID, passed: false, exitCode: 1, results };

  const json = formatWorkflowResult("verify", value, "json");
  assert.ok(json.length < 12000, `overflow fallback itself must stay under budget: ${json.length} characters`);
  const parsed = JSON.parse(json);

  assert.equal(parsed.command, "verify");
  assert.equal(parsed.runId, RUN_ID);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.resultCount, results.length);
  assert.deepEqual(parsed.repositoryIds.slice().sort(), repositories.slice().sort());
  assert.deepEqual(parsed.commands.slice().sort(), commands.slice().sort());

  // M6 (branch review): the collapsed shape used to drop the whole `results` array -- statuses,
  // exit codes, and the repository<->command pairing gone along with the bulky output that
  // actually caused the overflow. It now keeps a stripped entry per result (no `output`), so the
  // actionable half of the evidence survives even when the matrix itself does not fit.
  assert.equal(parsed.results.length, results.length);
  for (const result of parsed.results) {
    assert.equal(Object.hasOwn(result, "output"), false, "captured output must still be dropped -- that's what made room");
    assert.ok(typeof result.repositoryId === "string" && result.repositoryId.length > 0);
    assert.ok(typeof result.command === "string" && result.command.length > 0);
    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
  }
});

test("--format json for result also bounds each verified-evidence result's captured output", () => {
  const value = {
    command: "result",
    runId: RUN_ID,
    status: "completed",
    verifiedEvidence: {
      verifiedAt: "2026-08-04T12:00:00.000Z",
      passed: true,
      exitCode: 0,
      results: [heavyVerifyResult("backend", "pnpm test")],
    },
  };

  const json = formatWorkflowResult("result", value, "json");
  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, undefined);
  assert.ok(parsed.verifiedEvidence.results[0].output.length < 4000);
});

// --- I2 (branch review): `result --format json` must not collapse the whole envelope when its
// embedded evidence overflows -------------------------------------------------------------------
//
// Measured directly against this file's own `formatWorkflowResult("result", ..., "json")`, with a
// realistic envelope built here (the full runOutputBase field set, a canonicalResult-shaped
// `result` with three repositories' fingerprints/decisions/nextAction, and a growing
// 3-repository x 5-command evidence matrix at each result's real per-command capture cap): before
// resultOverflowFallback existed, this collapsed the ENTIRE response -- `result` included -- at
// n=12 evidence results, one test's worth of prior headroom coverage away from the 13-result shape
// this test uses (3 repos x 5 commands, well within a plausible project registry). Same failure
// shape item 2.1 fixed for `runs`, found here by measuring the one JSON surface this branch did
// not.
function realisticResultEnvelope(evidenceResultCount) {
  const repositories = ["backend", "panel", "docs"];
  const commands = ["pnpm typecheck", "pnpm biome:check", "pnpm ci:verify", "pnpm lint", "pnpm build"];
  const evidenceResults = [];
  outer:
  for (const repositoryId of repositories) {
    for (const command of commands) {
      if (evidenceResults.length >= evidenceResultCount) break outer;
      evidenceResults.push(heavyVerifyResult(repositoryId, command));
    }
  }

  return {
    command: "result",
    runId: RUN_ID,
    runDirectory: `/state/runs/${RUN_ID}`,
    projectAlias: "acme",
    projectLabel: "Acme Corp",
    task: "A-1",
    primaryTicket: "A-1",
    relatedTickets: [],
    state: "completed",
    harness: "claude",
    profileName: "default",
    workspace: { path: "/repo/acme/backend" },
    fallbackWorkspace: "/repo/acme/backend",
    resultCommand: `workflow result ${RUN_ID}`,
    reconcileCommand: `workflow reconcile --run ${RUN_ID}`,
    verifyCommand: `workflow verify ${RUN_ID}`,
    handoffCommand: `workflow handoff ${RUN_ID} --input /path/to/handoff-input.json`,
    status: "completed",
    result: {
      version: 1,
      runId: RUN_ID,
      generation: 1,
      status: "completed",
      summary: "Implemented the feature across backend/panel/docs, added tests, verified locally.",
      tickets: ["A-1"],
      repositories: repositories.map((id) => ({
        id,
        head: "a".repeat(40),
        branch: "feature/a-1",
        dirty: false,
        entries: 0,
        worktreeFingerprint: `sha256:${"0".repeat(64)}`,
        changedFiles: ["src/index.js", "src/util.js", "test/index.test.js"],
      })),
      verification: [
        { command: "pnpm typecheck", status: "passed", summary: "clean" },
        { command: "pnpm test", status: "passed", summary: "47 passed" },
      ],
      decisions: ["Used approach X over Y for reason Z"],
      concerns: [],
      nextAction: "Ready for review",
    },
    verifiedEvidence: {
      verifiedAt: "2026-08-04T12:00:00.000Z",
      passed: true,
      exitCode: 0,
      results: evidenceResults,
    },
    errors: [],
    exitCode: 0,
    nextActions: [],
  };
}

test("--format json for result stays under OUTPUT_LIMIT and keeps result/status at a realistic evidence count that used to collapse the whole envelope", () => {
  const value = realisticResultEnvelope(13);

  const unboundedLength = JSON.stringify(value, null, 2).length;
  assert.ok(unboundedLength > 12000, `fixture too small to prove anything: ${unboundedLength} characters unbounded`);

  const json = formatWorkflowResult("result", value, "json");
  assert.ok(json.length < 12000, `result JSON at a realistic 13-result evidence matrix was ${json.length} characters`);

  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.status, "completed");
  // The property the old collapse violated: `result` -- the worker's own claim -- must survive
  // even though the evidence matrix did not fit, because it does not scale with that matrix.
  assert.ok(parsed.result, "result must survive the overflow");
  assert.equal(parsed.result.summary, value.result.summary);
  assert.equal(parsed.result.repositories.length, 3);
  assert.equal(parsed.result.decisions.length, 1);
  assert.equal(parsed.result.nextAction, "Ready for review");
  assert.equal(parsed.verifiedEvidence.resultCount, 13);
  assert.equal(parsed.verifiedEvidence.results.length, 13);
  for (const result of parsed.verifiedEvidence.results) {
    assert.equal(Object.hasOwn(result, "output"), false, "captured output must still be dropped -- that's what made room");
  }
});

// M11 (branch review): every existing refusal assertion for `verify` was compact-only; nothing
// proved a refusal survives --format json rather than being reshaped by boundedJson's normal path
// (a refusal never overflows, but it does still flow through valueForJson's {...value, results:
// ...} spread, and nothing previously pinned that `reason` and the other refusal fields come out
// the other side unchanged).
test("--format json for verify carries a refusal's reason, not just the compact rendering", () => {
  const value = {
    command: "verify",
    runId: RUN_ID,
    results: [],
    passed: false,
    exitCode: 10,
    reason: "Project ocr has no verify commands configured.",
  };

  const json = formatWorkflowResult("verify", value, "json");
  const parsed = JSON.parse(json);
  assert.equal(parsed.command, "verify");
  assert.equal(parsed.runId, RUN_ID);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.exitCode, 10);
  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.reason, "Project ocr has no verify commands configured.");
});

// --- formatMerge (roadmap item 2.4's `workflow merge`) ----------------------------------------
//
// Two shapes reach this renderer, and the discriminator is structural rather than a field this
// file imports from commands.js (format.js is deliberately dependency-free): a preview carries
// `repositories[]`, an execution report carries `merged`/`failed`/`skipped`.
//
// The four things Task 2's own interface notes say the compact view must not lose: the exact argv
// per repository, the conflicts (never a truncated list rendered as the complete set), the branch
// mismatch with both branches beside each other, and the verification status including "none".

const MERGE_RUN_ID = "0b2612a8-6f2c-4a1e-8b7d-3f9c2a1d5e40";
const MERGE_DIGEST = `sha256:${"a3f9".repeat(16)}`;

function mergeRepository(overrides = {}) {
  return {
    repositoryId: "backend",
    worktreePath: "/home/op/work/sharyco/worktrees/registro-impl/backend",
    recordedBranch: "feature/1216110941098331/registro-impl",
    sourceBranch: "feature/registro-impl",
    sourceSha: "9e1c4b7a2d8f60315c4e9a7b3d2f81065c9a4e7b",
    sourceCommittedAt: "2026-08-05T18:42:11.000Z",
    branchMismatch: true,
    basePath: "/home/op/work/sharyco/backend",
    baseBranch: "dev",
    baseCheckedOutBranch: "dev",
    baseBranchCheckedOut: true,
    baseDirty: false,
    baseMerging: false,
    baseDirtyPaths: [],
    baseDirtyCount: 0,
    baseSha: "1f7d3c9b5a2e84670d1b6f3a9c5e2807b4d1a6f3",
    argv: ["git", "merge", "--no-ff", "--no-edit", "feature/registro-impl"],
    conflictStatus: "clean",
    conflicts: [],
    conflictCount: 0,
    conflictsTruncated: false,
    ...overrides,
  };
}

function mergePreview(overrides = {}) {
  const repositories = overrides.repositories ?? [mergeRepository()];
  const conflicts = overrides.conflicts ?? [];
  const mergeable = overrides.mergeable ?? conflicts.length === 0;
  return {
    command: "merge",
    runId: MERGE_RUN_ID,
    projectAlias: "sharyco",
    runState: "completed",
    refused: false,
    verification: {
      status: "recorded",
      verifiedAt: "2026-08-05T19:03:44.000Z",
      passed: true,
      exitCode: 0,
      staleRelativeToSource: false,
    },
    mergeable,
    approvalDigest: MERGE_DIGEST,
    exitCode: mergeable ? 0 : 11,
    nextActions: mergeable
      ? [`workflow merge ${MERGE_RUN_ID} --yes --approval-digest ${MERGE_DIGEST}`]
      : [`workflow merge ${MERGE_RUN_ID} --dry-run`],
    ...overrides,
    repositories,
    conflicts,
  };
}

function threeRepositoryPreview(perRepository = () => ({})) {
  const repositories = ["backend", "panel", "webapp"].map((repositoryId, index) => mergeRepository({
    repositoryId,
    worktreePath: `/home/op/work/sharyco/worktrees/registro-impl/${repositoryId}`,
    basePath: `/home/op/work/sharyco/${repositoryId}`,
    ...perRepository(repositoryId, index),
  }));
  return mergePreview({ repositories });
}

test("the compact merge preview renders each repository's argv verbatim, exactly as it would run", () => {
  const preview = threeRepositoryPreview((repositoryId) => ({
    argv: ["git", "merge", "--no-ff", "--no-edit", `feature/${repositoryId}-work`],
  }));

  const compact = formatWorkflowResult("merge", preview, "compact");

  assert.match(compact, /^Argv:$/m);
  for (const repository of preview.repositories) {
    const line = `${repository.repositoryId}: ${JSON.stringify(repository.argv)}`;
    assert.ok(
      compact.split("\n").includes(line),
      `the exact argv line must appear verbatim: ${line}\n---\n${compact}`,
    );
  }
});

test("a conflicted merge preview never renders like a clean one, and names the conflicted files", () => {
  const clean = formatWorkflowResult("merge", threeRepositoryPreview(), "compact");
  assert.match(clean, /^Merge: mergeable$/m);
  assert.doesNotMatch(clean, /CONFLICTED/);

  const conflicted = threeRepositoryPreview((repositoryId) => (repositoryId === "panel"
    ? {
      conflictStatus: "conflicted",
      conflicts: ["packages/panel/src/registro/index.tsx", "packages/panel/src/registro/form.tsx"],
      conflictCount: 2,
      conflictReason: "Merging feature/registro-impl into dev conflicts in 2 file(s)",
    }
    : {}));
  conflicted.conflicts = [{
    repositoryId: "panel",
    resource: "merge:/home/op/work/sharyco/panel",
    reason: "Merging feature/registro-impl into dev conflicts in 2 file(s): packages/panel/src/registro/index.tsx, packages/panel/src/registro/form.tsx",
  }];
  conflicted.mergeable = false;
  conflicted.exitCode = 11;

  const compact = formatWorkflowResult("merge", conflicted, "compact");
  assert.doesNotMatch(compact, /^Merge: mergeable$/m);
  assert.match(compact, /^Merge: blocked by 1 conflict/m);
  assert.match(compact, /CONFLICTED \(2\)/);
  assert.match(compact, /^Conflicted files:$/m);
  assert.match(compact, /packages\/panel\/src\/registro\/index\.tsx/);
  assert.match(compact, /packages\/panel\/src\/registro\/form\.tsx/);
  assert.match(compact, /^Conflicts:$/m);
  assert.match(compact, /merge:\/home\/op\/work\/sharyco\/panel/);
});

test("a truncated conflict list is never rendered as the complete set", () => {
  const preview = threeRepositoryPreview((repositoryId) => (repositoryId === "backend"
    ? {
      conflictStatus: "conflicted",
      conflicts: Array.from({ length: 10 }, (_, index) => `packages/backend/src/step-${index}.ts`),
      conflictCount: 900,
      conflictsTruncated: true,
    }
    : {}));
  preview.mergeable = false;
  preview.exitCode = 11;
  preview.conflicts = [{ repositoryId: "backend", resource: "merge:/home/op/work/sharyco/backend", reason: "900 conflicts" }];

  const compact = formatWorkflowResult("merge", preview, "compact");
  assert.match(compact, /TRUNCATED/, "the operator must not read 10 of 900 conflicts as the whole list");
  assert.match(compact, /showing 10 of at least 900/);
});

test("a conflict status git could not determine is never rendered as clean", () => {
  const preview = threeRepositoryPreview((repositoryId) => (repositoryId === "webapp"
    ? {
      conflictStatus: "unknown",
      conflicts: [],
      conflictCount: 0,
      conflictReason: "git merge-tree exited with code 128",
    }
    : {}));
  preview.mergeable = false;
  preview.exitCode = 11;
  preview.conflicts = [{
    repositoryId: "webapp",
    resource: "merge:/home/op/work/sharyco/webapp",
    reason: "Conflicts could not be determined: git merge-tree exited with code 128",
  }];

  const compact = formatWorkflowResult("merge", preview, "compact");
  assert.match(compact, /UNKNOWN/);
  assert.doesNotMatch(compact, /^webapp: none$/m, "an undetermined conflict list must not read as an empty one");
  assert.match(compact, /git merge-tree exited with code 128/);
});

test("a base checkout that is dirty, on the wrong branch, or unreadable is named in the compact table and never as clean", () => {
  const preview = threeRepositoryPreview((repositoryId) => {
    if (repositoryId === "panel") return { baseDirty: true, baseDirtyPaths: ["src/a.ts", "src/b.ts"], baseDirtyCount: 7 };
    if (repositoryId === "webapp") return { baseDirty: null, baseCheckedOutBranch: "main", baseBranchCheckedOut: false };
    return {};
  });
  preview.mergeable = false;
  preview.exitCode = 11;

  const compact = formatWorkflowResult("merge", preview, "compact");
  assert.match(compact, /DIRTY \(7\)/);
  assert.match(compact, /STATUS UNKNOWN/);
  assert.match(compact, /main \(NOT dev\)/);
});

test("a branch mismatch names both the recorded branch and the worktree's actual branch", () => {
  const mismatched = formatWorkflowResult("merge", mergePreview(), "compact");
  assert.match(mismatched, /^Branch mismatch:$/m);
  assert.match(mismatched, /feature\/1216110941098331\/registro-impl/);
  assert.match(mismatched, /feature\/registro-impl/);

  const agreed = formatWorkflowResult("merge", mergePreview({
    repositories: [mergeRepository({ recordedBranch: "feature/registro-impl", branchMismatch: false })],
  }), "compact");
  assert.match(agreed, /^Branch mismatch: none$/m, "an empty section says so rather than vanishing");
});

test("the merge preview names the verification status, including when there is none", () => {
  const none = formatWorkflowResult("merge", mergePreview({
    verification: { status: "none", verifiedAt: null, passed: null, exitCode: null, staleRelativeToSource: null },
  }), "compact");
  assert.match(none, /^Verification: none recorded/m);
  assert.doesNotMatch(none, /^Verification:\s*$/m);

  const failed = formatWorkflowResult("merge", mergePreview({
    verification: { status: "recorded", verifiedAt: "2026-08-05T19:03:44.000Z", passed: false, exitCode: 1, staleRelativeToSource: false },
  }), "compact");
  assert.match(failed, /^Verification: FAILED \(exit 1, ran 2026-08-05T19:03:44\.000Z\)/m);

  const stale = formatWorkflowResult("merge", mergePreview({
    verification: { status: "recorded", verifiedAt: "2026-08-05T19:03:44.000Z", passed: true, exitCode: 0, staleRelativeToSource: true },
  }), "compact");
  assert.match(stale, /STALE/);

  const unknownStaleness = formatWorkflowResult("merge", mergePreview({
    verification: { status: "recorded", verifiedAt: "2026-08-05T19:03:44.000Z", passed: true, exitCode: 0, staleRelativeToSource: null },
  }), "compact");
  assert.match(unknownStaleness, /staleness unknown/);
});

test("a mergeable preview prints the approval digest and the copy-pasteable approval command", () => {
  const compact = formatWorkflowResult("merge", mergePreview(), "compact");
  assert.match(compact, new RegExp(`^Approval digest: ${MERGE_DIGEST}$`, "m"));
  assert.match(compact, new RegExp(`^- workflow merge ${MERGE_RUN_ID} --yes --approval-digest ${MERGE_DIGEST}$`, "m"));
});

test("a refused merge preview renders as a refusal, never as an empty success, and keeps its next actions", () => {
  const value = {
    command: "merge",
    runId: MERGE_RUN_ID,
    projectAlias: "sharyco",
    runState: "completed",
    refused: true,
    reason: "Run 0b2612a8 has no repositories[] recorded; nothing to merge.",
    repositories: [],
    verification: null,
    conflicts: [],
    mergeable: false,
    approvalDigest: null,
    exitCode: 10,
    nextActions: [`workflow reconcile --run ${MERGE_RUN_ID}`, `workflow merge ${MERGE_RUN_ID} --dry-run`],
  };

  const compact = formatWorkflowResult("merge", value, "compact");
  assert.match(compact, /^Merge: refused — Run 0b2612a8 has no repositories\[\] recorded; nothing to merge\.$/m);
  assert.doesNotMatch(compact, /mergeable/);
  assert.doesNotMatch(compact, /^Approval digest:/m, "there is no digest an operator could pass back");
  assert.match(compact, new RegExp(`^- workflow reconcile --run ${MERGE_RUN_ID}$`, "m"));
  assert.match(compact, new RegExp(`^- workflow merge ${MERGE_RUN_ID} --dry-run$`, "m"));
});

test("the merge execution report separates merged, failed, and never-attempted, and a partial never reads as merged", () => {
  const report = {
    command: "merge",
    runId: MERGE_RUN_ID,
    projectAlias: "sharyco",
    approvalDigest: MERGE_DIGEST,
    status: "partial",
    merged: [{
      repositoryId: "backend",
      basePath: "/home/op/work/sharyco/backend",
      baseBranch: "dev",
      sourceBranch: "feature/registro-impl",
      sourceSha: "9e1c4b7a",
      argv: ["git", "merge", "--no-ff", "--no-edit", "feature/registro-impl"],
      code: 0,
    }],
    failed: [{
      repositoryId: "panel",
      basePath: "/home/op/work/sharyco/panel",
      baseBranch: "dev",
      sourceBranch: "feature/registro-impl",
      sourceSha: "9e1c4b7a",
      argv: ["git", "merge", "--no-ff", "--no-edit", "feature/registro-impl"],
      code: 1,
      reason: "error: Your local changes would be overwritten by merge.",
    }],
    skipped: [{
      repositoryId: "webapp",
      basePath: "/home/op/work/sharyco/webapp",
      baseBranch: "dev",
      sourceBranch: "feature/registro-impl",
      sourceSha: "9e1c4b7a",
      argv: ["git", "merge", "--no-ff", "--no-edit", "feature/registro-impl"],
      reason: "never attempted: an earlier repository's merge failed",
    }],
    passed: false,
    exitCode: 13,
    evidenceError: "evidence could not be persisted: run lock held",
    nextActions: [`workflow merge ${MERGE_RUN_ID} --dry-run`],
  };

  const compact = formatWorkflowResult("merge", report, "compact");
  assert.match(compact, /^Merge: PARTIAL$/m);
  assert.doesNotMatch(compact, /^Merge: merged$/m);
  assert.match(compact, /backend\s+\|\s+merged/);
  assert.match(compact, /panel\s+\|\s+FAILED/);
  assert.match(compact, /webapp\s+\|\s+NOT ATTEMPTED/);
  assert.match(compact, /^Reasons:$/m);
  assert.match(compact, /error: Your local changes would be overwritten by merge\./);
  assert.match(compact, /^Evidence: evidence could not be persisted: run lock held$/m);
  // The executed argv is the audit trail; it must survive into the report's rendering too.
  assert.match(compact, /\["git","merge","--no-ff","--no-edit","feature\/registro-impl"\]/);

  const merged = formatWorkflowResult("merge", { ...report, status: "merged", failed: [], skipped: [], passed: true, exitCode: 0, evidenceError: undefined }, "compact");
  assert.match(merged, /^Merge: merged$/m);
  assert.match(merged, /^Failed: none$/m);
  assert.match(merged, /^Never attempted: none$/m);
});

// Found running the real CLI (task 3, step 5) against a base checkout whose `pre-merge-commit`
// hook rejects the merge. git's stderr is two lines; rendered raw, the second one appeared in the
// Reasons section with no repository label in front of it -- and in that case the orphaned line
// was git's own "use 'git commit' to complete the merge", reading as advice about the whole run
// inside a report about a merge that failed.
test("a multi-line reason from git's own stderr stays attributed to its repository", () => {
  const report = {
    command: "merge",
    runId: MERGE_RUN_ID,
    status: "partial",
    merged: [{ repositoryId: "one", basePath: "/base/one", baseBranch: "dev", argv: ["git", "merge"] }],
    failed: [{
      repositoryId: "two",
      basePath: "/base/two",
      baseBranch: "dev",
      argv: ["git", "merge"],
      code: 1,
      reason: "policy: this repository requires a signed integration ticket\nNot committing merge; use 'git commit' to complete the merge.",
    }],
    skipped: [],
    passed: false,
    exitCode: 13,
    nextActions: [],
  };

  const compact = formatWorkflowResult("merge", report, "compact");
  const lines = compact.split("\n");
  const reasonsIndex = lines.indexOf("Reasons:");
  assert.ok(reasonsIndex >= 0);
  assert.equal(lines[reasonsIndex + 1], "two: policy: this repository requires a signed integration ticket");
  assert.equal(
    lines[reasonsIndex + 2],
    "    Not committing merge; use 'git commit' to complete the merge.",
    "a continuation line must be visibly part of its entry, not a statement about the whole run",
  );
});

test("the compact headline never says mergeable over a preview that says otherwise", () => {
  // Nothing produces this shape today -- commands.js computes `mergeable` as
  // `conflicts.length === 0` -- but a renderer that can print "mergeable" over a response the CLI
  // exits 11 on is the false-green shape this roadmap keeps removing.
  const divergent = mergePreview({ mergeable: false, exitCode: 11, conflicts: [] });
  const compact = formatWorkflowResult("merge", divergent, "compact");
  assert.doesNotMatch(compact, /^Merge: mergeable$/m);
  assert.match(compact, /^Merge: NOT MERGEABLE \(no conflicts were listed; refusing to read that as clean\)$/m);

  const unset = mergePreview();
  delete unset.mergeable;
  assert.doesNotMatch(formatWorkflowResult("merge", unset, "compact"), /^Merge: mergeable$/m);

  assert.match(formatWorkflowResult("merge", mergePreview(), "compact"), /^Merge: mergeable$/m);
});

// The column answers exactly one question -- what `git merge-tree` predicted about CONTENT -- and
// a repository can be blocked by something one column to its left. `gamma`'s real row in step 5
// read `dev, DIRTY (2) | clean` under a header that said `MERGE`, which promised more than the
// cell delivers.
test("the conflict column is named after the oracle that produced it, not after the merge", () => {
  const compact = formatWorkflowResult("merge", threeRepositoryPreview(), "compact");
  const header = compact.split("\n").find((line) => line.startsWith("REPO"));
  assert.ok(header, compact);
  assert.match(header, /MERGE-TREE/);
  assert.doesNotMatch(header, /\|\s*MERGE\s*$/, "a bare MERGE header promises a verdict this column does not give");
});

test("a base checkout stuck mid-merge is named as such, not merely as dirty", () => {
  const preview = threeRepositoryPreview((repositoryId) => (repositoryId === "panel"
    ? { baseDirty: true, baseMerging: true, baseDirtyPaths: ["two.txt"], baseDirtyCount: 1 }
    : {}));
  preview.mergeable = false;
  preview.exitCode = 11;

  const compact = formatWorkflowResult("merge", preview, "compact");
  assert.match(compact, /MID-MERGE \(1\)/);
  assert.doesNotMatch(compact, /DIRTY \(1\)/, "the more specific state must win; it is the one that changes what to do");
});

test("a base checkout whose merge state could not be read never renders as clean", () => {
  // The tri-state twin of `baseDirty`: a `null` merge state on an otherwise spotless checkout used
  // to reach the "clean" branch, which is the false green commands.js now refuses to compute.
  const preview = threeRepositoryPreview((repositoryId) => (repositoryId === "webapp"
    ? { baseMerging: null, baseDirty: false, baseDirtyPaths: [], baseDirtyCount: 0 }
    : {}));
  preview.mergeable = false;
  preview.exitCode = 11;

  const compact = formatWorkflowResult("merge", preview, "compact");
  const webappRow = compact.split("\n").find((line) => line.startsWith("webapp "));
  assert.ok(webappRow, compact);
  assert.match(webappRow, /MERGE STATE UNKNOWN/);
  assert.doesNotMatch(webappRow, /clean\s*\|/, "an unreadable merge state must not render as a clean checkout");
});

test("formatWorkflowResult dispatches \"merge\" to the compact merge renderer rather than raw JSON", () => {
  const compact = formatWorkflowResult("merge", mergePreview(), "compact");
  assert.match(compact, new RegExp(`^Run: ${MERGE_RUN_ID}$`, "m"));
  assert.doesNotMatch(compact, /^\{$/m, "the default JSON dump would mean the dispatch is missing");
});

// --- JSON size discipline for merge -----------------------------------------------------------
//
// Measured, not computed. Task 2's own display caps (10 conflict paths, 5 reason paths, 5 dirty
// paths per repository) put a three-repository conflicted preview at 11,814 characters against the
// shared 12,000 limit -- 98.5% of budget -- and a FOUR-repository one collapses to the general
// fallback's 200-character `{command, runId, truncated, truncationMarker}`, with every argv and
// every conflict gone. That is the exact shape an operator cannot act on.

const MERGE_CONFLICT_PATH = (repositoryId, index) =>
  `packages/${repositoryId}/src/features/registro/components/step-${String(index).padStart(4, "0")}/index.tsx`;
const MERGE_DIRTY_PATH = (repositoryId, index) =>
  `packages/${repositoryId}/src/features/registro/hooks/use-registro-${String(index).padStart(4, "0")}.ts`;

function worstCaseMergePreview(repositoryIds) {
  const repositories = repositoryIds.map((repositoryId) => {
    const conflicts = Array.from({ length: MERGE_DISPLAY_LIMITS.conflicts }, (_, index) => MERGE_CONFLICT_PATH(repositoryId, index));
    const dirty = Array.from({ length: MERGE_DISPLAY_LIMITS.dirtyPaths }, (_, index) => MERGE_DIRTY_PATH(repositoryId, index));
    const reasonPaths = conflicts.slice(0, MERGE_DISPLAY_LIMITS.reasonPaths);
    return mergeRepository({
      repositoryId,
      worktreePath: `/home/op/projects/work/sharyco/worktrees/1216110941098331-registro-impl/${repositoryId}`,
      basePath: `/home/op/projects/work/sharyco/${repositoryId}`,
      baseDirty: true,
      baseDirtyPaths: dirty,
      baseDirtyCount: dirty.length,
      conflictStatus: "conflicted",
      conflicts,
      conflictCount: 900,
      conflictsTruncated: true,
      conflictReason: `Merging feature/registro-impl into dev conflicts in 900 file(s): ${reasonPaths.join(", ")} (+${900 - reasonPaths.length} more)`,
    });
  });
  const conflicts = repositories.flatMap((repository) => [
    {
      repositoryId: repository.repositoryId,
      resource: `base:${repository.basePath}`,
      reason: `Base checkout ${repository.basePath} has ${repository.baseDirtyPaths.length} uncommitted path(s): ${repository.baseDirtyPaths.join(", ")}`,
    },
    {
      repositoryId: repository.repositoryId,
      resource: `merge:${repository.basePath}`,
      reason: repository.conflictReason,
    },
  ]);
  return mergePreview({ repositories, conflicts, mergeable: false, exitCode: 11 });
}

test("--format json for a realistic three-repository merge preview fits the shared 12,000-character limit", () => {
  const realistic = threeRepositoryPreview((repositoryId) => ({
    conflictStatus: "conflicted",
    conflicts: [MERGE_CONFLICT_PATH(repositoryId, 0), MERGE_CONFLICT_PATH(repositoryId, 1)],
    conflictCount: 2,
    conflictReason: `Merging feature/registro-impl into dev conflicts in 2 file(s)`,
  }));
  realistic.mergeable = false;
  realistic.exitCode = 11;

  const json = formatWorkflowResult("merge", realistic, "json");
  assert.ok(json.length < 12000 * 0.9, `a realistic three-repository preview was ${json.length} characters`);
  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, undefined, "it must not have fallen through to an overflow fallback");
  assert.equal(parsed.repositories.length, 3);
});

test("--format json for a merge preview that overflows keeps every argv and every conflict rather than collapsing the envelope", () => {
  const overflowing = worstCaseMergePreview(["backend", "panel", "webapp", "admin"]);

  const json = formatWorkflowResult("merge", overflowing, "json");
  assert.ok(json.length <= 12000, `the degraded response was ${json.length} characters`);
  const parsed = JSON.parse(json);

  assert.equal(parsed.truncated, true);
  assert.match(parsed.truncationMarker, /argv/i);
  // The two things an operator cannot act without.
  assert.equal(parsed.repositories.length, 4);
  for (const [index, repository] of parsed.repositories.entries()) {
    assert.deepEqual(repository.argv, overflowing.repositories[index].argv, "the argv is what the digest approves; it must survive");
    assert.ok(repository.conflicts.length > 0, "at least some conflicted paths must survive");
    assert.equal(repository.conflictCount, 900);
    assert.equal(repository.conflictsTruncated, true, "a shortened list must never read as complete");
  }
  assert.equal(parsed.conflicts.length, 8, "the aggregated conflict list -- what actually blocks -- must survive");
  assert.equal(parsed.approvalDigest, MERGE_DIGEST);
  assert.equal(parsed.mergeable, false);
  assert.equal(parsed.exitCode, 11);
});

test("--format json for a merge preview too wide for the first fallback still keeps every argv rather than dropping every repository", () => {
  const repositoryIds = Array.from({ length: 9 }, (_, index) => ["backend", "panel", "webapp", "admin", "mobile", "docs", "infra", "edge", "cms"][index]);
  const overflowing = worstCaseMergePreview(repositoryIds);

  const json = formatWorkflowResult("merge", overflowing, "json");
  assert.ok(json.length <= 12000, `the second-tier response was ${json.length} characters`);
  const parsed = JSON.parse(json);

  assert.equal(parsed.truncated, true);
  assert.equal(parsed.repositories.length, 9, "the general fallback would have dropped all nine");
  for (const [index, repository] of parsed.repositories.entries()) {
    assert.deepEqual(repository.argv, overflowing.repositories[index].argv);
    assert.equal(repository.conflictCount, 900);
    assert.equal(repository.conflictsTruncated, true);
    assert.deepEqual(repository.conflicts, [], "the second tier drops the paths themselves; the count and the flag carry the truth");
    assert.equal(Object.hasOwn(repository, "baseDirtyPaths"), false);
  }
  assert.equal(parsed.conflicts.length, 18);
  assert.equal(parsed.approvalDigest, MERGE_DIGEST);
});

test("--format json for merge carries a refusal's reason and next actions unchanged", () => {
  const value = {
    command: "merge",
    runId: MERGE_RUN_ID,
    refused: true,
    reason: "Unknown workflow project: sharyco",
    repositories: [],
    verification: null,
    conflicts: [],
    mergeable: false,
    approvalDigest: null,
    exitCode: 10,
    nextActions: ["workflow doctor sharyco", `workflow merge ${MERGE_RUN_ID} --dry-run`],
  };

  const parsed = JSON.parse(formatWorkflowResult("merge", value, "json"));
  assert.equal(parsed.refused, true);
  assert.equal(parsed.reason, "Unknown workflow project: sharyco");
  assert.equal(parsed.approvalDigest, null);
  assert.deepEqual(parsed.nextActions, value.nextActions);
});

// The measured worst case was defended only by a comment. The realistic-fixture test above asserts
// a bound the response clears by a wide margin; nothing pinned the number that actually matters --
// a THREE-repository preview (the real sharyco group project) at commands.js's own display caps,
// which sits at ~98% of budget. Raise MERGE_CONFLICT_DISPLAY_LIMIT from 10 to 15 there and the
// real three-repository case starts silently degrading; this is the test that notices.
test("--format json for a WORST-CASE three-repository preview still fits without any fallback", () => {
  const worstCase = worstCaseMergePreview(["backend", "panel", "webapp"]);

  const json = formatWorkflowResult("merge", worstCase, "json");
  assert.ok(json.length <= 12000, `the worst-case three-repository preview was ${json.length} characters`);

  const parsed = JSON.parse(json);
  assert.equal(parsed.truncated, undefined, "the real three-repository project must not need a fallback at all");
  assert.equal(parsed.repositories.length, 3);
  for (const [index, repository] of parsed.repositories.entries()) {
    // Unabridged: the full display-capped conflict list and the dirty paths both survive here,
    // which is exactly what the fallback tiers give up. Both counts come from commands.js's own
    // exported caps, so this assertion measures what ships rather than what was once typed here.
    assert.equal(repository.conflicts.length, MERGE_DISPLAY_LIMITS.conflicts);
    assert.equal(repository.baseDirtyPaths.length, MERGE_DISPLAY_LIMITS.dirtyPaths);
    assert.equal(repository.conflictReason, worstCase.repositories[index].conflictReason);
  }
});

// The tier boundary itself, pinned one repository either side, so a change that moves it is a test
// failure rather than a comment that quietly goes stale.
test("the merge JSON fallback tiers engage where they are documented to", () => {
  const tierOf = (repositoryIds) => {
    const parsed = JSON.parse(formatWorkflowResult("merge", worstCaseMergePreview(repositoryIds), "json"));
    if (!parsed.truncated) return "none";
    if (!Array.isArray(parsed.repositories) || parsed.repositories.length === 0) return "general";
    return parsed.repositories[0].worktreePath ? "1" : "2";
  };
  const names = ["backend", "panel", "webapp", "admin", "mobile", "docs", "infra", "edge", "cms", "api"];

  assert.equal(tierOf(names.slice(0, 3)), "none");
  assert.equal(tierOf(names.slice(0, 4)), "1");
  assert.equal(tierOf(names.slice(0, 5)), "1");
  assert.equal(tierOf(names.slice(0, 6)), "2");
  assert.equal(tierOf(names.slice(0, 9)), "2");
  assert.equal(tierOf(names.slice(0, 10)), "general", "past the tiers, the general fallback is the honest answer and the marker says so");
});

// The compact view is not a fuller answer at this size -- it is bounded to the same 12,000
// characters and it truncates its TAIL. Measured: at six repositories on the worst-case fixture it
// reaches the limit and loses `Conflicts:` and `Next:`. That is fail-safe (nothing can execute
// without a digest, and a mergeable preview never gets near this size), but the digest itself must
// survive, which is why it is rendered above the path-heavy sections rather than below them.
test("the compact preview keeps the approval digest even when it is truncated", () => {
  const wide = worstCaseMergePreview(["backend", "panel", "webapp", "admin", "mobile", "docs"]);
  const compact = formatWorkflowResult("merge", wide, "compact");

  assert.equal(compact.length, 12000);
  assert.match(compact, /\[output truncated at 12000 characters\]$/);
  assert.match(compact, new RegExp(`^Approval digest: ${MERGE_DIGEST}$`, "m"), "the one string an operator needs must not be what truncation takes first");
  assert.match(compact, /^Merge: blocked by 12 conflicts$/m);
  assert.match(compact, /^Argv:$/m);
  assert.doesNotMatch(compact, /^Next:$/m, "the tail is what is lost; the marker in the JSON fallback says so explicitly");

  // A mergeable preview -- the case an operator actually acts on -- is nowhere near the limit.
  const mergeable = threeRepositoryPreview();
  assert.ok(formatWorkflowResult("merge", mergeable, "compact").length < 12000 * 0.6);
});

// Fix round 2. The marker's closing sentence about the compact view used to be a single blanket
// claim -- "at a response this wide it loses `Conflicts:` and `Next:`" -- emitted by BOTH tiers.
// It was false at every size where tier 1 fires (measured: n=4 is 8,776 compact characters and
// n=5 is 10,865, neither truncated at all), and overstated at tier 2, where the `Conflicts:` header
// and the first entries do survive and the list is cut mid-entry. A marker whose job is accuracy
// has to be accurate about the format it is describing.
test("each JSON fallback tier's marker describes the compact view accurately for its own size range", () => {
  const names = ["backend", "panel", "webapp", "admin", "mobile", "docs", "infra", "edge", "cms"];
  const markerFor = (count) => JSON.parse(formatWorkflowResult("merge", worstCaseMergePreview(names.slice(0, count)), "json")).truncationMarker;

  const tierOne = markerFor(5);
  assert.match(tierOne, /has measured under that limit/);
  assert.doesNotMatch(tierOne, /it loses/, "tier 1 fires at sizes where the compact view loses nothing");

  const tierTwo = markerFor(9);
  assert.match(tierTwo, /loses `Next:` and the tail of `Conflicts:`/);
  assert.match(tierTwo, /keeping the run header, the approval digest, the table, `Argv:`, and the first conflict entries/);

  // And the claims are true of the actual compact rendering, not just internally consistent.
  const compactAtTierOne = formatWorkflowResult("merge", worstCaseMergePreview(names.slice(0, 5)), "compact");
  assert.ok(compactAtTierOne.length < 12000);
  assert.doesNotMatch(compactAtTierOne, /\[output truncated at/);
  assert.match(compactAtTierOne, /^Next:$/m);

  const compactAtTierTwo = formatWorkflowResult("merge", worstCaseMergePreview(names.slice(0, 9)), "compact");
  assert.equal(compactAtTierTwo.length, 12000);
  assert.doesNotMatch(compactAtTierTwo, /^Next:$/m);
  assert.match(compactAtTierTwo, /^Conflicts:$/m, "the header survives; it is the tail of the list that is cut");
  assert.ok(compactAtTierTwo.split("\n").some((line) => line.startsWith("- ")), "and so do the first entries");
});

// --- formatArchive (roadmap item 2.5's `workflow archive`) -------------------------------------
//
// Three shapes reach this renderer, and the discriminator is structural rather than a constant
// imported from commands.js (format.js is deliberately dependency-free): a refusal carries
// `refused: true`, an execution report carries `removed`/`kept`, and everything else is a preview.
//
// What this view must never lose, from Task 2's own concerns:
//   1. `losses[]` leads. The design's whole point is "what would be LOST", not "what would be
//      removed" -- `repositories[]` is a list of paths, `losses[]` is the list of work that stops
//      being findable.
//   2. `count: null` is UNKNOWN and must never render as `0`. `0` means "fully merged, nothing to
//      warn about"; they are opposite facts.
//   3. A partial report mixes losses that happened with losses that did not (`removed: true|false`)
//      and must render the difference.
//   4. `argv` is on `removed[]` only -- a `kept[]` entry's argv never ran, which is why it is not
//      carried at all.
//   5. `tab` has three distinguishable outcomes and `alreadyGone` is the COMMON one.

const ARCHIVE_RUN_ID = "7c3f1a2b-5d4e-4f60-9a8b-2c1d0e9f8a7b";
const ARCHIVE_DIGEST = `sha256:${"c7e1".repeat(16)}`;
const ARCHIVE_WORKTREE = (repositoryId) => `/home/op/projects/work/sharyco/worktrees/1216110941098331-registro-impl/${repositoryId}`;
const ARCHIVE_BASE = (repositoryId) => `/home/op/projects/work/sharyco/${repositoryId}`;

function archiveRepository(overrides = {}) {
  const repositoryId = overrides.repositoryId ?? "backend";
  return {
    repositoryId,
    worktreePath: ARCHIVE_WORKTREE(repositoryId),
    recordedBranch: "feature/1216110941098331/registro-impl",
    present: true,
    branch: "feature/registro-impl",
    branchMismatch: true,
    headSha: "3445371ae5e6c9d8b7a6f5e4d3c2b1a09876543f",
    headReachable: null,
    dirty: false,
    dirtyCount: 0,
    trackedCount: 0,
    untrackedCount: 0,
    basePath: ARCHIVE_BASE(repositoryId),
    baseBranch: "dev",
    unmergedCommits: 3,
    ...overrides,
  };
}

function unmergedLoss(repositoryId, count) {
  return {
    repositoryId,
    kind: "unmerged-commits",
    worktreePath: ARCHIVE_WORKTREE(repositoryId),
    branch: "feature/registro-impl",
    baseBranch: "dev",
    count,
    detail: `${count} commit(s) on feature/registro-impl are not in dev; the branch survives, but nothing will point at this work any more`,
  };
}

function unknownLoss(repositoryId, why) {
  return {
    repositoryId,
    kind: "unmerged-commits-unknown",
    worktreePath: ARCHIVE_WORKTREE(repositoryId),
    branch: "feature/registro-impl",
    baseBranch: "dev",
    count: null,
    detail: `how much of this work is unmerged could not be determined: ${why}`,
  };
}

function archivePreview(overrides = {}) {
  const repositories = overrides.repositories ?? [archiveRepository()];
  const losses = overrides.losses ?? [unmergedLoss("backend", 3)];
  return {
    command: "archive",
    runId: ARCHIVE_RUN_ID,
    projectAlias: "sharyco",
    runState: "completed",
    refused: false,
    reason: null,
    tabId: "w2M:t1",
    agent: {
      paneId: "w2W:p3",
      checkedPaneIds: ["w2W:p3", "w1V:p2"],
      resolved: false,
      reason: "Herdr reports no agent on pane w2W:p3 or pane w1V:p2",
    },
    lock: { held: false, ageMs: null, stale: null, ownership: null },
    removable: true,
    approvalDigest: ARCHIVE_DIGEST,
    exitCode: 0,
    nextActions: [`workflow archive ${ARCHIVE_RUN_ID} --yes --approval-digest ${ARCHIVE_DIGEST}`],
    ...overrides,
    repositories,
    losses,
  };
}

function threeRepositoryArchivePreview(perRepository = () => ({})) {
  const repositories = ["backend", "panel", "webapp"].map((repositoryId, index) => archiveRepository({
    repositoryId,
    ...perRepository(repositoryId, index),
  }));
  return archivePreview({
    repositories,
    losses: repositories.flatMap((record) => (
      record.unmergedCommits === null
        ? [unknownLoss(record.repositoryId, "the project has no base_branch configured, so the unmerged count cannot be measured")]
        : record.unmergedCommits > 0 ? [unmergedLoss(record.repositoryId, record.unmergedCommits)] : []
    )),
  });
}

test("the compact archive preview leads with what would be lost, names every loss, and prints the digest above the path-heavy sections", () => {
  const preview = threeRepositoryArchivePreview((repositoryId, index) => ({ unmergedCommits: index + 1 }));

  const compact = formatWorkflowResult("archive", preview, "compact");
  const lines = compact.split("\n");

  // The headline: the total is impossible to miss even if everything below it were cut.
  assert.match(compact, /^Would be lost: /m);
  assert.match(compact, /6 unmerged commit\(s\)/, "1 + 2 + 3 commits across the three repositories");

  // `losses[]` leads `repositories[]`: the section naming what is lost comes before the table of
  // paths, so the first thing an operator reads is the consequence, not the inventory.
  const lossesIndex = lines.findIndex((line) => line === "Losses:");
  const tableIndex = lines.findIndex((line) => /^REPO\s+\|/.test(line));
  assert.ok(lossesIndex > 0, `the preview must have a Losses section:\n${compact}`);
  assert.ok(tableIndex > lossesIndex, `the losses must come before the repository table:\n${compact}`);

  // The digest is above both, because bound() truncates the TAIL and the digest is the one string
  // an operator has to copy (formatMergePreview's own measured lesson).
  const digestIndex = lines.findIndex((line) => line === `Approval digest: ${ARCHIVE_DIGEST}`);
  assert.ok(digestIndex >= 0 && digestIndex < lossesIndex, `the digest must precede the losses:\n${compact}`);

  for (const record of preview.repositories) {
    assert.ok(compact.includes(record.worktreePath), `the worktree path for ${record.repositoryId} must be named`);
  }
  assert.match(compact, new RegExp(`^- workflow archive ${ARCHIVE_RUN_ID} --yes --approval-digest ${ARCHIVE_DIGEST}$`, "m"));
});

test("an unmerged count that could not be measured renders as UNKNOWN, never as 0, and never like a fully merged repository", () => {
  const preview = threeRepositoryArchivePreview((repositoryId, index) => ({
    unmergedCommits: index === 0 ? 0 : index === 1 ? null : 4,
    ...(index === 1 ? { unmergedReason: "the project has no base_branch configured, so the unmerged count cannot be measured" } : {}),
  }));

  const compact = formatWorkflowResult("archive", preview, "compact");
  // Read the row out of the TABLE, not out of the losses section above it -- both start with the
  // repository id, and the UNMERGED cell is the table's.
  const lines = compact.split("\n");
  const tableIndex = lines.findIndex((line) => /^REPO\s+\|/.test(line));
  const rowFor = (repositoryId) => lines.slice(tableIndex).find((line) => line.startsWith(repositoryId));

  // The false green this whole item exists to remove: `null` is "nobody could tell", `0` is
  // "checked, and nothing is unmerged". They must not produce the same cell.
  assert.match(rowFor("backend"), /\|\s+0\s*$/, "a measured 0 renders as 0");
  assert.match(rowFor("panel"), /\|\s+UNKNOWN\s*$/, "an unmeasurable count must never render as 0");
  assert.match(rowFor("webapp"), /\|\s+4\s*$/);

  // And in the loss list, and in the headline total.
  assert.match(compact, /UNKNOWN/);
  assert.doesNotMatch(compact, /panel \| 0 commit/);
  assert.match(compact, /^Would be lost: .*4 unmerged commit\(s\)/m, "the unknown loss must not be summed as 0 alongside the measured ones");
  assert.match(compact, /^Would be lost: .*UNKNOWN/m);
});

test("a fully merged, fully branched run says so explicitly rather than printing an empty losses section", () => {
  const preview = archivePreview({
    repositories: [archiveRepository({ unmergedCommits: 0 })],
    losses: [],
  });

  const compact = formatWorkflowResult("archive", preview, "compact");
  assert.match(compact, /^Would be lost: nothing/m);
  assert.match(compact, /^Losses: none$/m);
});

test("a refused archive preview renders as a refusal, never as an empty success, and keeps the -n in the remedy it was given", () => {
  const dirtyPath = ARCHIVE_WORKTREE("panel");
  const value = {
    command: "archive",
    runId: ARCHIVE_RUN_ID,
    projectAlias: "sharyco",
    runState: "completed",
    refused: true,
    reason: `Run ${ARCHIVE_RUN_ID} cannot be archived: ${dirtyPath} has 2 untracked file(s): .env.local, tmp/scratch.txt. Uncommitted and untracked work exists nowhere else, so this refuses for the whole run and never forces.`,
    tabId: "w2M:t1",
    agent: null,
    lock: null,
    repositories: [],
    losses: [],
    removable: false,
    approvalDigest: null,
    exitCode: 10,
    nextActions: [`git -C ${dirtyPath} status`, `git -C ${dirtyPath} clean -nd`, `workflow archive ${ARCHIVE_RUN_ID} --dry-run`],
  };

  const compact = formatWorkflowResult("archive", value, "compact");

  assert.match(compact, /^Archive: refused — Run .* cannot be archived: /m);
  assert.match(compact, /\.env\.local/);
  // A refusal carries `repositories: []` and `losses: []`; rendering either as an empty section
  // would read as "checked, and nothing would be lost" -- the opposite of what happened.
  assert.doesNotMatch(compact, /^Losses: none$/m);
  assert.doesNotMatch(compact, /^Would be lost: nothing/m);
  assert.doesNotMatch(compact, /^REPO\s+\|/m);
  assert.doesNotMatch(compact, /Approval digest/);
  // `-n` is a dry run; a command that refuses to destroy untracked work must not hand the operator
  // a one-liner that destroys it.
  assert.match(compact, new RegExp(`^- git -C ${dirtyPath.replace(/\//g, "\\/")} clean -nd$`, "m"));
  assert.match(compact, new RegExp(`^- workflow archive ${ARCHIVE_RUN_ID} --dry-run$`, "m"));
});

test("an in-progress-operation refusal prints the remedy it was handed, not a hardcoded merge one", () => {
  const worktree = ARCHIVE_WORKTREE("backend");
  const compact = formatWorkflowResult("archive", {
    command: "archive",
    runId: ARCHIVE_RUN_ID,
    projectAlias: "sharyco",
    runState: "completed",
    refused: true,
    reason: `Run ${ARCHIVE_RUN_ID} repository backend worktree at ${worktree} is in the middle of a rebase; finish it or run \`git -C ${worktree} rebase --abort\` before archiving.`,
    tabId: null,
    agent: null,
    lock: null,
    repositories: [],
    losses: [],
    removable: false,
    approvalDigest: null,
    exitCode: 10,
    nextActions: [`git -C ${worktree} status`, `git -C ${worktree} rebase --abort`, `workflow archive ${ARCHIVE_RUN_ID} --dry-run`],
  }, "compact");

  assert.match(compact, /rebase --abort/);
  assert.doesNotMatch(compact, /merge --abort/, "the remedy for a rebase is not the merge one");
});

test("a held lock is named on an archivable preview, together with the command that clears it", () => {
  const compact = formatWorkflowResult("archive", archivePreview({
    lock: {
      held: true,
      ageMs: 21_600_000,
      stale: true,
      ownership: { verdict: "owner-gone", removable: true, reason: "pid 4242 no longer exists" },
    },
    nextActions: [
      `workflow archive ${ARCHIVE_RUN_ID} --yes --approval-digest ${ARCHIVE_DIGEST}`,
      `workflow unlock ${ARCHIVE_RUN_ID} --yes`,
    ],
  }), "compact");

  // Archive does not remove the lock, but store.update/appendEvent both take it -- so an operator
  // who does not see this archives successfully and then gets a recordError with no explanation.
  assert.match(compact, /^Lock: HELD/m);
  assert.match(compact, /owner-gone/);
  assert.match(compact, new RegExp(`^- workflow unlock ${ARCHIVE_RUN_ID} --yes$`, "m"));
});

test("an already-vanished worktree and a detached HEAD are each named in the table rather than rendered as unknowns", () => {
  const compact = formatWorkflowResult("archive", archivePreview({
    repositories: [
      archiveRepository({ repositoryId: "backend", present: false, branch: null, headSha: null, unmergedCommits: null }),
      archiveRepository({ repositoryId: "panel", branch: null, headReachable: true, unmergedCommits: null }),
    ],
    losses: [
      unknownLoss("backend", `the worktree directory at ${ARCHIVE_WORKTREE("backend")} no longer exists, so its branch cannot be read`),
      {
        repositoryId: "panel",
        kind: "detached-head",
        worktreePath: ARCHIVE_WORKTREE("panel"),
        branch: null,
        baseBranch: "dev",
        count: null,
        detail: `the worktree at ${ARCHIVE_WORKTREE("panel")} is on a detached HEAD at 3445371ae5e6`,
      },
    ],
  }), "compact");

  assert.match(compact, /ALREADY GONE/, "a worktree the directory of which has vanished is the residue this command exists for");
  assert.match(compact, /DETACHED/);
  assert.doesNotMatch(compact, /\|\s+0\s*$/m, "no count here was measured, so none may render as 0");
});

function archiveReport(overrides = {}) {
  return {
    command: "archive",
    runId: ARCHIVE_RUN_ID,
    projectAlias: "sharyco",
    approvalDigest: ARCHIVE_DIGEST,
    status: "archived",
    archivedAt: "2026-08-07T12:00:00.000Z",
    removed: [{
      repositoryId: "backend",
      worktreePath: ARCHIVE_WORKTREE("backend"),
      branch: "feature/registro-impl",
      code: 0,
      argv: ["git", "worktree", "remove", ARCHIVE_WORKTREE("backend")],
    }],
    kept: [],
    tab: { tabId: "w2M:t1", closed: false, alreadyGone: true, reason: "not-found" },
    losses: [{ ...unmergedLoss("backend", 3), removed: true }],
    exitCode: 0,
    nextActions: [],
    ...overrides,
  };
}

test("the archive report separates what was removed from what was kept, and a partial never reads as archived", () => {
  const report = archiveReport({
    status: "partial",
    archivedAt: null,
    kept: [{
      repositoryId: "panel",
      worktreePath: ARCHIVE_WORKTREE("panel"),
      branch: "feature/registro-impl",
      code: 128,
      reason: "dirty",
      detail: `fatal: '${ARCHIVE_WORKTREE("panel")}' contains modified or untracked files, use --force to delete it`,
    }],
    losses: [
      { ...unmergedLoss("backend", 3), removed: true },
      { ...unmergedLoss("panel", 5), removed: false, detail: `5 commit(s) on feature/registro-impl are not in dev — but this worktree was NOT removed and is still on disk at ${ARCHIVE_WORKTREE("panel")}, so nothing has been lost yet.` },
    ],
    exitCode: 13,
    nextActions: [`workflow archive ${ARCHIVE_RUN_ID} --dry-run`],
  });

  const compact = formatWorkflowResult("archive", report, "compact");

  assert.match(compact, /^Archive: PARTIAL$/m);
  assert.doesNotMatch(compact, /^Archive: archived$/m);
  assert.match(compact, /backend\s+\|\s+removed/);
  assert.match(compact, /panel\s+\|\s+KEPT/);
  assert.match(compact, /contains modified or untracked files/);

  // The losses on a partial report describe two DIFFERENT worlds and must not render identically:
  // backend's happened, panel's did not.
  const backendLoss = compact.split("\n").find((line) => line.includes("backend") && line.includes("commit(s)"));
  const panelLoss = compact.split("\n").find((line) => line.includes("panel") && line.includes("commit(s)"));
  assert.ok(backendLoss && panelLoss, `both losses must be rendered:\n${compact}`);
  assert.notEqual(backendLoss.replace("backend", "X"), panelLoss.replace("panel", "X"), "a loss that happened must not render like one that did not");
  assert.match(panelLoss, /NOT LOST/);
});

test("the executed argv is rendered only for removals that actually succeeded", () => {
  const report = archiveReport({
    status: "partial",
    archivedAt: null,
    kept: [{
      repositoryId: "panel",
      worktreePath: ARCHIVE_WORKTREE("panel"),
      branch: "feature/registro-impl",
      code: null,
      reason: "unsafe-path",
      // Task 1's concern: this entry deliberately carries NO argv, because nothing ran.
      detail: "the worktree path is not absolute; refusing to spawn",
    }],
    exitCode: 13,
  });

  const compact = formatWorkflowResult("archive", report, "compact");

  assert.match(compact, /^Removed \(executed argv\):$/m);
  assert.match(compact, new RegExp(`^backend: \\["git","worktree","remove","${ARCHIVE_WORKTREE("backend").replace(/\//g, "\\/")}"\\]$`, "m"));
  assert.doesNotMatch(compact, /panel: \["git"/, "a kept repository never ran a command; printing one would be an audit trail of something that did not happen");
  assert.match(compact, /unsafe-path/);
});

test("the archive report's three tab outcomes never collapse into one", () => {
  const outcomes = [
    [{ tabId: null, closed: false, alreadyGone: false, reason: "no-tab-recorded" }, /^Tab: none recorded/m],
    // The COMMON case on a real machine: every recorded tab id is stale, so this is what an
    // operator sees almost every time. It must not read as a failure.
    [{ tabId: "w2M:t1", closed: false, alreadyGone: true, reason: "not-found" }, /^Tab: w2M:t1 already gone/m],
    [{ tabId: "w2M:t1", closed: true, alreadyGone: false, reason: null }, /^Tab: w2M:t1 closed$/m],
    [{ tabId: "w2M:t1", closed: false, alreadyGone: false, reason: "herdr exited with code 1" }, /^Tab: w2M:t1 NOT CLOSED — herdr exited with code 1$/m],
  ];

  const rendered = outcomes.map(([tab, expected]) => {
    const compact = formatWorkflowResult("archive", archiveReport({ tab }), "compact");
    const line = compact.split("\n").find((entry) => entry.startsWith("Tab: "));
    assert.match(compact, expected, `tab outcome ${JSON.stringify(tab)} rendered as:\n${line}`);
    return line;
  });
  assert.equal(new Set(rendered).size, outcomes.length, "four distinguishable outcomes must produce four distinguishable lines");
  assert.doesNotMatch(rendered[1], /NOT CLOSED|failed/i, "already gone is already archived, not a failure");
});

test("a persistence failure after real removals is named last, never folded into the verdict", () => {
  const compact = formatWorkflowResult("archive", archiveReport({
    recordError: "the run could not be marked archived: run lock is held",
    evidenceError: "evidence could not be persisted: run lock is held",
    nextActions: [`workflow unlock ${ARCHIVE_RUN_ID} --yes`],
  }), "compact");

  assert.match(compact, /^Archive: archived$/m, "the removals really happened; the verdict is about them");
  assert.match(compact, /^Record: the run could not be marked archived: run lock is held$/m);
  assert.match(compact, /^Evidence: evidence could not be persisted: run lock is held$/m);
  assert.match(compact, new RegExp(`^- workflow unlock ${ARCHIVE_RUN_ID} --yes$`, "m"));
});

// --- archive JSON, measured against the shared 12,000-character budget -------------------------
//
// Items 2.1, 2.3 and 2.4 each shipped a JSON collapse that only measurement caught, so this is
// measured against a fixture built FROM the caps that actually ship (ARCHIVE_DISPLAY_LIMITS),
// never against numbers copied out of commands.js.

function worstCaseArchivePreview(repositoryIds) {
  const repositories = repositoryIds.map((repositoryId) => archiveRepository({
    repositoryId,
    unmergedCommits: 900,
    unmergedReason: undefined,
  }));
  return archivePreview({
    repositories,
    losses: repositories.map((record) => unmergedLoss(record.repositoryId, 900)),
  });
}

function worstCaseArchiveRefusal(repositoryIds) {
  // A refusal's only long field is `reason`, already capped at reasonRepositories x reasonPaths by
  // commands.js. `nextActions` is capped by the SAME slice.
  const shown = repositoryIds.slice(0, ARCHIVE_DISPLAY_LIMITS.reasonRepositories);
  const clause = shown.map((repositoryId) => {
    const paths = Array.from({ length: ARCHIVE_DISPLAY_LIMITS.reasonPaths }, (_, index) => `packages/${repositoryId}/src/features/registro/hooks/use-registro-${String(index).padStart(4, "0")}.ts`);
    return `${ARCHIVE_WORKTREE(repositoryId)} has 12 untracked file(s): ${paths.join(", ")} (+7 more)`;
  }).join("; ");
  return {
    command: "archive",
    runId: ARCHIVE_RUN_ID,
    projectAlias: "sharyco",
    runState: "completed",
    refused: true,
    reason: `Run ${ARCHIVE_RUN_ID} cannot be archived: ${clause}${repositoryIds.length > shown.length ? ` (+${repositoryIds.length - shown.length} more repositories)` : ""}. Uncommitted and untracked work exists nowhere else, so this refuses for the whole run and never forces.`,
    tabId: "w2M:t1",
    agent: { paneId: "w2W:p3", checkedPaneIds: ["w2W:p3"], resolved: false, reason: "Herdr reports no agent on pane w2W:p3" },
    lock: { held: false, ageMs: null, stale: null, ownership: null },
    repositories: [],
    losses: [],
    removable: false,
    approvalDigest: null,
    exitCode: 10,
    nextActions: [...shown.flatMap((repositoryId) => [`git -C ${ARCHIVE_WORKTREE(repositoryId)} status`, `git -C ${ARCHIVE_WORKTREE(repositoryId)} clean -nd`]), `workflow archive ${ARCHIVE_RUN_ID} --dry-run`],
  };
}

test("--format json for a realistic three-repository archive fits the shared 12,000-character limit, preview, refusal and report alike", () => {
  for (const [label, value] of [
    ["preview", threeRepositoryArchivePreview((repositoryId, index) => ({ unmergedCommits: index === 1 ? null : 900 }))],
    ["refusal", worstCaseArchiveRefusal(["backend", "panel", "webapp"])],
    ["report", archiveReport({
      removed: ["backend", "panel", "webapp"].map((repositoryId) => ({
        repositoryId,
        worktreePath: ARCHIVE_WORKTREE(repositoryId),
        branch: "feature/registro-impl",
        code: 0,
        argv: ["git", "worktree", "remove", ARCHIVE_WORKTREE(repositoryId)],
      })),
      losses: ["backend", "panel", "webapp"].map((repositoryId) => ({ ...unmergedLoss(repositoryId, 900), removed: true })),
    })],
  ]) {
    const json = formatWorkflowResult("archive", value, "json");
    assert.ok(json.length < 12000 * 0.9, `the ${label} was ${json.length} characters, expected comfortably under 90% of OUTPUT_LIMIT`);
    const parsed = JSON.parse(json);
    assert.equal(parsed.truncated, undefined, `the ${label} must not have fallen through to an overflow fallback`);
  }
});

test("--format json for an archive preview too wide to fit keeps every worktree path and every loss count rather than collapsing the envelope", () => {
  const repositoryIds = ["backend", "panel", "webapp", "admin", "mobile", "docs", "infra", "edge", "cms", "gateway", "billing", "search"];
  const overflowing = worstCaseArchivePreview(repositoryIds);
  assert.ok(
    JSON.stringify(overflowing, null, 2).length > 12000,
    "the fixture is too small to prove anything: it must actually exceed OUTPUT_LIMIT",
  );

  const json = formatWorkflowResult("archive", overflowing, "json");
  assert.ok(json.length <= 12000, `the degraded response was ${json.length} characters`);
  const parsed = JSON.parse(json);

  assert.equal(parsed.truncated, true);
  assert.equal(parsed.repositories.length, repositoryIds.length, "the general fallback would have dropped every one of them");
  for (const [index, record] of parsed.repositories.entries()) {
    assert.equal(record.worktreePath, overflowing.repositories[index].worktreePath, "the path is what would be removed; it must survive");
    assert.equal(record.unmergedCommits, 900, "the loss count is what an operator is approving");
  }
  assert.equal(parsed.losses.length, repositoryIds.length);
  for (const loss of parsed.losses) {
    assert.equal(loss.count, 900);
    assert.equal(typeof loss.kind, "string");
  }
  assert.equal(parsed.approvalDigest, ARCHIVE_DIGEST, "without the digest nothing can be approved at all");
  assert.match(parsed.truncationMarker, /worktree path|path/i);
});

test("an unknown loss count survives the JSON overflow fallback as null, never as 0", () => {
  const repositoryIds = ["backend", "panel", "webapp", "admin", "mobile", "docs", "infra", "edge", "cms", "gateway", "billing", "search"];
  const overflowing = worstCaseArchivePreview(repositoryIds);
  overflowing.repositories[0].unmergedCommits = null;
  overflowing.losses[0] = unknownLoss(repositoryIds[0], "the project has no base_branch configured, so the unmerged count cannot be measured");

  const parsed = JSON.parse(formatWorkflowResult("archive", overflowing, "json"));
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.repositories[0].unmergedCommits, null);
  assert.equal(parsed.losses[0].count, null);
});

// The boundaries the ARCHIVE_OVERFLOW_TIERS comment documents, pinned as tiers rather than as byte
// counts (they are fixture-relative: shorter worktree paths push each one out). Mirrors the merge
// tier test, and exists for the same reason: the first version of this fallback bounded each
// `detail` to 120 characters when the real sentence is 119, so it degraded nothing, fired never,
// and left every wide archive collapsing to the general fallback's 202 characters. Only measuring
// caught that.
test("the archive JSON fallback tiers engage where they are documented to, and every tier keeps the paths and the counts", () => {
  const tierOf = (n) => {
    const parsed = JSON.parse(formatWorkflowResult("archive", worstCaseArchivePreview(
      Array.from({ length: n }, (_, index) => `repo-${String(index).padStart(2, "0")}`),
    ), "json"));
    if (!parsed.truncated) return "none";
    if (parsed.repositories === undefined) return "general";
    return Object.hasOwn(parsed.repositories[0], "recordedBranch") ? "tier1" : "tier2";
  };

  assert.equal(tierOf(10), "none");
  assert.equal(tierOf(11), "tier1");
  assert.equal(tierOf(12), "tier2");
  assert.equal(tierOf(16), "tier2");
  assert.equal(tierOf(17), "general");

  // And at every tier that is not the general one, the two things this fallback exists to protect
  // survive: the path that would be removed, and the count that would be lost.
  for (const n of [11, 12, 16]) {
    const preview = worstCaseArchivePreview(Array.from({ length: n }, (_, index) => `repo-${String(index).padStart(2, "0")}`));
    const parsed = JSON.parse(formatWorkflowResult("archive", preview, "json"));
    assert.equal(parsed.repositories.length, n);
    assert.deepEqual(parsed.repositories.map((record) => record.worktreePath), preview.repositories.map((record) => record.worktreePath));
    assert.deepEqual(parsed.losses.map((loss) => loss.count), preview.losses.map((loss) => loss.count));
    assert.equal(parsed.approvalDigest, ARCHIVE_DIGEST);
  }
});

// Three defects this renderer shipped and only the real CLI (task 3, step 5) exposed, all three in
// the same output: re-previewing an already-archived run. Each was a true-looking sentence that was
// false about the world it was describing.
test("a preview of a run whose worktrees are already gone never promises removals, mismatches, or checks that did not happen", () => {
  const preview = archivePreview({
    repositories: ["backend", "panel"].map((repositoryId) => archiveRepository({
      repositoryId,
      present: false,
      branch: null,
      headSha: null,
      unmergedCommits: null,
    })),
    losses: ["backend", "panel"].map((repositoryId) => unknownLoss(repositoryId, `the worktree directory at ${ARCHIVE_WORKTREE(repositoryId)} no longer exists, so its branch cannot be read`)),
    agent: { paneId: null, checkedPaneIds: [], resolved: false, reason: "the run records no pane id, so it has no agent to resolve" },
  });

  const compact = formatWorkflowResult("archive", preview, "compact");

  // 1. `2 worktree(s) would be removed` was false: both directories are already gone, so nothing is
  //    removed from disk and only the git registration is reclaimed.
  assert.doesNotMatch(compact, /^Archive: 2 worktree\(s\) would be removed$/m);
  assert.match(compact, /^Archive: nothing left on disk — all 2 recorded worktree\(s\) are already gone/m);

  // 2. `the worktree <path> is on -` was not a branch mismatch; it was a missing worktree.
  assert.doesNotMatch(compact, /is on - —/);
  assert.match(compact, /^backend: the run recorded feature\/1216110941098331\/registro-impl; that worktree is already gone/m);

  // 3. `no live agent (panes checked: none recorded)` claimed a check and denied it in the same
  //    breath. A run with no pane has no agent to resolve and Herdr is never asked.
  assert.doesNotMatch(compact, /panes checked: none recorded/);
  assert.match(compact, /^Agent: none to resolve \(the run never recorded a pane id, so Herdr was not asked\)$/m);

  // And a run that DID record panes still reports which ones were asked about -- `checkedPaneIds`
  // may name two, and that is the evidence behind "no live agent".
  const withPanes = formatWorkflowResult("archive", archivePreview(), "compact");
  assert.match(withPanes, /^Agent: no live agent \(Herdr asked about w2W:p3, w1V:p2\)$/m);
});

// A fourth defect from the same real run: the loss label restated the detail it sat in front of, so
// every unmerged loss printed its own opening clause twice.
test("a loss label is a scannable classifier, not a paraphrase of the sentence beside it", () => {
  const compact = formatWorkflowResult("archive", archivePreview(), "compact");
  const line = compact.split("\n").find((entry) => entry.startsWith("backend | "));

  assert.match(line, /^backend \| UNMERGED \(3\): 3 commit\(s\) on feature\/registro-impl are not in dev/);
  // The count and the branch appear once each in the label's slot; the sentence is not restated.
  assert.equal(line.match(/not in dev/g).length, 1);
  assert.equal(line.match(/feature\/registro-impl/g).length, 1);
});
