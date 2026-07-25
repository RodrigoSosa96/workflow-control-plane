# Pi Recovery Lane — Herdr Command Probe (Task 1)

> Confirms the exact Herdr commands the pi-session transport and resume/close wrap.
> Argv shapes below were confirmed from `--help` without a running Pi; the three
> **runtime** checks at the bottom still need a live interactive Pi (human/TTY).

## Confirmed from Herdr 0.7.5 `--help` (no Pi needed)

- **Graceful close keys:** `herdr agent send-keys <TARGET> <KEY>...`. `esc` is the
  canonical Escape name; Ctrl-D is expected to be `C-d` (tmux-style). TARGET is the
  agent target — confirm pane-id vs session-id in the runtime probe.
- **Focus a live session:** there is NO focus-a-pane-by-id. `herdr pane focus` is
  directional (`--direction` required). But `herdr tab focus <tabId>` ("Focus a
  tab") and `herdr workspace focus <workspaceId>` ("Focus a workspace") DO exist.
  → **resume's "focus" uses `herdr tab focus <tabId>`** (the identity carries
  `tabId`), not `pane focus`. Plan Task 2 provides `focusTab({ tabId })`, and
  `executeResume` (Task 5) must call `focusTab({ tabId })`, not `focusPane`.
- **Relaunch (resume dead):** `herdr agent start <name> --kind pi --pane <pane> --
  --session-id <exact> --extension <lifecycle> --extension <observability>` — the
  same launch argv sub-project #1 established.

## Runtime checks (REQUIRED, need a live interactive Pi — human/TTY)

Launch an interactive Pi with the sub-project #1 procedure
(`docs/superpowers/verification/pi-interactive-lifecycle.md`), note its `run-id`,
`pane_id`, `tab_id`, and the session id from `herdr agent list`.

- [ ] **1. Graceful close via send-keys.** With the agent idle:
  ```bash
  herdr agent list                         # confirm agent_status: idle; note the TARGET id
  herdr agent send-keys <pane_id> C-d      # try pane id as TARGET; adjust if rejected
  herdr agent list                         # did the agent leave / Pi exit cleanly?
  ```
  Record: the working TARGET (pane id or session id) and the exact key(s) that make
  an idle Pi exit. If `C-d` doesn't exit, try `/exit` via `send-text` + `enter`, and
  record what works.

- [ ] **2. Resume by exact session id.** After Pi exits, relaunch into a fresh pane
  with the exact session id + extensions (see the relaunch argv above). Confirm the
  native session history resumes (not a fresh session) and the workflow extensions
  reload (the observability widget reappears).

- [ ] **3. tab focus brings the session forward.** With a live session, run
  `herdr tab focus <tab_id>` and confirm it brings the agent's tab to the
  foreground. (Fallback: `herdr workspace focus <workspace_id>`.)

## Findings (probe complete, 2026-07-25, Herdr 0.7.5 / Pi 0.81.1)

- **send-keys TARGET:** the **pane id** (e.g. `w1T:p2`). `agent send-keys <pane_id> <key>` works.
- **exit key:** `ctrl+d` (with `+`; tmux-style `C-d` is rejected as `unsupported key`).
  `herdr agent send-keys w1T:p2 ctrl+d` returned `{type:"ok"}` and the agent left
  `agent list` — Pi exited gracefully. So `requestGracefulClose` = observe idle →
  `agentSendKeys({ target: paneId, keys: ["ctrl+d"] })`.
- **resume:** YES. `herdr agent start … --kind pi --pane <new> -- --session-id <UUID>
  --extension …` resumed the native session (history intact). The launch passes the
  **UUID** as `--session-id`; Herdr's `agent_session` reports `kind: "path"`, `value`
  the `.jsonl` path ending in `_<UUID>.jsonl`. So `observeExact` must match the UUID
  **inside** the path (`value.endsWith(sessionId + ".jsonl")`) or key off `pane_id` —
  NOT `value === sessionId`.
- **tab focus:** `herdr tab focus <tab_id>` raises the tab, but the Task 7 e2e showed
  it leaves the retained bootstrap **shell pane (above Pi)** as the active pane, so the
  cursor lands on the empty shell, not Pi. **Corrected:** use `herdr agent focus
  <target>` (target = pane id, same as send-keys), which focuses the agent's own pane.
  `focusAgent({ target: paneId })` is now the resume focus command; `focusTab` is a
  fallback. (`d761d85`.)
- **Unexpected:** none. Note: closing a Pi pane with `ctrl+d` leaves the pane as a
  bare shell (Pi exits, the pane stays), and resume creates a NEW pane in the same
  tab — so a resumed run's tab can show leftover shell panes alongside the live Pi.
  Cosmetic; the live Pi is unambiguous via `agent list`.

## Consequences for Tasks 2/3

