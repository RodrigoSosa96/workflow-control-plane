import { WorkflowError } from "./errors.js";

const WORKFLOW_ENV_KEYS = new Set([
  "WORKFLOW_RUN_ID",
  "WORKFLOW_RUN_DIR",
  "WORKFLOW_GENERATION",
  "WORKFLOW_HARNESS",
  "WORKFLOW_STATE_ROOT",
  "WORKFLOW_CONTROL_PLANE_BIN",
]);

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

// Herdr writes its JSON error envelope to stderr, so a failed command usually leaves stdout empty.
function extractStderrEnvelope(stderr) {
  const trimmed = stderr?.trim();
  if (!trimmed) return null;

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const error = payload?.error ?? (payload?.ok === false ? payload : null);
  if (!error || typeof error !== "object") return null;
  return error;
}

function parseJsonResult(result, context) {
  const stdout = result.stdout?.trim() ?? "";

  if (!stdout) {
    if (result.code && result.code !== 0) {
      const envelope = extractStderrEnvelope(result.stderr);
      fail(
        "HERDR",
        envelope?.message
          ?? `${context.binary} ${context.area} ${context.command} failed with exit code ${result.code}`,
        {
          ...(envelope?.code ? { code: envelope.code } : {}),
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

function parseIntegrationStatusResult(result, context) {
  const stdout = result.stdout ?? "";
  const trimmed = stdout.trim();

  if (!trimmed) {
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
    return [];
  }

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

  return trimmed.split(/\r?\n/).filter(Boolean).map((rawLine) => {
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator <= 0) {
      fail("HERDR", "Malformed Herdr integration status line", { line, stdout: result.stdout });
    }

    const name = line.slice(0, separator).trim();
    let rest = line.slice(separator + 1).trim();
    if (!name || !rest) {
      fail("HERDR", "Malformed Herdr integration status line", { line, stdout: result.stdout });
    }

    let path;
    const pathMatch = rest.match(/\(([^()]*)\)$/);
    if (pathMatch) {
      path = pathMatch[1];
      rest = rest.slice(0, pathMatch.index).trim();
    }

    let version;
    const versionMatch = rest.match(/\(v(\d+)\)$/);
    if (versionMatch) {
      version = Number.parseInt(versionMatch[1], 10);
      rest = rest.slice(0, versionMatch.index).trim();
    }

    const status = rest.trim();
    if (!status) {
      fail("HERDR", "Malformed Herdr integration status line", { line, stdout: result.stdout });
    }

    return {
      name,
      status,
      ...(version === undefined ? {} : { version }),
      ...(path ? { path } : {}),
    };
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pushOption(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function pushFocus(args, focus = false) {
  args.push(focus ? "--focus" : "--no-focus");
}

function normalizeWorkflowEnv(env = {}) {
  if (env === undefined || env === null) return [];
  if (typeof env !== "object" || Array.isArray(env)) {
    fail("PREFLIGHT", "workflow env must be a workflow env object", { env }, 10);
  }

  const entries = [];
  for (const [key, value] of Object.entries(env)) {
    if (!WORKFLOW_ENV_KEYS.has(key)) {
      fail("PREFLIGHT", `workflow env contains non-workflow key ${key}`, { key }, 10);
    }
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      fail("PREFLIGHT", `workflow env ${key} must be a non-empty string`, { key }, 10);
    }
    entries.push(`${key}=${value}`);
  }
  return entries;
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
    ?? extractId(value?.agent, ["agentId", "agent_id"])
    ?? null;
  const tabId = extractTabId(value)
    ?? extractTabId(value?.agent);
  const paneId = extractPaneId(value)
    ?? extractPaneId(value?.agent);

  if (!tabId || !paneId) {
    fail("HERDR", "Herdr agent response is missing required IDs", {
      value,
      agentId,
      tabId,
      paneId,
    });
  }

  return { agentId, tabId, paneId };
}

function normalizePaneProcessInfo(value) {
  if (value === null || value === undefined) return null;

  const processInfo = value?.process ?? value?.process_info ?? value;
  const foregroundProcess = Array.isArray(processInfo?.foreground_processes) && processInfo.foreground_processes.length > 0
    ? processInfo.foreground_processes[0]
    : null;

  if (!foregroundProcess) return processInfo;

  const argv = Array.isArray(foregroundProcess.argv) ? foregroundProcess.argv : undefined;
  const command = foregroundProcess.command
    ?? foregroundProcess.command_line
    ?? foregroundProcess.cmdline
    ?? (argv?.length ? argv.join(" ") : undefined);
  const executable = foregroundProcess.executable
    ?? foregroundProcess.exe
    ?? foregroundProcess.binary
    ?? (argv?.length ? argv[0] : undefined);

  return {
    ...processInfo,
    ...foregroundProcess,
    running: processInfo.running ?? foregroundProcess.running ?? true,
    ...(executable ? { executable } : {}),
    ...(command ? { command } : {}),
  };
}

// `pane split` returns before the new pane reaches its interactive shell prompt, and
// `agent start` rejects an unready pane outright rather than waiting for it.
const PANE_READY_TIMEOUT_MS = 10000;
const PANE_READY_POLL_MS = 250;

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function createHerdrAdapter({ runner, binary = "herdr", sleep = defaultSleep }) {
  async function run(area, command, args = [], { cwd } = {}) {
    const fullArgs = command ? [area, command, ...args] : [area, ...args];
    const result = await runner.run(binary, fullArgs, {
      allowFailure: true,
      ...(cwd ? { cwd } : {}),
    });

    return {
      result,
      context: { binary, area, command, args, cwd },
    };
  }

  async function invoke(area, command, args = [], options) {
    const { result, context } = await run(area, command, args, options);
    return parseJsonResult(result, context);
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
      const { result, context } = await run("integration", "status", args);
      return parseIntegrationStatusResult(result, context);
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
        const args = [];
        pushOption(args, "--cwd", operation.cwd);
        pushOption(args, "--branch", operation.branch);
        pushOption(args, "--base", operation.base);
        pushOption(args, "--path", operation.path);
        pushOption(args, "--label", operation.label);
        args.push("--json");
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

    async splitPane({ paneId, direction, ratio, cwd, env, focus = false }) {
      const args = [paneId, "--direction", direction];
      pushOption(args, "--ratio", ratio);
      pushOption(args, "--cwd", cwd);
      for (const entry of normalizeWorkflowEnv(env)) {
        args.push("--env", entry);
      }
      pushFocus(args, focus);
      return normalizePaneResult(await invoke("pane", "split", args, { cwd }));
    },

    // `pane run` types its command into the pane's shell rather than executing argv
    // directly, so each element is quoted to survive word splitting and globbing.
    async runInPane({ paneId, command, argv }) {
      if (argv !== undefined) {
        if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value.length === 0)) {
          fail("PREFLIGHT", "runInPane requires argv from a trusted source", { paneId, argv }, 10);
        }
        if (typeof paneId !== "string" || !paneId) {
          fail("PREFLIGHT", "runInPane requires a pane ID", { paneId }, 10);
        }
        return await invoke("pane", "run", [paneId, argv.map(shellQuote).join(" ")]);
      }
      if (typeof command !== "string" || !command.trim()) {
        fail("PREFLIGHT", "runInPane requires a trusted registry command string", { paneId, command }, 10);
      }
      return await invoke("pane", "run", [paneId, command]);
    },

    async getPaneProcessInfo(paneId) {
      if (typeof paneId !== "string" || !paneId) {
        fail("PREFLIGHT", "getPaneProcessInfo requires a pane ID string", { paneId }, 10);
      }
      return normalizePaneProcessInfo(await invoke("pane", "process-info", ["--pane", paneId]));
    },

    // Herdr types the canonical executable for --kind itself, so argv[0] is dropped and only
    // the remaining arguments are passed after --. `agent start` has no focus flag.
    async startAgent({ name, paneId, kind, argv, timeout, paneReadyTimeout = PANE_READY_TIMEOUT_MS } = {}) {
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value.length === 0)) {
        fail("PREFLIGHT", "startAgent requires argv from a trusted source", { name, paneId, kind, argv }, 10);
      }
      if (typeof paneId !== "string" || !paneId) {
        fail("PREFLIGHT", "startAgent requires a pane ID", { name, paneId, kind }, 10);
      }
      if (typeof kind !== "string" || !kind) {
        fail("PREFLIGHT", "startAgent requires an agent kind", { name, paneId, kind }, 10);
      }

      const executable = argv[0].slice(argv[0].lastIndexOf("/") + 1);
      if (executable !== kind) {
        fail(
          "PREFLIGHT",
          `startAgent argv executable ${executable} does not match the agent kind ${kind}`,
          { name, paneId, kind, executable },
          10,
        );
      }

      const args = [name];
      pushOption(args, "--kind", kind);
      pushOption(args, "--pane", paneId);
      pushOption(args, "--timeout", timeout);
      args.push("--", ...argv.slice(1));

      let waited = 0;
      for (;;) {
        try {
          return normalizeAgentResult(await invoke("agent", "start", args));
        } catch (error) {
          if (error?.details?.code !== "agent_pane_busy" || waited >= paneReadyTimeout) throw error;
          await sleep(PANE_READY_POLL_MS);
          waited += PANE_READY_POLL_MS;
        }
      }
    },

    // Herdr's exit key syntax is `ctrl+d`, not tmux-style `C-d` — the caller supplies the
    // probed key strings verbatim and this only validates shape, not key syntax.
    async agentSendKeys({ target, keys } = {}) {
      if (typeof target !== "string" || !target) {
        fail("PREFLIGHT", "agentSendKeys requires a target id", { target }, 10);
      }
      if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== "string" || !k)) {
        fail("PREFLIGHT", "agentSendKeys requires non-empty key strings", { target, keys }, 10);
      }
      return await invoke("agent", "send-keys", [target, ...keys]);
    },

    // `pane send-text` types literal text into the pane (no key translation), so it is the
    // way to enter a slash command like `/exit` verbatim. Unlike `agent send-keys`, it does
    // not submit — the caller sends `enter` separately. Only shape is validated here.
    async sendText({ paneId, text } = {}) {
      if (typeof paneId !== "string" || !paneId) {
        fail("PREFLIGHT", "sendText requires a pane ID", { paneId }, 10);
      }
      if (typeof text !== "string") {
        fail("PREFLIGHT", "sendText requires text as a string", { paneId, text }, 10);
      }
      return await invoke("pane", "send-text", [paneId, text]);
    },

    // Focus a specific agent by its target (the pane id, same target `agent send-keys` takes).
    // `agent focus` brings the agent's OWN pane forward — unlike `tab focus`, which only raises
    // the tab and leaves the retained bootstrap shell pane (above Pi) as the active pane.
    // `pane focus` is directional (next/prev) and cannot target a pane by id, so it is not used.
    async focusAgent({ target } = {}) {
      if (typeof target !== "string" || !target) {
        fail("PREFLIGHT", "focusAgent requires an agent target", { target }, 10);
      }
      return await invoke("agent", "focus", [target]);
    },

    // Best-effort, idempotent tab closure. `herdr tab close <tab_id>` takes the id as a
    // POSITIONAL, like `tab rename` and `tab focus`, not as an option.
    //
    // This one reports instead of throwing, and that is deliberate rather than a style choice: its
    // caller runs it AFTER worktree removals that cannot be undone by re-running, so a throw here
    // would discard the report of removals that really happened. Every branch therefore returns a
    // result -- including the caller bug of asking to close a tab that was never recorded.
    //
    // `tab_not_found` is the COMMON case, not an edge one: measured on this machine, every recorded
    // tabId is already stale because the Herdr server has been restarted since those runs launched.
    // It means *already archived*, so it is reported as `not-found` and must never be confused with
    // a real failure -- an unreachable server, or a tab id we never even sent, is not proof that a
    // tab is gone.
    async closeTab({ tabId } = {}) {
      if (typeof tabId !== "string" || !tabId) {
        return { closed: false, reason: "closeTab requires a tab id" };
      }

      try {
        await invoke("tab", "close", [tabId]);
        return { closed: true };
      } catch (error) {
        if (error?.details?.code === "tab_not_found") {
          return { closed: false, reason: "not-found" };
        }
        return { closed: false, reason: String(error?.message ?? error).slice(0, 256) };
      }
    },

    // Kept as a fallback for callers that only hold a tab id; prefer focusAgent, which focuses
    // the agent's pane rather than just raising the tab.
    async focusTab({ tabId } = {}) {
      if (typeof tabId !== "string" || !tabId) {
        fail("PREFLIGHT", "focusTab requires a tab id", { tabId }, 10);
      }
      return await invoke("tab", "focus", [tabId]);
    },
  };
}
