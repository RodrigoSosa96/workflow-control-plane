import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OBSERVATION_FAILED,
  classifyOwnership,
  createOwnOwnershipReader,
  isPlainMarker,
  readOwnProcessOwnership,
  sameOwnerDirectory,
} from "../src/workflow/ownership.js";

const MARKER = { pid: "111", startedAt: "2026-07-29T10:00:00.000Z" };
const LIVE_OBSERVATION = { pid: "111", startedAt: MARKER.startedAt, cwd: "/tmp/x", active: true };
const RECYCLED_OBSERVATION = { pid: "111", startedAt: "2026-07-29T11:30:00.000Z", cwd: "/tmp/x", active: true };

function assertBoundedReason(reason) {
  assert.equal(typeof reason, "string");
  assert.ok(reason.length > 0);
  assert.ok(reason.length <= 200, `reason exceeds 200 chars: ${reason.length}`);
  assert.ok(!reason.includes("\n"), "reason must be a single line");
}

// --- classifyOwnership: verdict table ---------------------------------

test("classifyOwnership: matching startedAt means the owner is alive", () => {
  const verdict = classifyOwnership(MARKER, LIVE_OBSERVATION);
  assert.equal(verdict.verdict, "owner-alive");
  assert.match(verdict.reason, /owner process is still running/);
  assertBoundedReason(verdict.reason);
});

test("classifyOwnership: differing startedAt means the pid was recycled and the owner is gone", () => {
  const verdict = classifyOwnership(MARKER, RECYCLED_OBSERVATION);
  assert.equal(verdict.verdict, "owner-gone");
  assert.match(verdict.reason, /pid was recycled/);
  assertBoundedReason(verdict.reason);
});

test("classifyOwnership: a null observation proves the owner process is gone", () => {
  const verdict = classifyOwnership(MARKER, null);
  assert.equal(verdict.verdict, "owner-gone");
  assert.match(verdict.reason, /proven gone/);
  assertBoundedReason(verdict.reason);
});

test("classifyOwnership: a failed observation is unprovable, not owner-gone", () => {
  const verdict = classifyOwnership(MARKER, OBSERVATION_FAILED);
  assert.equal(verdict.verdict, "unprovable");
  assert.match(verdict.reason, /liveness could not be verified/);
  assertBoundedReason(verdict.reason);
});

test("classifyOwnership: a marker missing startedAt (version 1) is unprovable regardless of observation", () => {
  const versionOneMarker = { pid: "111" };
  for (const observation of [LIVE_OBSERVATION, RECYCLED_OBSERVATION, null, OBSERVATION_FAILED]) {
    const verdict = classifyOwnership(versionOneMarker, observation);
    assert.equal(verdict.verdict, "unprovable");
    assert.match(verdict.reason, /predates provable ownership/);
    assertBoundedReason(verdict.reason);
  }
});

test("classifyOwnership: a marker missing pid is unprovable regardless of observation", () => {
  const noPidMarker = { startedAt: MARKER.startedAt };
  const verdict = classifyOwnership(noPidMarker, LIVE_OBSERVATION);
  assert.equal(verdict.verdict, "unprovable");
  assert.match(verdict.reason, /predates provable ownership/);
});

test("classifyOwnership: a null marker is unprovable because it is unreadable", () => {
  const verdict = classifyOwnership(null, LIVE_OBSERVATION);
  assert.equal(verdict.verdict, "unprovable");
  assert.match(verdict.reason, /marker is unreadable/);
  assert.equal(verdict.pid, null);
  assert.equal(verdict.startedAt, null);
});

test("classifyOwnership: a non-object marker (string) is unprovable because it is unreadable", () => {
  const verdict = classifyOwnership("not-a-marker", LIVE_OBSERVATION);
  assert.equal(verdict.verdict, "unprovable");
  assert.match(verdict.reason, /marker is unreadable/);
});

test("classifyOwnership: an array marker is unprovable because it is unreadable", () => {
  const verdict = classifyOwnership(["111", MARKER.startedAt], LIVE_OBSERVATION);
  assert.equal(verdict.verdict, "unprovable");
  assert.match(verdict.reason, /marker is unreadable/);
});

// --- classifyOwnership: shape guarantees --------------------------------

test("classifyOwnership: removable is true only for owner-gone", () => {
  assert.equal(classifyOwnership(MARKER, LIVE_OBSERVATION).removable, false);
  assert.equal(classifyOwnership(MARKER, RECYCLED_OBSERVATION).removable, true);
  assert.equal(classifyOwnership(MARKER, null).removable, true);
  assert.equal(classifyOwnership(MARKER, OBSERVATION_FAILED).removable, false);
  assert.equal(classifyOwnership({ pid: "111" }, null).removable, false);
  assert.equal(classifyOwnership(null, null).removable, false);
});

