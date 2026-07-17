import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowError } from "../src/workflow/errors.js";
import { createHerdrAdapter } from "../src/workflow/herdr.js";

function cliResult(result, id = "cli:test") {
  return JSON.stringify({ id, result });
}

function apiOk(result) {
  return JSON.stringify({ ok: true, result });
}

function cliError(error, id = "cli:test") {
  return JSON.stringify({ id, error });
}

function fixtureRunner(fixtures = []) {
  const queue = [...fixtures];
  const calls = [];

  return {
    calls,
    runner: {
      async run(command, args = [], options = {}) {
        calls.push({ command, args, options });
        const fixture = queue.shift();
        if (!fixture) {
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        }
        fixture.assert?.({ command, args, options });
        if (fixture.error) throw fixture.error;
        return {
          code: fixture.code ?? 0,
          stdout: fixture.stdout ?? cliResult(fixture.result ?? null),
          stderr: fixture.stderr ?? "",
        };
      },
    },
  };
}

const planOp = {
  cwd: "/repo/main",
  branch: "feature/ASANA-123/discovered-docs",
  base: "main",
  path: "/repo/.worktrees/ASANA-123-discovered-docs",
  label: "ASANA-123 discovered-docs",
};

test("parses live status and integration responses with the configured binary", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "mock-herdr");
        assert.deepEqual(args, ["status", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        client: { version: "0.7.4", protocol: 16 },
        server: { running: true, compatible: true },
      }, "cli:status"),
    },
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "mock-herdr");
        assert.deepEqual(args, ["integration", "status"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        integrations: [
          { name: "pi", state: "current", version: 5 },
        ],
      }, "cli:integration:status"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner, binary: "mock-herdr" });

  const status = await herdr.status();
  const integrations = await herdr.integrationStatus();

  assert.deepEqual(status, {
    client: { version: "0.7.4", protocol: 16 },
    server: { running: true, compatible: true },
  });
  assert.deepEqual(integrations, {
    integrations: [
      { name: "pi", state: "current", version: 5 },
    ],
  });
});

test("keeps supporting legacy ok/result success envelopes", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return {
          code: 0,
          stdout: apiOk({ server: { running: true } }),
          stderr: "",
        };
      },
    },
  });

  assert.deepEqual(await herdr.status(), { server: { running: true } });
});

