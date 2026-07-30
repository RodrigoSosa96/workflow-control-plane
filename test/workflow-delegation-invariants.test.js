import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  checkoutDigestFor,
  reservationMatchesDelegation,
  reservationResourceList,
  validateDelegationTransportIdentity,
} from "../src/workflow/delegation-invariants.js";

const READ_ONLY_ROLES = ["scout", "spec-reviewer", "code-reviewer"];
const WRITER_ROLE = "sdd-implementer";
const CHECKOUT_DIGEST = createHash("sha256").update("/fixture/checkout", "utf8").digest("hex");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DELEGATION_ID = "22222222-2222-4222-8222-222222222222";

function transportIdentity(overrides = {}) {
  return {
    kind: "pi-delegation",
    runId: RUN_ID,
    delegationId: DELEGATION_ID,
    sessionPath: "/private/session.jsonl",
    cwd: "/fixture/review",
    pid: "12345",
    processStartedAt: "2025-01-01T00:10:00.000Z",
    ...overrides,
  };
}

function collectFailure(fn) {
  const messages = [];
  const fail = (message) => {
    messages.push(message);
    throw new Error(message);
  };
  try {
    fn(fail);
    return { threw: false, messages };
  } catch {
    return { threw: true, messages };
  }
}

function record(overrides = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    role: "code-reviewer",
    mode: "background",
    cwd: "/fixture/checkout",
    ...overrides,
  };
}

function reservation(overrides = {}) {
  return {
    state: "active",
    delegationId: "22222222-2222-4222-8222-222222222222",
    role: "code-reviewer",
    mode: "background",
    checkoutDigest: CHECKOUT_DIGEST,
    resources: ["totalInternal", "readOnlyBackground"],
    ...overrides,
  };
}

test("checkoutDigestFor returns the sha256 hex digest of the given string", () => {
  const expected = createHash("sha256").update("/fixture/checkout", "utf8").digest("hex");
  assert.equal(checkoutDigestFor("/fixture/checkout"), expected);
  assert.match(checkoutDigestFor("/fixture/checkout"), /^[0-9a-f]{64}$/);
});

test("checkoutDigestFor is sensitive to its input", () => {
  assert.notEqual(checkoutDigestFor("/fixture/checkout-a"), checkoutDigestFor("/fixture/checkout-b"));
});

for (const role of READ_ONLY_ROLES) {
  test(`reservationResourceList for read-only role "${role}" in foreground includes foreground but not readOnlyBackground or checkout`, () => {
    const resources = reservationResourceList({ role, mode: "foreground", checkoutDigest: CHECKOUT_DIGEST });
    assert.deepEqual(resources, ["totalInternal", "foreground"]);
  });

  test(`reservationResourceList for read-only role "${role}" in background includes readOnlyBackground but not the checkout resource`, () => {
    const resources = reservationResourceList({ role, mode: "background", checkoutDigest: CHECKOUT_DIGEST });
    assert.deepEqual(resources, ["totalInternal", "readOnlyBackground"]);
    assert.ok(!resources.some((resource) => resource.startsWith("checkout:")));
    assert.ok(!resources.includes("writersTotal"));
  });
}

test("reservationResourceList for the writer role in foreground includes writersTotal and the checkout resource", () => {
  const resources = reservationResourceList({ role: WRITER_ROLE, mode: "foreground", checkoutDigest: CHECKOUT_DIGEST });
  assert.deepEqual(resources, ["totalInternal", "foreground", "writersTotal", `checkout:${CHECKOUT_DIGEST}`]);
});

test("reservationResourceList for the writer role in background includes writersTotal and the checkout resource but not foreground or readOnlyBackground", () => {
  const resources = reservationResourceList({ role: WRITER_ROLE, mode: "background", checkoutDigest: CHECKOUT_DIGEST });
  assert.deepEqual(resources, ["totalInternal", "writersTotal", `checkout:${CHECKOUT_DIGEST}`]);
  assert.ok(!resources.includes("foreground"));
  assert.ok(!resources.includes("readOnlyBackground"));
});

