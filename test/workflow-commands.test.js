import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as realFs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doctorCommand, inboxCommand, launchCommand, planCommand, reconcileCommand, resultCommand, runsCommand, statusCommand, unlockCommand, VERIFY_EXIT_CODES, verifyCommand } from "../src/workflow/commands.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { formatWorkflowResult } from "../src/workflow/format.js";
import { createRunStore } from "../src/workflow/run-store.js";
import { LIVE_RUN_STATES, RUN_STATES } from "../src/workflow/run-state.js";
import { runVerifyCommand as realRunVerifyCommand } from "../src/workflow/verify-runner.js";

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
  assert.deepEqual(pending.nextActions, [`workflow unlock ${UNLOCK_RUN_ID} --yes`]);
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

test("unlock surfaces the ambiguous-marker reason, not the generic unreadable one, when inspectLock reports more than one owner marker", async () => {
  // Final-review finding 5: inspectLock's markerAmbiguous flag (run-store.js) distinguishes "more
  // than one owner-*.json present" from a merely absent/corrupt marker -- exactly the wedged-lock
  // case an operator most needs explained. Before this, unlock's read-only report showed the same
  // generic classifyOwnership reason ("not a recognizable marker object", asserted in the previous
  // test) for both cases: the ambiguity-specific text only ever lived on removeLock's own refusal
  // path, which a non-removable up-front verdict never reaches (mutexOwnerRecoveryFlow refuses
  // before `remove` is ever called). Refusal behavior itself (verdict/removable/exitCode) is
  // unchanged either way -- only the diagnostic text sharpens.
  const inspected = inspectedLock({ marker: null, ageMs: 42, stale: false, markerAmbiguous: true });
  const store = lockStoreFor({ inspected });
  const { calls, inspectProcess } = inspectProcessReturning(null);

  const result = await unlockCommand({ runId: UNLOCK_RUN_ID, confirmed: true }, { store, inspectProcess });

  assert.equal(result.action, "refused");
  assert.equal(result.exitCode, 11);
  assert.equal(result.ownership.verdict, "unprovable");
  assert.equal(result.ownership.removable, false);
  assert.match(result.ownership.reason, /more than one owner marker/);
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

test("unlock threads deps.readOwnOwnership into storeForCommand's fallback store construction when deps.store is not pre-supplied", async () => {
  // Task 5 review round 2, finding 1: whenever WORKFLOW_STATE_ROOT is unset (the CLI's
  // documented default -- projects.yaml's launcher.state_root is the normal source), bin/
  // workflow.js does not pre-build `store`; storeForCommand must construct it lazily itself and
  // must pass deps.readOwnOwnership into that construction, or every lock acquireLock ever
  // writes through the resulting store carries no pid/startedAt -- `workflow unlock` would then
  // classify it "unprovable" forever. This is the precise, load-bearing regression test for that
  // one line in storeForCommand: deps.createRunStore stands in for the real factory (an existing
  // injection seam storeForCommand already had before this fix), so it directly observes what
  // storeForCommand passed it, without needing a real lock acquisition, herdr mocks, or
  // filesystem tricks.
  const calls = [];
  const fakeReadOwnOwnership = async () => ({ pid: "4242", startedAt: "2024-12-31T00:00:00.000Z" });
  const stubStore = {
    async inspectLock() {
      return null;
    },
  };
  const createRunStoreSpy = (args) => {
    calls.push(args);
    return stubStore;
  };

  const result = await unlockCommand(
    { runId: UNLOCK_RUN_ID },
    { stateRoot: "/state/workflow", readOwnOwnership: fakeReadOwnOwnership, createRunStore: createRunStoreSpy },
  );

  assert.equal(result.action, "no-lock");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stateRoot, "/state/workflow");
  assert.equal(calls[0].readOwnOwnership, fakeReadOwnOwnership);
});

// --- launchCommand --------------------------------------------------------

test("launch threads deps.readOwnOwnership into its own fallback run-store construction when deps.store is not pre-supplied", async () => {
  // Final-review finding 1: launchCommand -- this file's OWN wrapper around launch.js's
  // launchCommand, the one bin/workflow.js actually dispatches to for `workflow launch` -- built
  // its run store as createRunStore({ stateRoot }), bypassing storeForCommand entirely and
  // dropping deps.readOwnOwnership: the one createRunStore call site this roadmap item's own
  // acquisition path missed. In the default configuration (WORKFLOW_STATE_ROOT unset, the
  // documented default), every lock launch's own writes acquire -- create, writeAssignment, the
  // LAUNCHING/RUNNING/FAILED transitions in launch.js -- would carry no pid/startedAt, and a
  // crash mid-launch (the single most crash-prone window in the whole system) would leave residue
  // `workflow unlock`/`workflow reconcile` could never prove dead. Mirrors the unlock wiring test
  // above: a spy stands in for the real factory (an existing injection seam launchCommand already
  // had) so this observes exactly what launchCommand passed it, without needing a real preview.
  const calls = [];
  const fakeReadOwnOwnership = async () => ({ pid: "4242", startedAt: "2024-12-31T00:00:00.000Z" });
  const stubStore = {};
  const createRunStoreSpy = (args) => {
    calls.push(args);
    return stubStore;
  };

  // controlPlaneBin is deliberately left unset on both options and deps: launch.js's own preview
  // validates it and rejects before ever reaching planCommand -- a clean, deterministic stop that
  // still lands AFTER the store construction under test, without needing a real project/agent
  // fixture wired all the way through a full preview.
  await assert.rejects(
    () => launchCommand(
      { stateRoot: "/state/workflow", registryPath: "/tmp/projects.yaml" },
      {
        readOwnOwnership: fakeReadOwnOwnership,
        createRunStore: createRunStoreSpy,
        registry,
      },
    ),
    /controlPlaneBin/,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].stateRoot, "/state/workflow");
  assert.equal(calls[0].readOwnOwnership, fakeReadOwnOwnership);
});

// --- reconcileCommand's lock diagnostic ----------------------------------

const RECONCILE_RUN_ID = "88888888-8888-4888-8888-888888888888";

function reconcileRun(overrides = {}) {
  return {
    id: RECONCILE_RUN_ID,
    directory: `/state/workflow/${RECONCILE_RUN_ID}`,
    state: RUN_STATES.RUNNING,
    ...overrides,
  };
}

function reconcileLockMarker(overrides = {}) {
  return { version: 2, token: "t1", runId: RECONCILE_RUN_ID, pid: "9090", startedAt: "2026-07-29T09:00:00.000Z", ...overrides };
}

function reconcileInspectedLock(overrides = {}) {
  return {
    activePath: `/state/workflow/${RECONCILE_RUN_ID}/run.lock/active`,
    markerPath: `/state/workflow/${RECONCILE_RUN_ID}/run.lock/active/owner-t1.json`,
    marker: reconcileLockMarker(),
    ageMs: 45000,
    stale: false,
    ...overrides,
  };
}