test("classifyOwnership: returns a frozen object", () => {
  const verdict = classifyOwnership(MARKER, LIVE_OBSERVATION);
  assert.ok(Object.isFrozen(verdict));
  assert.throws(() => {
    verdict.verdict = "owner-gone";
  });
});

test("classifyOwnership: surfaces the marker's pid and startedAt as strings on every verdict", () => {
  const alive = classifyOwnership(MARKER, LIVE_OBSERVATION);
  assert.equal(alive.pid, "111");
  assert.equal(alive.startedAt, MARKER.startedAt);

  const gone = classifyOwnership(MARKER, null);
  assert.equal(gone.pid, "111");
  assert.equal(gone.startedAt, MARKER.startedAt);

  const unprovable = classifyOwnership(MARKER, OBSERVATION_FAILED);
  assert.equal(unprovable.pid, "111");
  assert.equal(unprovable.startedAt, MARKER.startedAt);
});

test("classifyOwnership: is pure and does not mutate its inputs", () => {
  const marker = { pid: "111", startedAt: MARKER.startedAt };
  const observation = { pid: "111", startedAt: MARKER.startedAt, cwd: "/tmp/x", active: true };
  const markerBefore = JSON.stringify(marker);
  const observationBefore = JSON.stringify(observation);
  classifyOwnership(marker, observation);
  assert.equal(JSON.stringify(marker), markerBefore);
  assert.equal(JSON.stringify(observation), observationBefore);
});

// --- readOwnProcessOwnership --------------------------------------------

test("readOwnProcessOwnership returns pid and startedAt when the inspector proves the process alive", async () => {
  const result = await readOwnProcessOwnership({
    pid: "222",
    async inspectProcess(pid) {
      assert.equal(pid, "222");
      return { pid, startedAt: "2026-07-29T09:00:00.000Z", cwd: "/tmp/x", active: true };
    },
  });
  assert.deepEqual(result, { pid: "222", startedAt: "2026-07-29T09:00:00.000Z" });
});

test("readOwnProcessOwnership returns null when the inspector proves the process absent", async () => {
  const result = await readOwnProcessOwnership({
    pid: "222",
    async inspectProcess() {
      return null;
    },
  });
  assert.equal(result, null);
});

test("readOwnProcessOwnership returns null (never throws) when the inspector throws on ambiguity", async () => {
  const result = await readOwnProcessOwnership({
    pid: "222",
    async inspectProcess() {
      throw new Error("ambiguous ps output");
    },
  });
  assert.equal(result, null);
});

test("readOwnProcessOwnership defaults pid to the current process's own pid", async () => {
  let observedPid;
  await readOwnProcessOwnership({
    async inspectProcess(pid) {
      observedPid = pid;
      return null;
    },
  });
  assert.equal(observedPid, String(process.pid));
});

test("readOwnProcessOwnership resolves to null (never rejects) when called with no arguments at all", async () => {
  await assert.doesNotReject(async () => {
    const result = await readOwnProcessOwnership();
    assert.equal(result, null);
  });
});

test("readOwnProcessOwnership resolves to null (never rejects) when inspectProcess is not a function", async () => {
  await assert.doesNotReject(async () => {
    const result = await readOwnProcessOwnership({ inspectProcess: "not-a-function", pid: "222" });
    assert.equal(result, null);
  });
});

// --- createOwnOwnershipReader: memoization ------------------------------

