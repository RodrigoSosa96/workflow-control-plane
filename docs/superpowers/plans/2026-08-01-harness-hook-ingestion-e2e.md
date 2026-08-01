# Harness Hook Ingestion E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a broken generated Claude settings file or merged Codex `hooks.json` fail the suite, by executing what the generators produced the way each harness would and asserting the effect on a real run record.

**Architecture:** One new test file drives the generated hook configuration through `/bin/sh -c` as a subprocess, with the same `WORKFLOW_*` env a worker pane gets, against a temp state root — then asserts the run moved `LAUNCHING → RUNNING`. Both harnesses get a matching negative case built by pointing the generator at a wrong control-plane root, which is what proves the assertion cannot be defeated by the hooks' deliberate exit-zero-on-everything. No production code changes; the Herdr placeholder test is deleted.

**Design source:** [`../specs/2026-08-01-harness-hook-ingestion-e2e-design.md`](../specs/2026-08-01-harness-hook-ingestion-e2e-design.md). Read its "Why exit codes cannot be the assertion" section before starting — it is the constraint that shapes every test here.

**Tech Stack:** Node.js ESM (>= 22.18), zero runtime dependencies, Node test runner, `node:child_process`.

## Global Constraints

- **Assert the run record, never the exit code.** `hooks/claude-lifecycle.mjs` and `hooks/codex-lifecycle.mjs` both wrap their whole body in `try {} catch {}` and end with `process.exitCode = 0`. A hook that does nothing is indistinguishable from one that worked, by exit code alone.
- **Execute the generated string through a shell.** Both generators double-quote the absolute script path specifically so a shell keeps it one argument; importing `main()` and calling it cannot observe that. `/bin/sh -c "<command>"`, as the harness runs it.
- **Read the generator's output; never restate the command.** The test walks `buildClaudeWorkerSettings(...)`'s and `ensureCodexWorkerHooks(...)`'s output for the command to run. A literal copy would be a fourth definition and would not follow the generator when it changes.
- **Never touch the developer's real state.** Every path written is under a `mkdtemp` root removed in `t.after`. The Codex case passes an explicit `hooksPath` under that root and must never read or write the real `~/.codex/hooks.json`.
- **Degrade, don't lie.** If `/bin/sh` or `node` cannot be resolved, skip with a named reason rather than failing or vacuously passing.
- **No production code changes.** If a test reveals a real defect in a generator or hook, that is a genuine finding: stop and report it rather than adjusting the test.
- **Do not change any existing hook test.** The in-process tests keep covering hook bodies; this file covers only ingestion.
- Zero new dependencies. Every task ends with its covering tests passing and `npm test` green. Baseline before Task 1: **921 tests, 920 pass, 1 skip** (the Herdr placeholder, deleted in Task 3).

## Reference: what the code does today

- `buildClaudeWorkerSettings({controlPlaneRoot})` (`src/workflow/harnesses.js`) returns `{hooks, statusLine, permissions}` where `hooks[event]` is `[{hooks: [{type: "command", command: 'node "<root>/hooks/claude-lifecycle.mjs" <event>'}]}]`, for each event in `CLAUDE_WORKER_HOOKS` (`["UserPromptSubmit", "Stop", "SessionEnd"]`).
- `ensureCodexWorkerHooks({hooksPath, controlPlaneRoot})` (`src/workflow/codex-hooks.js`) merges the same shape into a `hooks.json` at `hooksPath`, one entry per `CODEX_WORKER_HOOK_EVENTS` (same three events), each `{owner, hooks: [{type: "command", command, timeout: 10}]}`.
- Both hook entrypoints read the event from `process.argv[2]` and a JSON payload from stdin.
- `runLifecycleHook` (`hooks/lib/lifecycle-hook-core.mjs:81`) drives `LAUNCHING → RUNNING` on `UserPromptSubmit`, discriminating a first prompt from a continuation via persisted markers rather than run state.
- `runEnv(run, harness)` (`src/workflow/harnesses.js`) produces exactly the `WORKFLOW_*` set a worker pane receives. Use it — do not hand-list env keys.
- `test/workflow-claude-lifecycle-hook.test.js:27-28` shows the run fixture this plan reuses: `store.create({harness, profileName, generation: 1})` then `store.update(id, () => ({state: RUN_STATES.LAUNCHING}))`.