// A fake run store for reconcileCommand: `read` returns the fixed run, `update` fails the test
// outright if ever called (reconcile's read-only contract), and `inspectLock` is present or
// omitted per `includeInspectLock` so the same fixture covers both the normal path and the
// "store predates inspectLock" degradation path.
function reconcileStoreFor({ run, inspected = null, includeInspectLock = true } = {}) {
  const store = {
    async read(runId) {
      assert.equal(runId, run.id);
      return run;
    },
    async update() {
      assert.fail("reconcile must remain read-only and never call store.update");
    },
  };
  if (includeInspectLock) {
    const inspectLockCalls = [];
    store.inspectLockCalls = inspectLockCalls;
    store.inspectLock = async (runId) => {
      inspectLockCalls.push(runId);
      return inspected;
    };
  }
  return store;
}

test("reconcile reports a held lock whose owner is proven gone and appends workflow unlock to nextActions", async () => {
  const run = reconcileRun();
  const marker = reconcileLockMarker();
  const inspected = reconcileInspectedLock({ marker, ageMs: 999999, stale: true });
  const store = reconcileStoreFor({ run, inspected });
  const { inspectProcess } = inspectProcessReturning(null); // proven gone: no matching process

  const result = await reconcileCommand({ runId: run.id }, { store, inspectProcess });

  assert.deepEqual(result.lock, {
    ageMs: 999999,
    stale: true,
    ownership: {
      verdict: "owner-gone",
      reason: "the owner process is proven gone: no matching process exists",
      pid: marker.pid,
      startedAt: marker.startedAt,
      removable: true,
    },
  });
  assert.deepEqual(result.nextActions, [
    `workflow result ${run.id}`,
    `workflow handoff ${run.id} --input /state/workflow/${run.id}/handoff-input.json`,
    `workflow unlock ${run.id} --yes`,
  ]);
  assert.deepEqual(store.inspectLockCalls, [run.id]);
});

test("reconcile reports a live owner's verdict but does not suggest unlock", async () => {
  const run = reconcileRun();
  const marker = reconcileLockMarker();
  const inspected = reconcileInspectedLock({ marker });
  const store = reconcileStoreFor({ run, inspected });
  const { inspectProcess } = inspectProcessReturning({ pid: marker.pid, startedAt: marker.startedAt, cwd: "/wt", active: true });

  const result = await reconcileCommand({ runId: run.id }, { store, inspectProcess });

  assert.equal(result.lock.ownership.verdict, "owner-alive");
  assert.equal(result.lock.ownership.removable, false);
  assert.deepEqual(result.nextActions, [
    `workflow result ${run.id}`,
    `workflow handoff ${run.id} --input /state/workflow/${run.id}/handoff-input.json`,
  ]);
});

test("reconcile has no lock field and unchanged nextActions when no lock is held", async () => {
  const run = reconcileRun();
  const store = reconcileStoreFor({ run, inspected: null });
  const { calls, inspectProcess } = inspectProcessReturning(null);

  const result = await reconcileCommand({ runId: run.id }, { store, inspectProcess });

  assert.equal("lock" in result, false);
  assert.deepEqual(result.nextActions, [
    `workflow result ${run.id}`,
    `workflow handoff ${run.id} --input /state/workflow/${run.id}/handoff-input.json`,
  ]);
  // No lock to classify -- classifyMarkerOwnership (and therefore inspectProcess) is never reached.
  assert.deepEqual(calls, []);
});

test("reconcile still reconciles, with no lock field, when the injected store predates inspectLock", async () => {
  const run = reconcileRun();
  const store = reconcileStoreFor({ run, includeInspectLock: false });
  assert.equal(typeof store.inspectLock, "undefined");

  const result = await reconcileCommand({ runId: run.id }, { store });

  assert.equal("lock" in result, false);
  assert.deepEqual(result.nextActions, [
    `workflow result ${run.id}`,
    `workflow handoff ${run.id} --input /state/workflow/${run.id}/handoff-input.json`,
  ]);
  assert.equal(result.command, "reconcile");
});

test("reconcile still reconciles, with no lock field, when inspectLock itself throws (an odd-filesystem-state anomaly, not a missing method)", async () => {
  // Task 6 review: inspectLock can throw for reasons unrelated to "this store predates the
  // method" -- an EACCES/EIO/EISDIR reaching throwFs inside the real store's inspectLockInternal.
  // Those anomalies are most likely on exactly the wedged, crashed runs reconcile exists to
  // diagnose, so a throwing inspectLock must degrade the same way a missing one does: the lock
  // field is silently absent, never a thrown error that breaks reconcile entirely.
  const run = reconcileRun();
  const store = reconcileStoreFor({ run });
  store.inspectLock = async () => {
    throw new Error("Unable to stat active lock at /state/workflow/.../run.lock/active (EACCES)");
  };

  const result = await reconcileCommand({ runId: run.id }, { store });

  assert.equal("lock" in result, false);
  assert.deepEqual(result.nextActions, [
    `workflow result ${run.id}`,
    `workflow handoff ${run.id} --input /state/workflow/${run.id}/handoff-input.json`,
  ]);
  assert.equal(result.command, "reconcile");
});

test("reconcile reports a non-removable unprovable verdict and does not suggest unlock", async () => {
  // Task 6 review: only owner-alive was covered for "does not suggest unlock" -- a regression
  // that treated unprovable as removable would slip past that test alone (owner-alive was
  // already false for a different reason: a live owner). Covers both an ambiguous (throwing)
  // process inspection and, separately, a version-1 marker with no pid/startedAt to observe.
  const run = reconcileRun();

  const ambiguousInspected = reconcileInspectedLock();
  const ambiguousStore = reconcileStoreFor({ run, inspected: ambiguousInspected });
  const ambiguousInspectProcess = async () => {
    throw new Error("ps: ambiguous match");
  };
  const ambiguousResult = await reconcileCommand({ runId: run.id }, { store: ambiguousStore, inspectProcess: ambiguousInspectProcess });
  assert.equal(ambiguousResult.lock.ownership.verdict, "unprovable");
  assert.equal(ambiguousResult.lock.ownership.removable, false);
  assert.deepEqual(ambiguousResult.nextActions, [
    `workflow result ${run.id}`,
    `workflow handoff ${run.id} --input /state/workflow/${run.id}/handoff-input.json`,
  ]);

  const versionOneMarker = { token: "t1", runId: run.id }; // no pid/startedAt: predates provable ownership
  const versionOneInspected = reconcileInspectedLock({ marker: versionOneMarker });
  const versionOneStore = reconcileStoreFor({ run, inspected: versionOneInspected });
  const { calls, inspectProcess: versionOneInspectProcess } = inspectProcessReturning(null);
  const versionOneResult = await reconcileCommand({ runId: run.id }, { store: versionOneStore, inspectProcess: versionOneInspectProcess });
  assert.equal(versionOneResult.lock.ownership.verdict, "unprovable");
  assert.equal(versionOneResult.lock.ownership.removable, false);
  assert.deepEqual(versionOneResult.nextActions, [
    `workflow result ${run.id}`,
    `workflow handoff ${run.id} --input /state/workflow/${run.id}/handoff-input.json`,
  ]);
  // No pid on the marker means nothing to observe -- classifyOwnership already decides
  // "unprovable" without it, so no `ps` call should be spent confirming a foregone conclusion.
  assert.deepEqual(calls, []);
});

