import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandError, downloadAttachmentFile, getFullTaskContext, resolveProject, triageProject } from "../src/asana/commands.js";

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

test("reports ambiguous project names with candidate GIDs", async () => {
  const client = { projects: async () => [{ gid: "p1", name: "OCR" }, { gid: "p2", name: "ocr" }] };
  await assert.rejects(resolveProject(client, { projectName: "OCR" }), /p1.*p2/);
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
  const client = { downloadAttachment: async () => ({ name: "image.png", bytes: new Uint8Array([4, 5]) }) };
  const result = await downloadAttachmentFile(client, "a1", output);
  assert.equal(result.path, output);
  assert.deepEqual([...await readFile(output)], [4, 5]);
  await assert.rejects(downloadAttachmentFile(client, "a1", output), /already exists/);
});
