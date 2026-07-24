import assert from "node:assert/strict";
import { test } from "node:test";
import { doctorCommand, planCommand, resultCommand, statusCommand } from "../src/workflow/commands.js";
import { formatWorkflowResult } from "../src/workflow/format.js";
import { RUN_STATES } from "../src/workflow/run-state.js";

const registry = {
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
        roles: ["coordinator", "implementer"],
        model: null,
        arguments: [],
      },
    },
  },
  projects: {
    ocr: {
      label: "ExampleProject",
      kind: "work",
      path: "/repo/ocr",
      repository: "monorepo",
      base_branch: "dev",
      default_agent_profile: "pi-worker",
      allowed_agent_profiles: ["pi-worker"],
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
      default_agent_profile: "pi-worker",
      allowed_agent_profiles: ["pi-worker"],
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
    async splitPane() {
      throw new Error("splitPane must not be called by read-only commands");
    },
    async startAgent() {
      throw new Error("startAgent must not be called by read-only commands");
    },
  };
}

function multiHarnessRegistry() {
  const value = structuredClone(registry);
  value.launcher.agent_profiles["claude-worker"] = {
    harness: "claude",
    command: "claude",
    mode: "interactive",
    roles: ["implementer"],
    model: null,
    arguments: [],
    permission_mode: "manual",
  };
  value.launcher.agent_profiles["codex-worker"] = {
    harness: "codex",
    command: "codex",
    mode: "interactive",
    roles: ["implementer"],
    model: "gpt-5-codex",
    arguments: [],
    sandbox: "workspace-write",
    approval_policy: "on-request",
  };
  value.projects.ocr.allowed_agent_profiles = ["pi-worker", "claude-worker", "codex-worker"];
  value.projects.acme.allowed_agent_profiles = ["pi-worker", "claude-worker", "codex-worker"];
  return value;
}

function deps({ git, herdr, lookup, registryValue = registry }) {
  return {
    git,
    herdr,
    lookupExecutable: lookup.lookupExecutable,
    loadRegistry: async (path) => {
      assert.equal(path, "/tmp/projects.yaml");
      return registryValue;
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

test("doctor without a project reports global prerequisites without repository inspection", async () => {
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    pi: "/usr/bin/pi",
  });
  const git = createGit();
  const herdr = createHerdr({
    integrations: [
      { name: "pi", status: "current", version: 5, path: "/home/you/.pi/agent/extensions/herdr-agent-state.ts" },
    ],
  });

  const result = await doctorCommand({
    registryPath: "/tmp/projects.yaml",
  }, deps({ git, herdr, lookup }));

  assert.equal(result.ok, true);
  assert.equal(result.project, null);
  assert.deepEqual(result.checks.map((check) => check.id), [
    "registry",
    "binary:git",
    "binary:herdr",
    "binary:pi",
    "herdr:status",
    "herdr:integration:pi",
  ]);
  assert.deepEqual(git.calls, []);
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["status", "integrationStatus"]);

  const compact = formatWorkflowResult("doctor", result, "compact");
  assert.match(compact, /Doctor: ready/);
  assert.doesNotMatch(compact, /Project:/);
});

test("doctor validates only the selected agent profile binary and Herdr integration", async () => {
  const selectedRegistry = multiHarnessRegistry();
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    codex: "/usr/bin/codex",
  });
  const git = createGit({
    repositories: {
      "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
    },
  });
  const herdr = createHerdr({
    integrations: [
      { name: "codex", status: "current", version: 1, path: "/home/you/.codex/herdr-state.sh" },
    ],
  });

  const result = await doctorCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "ocr",
    agentProfile: "codex-worker",
  }, deps({ git, herdr, lookup, registryValue: selectedRegistry }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.id), [
    "registry",
    "binary:git",
    "binary:herdr",
    "binary:codex",
    "repository:ocr",
    "herdr:status",
    "herdr:integration:codex",
  ]);
  assert.deepEqual(lookup.calls, ["git", "herdr", "codex"]);
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["status", "integrationStatus"]);
});

