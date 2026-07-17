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

function createHerdr({ workspaces = [], tabs = {}, panes = {}, agents = [], processInfos = null } = {}) {
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
    ...(processInfos ? {
      async getPaneProcessInfo({ paneId }) {
        return Object.hasOwn(processInfos, paneId) ? processInfos[paneId] : null;
      },
    } : {}),
  };
}

function createRealpath({ canonical = {}, missing = [] } = {}) {
  const missingSet = new Set(missing);
  return async (value) => {
    if (missingSet.has(value)) {
      const error = new Error(`ENOENT: ${value}`);
      error.code = "ENOENT";
      throw error;
    }
    return canonical[value] ?? value;
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
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            label: "agent-shell",
            cwd: plan.agent.worktreePath,
            foreground_cwd: plan.agent.worktreePath,
          },
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

test("treats symlinked planned and actual worktree paths as the same canonical checkout", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const aliasedPlan = {
    ...plan,
    worktrees: [
      {
        ...plan.worktrees[0],
        path: "/links/ocr-discovered-docs",
      },
    ],
    workspace: {
      ...plan.workspace,
      path: "/links/ocr-discovered-docs",
    },
    tabs: plan.tabs.map((tab) => ({ ...tab, worktreePath: "/links/ocr-discovered-docs" })),
    agent: {
      ...plan.agent,
      worktreePath: "/links/ocr-discovered-docs",
    },
    runtime: {
      ...plan.runtime,
      worktreePath: "/links/ocr-discovered-docs",
    },
    operations: plan.operations.map((operation) => {
      if (operation.path === plan.workspace.path) return { ...operation, path: "/links/ocr-discovered-docs" };
      if (operation.cwd === plan.workspace.path) return { ...operation, cwd: "/links/ocr-discovered-docs" };
      return operation;
    }),
  };

  const reconciled = await reconcilePlan(aliasedPlan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
        "/links/ocr-discovered-docs": { rootPath: "/real/ocr-discovered-docs", commonDirPath: "/repo/ocr/.git" },
      },
      worktrees: {
        "/repo/ocr": [
          { path: "/real/ocr-discovered-docs", branch: branchRef(plan.worktrees[0].branch) },
        ],
      },
      statuses: {
        "/links/ocr-discovered-docs": { dirty: false, entries: [] },
      },
    }),
    herdr: createHerdr({
      workspaces: [
        {
          workspace_id: "w-symlink",
          worktree: {
            checkout_path: "/real/ocr-discovered-docs",
            repo_key: "/repo/ocr/.git",
          },
        },
      ],
      tabs: {
        "w-symlink": [
          { tab_id: "w-symlink:t1", workspace_id: "w-symlink", label: "agent" },
          { tab_id: "w-symlink:t2", workspace_id: "w-symlink", label: "runtime" },
        ],
      },
      panes: {
        "w-symlink": [
          {
            pane_id: "w-symlink:p1",
            tab_id: "w-symlink:t1",
            label: "agent-shell",
            cwd: "/real/ocr-discovered-docs",
            foreground_cwd: "/real/ocr-discovered-docs",
          },
          {
            pane_id: "w-symlink:p2",
            tab_id: "w-symlink:t2",
            label: "api",
            cwd: "/real/ocr-discovered-docs",
            foreground_cwd: "/real/ocr-discovered-docs",
            command: "pnpm dev:api",
          },
        ],
      },
      agents: [
        {
          tab_id: "w-symlink:t1",
          workspace_id: "w-symlink",
          name: plan.agent.sessionName,
          cwd: "/real/ocr-discovered-docs",
          agent_status: "working",
        },
      ],
    }),
    realpath: createRealpath({
      canonical: {
        "/links/ocr-discovered-docs": "/real/ocr-discovered-docs",
        "/real/ocr-discovered-docs": "/real/ocr-discovered-docs",
        "/repo/ocr/.git": "/repo/ocr/.git",
      },
    }),
  });

  assert.equal(reconciled.status, "compatible");
  assert.equal(reconciled.worktrees[0].status, "compatible");
  assert.equal(reconciled.workspace.status, "compatible");
});

test("falls back safely when canonicalizing a planned path that does not exist yet", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const calls = [];
  const realpath = async (value) => {
    calls.push(value);
    if (value === plan.worktrees[0].path) {
      const error = new Error(`ENOENT: ${value}`);
      error.code = "ENOENT";
      throw error;
    }
    return value;
  };

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
      },
      worktrees: {
        "/repo/ocr": [],
      },
    }),
    herdr: createHerdr(),
    realpath,
  });

  assert.equal(reconciled.worktrees[0].status, "missing");
  assert.ok(calls.includes(plan.worktrees[0].path));
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

