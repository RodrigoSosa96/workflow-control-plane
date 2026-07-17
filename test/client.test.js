import assert from "node:assert/strict";
import { test } from "node:test";
import { AsanaApiError, createAsanaClient } from "../src/asana/client.js";

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

test("sends bearer auth and explicit fields", async () => {
  let request;
  const client = createAsanaClient({ token: "secret-token", fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({ data: { gid: "me", name: "Rodrigo" } });
  } });
  assert.equal((await client.me()).gid, "me");
  assert.equal(request.options.headers.authorization, "Bearer secret-token");
  assert.match(request.url, /opt_fields=/);
  assert.doesNotMatch(request.url, /secret-token/);
});

test("follows Asana pagination envelopes", async () => {
  const urls = [];
  const client = createAsanaClient({ token: "x", fetchImpl: async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? jsonResponse({ data: [{ gid: "1" }], next_page: { uri: "https://app.asana.com/api/1.0/workspaces?offset=next" } })
      : jsonResponse({ data: [{ gid: "2" }], next_page: null });
  } });
  assert.deepEqual(await client.workspaces(), [{ gid: "1" }, { gid: "2" }]);
  assert.equal(urls.length, 2);
});

test("rejects cross-origin pagination before sending the bearer token", async () => {
  let calls = 0;
  const client = createAsanaClient({ token: "secret", fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ data: [{ gid: "1" }], next_page: { uri: "https://attacker.example/steal" } });
  } });
  await assert.rejects(client.workspaces(), /outside the configured Asana API origin/);
  assert.equal(calls, 1);
});

test("categorizes malformed pagination URIs", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async () =>
    jsonResponse({ data: [], next_page: { uri: "not a valid URL" } }) });
  await assert.rejects(client.workspaces(), (error) => error instanceof AsanaApiError && /malformed pagination URI/.test(error.message));
});

test("stops pagination at the configured safety limit", async () => {
  const client = createAsanaClient({ token: "x", maxPages: 1, fetchImpl: async () =>
    jsonResponse({ data: [], next_page: { uri: "https://app.asana.com/api/1.0/workspaces?offset=next" } }) });
  await assert.rejects(client.workspaces(), /pagination exceeded 1 pages/);
});

test("rejects malformed Asana envelopes", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async () => jsonResponse({ wrong: [] }) });
  await assert.rejects(client.workspaces(), /malformed response/);
});

test("sanitizes bounded API errors, redacts tokens, and reports rate limits", async () => {
  const client = createAsanaClient({ token: "top-secret", fetchImpl: async () =>
    jsonResponse({ errors: [{ message: "token top-secret rate limited " + "x".repeat(1000) }] }, 429, { "retry-after": "30" }) });
  await assert.rejects(client.me(), (error) => {
    assert.ok(error instanceof AsanaApiError);
    assert.match(error.message, /retry after 30 seconds/);
    assert.ok(error.message.length < 600);
    assert.doesNotMatch(error.message, /top-secret/);
    return true;
  });
});

test("uses the expected discovery endpoints", async () => {
  const urls = [];
  const client = createAsanaClient({ token: "x", fetchImpl: async (url) => {
    urls.push(new URL(url));
    return jsonResponse({ data: [] });
  } });
  await client.projects("w 1");
  await client.sections("p1");
  await client.sectionTasks("s1");
  assert.equal(urls[0].pathname, "/api/1.0/projects");
  assert.equal(urls[0].searchParams.get("workspace"), "w 1");
  assert.equal(urls[1].pathname, "/api/1.0/projects/p1/sections");
  assert.equal(urls[2].pathname, "/api/1.0/sections/s1/tasks");
  assert.ok(urls.every((url) => url.searchParams.has("opt_fields")));
});

test("uses task context endpoints", async () => {
  const paths = [];
  const client = createAsanaClient({ token: "x", fetchImpl: async (url) => {
    paths.push(new URL(url).pathname);
    return jsonResponse({ data: new URL(url).pathname.includes("/tasks/t1") && !new URL(url).pathname.match(/stories|subtasks|dependencies|dependents|attachments/) ? { gid: "t1" } : [] });
  } });
  await client.task("t1");
  await client.stories("t1");
  await client.subtasks("t1");
  await client.dependencies("t1");
  await client.dependents("t1");
  await client.attachments("t1");
  assert.deepEqual(paths, [
    "/api/1.0/tasks/t1", "/api/1.0/tasks/t1/stories", "/api/1.0/tasks/t1/subtasks",
    "/api/1.0/tasks/t1/dependencies", "/api/1.0/tasks/t1/dependents", "/api/1.0/tasks/t1/attachments",
  ]);
});

test("downloads Asana-hosted attachment bytes from fresh metadata", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async (url, options) => {
    if (String(url).includes("/attachments/a1")) return jsonResponse({ data: { gid: "a1", name: "image.png", host: "asana", download_url: "https://download.test/a1" } });
    assert.equal(options.headers.authorization, undefined, "must not send Asana bearer token to a download host");
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
  } });
  const result = await client.downloadAttachment("a1");
  assert.equal(result.name, "image.png");
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(result.contentType, "image/png");
});

test("rejects attachment redirects that leave HTTPS before following them", async () => {
  let downloadCalls = 0;
  const client = createAsanaClient({ token: "x", fetchImpl: async (url, options) => {
    if (String(url).includes("/attachments/a1")) return jsonResponse({ data: { gid: "a1", name: "image.png", host: "asana", download_url: "https://download.test/a1" } });
    downloadCalls += 1;
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "http://insecure.test/file" } });
  } });
  await assert.rejects(client.downloadAttachment("a1"), /valid HTTPS redirect/);
  assert.equal(downloadCalls, 1);
});

test("rejects redirect responses without Location", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async (url) => {
    if (String(url).includes("/attachments/a1")) return jsonResponse({ data: { gid: "a1", host: "asana", download_url: "https://download.test/a1" } });
    return new Response(null, { status: 302 });
  } });
  await assert.rejects(client.downloadAttachment("a1"), /redirect without a Location/);
});

test("does not treat non-redirect 3xx statuses as redirects", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async (url) => {
    if (String(url).includes("/attachments/a1")) return jsonResponse({ data: { gid: "a1", host: "asana", download_url: "https://download.test/a1" } });
    return new Response(null, { status: 304, headers: { location: "https://download.test/other" } });
  } });
  await assert.rejects(client.downloadAttachment("a1"), (error) => error.status === 304 && error.kind === "attachment");
});

test("categorizes attachment transport failures as network errors", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async (url) => {
    if (String(url).includes("/attachments/a1")) return jsonResponse({ data: { gid: "a1", host: "asana", download_url: "https://download.test/a1" } });
    throw new Error("socket closed");
  } });
  await assert.rejects(client.downloadAttachment("a1"), (error) => error instanceof AsanaApiError && /network failure/.test(error.message));
});

test("rejects external attachments even when metadata supplies a URL", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async () => jsonResponse({ data: { gid: "a1", host: "external", download_url: "http://127.0.0.1/private" } }) });
  await assert.rejects(client.downloadAttachment("a1"), /not Asana-hosted/);
});

test("rejects Asana attachments without HTTPS downloadable content", async () => {
  const client = createAsanaClient({ token: "x", fetchImpl: async () => jsonResponse({ data: { gid: "a1", host: "asana", download_url: "http://download.test/a1" } }) });
  await assert.rejects(client.downloadAttachment("a1"), /valid HTTPS download URL/);
});
