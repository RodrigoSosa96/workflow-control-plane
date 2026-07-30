// Owner markers both mutexes embed, and the pure verdict classifier that
// decides whether a marker's owner is provably dead.
//
// inspectExactProcessByPid draws a sharp line between "proven absent"
// (returns null) and "ambiguous" (throws). That distinction must survive
// here: an ambiguous observation can only ever yield "unprovable", never
// "owner-gone" — a mutex must not be treated as recoverable on a guess.

function fail(message) {
  throw new TypeError(message);
}

function isPlainMarker(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function markerField(marker, key) {
  const value = marker[key];
  return value === null || value === undefined ? null : String(value);
}

function frozenVerdict({ verdict, reason, pid, startedAt }) {
  return Object.freeze({ verdict, reason, pid, startedAt, removable: verdict === "owner-gone" });
}

// Marker fields both mutexes embed. Returns { pid, startedAt } or null when
// the process's own start time cannot be read — acquisition must still
// proceed even without a provable marker.
export async function readOwnProcessOwnership({ inspectProcess, pid = String(process.pid) } = {}) {
  if (typeof inspectProcess !== "function") {
    fail("readOwnProcessOwnership inspectProcess must be a function");
  }
  try {
    const result = await inspectProcess(pid);
    if (!result || typeof result !== "object") return null;
    return { pid: result.pid, startedAt: result.startedAt };
  } catch {
    // Ambiguous or failed inspection must not block mutex acquisition; the
    // marker is simply written without a provable start time.
    return null;
  }
}

// Memoizing wrapper. A lock is taken on nearly every write, so the live
// path must run `ps` once per process, not once per acquisition. The
// settled result — including null — is cached forever; inspectProcess is
// never invoked again after the first call. This is the ONLY place
// memoization lives: callers (the two mutex stores) must not add their own.
export function createOwnOwnershipReader({ inspectProcess, pid = String(process.pid) } = {}) {
  if (typeof inspectProcess !== "function") {
    fail("createOwnOwnershipReader inspectProcess must be a function");
  }
  let cached;
  return function readOwnOwnership() {
    if (!cached) cached = readOwnProcessOwnership({ inspectProcess, pid });
    return cached;
  };
}

export const OBSERVATION_FAILED = Symbol("observation-failed");

// Pure. marker is the parsed owner-marker object (any version); observation
// is the inspectExactProcessByPid result, null for proven-missing, or
// OBSERVATION_FAILED when inspection threw.
export function classifyOwnership(marker, observation) {
  if (!isPlainMarker(marker)) {
    return frozenVerdict({
      verdict: "unprovable",
      reason: "the owner marker is unreadable: it is not a recognizable marker object",
      pid: null,
      startedAt: null,
    });
  }

  const pid = markerField(marker, "pid");
  const startedAt = markerField(marker, "startedAt");

  if (pid === null || startedAt === null) {
    return frozenVerdict({
      verdict: "unprovable",
      reason: "the owner marker predates provable ownership and has no start time to compare",
      pid,
      startedAt,
    });
  }

  if (observation === OBSERVATION_FAILED) {
    return frozenVerdict({
      verdict: "unprovable",
      reason: "owner liveness could not be verified because process inspection failed",
      pid,
      startedAt,
    });
  }

  if (observation === null) {
    return frozenVerdict({
      verdict: "owner-gone",
      reason: "the owner process is proven gone: no matching process exists",
      pid,
      startedAt,
    });
  }

  if (observation.startedAt === marker.startedAt) {
    return frozenVerdict({
      verdict: "owner-alive",
      reason: "the owner process is still running with a matching start time",
      pid,
      startedAt,
    });
  }

  return frozenVerdict({
    verdict: "owner-gone",
    reason: "the owner pid was recycled: the running process has a different start time",
    pid,
    startedAt,
  });
}