test("plan uses selected Codex preconditions without requiring Pi or Claude readiness", async () => {
  const selectedRegistry = multiHarnessRegistry();
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    codex: "/usr/bin/codex",
  });
  const git = createGit({
    repositories: {
      "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
    },
    worktrees: {
      "/repo/ocr": [],
    },
  });
  const herdr = createHerdr({
    integrations: [
      { name: "codex", status: "current", version: 1, path: "/home/you/.codex/herdr-state.sh" },
    ],
  });

  const result = await planCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "Discovered Docs",
    agentProfile: "codex-worker",
  }, deps({ git, herdr, lookup, registryValue: selectedRegistry }));

  assert.equal(result.preconditions.agent.id, "binary:codex");
  assert.equal(result.preconditions.agent.status, "ready");
  assert.equal(result.preconditions.agent.profileName, "codex-worker");
  assert.equal(result.preconditions.agent.harness, "codex");
  assert.equal(result.preconditions.agentIntegration.id, "herdr:integration:codex");
  assert.equal(result.preconditions.agentIntegration.status, "ready");
  assert.equal(Object.hasOwn(result.preconditions, "pi"), false);
  assert.equal(Object.hasOwn(result.preconditions, "claude"), false);
  assert.deepEqual(lookup.calls, ["git", "herdr", "codex"]);
  assert.equal(result.nextCommand, 'workflow start ocr ASANA-123 --feature "Discovered Docs" --agent codex-worker --yes');
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
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["status", "integrationStatus", "listWorkspaces", "listAgents"]);
});

test("plan request and next command include normalized ticket bundles", async () => {
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    pi: "/usr/bin/pi",
  });
  const git = createGit({
    repositories: {
      "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
    },
    worktrees: {
      "/repo/ocr": [],
    },
  });
  const herdr = createHerdr({
    integrations: [
      { name: "pi", status: "current", version: 5, path: "/home/you/.pi/agent/extensions/herdr-agent-state.ts" },
    ],
  });

  const result = await planCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "ocr",
    task: "ASANA-123",
    tickets: ["ASANA-150", "ASANA-140", "ASANA-140"],
    feature: "Discovered Docs",
  }, deps({ git, herdr, lookup }));

  assert.equal(result.reconciliation.status, "incomplete");
  assert.deepEqual(result.request, {
    task: "ASANA-123",
    tickets: ["ASANA-123", "ASANA-140", "ASANA-150"],
    relatedTickets: ["ASANA-140", "ASANA-150"],
    feature: "Discovered Docs",
    repositories: [],
    runtimeProfile: null,
  });
  assert.equal(result.nextCommand, 'workflow start ocr ASANA-123 --feature "Discovered Docs" --tickets ASANA-140,ASANA-150 --yes');
});

