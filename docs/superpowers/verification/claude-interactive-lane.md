# Claude Interactive Lane — Verification (Task 7)

> The Claude interactive lane lets `workflow launch` start a real, long-lived
> `claude` process (via the `claude-worker` profile with `mode: interactive`)
> instead of the headless `stream-json` supervisor path, wired with the same
> lifecycle/observability contract the Pi interactive lane established:
> `--session-id`/`--settings` inject the control plane's hooks + statusLine
> (`buildClaudeWorkerSettings`), and `resume`/`close` recover it exactly like a
> Pi session via the generalized `SESSION_ADAPTERS.claude` transport.
>
> Same probe-first methodology as `pi-recovery-lane.md`: everything provable
> from source, `--help`, and a `--dry-run` launch is confirmed below with no
> live Claude session and no tokens spent. Only the runtime unknowns that
> require an actual interactive `claude` process (hook firing order, exit
> keys, native resume) are deferred to the human/TTY probe in §3, and the
> full wired-up CLI cycle to the e2e in §4 — both **NOT** run by the
> implementer agent (see the plan's "Manual gates").

## 1. Fixture path — confirmed via `--dry-run` (2026-07-26, no live Claude needed)

Confirms `createWorkflowFixture` (`src/workflow/fixture.js`) already emits a
`claude-worker` profile (`harness: claude`, `command: claude`, default
`mode: stream-json` — valid only because `fixture_mode: true` widens
`MODES_BY_HARNESS.claude` to include `stream-json`, per
`src/workflow/registry.js`), and that patching its `mode` to `interactive`
makes a dry-run launch select the real interactive Claude argv (hooks +
statusLine `--settings` wiring), not the fixture's headless `stream-json`
path. **No change to `src/workflow/fixture.js` was needed** — the profile
already existed exactly as required.

### Fixture build

```bash
cd /home/you/projects/personal/workflows/.worktrees/claude-interactive-lane
node -e '
import("./src/workflow/fixture.js").then(async ({ createWorkflowFixture }) => {
  const root = "/tmp/workflow-claude-lane-e2e-" + Date.now();
  const fixture = await createWorkflowFixture({ root, packageRoot: process.cwd() });
  console.log(JSON.stringify({ root: fixture.root, registryPath: fixture.registryPath, stateRoot: fixture.stateRoot }, null, 2));
});
'
```

This printed (this run):

```json
{
  "root": "/tmp/workflow-claude-lane-e2e-1785063495816",
  "registryPath": "/tmp/workflow-claude-lane-e2e-1785063495816/projects.yaml",
  "stateRoot": "/tmp/workflow-claude-lane-e2e-1785063495816/state"
}
```

Confirmed the generated `projects.yaml` already has:

```yaml
claude-worker:
  harness: claude
  command: claude
  mode: stream-json
  model: null
  arguments: []
  permission_mode: manual
```

### Patch `mode` to `interactive` + write a prompt

```bash
F=/tmp/workflow-claude-lane-e2e-1785063495816
sed -i 's/mode: stream-json/mode: interactive/' "$F/projects.yaml"   # only touches claude-worker's line
printf 'Greet once, then wait for further instructions.\n' > "$F/claude-prompt.txt"
```

### `--dry-run` launch (real CLI, real live Herdr — read-only, no side effects)

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent claude-worker --dry-run --prompt-file $F/claude-prompt.txt --format json > /tmp/claude-dryrun.json
echo "exit: $?"   # 0
```

Extracted from the JSON preview:

```json
"selection": { "profileName": "claude-worker", "harness": "claude", "command": "claude", "source": "explicit" },
"reconciliation.agent.profile": { "mode": "interactive", "permission_mode": "manual", "arguments": [], "model": null },
"reconciliation.operations[agent]": {
  "id": "agent", "kind": "agent.session.start", "phase": "start", "command": "claude",
  "sessionName": "fixture-single-FIX-101", "tabLabel": "agent"
},
"launchSpec.argv": [
  "claude", "--session-id", "<generated-native-session-id>",
  "--permission-mode", "manual",
  "--add-dir", "/tmp/workflow-claude-lane-e2e-1785063495816/state/<generated-run-id>",
  "--settings", "/tmp/workflow-claude-lane-e2e-1785063495816/state/<generated-run-id>/claude-worker-settings.json",
  "Read \"$WORKFLOW_RUN_DIR/assignment.md\". Complete the assignment. ..."
],
"approvalDigest": "sha256:c79549bdb6594a8f8ebac515e7232f7bb0d3c24ce4de1c3fdda84ab619814ebb"
```

**Confirmed: the interactive session lane is selected.** The plan-level op
(`id: "agent"`, `kind: "agent.session.start"`, `command: "claude"`) is
present exactly as expected (this part of the plan is harness-driven, not
mode-driven, so it appears the same for either mode — the mode-specific
signal is the `--settings` flag). The **decisive** signal that `mode:
interactive` actually selected the interactive lane (not the fixture's
`stream-json` supervisor path) is `--settings <run>/claude-worker-settings.json`
in `launchSpec.argv` — this only appears when `isClaudeInteractiveAgent()`
(`src/workflow/launch.js`) sees `mode === "interactive"`, and it is what
wires `buildClaudeWorkerSettings` (hooks + statusLine, `src/workflow/harnesses.js`)
into the real `claude` process.

For contrast, re-running the same dry-run against the **unpatched**
(`mode: stream-json`) registry drops `--settings` entirely:

```json
"argv": [
  "claude", "--session-id", "<generated-native-session-id>",
  "--permission-mode", "manual",
  "--add-dir", "/tmp/workflow-claude-lane-e2e-1785063495816/state/<generated-run-id>",
  "Read \"$WORKFLOW_RUN_DIR/assignment.md\". Complete the assignment. ..."
]
```

— and at real execute time (not dry-run), `fixture_mode: true` + `mode:
stream-json` routes through `isFixtureStreamJson()` in `src/workflow/launch.js`,
which never even runs `claude` directly — it spawns `workflow-worker.js` as a
plain process (`supervisor: true`) and drives Claude headlessly. So the two
signals (`--settings` present; not routed through the supervisor) together
are the confirmation that patching `mode: interactive` produces a genuine
interactive Claude launch.

### Cleanup

```bash
rm -rf /tmp/workflow-claude-lane-e2e-1785063495816
```

(done — the throwaway fixture above no longer exists on disk; the e2e in §4
builds its own.)

## 2. Verified facts (no probe needed)

- **Herdr reports a Claude agent's `agent_session` as a bare id**, not a path:
  `{ "kind": "id", "value": "<bare-uuid>" }` (source: `herdr:claude`). Live
  cross-check from this very environment's `herdr agent list` (2026-07-26,
  Herdr 0.7.5):
  ```json
  {"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"359ec1c8-dbbd-4b53-a5e8-817c611dc105"},"agent_status":"working","pane_id":"wD:pA", ...}
  ```
  and the matching session file is `~/.claude/projects/<munged-cwd>/359ec1c8-dbbd-4b53-a5e8-817c611dc105.jsonl` —
  the reported `value` **is** the bare filename stem, no prefix/suffix. This
  is why `SESSION_ADAPTERS.claude.sessionMatches` (`src/workflow/session-transport.js`)
  is `value === id` — unlike Pi, whose `agent_session.value` is a full
  `.jsonl` **path** the identity's UUID only appears inside.
- **`claude` supports `--session-id`, `--settings`, and `--resume`** (`claude --help`,
  v2.1.220):
  - `--session-id <uuid>` — "Use a specific session ID for the conversation
    (must be a valid UUID)"
  - `--settings <file-or-json>` — "Path to a settings JSON file ... to load
    additional settings from"
  - `-r, --resume [value]` — "Resume a conversation by session ID, or open
    interactive picker"
- **`herdr agent start --kind claude` works** — `claude` is a listed
  `--kind` value in `herdr agent start --help` (alongside `pi`, `codex`, …).
- **Sessions live at `~/.claude/projects/<munged-cwd>/<id>.jsonl`**, cwd-scoped
  (one directory per working directory, path separators munged to `-`) —
  confirmed by directory listing in this environment.
- **Default exit keys: `ctrl+d`.** This is Herdr's canonical key name
  (confirmed for Pi in `pi-recovery-lane.md`: `ctrl+d` with `+` works,
  tmux-style `C-d` is rejected) and is already the code's default for Claude
  too (`SESSION_ADAPTERS.claude.exitKeys = ["ctrl+d"]`). Whether the real
  `claude` process actually exits cleanly on `ctrl+d` (rather than e.g.
  prompting "press again to exit") is the one part of this that is **not**
  yet confirmed for Claude — that's probe item (a) below.

## 3. Probe section — runtime unknowns (human/TTY, real Claude, real tokens)

These need one live interactive `claude` process. Start it any way that's
convenient (e.g. `herdr agent start probe --kind claude --pane <pane>` in an
existing shell pane, or just run `claude` directly in a terminal Herdr is
tracking) — the Task-7 e2e in §4 below happens to also produce one, so it's
fine to fold this probe into that session instead of starting a second one.

- [ ] **(a) `ctrl+d` exits an idle Claude cleanly.**
  ```bash
  herdr agent list                          # find the claude agent; note pane_id; confirm agent_status: idle
  herdr agent send-keys <pane_id> ctrl+d
  herdr agent list                          # did the claude agent leave the list / process exit?
  ```
  If `ctrl+d` doesn't exit cleanly (e.g. it's swallowed, or Claude prompts
  "press ctrl+d again"), fall back to `/exit`:
  ```bash
  herdr pane send-text <pane_id> "/exit"
  herdr agent send-keys <pane_id> enter
  herdr agent list
  ```
  Record: which one worked, and whether it needed a repeat keypress.

- [ ] **(b) `claude --session-id <exact> --settings <file>` resumes native
  history AND reloads hooks + statusLine.** With a dead session's exact
  UUID and its regenerated `claude-worker-settings.json` (see §4 step 4 —
  this is exactly the `relaunchSession` argv in `src/workflow/commands.js`):
  ```bash
  claude --session-id <exact-uuid> --add-dir <run-directory> --settings <run-directory>/claude-worker-settings.json
  ```
  Inside the resumed session, confirm (1) the prior turn's greeting is in
  scrollback/history (not a fresh empty session), (2) the statusLine at the
  bottom renders `Workflow <id> | ...` (proves `--settings` was reloaded),
  and (3) a new prompt fires the hooks (see (c)).

- [ ] **(c) Which hooks fire, and a `Stop`-block continuation does NOT
  refire `UserPromptSubmit`.** The wired hooks are `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SessionEnd` (`CLAUDE_WORKER_HOOKS` in
  `src/workflow/harnesses.js`). `hooks/claude-lifecycle.mjs`'s `Stop` handler
  can return `{"decision":"block","reason":"..."}` to make Claude continue
  the turn instead of returning control (see `lifecycle.js`'s
  `MAX_STOP_ATTEMPTS = 2` — up to 2 auto-continuations before the run is
  marked `manual-handoff-required`). The code comment there already asserts
  "Claude does not fire `UserPromptSubmit` for a Stop-hook block
  continuation" — **this probe is what turns that from an assumption into a
  confirmed fact.** To check: add temporary logging (or `--debug hooks`) and
  watch which of the four events fire, in what order, across one greeting
  turn + at least one Stop-block continuation. Specifically confirm
  `UserPromptSubmit` does **not** fire again when Claude auto-continues after
  a `Stop` block — if it does, `runClaudeLifecycleHook`'s generation-bump
  logic (treating every non-first `UserPromptSubmit` as a new user follow-up)
  would misfire on an auto-continuation and needs a "continuation" source
  like the Pi extension has.

- [ ] **(d) `herdr agent list` reports the claude `agent_session` as
  `kind:"id"`, bare uuid — re-confirm against this run's own session** (not
  just the incidental cross-check in §2):
  ```bash
  herdr agent list | python3 -c "import sys,json; d=json.load(sys.stdin); print([a['agent_session'] for a in d['result']['agents'] if a['agent']=='claude'])"
  ```
  Confirm `kind` is `"id"` and `value` is the bare UUID matching the
  `--session-id` you launched with (no path, no prefix/suffix).

- [ ] **(e) `agent focus` / `tab focus` behave as they do for Pi.**
  ```bash
  herdr agent focus <pane_id>     # expect: the Claude pane itself comes forward
  herdr tab focus <tab_id>        # fallback: expect the tab raised, but (per the Pi
                                   # finding) possibly landing on a shell pane above
                                   # Claude rather than Claude itself
  ```
  Record whether Claude's `agent focus` behaves the same as Pi's (it should —
  `resume.js` and `relaunchSession` already call `herdr.focusAgent({ target: paneId })`
  unconditionally, not branching per harness).

### Findings (fill in after running)

- (a) exit key that worked: ____ (ctrl+d / /exit / other)
- (b) native history + settings reload: ____
- (c) hook firing order observed: ____ ; Stop-block refires UserPromptSubmit? ____ (yes/no)
- (d) `agent_session` shape observed: ____
- (e) `agent focus` vs `tab focus` behavior: ____
- Herdr version: ____ / Claude version: ____ / date: ____

## 4. Task-7 e2e — full CLI cycle with the Claude fixture (human/TTY, before merge)

Validates the **wired-up** interactive Claude lane end-to-end through the
`workflow` CLI: `launch` → identity survives → observability renders →
`resume` (live, focuses) → `close` (idle) → `resume` (dead, refuses) →
`resume --yes` (relaunch, resumes real history + reloads hooks/statusLine) →
`resume` (focuses the new pane). Mirrors `pi-recovery-lane.md`'s Task 7
e2e shape exactly, adapted for Claude's hook/settings wiring instead of
Pi's `--extension` flags.

**Token note:** unlike Pi (which just idles after one greeting turn), a
Claude worker whose `Stop` hook doesn't see a handoff will auto-continue up
to `MAX_STOP_ATTEMPTS = 2` times (the hook returns a `block` decision asking
it to write the handoff) before the run is marked
`manual-handoff-required` and Claude actually stops. With the prompt below
(explicitly told not to write a handoff), expect **one greeting turn plus up
to two short auto-continuations** — still cheap, but not a single turn like
Pi. You do not need to wait for `manual-handoff-required`; you can run
`close` the moment `herdr agent list` shows the agent `idle` at any point.

### Fixture (build your own — the §1 fixture was a throwaway, already deleted)

```bash
cd /home/you/projects/personal/workflows/.worktrees/claude-interactive-lane
F=/tmp/workflow-claude-lane-e2e-$(node -e 'console.log(Date.now())')
node -e '
import("./src/workflow/fixture.js").then(async ({ createWorkflowFixture }) => {
  await createWorkflowFixture({ root: process.env.F, packageRoot: process.cwd() });
});
'
sed -i 's/mode: stream-json/mode: interactive/' "$F/projects.yaml"   # patches claude-worker only
printf 'Greet the user in one short sentence, then wait. Do not read any files, do not write a handoff, and do not take any other action unless asked.\n' > "$F/claude-prompt.txt"
```

Compute the approval digest from the **CLI's own dry-run** (never a
programmatic `launchCommand` call — the two serialize options differently
and produce different digests):

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent claude-worker --dry-run --prompt-file $F/claude-prompt.txt
# copy the "Approval digest: sha256:..." line printed at the end
```

> **Robust alternative (no digest):** drop `--yes --approval-digest` below
> and confirm interactively — the CLI prints its own preview and asks
> `Proceed with workflow launch? [y/N]`, computing its own fresh digest, so
> there's no stale-digest risk:
> ```bash
> WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
>   --agent claude-worker --prompt-file $F/claude-prompt.txt   # then type: y
> ```

### 0. Launch

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent claude-worker --yes --approval-digest sha256:<paste-digest-here> \
  --prompt-file $F/claude-prompt.txt --format json
```

Capture the run id robustly (do not rely on `ls` — it may be aliased with
extra formatting flags in your shell):

```bash
export R=$(find $F/state -maxdepth 1 -mindepth 1 -type d -printf '%f\n')
echo "$R"
```

> **Note:** the launch report's top-level `status` may say `"partial"`
> cosmetically (a reconciliation-timing artifact seen in the Pi lane too, if
> Herdr hasn't settled the interactive readiness check by the moment the CLI
> reports back) — don't take that as a failure. Judge success by the two
> checks below: identity persisted + the agent actually alive in
> `herdr agent list`.

### 1. Identity survives the launch race

```bash
cat $F/state/$R/run.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('state:',d.get('state'));print(json.dumps(d.get('transportIdentity'),indent=2))"
# expect: transportIdentity.kind == "claude-session", with runId, sessionId, paneId, tabId, workspaceId, cwd
herdr agent list   # note the agent's pane_id / tab_id / agent_status; agent_session.value should equal sessionId
```

- [ ] `transportIdentity.kind == "claude-session"` and `sessionId` matches
  the id `herdr agent list` reports for that pane.

### 2. Observability line renders

```bash
PANE=<pane_id from step 1>
herdr pane read $PANE --lines 5
```

- [ ] The bottom of the pane shows the statusLine: `Workflow <shortId> | <phase> | claude | ...`
  (from `renderClaudeStatusLine` in `hooks/claude-statusline.mjs`) — proves
  the `--settings` statusLine wiring loaded in the real process.

### 3. `resume` a LIVE session → focus

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

- [ ] `{"command":"resume","runId":"…","action":"focused",…}` **and** the
  Claude pane itself (not a shell pane above it) comes to the foreground in
  Herdr (exercises `herdr agent focus <paneId>`).

### 4. `close` an IDLE session → graceful exit

Wait until `herdr agent list` shows the agent `idle`, then:

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js close $R --format json
herdr agent list   # the claude agent should be gone
```

- [ ] `{"command":"close","runId":"…","closed":true}` and the agent left
  `agent list` (confirms probe finding (a) — `ctrl+d` — wired end-to-end).
  If you got `{"closed":false,"reason":"working"}`, the agent was still
  mid-turn; wait and retry (fail-safe, never kills a working process).

### 5. `resume` a DEAD session WITHOUT `--yes` → reports, does not relaunch

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

- [ ] `{"command":"resume","runId":"…","action":"needs-confirmation","plan":"relaunch",…}`
  and **no** new pane/agent appears in `herdr agent list`.

### 6. `resume --yes` a DEAD session → relaunch WITH hooks/statusLine reload

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --yes --format json
herdr agent list   # a new claude agent should appear
```

- [ ] `{"command":"resume","runId":"…","action":"relaunched",…}`.
- [ ] In the new pane: **native session resumed** — the prior greeting is in
  scrollback, driven by `claude --session-id <exact>` (not `--continue`/`--last`).
- [ ] **Observability widget reappears** (statusLine renders again — proves
  `relaunchSession`'s regenerated `claude-worker-settings.json` reloaded, not
  a bare pane):
  ```bash
  cat $F/state/$R/run.json | python3 -c "import sys,json;d=json.load(sys.stdin);i=d['transportIdentity'];print('pane',i['paneId'],'tab',i['tabId'])"
  herdr pane read <new pane_id> --lines 5
  ```
- [ ] **Hooks reload:** send a follow-up prompt in the resumed pane and
  confirm the statusLine's phase/tokens update (proves `UserPromptSubmit` /
  telemetry hooks are live again, not just the statusLine binary).

### 7. `resume` again → focuses the NEW pane

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

- [ ] `action:"focused"` against the **new** pane/tab id from step 6 —
  proving the relaunched identity was persisted and re-observed.

### Cleanup

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js close $R || true
rm -rf $F
```

### Findings (e2e run, 2026-07-27, Herdr 0.7.5 / Claude Code 2.1.220)

Full cycle verified live against a real interactive Claude session. The e2e found
**6 real defects** (none catchable by the unit tests) — all fixed and re-verified:

- [x] **0–1. Identity survives:** state `completed` (Claude completed the handoff once
  the allowlist let it), `transportIdentity.kind == "claude-session"`, id OK.
- [x] **2. Observability:** telemetry produced (`phase`, `observability: reported`); the
  statusLine renders a real phase + the model — not stuck on "starting".
- [x] **3. resume LIVE → focused** Claude's own pane (`agent focus`).
- [x] **4. close IDLE → closed:true** and the worker actually exits.
- [x] **5. resume DEAD (no --yes) → needs-confirmation.**
- [x] **6. resume --yes → relaunched**, native history intact (resumed via `--resume`),
  statusLine + hooks reloaded, identity re-pointed at the new pane.
- [x] **7. resume again → focused the new pane.**

**Bugs found + fixed by this e2e:**

1. **Trust dialog stalls the worker** on a fresh worktree (Claude asks to trust the
   folder). Trust is keyed per-repo in `~/.claude.json`. Left as a **one-time manual
   accept per project** (semi-autonomous); pre-trust/skip is a documented opt-in.
2. **`dontAsk` auto-denied Write/Bash** → the worker couldn't submit the handoff and
   burned tokens on Stop-hook retry loops. FIX (`f197ad6`): `buildClaudeWorkerSettings`
   now emits a `permissions.allow` allowlist (`CLAUDE_WORKER_ALLOWED_TOOLS`) covering
   the worker's tools → zero denials → no wasted tokens.
3. **Generation inflated to 2** on the first prompt: the launch pre-sets state→running
   before the first `UserPromptSubmit` hook fires, defeating the `state==="launching"`
   discriminator. FIX (`63808a2`): persist `claudeStartedOnce` + `claudePendingContinuation`
   markers on the run (the stateless-hook equivalent of Pi's two in-process flags).
4. **`close` reported closed but Claude never exited** (`ctrl+d` is not Claude's exit).
   PROBED: `pane send-text "/exit"` + `enter` exits. FIX (`4457374`): `herdr.sendText`
   added; the claude adapter closes via `/exit` text, not `ctrl+d` keys (Pi unchanged).
5. **Model was Claude's default** (`claude-worker.model: null`). Not a bug — set `model`
   on the profile (a pattern like `sonnet` or an exact id); the launch passes `--model`.
6. **relaunch failed: "Session ID already in use."** Claude's `--session-id` *creates*
   (errors if the id exists); resuming needs `--resume <id>` (opposite of Pi). FIX
   (`80ded5e`): the claude relaunch uses `--resume`; Pi keeps `--session-id`.

**Note:** after `rm -rf` of the fixture, Herdr shows the leftover workspace/panes as
`(deleted)` (their cwd is gone). Cosmetic — the lane closes the *agent*, not the Herdr
workspace (out of scope; the canary forbids closing the workspace). Clear with
`herdr workspace close <id>`.
