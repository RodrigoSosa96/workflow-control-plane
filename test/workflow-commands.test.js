import assert from "node:assert/strict";
import { test } from "node:test";
import { doctorCommand, planCommand, resultCommand, statusCommand, unlockCommand } from "../src/workflow/commands.js";
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

function deps({ git, herdr, lookup, registryValue = registry, harnessVersion }) {
  return {
    git,
    herdr,
    lookupExecutable: lookup.lookupExecutable,
    ...(harnessVersion ? { harnessVersion } : {}),
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
    "telemetry:pi",
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
    "telemetry:pi",
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
    "telemetry:codex",
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
        name: "ocr-asana-123-discovered-docs",
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

test("doctor reports an unpinned harness version as a telemetry warning without failing the environment", async () => {
  // Telemetry pins exact harness versions and fails closed to "unknown"; every
  // hook swallows its errors, so without this check a routine harness upgrade
  // blanks telemetry with no signal anywhere.
  const lookup = createLookup({ git: "/usr/bin/git", herdr: "/usr/bin/herdr", pi: "/usr/bin/pi" });
  const herdr = createHerdr({
    integrations: [{ name: "pi", status: "current", version: 5, path: "/home/you/.pi/agent/extensions/herdr-agent-state.ts" }],
  });

  const drifted = await doctorCommand(
    { registryPath: "/tmp/projects.yaml" },
    deps({ git: createGit({}), herdr, lookup, harnessVersion: async () => "9.9.9" }),
  );
  const driftedCheck = drifted.checks.find((check) => check.id === "telemetry:pi");
  assert.equal(driftedCheck.status, "unknown");
  assert.equal(driftedCheck.value, "9.9.9");
  assert.ok(driftedCheck.expected.length > 0);
  assert.match(driftedCheck.reason, /not a telemetry-pinned version/i);
  // Observability degraded, but the environment can still launch work.
  assert.equal(drifted.ok, true);

  const pinnedVersion = driftedCheck.expected.at(-1);
  const pinned = await doctorCommand(
    { registryPath: "/tmp/projects.yaml" },
    deps({ git: createGit({}), herdr, lookup, harnessVersion: async () => pinnedVersion }),
  );
  const pinnedCheck = pinned.checks.find((check) => check.id === "telemetry:pi");
  assert.equal(pinnedCheck.status, "ready");
  assert.equal(pinnedCheck.value, pinnedVersion);

  const unreadable = await doctorCommand(
    { registryPath: "/tmp/projects.yaml" },
    deps({ git: createGit({}), herdr, lookup, harnessVersion: async () => { throw new Error("pi exited with 127"); } }),
  );
  const unreadableCheck = unreadable.checks.find((check) => check.id === "telemetry:pi");
  assert.equal(unreadableCheck.status, "unknown");
  assert.match(unreadableCheck.reason, /could not be read/i);
  assert.equal(unreadable.ok, true);
});

// --- unlockCommand ------------------------------------------------------

const UNLOCK_RUN_ID = "66666666-6666-4666-8666-666666666666";

function lockMarker(overrides = {}) {
  return { version: 2, token: "t1", runId: UNLOCK_RUN_ID, pid: "4242", startedAt: "2026-07-29T10:00:00.000Z", ...overrides };
}

function inspectedLock(overrides = {}) {
  return {
    activePath: `/state/workflow/${UNLOCK_RUN_ID}/run.lock/active`,
    markerPath: `/state/workflow/${UNLOCK_RUN_ID}/run.lock/active/owner-t1.json`,
    marker: lockMarker(),
    ageMs: 120000,
    stale: false,
    ...overrides,
  };
}

// A fake run store exposing only inspectLock/removeLock, call-recording so tests can prove the
// unconfirmed path never reaches a mutating call. removeLock mirrors the real store's contract
// (run-store.js): it calls `allow` with the marker it "re-read" internally, which defaults to
// the same one inspectLock already reported but can be overridden via `recheckMarker` to a
// DIFFERENT marker -- simulating the marker changing (a new owner, or the same owner's marker
// mutating) between the command's own up-front classification and removeLock's internal
// re-read, exactly what `allow` exists to re-authorize against. removeLockResult lets a test
// force removeLock's own refusal for reasons unrelated to `allow` (a store-level race `allow`
// itself cannot see, e.g. the active directory changing identity underneath).
function lockStoreFor({ inspected = null, recheckMarker, removeLockResult } = {}) {
  const inspectLockCalls = [];
  const removeLockCalls = [];
  return {
    inspectLockCalls,
    removeLockCalls,
    async inspectLock(runId) {
      inspectLockCalls.push(runId);
      return inspected;
    },
    async removeLock(runId, { allow } = {}) {
      removeLockCalls.push(runId);
      const marker = recheckMarker !== undefined ? recheckMarker : (inspected?.marker ?? null);
      const permitted = await allow(marker);
      if (!permitted) return { removed: false, reason: "removal was not permitted for the current owner marker" };
      if (removeLockResult) return removeLockResult;
      return { removed: true, markerPath: inspected.markerPath, activePath: inspected.activePath };
    },
  };
}

// deps.inspectProcess is `(pid) => Promise<observation|null>`, throwing on ambiguity -- the same
// shape bin/workflow.js's inspectDelegationPid already gives delegation callers.
function inspectProcessReturning(result) {
  const calls = [];
  return {
    calls,
    inspectProcess: async (pid) => {
      calls.push(pid);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("unlock reports no-lock and exits 0 without inspecting any process when there is no active lock", async () => {
  const store = lockStoreFor({ inspected: null });
  const { calls, inspectProcess } = inspectProcessReturning(null);

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID }, { store, inspectProcess });

  assert.deepEqual(result, {
    command: "unlock",
    runId: UNLOCK_RUN_ID,
    lock: null,
    ownership: null,
    action: "no-lock",
    removed: null,
    reason: null,
    cleanup: "none",
    nextActions: [],
    exitCode: 0,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(store.removeLockCalls, []);
});

test("unlock refuses an alive owner with exit 11 even when confirmed, and never calls removeLock", async () => {
  const marker = lockMarker();
  // Distinctive, non-default ageMs/stale so the passthrough assertions below can't coincidentally
  // match some hardcoded value in the implementation.
  const inspected = inspectedLock({ marker, ageMs: 87654, stale: true });
  const store = lockStoreFor({ inspected });
  const { inspectProcess } = inspectProcessReturning({ pid: marker.pid, startedAt: marker.startedAt, cwd: "/wt", active: true });

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.ownership.verdict, "owner-alive");
  assert.equal(result.ownership.removable, false);
  assert.equal(result.lock.markerVersion, 2);
  assert.equal(result.lock.ageMs, 87654);
  assert.equal(result.lock.stale, true);
  assert.equal(result.removed, null);
  assert.deepEqual(store.removeLockCalls, []);
});

test("unlock refuses a version-1 marker as unprovable, with a reason distinct from an alive owner", async () => {
  const marker = { token: "t1", runId: UNLOCK_RUN_ID }; // no pid/startedAt: predates provable ownership
  const inspected = inspectedLock({ marker });
  const store = lockStoreFor({ inspected });
  const { calls, inspectProcess } = inspectProcessReturning(null);

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.ownership.verdict, "unprovable");
  assert.match(result.ownership.reason, /predates provable ownership/);
  assert.equal(result.lock.markerVersion, 1);
  // No pid on the marker means nothing to observe -- classifyOwnership already decides
  // "unprovable" without it, so no `ps` call should be spent confirming a foregone conclusion.
  assert.deepEqual(calls, []);
  assert.deepEqual(store.removeLockCalls, []);
});

test("unlock treats a throwing (ambiguous) process inspection as unprovable, not a crash", async () => {
  const marker = lockMarker();
  const inspected = inspectedLock({ marker });
  const store = lockStoreFor({ inspected });
  const { inspectProcess } = inspectProcessReturning(new Error("ps: ambiguous match"));

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.ownership.verdict, "unprovable");
  assert.match(result.ownership.reason, /liveness could not be verified/);
  assert.deepEqual(store.removeLockCalls, []);
});

test("unlock treats a recycled pid (same pid, different start time) as owner-gone and removable", async () => {
  const marker = lockMarker();
  const inspected = inspectedLock({ marker });
  const store = lockStoreFor({ inspected });
  const { inspectProcess } = inspectProcessReturning({ pid: marker.pid, startedAt: "2026-07-29T12:00:00.000Z", cwd: "/wt", active: true });

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID }, { store, inspectProcess });

  assert.equal(result.ownership.verdict, "owner-gone");
  assert.match(result.ownership.reason, /recycled/);
  assert.equal(result.ownership.removable, true);
  assert.equal(result.action, "needs-confirmation");
  assert.equal(result.exitCode, 0);
});

