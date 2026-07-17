import assert from "node:assert/strict";
import { test } from "node:test";
import { doctorCommand, planCommand, statusCommand } from "../src/workflow/commands.js";
import { formatWorkflowResult } from "../src/workflow/format.js";

const registry = {
  launcher: {
    worktree_root: "/tmp/worktrees",
    agent: {
      command: "pi",
      session_template: "{project}-{task}-{slug}",
    },
  },
  projects: {
    ocr: {
      label: "ExampleProject",
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
            processes: [
              { id: "api", command: "pnpm dev:api", cwd: "." },
            ],
          },
        },
      },
    },
    acme: {
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
        panel: {
          path: "/repo/acme/acme_panel",
          base_branch: "dev",
          branch_template: "feature/{task}/{slug}",
        },
      },
      runtime: {
        default_profile: "standard",
        profiles: {
          standard: {
            processes: [
              { id: "api", command: "pnpm dev:api", cwd: "." },
            ],
          },
        },
      },
    },
  },
};

function branchRef(branch) {
  return `refs/heads/${branch}`;
}

function createLookup(paths) {
  const calls = [];
  return {
    calls,
    async lookupExecutable(name) {
      calls.push(name);
      return paths[name] ?? null;
    },
  };
}

function createGit({ repositories = {}, worktrees = {}, statuses = {} } = {}) {
  const calls = [];
  return {
    calls,
    async inspectRepository({ cwd }) {
      calls.push({ kind: "inspectRepository", cwd });
      const value = repositories[cwd];
      if (!value) throw new Error(`Unknown repository: ${cwd}`);
      return value;
    },
    async listWorktrees({ cwd }) {
      calls.push({ kind: "listWorktrees", cwd });
      return worktrees[cwd] ?? [];
    },
    async status({ cwd }) {
      calls.push({ kind: "status", cwd });
      return statuses[cwd] ?? { dirty: false, entries: [] };
    },
    async createWorktree() {
      throw new Error("createWorktree must not be called by read-only commands");
    },
  };
}

function createHerdr({ statusResult, integrations = [], workspaces = [], tabs = {}, panes = {}, agents = [] } = {}) {
  const calls = [];
  return {
    calls,
    async status() {
      calls.push({ kind: "status" });
      return statusResult ?? {
        client: { version: "0.7.4", protocol: 16 },
        server: { running: true, compatible: true },
      };
    },
    async integrationStatus() {
      calls.push({ kind: "integrationStatus" });
      return integrations;
    },
    async listWorkspaces() {
      calls.push({ kind: "listWorkspaces" });
      return { workspaces };
    },
    async listTabs({ workspaceId }) {
      calls.push({ kind: "listTabs", workspaceId });
      return { tabs: tabs[workspaceId] ?? [] };
    },
    async listPanes({ workspaceId }) {
      calls.push({ kind: "listPanes", workspaceId });
      return { panes: panes[workspaceId] ?? [] };
    },
    async listAgents() {
      calls.push({ kind: "listAgents" });
      return { agents };
    },
    async ensureNativeWorktree() {
      throw new Error("ensureNativeWorktree must not be called by read-only commands");
    },
    async createTab() {
      throw new Error("createTab must not be called by read-only commands");
    },
    async startAgent() {
      throw new Error("startAgent must not be called by read-only commands");
    },
  };
}

function deps({ git, herdr, lookup }) {
  return {
    git,
    herdr,
    lookupExecutable: lookup.lookupExecutable,
    loadRegistry: async (path) => {
      assert.equal(path, "/tmp/projects.yaml");
      return registry;
    },
  };
}

test("doctor reports registry, binaries, repositories, and Pi integration without mutation", async () => {
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    pi: "/usr/bin/pi",
  });
  const git = createGit({
    repositories: {
      "/repo/acme": { rootPath: "/repo/acme", commonDirPath: "/repo/acme/.git" },
      "/repo/acme/acme_backend": { rootPath: "/repo/acme/acme_backend", commonDirPath: "/repo/acme/acme_backend/.git" },
      "/repo/acme/acme_panel": { rootPath: "/repo/acme/acme_panel", commonDirPath: "/repo/acme/acme_panel/.git" },
    },
  });
  const herdr = createHerdr({
    integrations: [
      { name: "pi", status: "current", version: 5, path: "/home/you/.pi/agent/extensions/herdr-agent-state.ts" },
    ],
  });

  const result = await doctorCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "acme",
  }, deps({ git, herdr, lookup }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.id), [
    "registry",
    "binary:git",
    "binary:herdr",
    "binary:pi",
    "repository:acme",
    "repository:backend",
    "repository:panel",
    "herdr:status",
    "herdr:integration:pi",
  ]);
  assert.deepEqual(lookup.calls, ["git", "herdr", "pi"]);
  assert.deepEqual(git.calls.map((call) => call.cwd), [
    "/repo/acme",
    "/repo/acme/acme_backend",
    "/repo/acme/acme_panel",
  ]);
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["status", "integrationStatus"]);
});

