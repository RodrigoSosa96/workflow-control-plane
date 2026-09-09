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
  const fixtureSinglePath = join(root, "fixture-single");
  const fixtureBundlePath = join(root, "fixture-bundle");
  return {
    version: 3,
    launcher: {
      fixture_mode: true,
      state_root: stateRoot,
      worktree_root: join(root, "worktrees"),
      control_plane_bin: join(packageRoot, "bin", "workflow.js"),
      session_template: "{project}-{task}",
      default_agent_profile: "pi-worker",
      max_bundle_tickets: 5,
      delegation: {
        version: 1,
        totalInternal: 4,
        foreground: 3,
        readOnlyBackground: 3,
        writersTotal: 1,
        writersPerCheckout: 1,
        maxDepth: 1,
        remediationTurns: 2,
        allowBackgroundWriters: false,
      },
      agent_profiles: {
        "pi-worker": {
          harness: "pi",
          command: "pi",
          mode: "stream-json",
          model: null,
          arguments: [],
          roles: ["implementer"],
        },
        "claude-worker": {
          harness: "claude",
          command: "claude",
          mode: "stream-json",
          model: null,
          arguments: [],
          permission_mode: "manual",
          roles: ["implementer"],
        },
        "codex-worker": {
          harness: "codex",
          command: "codex",
          mode: "stream-json",
          model: "gpt-5-codex",
          arguments: [],
          sandbox: "workspace-write",
          approval_policy: "on-request",
          roles: ["implementer"],
        },
        "opencode-worker": {
          harness: "opencode",
          command: "opencode",
          mode: "stream-json",
          model: "claude-sonnet-4-20250514",
          arguments: [],
          availability: "fixture-only",
          roles: ["implementer"],
        },
      },
    },
    projects: {
      "fixture-single": {
        label: "Fixture Single",
        kind: "work",
        path: fixtureSinglePath,
        repository: "single",
        base_branch: "main",
        worktree: {
          branch_template: "feature/{task}",
          path_template: "{worktree_root}/{project}/{task}",
        },
      },
      "fixture-bundle": {
        label: "Fixture Bundle",
        kind: "work",
        path: fixtureBundlePath,
        repository: "group",
        worktree: {
          branch_template: "feature/{task}",
          path_template: "{worktree_root}/{project}/{task}",
        },
        coordination: {
          meta_repository: fixtureBundlePath,
          repos_directory: "repos",
        },
        repositories: {
          backend: {
            path: join(fixtureBundlePath, "repos", "backend"),
            base_branch: "main",
            branch_template: "feature/{task}",
          },
          frontend: {
            path: join(fixtureBundlePath, "repos", "frontend"),
            base_branch: "main",
            branch_template: "feature/{task}",
          },
        },
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
  await writeFile(join(path, "fixture.js"), `export const value = "initial";\n`);
  await writeFile(
    join(path, "test.js"),
    `import { value } from "./fixture.js";\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("fixture value matches expectation", () => {\n  assert.equal(value, "initial");\n});\n`,
  );
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  );
  await writeFile(
    join(path, "AGENTS.md"),
    "# Fixture-only safety\n\nThis is a disposable Workflow canary fixture. Do not push or reuse.\n",
  );
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
