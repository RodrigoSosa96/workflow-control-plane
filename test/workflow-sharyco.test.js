import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { executeStart } from "../src/workflow/execute.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { planWorkflow } from "../src/workflow/planner.js";
import { createProcessRunner } from "../src/workflow/process.js";
import { reconcilePlan } from "../src/workflow/reconcile.js";

const execFileAsync = promisify(execFile);

async function gitExec(cwd, args) {
  return await execFileAsync("git", args, { cwd });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitBranch(cwd) {
  const result = await gitExec(cwd, ["branch", "--show-current"]);
  return result.stdout.trim();
}

async function createRepo(root, name, branch) {
  const repoPath = join(root, name);
  await mkdir(repoPath, { recursive: true });
  await gitExec(root, ["init", `--initial-branch=${branch}`, repoPath]);
  await gitExec(repoPath, ["config", "user.name", "Workflow Tests"]);
  await gitExec(repoPath, ["config", "user.email", "workflow@example.test"]);
  await writeFile(join(repoPath, "README.md"), `${name}\n`);
  await gitExec(repoPath, ["add", "README.md"]);
  await gitExec(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-acme-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const metaPath = await createRepo(root, "acme", "main");
  const backendPath = await createRepo(root, "acme_backend", "dev");
  const panelPath = await createRepo(root, "acme_panel", "dev");
  const webappPath = await createRepo(root, "acme_webapp", "release");

  const registry = {
    launcher: {
      worktree_root: join(root, "worktrees"),
      state_root: join(root, "workflow-state"),
      session_template: "{project}-{task}-{slug}",
      default_agent_profile: "pi-worker",
      max_bundle_tickets: 10,
      agent_profiles: {
        "pi-worker": {
          harness: "pi",
          command: "pi",
          mode: "interactive",
          roles: ["coordinator", "implementer"],
          model: null,
          arguments: [],
        },
      },
    },
    projects: {
      acme: {
        label: "Acme",
        kind: "work",
        path: metaPath,
        repository: "group",
        default_agent_profile: "pi-worker",
        allowed_agent_profiles: ["pi-worker"],
        worktree: {
          branch_template: "ticket/{task}/{slug}",
          path_template: "{worktree_root}/acme/{task}-{slug}",
        },
        coordination: {
          meta_repository: metaPath,
          repos_directory: "repos",
        },
        repositories: {
          backend: {
            path: backendPath,
            base_branch: "dev",
            branch_template: "feature/{task}/{slug}",
          },
          panel: {
            path: panelPath,
            base_branch: "dev",
            branch_template: "feature/{task}/{slug}",
          },
          webapp: {
            path: webappPath,
            base_branch: "release",
            branch_template: "feature/{project}/{repository}/{slug}",
          },
        },
      },
    },
  };

  const git = createGitAdapter({ runner: createProcessRunner() });
  const metaRepository = await git.inspectRepository({ cwd: metaPath });
  const herdr = createFakeHerdr({ repoKey: metaRepository.commonDirPath });

  return {
    root,
    registry,
    git,
    herdr,
  };
}

function createFakeHerdr({ repoKey }) {
  const calls = [];
  const workspacesByPath = new Map();
  let workspaceCounter = 1;
  let tabCounter = 1;
  let paneCounter = 1;
  let agentCounter = 1;

  function workspaceForId(workspaceId) {
    for (const workspace of workspacesByPath.values()) {
      if (workspace.workspace_id === workspaceId) return workspace;
    }
    return null;
  }

  function makeTab(workspace, { label, cwd }) {
    const tab = {
      tab_id: `${workspace.workspace_id}:t${tabCounter++}`,
      workspace_id: workspace.workspace_id,
      label,
    };
    const pane = {
      pane_id: `${workspace.workspace_id}:p${paneCounter++}`,
      tab_id: tab.tab_id,
      workspace_id: workspace.workspace_id,
      cwd,
      foreground_cwd: cwd,
    };
    workspace.tabs.push(tab);
    workspace.panes.push(pane);
    workspace.active_tab_id = tab.tab_id;
    return { tab, pane };
  }

  return {
    calls,
    async ensureNativeWorktree(operation) {
      const existing = workspacesByPath.get(operation.path);
      const disposition = existing ? "opened" : "created";
      calls.push({ kind: `herdr.worktree.${disposition === "created" ? "create" : "open"}`, path: operation.path });

      if (existing) {
        const firstTab = existing.tabs[0];
        const firstPane = existing.panes.find((pane) => pane.tab_id === firstTab?.tab_id);
        return {
          workspaceId: existing.workspace_id,
          tabId: firstTab?.tab_id ?? existing.active_tab_id,
          paneId: firstPane?.pane_id ?? existing.panes[0]?.pane_id,
          disposition,
        };
      }

      const branchExists = await gitExec(operation.cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${operation.branch}`])
        .then(() => true)
        .catch((error) => {
          if (error.code === 1) return false;
          throw error;
        });
      if (branchExists) {
        await gitExec(operation.cwd, ["worktree", "add", operation.path, operation.branch]);
      } else {
        await gitExec(operation.cwd, ["worktree", "add", "-b", operation.branch, operation.path, "HEAD"]);
      }

      const workspace = {
        workspace_id: `w${workspaceCounter++}`,
        label: operation.label,
        cwd: operation.path,
        active_tab_id: null,
        worktree: {
          checkout_path: operation.path,
          repo_key: repoKey,
        },
        tabs: [],
        panes: [],
        agents: [],
      };
      const { tab, pane } = makeTab(workspace, { label: "bootstrap", cwd: operation.path });
      workspacesByPath.set(operation.path, workspace);
      return {
        workspaceId: workspace.workspace_id,
        tabId: tab.tab_id,
        paneId: pane.pane_id,
        disposition,
      };
    },
    async listWorkspaces() {
      calls.push({ kind: "herdr.workspace.list" });
      return {
        workspaces: [...workspacesByPath.values()].map((workspace) => ({
          workspace_id: workspace.workspace_id,
          label: workspace.label,
          active_tab_id: workspace.active_tab_id,
          cwd: workspace.cwd,
          worktree: workspace.worktree,
        })),
      };
    },
    async listTabs({ workspaceId }) {
      calls.push({ kind: "herdr.tab.list", workspaceId });
      return { tabs: workspaceForId(workspaceId)?.tabs ?? [] };
    },
    async listPanes({ workspaceId }) {
      calls.push({ kind: "herdr.pane.list", workspaceId });
      return { panes: workspaceForId(workspaceId)?.panes ?? [] };
    },
    async listAgents() {
      calls.push({ kind: "herdr.agent.list" });
      return {
        agents: [...workspacesByPath.values()].flatMap((workspace) => workspace.agents),
      };
    },
    async renameTab({ tabId, label }) {
      calls.push({ kind: "herdr.tab.rename", tabId, label });
      for (const workspace of workspacesByPath.values()) {
        const tab = workspace.tabs.find((candidate) => candidate.tab_id === tabId);
        if (tab) {
          tab.label = label;
          return { tab_id: tabId, label };
        }
      }
      throw new Error(`Unknown tab: ${tabId}`);
    },
    async createTab({ workspaceId, cwd, label, focus }) {
      calls.push({ kind: "herdr.tab.create", workspaceId, cwd, label, focus });
      const workspace = workspaceForId(workspaceId);
      if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
      const { tab, pane } = makeTab(workspace, { label, cwd });
      return { tabId: tab.tab_id, paneId: pane.pane_id };
    },
    async splitPane({ paneId, direction, cwd, env, focus }) {
      calls.push({ kind: "herdr.pane.split", paneId, direction, cwd, env, focus });
      const workspace = [...workspacesByPath.values()].find((candidate) => candidate.panes.some((pane) => pane.pane_id === paneId));
      if (!workspace) throw new Error(`Unknown pane for split: ${paneId}`);
      const pane = {
        pane_id: `${workspace.workspace_id}:p${paneCounter++}`,
        tab_id: workspace.active_tab_id,
        workspace_id: workspace.workspace_id,
        cwd,
        foreground_cwd: cwd,
      };
      workspace.panes.push(pane);
      return { paneId: pane.pane_id };
    },
    async startAgent({ name, paneId, kind, argv, focus }) {
      calls.push({ kind: "herdr.agent.start", name, paneId, harnessKind: kind, argv, focus });
      const workspace = [...workspacesByPath.values()].find((candidate) => candidate.panes.some((pane) => pane.pane_id === paneId));
      if (!workspace) throw new Error(`Unknown pane for agent start: ${paneId}`);
      const pane = workspace.panes.find((candidate) => candidate.pane_id === paneId);
      pane.agent = kind;
      pane.agent_status = "working";
      const agent = {
        agent_id: `a${agentCounter++}`,
        workspace_id: workspace.workspace_id,
        tab_id: pane.tab_id,
        pane_id: pane.pane_id,
        name,
        cwd: pane.cwd,
      };
      workspace.agents.push(agent);
      workspace.active_tab_id = pane.tab_id;
      return { agentId: agent.agent_id, tabId: pane.tab_id, paneId: pane.pane_id };
    },
    async closePane({ paneId }) {
      calls.push({ kind: "herdr.pane.close", paneId });
      for (const workspace of workspacesByPath.values()) {
        const nextPanes = workspace.panes.filter((pane) => pane.pane_id !== paneId);
        if (nextPanes.length !== workspace.panes.length) {
          workspace.panes = nextPanes;
          return { pane_id: paneId, closed: true };
        }
      }
      return { pane_id: paneId, closed: false };
    },
  };
}

async function reconcileAcmePlan({ registry, git, herdr, repositories, tickets }) {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    tickets,
    feature: "Onboarding",
    repositories,
  });
  const reconciled = await reconcilePlan(plan, { git, herdr });
  return { plan, reconciled };
}

function createFlakyGit(git, { failAlias, failTimes = 1 }) {
  let remaining = failTimes;
  return {
    ...git,
    async createWorktree(args) {
      const alias = args.path.split("/").at(-1);
      if (alias === failAlias && remaining > 0) {
        remaining -= 1;
        throw new Error(`simulated ${alias} worktree failure`);
      }
      return await git.createWorktree(args);
    },
  };
}

test("creates selected child worktrees inside one Acme task workspace", async (t) => {
  const { registry, git, herdr } = await createFixture(t);
  const { plan, reconciled } = await reconcileAcmePlan({
    registry,
    git,
    herdr,
    repositories: ["panel", "backend"],
  });

  const report = await executeStart(reconciled, { git, herdr });
  const after = await reconcilePlan(plan, { git, herdr });
  const metaWorktree = plan.workspace.path;
  const workspaceId = (await herdr.listWorkspaces()).workspaces[0].workspace_id;
  const directTabs = (await herdr.listTabs({ workspaceId })).tabs.map((tab) => tab.label);

  assert.equal(await gitBranch(join(metaWorktree, "repos/backend")), "feature/ASANA-456/onboarding");
  assert.equal(await gitBranch(join(metaWorktree, "repos/panel")), "feature/ASANA-456/onboarding");
  assert.equal(await pathExists(join(metaWorktree, "repos/webapp")), false);
  assert.deepEqual(report.repositories.map((repo) => repo.alias), ["backend", "panel"]);
  assert.deepEqual(directTabs, ["coordinator", "backend", "panel"]);
  assert.deepEqual(after.tabs.map((tab) => ({ label: tab.label, status: tab.status })), [
    { label: "coordinator", status: "compatible" },
    { label: "backend", status: "compatible" },
    { label: "panel", status: "compatible" },
    { label: "runtime", status: "missing" },
  ]);
  assert.equal(after.agent.status, "compatible");
  assert.equal((await herdr.listAgents()).agents.length, 1);
  assert.equal((await herdr.listAgents()).agents[0].cwd, metaWorktree);
});

test("creates three selected Acme child worktrees in deterministic order", async (t) => {
  const { registry, git, herdr } = await createFixture(t);
  const { plan, reconciled } = await reconcileAcmePlan({
    registry,
    git,
    herdr,
    repositories: ["webapp", "panel", "backend"],
  });

  const report = await executeStart(reconciled, { git, herdr });

  assert.deepEqual(report.repositories.map((repo) => repo.alias), ["backend", "panel", "webapp"]);
  assert.equal(await gitBranch(join(plan.workspace.path, "repos/backend")), "feature/ASANA-456/onboarding");
  assert.equal(await gitBranch(join(plan.workspace.path, "repos/panel")), "feature/ASANA-456/onboarding");
  assert.equal(await gitBranch(join(plan.workspace.path, "repos/webapp")), "feature/acme/webapp/onboarding");
});

test("keeps Acme child worktree naming tied to the primary ticket bundle identity", async (t) => {
  const { registry, git, herdr } = await createFixture(t);
  const { plan, reconciled } = await reconcileAcmePlan({
    registry,
    git,
    herdr,
    repositories: ["panel", "backend"],
    tickets: ["ASANA-499", "ASANA-460", "ASANA-460"],
  });

  const report = await executeStart(reconciled, { git, herdr });

  assert.equal(plan.identity.task, "ASANA-456");
  assert.equal(plan.identity.primaryTicket, "ASANA-456");
  assert.deepEqual(plan.identity.relatedTickets, ["ASANA-460", "ASANA-499"]);
  assert.deepEqual(plan.identity.tickets, ["ASANA-456", "ASANA-460", "ASANA-499"]);
  assert.match(plan.workspace.path, /ASANA-456-onboarding$/);
  assert.equal(await gitBranch(join(plan.workspace.path, "repos/backend")), "feature/ASANA-456/onboarding");
  assert.equal(await gitBranch(join(plan.workspace.path, "repos/panel")), "feature/ASANA-456/onboarding");
  assert.deepEqual(report.repositories.map((repo) => repo.alias), ["backend", "panel"]);
});

test("reuses existing child worktrees and does not relaunch coordinator Pi", async (t) => {
  const { registry, git, herdr } = await createFixture(t);
  const { plan, reconciled } = await reconcileAcmePlan({
    registry,
    git,
    herdr,
    repositories: ["backend", "panel"],
  });

  await executeStart(reconciled, { git, herdr });
  const firstAgentStarts = herdr.calls.filter((call) => call.kind === "herdr.agent.start").length;
  const rerunPlan = await reconcilePlan(plan, { git, herdr });
  const rerun = await executeStart(rerunPlan, { git, herdr });

  assert.equal(herdr.calls.filter((call) => call.kind === "herdr.agent.start").length, firstAgentStarts);
  assert.deepEqual(rerun.operations.map((operation) => ({ id: operation.id, status: operation.status })), [
    { id: "meta-worktree", status: "reused" },
    { id: "child-worktree:backend", status: "reused" },
    { id: "child-worktree:panel", status: "reused" },
    { id: "coordinator-tab", status: "reused" },
    { id: "child-tab:backend", status: "reused" },
    { id: "child-tab:panel", status: "reused" },
    { id: "agent", status: "reused" },
  ]);
  assert.equal((await herdr.listAgents()).agents.length, 1);
});

test("recovers after the second child worktree fails and succeeds on rerun", async (t) => {
  const { registry, git, herdr } = await createFixture(t);
  const { plan, reconciled } = await reconcileAcmePlan({
    registry,
    git,
    herdr,
    repositories: ["backend", "panel"],
  });

  const failingGit = createFlakyGit(git, { failAlias: "panel" });
  const firstRun = await executeStart(reconciled, { git: failingGit, herdr });

  assert.equal(firstRun.status, "partial");
  assert.equal(firstRun.operations.find((operation) => operation.id === "meta-worktree").status, "created");
  assert.equal(firstRun.operations.find((operation) => operation.id === "child-worktree:backend").status, "created");
  assert.equal(firstRun.operations.find((operation) => operation.id === "child-worktree:panel").status, "failed");
  assert.equal(await pathExists(join(plan.workspace.path, "repos/backend")), true);
  assert.equal(await pathExists(join(plan.workspace.path, "repos/panel")), false);

  const rerunPlan = await reconcilePlan(plan, { git, herdr });
  const rerun = await executeStart(rerunPlan, { git, herdr });

  assert.equal(rerun.status, "completed");
  assert.equal(rerun.operations.find((operation) => operation.id === "meta-worktree").status, "reused");
  assert.equal(rerun.operations.find((operation) => operation.id === "child-worktree:backend").status, "reused");
  assert.equal(rerun.operations.find((operation) => operation.id === "child-worktree:panel").status, "created");
  assert.equal(await gitBranch(join(plan.workspace.path, "repos/panel")), "feature/ASANA-456/onboarding");
});

test("rejects wrong-child-repository conflicts before any mutation", async (t) => {
  const { registry, git, herdr } = await createFixture(t);
  const { plan } = await reconcileAcmePlan({
    registry,
    git,
    herdr,
    repositories: ["backend", "panel"],
  });
  const backendPath = plan.worktrees.find((worktree) => worktree.alias === "backend").path;

  await gitExec(registry.projects.acme.repositories.panel.path, [
    "worktree",
    "add",
    "-b",
    "feature/panel-temp",
    backendPath,
    "HEAD",
  ]);

  const conflicted = await reconcilePlan(plan, { git, herdr });

  await assert.rejects(
    executeStart(conflicted, { git, herdr }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "CONFLICT");
      return true;
    },
  );

  assert.equal(herdr.calls.length, 4);
});

test("fails PREFLIGHT when the meta repository is missing instead of initializing it", async (t) => {
  const { registry, herdr } = await createFixture(t);
  const plan = planWorkflow({
    registry: {
      ...registry,
      projects: {
        ...registry.projects,
        acme: {
          ...registry.projects.acme,
          path: "/missing/acme",
          coordination: {
            ...registry.projects.acme.coordination,
            meta_repository: "/missing/acme",
          },
        },
      },
    },
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["backend"],
  });
  const preflightPlan = {
    ...plan,
    status: "incomplete",
    conflicts: [],
    workspace: { ...plan.workspace, status: "missing", actual: null },
    tabs: plan.tabs.map((tab) => ({ ...tab, status: "missing", actual: null })),
    agent: { ...plan.agent, status: "missing", actual: null },
    runtime: { ...plan.runtime, status: "incomplete", tab: null },
    operations: plan.operations.map((operation) => ({
      ...operation,
      reconciliation: { status: "missing", reason: `${operation.id} is missing` },
    })),
  };
  const git = {
    async inspectRepository() {
      throw new Error("meta repository is missing");
    },
    async createWorktree() {
      throw new Error("createWorktree should not run when meta preflight fails");
    },
  };

  await assert.rejects(
    executeStart(preflightPlan, { git, herdr }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /meta repository|missing/i);
      return true;
    },
  );
});