- Task 2 `agentSendKeys({ target, keys })` → `agent send-keys <target> <keys...>`;
  transport passes `target = identity.paneId`, `keys = ["ctrl+d"]`.
- Task 2 `focusTab({ tabId })` → `tab focus <tabId>`.
- Task 3 `observeExact`: find the agent by `pane_id === identity.paneId`, then confirm
  the session by `agent_session.value.endsWith(identity.sessionId + ".jsonl")` (the
  value is a path, not the bare UUID). `agent_status` idle → `idle`, working → `active`.

## Task 7 — Recovery lane e2e via the `workflow` CLI (REQUIRED, human/TTY)

The Task 1 probe validated the raw Herdr commands. Task 7 validates the **wired-up
recovery lane** end-to-end: `workflow launch` → `workflow close` (idle) →
`workflow resume` (live) → `workflow resume` (dead) → `workflow resume --yes`
(relaunch). One real interactive Pi session; the prompt just greets and idles, so
token use is minimal.

### Fixture (already built + patched to `mode: interactive`, digest computed)

- Fixture root: `/tmp/workflow-recovery-e2e-1784958220726`
- Registry: `…/projects.yaml` (pi-worker → `mode: interactive`)
- Prompt: `…/recovery-prompt.txt` (greet once, then wait — no edits, no handoff)
- Approval digest: `sha256:039926a2e696540dc7e999253cfe68b23337f5e5cdb0cc129417645e5173a8be`

> Only `WORKFLOW_PROJECTS_FILE` is needed — `resume`/`close` resolve the run store
> from the registry's `state_root` (`storeForCommand` → `stateRootForCommand`).
> If you regenerate the fixture or the digest is rejected, re-run the dry-run for a
> fresh digest:
> `WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 --dry-run --prompt-file $F/recovery-prompt.txt`

### 0. Launch the interactive session

```bash
F=/tmp/workflow-recovery-e2e-1784958220726
cd /home/you/projects/personal/workflows/.worktrees/pi-recovery-lane

WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --yes --approval-digest sha256:039926a2e696540dc7e999253cfe68b23337f5e5cdb0cc129417645e5173a8be \
  --prompt-file $F/recovery-prompt.txt
```

> **Robust human/TTY alternative (no digest):** drop `--yes --approval-digest` and
> confirm interactively — the CLI prints the preview, asks
> `Proceed with workflow launch? [y/N]`, and uses its own freshly-computed digest,
> so there is no stale-digest risk:
> ```bash
> WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
>   --prompt-file $F/recovery-prompt.txt   # then type: y
> ```
> The digest above must come from the **CLI** `--dry-run` (the fallback command
> below), not from a programmatic `launchCommand` call — the two serialize options
> differently and produce different digests.

Note the printed **run id** (call it `R`). Confirm the interactive session captured
the recovery identity (this is what makes the whole lane work; the probe already
saw it, re-confirm here):

```bash
cat $F/state/$R/run.json | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get('transportIdentity'),indent=2))"
# expect: kind "pi-session" with runId, sessionId, paneId, tabId, workspaceId, cwd
herdr agent list   # note the agent's pane_id / tab_id and agent_status
```

### 1. `resume` a LIVE session → focus (run this while the session is still up)

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

Expect `{"command":"resume","runId":"…","action":"focused",…}` **and** the agent's
tab comes to the foreground in Herdr (this exercises `herdr tab focus <tabId>`).
`focus` works whether the agent is `active` or `idle`.

### 2. `close` an IDLE session → graceful exit

Wait until the greeting turn has finished (`herdr agent list` shows the agent
`idle`), then:

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js close $R --format json
herdr agent list   # the agent should be gone (Pi exited via ctrl+d)
```

Expect `{"command":"close","runId":"…","closed":true}`. If you run it while the
agent is still working you'll correctly get `{"closed":false,"reason":"working"}` —
that's the fail-safe (never kills a working process); just wait for idle and retry.
(Probe finding: the pane stays as a bare shell after Pi exits — cosmetic.)

### 3. `resume` a DEAD session WITHOUT `--yes` → reports, does not relaunch

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

Expect `{"command":"resume","runId":"…","action":"needs-confirmation","plan":"relaunch",…}`
and **no** new pane/agent (`herdr agent list` unchanged). This is the never-relaunch-
without-confirmation invariant.

### 4. `resume --yes` a DEAD session → relaunch WITH extensions + env

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --yes --format json
herdr agent list   # a new pi agent should appear
```

Expect `{"command":"resume","runId":"…","action":"relaunched",…}`. In the new pane
confirm — this is the whole point of the relaunch fixes:
- the **native session resumed** (the prior greeting is in history, not a fresh
  session) — driven by `pi --session-id <exact>`;
- the **observability widget reappears** (the two workflow extensions reloaded —
  `PI_WORKER_EXTENSIONS`, not a bare pane);
- `run.json`'s `transportIdentity` now points at the **new** pane/tab (persisted on
  the confirmed relaunch):

