import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTemplate, normalizeTask, slugify } from "../src/workflow/naming.js";
import { planWorkflow } from "../src/workflow/planner.js";

function hasFunctionDeep(value) {
  if (typeof value === "function") return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => hasFunctionDeep(item));
}

const registry = {
  launcher: {
    worktree_root: "/tmp/worktrees",
    state_root: "/tmp/workflow-state",
    session_template: "{project}-{task}-{slug}",
    default_agent_profile: "pi-worker",
    max_bundle_tickets: 10,
    agent: {
      command: "pi",
      session_template: "{project}-{task}-{slug}",
    },
    agent_profiles: {
      "pi-worker": {
        harness: "pi",
        command: "pi",
        mode: "interactive",
        roles: ["coordinator", "implementer"],
        model: null,
        arguments: [],
      },
      "codex-worker": {
        harness: "codex",
        command: "codex",
        mode: "interactive",
        roles: ["implementer", "reviewer"],
        model: "gpt-5-codex",
        arguments: ["--config", "ui=false"],
        sandbox: "workspace-write",
        approval_policy: "on-request",
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
      allowed_agent_profiles: ["pi-worker", "codex-worker"],
      worktree: {
        branch_template: "feature/{task}/{slug}",
        path_template: "{worktree_root}/{project}/{task}-{slug}",
      },
      runtime: {
        default_profile: "standard",
        profiles: {
          standard: {
            processes: [
              { id: "api", command: "pnpm dev:api", cwd: ".", split: "right" },
            ],
          },
          alt: {
            processes: [
              { id: "web", command: "pnpm dev:web" },
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
      allowed_agent_profiles: ["pi-worker", "codex-worker"],
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
        webapp: {
          path: "/repo/acme/acme_webapp",
          base_branch: "release",
          branch_template: "feature/{project}/{repository}/{slug}",
        },
      },
    },
  },
};

test("sanitizes user text before branch and path expansion", () => {
  assert.equal(slugify("Discovered Docs / Filters $(touch bad)"), "discovered-docs-filters-touch-bad");
  assert.equal(normalizeTask(" ASANA-123 "), "ASANA-123");
  assert.equal(
    expandTemplate("feature/{task}/{slug}", {
      task: "ASANA-123",
      slug: "discovered-docs",
      project: "ocr",
      worktree_root: "/tmp/worktrees",
    }),
    "feature/ASANA-123/discovered-docs",
  );
});

test("rejects supplied placeholders outside the allowlist", () => {
  assert.throws(
    () => expandTemplate("feature/{unknown}", { unknown: "safe" }),
    /unknown placeholder|unsupported placeholder|allowlist/i,
  );
});

test("rejects empty slugs and traversal values", () => {
  assert.throws(() => slugify("!!!"), /slug/i);
  assert.throws(() => expandTemplate("feature/{slug}", { slug: "../escape" }), /traversal|path/i);
  assert.throws(
    () => expandTemplate("feature/{slug}/{missing}", { slug: "safe" }),
    /placeholder|braces|unresolved/i,
  );
});

test("plans an ordinary native Herdr worktree", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "ocr",
    task: "ASANA-123",
    tickets: ["ASANA-152", "ASANA-140", "ASANA-140"],
    feature: "Discovered Docs",
  });

  assert.equal(plan.mode, "ordinary");
  assert.equal(plan.identity.task, "ASANA-123");
  assert.equal(plan.identity.primaryTicket, "ASANA-123");
  assert.deepEqual(plan.identity.relatedTickets, ["ASANA-140", "ASANA-152"]);
  assert.deepEqual(plan.identity.tickets, ["ASANA-123", "ASANA-140", "ASANA-152"]);
  assert.equal(plan.worktrees[0].branch, "feature/ASANA-123/discovered-docs");
  assert.equal(plan.agent.command, "pi");
  assert.equal(plan.agent.sessionName, "ocr-ASANA-123-discovered-docs");
  assert.equal(plan.agent.profileName, "pi-worker");
  assert.equal(plan.agent.selectionSource, "project");
  assert.equal(plan.agent.harness, "pi");
  assert.deepEqual(plan.agent.roles, ["coordinator", "implementer"]);
  assert.deepEqual(plan.agent.profile, {
    mode: "interactive",
    model: null,
    arguments: [],
  });
  assert.deepEqual(plan.tabs.map((tab) => tab.label), ["agent", "runtime"]);
  assert.ok(plan.workspace.label.length <= 32);
  assert.equal(plan.runtime.profileName, "standard");
  assert.ok(plan.operations.some((operation) => operation.phase === "runtime"));
});

test("ordinary plan is plain JSON-compatible data", () => {
  const plan = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const jsonRoundTrip = JSON.parse(JSON.stringify(plan));

  assert.deepEqual(jsonRoundTrip, plan);
  assert.equal(hasFunctionDeep(plan), false);
});

test("group plan is plain JSON-compatible data", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["webapp", "backend"],
  });
  const jsonRoundTrip = JSON.parse(JSON.stringify(plan));

  assert.deepEqual(jsonRoundTrip, plan);
  assert.equal(hasFunctionDeep(plan), false);
});