test("reservationResourceList always includes totalInternal", () => {
  for (const role of [...READ_ONLY_ROLES, WRITER_ROLE]) {
    for (const mode of ["foreground", "background"]) {
      assert.ok(reservationResourceList({ role, mode, checkoutDigest: CHECKOUT_DIGEST }).includes("totalInternal"));
    }
  }
});

test("reservationResourceList rejects an unmanaged role", () => {
  assert.throws(() => reservationResourceList({ role: "unknown-role", mode: "foreground", checkoutDigest: CHECKOUT_DIGEST }));
});

test("reservationMatchesDelegation matches an active reservation covering every required resource", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation()), true);
});

test("reservationMatchesDelegation matches a writer reservation carrying its checkout resource", () => {
  const writerRecord = record({ role: WRITER_ROLE, mode: "foreground" });
  const writerReservation = reservation({
    role: WRITER_ROLE,
    mode: "foreground",
    resources: ["totalInternal", "foreground", "writersTotal", `checkout:${CHECKOUT_DIGEST}`],
  });
  assert.equal(reservationMatchesDelegation(writerRecord, writerReservation), true);
});

test("reservationMatchesDelegation tolerates extra resources beyond what is required", () => {
  const extra = reservation({ resources: ["totalInternal", "readOnlyBackground", "some-future-resource"] });
  assert.equal(reservationMatchesDelegation(record(), extra), true);
});

test("reservationMatchesDelegation rejects a missing reservation", () => {
  assert.equal(reservationMatchesDelegation(record(), null), false);
  assert.equal(reservationMatchesDelegation(record(), undefined), false);
});

test("reservationMatchesDelegation rejects a non-object reservation", () => {
  assert.equal(reservationMatchesDelegation(record(), "not-a-reservation"), false);
});

test("reservationMatchesDelegation rejects a reservation that is not active", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation({ state: "released" })), false);
});

test("reservationMatchesDelegation rejects a reservation for a different delegation", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation({ delegationId: "33333333-3333-4333-8333-333333333333" })), false);
});

test("reservationMatchesDelegation rejects a reservation for a different role", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation({ role: "scout" })), false);
});

test("reservationMatchesDelegation rejects a reservation for a different mode", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation({ mode: "foreground" })), false);
});

test("reservationMatchesDelegation rejects a reservation whose checkoutDigest does not match the record's cwd", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation({ checkoutDigest: "0".repeat(64) })), false);
});

test("reservationMatchesDelegation rejects a reservation whose resources are not an array", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation({ resources: "totalInternal" })), false);
});

test("reservationMatchesDelegation rejects a writer reservation missing the checkout resource", () => {
  const writerRecord = record({ role: WRITER_ROLE, mode: "background" });
  const missingCheckout = reservation({ role: WRITER_ROLE, mode: "background", resources: ["totalInternal", "writersTotal"] });
  assert.equal(reservationMatchesDelegation(writerRecord, missingCheckout), false);
});

test("reservationMatchesDelegation rejects a reservation missing a required resource", () => {
  assert.equal(reservationMatchesDelegation(record(), reservation({ resources: ["totalInternal"] })), false);
});

test("reservationMatchesDelegation derives the expected checkout digest from record.cwd, not from the reservation", () => {
  const otherCwdRecord = record({ cwd: "/fixture/other-checkout" });
  // The reservation's checkoutDigest was minted for /fixture/checkout, so a record claiming a
  // different cwd must not match even though every other field lines up.
  assert.equal(reservationMatchesDelegation(otherCwdRecord, reservation()), false);
});

