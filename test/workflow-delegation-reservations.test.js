import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as realFs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDelegationReservationStore } from "../src/workflow/delegation-reservations.js";
import { classifyOwnership, createSubprocessOwnOwnershipReader } from "../src/workflow/ownership.js";
import { inspectExactProcessByPid, psStatusArgv } from "../src/workflow/process-observation.js";
import { createProcessRunner } from "../src/workflow/process.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

const policy = {
  version: 1,
  totalInternal: 2,
  foreground: 1,
  readOnlyBackground: 1,
  writersTotal: 1,
  writersPerCheckout: 1,
  maxDepth: 1,
  remediationTurns: 2,
  allowBackgroundWriters: false,
};

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-delegation-reservations-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

// Unlike uuidSequence, never repeats: every gate acquisition and every reserve() call consumes
// at least one UUID (reservationId, gate ownerToken, lease ownerToken), so a test that calls
// reserve() more than once must not rely on a short fixed sequence freezing on its last value —
// that silently defeats the "Reservation ID already exists" collision check instead of
// exercising it, since a repeated ownerToken/reservationId only actually collides against
// records already persisted under an earlier, different value. Use this whenever a test's exact
// draw count isn't the point being tested.
function distinctUuidSequence() {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
}

function clockSequence(...values) {
  let index = 0;
  return {
    now() {
      return values[index++] ?? values.at(-1);
    },
  };
}

async function fileMode(path) {
  return (await stat(path)).mode & 0o777;
}

function createStore(stateRoot, ids = [FIRST_ID, SECOND_ID, THIRD_ID]) {
  return createDelegationReservationStore({
    stateRoot,
    randomUUID: uuidSequence(...ids),
    clock: clockSequence(
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:01:00.000Z",
      "2025-01-01T00:02:00.000Z",
      "2025-01-01T00:03:00.000Z",
      "2025-01-01T00:04:00.000Z",
      "2025-01-01T00:05:00.000Z",
    ),
    canonicalPath: async (value) => value,
  });
}

function activeGatePathFor(stateRoot, projectAlias) {
  const projectDigest = createHash("sha256").update(projectAlias, "utf8").digest("hex");
  return join(stateRoot, "delegation-reservations", "projects", projectDigest, "gate", "active");
}

// Wraps fs.readFile to capture the raw bytes of a single target path the first time it is
// read, and fs.chmod to record every mode applied to that same path, without altering what the
// caller sees. Used to observe the gate owner marker's exact content and file mode while
// releaseGate reads it (immediately before deleting it), since a successful reserve() releases
// the gate before returning and leaves nothing on disk to inspect afterward -- writeAtomicJson's
// chmodFile(path) call (the one that applies PRIVATE_FILE_MODE to the final marker path, after
// the temp file is opened with that same mode and renamed into place) is the honest observation
// point for the mode, since the file itself is gone by the time reserve() resolves. chmodModes
// is additive: existing callers that only destructure { fs, captured } are unaffected.
function fsCapturingRead(targetPath) {
  const captured = { text: null };
  const chmodModes = [];
  const fs = {
    ...realFs,
    async readFile(path, encoding) {
      const text = await realFs.readFile(path, encoding);
      if (path === targetPath && captured.text === null) captured.text = text;
      return text;
    },
    async chmod(path, mode) {
      if (path === targetPath) chmodModes.push(mode);
      return realFs.chmod(path, mode);
    },
  };
  return { fs, captured, chmodModes };
}

// Fabricates a different `ino` for the Nth fs.stat(path) call, deterministically simulating
// "this is a different directory now" without depending on how eagerly the underlying
// filesystem reuses a freed inode after rmdir+mkdir — observed to be immediate on this
// environment's tmpfs (WSL2), which makes a real rmdir+mkdir replacement indistinguishable
// from the original directory via dev/ino alone. Mirrors workflow-run-store.test.js's helper
// of the same name.
function fsWithFabricatedIdentityOnNthStat(targetPath, targetCallNumber) {
  let calls = 0;
  return {
    ...realFs,
    async stat(path) {
      const real = await realFs.stat(path);
      if (path !== targetPath) return real;
      calls += 1;
      if (calls !== targetCallNumber) return real;
      return { ...real, ino: (real.ino ?? 0) + 999999, isDirectory: () => real.isDirectory() };
    },
  };
}

