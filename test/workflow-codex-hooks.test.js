import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureCodexWorkerHooks, mergeCodexWorkerHooks } from "../src/workflow/codex-hooks.js";

test("adds the workflow lifecycle hooks beside an existing Herdr SessionStart hook, without clobbering it", () => {
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash '/h/herdr-agent-state.sh' session", timeout: 10 }] }] } };
  const merged = mergeCodexWorkerHooks(existing, "/cp");
  // Herdr's SessionStart preserved
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, "bash '/h/herdr-agent-state.sh' session");
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmds = merged.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => /\/cp\/hooks\/codex-lifecycle\.mjs" ?Ev|codex-lifecycle\.mjs" /.test(c) || c.includes(`/cp/hooks/codex-lifecycle.mjs`)));
  }
});

test("is idempotent — merging twice does not duplicate the workflow hook", () => {
  const once = mergeCodexWorkerHooks({ hooks: {} }, "/cp");
  const twice = mergeCodexWorkerHooks(once, "/cp");
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmds = twice.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes("codex-lifecycle.mjs"));
    assert.equal(cmds.length, 1);
  }
});

test("mergeCodexWorkerHooks never mutates the input object", () => {
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash session", timeout: 10 }] }] } };
  const snapshotBefore = JSON.stringify(existing);
  mergeCodexWorkerHooks(existing, "/cp");
  assert.equal(JSON.stringify(existing), snapshotBefore);
});

test("mergeCodexWorkerHooks tolerates an empty current object (no hooks key)", () => {
  const merged = mergeCodexWorkerHooks({}, "/cp");
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    assert.equal(merged.hooks[ev].length, 1);
    assert.equal(merged.hooks[ev][0].hooks[0].type, "command");
    assert.equal(merged.hooks[ev][0].hooks[0].timeout, 10);
    assert.equal(merged.hooks[ev][0].hooks[0].command, `node "/cp/hooks/codex-lifecycle.mjs" ${ev}`);
  }
});

test("ensureCodexWorkerHooks reads, merges, and writes back the hooks file", async () => {
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash '/h/herdr-agent-state.sh' session", timeout: 10 }] }] } };
  let writtenPath;
  let writtenText;
  const result = await ensureCodexWorkerHooks({
    hooksPath: "/home/user/.codex/hooks.json",
    controlPlaneRoot: "/cp",
    readFile: async (path) => {
      assert.equal(path, "/home/user/.codex/hooks.json");
      return JSON.stringify(existing);
    },
    writeFile: async (path, text) => {
      writtenPath = path;
      writtenText = text;
    },
  });
  assert.equal(writtenPath, "/home/user/.codex/hooks.json");
  const written = JSON.parse(writtenText);
  assert.equal(written.hooks.SessionStart[0].hooks[0].command, "bash '/h/herdr-agent-state.sh' session");
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    assert.equal(written.hooks[ev][0].hooks[0].command, `node "/cp/hooks/codex-lifecycle.mjs" ${ev}`);
  }
  assert.deepEqual(result, written);
});

test("ensureCodexWorkerHooks falls back to an empty hooks object when the file is absent", async () => {
  const result = await ensureCodexWorkerHooks({
    hooksPath: "/missing/.codex/hooks.json",
    controlPlaneRoot: "/cp",
    readFile: async () => {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    writeFile: async () => {},
  });
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    assert.equal(result.hooks[ev].length, 1);
  }
});

test("ensureCodexWorkerHooks falls back to an empty hooks object when the file is unparseable", async () => {
  const result = await ensureCodexWorkerHooks({
    hooksPath: "/bad/.codex/hooks.json",
    controlPlaneRoot: "/cp",
    readFile: async () => "not json{{{",
    writeFile: async () => {},
  });
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    assert.equal(result.hooks[ev].length, 1);
  }
});

test("ensureCodexWorkerHooks run twice via injected fs is idempotent end to end", async () => {
  let stored = null;
  const readFile = async () => {
    if (stored === null) {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    }
    return stored;
  };
  const writeFile = async (_path, text) => {
    stored = text;
  };
  await ensureCodexWorkerHooks({ hooksPath: "/x/.codex/hooks.json", controlPlaneRoot: "/cp", readFile, writeFile });
  const second = await ensureCodexWorkerHooks({ hooksPath: "/x/.codex/hooks.json", controlPlaneRoot: "/cp", readFile, writeFile });
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmds = second.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes("codex-lifecycle.mjs"));
    assert.equal(cmds.length, 1);
  }
});
