import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as realFs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDelegationReservationStore } from "../src/workflow/delegation-reservations.js";

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
