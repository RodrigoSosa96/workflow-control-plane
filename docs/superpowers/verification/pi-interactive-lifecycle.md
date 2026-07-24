# Pi Interactive Lifecycle — Manual Verification (Task 1)

> Empirical verification of Pi's interactive lane, run by a human in a TTY.
> Its findings unblock Task 6 (the Pi lifecycle extension), which must hook the
> real event names and know how extensions load into a worker.
>
> Fill in the **Findings** section at the bottom and hand it back.

## Experiment 1 — Real event names + extension loading (REQUIRED, unblocks Task 6)

A probe extension (`/tmp/pi-lifecycle-probe/log-events.ts`) logs every candidate
lifecycle event, in order, to `/tmp/pi-lifecycle-probe/events.log`. We load it via
`--extension` from a directory that is NOT the workflow repo, to mirror a worker
running in the ticket worktree.

### Steps (run in a real terminal)

```bash
# 1. Clear any old log
rm -f /tmp/pi-lifecycle-probe/events.log

# 2. Launch interactive Pi from a neutral dir, loading only the probe extension
cd /tmp/pi-lifecycle-probe
pi --extension /tmp/pi-lifecycle-probe/log-events.ts
```

Then, inside the Pi TUI, do exactly this sequence, waiting for Pi to finish and go
idle after each line:

1. Type: `say hello` → Enter. Wait until it finishes.
2. Type: `run the bash command: echo hi` → Enter. Wait until it finishes (this uses a tool).
3. Type: `now say goodbye` → Enter. Wait until it finishes. **(this line is the "follow-up" — the key case)**
4. Exit Pi: press **Ctrl-D** (or type `/exit`).

### Collect the log

```bash
cat /tmp/pi-lifecycle-probe/events.log
```

Paste that whole output back. It answers everything below; you don't have to
interpret it yourself, but the questions it settles are:

- **Extension loading:** is there a `"__probe_loaded__"` line at the top? If yes,
  `--extension <path>` is the load mechanism → Task 6 wires exactly that. If the
  log is empty/missing, extensions do NOT load that way and we need another path.
- **Work start:** which event fires when Pi begins working after each prompt —
  `agent_start`? `turn_start`? both?
- **Stop/idle:** which event marks the end of work — `agent_settled`? Does it
  carry `idle: true`?
- **Follow-up:** does line 3 (`now say goodbye`) produce a fresh `agent_start`
  after the previous `agent_settled`? (This is how the lifecycle extension will
  detect a user follow-up → new generation.)
- **Distinguisher:** do any events carry `streamingBehavior` or `stop_hook_active`
  fields? (Those would let us tell a real user follow-up from our own queued
  continuation — critical so continuations don't inflate the generation.)
- **Close:** which event fires on Ctrl-D — `session_shutdown`?

## Experiment 2 — Observability widget with a real run (OPTIONAL)

Confirms the actual `workflow-worker-observability.ts` extension renders inside an
interactive Pi when the `WORKFLOW_*` env is present. Only needed if Experiment 1
leaves doubt about the real extension (vs. the probe). Requires a real run in the
state store; skip unless you want the extra signal. If you want it, tell me and
I'll generate the exact env + a seeded run.

## Experiment 3 — Full interactive `workflow launch` (LATER, this is Task 8)

Running an end-to-end interactive `workflow launch` (which surfaces any Herdr
`agent start --kind pi` interactive-launch bugs) needs a fixture registry with
`mode: interactive`. That belongs to Task 8 (end-to-end verification), after the
lifecycle extension exists. Not required to unblock Task 6.

## Findings (completed 2026-07-24, Pi 0.81.1)

- **Extension loaded via `--extension`?** YES — `__probe_loaded__` logged first. `--extension <path>` is the load mechanism; Task 6 wires it into the launch argv.
- **Work START after a prompt:** `agent_start` (idle flips false). Preceded by `before_agent_start` (idle:true). Exactly one `agent_start` per work cycle.
- **STOP/idle:** `agent_settled` with `idle:true`. Exactly one per work cycle, after `agent_end`.
- **Follow-up:** YES — the third prompt fired a fresh `before_agent_start`→`agent_start` after the previous `agent_settled`. A user follow-up is a new `agent_start`.
- **`streamingBehavior` / `stop_hook_active`:** NONE present on any event. **No native field distinguishes a user follow-up from a queued continuation** — both are just `agent_start`. The extension must track this itself with local state.
- **Exit:** `session_shutdown` with `reason:"quit"`.
- **Tool cycle caveat:** a tool call produces MULTIPLE `turn_start`/`turn_end` inside a single `agent_start`…`agent_settled`. The lifecycle extension must hook `agent_start`/`agent_settled` (per-cycle), NOT `turn_start` (per-turn), for state/generation.
- **Unexpected:** none. Clean run.

### Design consequence for Task 6

Because no event field distinguishes a user follow-up from our own queued
continuation, the extension keeps two pieces of local state:

- `pendingContinuation` (bool): set true right after the extension queues a
  continuation on `agent_settled` (via `pi.sendUserMessage(..., {deliverAs: "followUp", triggerTurn: true})`). The very next `agent_start` consumes it → `source: "continuation"` and resets the flag. Any `agent_start` with the flag unset is `source: "user"`. (`triggerTurn` fires `agent_start` immediately, before the user can type, so the flag is reliable.)
- `startedOnce` (bool): the first `agent_start` confirms generation 1
  (`generation = current.generation`); every later user `agent_start` is a
  follow-up → `generation = current.generation + 1` (read `current.generation`
  from the run store). A continuation reuses `current.generation` unchanged.

This feeds `lifecycle.onPrompt({ runId, generation, source })`, whose Task 2
logic already treats `source: "continuation"` and a non-incremented generation
as "not a follow-up".
