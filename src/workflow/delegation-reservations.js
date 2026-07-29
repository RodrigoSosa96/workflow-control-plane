import { createHash, randomUUID as defaultRandomUUID } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { classifyDelegationRole, validateDelegationPolicy } from "./delegation-policy.js";
import { WorkflowError } from "./errors.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVATION_ROOT = "delegation-reservations";

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

function resourceList({ role, mode, checkoutDigest, policy }) {
  const kind = classifyDelegationRole(role);
  if (mode !== "foreground" && mode !== "background") fail("reservation mode must be foreground or background");
  if (kind === "writer" && mode === "background" && policy.allowBackgroundWriters !== true) {
    fail("background writer reservations are disabled by policy");
  }

  const resources = ["totalInternal"];
  if (mode === "foreground") resources.push("foreground");
  if (kind === "read-only" && mode === "background") resources.push("readOnlyBackground");
  if (kind === "writer") resources.push("writersTotal", `checkout:${checkoutDigest}`);
  return resources;
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
} = {}) {
  const root = resolve(assertString(stateRoot, "reservation state root"));
  if (typeof randomUUID !== "function" || typeof canonicalPath !== "function") fail("reservation store requires randomUUID and canonicalPath functions");
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
    await ensureDirectory(root);
    await ensureDirectory(join(root, RESERVATION_ROOT));
    await ensureDirectory(join(root, RESERVATION_ROOT, "projects"));
    await ensureDirectory(paths.project);
    await ensureDirectory(paths.leases);
    await ensureDirectory(paths.gate);
    try {
      await fs.mkdir(paths.activeGate, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("Reservation project gate is active; manual inspection required");
      }
      fail(`Unable to acquire reservation project gate (${error?.code ?? "FS_ERROR"})`);
    }
    await chmodDirectory(paths.activeGate);
    const ownerToken = uuid(randomUUID, "reservation gate owner token");
    const markerPath = join(paths.activeGate, "owner.json");
    await writeAtomicJson(markerPath, { version: 1, ownerToken });
    return { ...paths, ownerToken, markerPath };
  }

  async function releaseGate(gate) {
    const marker = await readJson(gate.markerPath);
    if (marker?.version !== 1 || marker.ownerToken !== gate.ownerToken) {
      fail("Reservation gate ownership could not be verified; manual inspection required");
    }
    try {
      await fs.unlink(gate.markerPath);
      await fs.rmdir(gate.activeGate);
    } catch (error) {
      fail(`Reservation gate ownership could not be released (${error?.code ?? "FS_ERROR"}); manual inspection required`);
    }
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
    const checkoutDigest = digestKey(normalizedCheckout);
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

  return Object.freeze({ reserve, release, releaseForDelegation, list });
}