test("reconcile performs no mutation even when the lock is removable", async () => {
  const run = reconcileRun();
  const inspected = reconcileInspectedLock(); // proven-missing owner below -> removable
  const store = reconcileStoreFor({ run, inspected });
  // Deliberately no removeLock on this store fake: if reconcile ever called it, this would throw
  // "store.removeLock is not a function" and fail the test, on top of the read-only store.update
  // assertion already wired into reconcileStoreFor.
  assert.equal(typeof store.removeLock, "undefined");
  const { inspectProcess } = inspectProcessReturning(null);

  const result = await reconcileCommand({ runId: run.id, confirmed: true }, { store, inspectProcess });

  assert.equal(result.lock.ownership.removable, true);
  assert.deepEqual(result.nextActions.at(-1), `workflow unlock ${run.id} --yes`);
});

// --- runsCommand ----------------------------------------------------------
//
// A real store over a temp state root, never a stub: the board's whole job is reading real
// records, and this repo has repeatedly found that stubbed stores hide exactly the defects that
// matter (see the roadmap's lessons). Runs are driven through the real state machine
// (create -> update -> update) rather than written as raw run.json, so these tests exercise the
// same legality run-state.js's ALLOWED map enforces in production.

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-runs-command-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

function fixedClock(timestamp) {
  return { now: () => timestamp };
}

