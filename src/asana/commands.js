import { access, mkdir, writeFile } from "node:fs/promises";
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
