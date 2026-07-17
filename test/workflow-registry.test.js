import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRegistry, resolveProject, validateRegistry } from "../src/workflow/registry.js";

async function registryFile(contents) {
  const dir = await mkdtemp(join(tmpdir(), "workflow-registry-"));
  const path = join(dir, "projects.yaml");
  await writeFile(path, contents);
  return path;
}

const valid = {
  version: 2,
  launcher: {
    worktree_root: "/tmp/worktrees",
    agent: { command: "pi", session_template: "{project}-{task}-{slug}" },
  },
  projects: {
    ocr: {
      label: "OCR",
      kind: "work",
      path: "/repo/ocr",
      repository: "monorepo",
      base_branch: "dev",
      worktree: {
        branch_template: "feature/{task}/{slug}",
        path_template: "{worktree_root}/{project}/{task}-{slug}",
      },
      runtime: {
        default_profile: "standard",
        profiles: {
          standard: {
            processes: [{ id: "api", cwd: ".", command: "pnpm dev:api" }],
          },
        },
      },
    },
  },
};

test("validates a version 2 ordinary project", () => {
  const registry = validateRegistry(valid);
  assert.equal(registry.projects.ocr.base_branch, "dev");
  assert.equal(registry.projects.ocr.runtime.profiles.standard.processes[0].split, "right");
});

test("rejects missing project kind", () => {
  const value = structuredClone(valid);
  delete value.projects.ocr.kind;
  assert.throws(() => validateRegistry(value), /kind.*work.*personal/i);
});

test("rejects unsupported project kind", () => {
  const value = structuredClone(valid);
  value.projects.ocr.kind = "infra";
  assert.throws(() => validateRegistry(value), /kind.*work.*personal/i);
});

test("returns an immutable normalized registry", () => {
  const registry = validateRegistry(valid);
  assert.throws(() => {
    registry.projects.ocr.label = "Changed";
  }, TypeError);
  assert.throws(() => {
    registry.projects.ocr.runtime.profiles.standard.processes[0].command = "changed";
  }, TypeError);
});

test("preserves OCR infrastructure runtime in the migrated registry", async () => {
  const registry = await loadRegistry(new URL("../projects.yaml", import.meta.url));
  assert.deepEqual(
    registry.projects.ocr.runtime.profiles.standard.processes.map(({ id, command }) => ({ id, command })),
    [
      { id: "infrastructure", command: "pnpm docker:dev" },
      { id: "backend", command: "pnpm dev:api" },
      { id: "frontend", command: "pnpm dev:front" },
      { id: "workers", command: "pnpm --filter=@app/workers dev" },
    ],
  );
});

test("loads a version 2 registry with ordinary and group projects", async () => {
  const registry = await loadRegistry(await registryFile(`
version: 2
launcher:
  worktree_root: "~/worktrees"
  agent:
    command: pi
    session_template: "{project}-{task}-{slug}"
projects:
  ocr:
    label: ExampleProject
    path: "~/repos/ocr"
    repository: monorepo
    base_branch: dev
    kind: work
    task_source: local
    verify:
      - pnpm typecheck
      - pnpm biome:check
    worktree:
      branch_template: "feature/{task}/{slug}"
      path_template: "{worktree_root}/{project}/{task}-{slug}"
    runtime:
      default_profile: standard
      profiles:
        standard:
          processes:
            - id: api
              command: pnpm dev:api
  acme:
    label: Acme
    kind: work
    path: "~/repos/acme"
    repository: group
    task_source: asana
    worktree:
      branch_template: "ticket/{task}/{slug}"
      path_template: "{worktree_root}/acme/{task}-{slug}"
    coordination:
      meta_repository: "~/repos/acme"
      repos_directory: repos
    repositories:
      backend:
        path: "~/repos/acme/acme_backend"
        base_branch: dev
        branch_template: "feature/{task}/{slug}"
      panel:
        path: "~/repos/acme/acme_panel"
        base_branch: dev
        branch_template: "feature/{task}/{slug}"
      webapp:
        path: "~/repos/acme/acme_webapp"
        base_branch: dev
        branch_template: "feature/{task}/{slug}"
`));

  assert.equal(registry.version, 2);
  assert.equal(registry.launcher.worktree_root, join(homedir(), "worktrees"));
  assert.equal(registry.projects.ocr.path, join(homedir(), "repos", "ocr"));
  assert.equal(registry.projects.ocr.runtime.profiles.standard.processes[0].cwd, ".");
  assert.equal(registry.projects.ocr.runtime.profiles.standard.processes[0].split, "right");
  assert.equal(registry.projects.acme.repositories.backend.base_branch, "dev");
  assert.equal(registry.projects.acme.repositories.webapp.base_branch, "dev");
});