// One second per now() call, so ordering assertions get strictly increasing updatedAt values
// without depending on wall-clock timing. Each state-machine hop (create, or one update) consumes
// exactly one now() call.
function incrementingClock() {
  let seconds = 0;
  return {
    now: () => {
      const value = `2025-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
      seconds += 1;
      return value;
    },
  };
}

// Lands a run in `targetState` using only real store.update() transitions. Every state other than
// planned/launching/running is reachable directly from running (see run-state.js's
// ALLOWED[RUNNING]), so this never needs more than three store calls regardless of target.
async function createRunInState(store, targetState, overrides = {}) {
  const run = await store.create({
    state: RUN_STATES.PLANNED,
    projectAlias: "ocr",
    primaryTicket: "A-1",
    relatedTickets: [],
    ...overrides,
  });
  if (targetState === RUN_STATES.PLANNED) return run;

  const launching = await store.update(run.id, () => ({ state: RUN_STATES.LAUNCHING }));
  if (targetState === RUN_STATES.LAUNCHING) return launching;

  const running = await store.update(run.id, () => ({ state: RUN_STATES.RUNNING }));
  if (targetState === RUN_STATES.RUNNING) return running;

  return store.update(run.id, () => ({ state: targetState }));
}

test("runsCommand lists runs across every project when none is given", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const ocrRun = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1" });
  const acmeRun = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "acme", primaryTicket: "B-1" });

  const result = await runsCommand({}, { stateRoot });

  assert.equal(result.command, "runs");
  assert.deepEqual(result.runs.map((run) => run.id).sort(), [ocrRun.id, acmeRun.id].sort());
  assert.deepEqual(result.skipped, []);
  assert.equal(result.exitCode, 0);
});

test("runsCommand narrows to --project", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const ocrRun = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1" });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "acme", primaryTicket: "B-1" });

  const result = await runsCommand({ projectAlias: "ocr" }, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.id), [ocrRun.id]);
});

test("runsCommand defaults to the live set, excluding completed/failed/interrupted and including the rest", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  for (const state of Object.values(RUN_STATES)) {
    await createRunInState(store, state, { projectAlias: "ocr", primaryTicket: state });
  }

  const result = await runsCommand({}, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.state).sort(), [...LIVE_RUN_STATES].sort());
  for (const excluded of [RUN_STATES.COMPLETED, RUN_STATES.FAILED, RUN_STATES.INTERRUPTED]) {
    assert.equal(result.runs.some((run) => run.state === excluded), false, `${excluded} must not appear in the default view`);
  }
});

test("runsCommand --all includes every state, live or not", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  for (const state of Object.values(RUN_STATES)) {
    await createRunInState(store, state, { projectAlias: "ocr", primaryTicket: state });
  }

  const result = await runsCommand({ all: true }, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.state).sort(), Object.values(RUN_STATES).sort());
});

test("runsCommand --state completed returns exactly the completed runs, bypassing the live-set default", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const completedRun = await createRunInState(store, RUN_STATES.COMPLETED, { projectAlias: "ocr", primaryTicket: "A-1" });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-2" });

  const result = await runsCommand({ state: RUN_STATES.COMPLETED }, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.id), [completedRun.id]);
});

// Roadmap item 2.5's board change. `archivedAt` is a top-level ISO string set only by a FULLY
// successful `workflow archive` (a partial one deliberately leaves it unset, so the board cannot
// hide a run that still has residue on disk). It is driven here through the real store's own
// update(), never written as raw run.json, exactly like every other runsCommand test above.
test("runsCommand --all hides archived runs and reports how many it hid", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const archived = await createRunInState(store, RUN_STATES.COMPLETED, { projectAlias: "ocr", primaryTicket: "A-1" });
  await store.update(archived.id, () => ({ archivedAt: "2026-08-07T12:00:00.000Z" }));
  const stillCompleted = await createRunInState(store, RUN_STATES.COMPLETED, { projectAlias: "ocr", primaryTicket: "A-2" });
  const running = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-3" });

  const all = await runsCommand({ all: true }, { stateRoot });
  assert.deepEqual(all.runs.map((run) => run.id).sort(), [stillCompleted.id, running.id].sort());
  assert.equal(all.archivedHidden, 1, "a run the board chose not to show is named as a count, never dropped in silence");

  // The default (live-set) view never showed a completed run anyway, so nothing is hidden there --
  // the count has to be honest about that rather than reporting every archived run in the store.
  const live = await runsCommand({}, { stateRoot });
  assert.deepEqual(live.runs.map((run) => run.id), [running.id]);
  assert.equal(live.archivedHidden, 0);
});

test("runsCommand --state still shows archived runs, because an explicit state is an explicit ask", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const archived = await createRunInState(store, RUN_STATES.COMPLETED, { projectAlias: "ocr", primaryTicket: "A-1" });
  await store.update(archived.id, () => ({ archivedAt: "2026-08-07T12:00:00.000Z" }));

  const result = await runsCommand({ state: RUN_STATES.COMPLETED }, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.id), [archived.id]);
  assert.equal(result.archivedHidden, 0, "nothing was hidden, so nothing is claimed to have been");
  assert.equal(result.runs[0].archivedAt, "2026-08-07T12:00:00.000Z");
});

test("only a real archivedAt string hides a run; a truthy non-string never does", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const bogus = await createRunInState(store, RUN_STATES.COMPLETED, { projectAlias: "ocr", primaryTicket: "A-1" });
  await store.update(bogus.id, () => ({ archivedAt: true }));

  const all = await runsCommand({ all: true }, { stateRoot });

  // The predicate is `typeof run.archivedAt === "string"` on purpose: the field also has to answer
  // *when*, and a record carrying something else has not been archived by this control plane.
  assert.deepEqual(all.runs.map((run) => run.id), [bogus.id]);
  assert.equal(all.archivedHidden, 0);
});

test("runsCommand refuses an unknown --state", async (t) => {
  const stateRoot = await tempStateRoot(t);

  await assert.rejects(
    () => runsCommand({ state: "bogus" }, { stateRoot }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "USAGE");
      assert.equal(error.exitCode, 64);
      // Same courtesy `--format`'s "must be compact or json." gets: name what was rejected AND
      // every value that would have been accepted. `/unknown/i` alone would have passed even if
      // the valid states were never named -- the regression that actually shipped.
      assert.match(error.message, /unknown run state: bogus\./i);
      for (const state of Object.values(RUN_STATES)) {
        assert.ok(error.message.includes(state), `expected the usage error to name valid state "${state}": ${error.message}`);
      }
      return true;
    },
  );
});

test("runsCommand orders by updatedAt descending with a deterministic id tiebreak", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: incrementingClock() });
  const older = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1" });
  const newer = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-2" });
  assert.ok(newer.updatedAt > older.updatedAt, "fixture assumption: the second run must be strictly newer");

  const result = await runsCommand({}, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.id), [newer.id, older.id]);
});

test("runsCommand breaks an updatedAt tie deterministically by id", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const first = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1" });
  const second = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-2" });
  assert.equal(first.updatedAt, second.updatedAt, "fixture assumption: both runs share one updatedAt");
  const [expectedFirst, expectedSecond] = [first.id, second.id].sort();

  const result = await runsCommand({}, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.id), [expectedFirst, expectedSecond]);
});

test("runsCommand surfaces a skipped record as data while the readable runs still list", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const readable = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1" });

  // Crash residue: a run directory whose run.json cannot be parsed (item 0.3's no-cleanup
  // policy preserves exactly this shape). list() must skip it, report it, and keep listing.
  const brokenRunId = "99999999-9999-4999-8999-999999999999";
  await realFs.mkdir(join(stateRoot, brokenRunId), { recursive: true, mode: 0o700 });
  await realFs.writeFile(join(stateRoot, brokenRunId, "run.json"), "not json", { mode: 0o600 });

  const result = await runsCommand({}, { stateRoot });

  assert.deepEqual(result.runs.map((run) => run.id), [readable.id]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].runId, brokenRunId);
  assert.match(result.skipped[0].message, /malformed/i);
  assert.equal(result.exitCode, 0);
});

// --- inboxCommand -----------------------------------------------------------
//
// Roadmap item 2.2. Same real-store discipline as runsCommand's tests above -- runs are driven
// through real store.create()/update() calls, never raw run.json -- plus the file's own
// createHerdr() stub (it already models listAgents()'s `{agents: [...]}` wire shape and records
// call order, which the "called exactly once" test below depends on).

test("inboxCommand correlates through transportIdentity.paneId, not the stale top-level paneId, for a resumed run (load-bearing case)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RUNNING, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    harness: "pi",
    paneId: "w1:dead-pane",
  });
  // Mirrors executeResume's own confirmed-relaunch patch exactly (resume.js:177): only
  // transportIdentity changes; the top-level paneId is never touched and keeps naming the
  // pane Herdr closed when the original session died.
  const resumed = await store.update(run.id, () => ({
    transportIdentity: { kind: "pi-session", paneId: "w1:live-pane", tabId: "t1", harness: "pi" },
  }));
  assert.equal(resumed.paneId, "w1:dead-pane", "fixture assumption: resume never touches the top-level paneId");

  // Herdr only knows about the LIVE pane -- the dead one is gone, not merely idle.
  const herdr = createHerdr({
    agents: [{ agent: "pi", pane_id: "w1:live-pane", agent_status: "blocked", cwd: "/wt" }],
  });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked.map((entry) => entry.runId), [run.id]);
  assert.equal(result.blocked[0].paneId, "w1:live-pane");
  assert.deepEqual(result.unresolved, []);
});

test("inboxCommand reports a run whose live agent is blocked", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RUNNING, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    harness: "pi",
    paneId: "w1:p1",
  });
  const herdr = createHerdr({ agents: [{ agent: "pi", pane_id: "w1:p1", agent_status: "blocked", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, [{
    runId: run.id,
    state: RUN_STATES.RUNNING,
    projectAlias: "ocr",
    primaryTicket: "A-1",
    harness: "pi",
    paneId: "w1:p1",
  }]);
  assert.equal(result.herdrAvailable, true);
  assert.equal(result.exitCode, 0);
});

test("inboxCommand omits runs whose live agent is working or idle", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-2", paneId: "w1:p2" });
  const herdr = createHerdr({
    agents: [
      { agent: "pi", pane_id: "w1:p1", agent_status: "working", cwd: "/wt" },
      { agent: "pi", pane_id: "w1:p2", agent_status: "idle", cwd: "/wt" },
    ],
  });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unresolved, []);
});

test("inboxCommand never reports a blocked agent that has no run behind it", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  const herdr = createHerdr({
    agents: [
      { agent: "pi", pane_id: "w1:p1", agent_status: "working", cwd: "/wt" },
      // An interactive session Herdr knows about that this control plane never launched --
      // herdr agent list returns every agent on the machine (the design spec's own finding).
      { agent: "shell", pane_id: "w9:interactive", agent_status: "blocked", cwd: "/elsewhere" },
    ],
  });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unresolved, []);
});

test("inboxCommand reports a non-terminal run with no pane id as unresolved, with a reason", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.PLANNED, { projectAlias: "ocr", primaryTicket: "A-1" });
  const herdr = createHerdr({ agents: [] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.equal(result.blocked.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].runId, run.id);
  assert.equal(result.unresolved[0].paneId, null);
  assert.match(result.unresolved[0].reason, /pane/i);
  assert.equal(result.exitCode, 0);
});

test("inboxCommand reports a run whose pane id matches no live Herdr agent as unresolved, with a reason", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:gone" });
  const herdr = createHerdr({ agents: [] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].runId, run.id);
  assert.equal(result.unresolved[0].paneId, "w1:gone");
  assert.match(result.unresolved[0].reason, /no live|not found|no agent/i);
});

// --- inboxCommand: waiting vs. unresolved (branch review 3b) ----------------------------------
//
// Found by running this command against the developer's real state root: a run in
// `manual-handoff-required` or `needs-input` has, by definition, a worker that already exited and
// left the next move to the operator. Its pane being gone is the *expected* shape, not a
// surprise -- reporting it the same way as a `running` run's vanished pane ("No live Herdr agent
// found for pane X") told the operator the wrong thing. See the design spec's correction
// paragraph.

test("inboxCommand puts a manual-handoff-required run with no live agent in waiting, not unresolved, naming the state and workflow result", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.MANUAL_HANDOFF_REQUIRED, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    harness: "pi",
    paneId: "w1:exited",
  });
  const herdr = createHerdr({ agents: [] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.unresolved, []);
  assert.equal(result.waiting.length, 1);
  assert.equal(result.waiting[0].runId, run.id);
  assert.equal(result.waiting[0].state, RUN_STATES.MANUAL_HANDOFF_REQUIRED);
  assert.match(result.waiting[0].reason, /manual-handoff-required/);
  assert.match(result.waiting[0].reason, /workflow result/);
  assert.doesNotMatch(result.waiting[0].reason, /no live|pane/i, "the vanished-pane detail is exactly the misleading framing this bucket exists to avoid");
  assert.equal(result.exitCode, 0);
});

test("inboxCommand puts a needs-input run with no pane id recorded in waiting, not unresolved", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.NEEDS_INPUT, { projectAlias: "ocr", primaryTicket: "A-1" });
  const herdr = createHerdr({ agents: [] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.unresolved, []);
  assert.equal(result.waiting.length, 1);
  assert.equal(result.waiting[0].runId, run.id);
  assert.equal(result.waiting[0].paneId, null);
  assert.match(result.waiting[0].reason, /needs-input/);
  assert.match(result.waiting[0].reason, new RegExp(`workflow result ${run.id}`));
});

test("inboxCommand keeps an active run (idle-awaiting-handoff) with no live agent in unresolved -- that one really is a diagnostic", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.IDLE_AWAITING_HANDOFF, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    paneId: "w1:vanished",
  });
  const herdr = createHerdr({ agents: [] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.waiting, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].runId, run.id);
  assert.equal(result.unresolved[0].state, RUN_STATES.IDLE_AWAITING_HANDOFF);
  assert.match(result.unresolved[0].reason, /no live|not found|no agent/i);
});

// --- inboxCommand: a live, resolved agent must not silently drop a waiting run (C1) -----------
//
// Found by branch review: the pre-fix loop only ever pushed into `waiting` from inside the
// "agent could not be confirmed" branches. A manual-handoff-required/needs-input/blocked run
// whose agent WAS found -- the ordinary shape right after a "manual" hook action, which lets the
// harness Stop proceed and leaves the session open and idle in its pane
// (hooks/lib/lifecycle-hook-core.mjs:133-157) -- fell through every branch and vanished with no
// entry in any list. This is the fresh, typical case, not a corner case.

test("inboxCommand still reports a manual-handoff-required run as waiting when its agent resolves alive and idle (C1)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.MANUAL_HANDOFF_REQUIRED, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    harness: "claude",
    paneId: "w1:p1",
  });
  const herdr = createHerdr({ agents: [{ agent: "claude", pane_id: "w1:p1", agent_status: "idle", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.waiting.length, 1);
  assert.equal(result.waiting[0].runId, run.id);
  assert.match(result.waiting[0].reason, /manual-handoff-required/);
});

test("inboxCommand still reports a needs-input run as waiting when its agent resolves alive with status done (C1)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.NEEDS_INPUT, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    paneId: "w1:p1",
  });
  const herdr = createHerdr({ agents: [{ agent: "pi", pane_id: "w1:p1", agent_status: "done", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.waiting.length, 1);
  assert.equal(result.waiting[0].runId, run.id);
});

// --- inboxCommand: self-reported blocked belongs in waiting, not the vanished-pane diagnostic (I3) --
//
// RUN_STATES.BLOCKED is written from a worker's own self-reported "I am blocked" (handoff.js:16).
// That run is waiting on the operator exactly as unambiguously as manual-handoff-required is --
// its pane being gone is the expected shape, not an infrastructure complaint.

test("inboxCommand puts a self-reported blocked run with no live agent in waiting, not unresolved (I3)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.BLOCKED, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    paneId: "w1:dead",
  });
  const herdr = createHerdr({ agents: [] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.unresolved, []);
  assert.equal(result.waiting.length, 1);
  assert.equal(result.waiting[0].runId, run.id);
  assert.equal(result.waiting[0].state, RUN_STATES.BLOCKED);
  assert.match(result.waiting[0].reason, /blocked/);
  assert.doesNotMatch(result.waiting[0].reason, /no live|pane/i, "the vanished-pane detail is exactly the misleading framing this bucket exists to avoid");
});

// `result-stale` is the deliberate counter-example: it stays in `unresolved` when its agent
// cannot be confirmed, because unlike manual-handoff-required/needs-input/blocked it is not a
// worker self-reporting "I need a human" -- see AWAITS_OPERATOR_STATES's comment in commands.js.
test("inboxCommand keeps a result-stale run with no live agent in unresolved, not waiting (documented decision)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RESULT_STALE, {
    projectAlias: "ocr",
    primaryTicket: "A-1",
    paneId: "w1:gone",
  });
  const herdr = createHerdr({ agents: [] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.waiting, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].runId, run.id);
  assert.equal(result.unresolved[0].state, RUN_STATES.RESULT_STALE);
  assert.match(result.unresolved[0].reason, /no live|not found|no agent/i);
});

// --- inboxCommand: an agent status outside Herdr's documented vocabulary is reported, not dropped (C2) --
//
// HERDR_AGENT_STATUSES (agent-status.js) is Herdr's documented vocabulary: idle, working,
// blocked, done, unknown. The pre-fix code compared `agentStatus(agent) === "blocked"` and did
// nothing on any other outcome -- so `unknown` (Herdr's own "could not determine" value), an
// absent agent_status, and any status outside the vocabulary entirely (e.g. a future Herdr rename
// of "blocked") all silently dropped the run with no entry in any list.

test("inboxCommand reports a running run as unresolved, not silently dropped, when its agent status is unknown (C2)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  const herdr = createHerdr({ agents: [{ agent: "pi", pane_id: "w1:p1", agent_status: "unknown", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.waiting, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].runId, run.id);
  assert.match(result.unresolved[0].reason, /unknown/i);
});

test("inboxCommand reports a running run as unresolved, not silently dropped, when its agent has no agent_status field at all (C2)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  const herdr = createHerdr({ agents: [{ agent: "pi", pane_id: "w1:p1", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.waiting, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].runId, run.id);
});

test("inboxCommand reports a running run as unresolved, not silently dropped, when its agent status is outside Herdr's documented vocabulary (C2)", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  const herdr = createHerdr({ agents: [{ agent: "pi", pane_id: "w1:p1", agent_status: "awaiting-permission", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.waiting, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].runId, run.id);
  assert.match(result.unresolved[0].reason, /awaiting-permission/);
});

test("inboxCommand still reports a run whose agent status is done as neither blocked nor waiting nor unresolved", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  const herdr = createHerdr({ agents: [{ agent: "pi", pane_id: "w1:p1", agent_status: "done", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(result.unresolved, []);
});

test("inboxCommand classifies a manual-handoff-required run as waiting even when Herdr itself is unreachable", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const manual = await createRunInState(store, RUN_STATES.MANUAL_HANDOFF_REQUIRED, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  const running = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-2", paneId: "w1:p2" });
  const herdr = { async listAgents() { throw new Error("herdr unreachable"); } };

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.equal(result.herdrAvailable, false);
  assert.deepEqual(result.waiting.map((entry) => entry.runId), [manual.id]);
  assert.deepEqual(result.unresolved.map((entry) => entry.runId), [running.id]);
  assert.match(result.unresolved[0].reason, /herdr/i);
});

test("inboxCommand puts every non-terminal run in unresolved with herdrAvailable false when Herdr is unreachable, and still exits 0", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const withPane = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  const withoutPane = await createRunInState(store, RUN_STATES.PLANNED, { projectAlias: "ocr", primaryTicket: "A-2" });
  const herdr = { async listAgents() { throw new Error("herdr unreachable"); } };

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.equal(result.herdrAvailable, false);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unresolved.map((entry) => entry.runId).sort(), [withPane.id, withoutPane.id].sort());
  for (const entry of result.unresolved) {
    assert.match(entry.reason, /herdr/i);
  }
  assert.equal(result.exitCode, 0);
});

test("inboxCommand treats a missing herdr adapter as unavailable rather than throwing", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });

  const result = await inboxCommand({}, { stateRoot });

  assert.equal(result.herdrAvailable, false);
  assert.deepEqual(result.unresolved.map((entry) => entry.runId), [run.id]);
  assert.equal(result.exitCode, 0);
});

test("inboxCommand never reports a terminal run, blocked or not", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  await createRunInState(store, RUN_STATES.COMPLETED, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  await createRunInState(store, RUN_STATES.FAILED, { projectAlias: "ocr", primaryTicket: "A-2", paneId: "w1:p2" });
  await createRunInState(store, RUN_STATES.INTERRUPTED, { projectAlias: "ocr", primaryTicket: "A-3", paneId: "w1:p3" });
  const herdr = createHerdr({
    agents: [
      { agent: "pi", pane_id: "w1:p1", agent_status: "blocked", cwd: "/wt" },
      { agent: "pi", pane_id: "w1:p2", agent_status: "blocked", cwd: "/wt" },
      { agent: "pi", pane_id: "w1:p3", agent_status: "blocked", cwd: "/wt" },
    ],
  });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(result.unresolved, []);
});

test("inboxCommand narrows to --project", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const ocrRun = await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "acme", primaryTicket: "B-1", paneId: "w1:p2" });
  const herdr = createHerdr({
    agents: [
      { agent: "pi", pane_id: "w1:p1", agent_status: "blocked", cwd: "/wt" },
      { agent: "pi", pane_id: "w1:p2", agent_status: "blocked", cwd: "/wt" },
    ],
  });

  const result = await inboxCommand({ projectAlias: "ocr" }, { stateRoot, herdr });

  assert.deepEqual(result.blocked.map((entry) => entry.runId), [ocrRun.id]);
});

test("inboxCommand calls herdr.listAgents exactly once regardless of run count", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  for (let index = 0; index < 5; index += 1) {
    await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: `A-${index}`, paneId: `w1:p${index}` });
  }
  const herdr = createHerdr({ agents: [] });

  await inboxCommand({}, { stateRoot, herdr });

  assert.deepEqual(herdr.calls.map((call) => call.kind), ["listAgents"]);
});

test("inboxCommand surfaces a skipped record as data the same way runsCommand does", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  await createRunInState(store, RUN_STATES.RUNNING, { projectAlias: "ocr", primaryTicket: "A-1", paneId: "w1:p1" });

  const brokenRunId = "88888888-8888-4888-8888-888888888888";
  await realFs.mkdir(join(stateRoot, brokenRunId), { recursive: true, mode: 0o700 });
  await realFs.writeFile(join(stateRoot, brokenRunId, "run.json"), "not json", { mode: 0o600 });
  const herdr = createHerdr({ agents: [{ agent: "pi", pane_id: "w1:p1", agent_status: "idle", cwd: "/wt" }] });

  const result = await inboxCommand({}, { stateRoot, herdr });

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].runId, brokenRunId);
  assert.equal(result.exitCode, 0);
});

// --- verifyCommand ----------------------------------------------------------
//
// A real store over a temp state root (runsCommand/inboxCommand's own lesson: a stubbed store
// hides exactly the defects that matter), with the project registry and the bounded shell runner
// (task 1's `runVerifyCommand`) both injected -- the matrix/refusal logic under test here has
// nothing to do with real YAML parsing or a real shell, and task 1 already covers the runner's own
// contract exhaustively.

// Wraps a real store so a test can assert exactly how many times (and with what) appendEvent was
// called, without giving up the real store's real file-backed appendEvent behavior underneath.
// Object.freeze on the store (run-store.js) blocks mutation, not spreading -- this makes a new
// plain object, so the override is safe.
function withAppendSpy(store) {
  const appendEventCalls = [];
  return {
    ...store,
    appendEventCalls,
    async appendEvent(runId, event) {
      appendEventCalls.push({ runId, event });
      return store.appendEvent(runId, event);
    },
  };
}

function verifyLoadRegistry(projects) {
  return async () => ({ projects });
}

// A test double for task 1's `runVerifyCommand`, scripted by `${cwd}::${command}` so a test can
// pick exactly one cell of the repository x command matrix to fail/error/time out while every
// other cell defaults to a clean pass -- the shape needed to prove attribution (a failure in one
// repository must not smear onto, or hide, the others).
function scriptedVerifyRunner(script = {}) {
  const calls = [];
  return {
    calls,
    async run(command, options = {}) {
      calls.push({ command, cwd: options.cwd });
      const scripted = script[`${options.cwd}::${command}`] ?? { status: "passed" };
      const exitCode = scripted.exitCode
        ?? (scripted.status === "passed" ? 0 : scripted.status === "failed" ? 1 : null);
      return {
        command,
        cwd: options.cwd,
        status: scripted.status,
        exitCode,
        output: scripted.output ?? "",
        truncated: scripted.truncated ?? false,
        durationMs: scripted.durationMs ?? 5,
        ...(scripted.reason !== undefined ? { reason: scripted.reason } : {}),
      };
    },
  };
}

test("verifyCommand runs every verify command once per repository, with that repository's path as cwd, and attributes a second-repository failure to it", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [
      { id: "backend", path: "/repo/acme/backend", branch: "feature/a" },
      { id: "panel", path: "/repo/acme/panel", branch: "feature/a" },
      { id: "docs", path: "/repo/acme/docs", branch: "feature/a" },
    ],
  });
  const loadRegistry = verifyLoadRegistry({ acme: { verify: ["pnpm typecheck", "pnpm test"] } });
  const runner = scriptedVerifyRunner({
    "/repo/acme/panel::pnpm test": { status: "failed", exitCode: 1, output: "1 failing" },
  });

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  // The matrix is every command x every repository: 2 commands x 3 repositories = 6 calls, each
  // with the owning repository's own path as cwd.
  assert.deepEqual(runner.calls, [
    { command: "pnpm typecheck", cwd: "/repo/acme/backend" },
    { command: "pnpm test", cwd: "/repo/acme/backend" },
    { command: "pnpm typecheck", cwd: "/repo/acme/panel" },
    { command: "pnpm test", cwd: "/repo/acme/panel" },
    { command: "pnpm typecheck", cwd: "/repo/acme/docs" },
    { command: "pnpm test", cwd: "/repo/acme/docs" },
  ]);
  assert.equal(result.results.length, 6);

  const panelFailure = result.results.find((entry) => entry.repositoryId === "panel" && entry.command === "pnpm test");
  assert.equal(panelFailure.status, "failed");
  assert.equal(panelFailure.cwd, "/repo/acme/panel");
  assert.equal(panelFailure.exitCode, 1);

  // The failure is attributed to panel specifically -- backend and docs, and panel's own
  // typecheck, must all still read as passed rather than being smeared by panel's one failure.
  for (const entry of result.results) {
    if (entry === panelFailure) continue;
    assert.equal(entry.status, "passed", `${entry.repositoryId}/${entry.command} must not be affected by panel's failure`);
  }

  assert.equal(result.passed, false);
  assert.equal(result.exitCode, VERIFY_EXIT_CODES.failed);
});

