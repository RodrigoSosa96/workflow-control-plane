import assert from "node:assert/strict";
import { test } from "node:test";
import { main, parseArgs } from "../bin/asana-workflow.js";

const io = () => {
  const stdout = [], stderr = [];
  return { stdout, stderr, out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
};

test("parses documented triage options", () => {
  assert.deepEqual(parseArgs(["triage", "--project", "ocr", "--sections", "Doing,Next", "--assignee", "any", "--format", "json"]), {
    command: "triage", project: "ocr", sections: ["Doing", "Next"], assignee: "any", format: "json",
  });
});

test("parses full tasks and attachment downloads", () => {
  assert.deepEqual(parseArgs(["task", "t1", "--full"]), { command: "task", gid: "t1", full: true, format: "compact" });
  assert.deepEqual(parseArgs(["attachment", "download", "a1", "--output", "/tmp/a"]), { command: "attachment-download", gid: "a1", output: "/tmp/a", format: "compact" });
});

test("rejects unknown formats, unsafe options, and missing required options", () => {
  assert.throws(() => parseArgs(["me", "--format", "xml"]), /compact or json/);
  assert.throws(() => parseArgs(["me", "--token", "must-not-be-accepted"]), /Unknown option: --token/);
  assert.throws(() => parseArgs(["triage"]), /--project/);
  assert.throws(() => parseArgs(["attachment", "download", "a1"]), /--output/);
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

test("main sanitizes failures and returns nonzero", async () => {
  const output = io();
  const code = await main(["me"], {
    ...output,
    loadToken: async () => ({ token: "super-secret" }),
    createClient: () => ({ me: async () => { throw new Error("request failed"); } }),
  });
  assert.equal(code, 1);
  assert.deepEqual(output.stderr, ["Error: request failed"]);
  assert.doesNotMatch(output.stderr[0], /super-secret/);
});