## File Structure

- Create: `test/workflow-hook-ingestion.test.js` — all four ingestion tests plus the shared subprocess helper.
- Modify: `test/workflow-harnesses.test.js` — the `PI_WORKER_EXTENSIONS` existence/import assertion (it already owns `harnesses.js` coverage).
- Delete: `test/workflow-herdr-smoke.test.js`.
- Modify: `README.md` or `scripts/smoke-workflow-fixture.js`'s header comment — record where live Herdr verification lives, wherever the repo already documents the smoke script.
- Modify: `ROADMAP.md` — close out 1.6.

---

### Task 1: Claude settings ingestion, positive and negative

**Files:**
- Create: `test/workflow-hook-ingestion.test.js`

**Interfaces:** the shared helper both harnesses use, defined once at the top of the file:

```js
// Run a generated hook command exactly as a harness would: through a shell, so the generators'
// double-quoting of the absolute script path is actually exercised, with the harness's JSON
// payload on stdin and the worker's WORKFLOW_* env. Resolves the captured output regardless of
// exit status -- the hooks always exit 0 by design, so the caller asserts on the run record, and
// the output is only for the failure message.
async function runHookCommand(command, { env, payload, timeoutMs = 20_000 }) {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify(payload ?? {}));
  });
}
```

`{ ...process.env, ...env }` is deliberate: the subprocess needs `PATH` to find `node`, and the test's own `WORKFLOW_*` values must win over anything inherited.

**The two tests.** The negative one is not optional and not a mutation step — it is permanent coverage, and it is the only thing that proves the positive test is not passing on a hook that silently did nothing:

- **Positive:** a run in `LAUNCHING`, the command taken from `buildClaudeWorkerSettings({controlPlaneRoot: CONTROL_PLANE_ROOT})`'s `hooks.UserPromptSubmit[0].hooks[0].command`, executed → the run reads back `RUNNING` at generation 1.
- **Negative:** the same, with the settings generated for a control-plane root that has no `hooks/` directory (a temp dir) → the run is still `LAUNCHING`. Include the captured stdout/stderr in the assertion message.

**Steps:**

- [ ] **Step 1: Write the skip guard and the helper.** Guard on `/bin/sh` being present and `process.execPath` being resolvable; `t.skip("this host cannot run a shell-invoked hook subprocess")` rather than failing. Follow the degrade pattern in `test/workflow-hook-ownership.test.js`.

- [ ] **Step 2: Write the positive test.**

```js
test("the generated Claude settings' UserPromptSubmit hook, run as the harness runs it, drives LAUNCHING to RUNNING", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "workflow-hook-ingestion-claude-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  const store = createRunStore({ stateRoot });
  const created = await store.create({ harness: "claude", profileName: "claude-worker", generation: 1 });
  await store.update(created.id, () => ({ state: RUN_STATES.LAUNCHING }));
  const run = await store.read(created.id);

  const settings = buildClaudeWorkerSettings({ controlPlaneRoot: CONTROL_PLANE_ROOT });
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;

  const result = await runHookCommand(command, {
    env: runEnv({ ...run, stateRoot, controlPlaneBin: join(CONTROL_PLANE_ROOT, "bin", "workflow.js") }, "claude"),
    payload: { session_id: "s-1", hook_event_name: "UserPromptSubmit" },
  });

  const after = await store.read(created.id);
  assert.equal(
    after.state,
    RUN_STATES.RUNNING,
    `the generated settings' hook did not advance the run. command: ${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.equal(after.generation, 1);
});
```

Check `runEnv`'s required fields against `src/workflow/harnesses.js` before writing this — it asserts on `run.id`, `run.directory`, `run.stateRoot` and `run.controlPlaneBin`, so the object passed must carry them. If `store.create` already returns them, pass the run through unchanged rather than spreading extras.

- [ ] **Step 3: Run it and confirm it passes.** `node --test test/workflow-hook-ingestion.test.js`. If it fails, that is a real finding about the generated settings — stop and report it rather than adjusting the test.

- [ ] **Step 4: Write the negative test** — same shape, but `buildClaudeWorkerSettings({ controlPlaneRoot: <a temp dir with no hooks/> })`, asserting the run is still `LAUNCHING` afterward. This is what proves the positive test is not satisfied by a no-op: the command still exits 0 (node fails to find the module, the shell reports it, nothing throws into the test), and only the run record tells the difference.

- [ ] **Step 5: Write the quoting test.** Create a temp directory whose name contains a space, copy or symlink the repo's `hooks/` directory under it, generate settings for that root, and assert the hook still advances the run. This pins the property the generator's own comment claims. If copying the whole `hooks/` tree is awkward, a symlink to the real one is fine — the point is the *root path* containing a space, not the file contents.

- [ ] **Step 6: Run the file, then `npm test`.**

- [ ] **Step 7: Commit.**

```bash
git add test/workflow-hook-ingestion.test.js
git commit -m "test: execute the generated Claude settings' hook the way the harness does"
```

---

### Task 2: Codex hooks.json ingestion, positive and negative

**Files:**
- Modify: `test/workflow-hook-ingestion.test.js` (extend)

**Interfaces:** reuses Task 1's `runHookCommand` unchanged. The difference is the path in: Codex's config is *merged into a shared file*, so the test goes through `ensureCodexWorkerHooks({ hooksPath, controlPlaneRoot })` against a temp `hooksPath`, then reads that file back and executes what it finds. That covers the read-merge-write path, not just the pure `mergeCodexWorkerHooks`.

**Steps:**

- [ ] **Step 1: Write the positive test** — mirror Task 1's shape with `harness: "codex"`, `profileName: "codex-worker"`:

```js
  const hooksPath = join(stateRoot, "codex-home", "hooks.json");
  await ensureCodexWorkerHooks({ hooksPath, controlPlaneRoot: CONTROL_PLANE_ROOT });
  const merged = JSON.parse(await readFile(hooksPath, "utf8"));
  const group = merged.hooks.UserPromptSubmit.find((entry) => entry.owner === "workflow-control-plane:codex-lifecycle");
  const command = group.hooks[0].command;