test("reserves read-only background capacity with opaque private state", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.deepEqual(reservation.resources, ["totalInternal", "readOnlyBackground"]);
  assert.match(reservation.projectDigest, /^[0-9a-f]{64}$/);
  assert.match(reservation.checkoutDigest, /^[0-9a-f]{64}$/);
  assert.equal(await fileMode(join(stateRoot, "delegation-reservations")), 0o700);
  assert.equal(await fileMode(reservation.path), 0o600);
  assert.doesNotMatch(reservation.path, /fixture-single|fixture\/source/);
  const persisted = await readFile(reservation.path, "utf8");
  assert.doesNotMatch(persisted, /fixture-single|fixture\/source/);

  const active = await reservations.list({ projectAlias: "fixture-single" });
  assert.deepEqual(active.map((item) => item.id), [FIRST_ID]);
  assert.equal(active[0].state, "active");
});

test("enforces background, foreground, and checkout writer limits", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);

  await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "scout",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });
  await assert.rejects(
    () => reservations.reserve({
      projectAlias: "fixture-single",
      delegationId: SECOND_ID,
      role: "code-reviewer",
      mode: "background",
      checkoutPath: "/fixture/source",
      policy,
    }),
    /readOnlyBackground|capacity/i,
  );

  const foregroundState = await tempStateRoot(t);
  const foreground = createStore(foregroundState);
  await foreground.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "spec-reviewer",
    mode: "foreground",
    checkoutPath: "/fixture/source",
    policy,
  });
  await assert.rejects(
    () => foreground.reserve({
      projectAlias: "fixture-single",
      delegationId: SECOND_ID,
      role: "scout",
      mode: "foreground",
      checkoutPath: "/fixture/other",
      policy,
    }),
    /foreground|capacity/i,
  );

  const writerState = await tempStateRoot(t);
  const writers = createStore(writerState);
  const writer = await writers.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "sdd-implementer",
    mode: "foreground",
    checkoutPath: "/fixture/source",
    policy,
  });
  assert.deepEqual(writer.resources, ["totalInternal", "foreground", "writersTotal", `checkout:${writer.checkoutDigest}`]);
  await assert.rejects(
    () => writers.reserve({
      projectAlias: "fixture-single",
      delegationId: SECOND_ID,
      role: "sdd-implementer",
      mode: "foreground",
      checkoutPath: "/fixture/source",
      policy,
    }),
    /writersTotal|checkout|capacity/i,
  );
});

test("serializes concurrent writers and retains released reservation history", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const first = createStore(stateRoot, [FIRST_ID, THIRD_ID, THIRD_ID]);
  const second = createStore(stateRoot, [SECOND_ID, THIRD_ID, THIRD_ID]);

  const settled = await Promise.allSettled([
    first.reserve({
      projectAlias: "fixture-single",
      delegationId: FIRST_ID,
      role: "sdd-implementer",
      mode: "foreground",
      checkoutPath: "/fixture/source",
      policy,
    }),
    second.reserve({
      projectAlias: "fixture-single",
      delegationId: SECOND_ID,
      role: "sdd-implementer",
      mode: "foreground",
      checkoutPath: "/fixture/source",
      policy,
    }),
  ]);
  const granted = settled.filter((result) => result.status === "fulfilled");
  assert.equal(granted.length, 1);

  const activeReservation = granted[0].value;
  const releasingStore = createStore(stateRoot, [THIRD_ID, THIRD_ID]);
  const released = await releasingStore.release({ reservation: activeReservation });
  assert.equal(released.state, "released");
  assert.ok(released.releasedAt);
  assert.equal(await fileMode(activeReservation.path), 0o600);

  const next = await releasingStore.reserve({
    projectAlias: "fixture-single",
    delegationId: THIRD_ID,
    role: "sdd-implementer",
    mode: "foreground",
    checkoutPath: "/fixture/source",
    policy,
  });
  assert.equal(next.state, "active");
  const history = await releasingStore.list({ projectAlias: "fixture-single" });
  assert.deepEqual(history.map((item) => item.state).sort(), ["active", "released"]);
});

