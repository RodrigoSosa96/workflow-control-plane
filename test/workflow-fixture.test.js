import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkflowFixture, loadFixtureDescriptor, assertOwnedFixture } from "../src/workflow/fixture.js";
import { cleanupWorkflowFixture } from "../src/workflow/fixture-cleanup.js";

const execFileAsync = promisify(execFile);

async function tempParent() {
  return await mkdtemp(join(tmpdir(), "workflow-fixture-"));
}

test("creates an owned fixture with fixture_mode registry and fake repos", async () => {
  const parent = await tempParent();
  const root = join(parent, "test-fixture");
  const packageRoot = "/repo";

  const fixture = await createWorkflowFixture({
    root,
    packageRoot,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(fixture.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(fixture.ownedBy, "workflow-launcher-fixture-v1");

  const marker = JSON.parse(await readFile(join(root, ".workflow-fixture.json"), "utf8"));
  assert.equal(marker.id, fixture.id);
  assert.equal(marker.ownedBy, "workflow-launcher-fixture-v1");

  const registryText = await readFile(fixture.registryPath, "utf8");
  assert.match(registryText, /fixture_mode:\s*true/);
  assert.match(registryText, /opencode-worker/);
  assert.match(registryText, /fixture-only/);

  for (const name of ["fixture-single", "fixture-bundle"]) {
    const repoPath = join(root, name);
    await access(repoPath);
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "log", "--oneline"]);
    assert.ok(stdout.trim().length > 0);
  }

  await rm(parent, { recursive: true, force: true });
});

test("load and assert ownership of an existing fixture", async () => {
  const parent = await tempParent();
  const root = join(parent, "test-fixture");
  const fixture = await createWorkflowFixture({ root, packageRoot: "/repo" });

  const loaded = await loadFixtureDescriptor(root);
  assert.equal(loaded.id, fixture.id);

  const marker = await assertOwnedFixture(root, fixture.id);
  assert.equal(marker.ownedBy, "workflow-launcher-fixture-v1");

  await rm(parent, { recursive: true, force: true });
});

test("cleanup requires confirmation and validates ownership", async () => {
  const parent = await tempParent();
  const root = join(parent, "test-fixture");
  const fixture = await createWorkflowFixture({ root, packageRoot: "/repo" });

  await assert.rejects(
    () => cleanupWorkflowFixture(fixture, { confirm: async () => false }),
    /cancelled|refused|not confirmed/i,
  );

  await assert.rejects(
    () => cleanupWorkflowFixture({ ...fixture, id: "wrong-id" }, { confirm: async () => true }),
    /marker|ownership|mismatch/i,
  );

  await rm(parent, { recursive: true, force: true });
});
