import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("README documents the workflow launcher commands and safety boundaries", async () => {
  const readme = await read("README.md");
  assert.match(readme, /workflow doctor ocr/);
  assert.match(readme, /workflow plan ocr ASANA-123 --feature "Discovered Docs"/);
  assert.match(readme, /workflow start ocr ASANA-123 --feature "Discovered Docs" --yes/);
  assert.match(readme, /workflow runtime ocr ASANA-123 --feature "Discovered Docs" --profile standard --yes/);
  assert.match(readme, /workflow status ocr ASANA-123 --feature "Discovered Docs"/);
  assert.match(readme, /workflow plan acme ASANA-456 --feature Onboarding --repos backend,panel/);
  assert.match(readme, /read-only/i);
  assert.match(readme, /requires explicit confirmation or --yes/i);
  assert.match(readme, /does not submit an implementation prompt automatically/i);
  assert.match(readme, /separate explicit checkpoint/i);
});

test("AGENTS workflow stages include Plan between Design and Isolation", async () => {
  const agents = await read("AGENTS.md");
  assert.match(agents, /1\. \*\*Triage:\*\*[\s\S]*2\. \*\*Design:\*\*[\s\S]*3\. \*\*Plan:\*\*[\s\S]*4\. \*\*Isolation:\*\*/);
});

test("workflow prompts require plan approval, manual confirmation, and status-based recovery", async () => {
  const startPrompt = await read(".pi/prompts/start-feature.md");
  assert.match(startPrompt, /workflow plan/i);
  assert.match(startPrompt, /approved design/i);
  assert.match(startPrompt, /approved plan/i);
  assert.match(startPrompt, /request confirmation before running workflow start/i);
  assert.doesNotMatch(startPrompt, /workflow start .*--yes/i);

  const resumePrompt = await read(".pi/prompts/resume-feature.md");
  assert.match(resumePrompt, /workflow status/i);
  assert.match(resumePrompt, /recovery/i);
  assert.doesNotMatch(resumePrompt, /workflow (start|runtime) .*--yes/i);
});