test("does not remove an active foreign reservation gate", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);
  const projectDigest = createHash("sha256").update("fixture-single", "utf8").digest("hex");
  const activeGate = join(stateRoot, "delegation-reservations", "projects", projectDigest, "gate", "active");
  await mkdir(activeGate, { recursive: true, mode: 0o700 });
  await chmod(activeGate, 0o755);

  await assert.rejects(
    () => reservations.reserve({
      projectAlias: "fixture-single",
      delegationId: FIRST_ID,
      role: "scout",
      mode: "foreground",
      checkoutPath: "/fixture/source",
      policy,
    }),
    /gate|manual/i,
  );
  assert.equal((await stat(activeGate)).isDirectory(), true);
  assert.equal(await fileMode(activeGate), 0o755);
});

test("releaseForDelegation frees a lease without its owner token and restores writer capacity", async (t) => {
  // The owner token reserve() mints is never persisted outside the lease file, so
  // release({reservation}) can have no real caller: releasing by delegation
  // identity is what actually lets capacity be reclaimed.
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot, [FIRST_ID, SECOND_ID, THIRD_ID, "44444444-4444-4444-8444-444444444444"]);
  const writer = {
    projectAlias: "fixture-single",
    role: "sdd-implementer",
    mode: "foreground",
    checkoutPath: "/fixture/source",
    policy,
  };

  await reservations.reserve({ ...writer, delegationId: FIRST_ID });
  // writersPerCheckout is 1: a second writer on the same checkout is refused.
  await assert.rejects(
    () => reservations.reserve({ ...writer, delegationId: SECOND_ID }),
    /capacity is exhausted/i,
  );

  const released = await reservations.releaseForDelegation({ projectAlias: "fixture-single", delegationId: FIRST_ID });
  assert.equal(released.length, 1);
  assert.equal(released[0].state, "released");
  // The lease file never exposes the owner token to a caller.
  assert.equal(released[0].ownerToken, undefined);

  // Capacity is reclaimed, so the next writer proceeds.
  const next = await reservations.reserve({ ...writer, delegationId: SECOND_ID });
  assert.equal(next.state, "active");

  const active = (await reservations.list({ projectAlias: "fixture-single" })).filter((entry) => entry.state === "active");
  assert.deepEqual(active.map((entry) => entry.delegationId), [SECOND_ID]);
});

test("releaseForDelegation is a no-op for unknown delegations and untouched projects", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);

  assert.deepEqual(await reservations.releaseForDelegation({ projectAlias: "never-used", delegationId: FIRST_ID }), []);

  await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });
  assert.deepEqual(await reservations.releaseForDelegation({ projectAlias: "fixture-single", delegationId: THIRD_ID }), []);
  const active = (await reservations.list({ projectAlias: "fixture-single" })).filter((entry) => entry.state === "active");
  assert.equal(active.length, 1);

  // Releasing twice is idempotent: the second call finds no active lease.
  assert.equal((await reservations.releaseForDelegation({ projectAlias: "fixture-single", delegationId: FIRST_ID })).length, 1);
  assert.deepEqual(await reservations.releaseForDelegation({ projectAlias: "fixture-single", delegationId: FIRST_ID }), []);
});