test("plan remains read-only and reports Herdr server and Pi integration readiness", async () => {
  const lookup = createLookup({
    git: "/usr/bin/git",
    herdr: "/usr/bin/herdr",
    pi: "/usr/bin/pi",
  });
  const git = createGit({
    repositories: {
      "/repo/ocr": { rootPath: "/repo/ocr", commonDirPath: "/repo/ocr/.git" },
    },
    worktrees: {
      "/repo/ocr": [],
    },
  });
  const herdr = createHerdr({
    statusResult: {
      client: { version: "0.7.4", protocol: 16 },
      server: { running: false, compatible: false },
    },
    integrations: [],
  });

  const result = await planCommand({
    registryPath: "/tmp/projects.yaml",
    projectAlias: "ocr",
    task: "ASANA-123",
    tickets: ["ASANA-150", "ASANA-140"],
    feature: "Discovered Docs",
  }, deps({ git, herdr, lookup }));

  assert.equal(result.reconciliation.status, "incomplete");
  assert.equal(result.preconditions.herdrStatus.status, "conflict");
  assert.match(result.preconditions.herdrStatus.reason, /Herdr server is not ready/i);
  assert.equal(result.preconditions.piIntegration.status, "missing");
  assert.match(result.preconditions.piIntegration.reason, /Pi integration is not installed/i);
  assert.equal(result.nextCommand, "workflow doctor ocr");
  assert.deepEqual(result.request, {
    task: "ASANA-123",
    tickets: ["ASANA-123", "ASANA-140", "ASANA-150"],
    relatedTickets: ["ASANA-140", "ASANA-150"],
    feature: "Discovered Docs",
    repositories: [],
    runtimeProfile: null,
  });
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["status", "integrationStatus"]);

  const compact = formatWorkflowResult("plan", result, "compact");
  assert.match(compact, /Preconditions:/);
  assert.match(compact, /herdr:status \| conflict \| Herdr server is not ready/i);
  assert.match(compact, /herdr:integration:pi \| missing \| Pi integration is not installed/i);
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
    tickets: ["ASANA-150", "ASANA-140", "ASANA-140"],
    feature: "Discovered Docs",
  }, deps({ git, herdr, lookup }));

  assert.equal(result.reconciliation.status, "incomplete");
  assert.equal(result.reconciliation.tabs.find((tab) => tab.label === "runtime").status, "missing");
  assert.equal(result.nextCommand, 'workflow runtime ocr ASANA-123 --feature "Discovered Docs" --tickets ASANA-140,ASANA-150 --profile standard --yes');
  assert.deepEqual(herdr.calls.map((call) => call.kind), ["status", "integrationStatus", "listWorkspaces", "listTabs", "listPanes", "listAgents"]);
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
    tickets: ["ASANA-499", "ASANA-460", "ASANA-460"],
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
    herdr: createHerdr({
      integrations: [
        { name: "pi", status: "current", version: 5, path: "/home/you/.pi/agent/extensions/herdr-agent-state.ts" },
      ],
    }),
    lookup,
  }));

  assert.equal(result.suggestedManifest.path, "/tmp/worktrees/acme/ASANA-456-onboarding/coordination-manifest.json");
  assert.equal(result.suggestedManifest.payload.ticket, "ASANA-456");
  assert.deepEqual(result.suggestedManifest.payload.tickets, ["ASANA-456", "ASANA-460", "ASANA-499"]);
  assert.deepEqual(result.suggestedManifest.payload.relatedTickets, ["ASANA-460", "ASANA-499"]);
  assert.deepEqual(result.suggestedManifest.payload.selectedRepositories, ["backend", "panel"]);
  assert.deepEqual(result.suggestedManifest.payload.integrationOrder, ["backend", "panel"]);
  assert.deepEqual(result.suggestedManifest.payload.branches, {
    backend: "feature/ASANA-456/onboarding",
    panel: "feature/ASANA-456/onboarding",
  });
  assert.equal(result.nextCommand, 'workflow start acme ASANA-456 --feature Onboarding --repos backend,panel --tickets ASANA-460,ASANA-499 --yes');
  assert.equal(
    result.suggestedManifest.payload.verificationCommands[0],
    'workflow status acme ASANA-456 --feature Onboarding --repos backend,panel --tickets ASANA-460,ASANA-499',
  );

  const compact = formatWorkflowResult("plan", result, "compact");
  assert.match(compact, /Suggested manifest/i);
  assert.match(compact, /coordination-manifest\.json/);
  assert.match(compact, /integrationOrder/);
});

test("result command verifies registered results through Task 4 in read-only mode", async () => {
  const runId = "55555555-5555-4555-8555-555555555555";
  const run = {
    id: runId,
    directory: "/state/workflow/55555555-5555-4555-8555-555555555555",
    projectAlias: "ocr",
    projectLabel: "ExampleProject",
    task: "ASANA-123",
    primaryTicket: "ASANA-123",
    relatedTickets: ["ASANA-140"],
    state: RUN_STATES.COMPLETED,
    resultPath: "/state/workflow/55555555-5555-4555-8555-555555555555/result.json",
    resultStatus: "completed",
  };
  const result = await resultCommand({ runId }, {
    store: {
      async read(id) {
        assert.equal(id, runId);
        return run;
      },
      async update() {
        assert.fail("result command must remain read-only");
      },
    },
    readCurrentResult: async (input) => {
      assert.equal(input.runId, runId);
      assert.equal(input.markStale, false);
      return { status: "completed", result: { status: "completed", summary: "Done" } };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.reconcileCommand, `workflow reconcile --run ${runId}`);
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
