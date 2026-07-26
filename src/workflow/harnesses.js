import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HANDOFF_COMMAND } from "./assignment.js";

export const CONTROL_PLANE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PI_WORKER_EXTENSIONS = [
  join(CONTROL_PLANE_ROOT, ".pi/extensions/workflow-worker-lifecycle.ts"),
  join(CONTROL_PLANE_ROOT, ".pi/extensions/workflow-worker-observability.ts"),
];

// The Claude analog of PI_WORKER_EXTENSIONS: lifecycle/telemetry state for an interactive
// Claude worker is derived by the control plane's own hook scripts rather than parsed from
// stdout (Claude has no non-interactive JSON event stream comparable to Pi's --mode json), so
// these are wired in via `--settings` instead of `--extension`.
export const CLAUDE_WORKER_HOOKS = Object.freeze(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);

export const WORKFLOW_ENV_KEYS = Object.freeze([
  "WORKFLOW_RUN_ID",
  "WORKFLOW_RUN_DIR",
  "WORKFLOW_GENERATION",
  "WORKFLOW_HARNESS",
  "WORKFLOW_STATE_ROOT",
  "WORKFLOW_CONTROL_PLANE_BIN",
]);

const HARNESSES = new Set(["pi", "claude", "codex", "opencode"]);

function assertString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function assertProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("profile must be an object");
  }
  const harness = assertString(profile.harness, "profile.harness");
  if (!HARNESSES.has(harness)) {
    throw new TypeError(`Unsupported harness: ${harness}`);
  }
  assertString(profile.command, "profile.command");
  if (!Array.isArray(profile.arguments) || profile.arguments.some((argument) => typeof argument !== "string" || argument.length === 0)) {
    throw new TypeError("profile.arguments must be an array of non-empty strings");
  }
  return profile;
}

function appendModel(argv, model) {
  if (model !== null && model !== undefined) {
    argv.push("--model", assertString(model, "profile.model"));
  }
}

export function runEnv(run, harness) {
  if (!run) return {};
  const env = {
    WORKFLOW_RUN_ID: assertString(run.id, "run.id"),
    WORKFLOW_RUN_DIR: assertString(run.directory, "run.directory"),
    WORKFLOW_GENERATION: String(run.generation ?? 1),
    WORKFLOW_HARNESS: harness,
    WORKFLOW_STATE_ROOT: assertString(run.stateRoot, "run.stateRoot"),
    WORKFLOW_CONTROL_PLANE_BIN: assertString(run.controlPlaneBin, "run.controlPlaneBin"),
  };
  return Object.fromEntries(WORKFLOW_ENV_KEYS.map((key) => [key, env[key]]));
}

// Builds the Claude `--settings` payload that wires the control plane's lifecycle/telemetry
// hooks and statusLine into an interactive Claude worker. The commands embed an absolute
// control-plane path that differs per machine/worktree, so this must be computed at launch
// time rather than shipped as a static committed settings file (mirrors PI_WORKER_EXTENSIONS,
// which is likewise derived from the running module's own location).
export function buildClaudeWorkerSettings({ controlPlaneRoot } = {}) {
  assertString(controlPlaneRoot, "controlPlaneRoot");
  const lifecycleScript = join(controlPlaneRoot, "hooks", "claude-lifecycle.mjs");
  const statuslineScript = join(controlPlaneRoot, "hooks", "claude-statusline.mjs");
  const hooks = Object.fromEntries(CLAUDE_WORKER_HOOKS.map((event) => [
    event,
    [{ hooks: [{ type: "command", command: `node ${lifecycleScript} ${event}` }] }],
  ]));
  return {
    hooks,
    statusLine: { type: "command", command: `node ${statuslineScript}` },
  };
}

function runBootstrapPrompt(run) {
  if (!run) return null;
  return `Read "$WORKFLOW_RUN_DIR/assignment.md". Complete the assignment. Write structured handoff JSON only to "$WORKFLOW_RUN_DIR/handoff-input.json", then run exactly: ${HANDOFF_COMMAND}`;
}

