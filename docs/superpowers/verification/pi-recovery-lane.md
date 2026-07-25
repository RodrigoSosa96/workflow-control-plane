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

## Findings (fill in)

- send-keys TARGET that works (pane id / session id):
- exit key sequence that cleanly closes an idle Pi:
- `pi --session-id <exact>` resumes the native session? (yes/no):
- `herdr tab focus <tabId>` brings the tab forward? (yes/no):
- anything unexpected:
