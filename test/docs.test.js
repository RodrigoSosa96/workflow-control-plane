import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Asana skill enforces complete read-only triage", async () => {
  const skill = await read(".agents/skills/asana-triage/SKILL.md");
  assert.match(skill, /^---\nname: asana-triage\ndescription:/);
  assert.match(skill, /asana-workflow auth status/);
  assert.match(skill, /asana-workflow me/);
  assert.match(skill, /asana-workflow triage/);
  assert.match(skill, /asana-workflow task <gid> --full/);
  assert.match(skill, /every candidate/i);
  assert.match(skill, /Do not (modify|write)/i);
  assert.match(skill, /--assignee me\|any\|<gid>/);
});

test("README documents local installation and secure token setup", async () => {
  const readme = await read("README.md");
  assert.match(readme, /npm install --global \/home\/you\/projects\/personal\/workflows/);
  assert.match(readme, /~\/\.config\/workflows\/asana-token/);
  assert.match(readme, /chmod 600/);
  assert.match(readme, /asana-workflow projects/);
  assert.match(readme, /ASANA_PROJECTS_FILE/);
  assert.match(readme, /npm uninstall --global workflow-control-plane/);
});

test("triage prompt explicitly delegates Asana access to the skill and CLI", async () => {
  const prompt = await read(".pi/prompts/triage-asana.md");
  assert.match(prompt, /asana-triage/);
  assert.match(prompt, /asana-workflow/);
});
