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
  if (task.html_notes && task.html_notes !== task.notes) lines.push("", "## HTML description and links", task.html_notes);
  addItems(lines, "Custom fields", task.custom_fields, (field) => `${value(field.name)}: ${value(field.display_value)}`);
  addItems(lines, "Comments and stories", context.stories, (story) => {
    const author = story.created_by?.name || "Asana";
    const richText = story.html_text && story.html_text !== story.text ? ` | HTML: ${story.html_text}` : "";
    return `${value(story.created_at)} | ${author} | ${value(story.text)}${richText}`;
  });
  addItems(lines, "Subtasks", context.subtasks, (item) => `${item.completed ? "[x]" : "[ ]"} ${value(item.name)} [${item.gid}]`);
  addItems(lines, "Dependencies", context.dependencies, (item) => `${item.completed ? "[x]" : "[ ]"} ${value(item.name)} [${item.gid}]`);
  addItems(lines, "Dependents", context.dependents, (item) => `${item.completed ? "[x]" : "[ ]"} ${value(item.name)} [${item.gid}]`);
  addItems(lines, "Attachments", context.attachments, attachment);
  return lines.join("\n");
}

function mutationValue(input) {
  if (input === null) return "none";
  if (Array.isArray(input)) return input.join(", ");
  if (typeof input === "object") return JSON.stringify(input);
  return value(input);
}

function formatMutation(result) {
  if (result.dryRun) {
    const lines = [`DRY RUN: ${result.action}`];
    for (const [key, item] of Object.entries(result.details ?? {})) lines.push(`  ${key}: ${mutationValue(item)}`);
    lines.push("Re-run with --confirm to apply.");
    return lines.join("\n");
  }

  const lines = [`Applied: ${result.action}`];
  if (result.task) {
    lines.push(`Task: ${value(result.task.name)} [${value(result.task.gid)}]`);
    if (result.task.permalink_url) lines.push(result.task.permalink_url);
  }
  if (result.story) lines.push(`Comment [${value(result.story.gid)}] added to task [${value(result.taskGid)}]`);
  if (result.action === "move task" && result.section) {
    lines.push(`Task [${value(result.taskGid)}] moved to section ${value(result.section.name)} [${value(result.section.gid)}]`);
  } else if (result.section) lines.push(`Section: ${value(result.section.name)} [${value(result.section.gid)}]`);
  if (result.project) {
    lines.push(`Project: ${value(result.project.name)} [${value(result.project.gid)}]`);
    if (result.project.permalink_url) lines.push(result.project.permalink_url);
  }
  if (result.sections?.length) lines.push(`Sections: ${result.sections.map(identity).join(", ")}`);
  if (result.alias) lines.push(`Registered alias: ${result.alias}`);
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
    case "mutation": return formatMutation(result);
    default: return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }
}