function expectedLaunch({ profileName, profile, sessionName, cwd, nativeSessionId }) {
  return {
    profileName,
    harness: profile.harness,
    sessionName,
    cwd,
    nativeSessionId,
  };
}

function piArgv({ profile, sessionName, run, nativeSessionId }) {
  const argv = [profile.command, "--name", sessionName];
  if (run) argv.push("--session-id", nativeSessionId);
  // A supervised run reads Pi's LF-delimited JSON events from stdout, so Pi must emit
  // them and exit instead of holding an interactive session open.
  if (profile.mode === "stream-json") argv.push("--print", "--mode", "json");
  // The headless supervisor path (stream-json) already derives lifecycle/telemetry
  // state by parsing Pi's stdout event stream, so loading these extensions there
  // would double-write state. Only interactive runs need them wired via --extension.
  if (run && profile.mode === "interactive") {
    for (const ext of PI_WORKER_EXTENSIONS) argv.push("--extension", ext);
  }
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  const bootstrap = runBootstrapPrompt(run);
  if (bootstrap) argv.push(bootstrap);
  return argv;
}

function claudeArgv({ profile, cwd, run, nativeSessionId, settingsPath }) {
  const argv = [profile.command];
  if (run) argv.push("--session-id", nativeSessionId);
  argv.push("--permission-mode", assertString(profile.permission_mode, "profile.permission_mode"));
  argv.push("--add-dir", run ? assertString(run.directory, "run.directory") : cwd);
  // Supervised (stream-json) Claude runs are headless and short-lived, driven entirely by the
  // supervisor process — loading the interactive worker's lifecycle/statusLine hooks there would
  // be inert at best and could double-write state the supervisor already derives itself. Only
  // interactive runs need them wired via --settings.
  if (run && profile.mode === "interactive" && settingsPath) {
    argv.push("--settings", assertString(settingsPath, "settingsPath"));
  }
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  const bootstrap = runBootstrapPrompt(run);
  if (bootstrap) argv.push(bootstrap);
  return argv;
}

function codexArgv({ profile, cwd, run }) {
  const argv = [profile.command, "-C", cwd];
  if (run) argv.push("--add-dir", assertString(run.directory, "run.directory"));
  argv.push("--sandbox", assertString(profile.sandbox, "profile.sandbox"));
  argv.push("--ask-for-approval", assertString(profile.approval_policy, "profile.approval_policy"));
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  const bootstrap = runBootstrapPrompt(run);
  if (bootstrap) argv.push(bootstrap);
  return argv;
}

function opencodeArgv({ profile, sessionName, run }) {
  const argv = [profile.command, "run", "--format", "json", "--title", sessionName];
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  const bootstrap = runBootstrapPrompt(run);
  if (bootstrap) argv.push(bootstrap);
  return argv;
}

export function buildHarnessLaunch({ profileName, profile, sessionName, cwd, run, nativeSessionId: requestedNativeSessionId, settingsPath } = {}) {
  assertString(profileName, "profileName");
  assertProfile(profile);
  assertString(sessionName, "sessionName");
  assertString(cwd, "cwd");

  const nativeSessionId = run && (profile.harness === "pi" || profile.harness === "claude")
    ? requestedNativeSessionId === undefined
      ? randomUUID()
      : assertString(requestedNativeSessionId, "nativeSessionId")
    : null;
  let argv;
  if (profile.harness === "pi") {
    argv = piArgv({ profile, sessionName, run, nativeSessionId });
  } else if (profile.harness === "claude") {
    argv = claudeArgv({ profile, cwd, run, nativeSessionId, settingsPath });
  } else if (profile.harness === "codex") {
    argv = codexArgv({ profile, cwd, run });
  } else {
    argv = opencodeArgv({ profile, sessionName, run });
  }

  return {
    argv,
    env: runEnv(run, profile.harness),
    expected: expectedLaunch({ profileName, profile, sessionName, cwd, nativeSessionId }),
  };
}
