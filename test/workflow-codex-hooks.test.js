import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    mkdir: async () => {},
    writeFile: async (path, text) => {
      writtenPath = path;
      writtenText = text;
    },
    rename: async (from, to) => renames.push({ from, to }),
  });
  // A crash mid-write must never truncate a file shared with other tools, and the
  // temp name is per-process so concurrent launches cannot interleave into one blob.
  assert.match(writtenPath, /^\/home\/user\/\.codex\/hooks\.json\.workflow-\d+-\d+\.tmp$/);
  assert.deepEqual(renames, [{ from: writtenPath, to: "/home/user/.codex/hooks.json" }]);
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
    mkdir: async () => {},
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
  const mkdir = async () => {};
  await ensureCodexWorkerHooks({ hooksPath: "/x/.codex/hooks.json", controlPlaneRoot: "/cp", readFile, writeFile, rename, mkdir });
  const second = await ensureCodexWorkerHooks({ hooksPath: "/x/.codex/hooks.json", controlPlaneRoot: "/cp", readFile, writeFile, rename, mkdir });
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

test("ensureCodexWorkerHooks refuses to write when an existing hooks file cannot be read", async () => {
  // EACCES means a file exists whose contents are invisible; writing would delete
  // every other tool's hooks. Only ENOENT may be treated as empty.
  let touched = false;
  await assert.rejects(
    () => ensureCodexWorkerHooks({
      hooksPath: "/locked/.codex/hooks.json",
      controlPlaneRoot: "/cp",
      readFile: async () => {
        const error = new Error("EACCES");
        error.code = "EACCES";
        throw error;
      },
      writeFile: async () => { touched = true; },
      rename: async () => { touched = true; },
    }),
    /could not be read|left unchanged/i,
  );
  assert.equal(touched, false);
});

test("ensureCodexWorkerHooks creates hooksPath's parent directory when it does not exist yet (real fs, nested temp path)", async (t) => {
  // On a fresh machine (or with CODEX_HOME pointed at a directory that was never created),
  // hooksPath's parent does not exist. readFile tolerates that as ENOENT-means-empty, but
  // writeFile/rename below both throw ENOENT with no directory to write into -- this is the
  // production defect: a launch on such a host silently never installs the Codex hooks. Uses
  // the real (non-injected) fs functions against a mkdtemp root so the fix is proven end to end,
  // not just that an injected mkdir was called.
  const tempRoot = await mkdtemp(join(tmpdir(), "workflow-codex-hooks-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const hooksPath = join(tempRoot, "not-created-yet", "nested", "hooks.json");

  const result = await ensureCodexWorkerHooks({ hooksPath, controlPlaneRoot: "/cp" });

  const written = JSON.parse(await readFile(hooksPath, "utf8"));
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    assert.equal(written.hooks[ev][0].hooks[0].command, `node "/cp/hooks/codex-lifecycle.mjs" ${ev}`);
  }
  assert.deepEqual(result, written);
});

test("ensureCodexWorkerHooks still writes correctly when hooksPath's parent directory already exists (real fs)", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "workflow-codex-hooks-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dir = join(tempRoot, "already-there");
  await mkdir(dir, { recursive: true });
  const hooksPath = join(dir, "hooks.json");

  const result = await ensureCodexWorkerHooks({ hooksPath, controlPlaneRoot: "/cp" });

  const written = JSON.parse(await readFile(hooksPath, "utf8"));
  for (const ev of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
    assert.equal(written.hooks[ev][0].hooks[0].command, `node "/cp/hooks/codex-lifecycle.mjs" ${ev}`);
  }
  assert.deepEqual(result, written);
});

test("ensureCodexWorkerHooks accepts an injected mkdir and calls it with the parent directory, recursively, before writing", async () => {
  // Mirrors the readFile/writeFile/rename injection already in this function's signature, so
  // this (like every other test in this file) never has to touch a real home directory.
  const calls = [];
  await ensureCodexWorkerHooks({
    hooksPath: "/home/user/.codex/nested/hooks.json",
    controlPlaneRoot: "/cp",
    readFile: async () => {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    mkdir: async (path, options) => { calls.push({ path, options }); },
    writeFile: async () => {
      assert.equal(calls.length, 1, "mkdir must run before writeFile");
    },
    rename: async () => {},
  });
  assert.deepEqual(calls, [{ path: "/home/user/.codex/nested", options: { recursive: true, mode: 0o700 } }]);
});

test("ensureCodexWorkerHooks writes the temp file with private permissions", async () => {
  const writes = [];
  await ensureCodexWorkerHooks({
    hooksPath: "/home/user/.codex/hooks.json",
    controlPlaneRoot: "/cp",
    readFile: async () => {
      const error = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    mkdir: async () => {},
    writeFile: async (path, text, options) => writes.push({ path, options }),
    rename: async () => {},
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, { mode: 0o600 });
});
