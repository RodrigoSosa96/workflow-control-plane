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

test("parses live status responses with the configured binary", async () => {
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
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner, binary: "mock-herdr" });

  const status = await herdr.status();

  assert.deepEqual(status, {
    client: { version: "0.7.4", protocol: 16 },
    server: { running: true, compatible: true },
  });
});


test("parses live plain-text integration status lines into stable structured entries", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "mock-herdr");
        assert.deepEqual(args, ["integration", "status"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: [
        "pi: current (v5) (/home/you/.pi/agent/extensions/herdr-agent-state.ts)",
        "copilot: not installed (/home/you/.copilot/hooks/herdr-agent-state.sh)",
      ].join("\n"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner, binary: "mock-herdr" });

  const integrations = await herdr.integrationStatus();

  assert.deepEqual(integrations, [
    {
      name: "pi",
      status: "current",
      version: 5,
      path: "/home/you/.pi/agent/extensions/herdr-agent-state.ts",
    },
    {
      name: "copilot",
      status: "not installed",
      path: "/home/you/.copilot/hooks/herdr-agent-state.sh",
    },
  ]);
});


test("returns an empty list when integration status output is empty", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return {
          code: 0,
          stdout: "\n",
          stderr: "",
        };
      },
    },
  });

  assert.deepEqual(await herdr.integrationStatus(), []);
});


test("rejects malformed nonempty integration status lines", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return {
          code: 0,
          stdout: "pi current missing colon",
          stderr: "",
        };
      },
    },
  });

  await assert.rejects(
    herdr.integrationStatus(),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "HERDR");
      assert.match(error.message, /integration status|malformed/i);
      assert.match(String(error.details.line), /missing colon/i);
      return true;
    },
  );
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

test("surfaces the herdr error envelope when it is written to stderr instead of stdout", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return {
          code: 1,
          stdout: "",
          stderr: cliError(
            { code: "agent_pane_not_found", message: "agent target pane wK:p2 not found" },
            "cli:agent:start",
          ),
        };
      },
    },
  });

  await assert.rejects(
    herdr.startAgent({ name: "fixture-single-FIX-101", paneId: "wK:p2", kind: "pi", argv: ["pi", "--name", "x"] }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "HERDR");
      assert.match(error.message, /agent target pane wK:p2 not found/);
      assert.equal(error.details.code, "agent_pane_not_found");
      return true;
    },
  );
});

test("keeps the generic exit-code failure when stderr holds no herdr envelope", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return { code: 1, stdout: "", stderr: "segfault" };
      },
    },
  });

  await assert.rejects(
    herdr.listAgents(),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "HERDR");
      assert.match(error.message, /exit code 1/);
      assert.equal(error.details.stderr, "segfault");
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

test("omits --base when creating a live native worktree without a base branch", async () => {
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
    base: undefined,
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

test("forwards workflow env to the split pane so the agent inherits the run context", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "pane",
          "split",
          "w2:p2",
          "--direction",
          "down",
          "--cwd",
          "/repo/.worktrees/FIX-101",
          "--env",
          "WORKFLOW_RUN_ID=run-1",
          "--env",
          "WORKFLOW_RUN_DIR=/state/runs/run-1",
          "--env",
          "WORKFLOW_GENERATION=1",
          "--env",
          "WORKFLOW_HARNESS=pi",
          "--env",
          "WORKFLOW_STATE_ROOT=/state",
          "--env",
          "WORKFLOW_CONTROL_PLANE_BIN=/repo/bin/workflow.js",
          "--no-focus",
        ]);
        assert.deepEqual(options, { allowFailure: true, cwd: "/repo/.worktrees/FIX-101" });
      },
      stdout: cliResult({
        type: "pane_split",
        pane: { pane_id: "w2:p3", tab_id: "w2:t2", workspace_id: "w2" },
      }, "cli:pane:split"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const pane = await herdr.splitPane({
    paneId: "w2:p2",
    direction: "down",
    cwd: "/repo/.worktrees/FIX-101",
    env: {
      WORKFLOW_RUN_ID: "run-1",
      WORKFLOW_RUN_DIR: "/state/runs/run-1",
      WORKFLOW_GENERATION: "1",
      WORKFLOW_HARNESS: "pi",
      WORKFLOW_STATE_ROOT: "/state",
      WORKFLOW_CONTROL_PLANE_BIN: "/repo/bin/workflow.js",
    },
    focus: false,
  });

  assert.deepEqual(pane, { paneId: "w2:p3" });
});

