import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createGitAdapter } from "../src/workflow/git.js";
import { createProcessRunner } from "../src/workflow/process.js";
import { RUN_STATES } from "../src/workflow/run-state.js";
import { createRunStore } from "../src/workflow/run-store.js";
import {
  HANDOFF_LIMITS,
  readCurrentResult,
  submitHandoff,
  validateHandoffInput,
} from "../src/workflow/handoff.js";

const execFileAsync = promisify(execFile);
const RUN_ID = "44444444-4444-4444-8444-444444444444";

async function gitExec(cwd, args) {
  return await execFileAsync("git", args, { cwd });
}

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-handoff-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "state");
}

async function createDisposableRepo(t) {
  const root = await mkdtemp(join(tmpdir(), "workflow-handoff-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repoPath = join(root, "repo");
  await mkdir(repoPath);
  await gitExec(root, ["init", "--initial-branch=main", repoPath]);
  await gitExec(repoPath, ["config", "user.name", "Workflow Tests"]);
  await gitExec(repoPath, ["config", "user.email", "workflow@example.test"]);
  await mkdir(join(repoPath, "src"));
  await writeFile(join(repoPath, "src", "example.js"), "export const value = 1;\n");
  await gitExec(repoPath, ["add", "src/example.js"]);
  await gitExec(repoPath, ["commit", "-m", "initial"]);

  return { root, repoPath };
}

async function createRunningRun(t, { repositories, tickets = ["A-1"], generation = 1 } = {}) {
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID });
  const created = await store.create({
    projectAlias: "ocr",
    primaryTicket: tickets[0],
    relatedTickets: tickets.slice(1),
    tickets,
    repositories,
    generation,
    state: RUN_STATES.PLANNED,
  });

  await store.update(created.id, () => ({ state: RUN_STATES.LAUNCHING }));
  await store.update(created.id, () => ({ state: RUN_STATES.RUNNING }));

  return { store, run: await store.read(created.id) };
}

function ticket(id, status = "completed") {
  return { id, status, evidence: ["node --test passed"] };
}

function validInput(overrides = {}) {
  return {
    version: 1,
    status: "completed",
    summary: "Implemented and verified the assignment.",
    tickets: [ticket("A-1")],
    changedFiles: ["src/example.js"],
    verification: [{ command: "node --test", status: "passed", summary: "1 test passed" }],
    decisions: [],
    concerns: [],
    nextAction: "Request code review",
    ...overrides,
  };
}

function expected(overrides = {}) {
  return {
    runId: RUN_ID,
    generation: 1,
    tickets: ["A-1"],
    repositories: [{ id: "app" }],
    ...overrides,
  };
}