test("gate marker written during a reserve is version 2 and carries pid and startedAt", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const markerPath = join(activeGatePathFor(stateRoot, "fixture-single"), "owner.json");
  const { fs, captured } = fsCapturingRead(markerPath);
  const reservations = createDelegationReservationStore({
    stateRoot,
    fs,
    randomUUID: uuidSequence(FIRST_ID, SECOND_ID, THIRD_ID),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    canonicalPath: async (value) => value,
    readOwnOwnership: async () => ({ pid: "4242", startedAt: "2024-12-31T00:00:00.000Z" }),
  });

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.equal(reservation.state, "active");
  assert.ok(captured.text, "expected releaseGate to have read the gate owner marker");
  const marker = JSON.parse(captured.text);
  assert.equal(marker.version, 2);
  assert.equal(marker.pid, "4242");
  assert.equal(marker.startedAt, "2024-12-31T00:00:00.000Z");
  assert.match(marker.ownerToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("a readOwnOwnership that throws still permits a reserve and writes a gate marker without pid or startedAt", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const markerPath = join(activeGatePathFor(stateRoot, "fixture-single"), "owner.json");
  const { fs, captured } = fsCapturingRead(markerPath);
  const reservations = createDelegationReservationStore({
    stateRoot,
    fs,
    randomUUID: uuidSequence(FIRST_ID, SECOND_ID, THIRD_ID),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    canonicalPath: async (value) => value,
    readOwnOwnership: async () => {
      throw new Error("ps failed");
    },
  });

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.equal(reservation.state, "active", "a throwing readOwnOwnership must not block gate acquisition");
  assert.ok(captured.text);
  const marker = JSON.parse(captured.text);
  assert.equal(marker.version, 2);
  assert.equal("pid" in marker, false);
  assert.equal("startedAt" in marker, false);
});

test("releaseGate accepts a version-1 marker for backward compatibility while still comparing ownerToken", async (t) => {
  // acquireGate itself never writes version 1 anymore; this proves releaseGate's version check
  // was widened rather than merely happening to still pass because nothing exercises it. Only
  // the byte content read back by releaseGate is swapped to a version-1 shape with the same
  // ownerToken; everything else about the acquisition (paths, identity) is real.
  const stateRoot = await tempStateRoot(t);
  const markerPath = join(activeGatePathFor(stateRoot, "fixture-single"), "owner.json");
  let downgraded = false;
  const fs = {
    ...realFs,
    async readFile(path, encoding) {
      const text = await realFs.readFile(path, encoding);
      if (path === markerPath && !downgraded) {
        downgraded = true;
        const parsed = JSON.parse(text);
        return `${JSON.stringify({ version: 1, ownerToken: parsed.ownerToken })}\n`;
      }
      return text;
    },
  };
  const reservations = createDelegationReservationStore({
    stateRoot,
    fs,
    randomUUID: distinctUuidSequence(),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    canonicalPath: async (value) => value,
  });

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.equal(reservation.state, "active");
  assert.equal(downgraded, true, "expected the version-1 downgrade to have been exercised");
  // The gate was actually released (not left wedged): a second reservation on the same project
  // proceeds without hitting "gate is active; manual inspection required".
  const second = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: SECOND_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy: { ...policy, readOnlyBackground: 2 },
  });
  assert.equal(second.state, "active");
});

test("inspectGate returns null for an untouched project and the marker for a held gate, mutating nothing", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);

  assert.equal(await reservations.inspectGate({ projectAlias: "never-used" }), null);

  const activeGate = activeGatePathFor(stateRoot, "fixture-single");
  const markerPath = join(activeGate, "owner.json");
  const marker = { version: 2, ownerToken: FIRST_ID, pid: "9999", startedAt: "2024-12-31T00:00:00.000Z" };
  const markerContent = `${JSON.stringify(marker, null, 2)}\n`;
  await mkdir(activeGate, { recursive: true, mode: 0o755 });
  await chmod(activeGate, 0o755);
  await writeFile(markerPath, markerContent, { mode: 0o644 });

  const inspected = await reservations.inspectGate({ projectAlias: "fixture-single" });
  assert.equal(inspected.activeGate, activeGate);
  assert.equal(inspected.markerPath, markerPath);
  assert.deepEqual(inspected.marker, marker);

  // Never mutates: the permissive modes and exact marker bytes set above must survive
  // untouched, and inspectGate must never acquire the gate it inspects.
  assert.equal(await fileMode(activeGate), 0o755);
  assert.equal(await fileMode(markerPath), 0o644);
  assert.equal(await readFile(markerPath, "utf8"), markerContent);
});

