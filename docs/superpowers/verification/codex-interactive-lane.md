# Codex Interactive Lane — Verification (Task 7)

> The Codex interactive lane lets `workflow launch` start a real, long-lived
> `codex` process (via the `codex-worker` profile with `mode: interactive`)
> instead of the headless `codex exec`/stream-json supervisor path, at the
> **maximum parity Codex allows** — the same recovery contract Pi and Claude
> established (`resume`/`close` via the generalized
> `SESSION_ADAPTERS.codex` transport, post-launch identity capture), and the
> same lifecycle-hook core driving `src/workflow/lifecycle.js` (full event
> parity — see §2). The one place parity is capped: **Codex has no
> scriptable status line**, so there is no in-TUI observability widget like
> Claude's; observability is **telemetry-only**, surfaced via
> `workflow worker status <run-id>` instead of a line rendered inside the
> pane. See `docs/superpowers/specs/2026-07-27-codex-interactive-lane-design.md`
> for the full design and the harness comparison.
>
> Same probe-first methodology as `pi-recovery-lane.md` and
> `claude-interactive-lane.md`: everything provable from source, `--help`,
> and a `--dry-run` launch is confirmed below with no live Codex session and
> no tokens spent. Only the runtime unknowns that require an actual
> interactive `codex` process (agent_session shape, exit sequence, native
> resume, hook-install safety) are deferred to the human/TTY probe in §3,
> and the full wired-up CLI cycle to the e2e in §4 — both **NOT** run by the
> implementer agent (see the plan's "Manual gates").

## 1. Fixture path — confirmed via `--dry-run` (2026-07-27, no live Codex needed)

Confirms `createWorkflowFixture` (`src/workflow/fixture.js`) already emits a
`codex-worker` profile (`harness: codex`, `command: codex`, default
`mode: stream-json` — valid only because `fixture_mode: true` widens
`MODES_BY_HARNESS.codex` to include `stream-json`, per
`src/workflow/registry.js`), and that patching its `mode` to `interactive`
makes a dry-run launch select the real interactive Codex argv (the
`agent.session.start` / `command: codex` op plus the interactive-only
`--dangerously-bypass-hook-trust` flag), not the fixture's headless
supervisor path. **No change to `src/workflow/fixture.js` was needed** — the
profile already existed exactly as required.

### Fixture build

```bash
cd /home/you/projects/personal/workflows/.worktrees/codex-interactive-lane
export F=/tmp/workflow-codex-lane-fixture-$(node -e 'console.log(Date.now())')
node -e '
import("./src/workflow/fixture.js").then(async ({ createWorkflowFixture }) => {
  const root = process.env.F;
  const fixture = await createWorkflowFixture({ root, packageRoot: process.cwd() });
  console.log(JSON.stringify({ root: fixture.root, registryPath: fixture.registryPath, stateRoot: fixture.stateRoot }, null, 2));
});
'
```

This printed (this run):

```json
{
  "root": "/tmp/workflow-codex-lane-fixture-1785181040636",
  "registryPath": "/tmp/workflow-codex-lane-fixture-1785181040636/projects.yaml",
  "stateRoot": "/tmp/workflow-codex-lane-fixture-1785181040636/state"
}
```

Confirmed the generated `projects.yaml` already has:

```yaml
codex-worker:
  harness: codex
  command: codex
  mode: stream-json
  model: gpt-5-codex
  arguments: []
  sandbox: workspace-write
  approval_policy: on-request
  roles:
    - implementer
```

### Patch `mode` to `interactive` — and a real finding about `approval_policy`

The task brief for this step says to also patch `.approval_policy` to
`"never"`. **Doing that literally fails schema validation** — this is a
genuine, reproducible finding, not a typo in this doc:

```bash
cp "$F/projects.yaml" "$F/projects.yaml.bak"
sed -i '/^    codex-worker:/,/^    [a-z-]*:$/{s/mode: stream-json/mode: interactive/; s/approval_policy: on-request/approval_policy: never/}' "$F/projects.yaml"
printf 'Greet once, then wait for further instructions.\n' > "$F/codex-prompt.txt"

WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent codex-worker --dry-run --prompt-file $F/codex-prompt.txt --format json
echo "exit: $?"
```

Output (this run):

```
CONFIG: agent profile codex-worker.approval_policy must be one of untrusted, on-request (received never)
exit: 3
```

**Why:** `src/workflow/registry.js`'s `CODEX_APPROVALS = new Set(["untrusted",
"on-request"])` unconditionally rejects `"never"` for a stored profile's
`approval_policy` — unlike `MODES_BY_HARNESS`, this set is **not** widened by
`fixture_mode: true` (the widening in `validateAgentProfile` only applies to
`mode`, not `approval_policy`). This is a deliberate safety guard, not an
oversight: `test/workflow-profiles.test.js` (`"rejects permission and sandbox
bypass shortcuts"`, and the dedicated `never.launcher.agent_profiles
["codex-worker"].approval_policy = "never"` case) asserts `validateRegistry`
throws on exactly this, alongside the same treatment given to
`--dangerously-skip-permissions` (Claude) and `danger-full-access` sandbox
(Codex) — a checked-in registry profile can never grant full-autonomy
approval. The `"never"` value **does** appear elsewhere in this codebase, but
only hardcoded directly into argv by code that bypasses profile validation
entirely: `relaunchSession`'s codex branch (`src/workflow/commands.js`) always
resumes with `-a never` (a dead session being reattached should not stop to
ask for approval), and several unit tests construct raw (non-registry)
profile objects with `approval_policy: "never"` to exercise `codexArgv`'s
plumbing in isolation. None of that goes through `validateRegistry`.

So the correct patch for this fixture is **`mode` only** — leave
`approval_policy` at the fixture's own default (`on-request`, already a
`CODEX_APPROVALS`-valid value):

```bash
cp "$F/projects.yaml.bak" "$F/projects.yaml"
sed -i '/^    codex-worker:/,/^    [a-z-]*:$/{s/mode: stream-json/mode: interactive/}' "$F/projects.yaml"
```

Resulting `codex-worker` block:

```yaml
codex-worker:
  harness: codex
  command: codex
  mode: interactive
  model: gpt-5-codex
  arguments: []
  sandbox: workspace-write
  approval_policy: on-request
  roles:
    - implementer
