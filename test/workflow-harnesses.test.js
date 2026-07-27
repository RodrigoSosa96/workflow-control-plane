import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaudeWorkerSettings, buildHarnessLaunch } from "../src/workflow/harnesses.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RUN = Object.freeze({
  id: RUN_ID,
  directory: "/state/runs/11111111-1111-4111-8111-111111111111",
  generation: 3,
  stateRoot: "/state/runs",
  controlPlaneBin: "/control/bin/workflow",
  originalRequest: "Implement OCR payment extraction with SECRET-DO-NOT-LEAK",
});
const SESSION_NAME = "ocr-A-1-fix";
const CWD = "/wt/ocr/A-1-fix";

function profile(overrides) {
  return {
    harness: "pi",
    command: "pi",
    mode: "interactive",
    roles: ["implementer"],
    model: null,
    arguments: [],
    ...overrides,
  };
}

function assertRunLaunch(spec, harness) {
  assert.deepEqual(spec.env, {
    WORKFLOW_RUN_ID: RUN_ID,
    WORKFLOW_RUN_DIR: RUN.directory,
    WORKFLOW_GENERATION: "3",
    WORKFLOW_HARNESS: harness,
    WORKFLOW_STATE_ROOT: RUN.stateRoot,
    WORKFLOW_CONTROL_PLANE_BIN: RUN.controlPlaneBin,
  });
  assert.deepEqual(Object.keys(spec.env), [
    "WORKFLOW_RUN_ID",
    "WORKFLOW_RUN_DIR",
    "WORKFLOW_GENERATION",
    "WORKFLOW_HARNESS",
    "WORKFLOW_STATE_ROOT",
    "WORKFLOW_CONTROL_PLANE_BIN",
  ]);
  assert.equal(spec.argv.every((value) => typeof value === "string" && value.length > 0), true);

  const bootstrap = spec.argv.at(-1);
  assert.match(bootstrap, /assignment\.md/);
  assert.match(bootstrap, /handoff-input\.json/);
  assert.match(bootstrap, /node "\$WORKFLOW_CONTROL_PLANE_BIN" handoff "\$WORKFLOW_RUN_ID" --input "\$WORKFLOW_RUN_DIR\/handoff-input\.json"/);
  assert.doesNotMatch(bootstrap, /write[^.]*result\.json|SECRET-DO-NOT-LEAK|payment extraction|originalRequest/i);
  assert.ok(bootstrap.length <= 500, `bootstrap prompt should be bounded, got ${bootstrap.length}`);
}

