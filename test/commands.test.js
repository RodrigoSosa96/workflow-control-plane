import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CommandError,
  commentTaskCommand,
  createProjectCommand,
  createTaskCommand,
  downloadAttachmentFile,
  getFullTaskContext,
  moveTaskCommand,
  registerProjectAlias,
  resolveProject,
  resolveSectionByName,
  triageProject,
  updateTaskCommand,
} from "../src/asana/commands.js";

test("resolves a project GID without discovery", async () => {
  const project = await resolveProject({ projects: () => assert.fail("not needed") }, { projectGid: "p1" });
  assert.deepEqual(project, { gid: "p1" });
});

test("resolves an exact case-insensitive project name", async () => {
  const client = { projects: async (workspace) => {
    assert.equal(workspace, "w1");
    return [{ gid: "p1", name: "OCR Platform" }, { gid: "p2", name: "Other" }];
  } };
  assert.deepEqual(await resolveProject(client, { projectName: "ocr platform", workspaceGid: "w1" }), { gid: "p1", name: "OCR Platform" });
});

test("resolves a project name across authenticated workspaces when workspace is omitted", async () => {
  const requested = [];
  const client = {
    me: async () => ({ workspaces: [{ gid: "w1" }, { gid: "w2" }] }),
    projects: async (workspace) => {
      assert.ok(workspace, "workspace scope is required");
      requested.push(workspace);
      return workspace === "w1" ? [{ gid: "p1", name: "Other" }] : [{ gid: "p2", name: "OCR" }];
    },
  };
  assert.deepEqual(await resolveProject(client, { projectName: "OCR" }), { gid: "p2", name: "OCR" });
  assert.deepEqual(requested, ["w1", "w2"]);
});

test("reports ambiguous project names with candidate GIDs", async () => {
  const client = { projects: async () => [{ gid: "p1", name: "OCR" }, { gid: "p2", name: "ocr" }] };
  await assert.rejects(resolveProject(client, { projectName: "OCR", workspaceGid: "w1" }), /p1.*p2/);
});

test("triage scans all project sections by default and filters to me", async () => {
  const calls = [];
  const client = {
    me: async () => ({ gid: "u1", name: "Rodrigo" }),
    sections: async () => [{ gid: "s1", name: "Doing" }, { gid: "s2", name: "Backlog" }],
    sectionTasks: async (gid) => {
      calls.push(gid);
      return gid === "s1"
        ? [{ gid: "t1", name: "Mine", assignee: { gid: "u1" } }, { gid: "t2", name: "Other", assignee: { gid: "u2" } }]
        : [{ gid: "t1", name: "Mine", assignee: { gid: "u1" } }];
    },
  };
  const result = await triageProject(client, { gid: "p1" }, { assignee: "me" });
  assert.deepEqual(calls.sort(), ["s1", "s2"]);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].gid, "t1");
  assert.deepEqual(result.tasks[0].sectionNames.sort(), ["Backlog", "Doing"]);
});

test("triage supports changing section names and any assignee", async () => {
  const client = {
    sections: async () => [{ gid: "s1", name: "Esta semana" }, { gid: "s2", name: "Después" }],
    sectionTasks: async () => [{ gid: "t2", assignee: { gid: "u2", name: "Someone" } }],
  };
  const result = await triageProject(client, { gid: "p1" }, { sectionNames: ["esta semana"], assignee: "any" });
  assert.deepEqual(result.sections.map((s) => s.name), ["Esta semana"]);
  assert.equal(result.tasks[0].assignee.name, "Someone");
});

test("triage filters by explicit assignee GID", async () => {
  const client = {
    sections: async () => [{ gid: "s1", name: "All" }],
    sectionTasks: async () => [{ gid: "a", assignee: { gid: "u1" } }, { gid: "b", assignee: null }],
  };
  const result = await triageProject(client, { gid: "p1" }, { assignee: "u1" });
  assert.deepEqual(result.tasks.map((task) => task.gid), ["a"]);
});

test("triage reports section filters that do not exist", async () => {
  const client = { sections: async () => [{ gid: "s1", name: "Backlog" }] };
  await assert.rejects(triageProject(client, { gid: "p1" }, { sectionNames: ["Next Sprint"], assignee: "any" }), CommandError);
});

test("aggregates complete task context", async () => {
  const client = {
    task: async () => ({ gid: "t1", name: "Task" }),
    stories: async () => [{ gid: "story" }], subtasks: async () => [{ gid: "sub" }],
    dependencies: async () => [{ gid: "dep" }], dependents: async () => [{ gid: "dependent" }],
    attachments: async () => [{ gid: "attachment" }],
  };
  assert.deepEqual(await getFullTaskContext(client, "t1"), {
    task: { gid: "t1", name: "Task" }, stories: [{ gid: "story" }], subtasks: [{ gid: "sub" }],
    dependencies: [{ gid: "dep" }], dependents: [{ gid: "dependent" }], attachments: [{ gid: "attachment" }],
  });
});

test("downloads attachment and refuses overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asana-download-"));
  const output = join(dir, "nested", "image.png");
  let downloads = 0;
  const client = { downloadAttachment: async () => { downloads += 1; return { name: "image.png", bytes: new Uint8Array([4, 5]) }; } };
  const result = await downloadAttachmentFile(client, "a1", output);
  assert.equal(result.path, output);
  assert.deepEqual([...await readFile(output)], [4, 5]);
  await assert.rejects(downloadAttachmentFile(client, "a1", output), /already exists/);
  assert.equal(downloads, 1, "existing output must be rejected before downloading bytes");
});

