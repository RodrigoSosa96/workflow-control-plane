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
