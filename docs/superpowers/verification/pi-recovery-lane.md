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
- **tab focus:** YES. `herdr tab focus <tab_id>` (single arg — the tab id, not pane id)
  brings the tab to the foreground. So `focusTab({ tabId })` = `tab focus <tabId>`.
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
