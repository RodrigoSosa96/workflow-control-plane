import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared test scaffolding. The tmp prefix stays per-file so a leftover
// directory still names the suite that leaked it.
export async function tempStateRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

export function fixedClock(timestamp) {
  return { now: () => timestamp };
}

export function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

export function clockSequence(...values) {
  let index = 0;
  return {
    now() {
      return values[index++] ?? values.at(-1);
    },
  };
}
