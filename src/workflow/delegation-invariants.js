// The reservation resources/match invariant, defined once. Lease creation
// (delegation-reservations.js) and every later verification
// (delegation-handoff.js) used to hand-roll their own copy of "what does
// this role/mode/checkout reserve" and "does this reservation still cover
// that delegation". They had drifted; this module is the one place both now
// call, so the layers stay the same predicate evaluated twice rather than
// two approximations of it.
//
// coordinator-policy.js still carries its own, weaker copy
// (reservationResources/reservationAllows, missing the checkout digest
// requirement) — migrating it changes an authorization outcome, so it is
// deliberately left alone here for its own task with its own
// failing-against-old-code test.

import { createHash } from "node:crypto";
import { classifyDelegationRole } from "./delegation-policy.js";

// sha256 hex digest of a string, exactly as reservation records' checkoutDigest
// field is minted and as a match check re-derives it from a delegation's cwd.
export function checkoutDigestFor(cwd) {
  return createHash("sha256").update(cwd, "utf8").digest("hex");
}

// The resources a delegation of this role/mode/checkout consumes against
// project capacity. Pure list-building only: whether a background writer or
// an invalid mode is *allowed* is a lease-creation policy decision, not part
// of the resource list, and stays with the caller that has a policy to
// check against.
export function reservationResourceList({ role, mode, checkoutDigest }) {
  const kind = classifyDelegationRole(role);
  const resources = ["totalInternal"];
  if (mode === "foreground") resources.push("foreground");
  if (kind === "read-only" && mode === "background") resources.push("readOnlyBackground");
  if (kind === "writer") resources.push("writersTotal", `checkout:${checkoutDigest}`);
  return resources;
}

// Does `reservation` still authorize `record` (a delegation record carrying
// id, role, mode, cwd)? Checks identity (state, delegationId, role, mode,
// checkout) and that every resource reservationResourceList requires for
// this role/mode/checkout is present. A predicate, not a validator — it
// returns false rather than throwing, so callers that need a reason keep
// their own checks around this.
export function reservationMatchesDelegation(record, reservation) {
  if (!reservation || typeof reservation !== "object") return false;
  if (
    reservation.state !== "active"
    || reservation.delegationId !== record.id
    || reservation.role !== record.role
    || reservation.mode !== record.mode
  ) {
    return false;
  }
  const checkoutDigest = checkoutDigestFor(record.cwd);
  if (reservation.checkoutDigest !== checkoutDigest || !Array.isArray(reservation.resources)) return false;
  const expected = reservationResourceList({ role: record.role, mode: record.mode, checkoutDigest });
  return expected.every((resource) => reservation.resources.includes(resource));
}