test("does not treat a Acme repository tab as compatible when its child worktree is missing", async () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["backend"],
  });
  const workspaceId = "w-missing-child";

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/acme": { rootPath: "/repo/acme", commonDirPath: "/repo/acme/.git" },
        "/repo/acme/acme_backend": { rootPath: "/repo/acme/acme_backend", commonDirPath: "/repo/acme/acme_backend/.git" },
        [plan.workspace.path]: { rootPath: plan.workspace.path, commonDirPath: "/repo/acme/.git" },
      },
      worktrees: {
        "/repo/acme": [
          { path: plan.workspace.path, branch: branchRef(plan.worktrees[0].branch) },
        ],
        "/repo/acme/acme_backend": [],
      },
    }),
    herdr: createHerdr({
      workspaces: [
        {
          workspace_id: workspaceId,
          worktree: {
            checkout_path: plan.workspace.path,
            repo_key: "/repo/acme/.git",
          },
        },
      ],
      tabs: {
        [workspaceId]: [
          { tab_id: "w-missing-child:t1", workspace_id: workspaceId, label: "coordinator" },
          { tab_id: "w-missing-child:t2", workspace_id: workspaceId, label: "backend" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w-missing-child:p1",
            tab_id: "w-missing-child:t1",
            label: "coordinator-shell",
            cwd: plan.workspace.path,
            foreground_cwd: plan.workspace.path,
          },
          {
            pane_id: "w-missing-child:p2",
            tab_id: "w-missing-child:t2",
            label: "backend-shell",
            cwd: plan.worktrees.find((worktree) => worktree.alias === "backend").path,
            foreground_cwd: plan.worktrees.find((worktree) => worktree.alias === "backend").path,
          },
        ],
      },
    }),
  });

  assert.equal(reconciled.tabs.find((tab) => tab.label === "backend").status, "incomplete");
  assert.match(reconciled.tabs.find((tab) => tab.label === "backend").reason, /worktree/i);
});

test("flags a Acme repository tab whose cwd points at the wrong child worktree", async () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["backend", "panel"],
  });
  const workspaceId = "w-wrong-child";
  const backendPath = plan.worktrees.find((worktree) => worktree.alias === "backend").path;
  const panelPath = plan.worktrees.find((worktree) => worktree.alias === "panel").path;

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/acme": { rootPath: "/repo/acme", commonDirPath: "/repo/acme/.git" },
        "/repo/acme/acme_backend": { rootPath: "/repo/acme/acme_backend", commonDirPath: "/repo/acme/acme_backend/.git" },
        "/repo/acme/acme_panel": { rootPath: "/repo/acme/acme_panel", commonDirPath: "/repo/acme/acme_panel/.git" },
        [plan.workspace.path]: { rootPath: plan.workspace.path, commonDirPath: "/repo/acme/.git" },
        [backendPath]: { rootPath: backendPath, commonDirPath: "/repo/acme/acme_backend/.git" },
        [panelPath]: { rootPath: panelPath, commonDirPath: "/repo/acme/acme_panel/.git" },
      },
      worktrees: {
        "/repo/acme": [
          { path: plan.workspace.path, branch: branchRef(plan.worktrees[0].branch) },
        ],
        "/repo/acme/acme_backend": [
          { path: backendPath, branch: branchRef(plan.worktrees.find((worktree) => worktree.alias === "backend").branch) },
        ],
        "/repo/acme/acme_panel": [
          { path: panelPath, branch: branchRef(plan.worktrees.find((worktree) => worktree.alias === "panel").branch) },
        ],
      },
    }),
    herdr: createHerdr({
      workspaces: [
        {
          workspace_id: workspaceId,
          worktree: {
            checkout_path: plan.workspace.path,
            repo_key: "/repo/acme/.git",
          },
        },
      ],
      tabs: {
        [workspaceId]: [
          { tab_id: "w-wrong-child:t1", workspace_id: workspaceId, label: "coordinator" },
          { tab_id: "w-wrong-child:t2", workspace_id: workspaceId, label: "backend" },
          { tab_id: "w-wrong-child:t3", workspace_id: workspaceId, label: "panel" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w-wrong-child:p1",
            tab_id: "w-wrong-child:t1",
            label: "coordinator-shell",
            cwd: plan.workspace.path,
            foreground_cwd: plan.workspace.path,
          },
          {
            pane_id: "w-wrong-child:p2",
            tab_id: "w-wrong-child:t2",
            label: "backend-shell",
            cwd: panelPath,
            foreground_cwd: panelPath,
          },
          {
            pane_id: "w-wrong-child:p3",
            tab_id: "w-wrong-child:t3",
            label: "panel-shell",
            cwd: panelPath,
            foreground_cwd: panelPath,
          },
        ],
      },
    }),
  });

  assert.equal(reconciled.tabs.find((tab) => tab.label === "backend").status, "conflict");
  assert.match(reconciled.tabs.find((tab) => tab.label === "backend").reason, /wrong|backend/i);
});

