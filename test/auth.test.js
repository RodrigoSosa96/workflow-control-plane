import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, loadToken } from "../src/asana/auth.js";

const files = (entries = {}) => ({
  async readFile(path) {
    if (!(path in entries)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return entries[path].content;
  },
  async stat(path) {
    if (!(path in entries)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { mode: entries[path].mode ?? 0o100600 };
  },
});

test("environment token takes precedence without reading files", async () => {
  const result = await loadToken({
    env: { ASANA_ACCESS_TOKEN: " env-token ", ASANA_TOKEN_FILE: "/custom" },
    homeDir: "/home/test",
    readFile: async () => assert.fail("should not read"),
    stat: async () => assert.fail("should not stat"),
  });
  assert.deepEqual(result, { token: "env-token", source: "environment" });
});

test("explicit token file takes precedence over default", async () => {
  const fs = files({ "/custom": { content: "custom-token\n" } });
  const result = await loadToken({ env: { ASANA_TOKEN_FILE: "/custom" }, homeDir: "/home/test", ...fs });
  assert.equal(result.token, "custom-token");
  assert.equal(result.source, "/custom");
});

test("loads default protected token file", async () => {
  const path = "/home/test/.config/workflows/asana-token";
  const result = await loadToken({ env: {}, homeDir: "/home/test", ...files({ [path]: { content: "abc" } }) });
  assert.deepEqual(result, { token: "abc", source: path });
});

test("warns when token file is readable by group or others", async () => {
  const path = "/home/test/.config/workflows/asana-token";
  const result = await loadToken({ env: {}, homeDir: "/home/test", ...files({ [path]: { content: "abc", mode: 0o100644 } }) });
  assert.match(result.warning, /chmod 600/);
});

test("rejects missing authentication with actionable error", async () => {
  await assert.rejects(
    loadToken({ env: {}, homeDir: "/home/test", ...files() }),
    (error) => error instanceof AuthError && /not configured/.test(error.message),
  );
});

test("rejects an empty token without including its contents", async () => {
  const path = "/home/test/.config/workflows/asana-token";
  await assert.rejects(
    loadToken({ env: {}, homeDir: "/home/test", ...files({ [path]: { content: "  \n" } }) }),
    (error) => error instanceof AuthError && /empty/.test(error.message),
  );
});
