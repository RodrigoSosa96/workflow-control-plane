import { WorkflowError } from "./errors.js";
import { claimTokenMatchesDigest, reservationMatchesDelegation, validateDelegationTransportIdentity } from "./delegation-invariants.js";

const ALLOWED_KEYS = new Set(["status", "generation", "summary", "verification", "concerns", "nextAction"]);
const HANDOFF_STATUSES = new Set(["completed", "blocked", "failed"]);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 4096;
const MAX_COMMAND_BYTES = 4096;
const MAX_STATUS_BYTES = 128;
const MAX_NEXT_ACTION_BYTES = 4096;
const MAX_CONCERN_BYTES = 1024;
const MAX_VERIFICATION = 20;
const MAX_CONCERNS = 20;

function fail(message, details) {
  throw new WorkflowError("HANDOFF", message, { details });
}

function assertObject(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${context} must be an object`);
  return value;
}

function assertString(value, context, limit) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${context} must be a bounded non-empty string`);
  }
  return value.trim();
}

function validateInputBytes(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    fail("Delegation handoff input must be JSON serializable");
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    fail("Delegation handoff input exceeds the byte limit");
  }
}

function validateVerification(value) {
  if (!Array.isArray(value) || value.length > MAX_VERIFICATION) fail("Delegation handoff verification must be a bounded array");
  return value.map((entry, index) => {
    assertObject(entry, `delegation handoff verification[${index}]`);
    for (const key of Object.keys(entry)) {
      if (key !== "command" && key !== "status") fail(`delegation handoff verification[${index}] contains unsupported field ${key}`);
    }
    return {
      command: assertString(entry.command, `delegation handoff verification[${index}].command`, MAX_COMMAND_BYTES),
      status: assertString(entry.status, `delegation handoff verification[${index}].status`, MAX_STATUS_BYTES),
    };
  });
}

function validateConcerns(value) {
  if (!Array.isArray(value) || value.length > MAX_CONCERNS) fail("Delegation handoff concerns must be a bounded array");
  return value.map((entry, index) => assertString(entry, `delegation handoff concerns[${index}]`, MAX_CONCERN_BYTES));
}

function validateInput(value) {
  assertObject(value, "delegation handoff input");
  validateInputBytes(value);
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) fail(`Delegation handoff input contains unsupported field ${key}`);
  }
  const status = assertString(value.status, "delegation handoff status", MAX_STATUS_BYTES);
  if (!HANDOFF_STATUSES.has(status)) fail("Delegation handoff status is unsupported");
  if (!Number.isInteger(value.generation) || value.generation < 1) fail("Delegation handoff generation must be a positive integer");
  return {
    status,
    generation: value.generation,
    summary: assertString(value.summary, "delegation handoff summary", MAX_SUMMARY_BYTES),
    verification: validateVerification(value.verification),
    concerns: validateConcerns(value.concerns),
    nextAction: assertString(value.nextAction, "delegation handoff nextAction", MAX_NEXT_ACTION_BYTES),
  };
}

function recordFor(run, delegationId) {
  const record = run?.delegations?.[delegationId];
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("Delegation was not found");
  return structuredClone(record);
}

// Was the loosest of the four transport-identity checks: it verified only
// kind/runId/delegationId, so a persisted identity missing sessionPath/cwd/
// pid/processStartedAt, carrying the wrong type for any of them, or carrying
// extra fields, passed through untouched. Delegating to the shared definition
// (see delegation-invariants.js) makes this the same strict shape check
// delegation-store.js already enforces when it first records the identity —
// this call now catches state that drifted or was tampered with after that.
function assertTransportIdentity(record, runId, delegationId) {
  validateDelegationTransportIdentity(record.transportIdentity, runId, delegationId, fail);
}

export async function submitDelegationHandoff({ runId, delegationId, input, store, delegations, reservations, claimToken } = {}) {
  if (!store || typeof store.read !== "function") fail("Delegation handoff requires a run store");
  if (!delegations || typeof delegations.recordResult !== "function") fail("Delegation handoff requires a compatible delegation store");
  if (!reservations || typeof reservations.list !== "function") fail("Delegation handoff requires a compatible reservation store");
  const run = await store.read(assertString(runId, "delegation handoff run ID", 128));
  const id = assertString(delegationId, "delegation handoff delegation ID", 128);
  const record = recordFor(run, id);
  assertTransportIdentity(record, run.id, id);
  const normalized = validateInput(input);
  if (record.generation !== normalized.generation) fail("Delegation handoff generation is not current");
  const matches = (await reservations.list({ projectAlias: run.projectAlias })).filter((reservation) => reservationMatchesDelegation(record, reservation));
  if (matches.length !== 1) fail("Delegation reservation is missing or has changed");

  // This is the boundary an untrusted child crosses: run ID, delegation ID, and
  // generation are all discoverable by any same-user process (a sibling
  // delegation can enumerate them under the run directory), so identity alone
  // cannot authenticate a result. The per-delegation secret minted at claim
  // time and handed to the child through its private env only closes that; the
  // record stores only its digest, so reading run.json does not reveal it.
  // A remediation generation carries its own token, enforced by recordResult.
  const activeRemediation = record.remediation?.state === "active"
    && record.remediation?.generation === normalized.generation;
  if (!activeRemediation && record.claimTokenDigest) {
    const presented = assertString(claimToken, "delegation handoff claim token", 128);
    if (!claimTokenMatchesDigest(presented, record.claimTokenDigest)) {
      fail("Delegation handoff claim token does not match the active delegation");
    }
  }
  const recorded = activeRemediation
    ? await delegations.recordResult({ runId: run.id, delegationId: id, result: normalized, claimToken })
    : await delegations.recordResult({ runId: run.id, delegationId: id, result: normalized });

  // The delegation is terminal now, so its reservation must stop counting
  // against per-project capacity. Best-effort: the advisory result is already
  // recorded and must not be undone by a lease-file failure, and a lease that
  // survives stays visible as `reservation.state: active` in
  // `workflow delegation reconcile`, where `workflow delegation release` clears it.
  if (typeof reservations.releaseForDelegation === "function") {
    try {
      await reservations.releaseForDelegation({ projectAlias: run.projectAlias, delegationId: id });
    } catch {
      // Reported by reconcile rather than failing a recorded handoff.
    }
  }
  return recorded;
}
