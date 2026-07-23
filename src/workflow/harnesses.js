import { randomUUID } from "node:crypto";
import { HANDOFF_COMMAND } from "./assignment.js";

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

function runEnv(run, harness) {
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
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  const bootstrap = runBootstrapPrompt(run);
  if (bootstrap) argv.push(bootstrap);
  return argv;
}

function claudeArgv({ profile, cwd, run, nativeSessionId }) {
  const argv = [profile.command];
  if (run) argv.push("--session-id", nativeSessionId);
  argv.push("--permission-mode", assertString(profile.permission_mode, "profile.permission_mode"));
  argv.push("--add-dir", run ? assertString(run.directory, "run.directory") : cwd);
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

export function buildHarnessLaunch({ profileName, profile, sessionName, cwd, run, nativeSessionId: requestedNativeSessionId } = {}) {
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
    argv = claudeArgv({ profile, cwd, run, nativeSessionId });
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
