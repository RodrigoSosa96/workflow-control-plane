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

function validV3() {
  return {
    version: 3,
    launcher: {
      worktree_root: "/tmp/worktrees",
      state_root: "/tmp/workflow-state",
      session_template: "{project}-{task}-{slug}",
      default_agent_profile: "pi-worker",
      max_bundle_tickets: 10,
      agent_profiles: {
        "pi-worker": {
          harness: "pi",
          command: "pi",
          mode: "interactive",
          roles: ["coordinator", "implementer", "reviewer"],
          arguments: [],
        },
      },
    },
    projects: {
      ocr: {
        label: "OCR",
        kind: "work",
        path: "/repo/ocr",
        repository: "monorepo",
        base_branch: "dev",
        default_agent_profile: "pi-worker",
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
}

test("normalizes a version 2 ordinary project into version 3", () => {
  const registry = validateRegistry(valid);
  assert.equal(registry.version, 3);
  assert.equal(registry.launcher.state_root, join(homedir(), ".local", "state", "workflow-launcher"));
  assert.equal(registry.launcher.session_template, "{project}-{task}-{slug}");
  assert.equal(registry.launcher.default_agent_profile, "pi-worker");
  assert.deepEqual(registry.launcher.agent_profiles["pi-worker"], {
    harness: "pi",
    command: "pi",
    mode: "interactive",
    roles: ["coordinator", "implementer", "reviewer"],
    model: null,
    arguments: [],
  });
  assert.equal(registry.launcher.agent.command, "pi");
  assert.equal(registry.launcher.agent.session_template, "{project}-{task}-{slug}");
  assert.equal(registry.projects.ocr.runtime.profiles.standard.processes[0].split, "right");
});

test("validates a version 3 ordinary project", () => {
  const registry = validateRegistry(validV3());
  assert.equal(registry.version, 3);
  assert.equal(registry.launcher.state_root, "/tmp/workflow-state");
  assert.equal(registry.launcher.agent.command, "pi");
  assert.equal(registry.projects.ocr.default_agent_profile, "pi-worker");
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
  assert.throws(() => {
    registry.launcher.agent_profiles["pi-worker"].command = "changed";
  }, TypeError);
});

test("rejects relative launcher and ordinary project paths after ~ expansion", () => {
  const relativeLauncher = structuredClone(valid);
  relativeLauncher.launcher.worktree_root = "relative/worktrees";
  assert.throws(() => validateRegistry(relativeLauncher), /launcher\.worktree_root.*absolute/i);

  const relativeProject = structuredClone(valid);
  relativeProject.projects.ocr.path = "./repo/ocr";
  assert.throws(() => validateRegistry(relativeProject), /ocr\.path.*absolute/i);
});

test("rejects relative group, meta-repository, and child repository paths after ~ expansion", () => {
  const groupValid = structuredClone(valid);
  groupValid.projects.acme = {
    label: "Acme",
    kind: "work",
    path: "/repo/acme",
    repository: "group",
    worktree: {
      branch_template: "ticket/{task}/{slug}",
      path_template: "{worktree_root}/acme/{task}-{slug}",
    },
    coordination: {
      meta_repository: "/repo/acme",
      repos_directory: "repos",
    },
    repositories: {
      backend: {
        path: "/repo/acme/acme_backend",
        base_branch: "dev",
        branch_template: "feature/{task}/{slug}",
      },
    },
  };

  const relativeGroup = structuredClone(groupValid);
  relativeGroup.projects.acme.path = "repo/acme";
  assert.throws(() => validateRegistry(relativeGroup), /acme\.path.*absolute/i);

  const relativeMeta = structuredClone(groupValid);
  relativeMeta.projects.acme.coordination.meta_repository = "./repo/acme";
  assert.throws(() => validateRegistry(relativeMeta), /acme\.coordination\.meta_repository.*absolute/i);

  const relativeChild = structuredClone(groupValid);
  relativeChild.projects.acme.repositories.backend.path = "repos/backend";
  assert.throws(() => validateRegistry(relativeChild), /acme\.repositories\.backend\.path.*absolute/i);
});

test("accepts launcher and project paths that become absolute after ~ expansion", () => {
  const value = structuredClone(valid);
  value.launcher.worktree_root = "~/worktrees";
  value.projects.ocr.path = "~/repo/ocr";

  const registry = validateRegistry(value);

  assert.equal(registry.launcher.worktree_root, join(homedir(), "worktrees"));
  assert.equal(registry.projects.ocr.path, join(homedir(), "repo", "ocr"));
});

test("preserves OCR infrastructure runtime in the canonical v3 registry", async () => {
  const registry = await loadRegistry(new URL("../projects.yaml", import.meta.url));
  assert.equal(registry.version, 3);
  assert.equal(registry.launcher.default_agent_profile, "pi-worker");
  assert.equal(registry.launcher.agent.command, "pi");
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

test("loads a version 2 registry with ordinary and group projects through migration", async () => {
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

  assert.equal(registry.version, 3);
  assert.equal(registry.launcher.worktree_root, join(homedir(), "worktrees"));
  assert.equal(registry.launcher.state_root, join(homedir(), ".local", "state", "workflow-launcher"));
  assert.equal(registry.launcher.agent.command, "pi");
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

test("rejects registry version 1", async () => {
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
    /version 1/i,
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

test("normalizes delegation defaults and allows projects to tighten them", () => {
  const value = validV3();
  value.projects.ocr.delegation = {
    totalInternal: 2,
    foreground: 2,
    readOnlyBackground: 1,
  };

  const registry = validateRegistry(value);

  assert.deepEqual(registry.launcher.delegation, {
    version: 1,
    totalInternal: 4,
    foreground: 3,
    readOnlyBackground: 3,
    writersTotal: 1,
    writersPerCheckout: 1,
    maxDepth: 1,
    remediationTurns: 2,
    allowBackgroundWriters: false,
  });
  assert.deepEqual(registry.projects.ocr.delegation, {
    version: 1,
    totalInternal: 2,
    foreground: 2,
    readOnlyBackground: 1,
    writersTotal: 1,
    writersPerCheckout: 1,
    maxDepth: 1,
    remediationTurns: 2,
    allowBackgroundWriters: false,
  });
});

test("rejects delegation overrides that relax a launcher writer budget", () => {
  const value = validV3();
  value.launcher.delegation = {
    version: 1,
    totalInternal: 4,
    foreground: 3,
    readOnlyBackground: 3,
    writersTotal: 1,
    writersPerCheckout: 1,
    maxDepth: 1,
    remediationTurns: 2,
    allowBackgroundWriters: false,
  };
  value.projects.ocr.delegation = { writersTotal: 2 };

  assert.throws(() => validateRegistry(value), /writersTotal.*launcher|writersTotal.*exceed/i);
});
