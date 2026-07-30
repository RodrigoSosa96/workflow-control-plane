// Owner markers both mutexes embed, and the pure verdict classifier that
// decides whether a marker's owner is provably dead.
//
// inspectExactProcessByPid draws a sharp line between "proven absent"
// (returns null) and "ambiguous" (throws). That distinction must survive
// here: an ambiguous observation can only ever yield "unprovable", never
// "owner-gone" — a mutex must not be treated as recoverable on a guess.

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { inspectExactProcessByPid, psStatusArgv } from "./process-observation.js";

// Exported so commands.js's observe-and-classify plumbing (observeOwner, ownerMarkerVersion)
// shares this one guard instead of hand-rolling the same "plain object, not an array" check --
// review finding D17 was this predicate written four times across layers; a fresh, unexported
// copy here would just be a fifth.
export function isPlainMarker(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Directory identity comparison shared by both mutex stores' pre-removal rechecks
// (run-store.js's removeLock, delegation-reservations.js's clearGate): dev/ino when the platform
// provides them, falling back to ctime/mtime otherwise. Both stores had byte-for-byte identical
// copies of this (sameActiveDirectory, sameGateDirectory) before this moved here -- the one place
// that already owns what both mutexes' owner markers mean is the natural home for the one place
// that decides whether "the same directory" still means the same acquisition.
export function sameOwnerDirectory(left, right) {
  if (
    Number.isFinite(left?.dev) && Number.isFinite(left?.ino)
    && Number.isFinite(right?.dev) && Number.isFinite(right?.ino)
  ) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left?.ctimeMs === right?.ctimeMs && left?.mtimeMs === right?.mtimeMs;
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
// proceed even without a provable marker. Total: this sits on the
// acquisition path, so it never throws, not even for a missing or
// non-function inspectProcess — a mis-wired caller degrades to null like
// any other "cannot read" case instead of aborting the lock.
export async function readOwnProcessOwnership({ inspectProcess, pid = String(process.pid) } = {}) {
  if (typeof inspectProcess !== "function") return null;
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
// Total like readOwnProcessOwnership: a missing or non-function
// inspectProcess is not validated here — it is left to readOwnProcessOwnership
// to turn into a memoized null, so a mis-wired reader degrades instead of
// throwing on the acquisition path.
export function createOwnOwnershipReader({ inspectProcess, pid = String(process.pid) } = {}) {
  let cached;
  return function readOwnOwnership() {
    if (!cached) cached = readOwnProcessOwnership({ inspectProcess, pid });
    return cached;
  };
}

// The `ps` invocation this module runs — byte-for-byte the same command and args
// bin/workflow.js's inspectDelegationPid already runs (through a process runner with
// allowFailure: true), because both build on process-observation.js's shared psStatusArgv.
// Marker verdicts hinge on `startedAt` string equality (classifyOwnership above), so a hook's
// own marker and unlock's later observation of it must come from the exact same invocation and
// parse; that is why the argv itself is a single exported function, not a literal repeated
// here. Resolves rather than rejects on a non-zero exit — inspectExactProcessByPid's runProcess
// contract needs that, since a `ps` exit of 1 with empty stdout/stderr is how it proves a pid
// is gone.
function spawnPsStatus(pid) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("ps", psStatusArgv(pid), { shell: false });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signal) => settle(() => {
      if (signal) {
        reject(new Error(`ps -p ${pid} exited via signal ${signal}`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    }));
  });
}

// Memoized own-ownership reader for a process with no injected runner: lifecycle hooks and Pi
// worker extensions, which build their own run store without threading a CLI-constructed
// inspector through it (unlike bin/workflow.js, which already has a `runner` and composes
// createOwnOwnershipReader directly). This is the one piece those call sites will share --
// unwired here; a later task points their stores at it.
//
// Composes the existing pieces rather than reimplementing either: inspectExactProcessByPid does
// the inspection and its proven-absent/ambiguous distinction, createOwnOwnershipReader does the
// memoization (including caching a null outcome, so a broken environment costs one `ps` attempt
// per process, not one per lock acquisition). Both seams default to real work so a caller can
// write createSubprocessOwnOwnershipReader() with no arguments and get a working reader; both
// stay injectable so tests never have to spawn a real `ps`.
export function createSubprocessOwnOwnershipReader({ spawnProcess = spawnPsStatus, readCwd = realpath } = {}) {
  return createOwnOwnershipReader({
    inspectProcess: (pid) => inspectExactProcessByPid(pid, { runProcess: spawnProcess, readCwd }),
  });
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