test("resolves exact case-insensitive section names and rejects missing or ambiguous names", async () => {
  const exactClient = { sections: async () => [{ gid: "s1", name: "Doing" }, { gid: "s2", name: "Done" }] };
  assert.deepEqual(await resolveSectionByName(exactClient, "p1", "doing"), { gid: "s1", name: "Doing" });
  await assert.rejects(resolveSectionByName(exactClient, "p1", "Missing"), /not found.*p1/i);
  const ambiguousClient = { sections: async () => [{ gid: "s1", name: "Doing" }, { gid: "s2", name: "doing" }] };
  await assert.rejects(resolveSectionByName(ambiguousClient, "p1", "Doing"), /ambiguous.*s1.*s2/i);
});

test("task creation is dry-run by default and executes only when confirmed", async () => {
  let writes = 0;
  const client = {
    me: async () => ({ gid: "u1" }),
    sections: async () => [{ gid: "s1", name: "Doing" }],
    createTask: async (fields) => { writes += 1; return { gid: "t1", name: fields.name, permalink_url: "https://asana.test/t1" }; },
    addTaskToSection: async () => { writes += 1; },
  };
  const input = { project: { gid: "p1" }, name: "Ticket", notes: "Details", section: "Doing", assignee: "me", dueOn: "2026-09-01" };

  const dry = await createTaskCommand(client, input, { confirm: false });
  assert.deepEqual(dry, {
    dryRun: true,
    action: "create task",
    details: { project: "p1", name: "Ticket", notes: "Details", section: "Doing [s1]", assignee: "u1", due_on: "2026-09-01" },
  });
  assert.equal(writes, 0);

  const applied = await createTaskCommand(client, input, { confirm: true });
  assert.equal(applied.task.gid, "t1");
  assert.equal(applied.section.gid, "s1");
  assert.equal(writes, 2);
});

test("update, comment, and move commands translate fields and respect confirmation", async () => {
  const calls = [];
  const client = {
    sections: async () => [{ gid: "s2", name: "Done" }],
    updateTask: async (gid, fields) => { calls.push(["update", gid, fields]); return { gid, ...fields }; },
    addStory: async (gid, text) => { calls.push(["comment", gid, text]); return { gid: "story1", text }; },
    addTaskToSection: async (sectionGid, taskGid) => { calls.push(["move", sectionGid, taskGid]); },
  };

  const dryUpdate = await updateTaskCommand(client, "t1", { assignee: "none", dueOn: "none", completed: true }, { confirm: false });
  assert.deepEqual(dryUpdate.details, { task: "t1", assignee: null, due_on: null, completed: true });
  await commentTaskCommand(client, "t1", "Ready", { confirm: false });
  await moveTaskCommand(client, "t1", { project: { gid: "p1" }, section: "Done" }, { confirm: false });
  assert.deepEqual(calls, []);

  const updated = await updateTaskCommand(client, "t1", { assignee: "none", dueOn: "none", completed: true }, { confirm: true });
  const commented = await commentTaskCommand(client, "t1", "Ready", { confirm: true });
  const moved = await moveTaskCommand(client, "t1", { project: { gid: "p1" }, section: "Done" }, { confirm: true });
  assert.equal(updated.task.completed, true);
  assert.equal(commented.story.gid, "story1");
  assert.equal(moved.section.gid, "s2");
  assert.deepEqual(calls, [
    ["update", "t1", { assignee: null, due_on: null, completed: true }],
    ["comment", "t1", "Ready"],
    ["move", "s2", "t1"],
  ]);
});

test("project creation plans sections and creates them in order only when confirmed", async () => {
  const calls = [];
  const client = {
    createProject: async (fields) => { calls.push(["project", fields]); return { gid: "p1", name: fields.name }; },
    createSection: async (gid, name) => { calls.push(["section", gid, name]); return { gid: `s-${name}`, name }; },
  };
  const input = { workspaceGid: "w1", name: "Board", sections: ["Backlog", "Doing", "Done"] };
  const dry = await createProjectCommand(client, input, { confirm: false });
  assert.deepEqual(dry.details, { workspace: "w1", name: "Board", sections: ["Backlog", "Doing", "Done"] });
  assert.deepEqual(calls, []);

  const applied = await createProjectCommand(client, input, { confirm: true });
  assert.deepEqual(applied.sections.map((section) => section.name), ["Backlog", "Doing", "Done"]);
  assert.deepEqual(calls, [
    ["project", { workspace: "w1", name: "Board", default_view: "board", public: true }],
    ["section", "p1", "Backlog"], ["section", "p1", "Doing"], ["section", "p1", "Done"],
  ]);
});

test("registers a new project alias without overwriting existing bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asana-alias-"));
  const path = join(dir, "projects.json");
  await writeFile(path, JSON.stringify({ version: 1, projects: { existing: { projectGid: "p0" } } }));

  await registerProjectAlias(path, "new-board", "p1");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    projects: { existing: { projectGid: "p0" }, "new-board": { projectGid: "p1" } },
  });
  await assert.rejects(registerProjectAlias(path, "existing", "p2"), /already exists/);
  await assert.rejects(registerProjectAlias(path, "../unsafe", "p2"), /valid Asana project alias/);
});
