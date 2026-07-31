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
//
// SessionStart is intentionally NOT wired: it fires before any real prompt and would consume
// the LAUNCHING→RUNNING transition, so the first real UserPromptSubmit would be misread as a
// follow-up and increment the generation to 2. UserPromptSubmit is the single work-start
// driver (matching Pi's agent_start), so generation 1 lines up with the first prompt.
export const CLAUDE_WORKER_HOOKS = Object.freeze(["UserPromptSubmit", "Stop", "SessionEnd"]);

// The worker runs with `--permission-mode dontAsk`, which auto-DENIES a tool unless an
// allowlist grants it. A denial makes Claude retry, wasting tokens (observed in the human/TTY
// e2e), so the worker's full toolset is allowlisted with ZERO denials. In Claude settings a
// bare tool name (e.g. "Bash") allows every use of that tool; a parenthesized form
// ("Bash(cmd:*)") would scope it, which is not what a trusted worktree worker needs.
export const CLAUDE_WORKER_ALLOWED_TOOLS = Object.freeze([
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
]);

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

// The filename an interactive Claude worker's `--settings` payload (built below) is written to
// in the run directory. launch.js writes it, commands.js regenerates it on relaunch, and
// claudeArgv points --settings at it — one definition shared by all three.
export const CLAUDE_WORKER_SETTINGS_FILE = "claude-worker-settings.json";