test("createOwnOwnershipReader invokes inspectProcess exactly once across many calls", async () => {
  let calls = 0;
  const reader = createOwnOwnershipReader({
    pid: "222",
    async inspectProcess(pid) {
      calls += 1;
      return { pid, startedAt: "2026-07-29T09:00:00.000Z", cwd: "/tmp/x", active: true };
    },
  });

  const first = await reader();
  const second = await reader();
  const third = await reader();

  assert.equal(calls, 1);
  assert.deepEqual(first, { pid: "222", startedAt: "2026-07-29T09:00:00.000Z" });
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("createOwnOwnershipReader memoizes a null result and never re-invokes inspectProcess", async () => {
  let calls = 0;
  const reader = createOwnOwnershipReader({
    pid: "222",
    async inspectProcess() {
      calls += 1;
      return null;
    },
  });

  assert.equal(await reader(), null);
  assert.equal(await reader(), null);
  assert.equal(calls, 1);
});

test("createOwnOwnershipReader memoizes a throwing inspector's outcome (null) and never re-invokes it", async () => {
  let calls = 0;
  const reader = createOwnOwnershipReader({
    pid: "222",
    async inspectProcess() {
      calls += 1;
      throw new Error("ambiguous ps output");
    },
  });

  assert.equal(await reader(), null);
  assert.equal(await reader(), null);
  assert.equal(calls, 1);
});

test("createOwnOwnershipReader invokes inspectProcess exactly once even when calls race before the first settles", async () => {
  let calls = 0;
  let resolveInspect;
  const reader = createOwnOwnershipReader({
    pid: "222",
    inspectProcess() {
      calls += 1;
      return new Promise((resolve) => {
        resolveInspect = resolve;
      });
    },
  });

  const first = reader();
  const second = reader();
  resolveInspect({ pid: "222", startedAt: "2026-07-29T09:00:00.000Z", cwd: "/tmp/x", active: true });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.deepEqual(firstResult, { pid: "222", startedAt: "2026-07-29T09:00:00.000Z" });
  assert.deepEqual(secondResult, firstResult);
});

test("createOwnOwnershipReader construction never throws when called with no arguments at all", () => {
  assert.doesNotThrow(() => createOwnOwnershipReader());
});

test("createOwnOwnershipReader's reader resolves to null (never rejects) when called with no arguments at all", async () => {
  const reader = createOwnOwnershipReader();
  await assert.doesNotReject(async () => {
    assert.equal(await reader(), null);
  });
  // Memoization still holds for the degraded case: repeated calls settle
  // to the same cached null instead of re-attempting inspection.
  assert.equal(await reader(), null);
});

test("createOwnOwnershipReader's reader resolves to null (never rejects) when inspectProcess is not a function", async () => {
  const reader = createOwnOwnershipReader({ inspectProcess: 42, pid: "222" });
  await assert.doesNotReject(async () => {
    assert.equal(await reader(), null);
  });
});

// --- isPlainMarker -------------------------------------------------------
// Exported so commands.js's observeOwner/ownerMarkerVersion share this exact guard instead of
// each hand-rolling their own copy (the consolidation this task adds on top of classifyOwnership,
// which already used this guard internally before it was exported).

test("isPlainMarker: true for a plain object, false for null, arrays, and primitives", () => {
  assert.equal(isPlainMarker({ pid: "1" }), true);
  assert.equal(isPlainMarker({}), true);
  assert.equal(isPlainMarker(null), false);
  assert.equal(isPlainMarker(undefined), false);
  assert.equal(isPlainMarker([]), false);
  assert.equal(isPlainMarker(["pid", "1"]), false);
  assert.equal(isPlainMarker("marker"), false);
  assert.equal(isPlainMarker(42), false);
});

// --- sameOwnerDirectory ---------------------------------------------------
// The directory-identity comparison both mutex stores (run-store.js's removeLock,
// delegation-reservations.js's clearGate) now import from here instead of each carrying a
// byte-for-byte identical copy.

test("sameOwnerDirectory: true when dev/ino match, even if mtimeMs/ctimeMs differ", () => {
  const left = { dev: 1, ino: 100, mtimeMs: 1000, ctimeMs: 1000 };
  const right = { dev: 1, ino: 100, mtimeMs: 2000, ctimeMs: 2000 };
  assert.equal(sameOwnerDirectory(left, right), true);
});

test("sameOwnerDirectory: false when dev/ino differ (a replaced directory)", () => {
  const left = { dev: 1, ino: 100, mtimeMs: 1000, ctimeMs: 1000 };
  const right = { dev: 1, ino: 200, mtimeMs: 1000, ctimeMs: 1000 };
  assert.equal(sameOwnerDirectory(left, right), false);
});

test("sameOwnerDirectory: falls back to ctimeMs/mtimeMs when dev/ino are not finite numbers", () => {
  const left = { mtimeMs: 1000, ctimeMs: 1000 };
  const right = { mtimeMs: 1000, ctimeMs: 1000 };
  assert.equal(sameOwnerDirectory(left, right), true);

  const replaced = { mtimeMs: 2000, ctimeMs: 2000 };
  assert.equal(sameOwnerDirectory(left, replaced), false);
});

test("sameOwnerDirectory: tolerates missing/undefined stats without throwing", () => {
  assert.equal(sameOwnerDirectory(undefined, undefined), true);
  assert.doesNotThrow(() => sameOwnerDirectory(null, { dev: 1, ino: 1 }));
  assert.equal(typeof sameOwnerDirectory(null, { dev: 1, ino: 1 }), "boolean");
});