test("start-phase operations exclude runtime-only operations while runtime operations are marked runtime", () => {
  const ordinary = planWorkflow({ registry, projectAlias: "ocr", task: "ASANA-123", feature: "Discovered Docs" });
  const group = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["backend", "panel"],
  });

  assert.deepEqual(ordinary.operations.filter((operation) => operation.phase === "start").map((operation) => operation.id), [
    "worktree",
    "workspace",
    "agent-tab",
    "agent",
  ]);
  assert.deepEqual(ordinary.operations.filter((operation) => operation.phase === "runtime").map((operation) => operation.id), [
    "runtime-tab",
    "runtime",
  ]);
  assert.deepEqual(group.operations.filter((operation) => operation.phase === "start").map((operation) => operation.id), [
    "meta-worktree",
    "child-worktree:backend",
    "child-worktree:panel",
    "coordinator-tab",
    "child-tab:backend",
    "child-tab:panel",
    "agent",
  ]);
  assert.deepEqual(group.operations.filter((operation) => operation.phase === "runtime").map((operation) => operation.id), [
    "runtime-tab",
    "runtime",
  ]);
});

test("bounds Herdr-visible labels", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "A remarkably long feature title that should never spill across the sidebar",
  });

  assert.ok(plan.workspace.label.length <= 32);
  assert.match(plan.workspace.label, /^ASANA-123/);
});

test("resolves a requested runtime profile without rewriting trusted commands", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "ocr",
    task: "ASANA-123",
    feature: "Discovered Docs",
    runtimeProfile: "alt",
  });
  const runtimeTab = plan.tabs.find((tab) => tab.label === "runtime");

  assert.equal(plan.runtime.profileName, "alt");
  assert.equal(runtimeTab.profileName, "alt");
  assert.deepEqual(runtimeTab.processes.map((process) => process.command), ["pnpm dev:web"]);
  assert.doesNotMatch(JSON.stringify(runtimeTab.processes), /ASANA-123|Discovered Docs/);
});

test("resolves an explicit allowed agent profile without changing primary worktree identity", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "ocr",
    task: "ASANA-123",
    tickets: ["ASANA-150"],
    feature: "Discovered Docs",
    agentProfile: "codex-worker",
  });
  const agentOperation = plan.operations.find((operation) => operation.id === "agent");

  assert.equal(plan.agent.command, "codex");
  assert.equal(plan.agent.profileName, "codex-worker");
  assert.equal(plan.agent.harness, "codex");
  assert.deepEqual(plan.agent.roles, ["implementer", "reviewer"]);
  assert.deepEqual(plan.agent.profile, {
    mode: "interactive",
    model: "gpt-5-codex",
    arguments: ["--config", "ui=false"],
    sandbox: "workspace-write",
    approval_policy: "on-request",
  });
  assert.equal(agentOperation.kind, "agent.session.start");
  assert.equal(agentOperation.command, "codex");
  assert.equal(plan.identity.task, "ASANA-123");
  assert.equal(plan.worktrees[0].branch, "feature/ASANA-123/discovered-docs");
  assert.equal(plan.agent.sessionName, "ocr-ASANA-123-discovered-docs");
});

test("rejects missing Acme repository selection", () => {
  assert.throws(
    () => planWorkflow({ registry, projectAlias: "acme", task: "ASANA-456", feature: "Onboarding" }),
    /repositories/i,
  );
});

test("plans one selected Acme repository", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["webapp"],
  });

  assert.equal(plan.mode, "group");
  assert.deepEqual(plan.repositories.map((repo) => repo.alias), ["webapp"]);
  assert.equal(plan.repositories[0].baseBranch, "release");
  assert.equal(plan.repositories[0].branch, "feature/acme/webapp/onboarding");
  assert.match(plan.repositories[0].worktreePath, /repos\/webapp$/);
});

test("plans two selected Acme repositories in deterministic order", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["panel", "backend"],
  });

  assert.deepEqual(plan.repositories.map((repo) => repo.alias), ["backend", "panel"]);
  assert.deepEqual(plan.tabs.map((tab) => tab.label), ["coordinator", "backend", "panel", "runtime"]);
  assert.equal(plan.worktrees[0].branch, "ticket/ASANA-456/onboarding");
  assert.match(plan.worktrees[1].path, /repos\/backend$/);
  assert.match(plan.worktrees[2].path, /repos\/panel$/);
});

test("plans three selected Acme repositories with repository-specific branches", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    feature: "Onboarding",
    repositories: ["webapp", "panel", "backend"],
  });

  assert.deepEqual(plan.repositories.map((repo) => repo.alias), ["backend", "panel", "webapp"]);
  assert.equal(plan.repositories[2].baseBranch, "release");
  assert.equal(plan.repositories[2].branch, "feature/acme/webapp/onboarding");
  assert.match(plan.worktrees[3].path, /repos\/webapp$/);
});

test("related tickets do not change Acme worktree naming", () => {
  const plan = planWorkflow({
    registry,
    projectAlias: "acme",
    task: "ASANA-456",
    tickets: ["ASANA-499", "ASANA-460", "ASANA-460"],
    feature: "Onboarding",
    repositories: ["panel", "backend"],
  });

  assert.equal(plan.identity.task, "ASANA-456");
  assert.equal(plan.identity.primaryTicket, "ASANA-456");
  assert.deepEqual(plan.identity.relatedTickets, ["ASANA-460", "ASANA-499"]);
  assert.deepEqual(plan.identity.tickets, ["ASANA-456", "ASANA-460", "ASANA-499"]);
  assert.equal(plan.worktrees[0].branch, "ticket/ASANA-456/onboarding");
  assert.match(plan.workspace.path, /ASANA-456-onboarding$/);
  assert.deepEqual(plan.repositories.map((repo) => repo.alias), ["backend", "panel"]);
});

test("rejects unknown Acme repository aliases", () => {
  assert.throws(
    () => planWorkflow({
      registry,
      projectAlias: "acme",
      task: "ASANA-456",
      feature: "Onboarding",
      repositories: ["backend", "missing"],
    }),
    /Unknown workflow repository/i,
  );
});
