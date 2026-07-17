const DEFAULT_BASE_URL = "https://app.asana.com/api/1.0";
const USER_FIELDS = "gid,name,email,workspaces.gid,workspaces.name";
const PROJECT_FIELDS = "gid,name,archived,permalink_url,workspace.gid,workspace.name";
const SECTION_FIELDS = "gid,name,project.gid";
const TASK_FIELDS = [
  "gid", "name", "notes", "html_notes", "completed", "completed_at", "due_on", "due_at",
  "created_at", "modified_at", "permalink_url", "resource_subtype", "num_subtasks",
  "assignee.gid", "assignee.name", "parent.gid", "parent.name", "projects.gid", "projects.name",
  "memberships.project.gid", "memberships.project.name", "memberships.section.gid", "memberships.section.name",
  "custom_fields.gid", "custom_fields.name", "custom_fields.type", "custom_fields.display_value",
].join(",");
const STORY_FIELDS = "gid,type,resource_subtype,text,html_text,created_at,created_by.gid,created_by.name";
const ATTACHMENT_FIELDS = "gid,name,resource_subtype,host,created_at,download_url,permanent_url,view_url,parent.gid";

export class AsanaApiError extends Error {
  constructor(message, { status, kind = "api" } = {}) {
    super(message);
    this.name = "AsanaApiError";
    this.status = status;
    this.kind = kind;
  }
}

export function createAsanaClient({ token, fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL, maxPages = 100 }) {
  if (!token) throw new AsanaApiError("An Asana token is required.");

  const apiHeaders = { accept: "application/json", authorization: `Bearer ${token}` };
  const apiOrigin = new URL(baseUrl).origin;
  const redact = (text) => String(text).split(token).join("[REDACTED]");

  function apiUrl(path, query = {}) {
    const url = path.startsWith("http") ? new URL(path) : new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
    if (url.origin !== apiOrigin) throw new AsanaApiError(`Refusing Asana API request outside the configured Asana API origin: ${url.origin}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    return url;
  }

  async function parseError(response) {
    let detail = response.statusText || "request failed";
    try {
      const body = await response.json();
      if (Array.isArray(body?.errors)) detail = body.errors.map((error) => error.message).filter(Boolean).join("; ") || detail;
    } catch {}
    detail = redact(detail).replace(/[\r\n]+/g, " ").slice(0, 400);
    const retry = response.status === 429 && response.headers.get("retry-after")
      ? `; retry after ${response.headers.get("retry-after")} seconds`
      : "";
    return new AsanaApiError(`Asana API ${response.status}: ${detail}${retry}`, { status: response.status, kind: "api" });
  }

  async function request(path, query = {}) {
    let response;
    try {
      response = await fetchImpl(apiUrl(path, query), { headers: { ...apiHeaders } });
    } catch (error) {
      if (error instanceof AsanaApiError) throw error;
      throw new AsanaApiError(`Asana API network failure: ${redact(error?.message || error).slice(0, 400)}`);
    }
    if (!response.ok) throw await parseError(response);
    let envelope;
    try { envelope = await response.json(); } catch { throw new AsanaApiError("Asana API returned malformed response data."); }
    if (!envelope || typeof envelope !== "object" || !("data" in envelope)) throw new AsanaApiError("Asana API returned a malformed response envelope.");
    return envelope;
  }

  async function list(path, query = {}) {
    const values = [];
    let next = apiUrl(path, query);
    for (let page = 0; next; page += 1) {
      if (page >= maxPages) throw new AsanaApiError(`Asana pagination exceeded ${maxPages} pages.`);
      const envelope = await request(next.toString());
      if (!Array.isArray(envelope.data)) throw new AsanaApiError("Asana API returned malformed response data for a list.");
      values.push(...envelope.data);
      if (envelope.next_page?.uri) {
        try { next = new URL(envelope.next_page.uri); }
        catch { throw new AsanaApiError("Asana API returned a malformed pagination URI."); }
      } else next = null;
    }
    return values;
  }

  const client = {
    me: async () => (await request("users/me", { opt_fields: USER_FIELDS })).data,
    workspaces: () => list("workspaces", { opt_fields: "gid,name,is_organization" }),
    projects: (workspace) => list("projects", { workspace, archived: false, opt_fields: PROJECT_FIELDS }),
    sections: (projectGid) => list(`projects/${projectGid}/sections`, { opt_fields: SECTION_FIELDS }),
    sectionTasks: (sectionGid) => list(`sections/${sectionGid}/tasks`, { opt_fields: TASK_FIELDS }),
    task: async (gid) => (await request(`tasks/${gid}`, { opt_fields: TASK_FIELDS })).data,
    stories: (gid) => list(`tasks/${gid}/stories`, { opt_fields: STORY_FIELDS }),
    subtasks: (gid) => list(`tasks/${gid}/subtasks`, { opt_fields: TASK_FIELDS }),
    dependencies: (gid) => list(`tasks/${gid}/dependencies`, { opt_fields: TASK_FIELDS }),
    dependents: (gid) => list(`tasks/${gid}/dependents`, { opt_fields: TASK_FIELDS }),
    attachments: (gid) => list(`tasks/${gid}/attachments`, { opt_fields: ATTACHMENT_FIELDS }),
    attachment: async (gid) => (await request(`attachments/${gid}`, { opt_fields: ATTACHMENT_FIELDS })).data,
    async downloadAttachment(gid) {
      const attachment = await client.attachment(gid);
      const attachmentError = (message, status) => new AsanaApiError(message, { status, kind: "attachment" });
      if (attachment.host !== "asana") throw attachmentError(`Attachment ${gid} is not Asana-hosted and cannot be downloaded by this CLI.`);
      let downloadUrl;
      try { downloadUrl = new URL(attachment.download_url); } catch { throw attachmentError(`Attachment ${gid} does not expose a valid HTTPS download URL.`); }
      if (downloadUrl.protocol !== "https:") throw attachmentError(`Attachment ${gid} does not expose a valid HTTPS download URL.`);
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        let response;
        try { response = await fetchImpl(downloadUrl, { headers: {}, redirect: "manual" }); }
        catch (error) { throw attachmentError(`Attachment download network failure: ${redact(error?.message || error).slice(0, 400)}`); }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw attachmentError(`Attachment ${gid} returned a redirect without a Location header.`, response.status);
          let redirected;
          try { redirected = new URL(location, downloadUrl); } catch { throw attachmentError(`Attachment ${gid} returned an invalid redirect.`, response.status); }
          if (redirected.protocol !== "https:") throw attachmentError(`Attachment ${gid} did not return a valid HTTPS redirect.`, response.status);
          downloadUrl = redirected;
          continue;
        }
        if (!response.ok) throw attachmentError(`Attachment download failed with status ${response.status}.`, response.status);
        let bytes;
        try { bytes = new Uint8Array(await response.arrayBuffer()); }
        catch (error) { throw attachmentError(`Attachment download network failure while reading response: ${redact(error?.message || error).slice(0, 400)}`); }
        return {
          gid: attachment.gid,
          name: attachment.name || `${gid}.bin`,
          contentType: response.headers.get("content-type") || "application/octet-stream",
          bytes,
        };
      }
      throw attachmentError(`Attachment ${gid} exceeded 5 HTTPS redirects.`);
    },
  };
  return client;
}