test("inspectGate ignores a stray non-owner file and still finds the real marker", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createDelegationReservationStore({ stateRoot, canonicalPath: async (value) => value });
  const activeGate = activeGatePathFor(stateRoot, "fixture-single");
  const markerPath = join(activeGate, "owner.json");
  const marker = { version: 2, ownerToken: "crashed-token" };
  await mkdir(activeGate, { recursive: true, mode: 0o700 });
  // Sorts before "owner.json" alphabetically: a naive "first readdir entry" implementation
  // would pick this stray file instead of filtering for the real marker name.
  await writeFile(join(activeGate, ".DS_Store"), "not a marker", { mode: 0o600 });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

  const inspected = await reservations.inspectGate({ projectAlias: "fixture-single" });

  assert.deepEqual(inspected.marker, marker);
  assert.equal(inspected.markerPath, markerPath);
});

test("clearGate clears only when allow returns true, refuses without throwing when the marker changes first, and unblocks reserve", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const ids = [FIRST_ID, SECOND_ID, THIRD_ID, "44444444-4444-4444-8444-444444444444"];
  const reservations = createStore(stateRoot, ids);
  const activeGate = activeGatePathFor(stateRoot, "fixture-single");
  const markerPath = join(activeGate, "owner.json");
  const marker = { version: 2, ownerToken: "crashed-token", pid: "9999", startedAt: "2024-12-31T00:00:00.000Z" };
  const markerContent = `${JSON.stringify(marker, null, 2)}\n`;
  await mkdir(activeGate, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });

  // The project is wedged behind the crash-residue gate.
  await assert.rejects(
    () => reservations.reserve({
      projectAlias: "fixture-single",
      delegationId: FIRST_ID,
      role: "scout",
      mode: "foreground",
      checkoutPath: "/fixture/source",
      policy,
    }),
    /gate|manual/i,
  );

  // allow() returning false: refuses without throwing, removes nothing.
  const disallowed = await reservations.clearGate({ projectAlias: "fixture-single", allow: () => false });
  assert.equal(disallowed.cleared, false);
  assert.match(disallowed.reason, /not permitted/i);
  assert.equal(await readFile(markerPath, "utf8"), markerContent);

  // The marker changes inside the allow() callback (simulating a fresh acquisition racing the
  // clear): clearGate must re-verify byte content immediately before deleting and refuse.
  let allowCalls = 0;
  const racedMarkerContent = `${JSON.stringify({ ...marker, ownerToken: "different-token" }, null, 2)}\n`;
  const raced = await reservations.clearGate({
    projectAlias: "fixture-single",
    allow: async (seenMarker) => {
      allowCalls += 1;
      assert.deepEqual(seenMarker, marker);
      await writeFile(markerPath, racedMarkerContent, { mode: 0o600 });
      return true;
    },
  });
  assert.equal(allowCalls, 1);
  assert.equal(raced.cleared, false);
  assert.match(raced.reason, /marker changed/i);
  assert.equal(await readFile(markerPath, "utf8"), racedMarkerContent, "the race-injected content must survive a refused clear");

  // Restore the stable marker, then a permitting allow() actually clears it.
  await writeFile(markerPath, markerContent, { mode: 0o600 });
  const cleared = await reservations.clearGate({
    projectAlias: "fixture-single",
    allow: (seenMarker) => {
      assert.deepEqual(seenMarker, marker);
      return true;
    },
  });
  assert.deepEqual(cleared, { cleared: true, activeGate });
  await assert.rejects(() => stat(activeGate), /ENOENT/);

  // The project accepts reservations again.
  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "scout",
    mode: "foreground",
    checkoutPath: "/fixture/source",
    policy,
  });
  assert.equal(reservation.state, "active");
});