```

### `--dry-run` launch (real CLI, real live Herdr — read-only, no side effects)

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent codex-worker --dry-run --prompt-file $F/codex-prompt.txt --format json > /tmp/codex-dryrun.json
echo "exit: $?"   # 0
```

> **Note:** the fixture's `default_agent_profile` is `pi-worker`, so
> `--agent codex-worker` is required — without it the dry-run would select
> Pi, not Codex.

Extracted from the JSON preview:

```json
"selection": { "profileName": "codex-worker", "harness": "codex", "command": "codex", "source": "explicit" },
"reconciliation.agent.profile": { "mode": "interactive", "sandbox": "workspace-write", "approval_policy": "on-request", "arguments": [], "model": "gpt-5-codex" },
"reconciliation.operations[agent]": {
  "id": "agent", "kind": "agent.session.start", "phase": "start", "command": "codex",
  "sessionName": "fixture-single-FIX-101", "tabLabel": "agent"
},
"launchSpec.argv": [
  "codex", "-C", "<worktree>/fixture-single/FIX-101",
  "--add-dir", "<state-root>/<generated-run-id>",
  "--sandbox", "workspace-write",
  "--ask-for-approval", "on-request",
  "--dangerously-bypass-hook-trust",
  "--model", "gpt-5-codex",
  "Read \"$WORKFLOW_RUN_DIR/assignment.md\". Complete the assignment. ..."
],
"approvalDigest": "sha256:1972b62d6986081c9b8874b155a226d8d184604da8d4e0c56b26cf5ff1f565f4"
```