test("rejects non-workflow env keys before splitting a pane", async () => {
  const fixture = fixtureRunner([]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  await assert.rejects(
    herdr.splitPane({
      paneId: "w2:p2",
      direction: "down",
      cwd: "/repo/.worktrees/FIX-101",
      env: { PATH: "/usr/bin" },
    }),
    (error) => error instanceof WorkflowError && error.category === "PREFLIGHT",
  );
  assert.equal(fixture.calls.length, 0);
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

test("quotes a trusted argv so the pane shell cannot split or glob it", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "pane",
          "run",
          "w2:p3",
          "'/usr/bin/node' '/repo dir/bin/workflow-worker.js' '--run' 'd46f8572-de27-465e-baf8-1ceafb850d62'",
        ]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ accepted: true }, "cli:pane:run"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(
    await herdr.runInPane({
      paneId: "w2:p3",
      argv: [
        "/usr/bin/node",
        "/repo dir/bin/workflow-worker.js",
        "--run",
        "d46f8572-de27-465e-baf8-1ceafb850d62",
      ],
    }),
    { accepted: true },
  );
});

test("escapes embedded single quotes when quoting pane argv", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args }) => {
        assert.deepEqual(args, ["pane", "run", "w2:p3", "'node' '/repo/it'\\''s/worker.js'"]);
      },
      stdout: cliResult({ accepted: true }, "cli:pane:run"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  await herdr.runInPane({ paneId: "w2:p3", argv: ["node", "/repo/it's/worker.js"] });
});

test("rejects untrusted argv shapes before running anything in a pane", async () => {
  const fixture = fixtureRunner([]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  for (const argv of [[], ["node", ""], ["node", 42]]) {
    await assert.rejects(
      herdr.runInPane({ paneId: "w2:p3", argv }),
      (error) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.category, "PREFLIGHT");
        return true;
      },
    );
  }
  assert.equal(fixture.calls.length, 0);
});

test("gets pane process-info through the public cli and unwraps the live envelope", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["pane", "process-info", "--pane", "w2:p3"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "pane_process_info",
        pane: { pane_id: "w2:p3", tab_id: "w2:t2" },
        process: {
          running: true,
          executable: "/usr/bin/pnpm",
          command: "pnpm dev:api",
          pid: 4242,
        },
      }, "cli:pane:process-info"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(await herdr.getPaneProcessInfo("w2:p3"), {
    running: true,
    executable: "/usr/bin/pnpm",
    command: "pnpm dev:api",
    pid: 4242,
  });
});

test("gets pane process-info from live foreground_processes contract", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["pane", "process-info", "--pane", "w2:p3"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "pane_process_info",
        pane: { pane_id: "w2:p3", tab_id: "w2:t2" },
        process_info: {
          pane_id: "w2:p3",
          shell_pid: 100,
          foreground_process_group_id: 4242,
          foreground_processes: [
            {
              argv: ["node", "server.js"],
              cmdline: "node server.js",
              cwd: "/repo",
              name: "node",
              pid: 4242,
            },
          ],
        },
      }, "cli:pane:process-info"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(await herdr.getPaneProcessInfo("w2:p3"), {
    pane_id: "w2:p3",
    shell_pid: 100,
    foreground_process_group_id: 4242,
    foreground_processes: [
      {
        argv: ["node", "server.js"],
        cmdline: "node server.js",
        cwd: "/repo",
        name: "node",
        pid: 4242,
      },
    ],
    argv: ["node", "server.js"],
    cmdline: "node server.js",
    cwd: "/repo",
    name: "node",
    pid: 4242,
    running: true,
    executable: "node",
    command: "node server.js",
  });
});

test("starts an agent with live argv after --, dropping the executable herdr supplies itself", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "agent",
          "start",
          "ocr-ASANA-123-discovered-docs",
          "--kind",
          "pi",
          "--pane",
          "w2:p9",
          "--timeout",
          "30000",
          "--",
          "--name",
          "ocr-ASANA-123-discovered-docs",
        ]);
        assert.deepEqual(options, { allowFailure: true });
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
    paneId: "w2:p9",
    kind: "pi",
    argv: ["pi", "--name", "ocr-ASANA-123-discovered-docs"],
    focus: false,
    timeout: 30000,
  });

  assert.deepEqual(result, {
    agentId: "a9",
    tabId: "w2:t1",
    paneId: "w2:p9",
  });
});