test("clearGate refuses without throwing when there is no active gate to clear", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);

  const result = await reservations.clearGate({ projectAlias: "never-used", allow: () => true });

  assert.equal(result.cleared, false);
  assert.match(result.reason, /no active gate/i);
});

test("clearGate's refusal is the public {cleared:false, reason} shape, not mutex-removal.js's internal {refused} sentinel", async (t) => {
  // clearGate translates removeOwnedMutex's `{refused: true, reason}` into this store's own
  // `{cleared: false, reason}` shape. mutex-removal.js's own tests only ever assert the internal
  // sentinel (that is its contract); nothing previously asserted that clearGate actually
  // performs the translation, so a caller that forgot it would go uncaught.
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);

  const result = await reservations.clearGate({ projectAlias: "never-used", allow: () => true });

  assert.deepEqual(result, { cleared: false, reason: "no active gate or the owner marker is unreadable" });
});

test("clearGate rejects a non-function allow before touching the filesystem", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const reservations = createStore(stateRoot);

  await assert.rejects(() => reservations.clearGate({ projectAlias: "never-used", allow: "not-a-function" }), /clearGate allow must be a function/);
  await assert.rejects(() => reservations.clearGate({ projectAlias: "never-used" }), /clearGate allow must be a function/);
});

test("clearGate's pre-unlink recheck refuses a same-content replacement gate via directory identity, not marker bytes", async (t) => {
  // If the identity check inside clearGate's pre-unlink recheck were deleted, this test would
  // fail: the fabricated identity below leaves the marker's path and byte content completely
  // untouched, so only a dev/ino (directory identity) comparison can distinguish "the same
  // gate we inspected" from "a replacement that happens to look identical".
  const stateRoot = await tempStateRoot(t);
  const activeGate = activeGatePathFor(stateRoot, "fixture-single");
  const markerPath = join(activeGate, "owner.json");
  const marker = { version: 2, ownerToken: "crashed-token" };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activeGate, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });

  // clearGate's own fs.stat(activeGate) call sequence is: 1) inspectGateInternal for `initial`,
  // 2) inspectGateInternal for `recheck` (this is the one under test — fabricate a different
  // identity for it).
  const fs = fsWithFabricatedIdentityOnNthStat(activeGate, 2);
  const reservations = createDelegationReservationStore({ stateRoot, fs, canonicalPath: async (value) => value });

  let allowCalls = 0;
  const result = await reservations.clearGate({
    projectAlias: "fixture-single",
    allow: async (seenMarker) => {
      allowCalls += 1;
      assert.deepEqual(seenMarker, marker);
      return true;
    },
  });

  assert.equal(allowCalls, 1);
  assert.equal(result.cleared, false);
  assert.match(result.reason, /replaced/i);
  // The gate must survive completely untouched: proof clearGate never unlinked the marker.
  assert.equal(await readFile(markerPath, "utf8"), markerContent);
  await assert.doesNotReject(() => stat(activeGate));
});

test("clearGate's pre-rmdir recheck refuses a same-content replacement gate via directory identity, not marker bytes", async (t) => {
  // Targets the second, later identity check that runs after the marker has already been
  // unlinked and immediately before rmdir. If that check were deleted, this test would fail:
  // the fabricated identity below leaves everything else (path, marker bytes) untouched, so
  // only a fresh dev/ino comparison right before rmdir can catch it.
  const stateRoot = await tempStateRoot(t);
  const activeGate = activeGatePathFor(stateRoot, "fixture-single");
  const markerPath = join(activeGate, "owner.json");
  const marker = { version: 2, ownerToken: "crashed-token" };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activeGate, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });

  // Calls 1 and 2 (the initial and recheck inspections) must see a consistent, real identity so
  // clearGate actually proceeds to unlink; call 3 is clearGate's own postUnlinkStat, taken
  // right after the unlink and immediately before rmdir — fabricate a different identity there
  // specifically.
  const fs = fsWithFabricatedIdentityOnNthStat(activeGate, 3);
  const reservations = createDelegationReservationStore({ stateRoot, fs, canonicalPath: async (value) => value });

  const result = await reservations.clearGate({ projectAlias: "fixture-single", allow: () => true });

  assert.equal(result.cleared, false);
  assert.match(result.reason, /replaced/i);
  // The marker was legitimately unlinked (that part of removal did commit), but the directory
  // itself must survive: proof clearGate refused to rmdir once the identity check caught the
  // fabricated mismatch, rather than rmdir-ing a directory it never re-verified.
  await assert.rejects(() => stat(markerPath), /ENOENT/);
  await assert.doesNotReject(() => stat(activeGate));
});

