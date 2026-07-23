import { WorkflowError } from "./errors.js";

function fail(category, message, options) {
  throw new WorkflowError(category, message, options);
}

export function resolveAgentProfile({ registry, project, requestedProfile } = {}) {
  const launcher = registry?.launcher;
  if (!launcher?.agent_profiles) {
    fail("schema", "Registry does not define launcher.agent_profiles");
  }

  const name = requestedProfile ?? project?.default_agent_profile ?? launcher.default_agent_profile;
  const source = requestedProfile ? "explicit" : project?.default_agent_profile ? "project" : "global";

  if (!name) {
    fail("lookup", "No workflow agent profile is configured", { exitCode: 2 });
  }

  const allowedProfiles = project?.allowed_agent_profiles;
  if (Array.isArray(allowedProfiles) && !allowedProfiles.includes(name)) {
    fail("lookup", `Agent profile ${name} is not allowed by project.allowed_agent_profiles`, {
      exitCode: 2,
      details: { name, project: project?.label ?? null },
    });
  }

  const profile = launcher.agent_profiles[name];
  if (!profile) {
    fail("lookup", `Unknown workflow agent profile: ${name}`, { exitCode: 2, details: { name } });
  }
  if (profile.availability === "fixture-only" && launcher.fixture_mode !== true) {
    fail("lookup", `Agent profile ${name} is fixture-only and cannot be selected outside a generated fixture registry`, {
      exitCode: 2,
      details: { name },
    });
  }

  return Object.freeze({ name, source, profile });
}