test("verifyCommand records a passed status for a clean command and a failed status with its exit code otherwise", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });

  const cleanRun = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    repositories: [{ id: "ocr", path: "/repo/ocr", branch: "main" }],
  });
  const loadRegistry = verifyLoadRegistry({ ocr: { verify: ["pnpm typecheck"] } });
  const cleanResult = await verifyCommand(
    { runId: cleanRun.id },
    { store, loadRegistry, runVerifyCommand: scriptedVerifyRunner().run },
  );
  assert.equal(cleanResult.results[0].status, "passed");
  assert.equal(cleanResult.results[0].exitCode, 0);
  assert.equal(cleanResult.passed, true);
  assert.equal(cleanResult.exitCode, VERIFY_EXIT_CODES.passed);

  const brokenRun = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-2",
    repositories: [{ id: "ocr", path: "/repo/ocr", branch: "main" }],
  });
  const runner = scriptedVerifyRunner({
    "/repo/ocr::pnpm typecheck": { status: "failed", exitCode: 2, output: "type error" },
  });
  const brokenResult = await verifyCommand({ runId: brokenRun.id }, { store, loadRegistry, runVerifyCommand: runner.run });
  assert.equal(brokenResult.results[0].status, "failed");
  assert.equal(brokenResult.results[0].exitCode, 2);
  assert.equal(brokenResult.passed, false);
  assert.equal(brokenResult.exitCode, VERIFY_EXIT_CODES.failed);
});