test("clearGate refuses to unlink the marker when a stray entry would make rmdir fail, preserving the ownership evidence", async (t) => {
  // If clearGate unlinked the marker first and only then discovered the stray entry (via
  // rmdir's ENOTEMPTY), the gate would end up wedged with NO marker at all: every later
  // clearGate/inspectGate would see "no active gate or the owner marker is unreadable" and the
  // pid/startedAt evidence this whole mechanism exists to preserve would be gone for good. This
  // test proves clearGate checks first and refuses before deleting anything.
  const stateRoot = await tempStateRoot(t);
  const reservations = createDelegationReservationStore({ stateRoot, canonicalPath: async (value) => value });
  const activeGate = activeGatePathFor(stateRoot, "fixture-single");
  const markerPath = join(activeGate, "owner.json");
  const marker = { version: 2, ownerToken: "crashed-token", pid: "9999", startedAt: "2024-12-31T00:00:00.000Z" };
  const markerContent = `${JSON.stringify(marker)}\n`;
  await mkdir(activeGate, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, markerContent, { mode: 0o600 });
  // A stray file inspectGate already tolerates when identifying the marker (see the
  // "ignores a stray non-owner file" test above) — but it would make a naive rmdir fail.
  await writeFile(join(activeGate, ".DS_Store"), "not a marker", { mode: 0o600 });

  let allowCalls = 0;
  const result = await reservations.clearGate({
    projectAlias: "fixture-single",
    allow: async (seenMarker) => {
      allowCalls += 1;
      assert.deepEqual(seenMarker, marker);
      return true;
    },
  });

  assert.equal(allowCalls, 1);
  assert.equal(result.cleared, false);
  assert.match(result.reason, /entries besides|evidence/i);
  // The marker must survive completely untouched — this is the actual evidence-preservation
  // guarantee under test: a buggy implementation that unlinked first and only discovered the
  // stray entry at rmdir would fail this exact assertion (the marker would already be gone).
  assert.equal(await readFile(markerPath, "utf8"), markerContent);
  // The stray file and the gate directory itself must also survive: nothing was touched.
  assert.equal(await readFile(join(activeGate, ".DS_Store"), "utf8"), "not a marker");
  await assert.doesNotReject(() => stat(activeGate));
});

// --- ownership: the gate's read-before-mutex order and its produced marker --------------------
//
// The run lock got exactly this treatment in 1.1b (test/workflow-hook-ownership.test.js:109);
// the reservation gate never did. Now that the Pi coordinator extension wires a real
// readOwnOwnership into this store (see .pi/extensions/workflow-coordinator/index.ts), both
// properties below are reachable from a real, non-CLI caller and are worth pinning as facts a
// future edit cannot silently break, rather than merely true by inspection of acquireGate.

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

