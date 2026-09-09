import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { assertOwnedFixture } from "./fixture.js";

export async function cleanupWorkflowFixture(descriptor, { confirm } = {}) {
  if (!descriptor || typeof descriptor.root !== "string") {
    throw new TypeError("Invalid fixture descriptor");
  }
  const root = resolve(descriptor.root);
  await assertOwnedFixture(root, descriptor.id);

  if (typeof confirm === "function") {
    const approved = await confirm(descriptor);
    if (!approved) throw new Error("Fixture cleanup was not confirmed");
  }

  await rm(root, { recursive: true, force: true });
}