test("unlock reports needs-confirmation for a proven-missing owner, then removes it once confirmed", async () => {
  const marker = lockMarker();
  const inspected = inspectedLock({ marker });
  const store = lockStoreFor({ inspected });
  const { inspectProcess } = inspectProcessReturning(null); // proven gone: no matching process

  const pending = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: false }, { store, inspectProcess });
  assert.equal(pending.action, "needs-confirmation");
  assert.equal(pending.exitCode, 0);
  assert.equal(pending.removed, null);
  assert.deepEqual(pending.nextActions, ["confirm-unlock"]);
  assert.deepEqual(store.removeLockCalls, []);

  const removed = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });
  assert.equal(removed.action, "removed");
  assert.equal(removed.exitCode, 0);
  assert.deepEqual(removed.removed, { markerPath: inspected.markerPath, activePath: inspected.activePath });
  assert.equal(removed.cleanup, "none");
  assert.deepEqual(store.removeLockCalls, [UNLOCK_RUN_ID]);
});

test("unlock authorizes removal against the marker removeLock re-reads, not the one classified up front", async () => {
  // Up front, the lock's marker is proven-missing (removable). By the time removeLock re-reads
  // the marker (recheckMarker), a DIFFERENT owner has since acquired the lock and is alive --
  // `allow` must re-classify THAT marker, not reuse the up-front verdict, or a live owner's lock
  // would be destroyed. This is the discriminating test for that re-classification: an
  // implementation that authorizes against the stale up-front snapshot instead (e.g. `allow:
  // async () => ownership.removable`, ignoring the marker `allow` actually receives) passes
  // every other test in this file -- including the "recycled pid" and "needs-confirmation, then
  // removes it once confirmed" tests above, since none of them ever hand `allow` a marker that
  // differs from the one already classified -- and would still incorrectly report this case as
  // removed. Confirmed load-bearing empirically: reverting `allow` to close over the up-front
  // `ownership` (ignoring its `marker` argument) fails this test alone; see the task report.
  const staleMarker = lockMarker(); // classified below as proven-missing (removable)
  const freshAliveMarker = lockMarker({ token: "t2", pid: "5151", startedAt: "2026-07-29T13:00:00.000Z" });
  const inspected = inspectedLock({ marker: staleMarker });
  const store = lockStoreFor({ inspected, recheckMarker: freshAliveMarker });
  const inspectProcess = async (pid) => {
    if (pid === freshAliveMarker.pid) {
      return { pid: freshAliveMarker.pid, startedAt: freshAliveMarker.startedAt, cwd: "/wt", active: true };
    }
    return null; // staleMarker's pid: proven gone
  };

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.removed, null);
  // The report reflects the FRESH (alive) verdict `allow` actually computed, not the stale
  // (proven-missing) one classified up front -- proof the re-classification, not merely a
  // refusal, actually happened.
  assert.equal(result.ownership.verdict, "owner-alive");
  assert.deepEqual(store.removeLockCalls, [UNLOCK_RUN_ID]);
});

