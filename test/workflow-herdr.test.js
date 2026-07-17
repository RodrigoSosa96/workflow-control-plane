import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowError } from "../src/workflow/errors.js";
import { createHerdrAdapter } from "../src/workflow/herdr.js";

function jsonResult(result) {
  return JSON.stringify({ ok: true, result });
}

function jsonError(error) {
  return JSON.stringify({ ok: false, error });
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
          stdout: fixture.stdout ?? jsonResult(fixture.result ?? null),
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

test("parses JSON status and integration responses with the configured binary", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "mock-herdr");
        assert.deepEqual(args, ["status", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: { server: { running: true } },
    },
    {
      assert: ({ command, args, options }) => {
        assert.equal(command, "mock-herdr");
        assert.deepEqual(args, ["integration", "status", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: { pi: { installed: true, current: true } },
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner, binary: "mock-herdr" });

  const status = await herdr.status();
  const integrations = await herdr.integrationStatus();

  assert.deepEqual(status, { server: { running: true } });
  assert.deepEqual(integrations, { pi: { installed: true, current: true } });
});

test("lists and gets workspaces, tabs, panes, and agents through JSON wrappers", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["workspace", "list", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: [{ workspace_id: "w1", cwd: "/repo/main" }],
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["workspace", "get", "w1", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: { workspace_id: "w1", cwd: "/repo/main" },
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["tab", "list", "--workspace", "w1", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: [{ tab_id: "w1:t1", workspace_id: "w1" }],
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["pane", "list", "--workspace", "w1", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: [{ pane_id: "w1:p1", tab_id: "w1:t1" }],
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["agent", "list", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: [{ agent_id: "a1", name: "ocr-ASANA-123" }],
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(await herdr.listWorkspaces(), [{ workspace_id: "w1", cwd: "/repo/main" }]);
  assert.deepEqual(await herdr.getWorkspace({ workspaceId: "w1" }), { workspace_id: "w1", cwd: "/repo/main" });
  assert.deepEqual(await herdr.listTabs({ workspaceId: "w1" }), [{ tab_id: "w1:t1", workspace_id: "w1" }]);
  assert.deepEqual(await herdr.listPanes({ workspaceId: "w1" }), [{ pane_id: "w1:p1", tab_id: "w1:t1" }]);
  assert.deepEqual(await herdr.listAgents(), [{ agent_id: "a1", name: "ocr-ASANA-123" }]);
});

test("throws a HERDR error on API error envelopes", async () => {
  const herdr = createHerdrAdapter({
    runner: {
      async run() {
        return {
          code: 9,
          stdout: jsonError({ code: "not_found", message: "pane missing" }),
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

test("returns IDs from a native worktree created response", async () => {
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
      result: {
        type: "worktree_created",
        workspace: { workspace_id: "w2", cwd: "/repo/.worktrees/ASANA-123-discovered-docs" },
        tab: { tab_id: "w2:t1", label: "shell" },
        root_pane: { pane_id: "w2:p1", label: "bootstrap" },
      },
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

test("returns IDs from a native worktree opened response", async () => {
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
      result: {
        type: "worktree_opened",
        workspace: { workspace_id: "w4" },
        tab: { tab_id: "w4:t1" },
        root_pane: { pane_id: "w4:p1" },
      },
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

test("normalizes an already-open native worktree response without deriving IDs from labels", async () => {
  const fixture = fixtureRunner([
    {
      result: {
        type: "worktree_already_open",
        workspace: { workspace_id: "w7", label: "some other label" },
        tab: { tab_id: "w7:t9", label: "agent" },
        root_pane: { pane_id: "w7:p4", label: "not-an-id" },
      },
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

test("creates tabs and panes with explicit focus flags and parsed IDs", async () => {
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
          "--json",
        ]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: {
        tab: { tab_id: "w2:t2" },
        root_pane: { pane_id: "w2:p2" },
      },
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
          "--json",
        ]);
        assert.deepEqual(options, { allowFailure: true, cwd: "/repo/.worktrees/ASANA-123-discovered-docs" });
      },
      result: {
        pane: { pane_id: "w2:p3" },
      },
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

test("renames tabs and panes, preserving literal labels", async () => {
  const fixture = fixtureRunner([
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["tab", "rename", "w2:t2", "agent shell", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: { tab_id: "w2:t2", label: "agent shell" },
    },
    {
      assert: ({ args, options }) => {
        assert.deepEqual(args, ["pane", "rename", "w2:p3", "api server", "--json"]);
        assert.deepEqual(options, { allowFailure: true });
      },
      result: { pane_id: "w2:p3", label: "api server" },
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
      result: { ok: true },
    },
  ]);
  const herdr = createHerdrAdapter({ runner: fixture.runner });

  assert.deepEqual(await herdr.runInPane({ paneId: "w2:p3", command: "pnpm dev:api --filter=@app/api" }), { ok: true });

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

test("starts an agent with explicit focus flags and argv after --", async () => {
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
      result: {
        agent: { agent_id: "a9", name: "ocr-ASANA-123-discovered-docs" },
        tab: { tab_id: "w2:t1" },
        pane: { pane_id: "w2:p9" },
      },
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