test("builds exact safe argv arrays and run env for Pi, Claude, and Codex profiles", () => {
  const piSpec = buildHarnessLaunch({
    profileName: "pi-worker",
    profile: profile({ arguments: ["--plain-output"] }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });

  assert.deepEqual(piSpec.argv.slice(0, 5), ["pi", "--name", "ocr-A-1-fix", "--session-id", piSpec.expected.nativeSessionId]);
  assert.match(piSpec.expected.nativeSessionId, UUID_RE);
  assert.equal(piSpec.expected.profileName, "pi-worker");
  assert.equal(piSpec.expected.harness, "pi");
  assert.equal(piSpec.argv.at(-2), "--plain-output");
  assert.equal(piSpec.argv.includes("--model"), false);
  assertRunLaunch(piSpec, "pi");

  const claudeSpec = buildHarnessLaunch({
    profileName: "claude-worker",
    profile: profile({
      harness: "claude",
      command: "claude",
      model: "claude-3-5-sonnet-latest",
      arguments: ["--verbose"],
      permission_mode: "manual",
    }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });

  assert.equal(claudeSpec.argv[0], "claude");
  assert.ok(claudeSpec.argv.includes("--session-id"));
  assert.match(claudeSpec.expected.nativeSessionId, UUID_RE);
  assert.ok(claudeSpec.argv.includes("--permission-mode"));
  assert.ok(claudeSpec.argv.includes("manual"));
  assert.ok(claudeSpec.argv.includes("--add-dir"));
  assert.equal(claudeSpec.argv[claudeSpec.argv.indexOf("--add-dir") + 1], RUN.directory);
  assert.equal(claudeSpec.argv.includes(CWD), false);
  assert.ok(claudeSpec.argv.includes("--model"));
  assert.ok(claudeSpec.argv.includes("claude-3-5-sonnet-latest"));
  assert.equal(claudeSpec.argv.at(-2), "--verbose");
  assertRunLaunch(claudeSpec, "claude");

  const codexSpec = buildHarnessLaunch({
    profileName: "codex-worker",
    profile: profile({
      harness: "codex",
      command: "codex",
      model: "gpt-5-codex",
      arguments: ["--config", "ui=false"],
      sandbox: "workspace-write",
      approval_policy: "on-request",
    }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });

  assert.deepEqual(codexSpec.argv.slice(0, 3), ["codex", "-C", "/wt/ocr/A-1-fix"]);
  assert.ok(codexSpec.argv.includes("workspace-write"));
  assert.ok(codexSpec.argv.includes("on-request"));
  assert.ok(codexSpec.argv.includes("--add-dir"));
  assert.equal(codexSpec.argv[codexSpec.argv.indexOf("--add-dir") + 1], RUN.directory);
  assert.ok(codexSpec.argv.includes("--model"));
  assert.ok(codexSpec.argv.includes("gpt-5-codex"));
  assert.equal(codexSpec.argv.at(-3), "--config");
  assert.equal(codexSpec.argv.at(-2), "ui=false");
  assert.equal(codexSpec.expected.nativeSessionId, null);
  assert.equal(codexSpec.expected.profileName, "codex-worker");
  assert.equal(codexSpec.expected.harness, "codex");
  assertRunLaunch(codexSpec, "codex");
});

test("builds a structured OpenCode run argv without session recovery flags", () => {
  const spec = buildHarnessLaunch({
    profileName: "opencode-worker",
    profile: profile({
      harness: "opencode",
      command: "opencode",
      mode: "stream-json",
      model: "provider/model",
      arguments: [],
      availability: "fixture-only",
    }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });

  assert.deepEqual(spec.argv.slice(0, 6), ["opencode", "run", "--format", "json", "--title", SESSION_NAME]);
  assert.equal(spec.argv.includes("--continue"), false);
  assert.equal(spec.argv.includes("--session"), false);
  assert.equal(spec.argv.includes("--model"), true);
  assert.equal(spec.expected.harness, "opencode");
  assert.equal(spec.expected.nativeSessionId, null);
  assertRunLaunch(spec, "opencode");
});

test("asks Pi for the non-interactive JSON event stream in stream-json mode", () => {
  const spec = buildHarnessLaunch({
    profileName: "pi-worker",
    profile: profile({ mode: "stream-json" }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });

  // The supervisor reads LF-delimited JSON from stdout, so Pi has to be told to emit it
  // and to exit rather than hold an interactive TUI open.
  assert.deepEqual(spec.argv.slice(0, 7), [
    "pi",
    "--name",
    SESSION_NAME,
    "--session-id",
    spec.expected.nativeSessionId,
    "--print",
    "--mode",
  ]);
  assert.equal(spec.argv[7], "json");
  assertRunLaunch(spec, "pi");
});

test("keeps interactive Pi starts free of the JSON stream flags", () => {
  const spec = buildHarnessLaunch({
    profileName: "pi-worker",
    profile: profile({ mode: "interactive" }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });

  assert.equal(spec.argv.includes("--print"), false);
  assert.equal(spec.argv.includes("--mode"), false);
});

test("pi interactive argv loads the workflow worker extensions", () => {
  const spec = buildHarnessLaunch({
    profileName: "pi-worker",
    profile: profile({ mode: "interactive" }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });
  const joined = spec.argv.join(" ");
  assert.match(joined, /--extension .*workflow-worker-lifecycle/);
  assert.match(joined, /--extension .*workflow-worker-observability/);
});

test("pi stream-json argv does not load the interactive-only workflow worker extensions", () => {
  const spec = buildHarnessLaunch({
    profileName: "pi-worker",
    profile: profile({ mode: "stream-json" }),
    sessionName: SESSION_NAME,
    cwd: CWD,
    run: RUN,
  });
  assert.equal(spec.argv.includes("--extension"), false);
});

test("preserves legacy no-prompt Pi starts when no run is supplied", () => {
  const spec = buildHarnessLaunch({
    profileName: "pi-worker",
    profile: profile({ arguments: ["--safe"] }),
    sessionName: SESSION_NAME,
    cwd: CWD,
  });

  assert.deepEqual(spec.argv, ["pi", "--name", SESSION_NAME, "--safe"]);
  assert.deepEqual(spec.env, {});
  assert.deepEqual(spec.expected, {
    profileName: "pi-worker",
    harness: "pi",
    sessionName: SESSION_NAME,
    cwd: CWD,
    nativeSessionId: null,
  });
});

test("claude worker settings wire lifecycle hooks and a statusLine to control-plane scripts", () => {
  const s = buildClaudeWorkerSettings({ controlPlaneRoot: "/cp" });
  // SessionStart is intentionally NOT wired: it would consume the LAUNCHING→RUNNING
  // transition and push every generation off-by-one. UserPromptSubmit is the sole work-start.
  assert.deepEqual(Object.keys(s.hooks).sort(), ["SessionEnd", "Stop", "UserPromptSubmit"]);
  assert.equal(s.hooks.SessionStart, undefined);
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmd = s.hooks[ev][0].hooks[0].command;
    assert.match(cmd, /\/cp\/hooks\/claude-lifecycle\.mjs/);
    // The script path must be double-quoted so a control-plane path containing a space is
    // passed as a single argument instead of being split by the shell.
    assert.ok(cmd.includes(`node "/cp/hooks/claude-lifecycle.mjs" ${ev}`), `command must quote the script path: ${cmd}`);
    assert.equal(s.hooks[ev][0].hooks[0].type, "command");
  }
  assert.match(s.statusLine.command, /\/cp\/hooks\/claude-statusline\.mjs/);
  assert.ok(s.statusLine.command.includes(`node "/cp/hooks/claude-statusline.mjs"`), "statusLine command must quote the script path");
  assert.equal(s.statusLine.type, "command");
});

test("claude worker settings allow the worker's tools so --permission-mode dontAsk never denies", () => {
  const s = buildClaudeWorkerSettings({ controlPlaneRoot: "/cp" });
  assert.ok(Array.isArray(s.permissions?.allow), "permissions.allow must be an array");
  // A bare tool name allows all uses of that tool. The worker must read/edit/write in its
  // worktree and run bash (tests + the handoff command) without a denial that triggers a
  // retry loop and wastes tokens.
  for (const tool of ["Bash", "Read", "Write", "Edit"]) {
    assert.ok(s.permissions.allow.includes(tool), `permissions.allow must include ${tool}`);
  }
  // hooks and statusLine must be unchanged by adding permissions.
  assert.deepEqual(Object.keys(s.hooks).sort(), ["SessionEnd", "Stop", "UserPromptSubmit"]);
  assert.equal(s.statusLine.type, "command");
});

test("interactive claudeArgv appends --settings; stream-json does not", () => {
  const run = { id: "r", directory: "/state/r", generation: 1, stateRoot: "/state", controlPlaneBin: "/cp/bin/workflow.js" };
  const interactive = buildHarnessLaunch({ profileName: "claude-worker",
    profile: { harness: "claude", command: "claude", mode: "interactive", model: null, arguments: [], permission_mode: "manual" },
    sessionName: "s", cwd: "/wt", run, settingsPath: "/state/r/claude-worker-settings.json" });
  assert.ok(interactive.argv.includes("--settings"));
  assert.equal(interactive.argv[interactive.argv.indexOf("--settings") + 1], "/state/r/claude-worker-settings.json");

  const streamed = buildHarnessLaunch({ profileName: "claude-worker",
    profile: { harness: "claude", command: "claude", mode: "stream-json", model: null, arguments: [], permission_mode: "manual" },
    sessionName: "s", cwd: "/wt", run });
  assert.ok(!streamed.argv.includes("--settings"));
});