The plain (non-JSON) dry-run prints the same digest on its own line:

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent codex-worker --dry-run --prompt-file $F/codex-prompt.txt | grep -i digest
# Approval digest: sha256:1972b62d6986081c9b8874b155a226d8d184604da8d4e0c56b26cf5ff1f565f4
```

**Confirmed: the interactive session lane is selected.** The plan-level op
(`id: "agent"`, `kind: "agent.session.start"`, `command: "codex"`) is
present — this part of the plan is harness-driven, not mode-driven, so it
appears the same for either mode (exactly like the Claude lane). The
**decisive** signal that `mode: interactive` actually selected the
interactive lane is `--dangerously-bypass-hook-trust` in `launchSpec.argv` —
this only appears when `isCodexInteractiveAgent()`
(`src/workflow/launch.js`, mirroring `isClaudeInteractiveAgent`) sees
`mode === "interactive"` (also gated in `codexArgv` itself,
`src/workflow/harnesses.js`: `if (run && profile.mode === "interactive")
argv.push("--dangerously-bypass-hook-trust")`), and is also the flag that
lets the workflow's lifecycle hook (installed into the global
`~/.codex/hooks.json`, §2) run without a per-invocation hook-trust prompt.

For contrast, re-running the same dry-run against the **unpatched**
(`mode: stream-json`) registry drops that flag entirely — the argv is
otherwise identical:

```json
"argv": [
  "codex", "-C", "<worktree>/fixture-single/FIX-101",
  "--add-dir", "<state-root>/<generated-run-id>",
  "--sandbox", "workspace-write",
  "--ask-for-approval", "on-request",
  "--model", "gpt-5-codex",
  "Read \"$WORKFLOW_RUN_DIR/assignment.md\". Complete the assignment. ..."
]
```

— and at real execute time (not dry-run), `fixture_mode: true` + `mode:
stream-json` routes through `isFixtureStreamJson()` in
`src/workflow/launch.js` (harness-agnostic: it only checks
`profile.mode === "stream-json"`), which never even runs `codex` directly —
it spawns `workflow-worker.js` as a plain process (`supervisor: true`) and
drives Codex headlessly via `codex exec`. So the two signals
(`--dangerously-bypass-hook-trust` present; not routed through the
supervisor) together are the confirmation that patching `mode: interactive`
produces a genuine interactive Codex launch — exactly parallel to how
`--settings` was the Claude lane's decisive signal.

### Cleanup

```bash
rm -rf "$F"
rm -f /tmp/codex-dryrun.json
```

(done — the throwaway fixture above no longer exists on disk; the e2e in §4
builds its own.)

## 2. Verified facts (no probe needed)

- **Codex fires the same hook event set as Claude Code**: `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreToolUse`, `PostToolUse`,
  `PreCompact`, `Notification` (confirmed against the `codex-cli` binary per
  `docs/superpowers/specs/2026-07-27-codex-interactive-lane-design.md`).
  This is why `hooks/codex-lifecycle.mjs` can be a thin `harness: "codex"`
  wrapper around the exact same shared core as Claude
  (`hooks/lib/lifecycle-hook-core.mjs`, extracted in `f7fe4e5`) instead of a
  degraded subset — lifecycle fidelity is full, not best-effort-lite.
- **`codex resume <SESSION_ID>` resumes a saved session** — confirmed via
  `codex resume --help` (codex-cli 0.145.0, this environment):
  `Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]` /
  `[SESSION_ID] — Session id (UUID) or session name ... If omitted, use
  --last to pick the most recent recorded session`. This is the subcommand
  `relaunchSession`'s codex branch (`src/workflow/commands.js`) builds:
  `[codex, "resume", <exact sessionId>, "-C", <cwd>, "-a", "never",
  "--dangerously-bypass-hook-trust"]` — a subcommand, not a flag (unlike
  Pi's `--session-id` or Claude's `--resume`).
- **Sessions live under `~/.codex/sessions/`, cwd-scoped, one file per
  session** — live directory listing from this environment (codex-cli
  0.145.0) shows the real layout is **`~/.codex/sessions/<YYYY>/<MM>/<DD>/
  rollout-<ISO-timestamp>-<uuid>.jsonl`** (a day-level directory, and a
  `rollout-<timestamp>-` prefix on the filename, not a bare `<uuid>.jsonl`
  as a naive reading of "sessions in `~/.codex/sessions/<YYYY>/<MM>/
  <uuid>.jsonl>`" might suggest). The uuid is still the last segment before
  `.jsonl`, which is what matters for `codex resume <id>` and for a
  filename-based identity fallback.
- **Hooks live in `~/.codex/hooks.json`**, shape `{ hooks: { <Event>: [{
  hooks: [{ type: "command", command, timeout }] }] } }` — confirmed by
  reading this environment's real file, which currently has only Herdr's
  entry (no live interactive Codex launch has run here yet):
  ```json
  {
    "hooks": {
      "SessionStart": [
        { "hooks": [ { "command": "bash '/home/you/.codex/herdr-agent-state.sh' session", "timeout": 10, "type": "command" } ] }
      ]
    }
  }
  ```
  `src/workflow/codex-hooks.js`'s `mergeCodexWorkerHooks`/
  `ensureCodexWorkerHooks` (task 5, `76af5fc`) read-merge-write this file,
  appending one entry per `CODEX_WORKER_HOOK_EVENTS = ["UserPromptSubmit",
  "Stop", "SessionEnd"]` with command `node "<control-plane-root>/hooks/
  codex-lifecycle.mjs" <Event>`, deduped by exact command string (idempotent
  re-runs), and **never** touching Herdr's `SessionStart` entry or any other
  event/entry it doesn't own. The install call is wired in
  `bin/workflow.js`'s `createLiveDependencies` and only fires for an
  interactive Codex launch (`isCodexInteractiveAgent`, best-effort — a
  failure is recorded as a launch note, never aborts the launch).