async function fileMode(path) {
  return (await stat(path)).mode & 0o777;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test("validates semantic input and replaces caller identity with expected values", () => {
  const normalized = validateHandoffInput(validInput({
    runId: "model-claimed-run",
    generation: 99,
  }), expected({ generation: 7 }));

  assert.equal(normalized.version, 1);
  assert.equal(normalized.runId, RUN_ID);
  assert.equal(normalized.generation, 7);
  assert.equal(normalized.status, "completed");
  assert.deepEqual(normalized.tickets.map((entry) => entry.id), ["A-1"]);
  assert.deepEqual(normalized.repositories, [{ id: "app", changedFiles: ["src/example.js"] }]);
  assert.equal(Object.hasOwn(normalized, "changedFiles"), false);
});

test("requires the exact expected ticket set without duplicates or omissions", () => {
  const twoTickets = expected({ tickets: ["A-1", "A-2"] });
  const normalized = validateHandoffInput(validInput({
    tickets: [ticket("A-2"), ticket("A-1")],
  }), twoTickets);

  assert.deepEqual(normalized.tickets.map((entry) => entry.id), ["A-1", "A-2"]);

  assert.throws(
    () => validateHandoffInput(validInput({ tickets: [ticket("A-1")] }), twoTickets),
    /ticket/i,
  );
  assert.throws(
    () => validateHandoffInput(validInput({ tickets: [ticket("A-1"), ticket("A-1")] }), twoTickets),
    /duplicate|ticket/i,
  );
});

test("rejects unknown repositories and unsafe changed-file paths", () => {
  const unknownRepository = validInput({
    repositories: [{ id: "secret-repo", changedFiles: ["src/example.js"] }],
  });
  delete unknownRepository.changedFiles;

  assert.throws(
    () => validateHandoffInput(unknownRepository, expected()),
    /repository/i,
  );

  for (const path of ["/etc/passwd", "../secret.txt", "src/../secret.txt"]) {
    assert.throws(
      () => validateHandoffInput(validInput({ changedFiles: [path] }), expected()),
      /path|traversal|absolute/i,
    );
  }
});

test("rejects unknown statuses and oversized handoff fields without leaking raw text", () => {
  assert.throws(
    () => validateHandoffInput(validInput({ status: "done" }), expected()),
    /status/i,
  );
  assert.throws(
    () => validateHandoffInput(validInput({ tickets: [ticket("A-1", "done")] }), expected()),
    /status/i,
  );
  assert.throws(
    () => validateHandoffInput(validInput({ verification: [{ command: "node --test", status: "unknown", summary: "ok" }] }), expected()),
    /status/i,
  );

  assert.throws(
    () => validateHandoffInput(validInput({ summary: `DO-NOT-LEAK-${"x".repeat(HANDOFF_LIMITS.summary)}` }), expected()),
    (error) => {
      assert.match(error.message, /summary|limit|size/i);
      assert.doesNotMatch(error.message, /DO-NOT-LEAK/);
      assert.ok(error.message.length < 300);
      return true;
    },
  );

  const tooManyTicketIds = Array.from({ length: HANDOFF_LIMITS.tickets + 1 }, (_, index) => `A-${index + 1}`);
  assert.throws(
    () => validateHandoffInput(validInput({
      tickets: tooManyTicketIds.map((id) => ticket(id)),
    }), expected({ tickets: tooManyTicketIds })),
    /ticket|limit/i,
  );

  assert.throws(
    () => validateHandoffInput(validInput({
      changedFiles: Array.from({ length: HANDOFF_LIMITS.changedFiles + 1 }, (_, index) => `src/file-${index}.js`),
    }), expected()),
    /changed files|limit/i,
  );

  assert.throws(
    () => validateHandoffInput(validInput({
      decisions: Array.from({ length: 70 }, () => "x".repeat(HANDOFF_LIMITS.itemText)),
    }), expected()),
    /bytes|size|limit/i,
  );
});

test("submitHandoff writes an authoritative private result and readCurrentResult accepts it", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });
  const input = validInput({
    runId: "model-claimed-run",
    generation: 99,
    repositories: [{
      id: "app",
      changedFiles: ["src/example.js"],
      head: "not-authoritative",
      worktreeFingerprint: "sha256:not-authoritative",
    }],
  });
  delete input.changedFiles;

  const result = await submitHandoff({ store, git, runId: run.id, generation: 1, input });

  assert.equal(result.runId, run.id);
  assert.equal(result.generation, 1);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.tickets.map((entry) => entry.id), ["A-1"]);
  assert.equal(result.repositories.length, 1);
  assert.equal(result.repositories[0].id, "app");
  assert.notEqual(result.repositories[0].head, "not-authoritative");
  assert.notEqual(result.repositories[0].worktreeFingerprint, "sha256:not-authoritative");
  assert.match(result.repositories[0].worktreeFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.repositories[0].changedFiles, ["src/example.js"]);

  const resultPath = join(run.directory, "result.json");
  const archivePath = join(run.directory, "results", "generation-1.json");
  assert.deepEqual(await readJson(resultPath), result);
  assert.deepEqual(await readJson(archivePath), result);
  assert.equal(await fileMode(resultPath), 0o600);
  assert.equal(await fileMode(archivePath), 0o600);
  assert.equal(await fileMode(join(run.directory, "results")), 0o700);
  assert.equal((await readdir(run.directory)).some((name) => name.startsWith(".result.json.")), false);
  assert.equal((await readdir(join(run.directory, "results"))).some((name) => name.startsWith(".generation-1.json.")), false);

  const storedRun = await store.read(run.id);
  assert.equal(storedRun.state, RUN_STATES.COMPLETED);
  assert.equal(storedRun.resultGeneration, 1);
  assert.equal(storedRun.resultStatus, "completed");

  const current = await readCurrentResult({ store, git, runId: run.id });
  assert.equal(current.status, "completed");
  assert.deepEqual(current.result, result);
});

