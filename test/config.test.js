import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadProjectConfig, resolveProjectBinding } from "../src/asana/config.js";

async function configFile(value) {
  const dir = await mkdtemp(join(tmpdir(), "asana-config-"));
  const path = join(dir, "projects.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("loads versioned project configuration", async () => {
  const value = { version: 1, projects: { ocr: { projectGid: "123", activeSections: ["In Progress"] } } };
  assert.deepEqual(await loadProjectConfig(await configFile(value)), value);
});

test("rejects unsupported configuration versions", async () => {
  await assert.rejects(loadProjectConfig(await configFile({ version: 2, projects: {} })), ConfigError);
});

test("passes numeric project GIDs through directly", () => {
  assert.deepEqual(resolveProjectBinding({ version: 1, projects: {} }, "12345"), { projectGid: "12345", activeSections: [] });
});

test("resolves aliases bound by GID or exact name", () => {
  const config = { version: 1, projects: {
    gid: { projectGid: "111", workspaceGid: "w1", activeSections: ["Doing"] },
    name: { projectName: "OCR Platform", activeSections: ["Next Sprint"] },
  } };
  assert.equal(resolveProjectBinding(config, "gid").projectGid, "111");
  assert.equal(resolveProjectBinding(config, "name").projectName, "OCR Platform");
});

test("rejects unknown aliases", () => {
  assert.throws(() => resolveProjectBinding({ version: 1, projects: {} }, "missing"), /Unknown Asana project alias/);
});

test("rejects unbound aliases with discovery instructions", () => {
  const config = { version: 1, projects: { ocr: { activeSections: ["In Progress"] } } };
  assert.throws(() => resolveProjectBinding(config, "ocr"), /asana-workflow projects/);
});
