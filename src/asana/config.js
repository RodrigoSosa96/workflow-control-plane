import { readFile } from "node:fs/promises";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadProjectConfig(path) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Unable to load Asana project configuration at ${path}: ${error.message}`);
  }
  if (config?.version !== 1 || !config.projects || typeof config.projects !== "object") {
    throw new ConfigError("Asana project configuration must use version 1 and contain a projects object.");
  }
  return config;
}

export function resolveProjectBinding(config, aliasOrGid) {
  if (/^\d+$/.test(aliasOrGid)) return { projectGid: aliasOrGid, activeSections: [] };
  const binding = config.projects[aliasOrGid];
  if (!binding) throw new ConfigError(`Unknown Asana project alias: ${aliasOrGid}`);
  if (!binding.projectGid && !binding.projectName) {
    throw new ConfigError(`Asana project alias '${aliasOrGid}' is not bound. Run 'asana-workflow projects', then add projectGid or projectName to config/asana-projects.json.`);
  }
  return { ...binding, activeSections: binding.activeSections ?? [] };
}