```bash
cat $F/state/$R/run.json | python3 -c "import sys,json;d=json.load(sys.stdin);i=d['transportIdentity'];print('pane',i['paneId'],'tab',i['tabId'])"
```

### 5. `resume` again → focuses the NEW pane (identity re-recognized)

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js resume $R --format json
```

Expect `action:"focused"` against the **new** tab id from step 4 — proving the
relaunched identity was persisted and re-observed (the `6c67b03` fix).

### Cleanup (after you're done)

```bash
# close the resumed session if still up, then drop the disposable fixture
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js close $R || true
rm -rf $F
```

### Findings (Task 7, 2026-07-25, Herdr 0.7.5 / Pi 0.81.1)

First real e2e ran the recovery lane against a live interactive Pi and **found a
launch bug** the unit tests could not see, plus verified the lane's own logic.

- **BUG FOUND + FIXED — launch did not persist `transportIdentity`.** A CLI
  `workflow launch` that ran to completion left `transportIdentity: null`, so
  `resume`/`close` would return `no-identity` — the recovery lane was dead on
  arrival for real runs. Root cause: the launcher wrote run state + identity in one
  `updateRun`, and the interactive worker's own lifecycle extension advances the run
  state concurrently, so that combined write can lose the race, hit an illegal
  transition, throw, and be swallowed — dropping the identity. Proven by an
  instrumented run: a direct-call launch that *won* the race kept the identity; the
  CLI run that *lost* it did not (same code, different timing). Fixed in `88289fe`
  by persisting `transportIdentity` first via a dedicated **state-less** merge that
  never throws on a transition. The prior identity unit test faked `executeStart`
  with the identity pre-attached, so it never exercised this path; a race test was
  added. **A fresh e2e is needed to confirm identity now survives to `completed`.**
- **1. resume LIVE → focused** returned `action: "focused"`, but the live e2e showed
  it focused the **empty shell pane above Pi**, not Pi (it used `tab focus`).
  **FIXED (`d761d85`):** resume now uses `herdr agent focus <paneId>` to focus Pi's
  own pane. Re-verify in the next e2e.
- **BUG FOUND + FIXED — `resume --yes` opened an EMPTY pane.** Two causes: (a) the
  relaunch focused the fresh tab's empty root pane, not Pi — fixed by `agent focus`
  after start (`d761d85`); and, the real culprit, (b) the relaunch agent name was
  `resume-<full sessionId>` = 43 chars, which `herdr agent start` rejects (names are
  1-32 chars, `[a-z][a-z0-9_-]*`), so **Pi never started** and the tab held only empty
  panes. Fixed (`5c491cc`) by naming the agent `resume-<sessionId first block>`
  (≤32 chars); the exact `--session-id` still drives the resume. The relaunch tests
  used a fake `s1` id (short name) and missed it; a real-UUID regression test was added.
- **2. close IDLE → closed:true ✅** verified live: sent `ctrl+d` to the pane, Pi
  exited gracefully, the agent left `agent list`.
- **3. resume DEAD (no --yes) → needs-confirmation ✅** verified live: `plan:
  relaunch`, nothing relaunched.
- Steps 1–3 were verified by backfilling the correct identity into the run (which
  the buggy launch failed to persist) and running the real `resume`/`close`
  commands against the live session — so the lane's transport/resume/close code is
  confirmed against a real Pi, independent of the launch bug now fixed.

### Full cycle verified live (2026-07-25, after all three fixes)

All steps confirmed against a real interactive Pi session (run `ff81022c`, session
`d263185e`), reading pane content directly to check history — not just command output:

- [x] **0. Identity survives to completion:** the launch persisted
  `transportIdentity` and it remained present after the run reached `completed`.
- [x] **1. resume LIVE → focused** the Pi pane itself (via `agent focus`).
- [x] **2. close IDLE → closed:true**, agent left `agent list`.
- [x] **3. resume DEAD (no --yes) → needs-confirmation**, nothing relaunched.
- [x] **4. resume --yes → relaunched:** the new agent came up on the **same** session
  file `…_d263185e….jsonl`, and `herdr pane read` showed the **full 55-line history**
  (handoff JSON, prior reasoning) — a true resume, not an empty session. Identity was
  re-pointed at the new pane (`w23:pA`/`w23:t5`).
- [x] **5. resume again → focused the new pane** (`action: focused`, pane `w23:pA`).

Three bugs were found and fixed by this e2e (`88289fe`, `d761d85`, `5c491cc`); none
were catchable by the unit tests as written (faked `executeStart`; fake short session
id; no live focus/resume check). The recovery lane now works end-to-end.

Note: failed relaunch attempts (before `5c491cc`) can leave empty shell panes/tabs in
the fixture workspace — cosmetic; drop the fixture (`rm -rf $F`) or close the
workspace to clear them.