test("lists and gets workspaces, tabs, panes, and agents through live JSON-default wrappers", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["workspace", "list"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "workspace_list",
        workspaces: [
          {
            active_tab_id: "wH:t3",
            agent_status: "done",
            focused: false,
            label: "workflow-launcher",
            number: 4,
            pane_count: 9,
            tab_count: 3,
            workspace_id: "wH",
            worktree: {
              checkout_path: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
              is_linked_worktree: true,
              repo_key: "/home/you/projects/personal/workflows/.git",
              repo_name: "workflows",
              repo_root: "/home/you/projects/personal/workflows",
            },
          },
        ],
      }, "cli:workspace:list"),
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["workspace", "get", "wH"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "workspace_info",
        workspace: {
          active_tab_id: "wH:t3",
          agent_status: "done",
          focused: false,
          label: "workflow-launcher",
          number: 4,
          pane_count: 9,
          tab_count: 3,
          workspace_id: "wH",
          worktree: {
            checkout_path: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
            is_linked_worktree: true,
            repo_key: "/home/you/projects/personal/workflows/.git",
            repo_name: "workflows",
            repo_root: "/home/you/projects/personal/workflows",
          },
        },
      }, "cli:workspace:get"),
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["tab", "list", "--workspace", "wH"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "tab_list",
        tabs: [
          {
            agent_status: "done",
            focused: false,
            label: "task-4",
            number: 3,
            pane_count: 3,
            tab_id: "wH:t3",
            workspace_id: "wH",
          },
        ],
      }, "cli:tab:list"),
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["pane", "list", "--workspace", "wH"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "pane_list",
        panes: [
          {
            agent: "pi",
            agent_session: {
              agent: "pi",
              kind: "path",
              source: "herdr:pi",
              value: "/home/you/.pi/agent/sessions/session.jsonl",
            },
            agent_status: "working",
            cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
            focused: false,
            foreground_cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
            label: "workflow-task-4",
            pane_id: "wH:p8",
            revision: 1,
            scroll: {
              max_offset_from_bottom: 1088,
              offset_from_bottom: 0,
              viewport_rows: 28,
            },
            tab_id: "wH:t3",
            terminal_id: "term_656d13f62dc871a",
            terminal_title: "π - workflow-task-4 - workflow-launcher",
            terminal_title_stripped: "π - workflow-task-4 - workflow-launcher",
            workspace_id: "wH",
          },
        ],
      }, "cli:pane:list"),
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["agent", "list"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "agent_list",
        agents: [
          {
            agent: "pi",
            agent_session: {
              agent: "pi",
              kind: "path",
              source: "herdr:pi",
              value: "/home/you/.pi/agent/sessions/session.jsonl",
            },
            agent_status: "working",
            cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
            focused: false,
            foreground_cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
            name: "workflow-task-4",
            pane_id: "wH:p8",
            revision: 1,
            screen_detection_skipped: true,
            tab_id: "wH:t3",
            terminal_id: "term_656d13f62dc871a",
            terminal_title: "π - workflow-task-4 - workflow-launcher",
            terminal_title_stripped: "π - workflow-task-4 - workflow-launcher",
            workspace_id: "wH",
          },
        ],
      }, "cli:agent:list"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(await herdr.listWorkspaces(), {
    type: "workspace_list",
    workspaces: [
      {
        active_tab_id: "wH:t3",
        agent_status: "done",
        focused: false,
        label: "workflow-launcher",
        number: 4,
        pane_count: 9,
        tab_count: 3,
        workspace_id: "wH",
        worktree: {
          checkout_path: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
          is_linked_worktree: true,
          repo_key: "/home/you/projects/personal/workflows/.git",
          repo_name: "workflows",
          repo_root: "/home/you/projects/personal/workflows",
        },
      },
    ],
  });
  assert.deepEqual(await herdr.getWorkspace({ workspaceId: "wH" }), {
    type: "workspace_info",
    workspace: {
      active_tab_id: "wH:t3",
      agent_status: "done",
      focused: false,
      label: "workflow-launcher",
      number: 4,
      pane_count: 9,
      tab_count: 3,
      workspace_id: "wH",
      worktree: {
        checkout_path: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
        is_linked_worktree: true,
        repo_key: "/home/you/projects/personal/workflows/.git",
        repo_name: "workflows",
        repo_root: "/home/you/projects/personal/workflows",
      },
    },
  });
  assert.deepEqual(await herdr.listTabs({ workspaceId: "wH" }), {
    type: "tab_list",
    tabs: [
      {
        agent_status: "done",
        focused: false,
        label: "task-4",
        number: 3,
        pane_count: 3,
        tab_id: "wH:t3",
        workspace_id: "wH",
      },
    ],
  });
  assert.deepEqual(await herdr.listPanes({ workspaceId: "wH" }), {
    type: "pane_list",
    panes: [
      {
        agent: "pi",
        agent_session: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: "/home/you/.pi/agent/sessions/session.jsonl",
        },
        agent_status: "working",
        cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
        focused: false,
        foreground_cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
        label: "workflow-task-4",
        pane_id: "wH:p8",
        revision: 1,
        scroll: {
          max_offset_from_bottom: 1088,
          offset_from_bottom: 0,
          viewport_rows: 28,
        },
        tab_id: "wH:t3",
        terminal_id: "term_656d13f62dc871a",
        terminal_title: "π - workflow-task-4 - workflow-launcher",
        terminal_title_stripped: "π - workflow-task-4 - workflow-launcher",
        workspace_id: "wH",
      },
    ],
  });
  assert.deepEqual(await herdr.listAgents(), {
    type: "agent_list",
    agents: [
      {
        agent: "pi",
        agent_session: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: "/home/you/.pi/agent/sessions/session.jsonl",
        },
        agent_status: "working",
        cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
        focused: false,
        foreground_cwd: "/home/you/projects/personal/workflows/.worktrees/workflow-launcher",
        name: "workflow-task-4",
        pane_id: "wH:p8",
        revision: 1,
        screen_detection_skipped: true,
        tab_id: "wH:t3",
        terminal_id: "term_656d13f62dc871a",
        terminal_title: "π - workflow-task-4 - workflow-launcher",
        terminal_title_stripped: "π - workflow-task-4 - workflow-launcher",
        workspace_id: "wH",
      },
    ],
  });
});

