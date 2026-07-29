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

test("ensureCodexWorkerHooks reads, merges, and writes the shared file through temp + rename", async () => {
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash '/h/herdr-agent-state.sh' session", timeout: 10 }] }] } };
  let writtenPath;
  let writtenText;
  const renames = [];
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
    rename: async (from, to) => renames.push({ from, to }),
  });
  // A crash mid-write must never truncate a file shared with other tools.
  assert.equal(writtenPath, "/home/user/.codex/hooks.json.workflow-tmp");
  assert.deepEqual(renames, [{ from: "/home/user/.codex/hooks.json.workflow-tmp", to: "/home/user/.codex/hooks.json" }]);
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
    rename: async () => {},
  });
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    assert.equal(result.hooks[ev].length, 1);
  }
});

test("ensureCodexWorkerHooks refuses to overwrite an existing hooks file it cannot parse", async () => {
  // The file is shared: replacing content this merge cannot read would destroy
  // every other tool's hooks (previously it fell back to an empty object and
  // wrote only the workflow's own entries).
  let wrote = false;
  await assert.rejects(
    () => ensureCodexWorkerHooks({
      hooksPath: "/bad/.codex/hooks.json",
      controlPlaneRoot: "/cp",
      readFile: async () => "not json{{{",
      writeFile: async () => { wrote = true; },
      rename: async () => { wrote = true; },
    }),
    /not valid JSON|left unchanged/i,
  );
  assert.equal(wrote, false);
});

test("ensureCodexWorkerHooks run twice via injected fs is idempotent end to end", async () => {
  const files = new Map();
  const readFile = async (path) => {
    if (!files.has(path)) {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    }
    return files.get(path);
  };
  const writeFile = async (path, text) => {
    files.set(path, text);
  };
  const rename = async (from, to) => {
    files.set(to, files.get(from));
    files.delete(from);
  };
  await ensureCodexWorkerHooks({ hooksPath: "/x/.codex/hooks.json", controlPlaneRoot: "/cp", readFile, writeFile, rename });
  const second = await ensureCodexWorkerHooks({ hooksPath: "/x/.codex/hooks.json", controlPlaneRoot: "/cp", readFile, writeFile, rename });
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const cmds = second.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes("codex-lifecycle.mjs"));
    assert.equal(cmds.length, 1);
  }
});

test("mergeCodexWorkerHooks replaces its own stale entries after the control plane moves", () => {
  // Idempotency keyed on the exact command string left one entry per path, so a
  // moved repo (or a second checkout) fired the shared hook core twice per
  // event, inflating the lifecycle generation counter.
  const first = mergeCodexWorkerHooks({ hooks: {} }, "/old/cp");
  const second = mergeCodexWorkerHooks(first, "/new/cp");
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    const commands = second.hooks[ev].flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.deepEqual(commands, [`node "/new/cp/hooks/codex-lifecycle.mjs" ${ev}`]);
  }
});

test("mergeCodexWorkerHooks preserves foreign entries while replacing workflow entries", () => {
  const foreign = { hooks: [{ type: "command", command: "bash '/h/other-tool.sh' prompt", timeout: 5 }] };
  const current = { hooks: { UserPromptSubmit: [foreign] } };
  const merged = mergeCodexWorkerHooks(mergeCodexWorkerHooks(current, "/old/cp"), "/new/cp");
  const commands = merged.hooks.UserPromptSubmit.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.deepEqual(commands, [
    "bash '/h/other-tool.sh' prompt",
    'node "/new/cp/hooks/codex-lifecycle.mjs" UserPromptSubmit',
  ]);
});
