const value = (input, fallback = "-") => input === undefined || input === null || input === "" ? fallback : String(input);
const identity = (item) => `${value(item.name)}${item.email ? ` <${item.email}>` : ""} [${value(item.gid)}]`;
const list = (items) => items.length ? items.map(identity).join("\n") : "No results.";
const status = (task) => task.completed ? `completed${task.completed_at ? ` at ${task.completed_at}` : ""}` : "open";
const attachment = (item) => `${value(item.name)} [${value(item.gid)}] | ${value(item.host)}${item.view_url ? ` | ${item.view_url}` : item.permanent_url ? ` | ${item.permanent_url}` : ""}`;

function formatTriage(result) {
  const lines = [
    `Project: ${value(result.project.name, "project")} [${result.project.gid}]`,
    `Assignee filter: ${result.assignee}`,
    `Sections: ${result.sections.map((section) => section.name).join(", ") || "none"}`,
    `Tasks: ${result.tasks.length}`,
  ];
  for (const task of result.tasks) {
    const assignee = task.assignee ? `${value(task.assignee.name)} [${task.assignee.gid}]` : "unassigned";
    const timing = task.due_on ? `due ${task.due_on}` : task.due_at ? `due ${task.due_at}` : "no due date";
    const modified = task.modified_at ? `modified ${task.modified_at}` : "";
    lines.push(`${task.gid} | ${value(task.name)} | ${status(task)} | ${task.sectionNames.join(", ")} | ${assignee} | ${timing}${modified ? ` | ${modified}` : ""}${task.permalink_url ? ` | ${task.permalink_url}` : ""}`);
  }
  return lines.join("\n");
}

function addItems(lines, heading, items, render) {
  if (!items?.length) return;
  lines.push("", `## ${heading}`);
  for (const item of items) lines.push(`- ${render(item)}`);
}

function formatTaskFull(context) {
  const task = context.task;
  const lines = [`# ${value(task.name)} [${task.gid}]`];
  if (task.permalink_url) lines.push(task.permalink_url);
  lines.push("", "## Metadata", `Status: ${status(task)}`);
  lines.push(`Assignee: ${task.assignee ? identity(task.assignee) : "unassigned"}`);
  if (task.due_on || task.due_at) lines.push(`Due: ${task.due_on || task.due_at}`);
  if (task.parent) lines.push(`Parent: ${identity(task.parent)}`);
  if (task.projects?.length) lines.push(`Projects: ${task.projects.map(identity).join(", ")}`);
  const sections = (task.memberships ?? []).map((membership) => membership.section).filter(Boolean);
  if (sections.length) lines.push(`Sections: ${sections.map(identity).join(", ")}`);
  if (task.created_at) lines.push(`Created: ${task.created_at}`);
  if (task.modified_at) lines.push(`Modified: ${task.modified_at}`);
  if (task.notes) lines.push("", "## Description", task.notes);
  addItems(lines, "Custom fields", task.custom_fields, (field) => `${value(field.name)}: ${value(field.display_value)}`);
  addItems(lines, "Comments and stories", context.stories, (story) => {
    const author = story.created_by?.name || "Asana";
    return `${value(story.created_at)} | ${author} | ${value(story.text)}`;
  });
  addItems(lines, "Subtasks", context.subtasks, (item) => `${item.completed ? "[x]" : "[ ]"} ${value(item.name)} [${item.gid}]`);
  addItems(lines, "Dependencies", context.dependencies, (item) => `${value(item.name)} [${item.gid}]`);
  addItems(lines, "Dependents", context.dependents, (item) => `${value(item.name)} [${item.gid}]`);
  addItems(lines, "Attachments", context.attachments, attachment);
  return lines.join("\n");
}

export function formatResult(command, result, format = "compact") {
  if (format === "json") return JSON.stringify(result, null, 2);
  switch (command) {
    case "auth-status": return `Asana auth: ${result.configured ? `configured (${result.source})` : result.message}`;
    case "me": return identity(result);
    case "workspaces":
    case "projects":
    case "sections": return list(result);
    case "attachments": return result.length ? result.map(attachment).join("\n") : "No results.";
    case "triage": return formatTriage(result);
    case "task": return formatTaskFull({ task: result, stories: [], subtasks: [], dependencies: [], dependents: [], attachments: [] });
    case "task-full": return formatTaskFull(result);
    case "attachment-download": return `Downloaded ${result.name} [${result.gid}] to ${result.path} (${result.bytes} bytes)`;
    default: return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }
}