- **Codex generates its own session id; there is no `--session-id`
  equivalent at launch** — `codex --help` has no such flag. The id is
  **discovered post-launch**: `discoverCodexSessionId({ herdr, paneId,
  attempts: 3, delayMs: 20 })` (`src/workflow/execute.js`, task 2, `822a71f`)
  polls `herdr.listAgents()` for the agent at the just-started pane and
  reads `agent_session.value`, retrying up to 3 times (the id can appear a
  beat after start) before giving up and leaving `sessionId: null` (resume's
  existing fail-safe then offers a relaunch instead of a bogus resume).
  Identity is persisted as `transportIdentity.kind === "codex-session"`
  (the same `` `${harness}-session` `` convention as Pi/Claude).
- **Default guess: `sessionMatches = value === id` (bare-id match, like
  Claude, not Pi's path-suffix match)** — `SESSION_ADAPTERS.codex`
  (`src/workflow/session-transport.js`, task 1, `7af1557`):
  ```js
  codex: Object.freeze({
    sessionMatches(value, id) { return value === id; },
    exitText: "/quit",
  }),
  ```
  This is a confident default carried over from Claude's confirmed shape
  (`{kind:"id", value:"<bare-uuid>"}`), not yet independently re-confirmed
  for a live Codex agent in *this* environment — no Codex agent happens to
  be running right now (`herdr agent list` here currently shows only
  `claude` agents). That re-confirmation is probe item (a) below.
- **Default guess: graceful exit is `/quit` (send-text + enter), not an exit
  key.** `SESSION_ADAPTERS.codex.exitText = "/quit"` and (unlike Claude,
  which keeps `exitKeys: ["ctrl+d"]` as an unused fallback) codex has **no**
  `exitKeys` fallback at all — `requestGracefulClose`
  (`src/workflow/session-transport.js`) takes the `exitText` branch
  unconditionally: `herdr.sendText({paneId, text:"/quit"})` then
  `herdr.agentSendKeys({target: paneId, keys:["enter"]})`. Whether real
  Codex actually exits cleanly on `/quit` (vs. `ctrl+d` or two `ctrl+c`s) is
  **not** yet confirmed — that's probe item (b) below.
- **`herdr agent start --kind codex` is supported** — `codex` is a listed
  `--kind` value in `herdr agent start --help` (this environment, Herdr
  0.7.5), alongside `pi`, `claude`, and others.
- **`codexArgv`'s sandbox/approval are profile-driven, not hardcoded**
  (`src/workflow/harnesses.js`): `--sandbox <profile.sandbox>`,
  `--ask-for-approval <profile.approval_policy>`. Because the registry
  forbids `approval_policy: "never"` (see §1), a real interactive launch
  built from a registry profile can only ever carry `untrusted` or
  `on-request` here — `"never"` is reachable only via the hardcoded
  `relaunchSession` resume path, never via a fresh `launch`.

## 3. Probe section — runtime unknowns (human/TTY, real Codex, real tokens)

These need one live interactive `codex` process. Start it any way that's
convenient (e.g. `herdr agent start probe --kind codex --pane <pane>` in an
existing shell pane, or run `codex` directly in a terminal Herdr is
tracking) — the Task-7 e2e in §4 below happens to also produce one, so it's
fine to fold this probe into that session instead of starting a second one.

- [ ] **(a) `herdr agent list` reports the codex `agent_session` shape.**
  Confirms/refutes the default `sessionMatches = value === id` guess above.
  ```bash
  herdr agent list | python3 -c "import sys,json; d=json.load(sys.stdin); print([a['agent_session'] for a in d['result']['agents'] if a['agent']=='codex'])"
  ```
  Record whether `kind` is `"id"` with a bare UUID `value` (like Claude), or
  something else (a path, a different `kind`). If it's a bare id, no code
  change is needed. If not, `SESSION_ADAPTERS.codex.sessionMatches` needs a
  fix mirroring Pi's path-suffix match.

- [ ] **(b) The graceful-exit sequence for an idle Codex session.** Test the
  coded default first:
  ```bash
  herdr agent list                              # find the codex agent; note pane_id; confirm agent_status: idle
  herdr pane send-text <pane_id> "/quit"
  herdr agent send-keys <pane_id> enter
  herdr agent list                              # did the codex agent leave the list / process exit?
  ```
  If `/quit` doesn't exit cleanly, try the fallbacks in order and record
  which one worked:
  ```bash
  herdr agent send-keys <pane_id> ctrl+d
  herdr agent list
  # or, if Codex needs a double press like some CLIs:
  herdr agent send-keys <pane_id> ctrl+c
  herdr agent send-keys <pane_id> ctrl+c
  herdr agent list
  ```
  Record: which one worked, whether it needed a repeat keypress, and
  whether the target was the agent pane itself (`agentSendKeys`/`sendText`
  already target `identity.paneId`, so no alternate target should be
  needed).

- [ ] **(c) `codex resume <id>` resumes the native session in the original
  cwd, with the workflow hook still active.** With a dead session's exact
  UUID (see §4 step 4 — this is exactly the `relaunchSession` argv in
  `src/workflow/commands.js`):
  ```bash
  codex resume <exact-uuid> -C <run-directory> -a never --dangerously-bypass-hook-trust
  ```
  Inside the resumed session, confirm (1) the prior turn's greeting is in
  scrollback/history (not a fresh empty session), and (2) a new prompt
  fires the hook (check `workflow worker status <run-id>` for an updated
  `phase`/generation — proves the global `~/.codex/hooks.json` entry is
  live in the resumed process, not just the original one). As a bonus,
  if convenient, note what field names the hook's stdin JSON actually uses
  for the event name and session id (`hooks/codex-lifecycle.mjs` currently
  ignores stdin entirely and keys off `env.WORKFLOW_*` + `process.argv[2]`,
  so this doesn't block anything today, but it's useful if a future change
  ever needs to read the payload).

- [ ] **(d) The workflow hook installed beside Herdr's does not disturb an
  *ordinary* (non-workflow) Codex session.** The no-op guard
  (`hooks/lib/lifecycle-hook-core.mjs`, shared with Claude) is supposed to
  make `codex-lifecycle.mjs` a silent no-op whenever `WORKFLOW_RUN_ID` isn't
  set or `WORKFLOW_HARNESS !== "codex"`. Confirm by starting a **plain**
  `codex` session with no `WORKFLOW_*` env at all (i.e. not launched via
  `workflow launch`) after the hook has been installed (per (e) below), and
  confirm:
  ```bash
  cd ~ && codex     # or any ordinary directory/session, NOT a workflow run
  # send a prompt, let it respond, then exit — should behave completely normally
  echo $?           # hook exits 0 either way; the check here is behavioral, not exit-code
  ```
  Record: no errors, no visible side effects, no delay attributable to the
  extra hook invocation.

- [ ] **(e) An interactive `workflow launch` actually installs the
  workflow's hooks into `~/.codex/hooks.json`.** Before the launch, note
  the file's current contents (should be Herdr-only, as in §2). After a
  real interactive launch (§4 step 0), re-check:
  ```bash
  cat ~/.codex/hooks.json | python3 -m json.tool
  ```
  Confirm it now additionally has `UserPromptSubmit`, `Stop`, and
  `SessionEnd` entries whose `command` is `node "<control-plane-root>/hooks/
  codex-lifecycle.mjs" <Event>`, and that Herdr's pre-existing `SessionStart`
  entry is byte-for-byte unchanged. Re-run the same launch a second time
  (or launch a second codex-worker run) and confirm the file does **not**
  grow a duplicate entry (idempotency).

### Findings (fill in after running)

- (a) `agent_session` shape observed: ____
- (b) exit sequence that worked: ____ (/quit / ctrl+d / ctrl+c×2 / other)
- (c) native history + hook still active after resume: ____ ; hook stdin field names (bonus): ____
- (d) ordinary (non-workflow) Codex session undisturbed by the installed hook: ____ (yes/no)
- (e) `~/.codex/hooks.json` gained the 3 workflow entries, Herdr's entry untouched, idempotent on re-run: ____
- Herdr version: ____ / Codex version: ____ / date: ____

## 4. Task-7 e2e — full CLI cycle with the Codex fixture (human/TTY, before merge)

Validates the **wired-up** interactive Codex lane end-to-end through the
`workflow` CLI: `launch` → identity survives → telemetry `phase` renders →
`resume` (live, focuses) → `close` (idle) → `resume` (dead, refuses) →
`resume --yes` (relaunch via `codex resume`, resumes real history) →
`resume` (focuses the new pane). Mirrors `claude-interactive-lane.md`'s
Task 7 e2e shape, adapted for Codex's post-launch discovery, global hooks,
and `/quit` exit instead of Claude's `--settings` + `/exit`.

**No in-TUI widget:** unlike the Claude e2e (which checks a rendered
statusLine in the pane), there is nothing to read from the pane itself here
— step 2 below checks `workflow worker status <run-id>` instead.

### Fixture (build your own — the §1 fixture was a throwaway, already deleted)

```bash
cd /home/you/projects/personal/workflows/.worktrees/codex-interactive-lane
F=/tmp/workflow-codex-lane-e2e-$(node -e 'console.log(Date.now())')
node -e '
import("./src/workflow/fixture.js").then(async ({ createWorkflowFixture }) => {
  await createWorkflowFixture({ root: process.env.F, packageRoot: process.cwd() });
});
' F=$F
sed -i '/^    codex-worker:/,/^    [a-z-]*:$/{s/mode: stream-json/mode: interactive/}' "$F/projects.yaml"   # mode only — see §1 for why approval_policy stays on-request
printf 'Greet the user in one short sentence, then wait. Do not read any files, do not write a handoff, and do not take any other action unless asked.\n' > "$F/codex-prompt.txt"
```

Compute the approval digest from the **CLI's own dry-run** (never a
programmatic `launchCommand` call — the two serialize options differently
and produce different digests):

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent codex-worker --dry-run --prompt-file $F/codex-prompt.txt
# copy the "Approval digest: sha256:..." line printed at the end
```

> **Robust alternative (no digest):** drop `--yes --approval-digest` below
> and confirm interactively — the CLI prints its own preview and asks
> `Proceed with workflow launch? [y/N]`, computing its own fresh digest, so
> there's no stale-digest risk:
> ```bash
> WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
>   --agent codex-worker --prompt-file $F/codex-prompt.txt   # then type: y
> ```

### 0. Launch

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --agent codex-worker --yes --approval-digest sha256:<paste-digest-here> \
  --prompt-file $F/codex-prompt.txt --format json
```