test("even though allow authorized removal, a store-level removeLock refusal (a race allow cannot see) surfaces as refused with its reason, not a crash", async () => {
  const marker = lockMarker();
  const inspected = inspectedLock({ marker });
  const store = lockStoreFor({
    inspected,
    removeLockResult: { removed: false, reason: "the active lock directory was replaced before removal" },
  });
  const { inspectProcess } = inspectProcessReturning(null);

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.removed, null);
  assert.equal(result.reason, "the active lock directory was replaced before removal");
  // allow's own re-classification still ran (and still authorized removal) before removeLock's
  // own, separate, post-authorization identity check refused -- the report carries that fresh
  // verdict, matching what removal was actually authorized against.
  assert.equal(result.ownership.verdict, "owner-gone");
  assert.equal(result.ownership.removable, true);
});

test("unlock refuses an unreadable/ambiguous marker (inspectLock's marker: null) as unprovable, with markerVersion null and the lock's ageMs/stale passed through", async () => {
  // inspectLock reports marker: null when the marker is absent, unreadable, or ambiguous (e.g.
  // more than one owner-*.json file in the active lock directory) while the active lock
  // directory itself still exists -- a realistic wedged-lock shape a previous task's fix
  // specifically preserves evidence for, and exactly what this command's operator hits on a
  // genuinely crashed run with stray residue in the lock directory.
  const inspected = inspectedLock({ marker: null, ageMs: 555555, stale: true });
  const store = lockStoreFor({ inspected });
  const { calls, inspectProcess } = inspectProcessReturning(null);

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.ownership.verdict, "unprovable");
  assert.match(result.ownership.reason, /is not a recognizable marker object/);
  // markerVersion: null is distinct from the version-1 test above's markerVersion: 1 -- a helper
  // that just hardcoded 1 for any non-version-2 input would wrongly pass here too if this case
  // weren't asserted on its own.
  assert.equal(result.lock.markerVersion, null);
  assert.equal(result.lock.ageMs, 555555);
  assert.equal(result.lock.stale, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.removeLockCalls, []);
});

test("unlock without a wired inspectProcess degrades to unprovable rather than throwing", async () => {
  const marker = lockMarker();
  const inspected = inspectedLock({ marker });
  const store = lockStoreFor({ inspected });

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.ownership.verdict, "unprovable");
});

test("the unconfirmed path never calls removeLock, across no-lock, refused, and needs-confirmation outcomes", async () => {
  const aliveMarker = lockMarker();
  const cases = [
    { inspected: null, observation: null }, // no-lock
    { inspected: inspectedLock({ marker: aliveMarker }), observation: { pid: aliveMarker.pid, startedAt: aliveMarker.startedAt, cwd: "/wt", active: true } }, // alive -> refused
    { inspected: inspectedLock({ marker: lockMarker() }), observation: null }, // proven-gone -> needs-confirmation
  ];
  for (const { inspected, observation } of cases) {
    const store = lockStoreFor({ inspected });
    const { inspectProcess } = inspectProcessReturning(observation);
    await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: false }, { store, inspectProcess });
    assert.deepEqual(store.removeLockCalls, []);
  }
});
