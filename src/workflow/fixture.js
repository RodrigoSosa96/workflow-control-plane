import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID as defaultRandomUUID } from "node:crypto";
import { stringify } from "yaml";

const FIXTURE_VERSION = "workflow-launcher-fixture-v1";

function validateChildPath(root, target) {
  const resolved = resolve(target);
  const rootResolved = resolve(root);
  if (!resolved.startsWith(rootResolved + "/") && resolved !== rootResolved) {
    throw new Error(`Path escapes fixture root: ${target}`);
  }
  return resolved;
}

function buildFixtureRegistry({ root, stateRoot, packageRoot }) {
  return {
    launcher: {
      fixture_mode: true,
      state_root: stateRoot,
      control_plane_bin: join(packageRoot, "bin", "workflow.js"),
    },
    projects: {
      "fixture-single": {
        label: "Fixture Single",
        kind: "work",
        repository: join(root, "fixture-single"),
      },
      "fixture-bundle": {
        label: "Fixture Bundle",
        kind: "group",
        repository: join(root, "fixture-bundle"),
      },
    },
    agent_profiles: {
      "pi-worker": {
        harness: "pi",
        command: "pi",
        mode: "stream-json",
        model: null,
        arguments: [],
      },
      "claude-worker": {
        harness: "claude",
        command: "claude",
        mode: "stream-json",
        model: null,
        arguments: [],
        permission_mode: "manual",
      },
      "codex-worker": {
        harness: "codex",
        command: "codex",
        mode: "stream-json",
        model: "gpt-5-codex",
        arguments: [],
        sandbox: "workspace-write",
        approval_policy: "on-request",
      },
      "opencode-worker": {
        harness: "opencode",
        command: "opencode",
        mode: "stream-json",
        model: "claude-sonnet-4-20250514",
        arguments: [],
        availability: "fixture-only",
      },
    },
  };
}

async function initFixtureRepo(path) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch", "main", path]);
  await execFileAsync("git", ["-C", path, "config", "user.name", "Workflow Fixture"]);
  await execFileAsync("git", ["-C", path, "config", "user.email", "workflow-fixture@example.invalid"]);
  await writeFile(join(path, "README.md"), "# Workflow Fixture\n");
  await execFileAsync("git", ["-C", path, "add", "--all"]);
  await execFileAsync("git", ["-C", path, "commit", "-m", "test: initialize workflow fixture"]);
}

export async function createWorkflowFixture({ root, packageRoot, clock = () => new Date().toISOString(), randomUUID = defaultRandomUUID } = {}) {
  if (!root || typeof root !== "string") throw new TypeError("Fixture root is required");
  if (!packageRoot || typeof packageRoot !== "string") throw new TypeError("Package root is required");

  const id = randomUUID();
  const stateRoot = join(root, "state");
  const registryPath = join(root, "projects.yaml");
  const markerPath = join(root, ".workflow-fixture.json");

  const fixture = {
    id,
    root,
    packageRoot,
    stateRoot,
    registryPath,
    markerPath,
    ownedBy: FIXTURE_VERSION,
    createdAt: clock(),
    registry: buildFixtureRegistry({ root, stateRoot, packageRoot }),
    projects: {
      "fixture-single": { path: join(root, "fixture-single"), tickets: ["FIX-101", "FIX-102"] },
      "fixture-bundle": { path: join(root, "fixture-bundle"), tickets: ["FIX-201", "FIX-202", "FIX-203"] },
    },
  };

  await mkdir(root, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(markerPath, JSON.stringify({ id, ownedBy: FIXTURE_VERSION, createdAt: fixture.createdAt }, null, 2) + "\n");
  await writeFile(registryPath, stringify(fixture.registry));

  for (const project of Object.values(fixture.projects)) {
    await initFixtureRepo(project.path);
  }

  return fixture;
}

export async function loadFixtureDescriptor(root) {
  const markerPath = join(root, ".workflow-fixture.json");
  const text = await readFile(markerPath, "utf8");
  const marker = JSON.parse(text);
  if (typeof marker.id !== "string" || typeof marker.ownedBy !== "string") {
    throw new Error("Invalid fixture marker");
  }
  return {
    id: marker.id,
    root,
    ownedBy: marker.ownedBy,
    createdAt: marker.createdAt,
    markerPath,
    registryPath: join(root, "projects.yaml"),
    stateRoot: join(root, "state"),
  };
}

export async function assertOwnedFixture(root, fixtureId) {
  const descriptor = await loadFixtureDescriptor(root);
  if (descriptor.id !== fixtureId) {
    throw new Error(`Fixture UUID mismatch: expected ${fixtureId}, found ${descriptor.id}`);
  }
  if (descriptor.ownedBy !== FIXTURE_VERSION) {
    throw new Error(`Fixture ownership mismatch: expected ${FIXTURE_VERSION}, found ${descriptor.ownedBy}`);
  }
  for (const target of [descriptor.root, descriptor.stateRoot, descriptor.registryPath, descriptor.markerPath]) {
    validateChildPath(root, target);
  }
  return descriptor;
}