test("rejects unknown template placeholders", async () => {
  await assert.rejects(
    loadRegistry(await registryFile(`
version: 2
launcher:
  worktree_root: /tmp/worktrees
  agent:
    command: pi
    session_template: "{project}-{task}-{slug}"
projects:
  ocr:
    label: OCR
    kind: work
    path: /repo/ocr
    repository: monorepo
    base_branch: dev
    worktree:
      branch_template: "feature/{unknown}"
      path_template: "{worktree_root}/{project}/{task}-{slug}"
`)),
    /unknown placeholder.*unknown/i,
  );
});

test("rejects an unsupported registry version", async () => {
  await assert.rejects(
    loadRegistry(await registryFile(`
version: 1
projects:
  ocr:
    label: OCR
    kind: work
    path: /repo/ocr
    repository: monorepo
    base_branch: dev
    worktree:
      branch_template: "feature/{task}/{slug}"
      path_template: "{worktree_root}/{project}/{task}-{slug}"
`)),
    /version 2/i,
  );
});

test("rejects duplicate runtime process ids", async () => {
  await assert.rejects(
    loadRegistry(await registryFile(`
version: 2
launcher:
  worktree_root: /tmp/worktrees
  agent:
    command: pi
    session_template: "{project}-{task}-{slug}"
projects:
  ocr:
    label: OCR
    kind: work
    path: /repo/ocr
    repository: monorepo
    base_branch: dev
    worktree:
      branch_template: "feature/{task}/{slug}"
      path_template: "{worktree_root}/{project}/{task}-{slug}"
    runtime:
      default_profile: standard
      profiles:
        standard:
          processes:
            - id: api
              command: pnpm dev:api
            - id: api
              command: pnpm dev:web
`)),
    /duplicate runtime process id/i,
  );
});

test("rejects invalid runtime split values", async () => {
  await assert.rejects(
    loadRegistry(await registryFile(`
version: 2
launcher:
  worktree_root: /tmp/worktrees
  agent:
    command: pi
    session_template: "{project}-{task}-{slug}"
projects:
  ocr:
    label: OCR
    kind: work
    path: /repo/ocr
    repository: monorepo
    base_branch: dev
    worktree:
      branch_template: "feature/{task}/{slug}"
      path_template: "{worktree_root}/{project}/{task}-{slug}"
    runtime:
      default_profile: standard
      profiles:
        standard:
          processes:
            - id: api
              command: pnpm dev:api
              split: center
`)),
    /split/i,
  );
});

test("rejects invalid runtime ratio values", async () => {
  await assert.rejects(
    loadRegistry(await registryFile(`
version: 2
launcher:
  worktree_root: /tmp/worktrees
  agent:
    command: pi
    session_template: "{project}-{task}-{slug}"
projects:
  ocr:
    label: OCR
    kind: work
    path: /repo/ocr
    repository: monorepo
    base_branch: dev
    worktree:
      branch_template: "feature/{task}/{slug}"
      path_template: "{worktree_root}/{project}/{task}-{slug}"
    runtime:
      default_profile: standard
      profiles:
        standard:
          processes:
            - id: api
              command: pnpm dev:api
              split: right
              ratio: 1
`)),
    /ratio/i,
  );
});

test("rejects missing group coordination", async () => {
  await assert.rejects(
    loadRegistry(await registryFile(`
version: 2
launcher:
  worktree_root: /tmp/worktrees
  agent:
    command: pi
    session_template: "{project}-{task}-{slug}"
projects:
  acme:
    label: Acme
    kind: work
    path: /repo/acme
    repository: group
    worktree:
      branch_template: "ticket/{task}/{slug}"
      path_template: "{worktree_root}/acme/{task}-{slug}"
    repositories:
      backend:
        path: /repo/acme/acme_backend
        base_branch: dev
        branch_template: "feature/{task}/{slug}"
`)),
    /coordination/i,
  );
});

test("resolves a registered project and rejects unknown aliases", () => {
  const registry = validateRegistry(valid);
  assert.equal(resolveProject(registry, "ocr").label, "OCR");
  assert.throws(() => resolveProject(registry, "missing"), /Unknown workflow project/);
});