test("throws a HERDR error on live API error envelopes", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return {
          code: 9,
          stdout: cliError({ code: "not_found", message: "pane missing" }, "cli:pane:list"),
          stderr: "backend exploded",
        };
      },
    },
  });

  await assert.rejects(
    herdr.listPanes({ workspaceId: "w1" }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "HERDR");
      assert.match(error.message, /pane missing/i);
      assert.equal(error.details.code, "not_found");
      assert.equal(error.details.stderr, "backend exploded");
      return true;
    },
  );
});

test("throws a HERDR error on malformed JSON output", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return {
          code: 0,
          stdout: "not-json",
          stderr: "",
        };
      },
    },
  });

  await assert.rejects(
    herdr.status(),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "HERDR");
      assert.match(error.message, /invalid|json/i);
      return true;
    },
  );
});

test("returns IDs from a live native worktree created response", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "worktree",
          "create",
          "--cwd",
          "/repo/main",
          "--branch",
          "feature/ASANA-123/discovered-docs",
          "--base",
          "main",
          "--path",
          "/repo/.worktrees/ASANA-123-discovered-docs",
          "--label",
          "ASANA-123 discovered-docs",
          "--json",
        ]);
        assert.deepEqual(options, { allowFailure: true, cwd: "/repo/main" });
      },
      stdout: cliResult({
        type: "worktree_created",
        workspace: { workspace_id: "w2", cwd: "/repo/.worktrees/ASANA-123-discovered-docs" },
        tab: { tab_id: "w2:t1", label: "shell" },
        root_pane: { pane_id: "w2:p1", label: "bootstrap" },
      }, "cli:worktree:create"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.ensureNativeWorktree({
    ...planOp,
    reconciliation: { status: "missing" },
  });

  assert.deepEqual(result, {
    workspaceId: "w2",
    tabId: "w2:t1",
    paneId: "w2:p1",
    disposition: "created",
  });
});

test("returns IDs from a live native worktree opened response", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "worktree",
          "open",
          "--cwd",
          "/repo/main",
          "--path",
          "/repo/.worktrees/ASANA-123-discovered-docs",
          "--label",
          "ASANA-123 discovered-docs",
          "--json",
        ]);
        assert.deepEqual(options, { allowFailure: true, cwd: "/repo/main" });
      },
      stdout: cliResult({
        type: "worktree_opened",
        workspace: { workspace_id: "w4" },
        tab: { tab_id: "w4:t1" },
        root_pane: { pane_id: "w4:p1" },
      }, "cli:worktree:open"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.ensureNativeWorktree({
    ...planOp,
    reconciliation: { status: "closed" },
  });

  assert.deepEqual(result, {
    workspaceId: "w4",
    tabId: "w4:t1",
    paneId: "w4:p1",
    disposition: "opened",
  });
});