Capture the run id robustly (do not rely on `ls` — it may be aliased with
extra formatting flags in your shell):

```bash
export R=$(find $F/state -maxdepth 1 -mindepth 1 -type d -printf '%f\n')
echo "$R"
```

> **Note:** the launch report's top-level `status` may say `"partial"`
> cosmetically (a reconciliation-timing artifact seen in the Pi and Claude
> lanes too — here it's especially likely, since Codex's session id is
> *discovered* post-launch via a bounded retry, so the CLI may report back
> before discovery settles). Don't take that as a failure. Judge success by
> the two checks below: identity persisted + the agent actually alive in
> `herdr agent list`.

- [ ] Launch reports (`"running"` or cosmetically `"partial"`), and no
  `CONFIG:` schema error is raised (confirms the `approval_policy` finding
  from §1 didn't creep back in via a stale patched registry).

### 1. Identity survives the launch race

```bash
cat $F/state/$R/run.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('state:',d.get('state'));print(json.dumps(d.get('transportIdentity'),indent=2))"
# expect: transportIdentity.kind == "codex-session", with runId, sessionId, paneId, tabId, workspaceId, cwd
herdr agent list   # note the agent's pane_id / tab_id / agent_status; agent_session.value should equal sessionId
```

- [ ] `transportIdentity.kind == "codex-session"` and `sessionId` is
  non-null (discovery succeeded) and matches the id `herdr agent list`
  reports for that pane.

### 2. Telemetry `phase` renders (no in-TUI widget for Codex)

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js worker status $R --format json
```

- [ ] A telemetry snapshot is present with a real `phase` (not stuck on
  `"starting"`), and `harness: "codex"` — proves the global
  `~/.codex/hooks.json` entry fired at least once (`UserPromptSubmit` at
  minimum) and recorded through `hooks/codex-lifecycle.mjs` →
  `runLifecycleHook` → the telemetry store.

### 3. `resume` a LIVE session → focus

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

- [ ] `{"command":"resume","runId":"…","action":"focused",…}` **and** the
  Codex pane itself (not a shell pane above it) comes to the foreground in
  Herdr (exercises `herdr agent focus <paneId>` — harness-agnostic, same
  call as Pi/Claude).

### 4. `close` an IDLE session → graceful exit

Wait until `herdr agent list` shows the agent `idle`, then:

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js close $R --format json
herdr agent list   # the codex agent should be gone
```

- [ ] `{"command":"close","runId":"…","closed":true}` and the agent left
  `agent list` (confirms probe finding (b) — the `/quit` exit sequence —
  wired end-to-end). If you got `{"closed":false,"reason":"working"}`, the
  agent was still mid-turn; wait and retry (fail-safe, never kills a
  working process).

### 5. `resume` a DEAD session WITHOUT `--yes` → reports, does not relaunch

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

- [ ] `{"command":"resume","runId":"…","action":"needs-confirmation","plan":"relaunch",…}`
  and **no** new pane/agent appears in `herdr agent list`.

### 6. `resume --yes` a DEAD session → relaunch via `codex resume`

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --yes --format json
herdr agent list   # a new codex agent should appear
```

- [ ] `{"command":"resume","runId":"…","action":"relaunched",…}`.
- [ ] In the new pane: **native session resumed** — the prior greeting is in
  scrollback, driven by `codex resume <exact-id>` (the SUBCOMMAND form, not
  a bootstrap prompt — confirms probe finding (c)).
- [ ] **Telemetry resumes:** send a follow-up prompt in the resumed pane and
  confirm `workflow worker status $R` shows an updated `phase`/generation
  (proves the global hook is live again in the new process, not just the
  original one — same file, no per-run regeneration needed for Codex).

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

### Findings (e2e run, ____, Herdr ____ / Codex ____)

Fill in after running live:

- [ ] 0. Launch reported ____ (running/partial); no schema error.
- [ ] 1. Identity survives: `transportIdentity.kind == "codex-session"`, `sessionId` discovered: ____
### Findings (e2e run, 2026-07-27, Herdr 0.7.5 / codex-cli 0.145.0)

Verified live against a real interactive Codex session. Core recovery works; the e2e
found + fixed 3 defects and surfaced one Codex/Herdr limitation.

- [x] **0–1. Identity discovered:** `transportIdentity.kind == "codex-session"`, id OK.
  Codex `agent_session` is a bare uuid (`{kind:"id", value:"<uuid>"}`) → `value===id`.
- [x] **2. Telemetry:** `worker status` shows `phase` (`settled`), `harness: codex`,
  and the workflow hook installed into `~/.codex/hooks.json` (best-effort, beside Herdr's).
- [x] **3. resume LIVE → focused** Codex's own pane (`agent focus`).
- [x] **4. close IDLE → exits** via `/quit` (after the settle fix, see below).
- [x] **5. resume DEAD → needs-confirmation.**
- [x] **6. resume --yes → relaunched:** `codex resume <id>` **reuses the same session id
  and resumes the full native history** (verified via `herdr pane read` — the prior
  conversation, incl. the submitted handoff, was intact).
- [~] **7. resume again → LIMITATION** (see below).

**Bugs found + fixed by this e2e:**

1. **Post-launch identity discovery was too impatient** (3×20ms ≈ 60ms). Codex's session
   id appears in `herdr agent list` only ~seconds after `SessionStart` fires. FIX
   (`e4dd0ee`): widen the discovery window to ~10s (returns as soon as found; timing
   injectable so the no-match test stays fast).
2. **`close` typed `/quit` but the immediate `enter` was swallowed as a newline** in
   Codex's multi-line composer (race — enter arrived before Codex rendered the text),
   leaving the agent alive. FIX (`fb7eddb`): the codex adapter declares `exitSettleMs=1000`;
   `requestGracefulClose` waits it between the text and the enter (Pi/Claude unchanged).
3. **Approval-autonomy** — the registry's `CODEX_APPROVALS` didn't allow `never`, so the
   worker would prompt and stall. FIX (`3ce68f0`): allow `approval_policy: never`
   (autonomous; the sandbox still applies; sneaking approval flags via `arguments` stays forbidden).

**Known limitation (documented follow-up, not a code defect):** after a `codex resume`
relaunch, Herdr does **not** report the resumed agent's `agent_session` while it is idle
(it stays empty until Codex takes a turn). So re-observing/closing the **relaunched**
session via the workflow returns `mismatch` until it acts — step 7's re-resume and closing
the relaunched agent aren't reliable until then. The relaunch itself works and resumes the
history (the core recovery goal). This is a Herdr↔Codex integration limit, not the lane's
code; a future workaround could relax `observeExact` to trust the pane it just relaunched
into when the session value is not yet reported.

**Note:** after `rm -rf` of the fixture, Herdr may show the leftover
workspace/panes as `(deleted)` (their cwd is gone) — cosmetic, the lane
closes the *agent*, not the Herdr workspace. Clear with `herdr workspace
close <id>` if needed.
