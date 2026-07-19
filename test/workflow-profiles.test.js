import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgentProfile, validateRegistry } from "../src/workflow/registry.js";
import { resolveAgentProfile } from "../src/workflow/profiles.js";

function registryValue() {
  return {
    version: 3,
    launcher: {
      worktree_root: "/tmp/worktrees",
      state_root: "/tmp/workflow-state",
      session_template: "{project}-{task}-{slug}",
      default_agent_profile: "pi-worker",
      max_bundle_tickets: 10,
      agent_profiles: {
        "pi-worker": { harness: "pi", command: "pi", mode: "interactive", roles: ["implementer"], arguments: [] },
        "claude-worker": { harness: "claude", command: "claude", mode: "interactive", roles: ["implementer"], permission_mode: "manual", arguments: [] },
        "codex-worker": { harness: "codex", command: "codex", mode: "interactive", roles: ["implementer"], sandbox: "workspace-write", approval_policy: "on-request", arguments: [] },
      },
    },
    projects: {
      app: {
        label: "App",
        kind: "personal",
        path: "/repo/app",
        repository: "single",
        base_branch: "main",
        default_agent_profile: "pi-worker",
        allowed_agent_profiles: ["pi-worker", "codex-worker"],
        worktree: {
          branch_template: "feature/{task}/{slug}",
          path_template: "{worktree_root}/{project}/{task}-{slug}",
        },
      },
    },
  };
}

test("explicit allowed profile wins over project and global defaults", () => {
  const registry = validateRegistry(registryValue());
  assert.deepEqual(resolveAgentProfile({ registry, project: registry.projects.app, requestedProfile: "codex-worker" }), {
    name: "codex-worker",
    source: "explicit",
    profile: registry.launcher.agent_profiles["codex-worker"],
  });
});

test("falls back through project and global defaults with frozen registry-owned profiles", () => {
  const registry = validateRegistry(registryValue());
  const projectDefault = resolveAgentProfile({ registry, project: registry.projects.app });
  assert.equal(projectDefault.name, "pi-worker");
  assert.equal(projectDefault.source, "project");
  assert.equal(projectDefault.profile, registry.launcher.agent_profiles["pi-worker"]);
  assert.equal(Object.isFrozen(projectDefault.profile), true);
  assert.throws(() => {
    projectDefault.profile.command = "changed";
  }, TypeError);

  const globalValue = registryValue();
  delete globalValue.projects.app.default_agent_profile;
  globalValue.projects.app.allowed_agent_profiles = ["pi-worker"];
  const globalRegistry = validateRegistry(globalValue);
  assert.deepEqual(resolveAgentProfile({ registry: globalRegistry, project: globalRegistry.projects.app }), {
    name: "pi-worker",
    source: "global",
    profile: globalRegistry.launcher.agent_profiles["pi-worker"],
  });
});

test("rejects dangerous Claude and Codex profiles", () => {
  const claude = registryValue();
  claude.launcher.agent_profiles["claude-worker"].arguments = ["--dangerously-skip-permissions"];
  assert.throws(() => validateRegistry(claude), /dangerously-skip-permissions/i);

  const codex = registryValue();
  codex.launcher.agent_profiles["codex-worker"].sandbox = "danger-full-access";
  assert.throws(() => validateRegistry(codex), /danger-full-access/i);
});

test("validateAgentProfile rejects unknown harnesses and profile fields", () => {
  assert.throws(() => validateAgentProfile("custom-worker", {
    harness: "cursor",
    command: "cursor",
    mode: "interactive",
    roles: ["implementer"],
    arguments: [],
  }), /harness.*cursor/i);

  assert.throws(() => validateAgentProfile("pi-worker", {
    harness: "pi",
    command: "pi",
    mode: "interactive",
    roles: ["implementer"],
    arguments: [],
    extra_field: true,
  }), /extra_field/i);
});

test("validateAgentProfile requires non-empty roles and argv-safe string arguments", () => {
  assert.throws(() => validateAgentProfile("pi-worker", {
    harness: "pi",
    command: "pi",
    mode: "interactive",
    roles: [],
    arguments: [],
  }), /roles/i);

  assert.throws(() => validateAgentProfile("pi-worker", {
    harness: "pi",
    command: "pi",
    mode: "interactive",
    roles: ["implementer"],
    arguments: ["--safe", 1],
  }), /arguments.*string/i);
});

