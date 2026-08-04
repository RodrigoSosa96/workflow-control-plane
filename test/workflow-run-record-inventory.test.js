import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createRunStore } from "../src/workflow/run-store.js";
import { createLaunchPreview, executeLaunch } from "../src/workflow/launch.js";
import { createLifecycle } from "../src/workflow/lifecycle.js";
import { runLifecycleHook } from "../hooks/lib/lifecycle-hook-core.mjs";
import { createTelemetryStore } from "../src/workflow/telemetry-store.js";
import { createDelegationStore } from "../src/workflow/delegation-store.js";
import { submitHandoff, readCurrentResult } from "../src/workflow/handoff.js";
import { executeResume } from "../src/workflow/resume.js";
import { createFakeWorkerTransport } from "../src/workflow/worker-transport.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

// This test's job is narrow and stated in docs/run-record-fields.md's "Scope" section: build one
// run record through real store operations plus a representative slice of the modules that write
// to it, then assert every top-level key that record carries is named (as inline code) somewhere
// in that document. It is not a schema validator and it does not check that a documented field's
// "written by" text or meaning is accurate — see the doc's own reach/limits section for the full
// list of what this check does and does not cover.

const DOC_PATH = new URL("../docs/run-record-fields.md", import.meta.url);

const STATE_ROOT_LABEL = "/state/workflow";
const CONTROL_PLANE_BIN_LABEL = "/repo/bin/workflow.js";
const TASK = "ASANA-9001";
const RELATED_TICKETS = ["ASANA-9002"];
const WORKTREE_PATH = "/worktrees/ocr/ASANA-9001-app";
const BRANCH = "feature/ASANA-9001/app-inventory";

const PI_SESSION_IDENTITY = Object.freeze({
  kind: "pi-session",
  sessionId: "sess-1",
  paneId: "pane-1",
  tabId: "tab-1",
  harness: "pi",
});
const RELAUNCH_SESSION_IDENTITY = Object.freeze({
  kind: "pi-session",
  sessionId: "sess-2",
  paneId: "pane-2",
  tabId: "tab-2",
  harness: "pi",
});

// Extracts every field name that heads a table row (line-anchored `| \`name\` |`) from the
// document, rather than every inline-code span. A prose sentence that merely mentions a field
// name in backticks — or a module/function name that happens to look like one — does not land in
// this set: a stray backtick match used to widen the "documented" set and silently hide a real
// gap (a field could pass just by being named in passing prose, never in its own table row); this
// line-anchored form makes that impossible; only a name that actually heads a table row counts as
// documented. See docs/run-record-fields.md's "Scope" section for why `directory` and
// `consumedAt` are deliberately kept out of every table — with this extraction, the check now
// agrees with the document and treats them as undocumented too.
function extractDocumentedFieldNames(docText) {
  const documented = new Set();
  for (const match of docText.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \|/gm)) {
    documented.add(match[1]);
  }
  return documented;
}

// The reusable comparison both the main test and the load-bearing regression tests below share:
// every top-level key of `record` must head a table row in `docText`. Returns the missing keys
// (empty when the record is fully documented) rather than asserting directly, so callers can
// inspect the failure shape instead of only its presence.
export function undocumentedFields(record, docText) {
  const documented = extractDocumentedFieldNames(docText);
  return Object.keys(record).filter((key) => !documented.has(key));
}

function buildReconciliation() {
  const tickets = [TASK, ...RELATED_TICKETS];
  return {
    mode: "ordinary",
    status: "incomplete",
    conflicts: [],
    identity: {
      projectAlias: "ocr",
      projectLabel: "ExampleProject",
      task: TASK,
      primaryTicket: TASK,
      relatedTickets: RELATED_TICKETS,
      tickets,
      feature: "Inventory Fixture",
      slug: "inventory-fixture",
    },
    repositories: [{
      alias: "app",
      path: "/repo/app",
      baseBranch: "dev",
      branch: BRANCH,
      worktreePath: WORKTREE_PATH,
    }],
    worktrees: [{
      role: "primary",
      alias: "app",
      path: WORKTREE_PATH,
      branch: BRANCH,
      baseBranch: "dev",
      repositoryPath: "/repo/app",
      label: `${TASK} app`,
    }],
    agent: {
      command: "pi",
      sessionName: `ocr-${TASK}`,
      tabLabel: "agent",
      worktreePath: WORKTREE_PATH,
      profileName: "pi-worker",
      selectionSource: "explicit",
      harness: "pi",
      roles: ["coordinator", "implementer"],
      profile: { mode: "interactive", model: null, arguments: [] },
      status: "missing",
      actual: null,
    },
    operations: [
      {
        id: "agent",
        kind: "agent.session.start",
        phase: "start",
        cwd: WORKTREE_PATH,
        command: "pi",
        sessionName: `ocr-${TASK}`,
        tabLabel: "agent",
        reconciliation: { status: "missing", reason: "agent is missing" },
      },
    ],
  };
}

