import assert from "node:assert/strict";
import { test } from "node:test";
import { formatResult } from "../src/asana/format.js";

test("formats normalized JSON deterministically", () => {
  assert.equal(formatResult("me", { gid: "u1", name: "Rodrigo" }, "json"), '{\n  "gid": "u1",\n  "name": "Rodrigo"\n}');
});

test("formats identity and discovery lists compactly", () => {
  assert.equal(formatResult("me", { gid: "u1", name: "Rodrigo", email: "r@example.com" }), "Rodrigo <r@example.com> [u1]");
  assert.equal(formatResult("projects", [{ gid: "p1", name: "OCR", archived: false }]), "OCR [p1]");
  assert.equal(formatResult("sections", [{ gid: "s1", name: "Esta semana" }]), "Esta semana [s1]");
});

test("formats triage rows with section and assignee context", () => {
  const output = formatResult("triage", {
    project: { gid: "p1", name: "OCR" }, assignee: "any",
    sections: [{ name: "Doing" }],
    tasks: [{ gid: "t1", name: "Fix OCR", sectionNames: ["Doing"], assignee: { name: "Rodrigo", gid: "u1" }, due_on: "2026-07-20", modified_at: "2026-07-17T01:00:00Z", permalink_url: "https://asana.test/t1" }],
  });
  assert.match(output, /Project: OCR \[p1\]/);
  assert.match(output, /Sections: Doing/);
  assert.match(output, /t1 \| Fix OCR \| Doing \| Rodrigo \[u1\] \| due 2026-07-20/);
  assert.doesNotMatch(output, /undefined/);
});

test("formats complete task context while omitting empty sections", () => {
  const output = formatResult("task-full", {
    task: { gid: "t1", name: "Feature", notes: "Detailed description", permalink_url: "https://asana.test/t1", custom_fields: [{ name: "Priority", display_value: "High" }] },
    stories: [{ gid: "c1", resource_subtype: "comment_added", text: "A comment", created_by: { name: "Ana" }, created_at: "2026-07-17" }],
    subtasks: [{ gid: "s1", name: "Subtask", completed: false }], dependencies: [], dependents: [],
    attachments: [{ gid: "a1", name: "mock.png", host: "asana", view_url: "https://asana.test/a1" }],
  });
  assert.match(output, /# Feature \[t1\]/);
  assert.match(output, /Detailed description/);
  assert.match(output, /Priority: High/);
  assert.match(output, /Ana.*A comment/);
  assert.match(output, /Subtask \[s1\]/);
  assert.match(output, /mock.png \[a1\]/);
  assert.doesNotMatch(output, /Dependencies/);
  assert.doesNotMatch(output, /undefined/);
});

test("formats authentication status without credentials", () => {
  assert.equal(formatResult("auth-status", { configured: false, message: "not configured" }), "Asana auth: not configured");
});