// Builds the Claude `--settings` payload that wires the control plane's lifecycle/telemetry
// hooks and statusLine into an interactive Claude worker. The commands embed an absolute
// control-plane path that differs per machine/worktree, so this must be computed at launch
// time rather than shipped as a static committed settings file (mirrors PI_WORKER_EXTENSIONS,
// which is likewise derived from the running module's own location).
export function buildClaudeWorkerSettings({ controlPlaneRoot } = {}) {
  assertString(controlPlaneRoot, "controlPlaneRoot");
  const lifecycleScript = join(controlPlaneRoot, "hooks", "claude-lifecycle.mjs");
  const statuslineScript = join(controlPlaneRoot, "hooks", "claude-statusline.mjs");
  // The script paths are absolute and per-machine/worktree, so they can contain spaces.
  // Double-quote them so the shell keeps each path a single argument instead of splitting
  // it (which would silently break the hook).
  const hooks = Object.fromEntries(CLAUDE_WORKER_HOOKS.map((event) => [
    event,
    [{ hooks: [{ type: "command", command: `node "${lifecycleScript}" ${event}` }] }],
  ]));
  return {
    hooks,
    statusLine: { type: "command", command: `node "${statuslineScript}"` },
    permissions: { allow: [...CLAUDE_WORKER_ALLOWED_TOOLS] },
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

// One argv builder per harness, called by BOTH `workflow launch` (buildHarnessLaunch) and
// `workflow resume` (buildHarnessResume). A launch and a resume of the same profile differ in
// exactly two things, and neither of them is a flag: the `sessionForm` argument — the tokens that
// name the native session, which each harness spells differently — and the launch-only bootstrap
// prompt appended by buildHarnessLaunch. Every flag the profile contributes is written here once.
//
// It used to be written twice: `workflow resume` hand-assembled its own argv per harness, and the
// two drifted, so a resumed worker ran outside the security envelope its approval covered — the
// claude resume dropped `--permission-mode`, the codex resume dropped `--sandbox` and answered
// `-a never` in place of the approved `--ask-for-approval`. Adding a flag to a launch without
// adding it to the resume is now structurally impossible rather than merely discouraged.
//
// With one honest exception, which is why buildHarnessResume carries an extra assertion: Claude's
// `--settings` is gated on the caller-supplied `settingsPath`, not on the profile, so a caller
// that omits it gets an argv with the flag silently missing. Both entry points therefore have to
// guarantee the argument for an interactive Claude run — launch.js passes it (see
// isClaudeInteractiveAgent in launch.js), and buildHarnessResume demands it instead of trusting
// its caller. Any future flag gated on an argument rather than on the profile needs the same
// treatment; a flag derived from the profile alone needs none.

function piArgv({ profile, sessionName, run, sessionForm }) {
  const argv = [profile.command, "--name", sessionName, ...sessionForm];
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
  return argv;
}

function claudeArgv({ profile, cwd, run, sessionForm, settingsPath }) {
  const argv = [profile.command, ...sessionForm];
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
  return argv;
}

function codexArgv({ profile, cwd, run, sessionForm }) {
  // The session form goes first because Codex's is positional (`codex resume <id>`) and must
  // precede -C and every flag; at launch it is empty, since Codex has no session flag there.
  const argv = [profile.command, ...sessionForm, "-C", cwd];
  if (run) argv.push("--add-dir", assertString(run.directory, "run.directory"));
  argv.push("--sandbox", assertString(profile.sandbox, "profile.sandbox"));
  argv.push("--ask-for-approval", assertString(profile.approval_policy, "profile.approval_policy"));
  // The interactive worker's lifecycle hook (wired via Codex's notify/config) would otherwise
  // trigger a per-invocation trust prompt; a supervised stream-json/exec run is headless and
  // has no one to answer that prompt, so only interactive runs get the bypass.
  if (run && profile.mode === "interactive") {
    argv.push("--dangerously-bypass-hook-trust");
  }
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  return argv;
}

function opencodeArgv({ profile, sessionName }) {
  // OpenCode names no session at all — no launch flag and no resume form (see
  // RESUME_SESSION_FORM), so it takes no sessionForm.
  const argv = [profile.command, "run", "--format", "json", "--title", sessionName];
  appendModel(argv, profile.model);
  argv.push(...profile.arguments);
  return argv;
}

const HARNESS_ARGV = Object.freeze({
  pi: piArgv,
  claude: claudeArgv,
  codex: codexArgv,
  opencode: opencodeArgv,
});

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
  // pi and claude are the only harnesses that name a session at launch, and nativeSessionId is
  // non-null for exactly those two (codex has no session flag at launch; opencode has no session).
  const sessionForm = nativeSessionId ? ["--session-id", nativeSessionId] : [];
  const argv = HARNESS_ARGV[profile.harness]({ profile, sessionName, cwd, run, sessionForm, settingsPath });
  // The bootstrap prompt is launch-only: it tells a fresh worker to read the assignment and hand
  // off. A resume continues an existing session, so buildHarnessResume never appends it.
  const bootstrap = runBootstrapPrompt(run);
  if (bootstrap) argv.push(bootstrap);

  return {
    argv,
    env: runEnv(run, profile.harness),
    expected: expectedLaunch({ profileName, profile, sessionName, cwd, nativeSessionId }),
  };
}

// How each harness names an EXISTING session on the command line — the only per-harness knowledge
// a resume adds to the launch argv above.
const RESUME_SESSION_FORM = Object.freeze({
  // Pi's --session-id resumes-or-creates, so a resume names the session exactly as the launch did.
  pi: (sessionId) => ["--session-id", sessionId],
  // Claude is the opposite: `--session-id <id>` CREATES a session and errors ("Session ID already
  // in use") when it exists, so reattaching to a dead session's native history must use --resume.
  claude: (sessionId) => ["--resume", sessionId],
  // Codex resumes through the `codex resume <id>` SUBCOMMAND rather than a flag: the subcommand
  // and the exact session id are positional and must precede -C and every flag (which is why
  // codexArgv places the session form first).
  codex: (sessionId) => ["resume", sessionId],
  // opencode is deliberately absent: it has no resume form. `workflow resume` never reaches one
  // in production, and inventing an argv would run something no approval ever covered.
});

// The resume counterpart of buildHarnessLaunch: the argv that reattaches to an EXISTING native
// session, running the same security envelope the approved launch ran. It is the same per-harness
// argv builder, given the harness's resume session form instead of its launch one — so the flags
// cannot differ. The profile is supplied by the caller (the one persisted on the run record at
// launch, `run.agentProfile`) and is never re-resolved from the registry here: a registry edited
// since the approval must not change what a resume runs.
//
// Returns {argv, env}: the launch's `expected` describes an approval surface and has no resume
// analogue.
export function buildHarnessResume({ profileName, profile, sessionName, cwd, run, sessionId, settingsPath } = {}) {
  assertString(profileName, "profileName");
  assertProfile(profile);
  assertString(sessionName, "sessionName");
  assertString(cwd, "cwd");
  assertString(sessionId, "sessionId");
  // Unlike a launch, a resume always belongs to a run: its directory is what --add-dir grants, and
  // its fields are the WORKFLOW_* env the relaunched pane needs.
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new TypeError("run must be the run record the resumed session belongs to");
  }
  const resumeForm = RESUME_SESSION_FORM[profile.harness];
  if (!resumeForm) {
    throw new TypeError(`Harness ${profile.harness} (profile ${profileName}) has no resume form; only ${Object.keys(RESUME_SESSION_FORM).join(", ")} can be resumed`);
  }
  // --settings is the one flag claudeArgv gates on a caller-supplied argument rather than on the
  // profile, so it is the one flag a resume could silently drop: omit settingsPath and the pane
  // comes back with its lifecycle/statusLine hooks dead, no error, no failing assertion. A resume
  // always has a run and knows the mode, so the condition is decidable here — demand the argument
  // in exactly the case where claudeArgv would emit the flag.
  if (profile.harness === "claude" && profile.mode === "interactive") {
    assertString(settingsPath, "settingsPath");
  }

  // No bootstrap prompt, unlike buildHarnessLaunch: a resume continues an existing session rather
  // than restarting the assignment.
  const argv = HARNESS_ARGV[profile.harness]({ profile, sessionName, cwd, run, sessionForm: resumeForm(sessionId), settingsPath });
  return { argv, env: runEnv(run, profile.harness) };
}
