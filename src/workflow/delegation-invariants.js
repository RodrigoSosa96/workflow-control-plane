// The reservation resources/match invariant, defined once. Lease creation
// (delegation-reservations.js) and every later verification (delegation-handoff.js,
// coordinator-policy.js) evaluate this one predicate, so the layers stay the same predicate
// applied repeatedly rather than separate approximations that can drift. The match compares the
// reservation's checkoutDigest against the delegation's cwd and its role/mode against the
// delegation's: a reservation minted for a different role, mode, or checkout must never
// authorize the delegation.
//
// The transport identity shape below is the same idea for a different invariant: one strict
// definition (exact key set, kind === "pi-delegation", bounded strings, absolute
// sessionPath/cwd, runId/delegationId cross-check) shared by the recording, service-boundary,
// and untrusted-child-boundary checks, so a tampered or corrupted record fails shape validation
// instead of silently proceeding.
//
// pi-delegation-transport.js keeps its own copy rather than calling this one: it validates a
// standalone identity with no expected runId/delegationId to cross-check against (that check,
// where it applies, happens one layer up via remediationContext), and it canonicalizes
// sessionPath/cwd with path.resolve() to match the containment checks (ensureContained) the rest
// of that module relies on for path-traversal safety. That is a different job, not a laxer
// version of this one, so it is not migrated here.

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { classifyDelegationRole } from "./delegation-policy.js";

// Exported (not just module-private) so pi-delegation-transport.js's own
// assertTransportIdentity — which validates a different shape (see that
// module's comment on why it is not migrated to
// validateDelegationTransportIdentity below) — can still share this exact
// key set rather than carrying a second byte-for-byte copy that could drift
// if a field is ever added here.
export const TRANSPORT_IDENTITY_KEYS = new Set(["kind", "runId", "delegationId", "sessionPath", "cwd", "pid", "processStartedAt"]);
const MAX_SHORT_TEXT = 4096;

function assertIdentityString(value, context, { limit = MAX_SHORT_TEXT, absolute = false } = {}, fail) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${context} must be a bounded non-empty string`);
  }
  if (absolute && !isAbsolute(value)) fail(`${context} must be an absolute path`);
  return value;
}

// The delegation transport identity shape, defined once — see the module
// header above for how each caller's own copy compared to this one. Validates
// `value` against the exact key set a pi-delegation transport identity
// carries and cross-checks it against the caller's expected runId/
// delegationId, returning the normalized identity. Raises through the
// caller-supplied `fail(message)` rather than throwing directly, since each
// layer keeps its own error convention (WorkflowError category, exception
// type, and extra details differ across callers).
export function validateDelegationTransportIdentity(value, runId, delegationId, fail) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("transport identity must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!TRANSPORT_IDENTITY_KEYS.has(key)) fail(`transport identity contains unsupported field ${key}`);
  }
  if (value.kind !== "pi-delegation") fail("transport identity kind is unsupported");
  const identity = {
    kind: "pi-delegation",
    runId: assertIdentityString(value.runId, "transport identity runId", { limit: 128 }, fail),
    delegationId: assertIdentityString(value.delegationId, "transport identity delegationId", { limit: 128 }, fail),
    sessionPath: assertIdentityString(value.sessionPath, "transport identity sessionPath", { limit: MAX_SHORT_TEXT, absolute: true }, fail),
    cwd: assertIdentityString(value.cwd, "transport identity cwd", { limit: MAX_SHORT_TEXT, absolute: true }, fail),
    pid: assertIdentityString(value.pid, "transport identity pid", { limit: 128 }, fail),
    processStartedAt: assertIdentityString(value.processStartedAt, "transport identity processStartedAt", { limit: 128 }, fail),
  };
  if (identity.runId !== runId || identity.delegationId !== delegationId) {
    fail("transport identity does not match the delegation");
  }
  return identity;
}

// sha256 hex digest of a string, exactly as reservation records' checkoutDigest
// field is minted and as a match check re-derives it from a delegation's cwd.
export function checkoutDigestFor(cwd) {
  return createHash("sha256").update(cwd, "utf8").digest("hex");
}

// True when `presentedToken`, lowercased, hashes to `storedDigest`. This is
// the authentication check at the boundary an untrusted delegation child
// crosses: the token is minted at claim time and reaches the child only
// through its private environment, while the record persists only this
// digest (so a sibling reading the run record cannot recover the token from
// it). delegation-store.js (recordResult's remediation branch and its three
// remediation-launch guards: completeRemediationLaunch,
// rollbackRemediationLaunch, markRemediationLaunchManualRecovery) and
// delegation-handoff.js each hand-rolled this same comparison; this is the
// one definition. A predicate, not a validator — it returns false rather
// than throwing on a missing token or digest, so callers keep their own
// shape checks (delegation-store.js's validateClaimToken enforces the UUID
// shape and throws) and their own failure messages around this.
export function claimTokenMatchesDigest(presentedToken, storedDigest) {
  if (typeof presentedToken !== "string" || !presentedToken) return false;
  if (typeof storedDigest !== "string" || !storedDigest) return false;
  return `sha256:${createHash("sha256").update(presentedToken.toLowerCase(), "utf8").digest("hex")}` === storedDigest;
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