test("a missing repository path is recorded as an error for that repository, and the remaining repositories still run", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [
      { id: "backend", path: "/repo/acme/backend", branch: "feature/a" },
      { id: "gone", path: "/repo/acme/gone", branch: "feature/a" },
    ],
  });
  const loadRegistry = verifyLoadRegistry({ acme: { verify: ["pnpm typecheck"] } });
  const runner = scriptedVerifyRunner({
    "/repo/acme/gone::pnpm typecheck": { status: "error", exitCode: null, reason: "cwd not found: /repo/acme/gone" },
  });

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  assert.equal(result.results.length, 2);
  const backend = result.results.find((entry) => entry.repositoryId === "backend");
  const gone = result.results.find((entry) => entry.repositoryId === "gone");
  assert.equal(backend.status, "passed");
  assert.equal(gone.status, "error");
  assert.equal(gone.reason, "cwd not found: /repo/acme/gone");
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, VERIFY_EXIT_CODES.failed);
});

test("a timed-out command does not abort the remaining matrix", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await store.create({
    projectAlias: "acme",
    primaryTicket: "A-1",
    repositories: [{ id: "backend", path: "/repo/acme/backend", branch: "feature/a" }],
  });
  const loadRegistry = verifyLoadRegistry({ acme: { verify: ["pnpm typecheck", "pnpm test"] } });
  const runner = scriptedVerifyRunner({
    "/repo/acme/backend::pnpm typecheck": { status: "timed-out", exitCode: null, reason: "timed out after 300000ms" },
  });

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, "timed-out");
  assert.equal(result.results[0].reason, "timed out after 300000ms");
  // pnpm test still ran even though pnpm typecheck timed out first.
  assert.equal(result.results[1].status, "passed");
  assert.equal(result.passed, false);
});