test("plan stays read-only, returns ordered operations, and reports conflicts even when Pi is missing", async () => {
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
  });
  const git = createGit({
    repositories: {
      "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
    },
    worktrees: {
      "/repo/ocr": [
        { path: "/tmp/wrong-path", branch: branchRef("feature/ASANA-123/discovered-docs") },
      ],
    },
  });
  const herdr = createHerdr();

  const result = await planCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "Discovered Docs",
  }, deps({ git, herdr, lookup }));

  assert.equal(result.preconditions.pi.status, "missing");
  assert.deepEqual(result.reconciliation.operations.map((operation) => operation.id), [
    "worktree",
    "workspace",
    "agent-tab",
    "agent",
    "runtime-tab",
    "runtime",
  ]);
  assert.equal(result.reconciliation.status, "conflict");
  assert.match(result.conflicts[0].reason, /already checked out|wrong path/i);
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["listWorkspaces", "listAgents"]);
});

test("status reports actual state and the safe next command without attempting repair", async () => {
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    pi: "/usr/bin/pi",
  });
  const workspacePath = "/tmp/worktrees/ocr/ASANA-123-discovered-docs";
  const git = createGit({
    repositories: {
      "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
      [workspacePath]: { rootPath: workspacePath, commonDirPath: "/repo/ocr/.git" },
    },
    worktrees: {
      "/repo/ocr": [
        { path: workspacePath, branch: branchRef("feature/ASANA-123/discovered-docs") },
      ],
    },
  });
  const herdr = createHerdr({
    workspaces: [
      {
        workspace_id: "w1",
        worktree: {
          checkout_path: workspacePath,
          repo_key: "/repo/ocr/.git",
        },
      },
    ],
    tabs: {
      w1: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "agent" },
      ],
    },
    agents: [
      {
        tab_id: "w1:t1",
        workspace_id: "w1",
        name: "ocr-ASANA-123-discovered-docs",
        cwd: workspacePath,
        agent_status: "working",
      },
    ],
  });

  const result = await statusCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "Discovered Docs",
  }, deps({ git, herdr, lookup }));

  assert.equal(result.reconciliation.status, "incomplete");
  assert.equal(result.reconciliation.tabs.find((tab) => tab.label === "runtime").status, "missing");
  assert.equal(result.nextCommand, 'workflow runtime ocr ASANA-123 --feature "Discovered Docs" --profile standard --yes');
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["listWorkspaces", "listTabs", "listPanes", "listAgents"]);
});

test("plan exposes a suggested Acme coordination manifest and compact output prints it", async () => {
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    pi: "/usr/bin/pi",
  });
  const result = await planCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["panel", "backend"],
  }, deps({
    git: createGit({
      repositories: {
        "/repo/acme": { rootPath: "/repo/acme", commonDirPath: "/repo/acme/.git" },
        "/repo/acme/acme_backend": { rootPath: "/repo/acme/acme_backend", commonDirPath: "/repo/acme/acme_backend/.git" },
        "/repo/acme/acme_panel": { rootPath: "/repo/acme/acme_panel", commonDirPath: "/repo/acme/acme_panel/.git" },
      },
      worktrees: {
        "/repo/acme": [],
        "/repo/acme/acme_backend": [],
        "/repo/acme/acme_panel": [],
      },
    }),
    herdr: createHerdr(),
    lookup,
  }));

  assert.equal(result.suggestedManifest.path, "/tmp/worktrees/acme/ASANA-456-onboarding/coordination-manifest.json");
  assert.equal(result.suggestedManifest.payload.ticket, "ASANA-456");
  assert.deepEqual(result.suggestedManifest.payload.selectedRepositories, ["backend", "panel"]);
  assert.deepEqual(result.suggestedManifest.payload.integrationOrder, ["backend", "panel"]);
  assert.deepEqual(result.suggestedManifest.payload.branches, {
    backend: "feature/ASANA-456/onboarding",
    panel: "feature/ASANA-456/onboarding",
  });
  assert.match(result.suggestedManifest.payload.verificationCommands[0], /workflow status acme ASANA-456/);

  const compact = formatWorkflowResult("plan", result, "compact");
  assert.match(compact, /Suggested manifest/i);
  assert.match(compact, /coordination-manifest\.json/);
  assert.match(compact, /integrationOrder/);
});

test("formats bounded compact output and normalized JSON", () => {
  const compact = formatWorkflowResult("status", {
    project: { alias: "ocr", label: "ExampleProject" },
    reconciliation: {
      status: "conflict",
      conflicts: Array.from({ length: 500 }, (_, index) => ({
        resource: `resource-${index}`,
        reason: "x".repeat(80),
      })),
    },
    nextCommand: null,
  }, "compact");

  assert.ok(compact.length <= 12000);
  assert.match(compact, /Status: conflict/);

  assert.equal(
    formatWorkflowResult("doctor", { z: 1, a: { y: 2, x: 1 } }, "json"),
    '{\n  "a": {\n    "x": 1,\n    "y": 2\n  },\n  "z": 1\n}',
  );
});