test("normalizes a live already-open native worktree response without deriving IDs from labels", async () => {
  const fixture = fixtureRunner([
    {
      stdout: cliResult({
        type: "worktree_already_open",
        workspace: { workspace_id: "w7", label: "some other label" },
        tab: { tab_id: "w7:t9", label: "agent" },
        root_pane: { pane_id: "w7:p4", label: "not-an-id" },
      }, "cli:worktree:open"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.ensureNativeWorktree({
    ...planOp,
    reconciliation: { status: "closed" },
  });

  assert.deepEqual(result, {
    workspaceId: "w7",
    tabId: "w7:t9",
    paneId: "w7:p4",
    disposition: "already_open",
  });
});

test("reuses discovered IDs when reconciliation reports an already-open worktree", async () => {
  const fixture = fixtureRunner([]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.ensureNativeWorktree({
    ...planOp,
    reconciliation: {
      status: "open",
      workspace: { workspace_id: "w9" },
      tab: { tab_id: "w9:t1" },
      root_pane: { pane_id: "w9:p1" },
    },
  });

  assert.deepEqual(result, {
    workspaceId: "w9",
    tabId: "w9:t1",
    paneId: "w9:p1",
    disposition: "already_open",
  });
  assert.equal(fixture.calls.length, 0);
});

test("creates tabs and panes with explicit focus flags and live parsed IDs", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "tab",
          "create",
          "--workspace",
          "w2",
          "--label",
          "runtime",
          "--no-focus",
        ]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "tab_created",
        tab: { tab_id: "w2:t2", workspace_id: "w2", label: "runtime" },
        root_pane: { pane_id: "w2:p2", tab_id: "w2:t2", workspace_id: "w2" },
      }, "cli:tab:create"),
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "pane",
          "split",
          "w2:p2",
          "--direction",
          "right",
          "--ratio",
          "0.35",
          "--cwd",
          "/repo/.worktrees/ASANA-123-discovered-docs",
          "--focus",
        ]);
        assert.deepEqual(options, { allowFailure: true, cwd: "/repo/.worktrees/ASANA-123-discovered-docs" });
      },
      stdout: cliResult({
        type: "pane_split",
        pane: {
          pane_id: "w2:p3",
          tab_id: "w2:t2",
          workspace_id: "w2",
          cwd: "/repo/.worktrees/ASANA-123-discovered-docs",
        },
      }, "cli:pane:split"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const tab = await herdr.createTab({ workspaceId: "w2", label: "runtime", focus: false });
  const pane = await herdr.splitPane({
    paneId: "w2:p2",
    direction: "right",
    ratio: 0.35,
    cwd: "/repo/.worktrees/ASANA-123-discovered-docs",
    focus: true,
  });

  assert.deepEqual(tab, { tabId: "w2:t2", paneId: "w2:p2" });
  assert.deepEqual(pane, { paneId: "w2:p3" });
});

test("renames tabs and panes, preserving literal labels without unsupported json flags", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["tab", "rename", "w2:t2", "agent shell"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ tab_id: "w2:t2", label: "agent shell" }, "cli:tab:rename"),
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["pane", "rename", "w2:p3", "api server"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ pane_id: "w2:p3", label: "api server" }, "cli:pane:rename"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(await herdr.renameTab({ tabId: "w2:t2", label: "agent shell" }), {
    tab_id: "w2:t2",
    label: "agent shell",
  });
  assert.deepEqual(await herdr.renamePane({ paneId: "w2:p3", label: "api server" }), {
    pane_id: "w2:p3",
    label: "api server",
  });
});

test("runs trusted pane commands as a single argument and rejects untrusted shapes", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["pane", "run", "w2:p3", "pnpm dev:api --filter=@app/api"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ accepted: true }, "cli:pane:run"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(await herdr.runInPane({ paneId: "w2:p3", command: "pnpm dev:api --filter=@app/api" }), { accepted: true });

  await assert.rejects(
    herdr.runInPane({ paneId: "w2:p3", command: ["pnpm", "dev:api"] }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /registry|command|string/i);
      return true;
    },
  );
});

test("starts an agent with explicit focus flags and live argv after --", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "agent",
          "start",
          "ocr-ASANA-123-discovered-docs",
          "--cwd",
          "/repo/.worktrees/ASANA-123-discovered-docs",
          "--tab",
          "w2:t1",
          "--no-focus",
          "--",
          "pi",
          "--name",
          "ocr-ASANA-123-discovered-docs",
        ]);
        assert.deepEqual(options, { allowFailure: true, cwd: "/repo/.worktrees/ASANA-123-discovered-docs" });
      },
      stdout: cliResult({
        type: "agent_started",
        agent: { agent_id: "a9", name: "ocr-ASANA-123-discovered-docs" },
        tab: { tab_id: "w2:t1" },
        pane: { pane_id: "w2:p9" },
      }, "cli:agent:start"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.startAgent({
    name: "ocr-ASANA-123-discovered-docs",
    cwd: "/repo/.worktrees/ASANA-123-discovered-docs",
    tabId: "w2:t1",
    argv: ["pi", "--name", "ocr-ASANA-123-discovered-docs"],
    focus: false,
  });

  assert.deepEqual(result, {
    agentId: "a9",
    tabId: "w2:t1",
    paneId: "w2:p9",
  });
});
