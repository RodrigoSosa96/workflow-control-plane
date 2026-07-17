import assert from "node:assert/strict";
import { test } from "node:test";
import { planWorkflow } from "../src/workflow/planner.js";
import { reconcilePlan } from "../src/workflow/reconcile.js";

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

function createGit({ repositories = {}, worktrees = {}, statuses = {} } = {}) {
  return {
    async inspectRepository({ cwd }) {
      const value = repositories[cwd];
      if (!value) throw new Error(`Unknown repository: ${cwd}`);
      return value;
    },
    async listWorktrees({ cwd }) {
      return worktrees[cwd] ?? [];
    },
    async status({ cwd }) {
      return statuses[cwd] ?? { dirty: false, entries: [] };
    },
  };
}

function createHerdr({ workspaces = [], tabs = {}, panes = {}, agents = [] } = {}) {
  return {
    async listWorkspaces() {
      return { workspaces };
    },
    async listTabs({ workspaceId }) {
      return { tabs: tabs[workspaceId] ?? [] };
    },
    async listPanes({ workspaceId }) {
      return { panes: panes[workspaceId] ?? [] };
    },
    async listAgents() {
      return { agents };
    },
  };
}

test("classifies a compatible ordinary plan from Git and Herdr facts", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const commonDirPath = "/repo/ocr/.git";
  const workspaceId = "w1";
  const tabs = [
    { tab_id: "w1:t1", workspace_id: workspaceId, label: "agent" },
    { tab_id: "w1:t2", workspace_id: workspaceId, label: "runtime" },
  ];

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath },
        [plan.worktrees[0].path]: { rootPath: plan.worktrees[0].path, commonDirPath },
      },
      worktrees: {
        "/repo/ocr": [
          { path: plan.worktrees[0].path, branch: branchRef(plan.worktrees[0].branch) },
        ],
      },
      statuses: {
        [plan.worktrees[0].path]: { dirty: false, entries: [] },
      },
    }),
    herdr: createHerdr({
      workspaces: [
        {
          workspace_id: workspaceId,
          label: "some other label",
          worktree: {
            checkout_path: plan.workspace.path,
            repo_key: commonDirPath,
          },
        },
      ],
      tabs: {
        [workspaceId]: tabs,
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w1:p2",
            tab_id: "w1:t2",
            label: "api",
            cwd: plan.runtime.worktreePath,
            foreground_cwd: plan.runtime.worktreePath,
            command: "pnpm dev:api",
          },
        ],
      },
      agents: [
        {
          tab_id: "w1:t1",
          workspace_id: workspaceId,
          name: plan.agent.sessionName,
          cwd: plan.agent.worktreePath,
          agent_status: "working",
        },
      ],
    }),
  });

  assert.equal(reconciled.status, "compatible");
  assert.equal(reconciled.worktrees[0].status, "compatible");
  assert.equal(reconciled.workspace.status, "compatible");
  assert.equal(reconciled.tabs.find((tab) => tab.label === "runtime").status, "compatible");
  assert.equal(reconciled.agent.status, "compatible");
  assert.equal(reconciled.runtime.processes[0].status, "compatible");
  assert.equal(reconciled.operations.find((operation) => operation.id === "worktree").reconciliation.status, "open");
});

test("detects the same branch already checked out at the wrong path", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
      },
      worktrees: {
        "/repo/ocr": [
          { path: "/tmp/somewhere-else", branch: branchRef(plan.worktrees[0].branch) },
        ],
      },
    }),
    herdr: createHerdr(),
  });

  assert.equal(reconciled.status, "conflict");
  assert.equal(reconciled.worktrees[0].status, "conflict");
  assert.match(reconciled.worktrees[0].reason, /already checked out|wrong path/i);
});

test("detects a different repository occupying the planned worktree path", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
        [plan.worktrees[0].path]: { rootPath: plan.worktrees[0].path, commonDirPath: "/repo/other/.git" },
      },
      worktrees: {
        "/repo/ocr": [],
      },
    }),
    herdr: createHerdr(),
  });

  assert.equal(reconciled.status, "conflict");
  assert.equal(reconciled.worktrees[0].status, "conflict");
  assert.match(reconciled.worktrees[0].reason, /wrong repository|planned path/i);
});

test("marks a compatible Git worktree with no open Herdr workspace as incomplete", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
        [plan.worktrees[0].path]: { rootPath: plan.worktrees[0].path, commonDirPath: "/repo/ocr/.git" },
      },
      worktrees: {
        "/repo/ocr": [
          { path: plan.worktrees[0].path, branch: branchRef(plan.worktrees[0].branch) },
        ],
      },
    }),
    herdr: createHerdr(),
  });

  assert.equal(reconciled.status, "incomplete");
  assert.equal(reconciled.workspace.status, "incomplete");
  assert.match(reconciled.workspace.reason, /closed|not open/i);
  assert.equal(reconciled.operations.find((operation) => operation.id === "worktree").reconciliation.status, "closed");
});

