import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as defaultFs from "node:fs/promises";

const EVENTS_FILE = "events.jsonl";

function ensureString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function ensureObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

export function eventBusPath(stateRoot) {
  return join(ensureString(stateRoot, "stateRoot"), EVENTS_FILE);
}

export async function appendEvent({ stateRoot, event, fs = defaultFs } = {}) {
  ensureObject(event, "event");
  const directory = ensureString(stateRoot, "stateRoot");
  const path = eventBusPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const line = JSON.stringify(event) + "\n";
  await fs.appendFile(path, line, { mode: 0o600 });
  return { path };
}

export async function readEvents({ stateRoot, fromByte = 0, fs = defaultFs } = {}) {
  const directory = ensureString(stateRoot, "stateRoot");
  const path = eventBusPath(directory);
  try {
    const stats = await fs.stat(path);
    const total = stats.size;
    if (fromByte >= total) {
      return { events: [], nextByte: total };
    }
    const fd = await fs.open(path, "r");
    try {
      const buffer = Buffer.alloc(total - fromByte);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, fromByte);
      // Consume only up to the last complete line. A trailing line caught
      // mid-append is left for the next read instead of being skipped forever.
      const lastNewline = bytesRead > 0 ? buffer.lastIndexOf(0x0a, bytesRead - 1) : -1;
      if (lastNewline === -1) {
        return { events: [], nextByte: fromByte };
      }
      const text = buffer.toString("utf8", 0, lastNewline + 1);
      const lines = text.split("\n").filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Skip malformed lines; the bus is best-effort.
        }
      }
      return { events, nextByte: fromByte + lastNewline + 1 };
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { events: [], nextByte: 0 };
    }
    throw error;
  }
}
