import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { main, parseArgs } from "../bin/asana-workflow.js";

const io = () => {
  const stdout = [], stderr = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
};

test("installed symlink executes the CLI entry point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asana-cli-link-"));
  const link = join(dir, "asana-workflow");
  await symlink(new URL("../bin/asana-workflow.js", import.meta.url), link);
  const result = spawnSync(link, ["auth", "status"], {
    encoding: "utf8",
    env: { ...process.env, ASANA_ACCESS_TOKEN: "test-token" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Asana auth: configured (environment)");
});

test("parses documented triage options", () => {
  assert.deepEqual(parseArgs(["triage", "--project", "ocr", "--sections", "Doing,Next", "--assignee", "any", "--format", "json"]), {
    command: "triage", project: "ocr", sections: ["Doing", "Next"], assignee: "any", format: "json",
  });
});

test("parses full tasks and attachment downloads", () => {
  assert.deepEqual(parseArgs(["task", "101", "--full"]), { command: "task", gid: "101", full: true, format: "compact" });
  assert.deepEqual(parseArgs(["attachment", "download", "201", "--output", "/tmp/a"]), { command: "attachment-download", gid: "201", output: "/tmp/a", format: "compact" });
});

test("rejects unknown formats, unsafe options, and missing required options", () => {
  assert.throws(() => parseArgs(["me", "--format", "xml"]), /compact or json/);
  assert.throws(() => parseArgs(["me", "--token", "must-not-be-accepted"]), /Unknown option: --token/);
  assert.throws(() => parseArgs(["me", "junk"]), /unexpected argument/);
  assert.throws(() => parseArgs(["me", "--workspace", "w1"]), /does not accept --workspace/);
  assert.throws(() => parseArgs(["task", "1", "2"]), /unexpected argument/);
  assert.throws(() => parseArgs(["attachments", "1", "--full"]), /does not accept --full/);
  assert.throws(() => parseArgs(["auth", "status", "junk"]), /unexpected argument/);
  assert.throws(() => parseArgs(["task", "../users/me"]), /valid Asana GID/);
  assert.throws(() => parseArgs(["triage", "--project", "ocr", "--assignee", "not-a-gid"]), /assignee must be me, any, or an Asana GID/);
  assert.throws(() => parseArgs(["me", "--format", "json", "--format", "compact"]), /Duplicate option/);
  assert.throws(() => parseArgs(["me", "--token", "secret", "--help"]), /Unknown option: --token/);
  assert.throws(() => parseArgs(["triage"]), /--project/);
  assert.throws(() => parseArgs(["attachment", "download", "201"]), /--output/);
});

test("auth status succeeds when auth is missing", async () => {
  const output = io();
  const code = await main(["auth", "status"], {
    ...output,
    loadToken: async () => { throw new Error("authentication is not configured"); },
  });
  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["Asana auth: not configured"]);
});

test("main prints compact discovery output with injected client", async () => {
  const output = io();
  const client = { me: async () => ({ gid: "u1", name: "Rodrigo" }) };
  const code = await main(["me"], {
    ...output,
    loadToken: async () => ({ token: "hidden", source: "test" }),
    createClient: () => client,
  });
  assert.equal(code, 0);
  assert.deepEqual(output.stdout, ["Rodrigo [u1]"]);
  assert.deepEqual(output.stderr, []);
});

test("main discovers projects across all user workspaces", async () => {
  const output = io();
  const client = {
    me: async () => ({ workspaces: [{ gid: "w1" }, { gid: "w2" }] }),
    projects: async (gid) => [{ gid: `p-${gid}`, name: `Project ${gid}` }],
  };
  const code = await main(["projects"], {
    ...output, loadToken: async () => ({ token: "hidden" }), createClient: () => client,
  });
  assert.equal(code, 0);
  assert.match(output.stdout[0], /Project w1 \[p-w1\].*Project w2 \[p-w2\]/s);
});

test("main dispatches flexible triage options", async () => {
  const output = io();
  const client = {
    sections: async () => [{ gid: "s1", name: "Doing" }],
    sectionTasks: async () => [{ gid: "t1", name: "Mine", assignee: { gid: "u1", name: "Rodrigo" } }],
    me: async () => ({ gid: "u1", name: "Rodrigo" }),
  };
  const code = await main(["triage", "--project", "123", "--assignee", "me"], {
    ...output,
    loadToken: async () => ({ token: "hidden" }), createClient: () => client,
    loadConfig: async () => ({ version: 1, projects: {} }),
  });
  assert.equal(code, 0);
  assert.match(output.stdout[0], /Mine/);
});

test("main exposes stable usage and authentication error categories", async () => {
  const usage = io();
  assert.equal(await main(["triage"], usage), 64);
  assert.match(usage.stderr[0], /^USAGE:/);

  const auth = io();
  const error = Object.assign(new Error("authentication missing"), { name: "AuthError" });
  assert.equal(await main(["me"], { ...auth, loadToken: async () => { throw error; } }), 2);
  assert.deepEqual(auth.stderr, ["AUTH: authentication missing"]);
});

test("main categorizes API authentication failures", async () => {
  const output = io();
  const unauthorized = Object.assign(new Error("unauthorized"), { name: "AsanaApiError", status: 401, kind: "api" });
  const code = await main(["me"], {
    ...output, loadToken: async () => ({ token: "hidden" }),
    createClient: () => ({ me: async () => { throw unauthorized; } }),
  });
  assert.equal(code, 2);
  assert.deepEqual(output.stderr, ["AUTH: unauthorized"]);
});

test("main does not classify attachment-host auth failures as Asana auth failures", async () => {
  const output = io();
  const attachmentFailure = Object.assign(new Error("download unauthorized"), { name: "AsanaApiError", status: 401, kind: "attachment" });
  const code = await main(["attachment", "download", "201", "--output", "/tmp/a"], {
    ...output, loadToken: async () => ({ token: "hidden" }),
    createClient: () => ({ downloadAttachment: async () => { throw attachmentFailure; } }),
  });
  assert.equal(code, 9);
  assert.deepEqual(output.stderr, ["ATTACHMENT: download unauthorized"]);
});

test("main exposes rate-limit category", async () => {
  const output = io();
  const rateLimit = Object.assign(new Error("retry later"), { name: "AsanaApiError", status: 429 });
  const code = await main(["me"], {
    ...output, loadToken: async () => ({ token: "hidden" }),
    createClient: () => ({ me: async () => { throw rateLimit; } }),
  });
  assert.equal(code, 4);
  assert.deepEqual(output.stderr, ["RATE_LIMIT: retry later"]);
});

test("main sanitizes internal failures and returns nonzero", async () => {
  const output = io();
  const code = await main(["me"], {
    ...output,
    loadToken: async () => ({ token: "super-secret" }),
    createClient: () => ({ me: async () => { throw new Error("request failed with super-secret"); } }),
  });
  assert.equal(code, 1);
  assert.deepEqual(output.stderr, ["INTERNAL: request failed with [REDACTED]"]);
  assert.doesNotMatch(output.stderr[0], /super-secret/);
});