test("marks a missing runtime tab as incomplete without inventing compatibility from labels", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const workspaceId = "w2";

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
        [plan.worktrees[0].path]: { rootPath: plan.worktrees[0].path, commonDirPath: "/repo/ocr/.git" },
      },
      worktrees: {
        "/repo/ocr": [
          { path: plan.worktrees[0].path, branch: branchRef(plan.worktrees[0].branch) },
        ],
      },
    }),
    herdr: createHerdr({
      workspaces: [
        {
          workspace_id: workspaceId,
          label: "irrelevant presentation label",
          worktree: {
            checkout_path: plan.workspace.path,
            repo_key: "/repo/ocr/.git",
          },
        },
      ],
      tabs: {
        [workspaceId]: [
          { tab_id: "w2:t1", workspace_id: workspaceId, label: "agent" },
        ],
      },
      agents: [
        {
          tab_id: "w2:t1",
          workspace_id: workspaceId,
          name: plan.agent.sessionName,
          cwd: plan.agent.worktreePath,
          agent_status: "working",
        },
      ],
    }),
  });

  assert.equal(reconciled.status, "incomplete");
  assert.equal(reconciled.tabs.find((tab) => tab.label === "runtime").status, "missing");
  assert.equal(reconciled.runtime.status, "incomplete");
});

test("flags duplicate runtime panes for the same planned process as a conflict", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const workspaceId = "w3";

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
        [plan.worktrees[0].path]: { rootPath: plan.worktrees[0].path, commonDirPath: "/repo/ocr/.git" },
      },
      worktrees: {
        "/repo/ocr": [
          { path: plan.worktrees[0].path, branch: branchRef(plan.worktrees[0].branch) },
        ],
      },
    }),
    herdr: createHerdr({
      workspaces: [
        {
          workspace_id: workspaceId,
          worktree: {
            checkout_path: plan.workspace.path,
            repo_key: "/repo/ocr/.git",
          },
        },
      ],
      tabs: {
        [workspaceId]: [
          { tab_id: "w3:t1", workspace_id: workspaceId, label: "agent" },
          { tab_id: "w3:t2", workspace_id: workspaceId, label: "runtime" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w3:p1",
            tab_id: "w3:t2",
            label: "api",
            cwd: plan.runtime.worktreePath,
            foreground_cwd: plan.runtime.worktreePath,
            command: "pnpm dev:api",
          },
          {
            pane_id: "w3:p2",
            tab_id: "w3:t2",
            label: "api",
            cwd: plan.runtime.worktreePath,
            foreground_cwd: plan.runtime.worktreePath,
            command: "pnpm dev:api",
          },
        ],
      },
    }),
  });

  assert.equal(reconciled.status, "conflict");
  assert.equal(reconciled.runtime.processes[0].status, "conflict");
  assert.match(reconciled.runtime.processes[0].reason, /duplicate/i);
});

test("flags a Acme child worktree path that belongs to the wrong repository", async () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["backend", "panel"],
  });
  const backend = plan.worktrees.find((worktree) => worktree.alias === "backend");

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/acme": { rootPath: "/repo/acme", commonDirPath: "/repo/acme/.git" },
        "/repo/acme/acme_backend": { rootPath: "/repo/acme/acme_backend", commonDirPath: "/repo/acme/acme_backend/.git" },
        "/repo/acme/acme_panel": { rootPath: "/repo/acme/acme_panel", commonDirPath: "/repo/acme/acme_panel/.git" },
        [plan.workspace.path]: { rootPath: plan.workspace.path, commonDirPath: "/repo/acme/.git" },
        [backend.path]: { rootPath: backend.path, commonDirPath: "/repo/acme/acme_panel/.git" },
      },
      worktrees: {
        "/repo/acme": [
          { path: plan.workspace.path, branch: branchRef(plan.worktrees[0].branch) },
        ],
        "/repo/acme/acme_backend": [],
        "/repo/acme/acme_panel": [
          { path: plan.worktrees.find((worktree) => worktree.alias === "panel").path, branch: branchRef(plan.worktrees.find((worktree) => worktree.alias === "panel").branch) },
        ],
      },
    }),
    herdr: createHerdr(),
  });

  assert.equal(reconciled.status, "conflict");
  assert.equal(reconciled.worktrees.find((worktree) => worktree.alias === "backend").status, "conflict");
  assert.match(reconciled.worktrees.find((worktree) => worktree.alias === "backend").reason, /wrong repository|backend/i);
});