test("starts an agent when the live contract omits agent_id", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "agent",
          "start",
          "ocr-ASANA-123-discovered-docs",
          "--kind",
          "pi",
          "--pane",
          "w2:p9",
          "--",
          "--name",
          "ocr-ASANA-123-discovered-docs",
        ]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "agent_started",
        agent: {
          name: "ocr-ASANA-123-discovered-docs",
          workspace_id: "w2",
          tab_id: "w2:t1",
          pane_id: "w2:p9",
        },
        argv: ["pi", "--name", "ocr-ASANA-123-discovered-docs"],
      }, "cli:agent:start"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.startAgent({
    name: "ocr-ASANA-123-discovered-docs",
    paneId: "w2:p9",
    kind: "pi",
    argv: ["pi", "--name", "ocr-ASANA-123-discovered-docs"],
    focus: false,
  });

  assert.deepEqual(result, {
    agentId: null,
    tabId: "w2:t1",
    paneId: "w2:p9",
  });
});

test("starts an agent with a non-pi harness kind", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, [
          "agent",
          "start",
          "ocr-ASANA-123-discovered-docs",
          "--kind",
          "codex",
          "--pane",
          "w2:p10",
          "--",
          "-C",
          "/repo/.worktrees/ASANA-123-discovered-docs",
        ]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({
        type: "agent_started",
        agent: { agent_id: "a10", name: "ocr-ASANA-123-discovered-docs" },
        tab: { tab_id: "w2:t1" },
        pane: { pane_id: "w2:p10" },
      }, "cli:agent:start"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.startAgent({
    name: "ocr-ASANA-123-discovered-docs",
    paneId: "w2:p10",
    kind: "codex",
    argv: ["codex", "-C", "/repo/.worktrees/ASANA-123-discovered-docs"],
  });

  assert.deepEqual(result, {
    agentId: "a10",
    tabId: "w2:t1",
    paneId: "w2:p10",
  });
});

test("waits for a freshly split pane to reach its shell prompt before starting the agent", async () => {
  let attempts = 0;
  const slept = [];
  const herdr = createHerdrAdapter({
    sleep: async (ms) => { slept.push(ms); },
    runner: {
      async run() {
        attempts += 1;
        if (attempts < 3) {
          return {
            code: 1,
            stdout: "",
            stderr: cliError(
              { code: "agent_pane_busy", message: "agent target pane w2:p9 is not an available shell" },
              "cli:agent:start",
            ),
          };
        }
        return {
          code: 0,
          stdout: cliResult({
            type: "agent_started",
            agent: { agent_id: "a9" },
            tab: { tab_id: "w2:t1" },
            pane: { pane_id: "w2:p9" },
          }, "cli:agent:start"),
          stderr: "",
        };
      },
    },
  });

  const result = await herdr.startAgent({
    name: "fixture-single-fix-101",
    paneId: "w2:p9",
    kind: "pi",
    argv: ["pi", "--name", "x"],
  });

  assert.equal(result.agentId, "a9");
  assert.equal(attempts, 3);
  assert.equal(slept.length, 2);
});

test("gives up waiting for a busy pane and surfaces the herdr error", async () => {
  let attempts = 0;
  const herdr = createHerdrAdapter({
    sleep: async () => {},
    runner: {
      async run() {
        attempts += 1;
        return {
          code: 1,
          stdout: "",
          stderr: cliError(
            { code: "agent_pane_busy", message: "agent target pane w2:p9 is not an available shell" },
            "cli:agent:start",
          ),
        };
      },
    },
  });

  await assert.rejects(
    herdr.startAgent({
      name: "fixture-single-fix-101",
      paneId: "w2:p9",
      kind: "pi",
      argv: ["pi", "--name", "x"],
      paneReadyTimeout: 1000,
    }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.details.code, "agent_pane_busy");
      return true;
    },
  );
  assert.ok(attempts > 1, `expected retries, got ${attempts}`);
});