test("submitHandoff rejects stale generations before creating result artifacts", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });

  await assert.rejects(
    () => submitHandoff({ store, git, runId: run.id, generation: 2, input: validInput() }),
    /generation/i,
  );
  await assert.rejects(
    () => stat(join(run.directory, "result.json")),
    (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR",
  );
  assert.equal((await store.read(run.id)).state, RUN_STATES.RUNNING);
});

test("submitHandoff refuses non-running runs without creating result artifacts", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const stateRoot = await tempStateRoot(t);
  const store = createRunStore({ stateRoot, randomUUID: () => RUN_ID });
  const run = await store.create({
    projectAlias: "ocr",
    primaryTicket: "A-1",
    relatedTickets: [],
    tickets: ["A-1"],
    repositories: [{ id: "app", path: repoPath }],
    generation: 1,
    state: RUN_STATES.PLANNED,
  });
  const git = createGitAdapter({ runner: createProcessRunner() });

  await assert.rejects(
    () => submitHandoff({ store, git, runId: run.id, generation: 1, input: validInput() }),
    /state|transition|handoff/i,
  );
  await assert.rejects(
    () => stat(join(run.directory, "result.json")),
    (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR",
  );
  assert.equal((await store.read(run.id)).state, RUN_STATES.PLANNED);
});

test("readCurrentResult refuses current-looking artifacts that were not registered in the run store", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });
  const fingerprint = await git.fingerprint({ cwd: repoPath });
  const forged = {
    version: 1,
    runId: run.id,
    generation: 1,
    status: "completed",
    summary: "Forged but structurally current.",
    tickets: [ticket("A-1")],
    repositories: [{
      id: "app",
      head: fingerprint.head,
      branch: fingerprint.branch,
      dirty: fingerprint.dirty,
      entries: fingerprint.entries,
      worktreeFingerprint: fingerprint.digest,
      changedFiles: ["src/example.js"],
    }],
    verification: [{ command: "node --test", status: "passed", summary: "1 test passed" }],
    decisions: [],
    concerns: [],
    nextAction: "Request code review",
  };
  await writeFile(join(run.directory, "result.json"), `${JSON.stringify(forged, null, 2)}\n`, { mode: 0o600 });

  const current = await readCurrentResult({ store, git, runId: run.id });

  assert.equal(current.status, RUN_STATES.RESULT_STALE);
  assert.notEqual(current.status, "completed");
  assert.ok(current.errors.some((message) => /store|registered|canonical/i.test(message)));
  assert.equal((await store.read(run.id)).state, RUN_STATES.RESULT_STALE);
});

test("readCurrentResult marks changed fingerprints stale without deleting archived results", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });
  const result = await submitHandoff({ store, git, runId: run.id, generation: 1, input: validInput() });
  const archivePath = join(run.directory, "results", "generation-1.json");
  const archivedBefore = await readFile(archivePath, "utf8");

  await writeFile(join(repoPath, "src", "example.js"), "export const value = 2;\n");
  const stale = await readCurrentResult({ store, git, runId: run.id });

  assert.equal(stale.status, RUN_STATES.RESULT_STALE);
  assert.notEqual(stale.status, "completed");
  assert.deepEqual(stale.result, result);
  assert.ok(stale.errors.some((message) => /fingerprint|stale/i.test(message)));
  assert.equal((await store.read(run.id)).state, RUN_STATES.RESULT_STALE);
  assert.equal(await readFile(archivePath, "utf8"), archivedBefore);
  assert.equal(await fileMode(archivePath), 0o600);
});

test("readCurrentResult rejects a registered result when current artifact bytes are tampered", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });
  const result = await submitHandoff({ store, git, runId: run.id, generation: 1, input: validInput() });
  const resultPath = join(run.directory, "result.json");
  const archivePath = join(run.directory, "results", "generation-1.json");
  const archiveBefore = await readFile(archivePath, "utf8");
  const canonicalBytes = await readFile(resultPath);

  const storedRun = await store.read(run.id);
  assert.equal(storedRun.resultArtifactDigest, sha256Digest(canonicalBytes));

  const tampered = { ...result, summary: "Tampered after registration while fingerprints still match." };
  await writeFile(resultPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });

  const current = await readCurrentResult({ store, git, runId: run.id });

  assert.equal(current.status, RUN_STATES.RESULT_STALE);
  assert.notEqual(current.status, "completed");
  assert.deepEqual(current.result, tampered);
  assert.ok(current.errors.some((message) => /digest|artifact|tamper|stale/i.test(message)));
  assert.equal((await store.read(run.id)).state, RUN_STATES.RESULT_STALE);
  assert.equal(await readFile(archivePath, "utf8"), archiveBefore);
});

