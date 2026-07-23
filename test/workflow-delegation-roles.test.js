import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { test } from "node:test";
import { loadDelegationRole } from "../src/workflow/delegation-roles.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDirectory = join(projectRoot, ".pi", "agents");

const EXPECTED = new Map([
  ["scout", ["read", "bash", "grep", "find", "ls"]],
  ["spec-reviewer", ["read", "bash", "grep", "find", "ls"]],
  ["code-reviewer", ["read", "bash", "grep", "find", "ls"]],
  ["sdd-implementer", ["read", "bash", "edit", "write", "grep", "find", "ls"]],
]);

function parseFrontmatter(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  assert.ok(match, "role file must contain YAML frontmatter");
  return { data: parseYaml(match[1]), body: match[2].trim() };
}

function frontmatterTools(value) {
  return String(value)
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

async function tempAgentDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-delegation-roles-"));
  t.after(() => realFs.rm(root, { recursive: true, force: true }));
  return root;
}

function roleBody(name) {
  return `Role ${name}. Follow the frozen brief only. Use no subagents. Do no cleanup, no deploy, and no push. Return a bounded report with configured verification.`;
}

function roleText({
  name,
  description = `Role ${name} description`,
  tools = name === "sdd-implementer" ? "read,bash,edit,write,grep,find,ls" : "read,bash,grep,find,ls",
  systemPromptMode = "append",
  inheritProjectContext = true,
  inheritSkills = true,
  async = false,
  maxSubagentDepth = 1,
  extraFrontmatter = "",
  body = roleBody(name),
} = {}) {
  return `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\nsystemPromptMode: ${systemPromptMode}\ninheritProjectContext: ${inheritProjectContext}\ninheritSkills: ${inheritSkills}\nasync: ${async}\nmaxSubagentDepth: ${maxSubagentDepth}\n${extraFrontmatter}---\n${body}\n`;
}

test("project delegation roles have exact managed names, required metadata, and bounded safety prompts", async () => {
  const files = (await readdir(agentDirectory)).filter((entry) => entry.endsWith(".md")).sort();
  assert.deepEqual(files, ["code-reviewer.md", "scout.md", "sdd-implementer.md", "spec-reviewer.md"]);

  const seenNames = new Set();
  for (const [name, expectedTools] of EXPECTED) {
    const text = await readFile(join(agentDirectory, `${name}.md`), "utf8");
    const { data, body } = parseFrontmatter(text);
    const tools = frontmatterTools(data.tools);

    assert.equal(data.name, name);
    assert.equal(seenNames.has(data.name), false);
    seenNames.add(data.name);
    assert.equal(typeof data.description, "string");
    assert.ok(Buffer.byteLength(data.description, "utf8") <= 200);
    assert.deepEqual(tools, expectedTools);
    assert.equal(data.systemPromptMode, "append");
    assert.equal(data.inheritProjectContext, true);
    assert.equal(data.inheritSkills, true);
    assert.equal(data.async, false);
    assert.equal(data.maxSubagentDepth, 1);
    assert.match(body, /frozen brief/i);
    assert.match(body, /no subagents/i);
    assert.match(body, /no cleanup/i);
    assert.match(body, /no deploy/i);
    assert.match(body, /no push/i);
    assert.match(body, /bounded report/i);
    assert.match(body, /configured verification/i);

    const loaded = await loadDelegationRole({ name, agentDirectory });
    assert.deepEqual(loaded, { name, tools: expectedTools, systemPrompt: body });
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.tools), true);

    if (name === "sdd-implementer") {
      assert.equal(loaded.tools.includes("edit"), true);
      assert.equal(loaded.tools.includes("write"), true);
    } else {
      assert.equal(loaded.tools.includes("edit"), false);
      assert.equal(loaded.tools.includes("write"), false);
    }
    assert.equal(loaded.tools.includes("subagent"), false);
  }
});

test("loadDelegationRole rejects duplicate names and invalid frontmatter or tool policy", async (t) => {
  const root = await tempAgentDirectory(t);

  await writeFile(join(root, "scout.md"), roleText({ name: "scout" }));
  await writeFile(join(root, "copy.md"), roleText({ name: "scout" }));
  await assert.rejects(() => loadDelegationRole({ name: "scout", agentDirectory: root }), /duplicate/i);

  await writeFile(join(root, "scout.md"), roleText({ name: "scout", extraFrontmatter: "mode: background\n" }));
  await writeFile(join(root, "copy.md"), roleText({ name: "spec-reviewer" }));
  await assert.rejects(() => loadDelegationRole({ name: "scout", agentDirectory: root }), /unknown|unsupported/i);

  await writeFile(join(root, "scout.md"), `---\nname: scout\ntools: read,bash,grep,find,ls\n---\n${roleBody("scout")}\n`);
  await assert.rejects(() => loadDelegationRole({ name: "scout", agentDirectory: root }), /required|metadata/i);

  await writeFile(join(root, "scout.md"), roleText({ name: "scout", tools: "read,bash; rm -rf /,grep,find,ls" }));
  await assert.rejects(() => loadDelegationRole({ name: "scout", agentDirectory: root }), /tool/i);

  await writeFile(join(root, "scout.md"), roleText({ name: "scout", async: true }));
  await assert.rejects(() => loadDelegationRole({ name: "scout", agentDirectory: root }), /async|background/i);

  await writeFile(join(root, "scout.md"), roleText({ name: "scout", tools: "read,bash,subagent,grep,find,ls" }));
  await assert.rejects(() => loadDelegationRole({ name: "scout", agentDirectory: root }), /subagent|nested/i);
});

test("loadDelegationRole rejects role files that resolve outside the expected agent directory", async (t) => {
  const root = await tempAgentDirectory(t);
  const outside = await tempAgentDirectory(t);
  await writeFile(join(outside, "scout.md"), roleText({ name: "scout" }));
  await symlink(join(outside, "scout.md"), join(root, "scout.md"));
  await assert.rejects(() => loadDelegationRole({ name: "scout", agentDirectory: root }), /outside|agent directory/i);
});
