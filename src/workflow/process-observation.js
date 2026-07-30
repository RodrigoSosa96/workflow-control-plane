const PS_STATUS_RE = /^(?<startedAt>[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(?<state>[A-Z]+)/u;

// The one `ps` argv every own-ownership observation site must share, byte-for-byte:
// ownership.js's spawnPsStatus (the write side, invoked from acquireLock/acquireGate before a
// mutex is taken), bin/workflow.js's inspectDelegationPid (the read side `workflow unlock` uses
// to observe an arbitrary owner), and workflow-hook-ownership.test.js's own unlock-path test
// helper. classifyOwnership (ownership.js) compares startedAt for exact string equality: a
// hook's own marker and unlock's later observation of it must come from the exact same `ps`
// invocation and parse, or a live owner risks being misclassified as proven-dead and its lock
// removed out from under it. This lives here, next to the parse (parsePsProcessStatus) that
// reads what this argv produces, so the write shape and the read shape can never drift apart.
export function psStatusArgv(pid) {
  return ["-p", String(pid), "-o", "lstart=", "-o", "state="];
}

function fail(message) {
  throw new TypeError(message);
}

function assertPid(value) {
  const pid = String(value ?? "").trim();
  if (!pid || pid.includes("\0")) fail("process pid must be a bounded non-empty string");
  return pid;
}

export function normalizeProcessStartedAt(value) {
  const text = String(value ?? "").trim().replace(/\s+/gu, " ");
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) fail("process startedAt is invalid");
  return new Date(parsed).toISOString();
}

export function activeFromProcessState(value) {
  const state = String(value ?? "").trim().toUpperCase();
  return state.startsWith("R") || state.startsWith("D");
}

export function parsePsProcessStatus(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/gu).at(-1)?.trim() ?? "";
  const match = PS_STATUS_RE.exec(line);
  if (!match?.groups) fail("process inspection output is invalid");
  return {
    startedAt: normalizeProcessStartedAt(match.groups.startedAt),
    active: activeFromProcessState(match.groups.state),
  };
}

function psProvesMissing(result) {
  return result?.code === 1 && !String(result?.stdout ?? "").trim() && !String(result?.stderr ?? "").trim();
}

function procReadProvesMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ESRCH";
}

export async function inspectExactProcessByPid(pid, {
  runProcess,
  readCwd,
  cwdFallback: _cwdFallback,
} = {}) {
  const resolvedPid = assertPid(pid);
  if (typeof runProcess !== "function") fail("process inspection runProcess must be a function");
  if (typeof readCwd !== "function") fail("process inspection readCwd must be a function");

  const result = await runProcess(resolvedPid);
  if (!result || typeof result !== "object") fail("process inspection result must be an object");
  if (psProvesMissing(result)) return null;
  if (result.code !== 0) fail("process inspection could not verify whether the process still exists");
  if (!String(result.stdout ?? "").trim()) fail("process inspection output is invalid");

  const parsed = parsePsProcessStatus(result.stdout);
  let cwd;
  try {
    cwd = await readCwd(`/proc/${resolvedPid}/cwd`);
  } catch (error) {
    if (procReadProvesMissing(error)) return null;
    throw error;
  }

  return {
    pid: resolvedPid,
    startedAt: parsed.startedAt,
    cwd,
    active: parsed.active,
  };
}