test("rejects permission and sandbox bypass shortcuts", () => {
  const bypassField = registryValue();
  bypassField.launcher.agent_profiles["claude-worker"].bypassPermissions = true;
  assert.throws(() => validateRegistry(bypassField), /bypassPermissions/i);

  const allowSkip = registryValue();
  allowSkip.launcher.agent_profiles["claude-worker"].arguments = ["--allow-dangerously-skip-permissions"];
  assert.throws(() => validateRegistry(allowSkip), /allow-dangerously-skip-permissions/i);

  const permissionModeOverride = registryValue();
  permissionModeOverride.launcher.agent_profiles["claude-worker"].arguments = ["--permission-mode=bypassPermissions"];
  assert.throws(() => validateRegistry(permissionModeOverride), /permission-mode|bypasspermissions/i);

  const sandboxEqualsOverride = registryValue();
  sandboxEqualsOverride.launcher.agent_profiles["codex-worker"].arguments = ["--sandbox=danger-full-access"];
  assert.throws(() => validateRegistry(sandboxEqualsOverride), /sandbox|danger-full-access/i);

  const sandboxShortOverride = registryValue();
  sandboxShortOverride.launcher.agent_profiles["codex-worker"].arguments = ["-s", "danger-full-access"];
  assert.throws(() => validateRegistry(sandboxShortOverride), /sandbox|danger-full-access/i);

  const configSandboxOverride = registryValue();
  configSandboxOverride.launcher.agent_profiles["codex-worker"].arguments = ["-c", 'sandbox = "danger-full-access"'];
  assert.throws(() => validateRegistry(configSandboxOverride), /config|sandbox|danger-full-access/i);

  const approvalOverride = registryValue();
  approvalOverride.launcher.agent_profiles["codex-worker"].arguments = ["--ask-for-approval=never"];
  assert.throws(() => validateRegistry(approvalOverride), /ask-for-approval|approval|never/i);

  const shortApprovalOverride = registryValue();
  shortApprovalOverride.launcher.agent_profiles["codex-worker"].arguments = ["-a", "never"];
  assert.throws(() => validateRegistry(shortApprovalOverride), /approval|never/i);

  const attachedShortApprovalOverride = registryValue();
  attachedShortApprovalOverride.launcher.agent_profiles["codex-worker"].arguments = ["-anever"];
  assert.throws(() => validateRegistry(attachedShortApprovalOverride), /approval|never/i);

  const shortProfileOverride = registryValue();
  shortProfileOverride.launcher.agent_profiles["codex-worker"].arguments = ["-p", "unsafe-profile"];
  assert.throws(() => validateRegistry(shortProfileOverride), /profile|unsafe-profile/i);

  const attachedShortProfileOverride = registryValue();
  attachedShortProfileOverride.launcher.agent_profiles["codex-worker"].arguments = ["-punsafe-profile"];
  assert.throws(() => validateRegistry(attachedShortProfileOverride), /profile|unsafe-profile/i);

  const profileEqualsOverride = registryValue();
  profileEqualsOverride.launcher.agent_profiles["codex-worker"].arguments = ["--profile=unsafe-profile"];
  assert.throws(() => validateRegistry(profileEqualsOverride), /profile|unsafe-profile/i);

  const attachedShortSandboxOverride = registryValue();
  attachedShortSandboxOverride.launcher.agent_profiles["codex-worker"].arguments = ["-sdanger-full-access"];
  assert.throws(() => validateRegistry(attachedShortSandboxOverride), /sandbox|danger-full-access/i);

  const attachedShortConfigSandboxOverride = registryValue();
  attachedShortConfigSandboxOverride.launcher.agent_profiles["codex-worker"].arguments = ['-csandbox = "danger-full-access"'];
  assert.throws(() => validateRegistry(attachedShortConfigSandboxOverride), /config|sandbox|danger-full-access/i);

  const configApprovalOverride = registryValue();
  configApprovalOverride.launcher.agent_profiles["codex-worker"].arguments = ["-c", 'approval_policy = "never"'];
  assert.throws(() => validateRegistry(configApprovalOverride), /config|approval|never/i);

  const never = registryValue();
  never.launcher.agent_profiles["codex-worker"].approval_policy = "never";
  assert.throws(() => validateRegistry(never), /approval_policy.*never|never.*approval/i);

  const bypassBoth = registryValue();
  bypassBoth.launcher.agent_profiles["codex-worker"].arguments = ["--dangerously-bypass-approvals-and-sandbox"];
  assert.throws(() => validateRegistry(bypassBoth), /dangerously-bypass-approvals-and-sandbox/i);

  const bypassHookTrust = registryValue();
  bypassHookTrust.launcher.agent_profiles["codex-worker"].arguments = ["--dangerously-bypass-hook-trust"];
  assert.throws(() => validateRegistry(bypassHookTrust), /dangerously-bypass-hook-trust/i);
});

test("preserves non-security profile arguments", () => {
  assert.deepEqual(validateAgentProfile("pi-worker", {
    harness: "pi",
    command: "pi",
    mode: "interactive",
    roles: ["implementer"],
    arguments: ["--plain-output", "session"],
  }).arguments, ["--plain-output", "session"]);
});

test("rejects project allowlist violations and invalid defaults", () => {
  const registry = validateRegistry(registryValue());
  assert.throws(
    () => resolveAgentProfile({ registry, project: registry.projects.app, requestedProfile: "claude-worker" }),
    /allowed_agent_profiles|not allowed/i,
  );

  const invalidAllowed = registryValue();
  invalidAllowed.projects.app.allowed_agent_profiles = ["pi-worker", "missing-worker"];
  assert.throws(() => validateRegistry(invalidAllowed), /allowed_agent_profiles.*missing-worker/i);

  const invalidProjectDefault = registryValue();
  invalidProjectDefault.projects.app.default_agent_profile = "claude-worker";
  assert.throws(() => validateRegistry(invalidProjectDefault), /default_agent_profile.*claude-worker.*allowed|allowed.*claude-worker/i);

  const invalidGlobalDefault = registryValue();
  invalidGlobalDefault.launcher.default_agent_profile = "missing-worker";
  assert.throws(() => validateRegistry(invalidGlobalDefault), /default_agent_profile.*missing-worker/i);

  const disallowedGlobalFallback = registryValue();
  delete disallowedGlobalFallback.projects.app.default_agent_profile;
  disallowedGlobalFallback.projects.app.allowed_agent_profiles = ["codex-worker"];
  assert.throws(() => validateRegistry(disallowedGlobalFallback), /default_agent_profile.*allowed|allowed_agent_profiles/i);
});
