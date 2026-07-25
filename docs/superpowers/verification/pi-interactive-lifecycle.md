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

## Task 8 — Full interactive `workflow launch` end-to-end (REQUIRED before merge)

Prepared fixture (already generated + patched to `mode: interactive`, prompt written,
approval digest computed):

- Fixture: `/tmp/workflow-smoke-1784945292112`
- Registry: `/tmp/workflow-smoke-1784945292112/projects.yaml` (pi-worker → `mode: interactive`)
- Prompt: `/tmp/workflow-smoke-1784945292112/canary-prompt.txt`
- Approval digest: `sha256:6d4b8b863c4310bec35ca3e563fd7839f5e33a425cc16a669495aca003b75e2d`

> If you regenerate the fixture or the digest is rejected, re-run the dry-run to
> get a fresh digest:
> `WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 --dry-run --prompt-file $F/canary-prompt.txt`

Dry-run already confirmed the interactive lane is selected (op `agent.session.start`,
argv `pi --name … --session-id …`, NOT the supervisor) and both extensions are wired
via `--extension`.

### Autonomous run

```bash
F=/tmp/workflow-smoke-1784945292112
cd /home/you/projects/personal/workflows/.worktrees/pi-interactive-lifecycle

WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js launch fixture-single FIX-101 \
  --yes --approval-digest sha256:6d4b8b863c4310bec35ca3e563fd7839f5e33a425cc16a669495aca003b75e2d \
  --prompt-file $F/canary-prompt.txt
```

This creates a Herdr workspace + pane running interactive Pi with the two workflow
extensions. Note the **run id** it prints. Then, in Herdr, open the agent pane and check:

1. **Extension load (the top runtime risk):** does the observability widget appear,
   and are there NO Pi errors about failing to load
   `workflow-worker-lifecycle.ts` / `workflow-worker-observability.ts` or their
   relative `.js` imports? (If it errors here, the extension needs different
   packaging — see the follow-ups doc.)
2. **Pi does the work:** it reads the assignment, edits `fixture.js`, runs the
   tests, and runs the handoff command.
3. **State + telemetry from outside the pane:**

```bash
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js status fixture-single FIX-101
WORKFLOW_PROJECTS_FILE=$F/projects.yaml node bin/workflow.js result <run-id>
cat $F/state/<run-id>/telemetry/workers/*.json   # phase should not be stuck on unknown
```

Expected: status shows the run `running` then terminal; `result` returns the
handoff; final state `completed`; telemetry `phase` advances (running → … → settled)
with `observability: reported`.

### Assisted run (follow-up → generation)

In the Pi pane, after it settles, type a follow-up (e.g. `now also add a comment to fixture.js`).
Then check the run's telemetry/state:

```bash
cat $F/state/<run-id>/run.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('state', d['state'], 'generation', d.get('generation'))"
```

Expected: `generation` incremented (2), state back to `running`, and the prior
`result.json` archived (look for `$F/state/<run-id>/results/generation-1.json`).

### Not validated here (follow-ups)

`workflow resume` / `workflow close` are NOT functional against real runs yet
(transportIdentity is not captured at launch and the CLI wires the delegation
transport, not an interactive session transport — see
`docs/superpowers/plans/2026-07-25-pi-interactive-lifecycle-followups.md`). Skip
resume/close in this pass.

### Findings (autonomous run completed 2026-07-25, run 0244f07e)

- **Extensions loaded?** YES — the observability widget rendered in the pane
  (`Workflow 0244f07e… | running/settled | pi`, Model, Tool). No `.ts`/import
  errors. This confirms Pi loads a `.ts` extension by absolute path with relative
  `.js` imports — the top runtime risk. ✅
- **Autonomous reached `completed` and returned the handoff?** YES. Pi edited
  `fixture.js` → `implemented`, updated `test.js`, ran the tests, submitted the
  handoff (status `completed`, ticket `FIX-101` only — correctly ignored FIX-102
  as out of scope). stateHistory: `planned → launching → running → completed`,
  generation 1. `results/generation-1.json` present. ✅
- **Telemetry phase advanced (not stuck unknown)?** YES — `phase settled`,
  `observability reported`, `cost 0.037`. The lifecycle extension drove the run
  state; the observability extension recorded telemetry. ✅
- **Assisted (follow-up → generation 2)?** NOT YET RUN — the operator ended the
  session after the autonomous handoff without typing a follow-up. Optional
  next pass.
- **Two bugs found:**
  1. Widget showed `Cost: $[object Object]` and never showed tokens — FIXED on
     this branch (`buildObservabilityLines`).
  2. Launch report said `partial`/`failed` with `Tab/Pane: unknown` although the
     run completed successfully — the interactive launch under-reports the started
     tab/pane. Tracked as a follow-up.
- **Herdr `agent start --kind pi`:** the pane launched and Pi ran; the only issue
  was the report's tab/pane resolution above, not the launch itself.

### Also fixed while running Task 8

- The CLI `--dry-run → --yes` flow failed with `Stale approval digest` because
  `dryRun` leaked into the approval digest. FIXED (`launch.js` volatile keys).

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
