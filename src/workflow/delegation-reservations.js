import { createHash, randomUUID as defaultRandomUUID } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { classifyDelegationRole, validateDelegationPolicy } from "./delegation-policy.js";
import { checkoutDigestFor, reservationResourceList } from "./delegation-invariants.js";
import { WorkflowError } from "./errors.js";
import { MUTEX_RETRY_BUDGET_MS, retryWithinBudget } from "./bounded-retry.js";
import { removeOwnedMutex } from "./mutex-removal.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVATION_ROOT = "delegation-reservations";
const GATE_MARKER_NAME = "owner.json";

function fail(message, details) {
  throw new WorkflowError("delegation-reservation", message, { details });
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${context} must be an object`);
  return value;
}

function assertString(value, context, limit = 4096) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > limit) {
    fail(`${context} must be a bounded non-empty string`);
  }
  return value;
}

function digestKey(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timestamp(clock) {
  const value = typeof clock === "function" ? clock() : clock?.now?.();
  const normalized = value instanceof Date ? value.toISOString() : typeof value === "number" ? new Date(value).toISOString() : value;
  if (typeof normalized !== "string" || !normalized.trim() || Number.isNaN(Date.parse(normalized))) {
    fail("clock must return a valid timestamp");
  }
  return normalized;
}

function uuid(randomUUID, context) {
  const value = randomUUID();
  if (typeof value !== "string" || !UUID_RE.test(value)) fail(`${context} generator returned an invalid UUID`);
  return value.toLowerCase();
}

async function defaultCanonicalPath(value) {
  return resolve(value);
}

// Lease-creation policy decisions (a valid mode, whether policy allows a
// background writer) live here, not in the shared resource list — that list
// only says what a role/mode/checkout consumes, not whether creating a
// lease for it is currently permitted.
function resourceList({ role, mode, checkoutDigest, policy }) {
  const kind = classifyDelegationRole(role);
  if (mode !== "foreground" && mode !== "background") fail("reservation mode must be foreground or background");
  if (kind === "writer" && mode === "background" && policy.allowBackgroundWriters !== true) {
    fail("background writer reservations are disabled by policy");
  }
  return reservationResourceList({ role, mode, checkoutDigest });
}

function capacityFor(resource, policy) {
  if (resource.startsWith("checkout:")) return policy.writersPerCheckout;
  return policy[resource];
}

function validateReservationRecord(value, projectDigest) {
  assertObject(value, "reservation record");
  if (value.version !== 1 || typeof value.id !== "string" || !UUID_RE.test(value.id)) fail("Malformed reservation record");
  if (typeof value.ownerToken !== "string" || !UUID_RE.test(value.ownerToken)) fail("Malformed reservation record");
  if (value.projectDigest !== projectDigest || typeof value.checkoutDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.checkoutDigest)) {
    fail("Malformed reservation record");
  }
  if (!Array.isArray(value.resources) || value.resources.some((resource) => typeof resource !== "string")) fail("Malformed reservation record");
  if (value.state !== "active" && value.state !== "released") fail("Malformed reservation record");
  return value;
}

export function createDelegationReservationStore({
  stateRoot,
  fs = defaultFs,
  clock = () => new Date().toISOString(),
  randomUUID = defaultRandomUUID,
  canonicalPath = defaultCanonicalPath,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryNow = () => performance.now(),
  readOwnOwnership = async () => null,
} = {}) {
  const root = resolve(assertString(stateRoot, "reservation state root"));
  if (typeof randomUUID !== "function" || typeof canonicalPath !== "function") fail("reservation store requires randomUUID and canonicalPath functions");
  if (typeof sleep !== "function") fail("reservation store requires a sleep function");
  if (typeof retryNow !== "function") fail("reservation store requires a retryNow function");
  if (typeof readOwnOwnership !== "function") fail("reservation store requires a readOwnOwnership function");
  let tempCounter = 0;

  async function chmodDirectory(path) {
    try {
      await fs.chmod(path, PRIVATE_DIR_MODE);
    } catch (error) {
      fail(`Unable to set private mode on reservation directory (${error?.code ?? "FS_ERROR"})`);
    }
  }

  async function chmodFile(path) {
    try {
      await fs.chmod(path, PRIVATE_FILE_MODE);
    } catch (error) {
      fail(`Unable to set private mode on reservation file (${error?.code ?? "FS_ERROR"})`);
    }
  }

  async function ensureDirectory(path) {
    try {
      await fs.mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (error) {
      fail(`Unable to create reservation directory (${error?.code ?? "FS_ERROR"})`);
    }
    await chmodDirectory(path);
  }

  async function writeAtomicJson(path, value) {
    tempCounter += 1;
    const temporary = join(dirname(path), `.${path.split("/").at(-1)}.${process.pid}.${tempCounter}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "w", PRIVATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, path);
      await chmodFile(path);
    } catch (error) {
      try {
        await handle?.close();
      } catch {}
      fail(`Unable to write reservation record (${error?.code ?? "FS_ERROR"})`);
    }
  }

  async function readJson(path) {
    let text;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (error) {
      fail(`Unable to read reservation record (${error?.code ?? "FS_ERROR"})`);
    }
    try {
      return JSON.parse(text);
    } catch {
      fail("Malformed reservation record");
    }
  }

  function projectPaths(projectDigest) {
    const project = join(root, RESERVATION_ROOT, "projects", projectDigest);
    return {
      project,
      leases: join(project, "leases"),
      gate: join(project, "gate"),
      activeGate: join(project, "gate", "active"),
    };
  }

  async function acquireGate(paths) {
    // Read this process's own start time before touching any gate state. A slow `ps` spawn
    // must never run while the mkdir-based mutex is held: it would eat into the bounded retry
    // budget below, and it would widen the window where the active directory exists with no
    // marker yet. A throw here must never block acquisition — the marker is simply written
    // without a provable start time, same as a version-1 marker. createOwnOwnershipReader (not
    // this store) is the only place that memoizes, so calling this again on a retry is cheap.
    let processOwnership = null;
    try {
      processOwnership = await readOwnOwnership();
    } catch {
      processOwnership = null;
    }

    await ensureDirectory(root);
    await ensureDirectory(join(root, RESERVATION_ROOT));
    await ensureDirectory(join(root, RESERVATION_ROOT, "projects"));
    await ensureDirectory(paths.project);
    await ensureDirectory(paths.leases);
    await ensureDirectory(paths.gate);
    // The gate is a mkdir mutex held for a single read-modify-write. Concurrent
    // holders are millisecond-scale, so a bounded retry absorbs a live collision
    // instead of telling the operator to inspect a gate that is about to clear.
    // Crash residue still ends in the manual-inspection error, unchanged. The
    // retry itself is shared with run-store.js's acquireLockWithRetry -- see
    // bounded-retry.js for why it budgets wall time instead of attempt count.
    try {
      await retryWithinBudget(
        () => fs.mkdir(paths.activeGate, { mode: PRIVATE_DIR_MODE }),
        { shouldRetry: (error) => error?.code === "EEXIST", budgetMs: MUTEX_RETRY_BUDGET_MS, now: retryNow, sleep },
      );
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail(`Unable to acquire reservation project gate (${error?.code ?? "FS_ERROR"})`);
      }
      fail("Reservation project gate is active; manual inspection required");
    }
    await chmodDirectory(paths.activeGate);
    const ownerToken = uuid(randomUUID, "reservation gate owner token");
    const markerPath = join(paths.activeGate, GATE_MARKER_NAME);
    const marker = {
      version: 2,
      ownerToken,
      ...(processOwnership ? { pid: processOwnership.pid, startedAt: processOwnership.startedAt } : {}),
    };
    await writeAtomicJson(markerPath, marker);
    return { ...paths, ownerToken, markerPath };
  }

  async function releaseGate(gate) {
    const marker = await readJson(gate.markerPath);
    if ((marker?.version !== 1 && marker?.version !== 2) || marker.ownerToken !== gate.ownerToken) {
      fail("Reservation gate ownership could not be verified; manual inspection required");
    }
    try {
      await fs.unlink(gate.markerPath);
      await fs.rmdir(gate.activeGate);
    } catch (error) {
      fail(`Reservation gate ownership could not be released (${error?.code ?? "FS_ERROR"}); manual inspection required`);
    }
  }

  function isGateMarkerName(name) {
    return name === GATE_MARKER_NAME;
  }

  // Shared by inspectGate (read-only) and clearGate (which calls this twice to check-then-act).
  // Never mkdirs, chmods, or writes anything — it only stats/reads what acquireGate/releaseGate
  // already produced. Returns null when there is no active gate directory at all.
  async function inspectGateInternal(paths) {
    let activeStat;
    try {
      activeStat = await fs.stat(paths.activeGate);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      fail(`Unable to inspect reservation project gate (${error?.code ?? "FS_ERROR"})`);
    }
    if (!activeStat.isDirectory()) return null;

    let entries;
    try {
      entries = await fs.readdir(paths.activeGate);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      fail(`Unable to list reservation project gate (${error?.code ?? "FS_ERROR"})`);
    }

    // Only the exact owner.json shape acquireGate ever writes counts as a marker. A stray file
    // (an editor temp, a .DS_Store) must never be guessed at as "the" marker. (Unlike
    // run-store's owner-<token>.json pattern match, this exact-name filter can only ever find
    // zero or one match — a directory cannot hold two entries with an identical name — so there
    // is no genuinely ambiguous case to track here.)
    const markerNames = entries.filter(isGateMarkerName);
    if (markerNames.length !== 1) {
      return { activeGate: paths.activeGate, activeStat, entries, markerPath: null, markerText: null, marker: null };
    }

    const markerPath = join(paths.activeGate, markerNames[0]);
    let markerText = null;
    try {
      markerText = await fs.readFile(markerPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") fail(`Unable to read reservation gate owner marker (${error?.code ?? "FS_ERROR"})`);
    }

    let marker = null;
    if (markerText !== null) {
      try {
        marker = JSON.parse(markerText);
      } catch {
        marker = null;
      }
    }

    return { activeGate: paths.activeGate, activeStat, entries, markerPath, markerText, marker };
  }

  // Read-only diagnosis for a future `workflow delegation gate-clear` command: must never
  // acquire the gate it inspects and must never mutate, unlike every other gate path here.
  async function inspectGate({ projectAlias } = {}) {
    const alias = assertString(projectAlias, "reservation project alias", 512);
    const projectDigest = digestKey(alias);
    const inspected = await inspectGateInternal(projectPaths(projectDigest));
    if (!inspected) return null;
    const { activeGate, markerPath, marker } = inspected;
    return { activeGate, markerPath, marker };
  }

  // Removes an active gate only when the caller's `allow` predicate approves the currently
  // observed marker, then re-verifies both the active directory's identity (the same dev/ino
  // comparison releaseGate's paired acquire/release implicitly trusts) and the marker's raw
  // bytes immediately before deleting anything — and again, identity only, immediately before
  // rmdir. A change in either window (a fresh acquisition, a different marker) refuses instead
  // of deleting unknown state. Refuses by returning a reason; it only throws for anomalies
  // discovered after the rmdir itself has already begun. The choreography itself lives in
  // mutex-removal.js's removeOwnedMutex, shared with run-store.js's removeLock; this function
  // supplies the gate-specific inspect/error-wrapping/success-shape and the "active gate" noun.
  async function clearGate({ projectAlias, allow } = {}) {
    if (typeof allow !== "function") fail("clearGate allow must be a function");
    const alias = assertString(projectAlias, "reservation project alias", 512);
    const projectDigest = digestKey(alias);
    const paths = projectPaths(projectDigest);

    async function inspect() {
      const internal = await inspectGateInternal(paths);
      if (!internal) return null;
      return {
        dirPath: internal.activeGate,
        dirStat: internal.activeStat,
        markerPath: internal.markerPath,
        markerText: internal.markerText,
        marker: internal.marker,
        entries: internal.entries,
      };
    }

    // The shared choreography only knows "refuse on ENOENT/ENOTDIR, otherwise throw" for the
    // unlink and post-unlink stat steps; it deliberately does not know this store's own error
    // wrapping convention. Wrap fs.unlink/fs.stat here so an unexpected error still comes out
    // exactly as it did before this call moved into mutex-removal.js. fs.rmdir stays unwrapped:
    // its full anomaly handling is delegated to onRmdirError instead.
    const removalFs = {
      unlink: async (path) => {
        try {
          await fs.unlink(path);
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw error;
          fail(`Unable to remove reservation gate owner marker (${error?.code ?? "FS_ERROR"})`);
        }
      },
      stat: async (path) => {
        try {
          return await fs.stat(path);
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw error;
          fail(`Unable to inspect reservation project gate (${error?.code ?? "FS_ERROR"})`);
        }
      },
      rmdir: (path) => fs.rmdir(path),
    };

    const result = await removeOwnedMutex({
      inspect,
      allow,
      fs: removalFs,
      noun: "active gate",
      onRemoved: (recheck) => ({ cleared: true, activeGate: recheck.dirPath }),
      onRmdirError: (error) => {
        // At this point the owner marker is already unlinked -- only the directory removal
        // itself failed. Say both facts: what removal already committed (the marker, the
        // ownership evidence) and what it could not finish (the directory), matching this
        // spec's "reports exactly what was removed and what remains" requirement instead of
        // leaving an operator to guess whether the marker survived.
        fail(`The reservation gate owner marker was already removed, but the active gate directory could not be removed (${error?.code ?? "FS_ERROR"}); manual inspection required`);
      },
    });

    if (result.refused) return { cleared: false, reason: result.reason };
    return result;
  }

  async function withProjectGate(projectDigest, callback) {
    const gate = await acquireGate(projectPaths(projectDigest));
    let result;
    let callbackError;
    try {
      result = await callback(gate);
    } catch (error) {
      callbackError = error;
    }
    let releaseError;
    try {
      await releaseGate(gate);
    } catch (error) {
      releaseError = error;
    }
    if (releaseError) throw releaseError;
    if (callbackError) throw callbackError;
    return result;
  }

  async function readRecords(paths, projectDigest) {
    let entries;
    try {
      entries = await fs.readdir(paths.leases, { withFileTypes: true });
    } catch (error) {
      fail(`Unable to list reservation records (${error?.code ?? "FS_ERROR"})`);
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(paths.leases, entry.name);
      await chmodFile(path);
      const record = validateReservationRecord(await readJson(path), projectDigest);
      records.push({ ...record, path });
    }
    records.sort((left, right) => left.id.localeCompare(right.id));
    return records;
  }

  async function reserve({ projectAlias, delegationId, role, mode, checkoutPath, policy } = {}) {
    const alias = assertString(projectAlias, "reservation project alias", 512);
    const id = assertString(delegationId, "reservation delegation ID", 128);
    if (!UUID_RE.test(id)) fail("reservation delegation ID must be a UUID");
    assertString(role, "reservation role", 128);
    const effectivePolicy = validateDelegationPolicy(policy, "reservation policy");
    const canonicalCheckout = await canonicalPath(assertString(checkoutPath, "reservation checkout path"));
    const normalizedCheckout = assertString(canonicalCheckout, "canonical reservation checkout path");
    const projectDigest = digestKey(alias);
    const checkoutDigest = checkoutDigestFor(normalizedCheckout);
    const resources = resourceList({ role, mode, checkoutDigest, policy: effectivePolicy });
    const reservationId = uuid(randomUUID, "reservation ID");

    return await withProjectGate(projectDigest, async (paths) => {
      const records = await readRecords(paths, projectDigest);
      for (const resource of resources) {
        const activeCount = records.filter((record) => record.state === "active" && record.resources.includes(resource)).length;
        if (activeCount >= capacityFor(resource, effectivePolicy)) {
          fail(`Reservation capacity is exhausted for ${resource}`);
        }
      }

      if (records.some((record) => record.id === reservationId)) fail("Reservation ID already exists");
      const ownerToken = uuid(randomUUID, "reservation owner token");
      const record = {
        version: 1,
        id: reservationId,
        ownerToken,
        projectDigest,
        delegationId: id.toLowerCase(),
        role,
        mode,
        checkoutDigest,
        resources,
        state: "active",
        acquiredAt: timestamp(clock),
      };
      const path = join(paths.leases, `${reservationId}.json`);
      await writeAtomicJson(path, record);
      return { ...record, path };
    });
  }

  async function release({ reservation } = {}) {
    assertObject(reservation, "reservation");
    const id = assertString(reservation.id, "reservation id", 128);
    const ownerToken = assertString(reservation.ownerToken, "reservation owner token", 128);
    const projectDigest = assertString(reservation.projectDigest, "reservation project digest", 128);
    if (!UUID_RE.test(id) || !UUID_RE.test(ownerToken) || !/^[0-9a-f]{64}$/.test(projectDigest)) {
      fail("reservation ownership is malformed");
    }

    return await withProjectGate(projectDigest, async (paths) => {
      const path = join(paths.leases, `${id.toLowerCase()}.json`);
      const record = validateReservationRecord(await readJson(path), projectDigest);
      if (record.ownerToken !== ownerToken.toLowerCase() || record.state !== "active") {
        fail("reservation ownership could not be verified");
      }
      const released = { ...record, state: "released", releasedAt: timestamp(clock) };
      await writeAtomicJson(path, released);
      return { ...released, path };
    });
  }

  // Release by delegation identity rather than by owner token. The token is
  // minted inside reserve() and never persisted outside the lease file, so no
  // later caller can present it — which is why release() had no callers and
  // every lease leaked, permanently exhausting per-project capacity (one
  // successful writer delegation was enough with writersPerCheckout: 1).
  // Authorization is the caller's: both call sites verify against the
  // authoritative run store that the delegation is no longer running.
  async function releaseForDelegation({ projectAlias, delegationId } = {}) {
    const alias = assertString(projectAlias, "reservation project alias", 512);
    const id = assertString(delegationId, "reservation delegation ID", 128);
    if (!UUID_RE.test(id)) fail("reservation delegation ID must be a UUID");
    const projectDigest = digestKey(alias);
    const target = id.toLowerCase();

    try {
      await fs.stat(projectPaths(projectDigest).leases);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      fail(`Unable to inspect reservation records (${error?.code ?? "FS_ERROR"})`);
    }

    return await withProjectGate(projectDigest, async (paths) => {
      const records = await readRecords(paths, projectDigest);
      const released = [];
      for (const record of records) {
        if (record.state !== "active" || record.delegationId !== target) continue;
        const next = { ...record, state: "released", releasedAt: timestamp(clock) };
        const { path, ...persisted } = next;
        await writeAtomicJson(path, persisted);
        released.push({ ...persisted, path });
      }
      return released.map(({ ownerToken: _ownerToken, ...record }) => record);
    });
  }

  async function list({ projectAlias } = {}) {
    const alias = assertString(projectAlias, "reservation project alias", 512);
    const projectDigest = digestKey(alias);
    const paths = projectPaths(projectDigest);
    try {
      await fs.stat(paths.leases);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      fail(`Unable to inspect reservation records (${error?.code ?? "FS_ERROR"})`);
    }
    const records = await readRecords(paths, projectDigest);
    return records.map(({ ownerToken: _ownerToken, ...record }) => record);
  }

  return Object.freeze({ reserve, release, releaseForDelegation, list, inspectGate, clearGate });
}