test("flags a Acme repository tab whose cwd points at a stale path", async () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["backend"],
  });
  const workspaceId = "w-stale-child";
  const backendPath = plan.worktrees.find((worktree) => worktree.alias === "backend").path;

  const reconciled = await reconcilePlan(plan, {
    git: createGit({
      repositories: {
        "/repo/acme": { rootPath: "/repo/acme", commonDirPath: "/repo/acme/.git" },
        "/repo/acme/acme_backend": { rootPath: "/repo/acme/acme_backend", commonDirPath: "/repo/acme/acme_backend/.git" },
        [plan.workspace.path]: { rootPath: plan.workspace.path, commonDirPath: "/repo/acme/.git" },
        [backendPath]: { rootPath: backendPath, commonDirPath: "/repo/acme/acme_backend/.git" },
      },
      worktrees: {
        "/repo/acme": [
          { path: plan.workspace.path, branch: branchRef(plan.worktrees[0].branch) },
        ],
        "/repo/acme/acme_backend": [
          { path: backendPath, branch: branchRef(plan.worktrees.find((worktree) => worktree.alias === "backend").branch) },
        ],
      },
    }),
    herdr: createHerdr({
      workspaces: [
        {
          workspace_id: workspaceId,
          worktree: {
            checkout_path: plan.workspace.path,
            repo_key: "/repo/acme/.git",
          },
        },
      ],
      tabs: {
        [workspaceId]: [
          { tab_id: "w-stale-child:t1", workspace_id: workspaceId, label: "coordinator" },
          { tab_id: "w-stale-child:t2", workspace_id: workspaceId, label: "backend" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w-stale-child:p1",
            tab_id: "w-stale-child:t1",
            label: "coordinator-shell",
            cwd: plan.workspace.path,
            foreground_cwd: plan.workspace.path,
          },
          {
            pane_id: "w-stale-child:p2",
            tab_id: "w-stale-child:t2",
            label: "backend-shell",
            cwd: "/tmp/stale-backend",
            foreground_cwd: "/tmp/stale-backend",
          },
        ],
      },
    }),
  });

  assert.equal(reconciled.tabs.find((tab) => tab.label === "backend").status, "conflict");
  assert.match(reconciled.tabs.find((tab) => tab.label === "backend").reason, /stale|cwd|backend/i);
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

test("does not treat a runtime pane with the right label but wrong command as compatible", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const workspaceId = "w-wrong-runtime-command";

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
          { tab_id: "w-wrong-runtime-command:t1", workspace_id: workspaceId, label: "agent" },
          { tab_id: "w-wrong-runtime-command:t2", workspace_id: workspaceId, label: "runtime" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w-wrong-runtime-command:p1",
            tab_id: "w-wrong-runtime-command:t1",
            label: "agent-shell",
            cwd: plan.agent.worktreePath,
            foreground_cwd: plan.agent.worktreePath,
          },
          {
            pane_id: "w-wrong-runtime-command:p2",
            tab_id: "w-wrong-runtime-command:t2",
            label: "api",
            cwd: plan.runtime.worktreePath,
            foreground_cwd: plan.runtime.worktreePath,
            command: "pnpm wrong",
          },
        ],
      },
      agents: [
        {
          tab_id: "w-wrong-runtime-command:t1",
          workspace_id: workspaceId,
          name: plan.agent.sessionName,
          cwd: plan.agent.worktreePath,
          agent_status: "working",
        },
      ],
    }),
  });

  assert.equal(reconciled.status, "conflict");
  assert.equal(reconciled.runtime.processes[0].status, "conflict");
  assert.match(reconciled.runtime.processes[0].reason, /command|process|api/i);
});

