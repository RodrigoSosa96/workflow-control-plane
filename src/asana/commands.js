import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandError";
  }
}

export async function resolveProject(client, binding) {
  if (binding.projectGid) return { gid: binding.projectGid };
  let projects;
  if (binding.workspaceGid) projects = await client.projects(binding.workspaceGid);
  else {
    const user = await client.me();
    const groups = await Promise.all((user.workspaces ?? []).map((workspace) => client.projects(workspace.gid)));
    projects = groups.flat();
  }
  const target = binding.projectName.toLocaleLowerCase();
  const matches = projects.filter((project) => project.name?.toLocaleLowerCase() === target);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new CommandError(`Asana project named '${binding.projectName}' was not found.`);
  throw new CommandError(`Asana project name '${binding.projectName}' is ambiguous: ${matches.map((item) => `${item.name} (${item.gid})`).join(", ")}`);
}

export async function triageProject(client, project, { sectionNames = [], assignee = "me" } = {}) {
  const allSections = await client.sections(project.gid);
  const requested = sectionNames.map((name) => name.toLocaleLowerCase());
  const sections = requested.length === 0
    ? allSections
    : allSections.filter((section) => requested.includes(section.name.toLocaleLowerCase()));
  if (requested.length > 0) {
    const found = new Set(sections.map((section) => section.name.toLocaleLowerCase()));
    const missing = sectionNames.filter((name) => !found.has(name.toLocaleLowerCase()));
    if (missing.length) throw new CommandError(`Asana sections not found in project ${project.gid}: ${missing.join(", ")}`);
  }

  let assigneeGid = assignee;
  let identity;
  if (assignee === "me") {
    identity = await client.me();
    assigneeGid = identity.gid;
  }

  const taskLists = await Promise.all(sections.map((section) => client.sectionTasks(section.gid)));
  const tasksByGid = new Map();
  taskLists.forEach((tasks, index) => {
    const section = sections[index];
    for (const task of tasks) {
      if (assignee !== "any" && task.assignee?.gid !== assigneeGid) continue;
      const current = tasksByGid.get(task.gid);
      if (current) {
        if (!current.sectionNames.includes(section.name)) current.sectionNames.push(section.name);
      } else {
        tasksByGid.set(task.gid, { ...task, sectionNames: [section.name] });
      }
    }
  });

  return { project, identity, assignee, sections, tasks: [...tasksByGid.values()] };
}

export async function getFullTaskContext(client, gid) {
  const [task, stories, subtasks, dependencies, dependents, attachments] = await Promise.all([
    client.task(gid), client.stories(gid), client.subtasks(gid), client.dependencies(gid),
    client.dependents(gid), client.attachments(gid),
  ]);
  return { task, stories, subtasks, dependencies, dependents, attachments };
}

export async function resolveSectionByName(client, projectGid, name) {
  const sections = await client.sections(projectGid);
  const target = name.toLocaleLowerCase();
  const matches = sections.filter((section) => section.name?.toLocaleLowerCase() === target);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new CommandError(`Asana section '${name}' was not found in project ${projectGid}.`);
  throw new CommandError(`Asana section name '${name}' is ambiguous in project ${projectGid}: ${matches.map((section) => `${section.name} (${section.gid})`).join(", ")}`);
}

const dryRun = (action, details) => ({ dryRun: true, action, details });

async function resolveAssignee(client, assignee) {
  if (assignee !== "me") return assignee;
  return (await client.me()).gid;
}