async function fakePlanCommand() {
  const reconciliation = buildReconciliation();
  return {
    command: "plan",
    project: { alias: "ocr", label: "ExampleProject" },
    request: {
      task: reconciliation.identity.task,
      tickets: reconciliation.identity.tickets,
      relatedTickets: reconciliation.identity.relatedTickets,
      feature: reconciliation.identity.feature,
      repositories: ["app"],
      runtimeProfile: null,
    },
    preconditions: {
      git: { id: "binary:git", status: "ready" },
      herdr: { id: "binary:herdr", status: "ready" },
      herdrStatus: { id: "herdr:status", status: "ready" },
      agent: { id: "binary:pi", status: "ready" },
      agentIntegration: { id: "herdr:integration:pi", status: "ready" },
    },
    reconciliation,
    conflicts: [],
  };
}

async function fakeExecuteStart() {
  return {
    status: "completed",
    operations: [{
      id: "agent",
      kind: "agent.session.start",
      status: "created",
      agentId: "agent-1",
      tabId: "tab-1",
      paneId: "pane-1",
      sessionIdentity: PI_SESSION_IDENTITY,
    }],
    notes: [],
  };
}

// A stateful git fingerprint stub: the first call (from submitHandoff) records one digest; every
// call after (from readCurrentResult, driven deliberately below) returns a different one, so the
// worktree-fingerprint comparison in handoff.js's collectResultShapeErrors finds a mismatch and
// readCurrentResult routes the run through markResultStale — the only way to reach `resultStaleAt`
// short of calling that unexported function directly.
function fingerprintDriftingGit() {
  let calls = 0;
  return {
    async fingerprint() {
      calls += 1;
      return {
        head: calls === 1 ? "head-a" : "head-b",
        branch: BRANCH,
        dirty: false,
        entries: 0,
        digest: calls === 1 ? "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
    },
  };
}

// Builds one run record by driving the store's own operations plus the representative lanes
// named in docs/run-record-fields.md's "Scope" section: launch, lifecycle, the shared lifecycle
// hook core (pi harness), telemetry, delegation, a structured handoff plus a forced stale-result
// read, and a confirmed resume relaunch. Returns the record exactly as persisted on disk (not the
// in-memory shape store.read() returns, which additionally carries a non-persisted `directory`).
async function buildRepresentativeRecord(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "workflow-run-record-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createRunStore({ stateRoot: join(root, "state") });

  const preview = await createLaunchPreview({
    request: "Investigate the inventory fixture.",
    projectAlias: "ocr",
    task: TASK,
    tickets: RELATED_TICKETS,
    repositories: ["app"],
    agentProfile: "pi-worker",
    stateRoot: STATE_ROOT_LABEL,
    controlPlaneBin: CONTROL_PLANE_BIN_LABEL,
    originSession: { harness: "pi", sessionId: "pi:origin-session-1" },
  }, { planCommand: fakePlanCommand });

  const report = await executeLaunch(preview, {
    planCommand: fakePlanCommand,
    store,
    stateRoot: STATE_ROOT_LABEL,
    controlPlaneBin: CONTROL_PLANE_BIN_LABEL,
    executeStart: fakeExecuteStart,
  });
  assert.equal(report.status, "running", "fixture launch must succeed for the rest of this build to be reachable");
  const runId = report.runId;

  const lifecycle = createLifecycle({ store });
  const hookEnv = { WORKFLOW_RUN_ID: runId, WORKFLOW_HARNESS: "pi" };

  // A follow-up prompt: generation 2 > the launch's generation 1, so lifecycle.onPrompt takes its
  // follow-up branch and writes stopAttempts/previousGeneration alongside the generation bump.
  await lifecycle.onPrompt({ runId, generation: 2, source: "user" });
  // A Stop without a valid handoff, under the attempt budget: action "continue", stopAttempts: 1.
  await lifecycle.onStop({ runId, generation: 2, hasValidHandoff: false });
  // The shared hook core's first UserPromptSubmit for this run: piStartedOnce becomes true.
  await runLifecycleHook({ harness: "pi", event: "UserPromptSubmit", stdinJson: {}, env: hookEnv, store, lifecycle });
  // A Stop whose action is "continue" (second attempt, still under budget): piPendingContinuation
  // becomes true.
  await runLifecycleHook({
    harness: "pi",
    event: "Stop",
    stdinJson: {},
    env: hookEnv,
    store,
    lifecycle,
    hasValidHandoff: async () => false,
  });

  const telemetry = createTelemetryStore({ store });
  await telemetry.record({ runId, workerId: runId, event: { type: "lifecycle", harness: "pi", phase: "running" } });

  const delegations = createDelegationStore({ store });
  await delegations.prepare({
    runId,
    input: {
      role: "scout",
      mode: "foreground",
      originSessionId: "pi:origin-session-1",
      cwd: WORKTREE_PATH,
      brief: "Investigate the inventory fixture's delegated scope.",
      task: "Investigate the inventory fixture's delegated scope in detail.",
      budget: { maxRuntimeMs: 600000, concurrency: 1, maxTurns: 5, maxToolCalls: 20 },
    },
  });

  const git = fingerprintDriftingGit();
  const beforeHandoff = await store.read(runId);
  assert.equal(beforeHandoff.state, RUN_STATES.IDLE_AWAITING_HANDOFF, "fixture must reach a handoff-accepting state before submitHandoff");
  await submitHandoff({
    store,
    git,
    runId,
    generation: beforeHandoff.generation,
    input: {
      version: 1,
      status: "completed",
      summary: "Inventory fixture handoff.",
      tickets: [
        { id: TASK, status: "completed", evidence: ["done"] },
        { id: RELATED_TICKETS[0], status: "completed", evidence: ["done"] },
      ],
      changedFiles: ["src/index.js"],
      verification: [{ command: "npm test", status: "passed", summary: "ok" }],
      decisions: [],
      concerns: [],
      nextAction: "none",
    },
  });
  // A second, differing fingerprint (see fingerprintDriftingGit) makes this read detect drift and
  // route through the internal markResultStale, producing resultStaleAt.
  await readCurrentResult({ store, git, runId });

  const transport = createFakeWorkerTransport({ observations: [{ state: "missing", identity: PI_SESSION_IDENTITY }] });
  await executeResume({
    store,
    transport,
    runId,
    confirmed: true,
    relaunch: async () => ({ identity: RELAUNCH_SESSION_IDENTITY }),
  });

  const finalRun = await store.read(runId);
  const raw = await readFile(join(finalRun.directory, "run.json"), "utf8");
  return JSON.parse(raw);
}

test("every field the representative record carries is documented in docs/run-record-fields.md", async (t) => {
  const record = await buildRepresentativeRecord(t);
  const docText = await readFile(DOC_PATH, "utf8");
  const missing = undocumentedFields(record, docText);
  assert.deepEqual(missing, [], `undocumented run record field(s): ${missing.join(", ")}`);

  // A sanity floor on the fixture itself: if this collapses well below the fields the writers in
  // launch.js/lifecycle.js/lifecycle-hook-core.mjs/handoff.js/telemetry-store.js/
  // delegation-store.js/resume.js are known to produce, the fixture regressed silently rather than
  // the check losing coverage quietly.
  assert.ok(Object.keys(record).length >= 40, `expected a richly-populated fixture record, got ${Object.keys(record).length} keys`);
});

test("the inventory check is load-bearing: a field missing from the document fails it", () => {
  const docText = "| `version` | Meaning | When | Yes |\n| `id` | Meaning | When | Yes |\n";
  const missing = undocumentedFields({ version: 1, id: "r1", state: "running", totallyUndocumentedField: true }, docText);
  assert.deepEqual(missing, ["state", "totallyUndocumentedField"]);
});

test("the inventory check passes once every field heads a table row in the document", () => {
  const docText = "| `version` | Meaning | When | Yes |\n| `id` | Meaning | When | Yes |\n| `state` | Meaning | When | Yes |\n";
  const missing = undocumentedFields({ version: 1, id: "r1", state: "running" }, docText);
  assert.deepEqual(missing, []);
});

test("a field merely mentioned in prose, not heading a table row, does not count as documented", () => {
  const docText = "the internal record shape (`role`, `state`, `budget`, `result`, `remediation`, ...) is out of scope here.\n" +
    "| `version` | Meaning | When | Yes |\n";
  const missing = undocumentedFields({ version: 1, role: "scout", budget: {} }, docText);
  assert.deepEqual(missing, ["role", "budget"]);
});