test("validateDelegationTransportIdentity accepts a well-formed identity and returns it normalized", () => {
  const { threw, messages } = collectFailure((fail) => {
    const result = validateDelegationTransportIdentity(transportIdentity(), RUN_ID, DELEGATION_ID, fail);
    assert.deepEqual(result, transportIdentity());
  });
  assert.equal(threw, false);
  assert.deepEqual(messages, []);
});

test("validateDelegationTransportIdentity rejects a non-object value", () => {
  const { threw, messages } = collectFailure((fail) => validateDelegationTransportIdentity(null, RUN_ID, DELEGATION_ID, fail));
  assert.equal(threw, true);
  assert.match(messages[0], /must be an object/);
});

test("validateDelegationTransportIdentity rejects an identity carrying an unsupported field", () => {
  const { threw, messages } = collectFailure((fail) => (
    validateDelegationTransportIdentity(transportIdentity({ extra: "unexpected" }), RUN_ID, DELEGATION_ID, fail)
  ));
  assert.equal(threw, true);
  assert.match(messages[0], /unsupported field extra/);
});

test("validateDelegationTransportIdentity rejects an identity missing a required field", () => {
  const value = transportIdentity();
  delete value.cwd;
  const { threw, messages } = collectFailure((fail) => validateDelegationTransportIdentity(value, RUN_ID, DELEGATION_ID, fail));
  assert.equal(threw, true);
  assert.match(messages[0], /transport identity cwd/);
});

test("validateDelegationTransportIdentity rejects an unsupported kind", () => {
  const { threw, messages } = collectFailure((fail) => (
    validateDelegationTransportIdentity(transportIdentity({ kind: "codex-delegation" }), RUN_ID, DELEGATION_ID, fail)
  ));
  assert.equal(threw, true);
  assert.match(messages[0], /kind is unsupported/);
});

test("validateDelegationTransportIdentity rejects a relative sessionPath or cwd", () => {
  const relativeSessionPath = collectFailure((fail) => (
    validateDelegationTransportIdentity(transportIdentity({ sessionPath: "relative/session.jsonl" }), RUN_ID, DELEGATION_ID, fail)
  ));
  assert.equal(relativeSessionPath.threw, true);
  assert.match(relativeSessionPath.messages[0], /sessionPath must be an absolute path/);

  const relativeCwd = collectFailure((fail) => (
    validateDelegationTransportIdentity(transportIdentity({ cwd: "relative/checkout" }), RUN_ID, DELEGATION_ID, fail)
  ));
  assert.equal(relativeCwd.threw, true);
  assert.match(relativeCwd.messages[0], /cwd must be an absolute path/);
});

test("validateDelegationTransportIdentity rejects an oversized field", () => {
  const { threw, messages } = collectFailure((fail) => (
    validateDelegationTransportIdentity(transportIdentity({ pid: "1".repeat(129) }), RUN_ID, DELEGATION_ID, fail)
  ));
  assert.equal(threw, true);
  assert.match(messages[0], /transport identity pid/);
});

test("validateDelegationTransportIdentity rejects an identity whose runId or delegationId does not match the caller's expectation", () => {
  const wrongRun = collectFailure((fail) => validateDelegationTransportIdentity(transportIdentity(), "99999999-9999-4999-8999-999999999999", DELEGATION_ID, fail));
  assert.equal(wrongRun.threw, true);
  assert.match(wrongRun.messages[0], /does not match the delegation/);

  const wrongDelegation = collectFailure((fail) => validateDelegationTransportIdentity(transportIdentity(), RUN_ID, "99999999-9999-4999-8999-999999999999", fail));
  assert.equal(wrongDelegation.threw, true);
  assert.match(wrongDelegation.messages[0], /does not match the delegation/);
});

test("validateDelegationTransportIdentity raises through the caller-supplied fail function rather than a fixed exception type", () => {
  class CustomError extends Error {}
  assert.throws(
    () => validateDelegationTransportIdentity(null, RUN_ID, DELEGATION_ID, (message) => {
      throw new CustomError(message);
    }),
    CustomError,
  );
});
