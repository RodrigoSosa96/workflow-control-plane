import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWorkflowResult } from "../src/workflow/format.js";

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