export async function createTaskCommand(client, input, { confirm = false } = {}) {
  const section = input.section ? await resolveSectionByName(client, input.project.gid, input.section) : undefined;
  const assignee = input.assignee === undefined ? undefined : await resolveAssignee(client, input.assignee);
  const fields = {
    projects: [input.project.gid],
    name: input.name,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(input.dueOn !== undefined ? { due_on: input.dueOn } : {}),
  };
  const details = {
    project: input.project.gid,
    name: input.name,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(section ? { section: `${section.name} [${section.gid}]` } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(input.dueOn !== undefined ? { due_on: input.dueOn } : {}),
  };
  if (!confirm) return dryRun("create task", details);
  const task = await client.createTask(fields);
  if (section) await client.addTaskToSection(section.gid, task.gid);
  return { applied: true, action: "create task", task, ...(section ? { section } : {}) };
}

export async function updateTaskCommand(client, gid, input, { confirm = false } = {}) {
  const assignee = input.assignee === undefined ? undefined : await resolveAssignee(client, input.assignee);
  const fields = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(assignee !== undefined ? { assignee: assignee === "none" ? null : assignee } : {}),
    ...(input.dueOn !== undefined ? { due_on: input.dueOn === "none" ? null : input.dueOn } : {}),
    ...(input.completed !== undefined ? { completed: input.completed } : {}),
  };
  if (!confirm) return dryRun("update task", { task: gid, ...fields });
  const task = await client.updateTask(gid, fields);
  return { applied: true, action: "update task", task };
}

export async function commentTaskCommand(client, gid, text, { confirm = false } = {}) {
  if (!confirm) return dryRun("add comment", { task: gid, text });
  const story = await client.addStory(gid, text);
  return { applied: true, action: "add comment", taskGid: gid, story };
}

export async function moveTaskCommand(client, gid, input, { confirm = false } = {}) {
  const section = await resolveSectionByName(client, input.project.gid, input.section);
  const details = { task: gid, project: input.project.gid, section: `${section.name} [${section.gid}]` };
  if (!confirm) return dryRun("move task", details);
  await client.addTaskToSection(section.gid, gid);
  return { applied: true, action: "move task", taskGid: gid, projectGid: input.project.gid, section };
}

export async function createProjectCommand(client, input, { confirm = false } = {}) {
  const details = { workspace: input.workspaceGid, name: input.name, sections: input.sections };
  if (!confirm) return dryRun("create project", details);
  const project = await client.createProject({
    workspace: input.workspaceGid,
    name: input.name,
    default_view: "board",
    public: true,
  });
  const sections = [];
  for (const name of input.sections) sections.push(await client.createSection(project.gid, name));
  return { applied: true, action: "create project", project, sections };
}

export async function registerProjectAlias(
  configPath,
  alias,
  projectGid,
  { readFileImpl = readFile, writeFileImpl = writeFile } = {},
) {
  if (!/^[\p{L}\p{N}._-]+$/u.test(alias || "")) throw new CommandError("Alias must be a valid Asana project alias.");
  let config;
  try {
    config = JSON.parse(await readFileImpl(configPath, "utf8"));
  } catch (error) {
    throw new CommandError(`Unable to load Asana project configuration at ${configPath}: ${error.message}`);
  }
  if (config?.version !== 1 || !config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)) {
    throw new CommandError("Asana project configuration must use version 1 and contain a projects object.");
  }
  if (Object.hasOwn(config.projects, alias)) throw new CommandError(`Asana project alias '${alias}' already exists.`);
  config.projects[alias] = { projectGid };
  try {
    await writeFileImpl(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new CommandError(`Unable to write Asana project configuration at ${configPath}: ${error.message}`);
  }
  return { alias, projectGid, configPath };
}

export async function downloadAttachmentFile(
  client,
  gid,
  output,
  { accessImpl = access, mkdirImpl = mkdir, writeFileImpl = writeFile } = {},
) {
  try {
    await accessImpl(output);
    throw new CommandError(`Output file already exists: ${output}`);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (error?.code !== "ENOENT") throw new CommandError(`Unable to inspect output path ${output}: ${error.message}`);
  }
  const download = await client.downloadAttachment(gid);
  await mkdirImpl(dirname(output), { recursive: true });
  try {
    await writeFileImpl(output, download.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new CommandError(`Output file already exists: ${output}`);
    throw new CommandError(`Unable to write attachment to ${output}: ${error.message}`);
  }
  return { gid, name: download.name, path: output, contentType: download.contentType, bytes: download.bytes.length };
}
