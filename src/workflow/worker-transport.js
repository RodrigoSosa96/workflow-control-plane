const METHODS = Object.freeze(["start", "observeExact", "deliverFollowUp", "requestGracefulClose"]);
const OBSERVATION_STATES = new Set(["active", "idle", "missing", "mismatch"]);
const FORBIDDEN_DETAIL_KEYS = new Set(["terminal", "paneText", "transcript", "stdout", "stderr"]);
const MAX_PROMPT_BYTES = 64 * 1024;

function assertIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string" || !value.kind) {
    throw new TypeError("Worker transport requires an exact identity object");
  }
  for (const [key, field] of Object.entries(value)) {
    if (typeof key !== "string" || typeof field !== "string" || !field || field.includes("\0") || Buffer.byteLength(field, "utf8") > 4096) {
      throw new TypeError("Worker transport identity fields must be bounded strings");
    }
  }
  return structuredClone(value);
}

function assertPrompt(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES) {
    throw new TypeError("Worker transport follow-up prompt must be bounded valid text");
  }
  return value;
}

function assertDetails(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Worker transport observation details must be an object");
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key)) {
      throw new TypeError("Worker transport observation details must not contain terminal-derived content");
    }
  }
  return structuredClone(value);
}

function normalizeObservation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !OBSERVATION_STATES.has(value.state)) {
    throw new TypeError("Worker transport observation has an unsupported state");
  }
  const observation = {
    state: value.state,
    identity: assertIdentity(value.identity),
  };
  const details = assertDetails(value.details);
  if (details !== undefined) observation.details = details;
  return observation;
}

export function assertWorkerTransport(transport) {
  for (const method of METHODS) {
    if (typeof transport?.[method] !== "function") {
      throw new TypeError(`Worker transport requires ${method}()`);
    }
  }
  return transport;
}

export function createFakeWorkerTransport({ observations = [] } = {}) {
  if (!Array.isArray(observations)) throw new TypeError("Fake worker transport observations must be an array");
  const pending = observations.map(normalizeObservation);
  const calls = [];

  const transport = {
    async start(approvedAssignment = {}) {
      const identity = assertIdentity(approvedAssignment.identity);
      calls.push({ method: "start", identity });
      return { identity };
    },

    async observeExact(requestedIdentity) {
      const identity = assertIdentity(requestedIdentity);
      const next = pending.shift() ?? { state: "missing", identity };
      calls.push({ method: "observeExact", identity });
      return structuredClone(next);
    },

    async deliverFollowUp(requestedIdentity, prompt) {
      const identity = assertIdentity(requestedIdentity);
      assertPrompt(prompt);
      calls.push({ method: "deliverFollowUp", identity });
      return { delivered: true, identity };
    },

    async requestGracefulClose(requestedIdentity) {
      const identity = assertIdentity(requestedIdentity);
      calls.push({ method: "requestGracefulClose", identity });
      return { requested: true, identity };
    },
  };

  Object.defineProperty(transport, "calls", {
    enumerable: true,
    get() {
      return Object.freeze(calls.map((call) => structuredClone(call)));
    },
  });
  return Object.freeze(transport);
}