// Duplicated (not imported) from test/workflow-hook-ownership.test.js:38-46 deliberately: that
// file's header states it exists to prove exactly one property (write/read startedAt equality)
// and must not be diluted with wiring assertions, and every other fixture this test needs
// already lives in this file. Four lines here is far less duplication than threading this
// file's ~25 lines of reservation fixtures the other way. Kept byte-for-byte equivalent: the
// real createProcessRunner, `ps` invoked with allowFailure so a non-zero exit resolves instead
// of rejecting, and the real node:fs/promises realpath for reading /proc/<pid>/cwd -- the exact
// wiring bin/workflow.js's inspectDelegationPid gives `workflow delegation gate-clear`, which is
// the command whose verdict the marker test below is really about.
const runner = createProcessRunner();
async function observeViaUnlockPath(pid) {
  return inspectExactProcessByPid(pid, {
    async runProcess(resolvedPid) {
      return runner.run("ps", psStatusArgv(resolvedPid), { allowFailure: true });
    },
    readCwd: realpath,
  });
}

// 1.1's task-2 review deliberately moved the own-ownership read out of acquireGate's critical
// section: a slow `ps` spawn must never run while the mkdir-based gate is held, both to protect
// the bounded retry budget at :191-199 and to avoid widening the window where the active gate
// directory exists with no marker yet. Until the coordinator was wired, no non-CLI caller reached
// this gate with a real reader at all, so the ordering was only ever true by inspection. This
// makes it a fact a future edit cannot silently break.
test("readOwnOwnership is invoked before the active gate directory exists (the gate's read precedes acquisition, never runs while the mutex is held)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const activeGate = activeGatePathFor(stateRoot, "fixture-single");

  let activeGateExistedDuringRead;
  const reservations = createDelegationReservationStore({
    stateRoot,
    randomUUID: uuidSequence(FIRST_ID, SECOND_ID, THIRD_ID),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    canonicalPath: async (value) => value,
    async readOwnOwnership() {
      activeGateExistedDuringRead = await pathExists(activeGate);
      return { pid: "1", startedAt: "2025-01-01T00:00:00.000Z" };
    },
  });

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.equal(reservation.state, "active");
  assert.equal(
    activeGateExistedDuringRead,
    false,
    "readOwnOwnership ran while the active gate directory already existed -- the ownership read "
    + "must complete before the gate mutex is acquired, not during or after",
  );
});

// The coordinator now builds its reservation store with exactly this reader
// (createSubprocessOwnOwnershipReader), so this is the marker a real coordinator writes. The
// verdict assertion is the point: "not unprovable" alone would not distinguish a classifiable
// marker from a broken observation. This process is alive and its start time matches, so the one
// correct verdict is owner-alive.
test("a reservation gate acquired with the real subprocess ownership reader yields a marker classifyOwnership can rule on", async (t) => {
  // Degrade, don't silently pass: the reader swallows a missing/unusable `ps` and resolves null.
  const written = await createSubprocessOwnOwnershipReader()();
  if (!written) {
    t.skip("this host cannot report its own process start time via `ps`");
    return;
  }

  const stateRoot = await tempStateRoot(t);
  const markerPath = join(activeGatePathFor(stateRoot, "fixture-single"), "owner.json");
  const { fs, captured, chmodModes } = fsCapturingRead(markerPath);
  const reservations = createDelegationReservationStore({
    stateRoot,
    fs,
    randomUUID: uuidSequence(FIRST_ID, SECOND_ID, THIRD_ID),
    clock: clockSequence("2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z"),
    canonicalPath: async (value) => value,
    readOwnOwnership: createSubprocessOwnOwnershipReader(),
  });

  const reservation = await reservations.reserve({
    projectAlias: "fixture-single",
    delegationId: FIRST_ID,
    role: "code-reviewer",
    mode: "background",
    checkoutPath: "/fixture/source",
    policy,
  });

  assert.equal(reservation.state, "active");
  assert.ok(captured.text, "expected releaseGate to have read the gate owner marker");
  const marker = JSON.parse(captured.text);
  assert.equal(marker.version, 2);
  assert.equal(marker.pid, String(process.pid));
  assert.equal(marker.startedAt, written.startedAt);
  assert.deepEqual(chmodModes, [0o600]);

  const verdict = classifyOwnership(marker, await observeViaUnlockPath(marker.pid));
  assert.equal(verdict.verdict, "owner-alive");
  assert.equal(verdict.removable, false);
});
