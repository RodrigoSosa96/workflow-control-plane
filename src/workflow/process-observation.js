const PS_STATUS_RE = /^(?<startedAt>[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(?<state>[A-Z]+)/u;

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

export async function inspectExactProcessByPid(pid, {
  runProcess,
  readCwd,
  cwdFallback,
} = {}) {
  const resolvedPid = assertPid(pid);
  if (typeof runProcess !== "function") fail("process inspection runProcess must be a function");
  if (typeof readCwd !== "function") fail("process inspection readCwd must be a function");

  const result = await runProcess(resolvedPid);
  if (!result || typeof result !== "object") fail("process inspection result must be an object");
  if (result.code !== 0 || !String(result.stdout ?? "").trim()) return null;

  const parsed = parsePsProcessStatus(result.stdout);
  let cwd = cwdFallback ?? null;
  try {
    cwd = await readCwd(`/proc/${resolvedPid}/cwd`);
  } catch {
    if (!cwd) return null;
  }

  return {
    pid: resolvedPid,
    startedAt: parsed.startedAt,
    cwd,
    active: parsed.active,
  };
}