test("verifyCommand refuses a run with no repositories[] recorded, and appends nothing", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = withAppendSpy(createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") }));
  const run = await store.create({ projectAlias: "ocr", primaryTicket: "A-1" });
  const loadRegistry = verifyLoadRegistry({ ocr: { verify: ["pnpm typecheck"] } });
  const runner = scriptedVerifyRunner();

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  assert.equal(result.command, "verify");
  assert.equal(result.runId, run.id);
  assert.deepEqual(result.results, []);
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, VERIFY_EXIT_CODES.refused);
  assert.match(result.reason, /no repositories/i);
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("verifyCommand refuses a run whose project is absent from the registry, and appends nothing", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = withAppendSpy(createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") }));
  const run = await store.create({
    projectAlias: "ghost",
    primaryTicket: "A-1",
    repositories: [{ id: "ghost", path: "/repo/ghost", branch: "main" }],
  });
  const loadRegistry = verifyLoadRegistry({ ocr: { verify: ["pnpm typecheck"] } }); // no "ghost" project
  const runner = scriptedVerifyRunner();

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  assert.deepEqual(result.results, []);
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, VERIFY_EXIT_CODES.refused);
  assert.match(result.reason, /unknown workflow project: ghost/i);
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(store.appendEventCalls, []);
});

test("verifyCommand refuses a project with no verify commands configured, and appends nothing", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = withAppendSpy(createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") }));
  const run = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    repositories: [{ id: "ocr", path: "/repo/ocr", branch: "main" }],
  });
  const loadRegistry = verifyLoadRegistry({ ocr: {} }); // no verify field at all
  const runner = scriptedVerifyRunner();

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  assert.deepEqual(result.results, []);
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, VERIFY_EXIT_CODES.refused);
  assert.match(result.reason, /no verify commands/i);
  assert.deepEqual(store.appendEventCalls, []);

  // An empty verify array is the same refusal as an absent field -- not a matrix of zero results.
  const emptyLoadRegistry = verifyLoadRegistry({ ocr: { verify: [] } });
  const emptyResult = await verifyCommand({ runId: run.id }, { store, loadRegistry: emptyLoadRegistry, runVerifyCommand: runner.run });
  assert.equal(emptyResult.exitCode, VERIFY_EXIT_CODES.refused);
  assert.match(emptyResult.reason, /no verify commands/i);
});