test("does not retry agent start failures unrelated to pane readiness", async () => {
  let attempts = 0;
  const herdr = createHerdrAdapter({
    sleep: async () => {},
    runner: {
      async run() {
        attempts += 1;
        return {
          code: 1,
          stdout: "",
          stderr: cliError({ code: "invalid_agent_name", message: "agent name must start with a lowercase letter" }, "cli:agent:start"),
        };
      },
    },
  });

  await assert.rejects(
    herdr.startAgent({ name: "BAD", paneId: "w2:p9", kind: "pi", argv: ["pi", "--name", "x"] }),
    (error) => error.details.code === "invalid_agent_name",
  );
  assert.equal(attempts, 1);
});

test("rejects argv whose executable does not match the agent kind", async () => {
  const calls = [];
  const herdr = createHerdrAdapter({
    runner: {
      async run(command, args, options) {
        calls.push({ command, args, options });
        return { code: 0, stdout: cliResult(null), stderr: "" };
      },
    },
  });

  await assert.rejects(
    herdr.startAgent({
      name: "ocr-ASANA-123-discovered-docs",
      paneId: "w2:p9",
      kind: "pi",
      argv: ["codex", "--name", "x"],
    }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /kind/i);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test("accepts an absolute executable path whose basename matches the kind", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args }) => {
        assert.deepEqual(args, [
          "agent",
          "start",
          "ocr-ASANA-123-discovered-docs",
          "--kind",
          "pi",
          "--pane",
          "w2:p9",
          "--",
          "--name",
          "x",
        ]);
      },
      stdout: cliResult({
        type: "agent_started",
        agent: { agent_id: "a11" },
        tab: { tab_id: "w2:t1" },
        pane: { pane_id: "w2:p9" },
      }, "cli:agent:start"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  const result = await herdr.startAgent({
    name: "ocr-ASANA-123-discovered-docs",
    paneId: "w2:p9",
    kind: "pi",
    argv: ["/usr/local/bin/pi", "--name", "x"],
  });

  assert.equal(result.agentId, "a11");
});

test("agentSendKeys sends the exit keys to the target via the public cli", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["agent", "send-keys", "w2:p9", "C-d"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ sent: true }, "cli:agent:send-keys"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });
  assert.deepEqual(await herdr.agentSendKeys({ target: "w2:p9", keys: ["C-d"] }), { sent: true });
});

test("agentSendKeys sends multiple keys in order", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["agent", "send-keys", "w1T:p2", "ctrl+d"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ sent: true }, "cli:agent:send-keys"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });
  assert.deepEqual(await herdr.agentSendKeys({ target: "w1T:p2", keys: ["ctrl+d"] }), { sent: true });
});

test("agentSendKeys rejects a missing target or empty keys", async () => {
  const herdr = createHerdrAdapter({ runner: fixtureRunner([]).runner });
  await assert.rejects(herdr.agentSendKeys({ target: "", keys: ["C-d"] }), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
  await assert.rejects(herdr.agentSendKeys({ target: "w2:p9", keys: [] }), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
  await assert.rejects(herdr.agentSendKeys({ target: "w2:p9", keys: ["ok", ""] }), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
  await assert.rejects(herdr.agentSendKeys({ target: "w2:p9", keys: [42] }), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
  await assert.rejects(herdr.agentSendKeys({}), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
});

test("focusTab focuses the target tab via the public cli", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["tab", "focus", "w2:t1"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      stdout: cliResult({ focused: true }, "cli:tab:focus"),
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });
  assert.deepEqual(await herdr.focusTab({ tabId: "w2:t1" }), { focused: true });
});

test("focusTab rejects a missing tab id", async () => {
  const herdr = createHerdrAdapter({ runner: fixtureRunner([]).runner });
  await assert.rejects(herdr.focusTab({ tabId: "" }), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
  await assert.rejects(herdr.focusTab({}), (e) => e instanceof WorkflowError && e.category === "PREFLIGHT");
});

test("startAgent requires paneId and kind", async () => {
  const calls = [];
  const herdr = createHerdrAdapter({
    runner: {
      async run(command, args, options) {
        calls.push({ command, args, options });
        return { code: 0, stdout: cliResult(null), stderr: "" };
      },
    },
  });

  await assert.rejects(
    herdr.startAgent({
      name: "ocr-ASANA-123-discovered-docs",
      argv: ["pi", "--name", "ocr-ASANA-123-discovered-docs"],
    }),
    (error) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.category, "PREFLIGHT");
      assert.match(error.message, /pane ID|kind/i);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});
