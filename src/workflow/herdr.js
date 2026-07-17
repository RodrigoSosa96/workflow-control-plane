import { WorkflowError } from "./errors.js";

function fail(category, message, details, exitCode = 1) {
  throw new WorkflowError(category, message, { details, exitCode });
}

function extractId(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

function extractWorkspaceId(value) {
  return extractId(value, ["workspaceId", "workspace_id"])
    ?? extractId(value?.workspace, ["workspaceId", "workspace_id"]);
}

function extractTabId(value) {
  return extractId(value, ["tabId", "tab_id"])
    ?? extractId(value?.tab, ["tabId", "tab_id"]);
}

function extractPaneId(value) {
  return extractId(value, ["paneId", "pane_id"])
    ?? extractId(value?.pane, ["paneId", "pane_id"])
    ?? extractId(value?.rootPane, ["paneId", "pane_id"])
    ?? extractId(value?.root_pane, ["paneId", "pane_id"]);
}

function unwrapHerdrPayload(payload, context) {
  if (!payload || typeof payload !== "object") return payload;

  const error = payload.error ?? (payload.ok === false ? payload : null);
  if (error) {
    fail(
      "HERDR",
      error.message ?? `${context.binary} ${context.area} ${context.command} failed`,
      {
        code: error.code,
        stdout: context.stdout,
        stderr: context.stderr,
        command: context.binary,
        args: [context.area, context.command, ...context.args],
        cwd: context.cwd,
      },
      context.code || 1,
    );
  }

  if (Object.hasOwn(payload, "result")) {
    return payload.result;
  }

  return payload;
}

function parseJsonResult(result, context) {
  const stdout = result.stdout?.trim() ?? "";

  if (!stdout) {
    if (result.code && result.code !== 0) {
      fail(
        "HERDR",
        `${context.binary} ${context.area} ${context.command} failed with exit code ${result.code}`,
        {
          stdout: result.stdout,
          stderr: result.stderr,
          command: context.binary,
          args: [context.area, context.command, ...context.args],
          cwd: context.cwd,
        },
        result.code,
      );
    }
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    fail(
      "HERDR",
      `Invalid JSON from ${context.binary} ${context.area} ${context.command}: ${error.message}`,
      {
        stdout: result.stdout,
        stderr: result.stderr,
        command: context.binary,
        args: [context.area, context.command, ...context.args],
        cwd: context.cwd,
      },
      result.code || 1,
    );
  }

  const value = unwrapHerdrPayload(payload, {
    ...context,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });

  if (result.code && result.code !== 0) {
    fail(
      "HERDR",
      `${context.binary} ${context.area} ${context.command} failed with exit code ${result.code}`,
      {
        stdout: result.stdout,
        stderr: result.stderr,
        command: context.binary,
        args: [context.area, context.command, ...context.args],
        cwd: context.cwd,
      },
      result.code,
    );
  }

  return value;
}

function pushOption(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function pushFocus(args, focus = false) {
  args.push(focus ? "--focus" : "--no-focus");
}

function normalizeWorktreeDisposition(type, fallback) {
  if (type === "worktree_created") return "created";
  if (type === "worktree_opened") return "opened";
  if (type === "worktree_already_open") return "already_open";
  return fallback;
}

function normalizeWorktreeResult(value, fallbackDisposition) {
  const workspaceId = extractWorkspaceId(value);
  const tabId = extractTabId(value);
  const paneId = extractPaneId(value);
  const disposition = normalizeWorktreeDisposition(value?.type, fallbackDisposition);

  if (!workspaceId || !tabId || !paneId || !disposition) {
    fail("HERDR", "Herdr worktree response is missing required IDs", {
      value,
      workspaceId,
      tabId,
      paneId,
      disposition,
    });
  }

  return { workspaceId, tabId, paneId, disposition };
}

function normalizeTabResult(value) {
  const tabId = extractTabId(value);
  const paneId = extractPaneId(value);

  if (!tabId || !paneId) {
    fail("HERDR", "Herdr tab response is missing required IDs", { value, tabId, paneId });
  }

  return { tabId, paneId };
}

function normalizePaneResult(value) {
  const paneId = extractPaneId(value);

  if (!paneId) {
    fail("HERDR", "Herdr pane response is missing a pane ID", { value });
  }

  return { paneId };
}

function normalizeAgentResult(value) {
  const agentId = extractId(value, ["agentId", "agent_id"])
    ?? extractId(value?.agent, ["agentId", "agent_id"]);
  const tabId = extractTabId(value);
  const paneId = extractPaneId(value);

  if (!agentId || !tabId || !paneId) {
    fail("HERDR", "Herdr agent response is missing required IDs", {
      value,
      agentId,
      tabId,
      paneId,
    });
  }

  return { agentId, tabId, paneId };
}

export function createHerdrAdapter({ runner, binary = "herdr" }) {
  async function invoke(area, command, args = [], { cwd } = {}) {
    const fullArgs = command ? [area, command, ...args] : [area, ...args];
    const result = await runner.run(binary, fullArgs, {
      allowFailure: true,
      ...(cwd ? { cwd } : {}),
    });

    return parseJsonResult(result, { binary, area, command, args, cwd });
  }

  return {
    async status({ target } = {}) {
      const args = [];
      if (target) args.push(String(target));
      args.push("--json");
      return await invoke("status", "", args);
    },

    async integrationStatus({ outdatedOnly = false } = {}) {
      const args = [];
      if (outdatedOnly) args.push("--outdated-only");
      return await invoke("integration", "status", args);
    },

    async listWorkspaces() {
      return await invoke("workspace", "list");
    },

    async getWorkspace({ workspaceId }) {
      return await invoke("workspace", "get", [workspaceId]);
    },

    async listTabs({ workspaceId }) {
      const args = [];
      pushOption(args, "--workspace", workspaceId);
      return await invoke("tab", "list", args);
    },

    async listPanes({ workspaceId }) {
      const args = [];
      pushOption(args, "--workspace", workspaceId);
      return await invoke("pane", "list", args);
    },

    async listAgents() {
      return await invoke("agent", "list");
    },

    async ensureNativeWorktree(operation) {
      const reconciliation = operation?.reconciliation ?? {};

      if (reconciliation.status === "open") {
        return normalizeWorktreeResult(reconciliation, "already_open");
      }

      if (reconciliation.status === "missing") {
        const args = [
          "--cwd",
          operation.cwd,
          "--branch",
          operation.branch,
          "--base",
          operation.base,
          "--path",
          operation.path,
          "--label",
          operation.label,
          "--json",
        ];
        const value = await invoke("worktree", "create", args, { cwd: operation.cwd });
        return normalizeWorktreeResult(value);
      }

      if (reconciliation.status === "closed") {
        const args = [
          "--cwd",
          operation.cwd,
          "--path",
          operation.path,
          "--label",
          operation.label,
          "--json",
        ];
        const value = await invoke("worktree", "open", args, { cwd: operation.cwd });
        return normalizeWorktreeResult(value);
      }

      fail("CONFLICT", "ensureNativeWorktree requires missing, closed, or open reconciliation", {
        operation,
        reconciliation,
      }, 11);
    },

    async createTab({ workspaceId, cwd, label, focus = false }) {
      const args = [];
      pushOption(args, "--workspace", workspaceId);
      pushOption(args, "--cwd", cwd);
      pushOption(args, "--label", label);
      pushFocus(args, focus);
      return normalizeTabResult(await invoke("tab", "create", args, { cwd }));
    },

    async renameTab({ tabId, label }) {
      return await invoke("tab", "rename", [tabId, label]);
    },

    async renamePane({ paneId, label }) {
      return await invoke("pane", "rename", [paneId, label]);
    },

    async splitPane({ paneId, direction, ratio, cwd, focus = false }) {
      const args = [paneId, "--direction", direction];
      pushOption(args, "--ratio", ratio);
      pushOption(args, "--cwd", cwd);
      pushFocus(args, focus);
      return normalizePaneResult(await invoke("pane", "split", args, { cwd }));
    },

    async runInPane({ paneId, command }) {
      if (typeof command !== "string" || !command.trim()) {
        fail("PREFLIGHT", "runInPane requires a trusted registry command string", { paneId, command }, 10);
      }
      return await invoke("pane", "run", [paneId, command]);
    },

    async startAgent({ name, cwd, workspaceId, tabId, split, argv, focus = false }) {
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value.length === 0)) {
        fail("PREFLIGHT", "startAgent requires argv from a trusted source", {
          name,
          cwd,
          workspaceId,
          tabId,
          split,
          argv,
        }, 10);
      }

      const args = [name];
      pushOption(args, "--cwd", cwd);
      pushOption(args, "--workspace", workspaceId);
      pushOption(args, "--tab", tabId);
      pushOption(args, "--split", split);
      pushFocus(args, focus);
      args.push("--", ...argv);

      return normalizeAgentResult(await invoke("agent", "start", args, { cwd }));
    },
  };
}
