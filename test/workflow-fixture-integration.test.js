import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createWorkflowFixture } from "../src/workflow/fixture.js";
import { launchCommand, handoffCommand, resultCommand } from "../src/workflow/commands.js";
import { createGitAdapter } from "../src/workflow/git.js";
import { createProcessRunner } from "../src/workflow/process.js";
import { createRunStore } from "../src/workflow/run-store.js";

function fakeGit() {
  return {
    async fingerprint({ cwd }) {
      return {
        digest: "fake-digest",
        branch: "main",
        head: "abc123",
        root: cwd,
        changed: [],
      };
    },
    async inspectRepository({ cwd }) {
      return {
        root: cwd,
        branch: "main",
        head: "abc123",
        changed: [],
        clean: true,
        upstream: null,
      };
    },
  };
}

function fakeHerdr({ harness = "pi" } = {}) {
  return {
    async ensureNativeWorktree() { return { workspaceId: "ws-1", worktreePath: "/tmp", tabId: "tab-1", paneId: "pane-1" }; },
    async renameTab() {},
    async createTab() { return { tabId: "tab-1" }; },
    async startAgent() { return { agentId: "agent-1", tabId: "tab-1", paneId: "pane-1" }; },
    async listWorkspaces() { return { workspaces: [] }; },
    async listTabs() { return { tabs: [] }; },
    async listPanes() { return { panes: [] }; },
    async listAgents() { return { agents: [] }; },
    async closePane() {},
    async status() { return { server: { running: true, compatible: true }, version: "0.7.4" }; },
    async integrationStatus() { return [{ name: harness, status: "current" }]; },
  };
}

async function tempParent() {
  return await mkdtemp(join(tmpdir(), "workflow-integ-"));
}

test("dry-run launch preview accepts all four fixture harness profiles", async () => {
  const parent = await tempParent();
  const fixture = await createWorkflowFixture({ root: join(parent, "fixture"), packageRoot: "/repo" });

  for (const agentProfile of ["pi-worker", "claude-worker", "codex-worker", "opencode-worker"]) {
    const { preview } = await launchCommand({
      projectAlias: "fixture-single",
      task: "FIX-101",
      agentProfile,
      registryPath: fixture.registryPath,
      stateRoot: fixture.stateRoot,
      controlPlaneBin: "/repo/bin/workflow.js",
      request: "fixture edit",
    }, {
      herdr: fakeHerdr(),
      git: createGitAdapter({ runner: createProcessRunner() }),
      lookupExecutable: async (name) => `/usr/bin/${name}`,
    });

    const harness = agentProfile === "opencode-worker" ? "opencode" : agentProfile.replace("-worker", "");
    assert.equal(preview.selection.harness, harness);
    assert.equal(preview.selection.profileName, agentProfile);
    assert.equal(preview.reconciliation.agent.profile.mode, "stream-json");
    if (agentProfile === "opencode-worker") {
      assert.equal(preview.reconciliation.agent.profile.availability, "fixture-only");
    }
  }

  await rm(parent, { recursive: true, force: true });
});

for (const agentProfile of ["pi-worker", "claude-worker", "codex-worker", "opencode-worker"]) {
  test(`full fake worker cycle through launch, handoff, and result for ${agentProfile}`, async () => {
    const parent = await tempParent();
    const fixture = await createWorkflowFixture({ root: join(parent, "fixture"), packageRoot: "/repo" });

    const repoDir = join(fixture.root, "fixture-single");
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "index.js"), "module.exports = () => 0;\n");
    await mkdir(join(repoDir, "test"), { recursive: true });
    await writeFile(
      join(repoDir, "test", "index.test.js"),
      'const assert = require("assert");\nconst fn = require("../src/index.js");\nassert.equal(fn(), 42);\n',
    );

    const harness = agentProfile === "opencode-worker" ? "opencode" : agentProfile.replace("-worker", "");
    const git = fakeGit();
    const herdr = fakeHerdr({ harness });

    const { preview, execute } = await launchCommand({
      projectAlias: "fixture-single",
      task: "FIX-101",
      agentProfile,
      registryPath: fixture.registryPath,
      stateRoot: fixture.stateRoot,
      controlPlaneBin: "/repo/bin/workflow.js",
      request: "Edit fixture-single/src/index.js so the test passes.",
    }, { herdr, git: createGitAdapter({ runner: createProcessRunner() }), lookupExecutable: async (name) => `/usr/bin/${name}` });

    const report = await execute({ approvalDigest: preview.approvalDigest });
    assert.equal(report.status, "running");
    const runId = report.runId;

    const fakeAgentPath = join(import.meta.dirname, "support", "fake-workflow-agent.js");
    const runDir = join(fixture.stateRoot, runId);
    const child = spawn(process.execPath, [fakeAgentPath], {
      env: {
        ...process.env,
        WORKFLOW_RUN_ID: runId,
        WORKFLOW_STATE_ROOT: fixture.stateRoot,
        WORKFLOW_RUN_DIR: runDir,
        WORKFLOW_HARNESS: harness,
        WORKFLOW_GENERATION: "1",
        WORKFLOW_CONTROL_PLANE_BIN: "/repo/bin/workflow.js",
      },
      cwd: repoDir,
    });
    const workerExit = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(workerExit, 0);

    const store = createRunStore({ stateRoot: fixture.stateRoot });
    const handoffResult = await handoffCommand({ runId, input: join(runDir, "handoff-input.json"), env: { WORKFLOW_RUN_ID: runId } }, { store, git });
    assert.equal(handoffResult.status, "completed");

    const result = await resultCommand({ runId }, { store, git });
    assert.equal(result.status, "completed");
    assert.equal(result.runId, runId);

    await rm(parent, { recursive: true, force: true });
  });
}