```

Find the workflow's own group by its `owner` marker rather than by index — `mergeCodexWorkerHooks` preserves foreign entries ahead of it, so index 0 is not guaranteed to be ours. Read the marker's value from `src/workflow/codex-hooks.js` rather than retyping it if it is exported; if it is not exported, note in your report that the test hardcodes it and why.

- [ ] **Step 2: Run it and confirm it passes.** A failure here is a real finding about the merge — report, do not adjust.

- [ ] **Step 3: Write the negative test** — `ensureCodexWorkerHooks` with a control-plane root that has no `hooks/`, asserting the run stays `LAUNCHING`.

- [ ] **Step 4: Assert the real `~/.codex/hooks.json` was never touched.** The cheapest honest form: assert the `hooksPath` the test passed is under the temp root, and that `ensureCodexWorkerHooks` is never called without an explicit `hooksPath` anywhere in this file. If you can additionally stat the real path before and after and compare, do — but do not create it if it does not exist.

- [ ] **Step 5: Run the file, then `npm test`.**

- [ ] **Step 6: Commit.**

```bash
git add test/workflow-hook-ingestion.test.js
git commit -m "test: execute the merged Codex hooks.json entry the way the harness does"
```

---

### Task 3: Pi extension paths, and retire the Herdr placeholder

**Files:**
- Modify: `test/workflow-harnesses.test.js`
- Delete: `test/workflow-herdr-smoke.test.js`
- Modify: wherever the repo documents `scripts/smoke-workflow-fixture.js` (check `README.md` first, then the script's own header comment)

**Interfaces:** no production change.

**Why the placeholder goes rather than gets implemented:** its body is `throw new Error("Live Herdr smoke not implemented in automated suite")`, gated behind `WORKFLOW_RUN_LIVE_HERDR_SMOKE=1`. Enabling the flag cannot make it pass, so the flag is a trap and the file advertises coverage that does not exist. Live Herdr verification already exists in `scripts/smoke-workflow-fixture.js --real`, behind a TTY gate and a typed confirmation. Deleting it also takes the suite to zero skips.

**Steps:**

- [ ] **Step 1: Write the Pi extension test** in `test/workflow-harnesses.test.js`:

```js
// Pi loads these in-process via --extension, so their ingestion cannot be exercised without
// running Pi (that stays with the --real canary). What IS testable is Pi's share of the same
// broken-path failure class the Claude and Codex ingestion tests cover: an extension file moved
// or renamed leaves PI_WORKER_EXTENSIONS pointing at nothing, and every launch wires a flag at
// a path that does not exist.
test("every PI_WORKER_EXTENSIONS path exists and can be imported", async () => {
  assert.ok(PI_WORKER_EXTENSIONS.length > 0);
  for (const path of PI_WORKER_EXTENSIONS) {
    assert.equal(existsSync(path), true, `PI_WORKER_EXTENSIONS points at a missing file: ${path}`);
    await import(pathToFileURL(path).href);
  }
});
```

The `import` matters as much as the existence check: these are `.ts` files run through Node's native type stripping, so a syntax error or a broken import inside one is exactly the silent failure this catches. Note that importing them runs their module scope — check first that neither extension does anything at module scope beyond declarations (both build a memoized ownership reader, which spawns nothing until called; confirm that is still true before relying on it, and say so in your report).

- [ ] **Step 2: Delete `test/workflow-herdr-smoke.test.js`.**

- [ ] **Step 3: Record where live Herdr verification lives.** Find where the repo documents the smoke script (`README.md`'s smoke/verification section, or the script's header) and add one sentence: live Herdr verification is `npm run smoke:fixture -- --real --agent <harness> --keep`, which requires a TTY and a typed confirmation, and there is deliberately no automated equivalent. Do not invent a new documentation section if one already exists.

- [ ] **Step 4: Run `npm test` and confirm the suite reports zero skips.** State the exact numbers in your report.

- [ ] **Step 5: Commit.**

```bash
git add test/workflow-harnesses.test.js README.md
git rm test/workflow-herdr-smoke.test.js
git commit -m "test: pin the Pi extension paths; retire the unimplementable Herdr placeholder"
```

---

### Task 4: Close out the roadmap

**Files:**
- Modify: `ROADMAP.md`

**Interfaces:** documentation only, in **Spanish** (code identifiers stay in English). Read the 1.1c and 1.3 entries first — they are the model for register and density. `npm test` must stay green (`test/docs.test.js` and `test/workflow-docs.test.js` read repository docs).

**Steps:**

- [ ] **Step 1: Mark 1.6 done** — `- [x]` with its commit range, in the Fase 1 list.
- [ ] **Step 2: Add a progress-table row** — date, item, commit range, final suite count, and what changed: the generated Claude settings and the merged Codex `hooks.json` are now executed through a shell as the harness runs them, asserted on the run record rather than on an exit code, with a negative case per harness; the Pi extension paths are pinned; the Herdr placeholder is gone.
- [ ] **Step 3: State the reason the negative cases exist**, plainly: both hooks exit 0 on every failure by design, so a positive-only test could have been satisfied by a hook that did nothing. That is why each harness has a case that generates against a wrong control-plane root and asserts the run did *not* move.
- [ ] **Step 4: Record what is still not covered** — Pi's actual `--extension` ingestion, which needs a real Pi, and live Herdr, which needs a running Herdr; both stay with `scripts/smoke-workflow-fixture.js --real`. Do not let the entry imply the lane is fully covered.
- [ ] **Step 5: Repoint the ordered list** — 1.6 struck through and complete; **1.2** becomes the next step, now with its safety net in place. Note that the suite has zero skips.
- [ ] **Step 6: Run `npm test`**, then commit.

```bash
git add ROADMAP.md
git commit -m "docs: close out roadmap 1.6, harness hook ingestion e2e"
```

---

## Verification

The spec's nine Verification Strategy items map to these tasks:

| Spec item | Task |
|---|---|
| 1 (Claude settings drives LAUNCHING→RUNNING) | Task 1 |
| 2 (Codex hooks.json the same) | Task 2 |
| 3 (both fail against a broken generator) | Tasks 1 and 2 — permanent negative tests, not one-off mutations |
| 4 (quoting survives a root with a space) | Task 1 |
| 5 (real `~/.codex/hooks.json` untouched) | Task 2 |
| 6 (`PI_WORKER_EXTENSIONS` exist and import) | Task 3 |
| 7 (placeholder deleted, zero skips) | Task 3 |
| 8 (no existing hook test changes) | Tasks 1-3 — assert by diff |
| 9 (`npm test` green) | every task |

After Task 4, run a final review of the whole branch diff against the spec before merging, as items 1.1, 1.1b, 1.1c, 1.3 and 1.4 each did.