test("the evidence lands in the run's event log, in a form workflow result can read back", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });
  const run = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    repositories: [{ id: "ocr", path: "/repo/ocr", branch: "main" }],
  });
  const loadRegistry = verifyLoadRegistry({ ocr: { verify: ["pnpm typecheck"] } });
  const runner = scriptedVerifyRunner();

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  const eventsPath = join(run.directory, "events.jsonl");
  const lines = (await realFs.readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const [event] = lines;
  assert.equal(event.type, "verification");
  assert.equal(event.runId, run.id);
  assert.equal(typeof event.id, "string");
  assert.equal(typeof event.timestamp, "string");
  assert.equal(event.passed, true);
  assert.equal(event.exitCode, VERIFY_EXIT_CODES.passed);
  assert.deepEqual(event.results, result.results);
});

// I4 (branch review): before this fix, a held run lock turned `store.appendEvent`'s lock
// diagnostic into a thrown error that discarded the entire matrix -- no table, no results, after
// the real cost (a serial run of every verify command x every repository) had already been paid.
// Simulated the same way workflow-run-store.test.js proves lock contention: a real `run.lock/active`
// directory created out-of-band (not a mocked store), with `retryNow`/`sleep` injected so the
// bounded retry exhausts its budget in simulated time instead of real wall-clock seconds.
test("a held run lock does not discard the matrix that already ran; the results come back with an evidenceError instead of being thrown away", async (t) => {
  const stateRoot = await tempStateRoot(t);
  let elapsedMs = 0;
  const store = createRunStore({
    stateRoot,
    clock: fixedClock("2025-01-01T00:00:00.000Z"),
    retryNow: () => elapsedMs,
    sleep: async (ms) => {
      elapsedMs += ms;
    },
  });
  const run = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    repositories: [{ id: "ocr", path: "/repo/ocr", branch: "main" }],
  });
  const loadRegistry = verifyLoadRegistry({ ocr: { verify: ["pnpm typecheck", "pnpm test"] } });
  const runner = scriptedVerifyRunner();

  // Another in-flight command already holds the run lock.
  await realFs.mkdir(join(stateRoot, run.id, "run.lock", "active"), { recursive: true, mode: 0o700 });

  const result = await verifyCommand({ runId: run.id }, { store, loadRegistry, runVerifyCommand: runner.run });

  // The matrix ran to completion despite the lock -- nothing about it was discarded.
  assert.equal(result.command, "verify");
  assert.equal(result.runId, run.id);
  assert.equal(result.results.length, 2);
  assert.equal(result.passed, true);
  assert.equal(result.exitCode, VERIFY_EXIT_CODES.passed);
  assert.deepEqual(runner.calls.map((call) => call.command), ["pnpm typecheck", "pnpm test"]);

  // Persistence failed, and that failure is on the response for the operator to see -- not thrown.
  assert.match(result.evidenceError, /evidence could not be persisted/i);
  assert.match(result.evidenceError, /lock/i);

  // Nothing was appended: the lock was never released for this attempt to write through.
  const eventsPath = join(run.directory, "events.jsonl");
  await assert.rejects(() => realFs.readFile(eventsPath, "utf8"), { code: "ENOENT" });
});

// C1 (branch review): a repository entry with no usable path must be a recorded error for that
// repository, never a silent pass in the CLI's own cwd. Uses the REAL runner (task 1's
// runVerifyCommand, not scriptedVerifyRunner) with a command that writes its actual cwd to a
// marker file -- the same reproduction the review used -- against every shape run-store.js/
// launch.js can actually produce: run-store.js does not validate repositories[] at all (nothing in
// it even mentions "repositories"), and commands.js's own `runLikeFromLaunchPreview`
// (`path: repository.worktreePath ?? repository.path`) and launch.js's `repositoriesForDigest`
// (`path: repository.path ?? null`) both round-trip a missing path through to a bare `null` on the
// run record without complaint.
test("a repository entry with no usable path is a recorded error, not a silent pass in the CLI's own cwd, across every shape a run record can carry", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });

  const shapes = {
    "path missing": { id: "no-path" },
    "path null": { id: "path-null", path: null },
    "path empty string": { id: "path-empty", path: "" },
    "entry is a bare string": "bare-string",
    "entry is an empty object": {},
  };

  for (const [label, repository] of Object.entries(shapes)) {
    const dir = await mkdtemp(join(tmpdir(), "verify-c1-"));
    t.after(() => realFs.rm(dir, { recursive: true, force: true }));
    const markerPath = join(dir, "marker");

    const run = await store.create({
      projectAlias: "ocr",
      primaryTicket: `C1-${label}`,
      repositories: [repository],
    });
    const loadRegistry = verifyLoadRegistry({ ocr: { verify: [`pwd > ${markerPath} ; true`] } });

    const result = await verifyCommand(
      { runId: run.id },
      { store, loadRegistry, runVerifyCommand: realRunVerifyCommand },
    );

    assert.equal(result.results.length, 1, label);
    assert.equal(result.results[0].status, "error", label);
    assert.equal(result.results[0].reason, "no repository path recorded", label);
    assert.equal(result.passed, false, label);
    assert.equal(result.exitCode, VERIFY_EXIT_CODES.failed, label);

    // The command must never have run at all -- not in the repository's own worktree (there is
    // none), and not silently in the CLI's own cwd either.
    assert.equal(existsSync(markerPath), false, `${label}: the command must never have run at all`);
  }
});

// R2 (branch re-review, same false-green class as C1): a *relative* path string is a different
// shape of the exact same problem C1 fixed for a missing one. checkCwd used to treat any non-
// empty string as validated and hand it straight to node's spawn, which resolves a relative cwd
// against THIS process's own cwd (the CLI's own checkout) -- not against any run worktree -- so a
// relative repository.path can pass silently whenever that relative segment happens to exist
// wherever the CLI is invoked from. This repository genuinely has a `src/` directory, so `path:
// "src"` is exactly the false green the re-review measured (`checkCwd("src")` resolving against
// this checkout and reporting `passed`) -- reproduced here through the real runner end to end, the
// same way C1's own test above does for a missing path.
test("a repository entry with a relative path is a recorded error, not a silent pass in the CLI's own cwd", async (t) => {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, clock: fixedClock("2025-01-01T00:00:00.000Z") });

  const dir = await mkdtemp(join(tmpdir(), "verify-r2-"));
  t.after(() => realFs.rm(dir, { recursive: true, force: true }));
  const markerPath = join(dir, "marker");

  const run = await store.create({
    projectAlias: "ocr",
    primaryTicket: "R2-relative-path",
    repositories: [{ id: "ocr", path: "src" }],
  });
  const loadRegistry = verifyLoadRegistry({ ocr: { verify: [`pwd > ${markerPath} ; true`] } });

  const result = await verifyCommand(
    { runId: run.id },
    { store, loadRegistry, runVerifyCommand: realRunVerifyCommand },
  );

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, "error");
  assert.equal(result.results[0].reason, "cwd is not an absolute path: src");
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, VERIFY_EXIT_CODES.failed);

  // The command must never have run at all -- not in this checkout's own src/ (where "src" would
  // otherwise silently resolve) and not anywhere else either.
  assert.equal(existsSync(markerPath), false, "the command must never have run at all");
});