test("readCurrentResult marks a missing current artifact stale before returning", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });
  await submitHandoff({ store, git, runId: run.id, generation: 1, input: validInput() });
  const archivePath = join(run.directory, "results", "generation-1.json");
  const archivedBefore = await readFile(archivePath, "utf8");

  await rm(join(run.directory, "result.json"), { force: true });
  const current = await readCurrentResult({ store, git, runId: run.id });

  assert.equal(current.status, RUN_STATES.RESULT_STALE);
  assert.notEqual(current.status, "completed");
  assert.ok(current.errors.some((message) => /missing|no current result/i.test(message)));
  assert.equal((await store.read(run.id)).state, RUN_STATES.RESULT_STALE);
  assert.equal(await readFile(archivePath, "utf8"), archivedBefore);
});

test("readCurrentResult marks a malformed current artifact stale before returning", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });
  await submitHandoff({ store, git, runId: run.id, generation: 1, input: validInput() });
  const resultPath = join(run.directory, "result.json");
  const archivePath = join(run.directory, "results", "generation-1.json");
  const archivedBefore = await readFile(archivePath, "utf8");

  await writeFile(resultPath, "{ this is not json\n", { mode: 0o600 });
  const current = await readCurrentResult({ store, git, runId: run.id });

  assert.equal(current.status, RUN_STATES.RESULT_STALE);
  assert.notEqual(current.status, "completed");
  assert.ok(current.errors.some((message) => /malformed|invalid/i.test(message)));
  assert.equal((await store.read(run.id)).state, RUN_STATES.RESULT_STALE);
  assert.equal(await readFile(archivePath, "utf8"), archivedBefore);
});

test("readCurrentResult persists result-stale for needs-input and failed handoffs", async (t) => {
  for (const [status, expectedState] of [
    ["needs-input", RUN_STATES.NEEDS_INPUT],
    ["failed", RUN_STATES.FAILED],
  ]) {
    const { repoPath } = await createDisposableRepo(t);
    const { store, run } = await createRunningRun(t, {
      repositories: [{ id: "app", path: repoPath }],
    });
    const git = createGitAdapter({ runner: createProcessRunner() });
    await submitHandoff({
      store,
      git,
      runId: run.id,
      generation: 1,
      input: validInput({
        status,
        summary: `Run finished with ${status}.`,
        tickets: [ticket("A-1", status)],
        nextAction: "Review stale result handling",
      }),
    });
    assert.equal((await store.read(run.id)).state, expectedState);

    await writeFile(join(repoPath, "src", "example.js"), `export const status = ${JSON.stringify(status)};\n`);
    const current = await readCurrentResult({ store, git, runId: run.id });

    assert.equal(current.status, RUN_STATES.RESULT_STALE, status);
    assert.equal((await store.read(run.id)).state, RUN_STATES.RESULT_STALE, status);
  }
});

test("readCurrentResult fails closed when stale state cannot be persisted", async (t) => {
  const { repoPath } = await createDisposableRepo(t);
  const { store, run } = await createRunningRun(t, {
    repositories: [{ id: "app", path: repoPath }],
  });
  const git = createGitAdapter({ runner: createProcessRunner() });
  await submitHandoff({ store, git, runId: run.id, generation: 1, input: validInput() });
  await writeFile(join(repoPath, "src", "example.js"), "export const value = 3;\n");
  const failingStore = {
    read: (...args) => store.read(...args),
    async update() {
      throw new Error("forced result-stale update failure");
    },
  };

  await assert.rejects(
    () => readCurrentResult({ store: failingStore, git, runId: run.id }),
    /forced result-stale update failure/,
  );
  assert.equal((await store.read(run.id)).state, RUN_STATES.COMPLETED);
});