test("classifies runtime processes from pane process-info instead of stale pane command metadata", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const workspaceId = "w-runtime-process-info";

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
          { tab_id: "w-runtime-process-info:t1", workspace_id: workspaceId, label: "agent" },
          { tab_id: "w-runtime-process-info:t2", workspace_id: workspaceId, label: "runtime" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w-runtime-process-info:p1",
            tab_id: "w-runtime-process-info:t1",
            label: "agent-shell",
            cwd: plan.agent.worktreePath,
            foreground_cwd: plan.agent.worktreePath,
          },
          {
            pane_id: "w-runtime-process-info:p2",
            tab_id: "w-runtime-process-info:t2",
            label: "api",
            cwd: plan.runtime.worktreePath,
            foreground_cwd: plan.runtime.worktreePath,
            command: "pnpm stale",
          },
        ],
      },
      processInfos: {
        "w-runtime-process-info:p2": {
          running: true,
          executable: "pnpm",
          command: "pnpm dev:api",
        },
      },
      agents: [
        {
          tab_id: "w-runtime-process-info:t1",
          workspace_id: workspaceId,
          name: plan.agent.sessionName,
          cwd: plan.agent.worktreePath,
          agent_status: "working",
        },
      ],
    }),
  });

  assert.equal(reconciled.status, "compatible");
  assert.equal(reconciled.runtime.processes[0].status, "compatible");
});

test("does not treat a runtime pane as compatible when process-info executable mismatches", async () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const workspaceId = "w-runtime-executable-mismatch";

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
          { tab_id: "w-runtime-executable-mismatch:t1", workspace_id: workspaceId, label: "agent" },
          { tab_id: "w-runtime-executable-mismatch:t2", workspace_id: workspaceId, label: "runtime" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w-runtime-executable-mismatch:p1",
            tab_id: "w-runtime-executable-mismatch:t1",
            label: "agent-shell",
            cwd: plan.agent.worktreePath,
            foreground_cwd: plan.agent.worktreePath,
          },
          {
            pane_id: "w-runtime-executable-mismatch:p2",
            tab_id: "w-runtime-executable-mismatch:t2",
            label: "api",
            cwd: plan.runtime.worktreePath,
            foreground_cwd: plan.runtime.worktreePath,
            command: "pnpm dev:api",
          },
        ],
      },
      processInfos: {
        "w-runtime-executable-mismatch:p2": {
          running: true,
          executable: "bash",
          command: "pnpm dev:api",
        },
      },
      agents: [
        {
          tab_id: "w-runtime-executable-mismatch:t1",
          workspace_id: workspaceId,
          name: plan.agent.sessionName,
          cwd: plan.agent.worktreePath,
          agent_status: "working",
        },
      ],
    }),
  });

  assert.equal(reconciled.status, "conflict");
  assert.equal(reconciled.runtime.processes[0].status, "conflict");
  assert.match(reconciled.runtime.processes[0].reason, /executable|command|process/i);
});

test("preserves compatible runtime siblings while only missing processes remain incomplete", async () => {
  const runtimeRegistry = structuredClone(registry);
  runtimeRegistry.projects.ocr.runtime.profiles.standard.processes = [
    { id: "api", command: "pnpm dev:api", cwd: "." },
    { id: "frontend", command: "pnpm dev:front", cwd: "apps/front", split: "right", ratio: 0.35 },
  ];
  const plan = planWorkflow({ registry: runtimeRegistry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const workspaceId = "w-runtime-siblings";

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
          { tab_id: "w-runtime-siblings:t1", workspace_id: workspaceId, label: "agent" },
          { tab_id: "w-runtime-siblings:t2", workspace_id: workspaceId, label: "runtime" },
        ],
      },
      panes: {
        [workspaceId]: [
          {
            pane_id: "w-runtime-siblings:p1",
            tab_id: "w-runtime-siblings:t1",
            label: "agent-shell",
            cwd: plan.agent.worktreePath,
            foreground_cwd: plan.agent.worktreePath,
          },
          {
            pane_id: "w-runtime-siblings:p2",
            tab_id: "w-runtime-siblings:t2",
            label: "api",
            cwd: plan.runtime.worktreePath,
            foreground_cwd: plan.runtime.worktreePath,
            command: "pnpm stale",
          },
        ],
      },
      processInfos: {
        "w-runtime-siblings:p2": {
          running: true,
          executable: "pnpm",
          command: "pnpm dev:api",
        },
      },
      agents: [
        {
          tab_id: "w-runtime-siblings:t1",
          workspace_id: workspaceId,
          name: plan.agent.sessionName,
          cwd: plan.agent.worktreePath,
          agent_status: "working",
        },
      ],
    }),
  });

  assert.equal(reconciled.status, "incomplete");
  assert.deepEqual(reconciled.runtime.processes.map(({ id, status }) => ({ id, status })), [
    { id: "api", status: "compatible" },
    { id: "frontend", status: "missing" },
  ]);
});
