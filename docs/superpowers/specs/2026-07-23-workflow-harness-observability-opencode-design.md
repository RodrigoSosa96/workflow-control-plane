# Workflow Harness Observability and OpenCode Design

**Status:** Approved for planning

## Goal

Make Workflow-launched harnesses observable without making terminal/transcript content authoritative, and introduce OpenCode as a fourth harness behind disposable-fixture and canary gates.

The feature provides:

- normalized, private telemetry for Pi, Claude Code, Codex, and OpenCode;
- a read-only terminal surface for current status and followable updates;
- a project-local Pi widget for the current Pi worker session; and
- an `opencode-worker` candidate profile that cannot be selected by a real registered project until fixture and canary gates are explicitly passed.

## Non-goals

- Altering the host coding-agent chat UI directly. The host harness owns that UI; it may consume Workflow's compact JSON/event output but Workflow cannot replace its rendering.
- Reading, storing, or displaying prompts, assistant text, thinking text, transcripts, stdout/stderr, tool arguments, credentials, or token values.
- Estimating token counts or cost when a harness/provider does not report them.
- Session guessing, global Pi/OpenCode state, package installation, permission/trust bypasses, terminal scraping, automatic cleanup, release, kill, deploy, push, or merge.
- Enabling internal background writers.
- Running real models, Herdr sessions, fixtures, or canaries as automated test side effects.

## Authority and privacy model

Workflow remains the authority for lifecycle, worktrees, reservations, canonical external handoffs, and internal advisory delegation results. Telemetry is observational only: it cannot make a handoff canonical, authorize a retry, bypass a permission, or change result state.

Each external worker receives a private telemetry directory below its existing private run directory:

```text
<run-dir>/telemetry/
  workers/<worker-id>.json
  events.jsonl
```

The worker snapshot is rewritten atomically. Event records are append-only and bounded. Both are private run artifacts. Public CLI output is a redacted projection.

Allowed persisted/public telemetry fields are bounded identifiers and measurements:

- schema version, run ID, opaque worker ID, harness/profile/model/thinking-or-effort;
- exact process/session identity held privately, with public status exposing only safe state classifications;
- phase, elapsed timestamps, turn count, tool-name/count summaries, retry/compaction state;
- provider-reported input/output/cache tokens, context use, and cost; and
- a per-field availability value: `reported`, `not-reported`, or `unknown`.

No raw provider event is persisted. Unknown event types or malformed values produce a bounded `unknown` telemetry state and do not make an action safe.

## Normalized telemetry contract

A `HarnessTelemetryAdapter` consumes an official structured harness stream and emits a strictly validated normalized event. It has no authority to spawn, terminate, resume, or hand off work.

Common phases:

```text
starting → running ↔ tool | retrying | compacting
running → settled | failed | unknown | manual-recovery
```

An adapter can emit only recognized lifecycle changes, safe tool names, model metadata, and explicit provider usage. Missing usage remains `not-reported`; it is never calculated from text or duration.

Harness sources:

| Harness | Structured source | Usage policy |
|---|---|---|
| Pi | RPC state/events and `get_session_stats` | Per-session input/output/cache/cost/context if Pi reports it. |
| Claude Code | `--output-format stream-json`, optionally partial/hook events | Normalize only fields present in its documented JSON events. |
| Codex | `codex exec --json` | Normalize only tested JSONL fields. |
| OpenCode | `opencode run --format json` | Normalize only tested JSON fields; `opencode stats` is historical aggregate data and never attributed to an individual run. |

Every adapter is version-aware and has fixture contract tests. A changed or unsupported stream is `unknown`, not a best-effort parse.

## Operator surfaces

### Workflow CLI

Add read-only commands:

```text
workflow worker status <run-id> [--format compact|json]
workflow worker watch <run-id> [--format compact|json]
```

`status` returns the current redacted snapshots. `watch` follows Workflow-owned private telemetry changes and emits compact lines or JSON records suitable for a controller to summarize in a host chat. It never opens an arbitrary session, reads a terminal, or polls global harness history.

A compact line may show:

```text
[OpenCode • run-id • running] model: provider/model | turn 2 | tool: edit | 01:14
usage: 12.4k input / 1.1k output | cost: not-reported
```

Public output redacts session IDs, session paths, run paths, claim tokens, tool arguments, and event payload text.

### Pi widget

A project-local, explicitly loaded Pi extension renders the current Pi worker's model, thinking level, phase, turn/tool summary, elapsed time, and provider-reported usage. It starts only from `session_start`, tears down idempotently on `session_shutdown`, and has no global watcher.

The widget writes only the normalized private telemetry artifact for its exact Workflow run. It neither observes unrelated sessions nor reads `~/.pi` state. In non-TUI modes it emits no UI and preserves the same telemetry safety contract.

### Host-chat bridge

The repository cannot alter the UI of the outer coding-agent harness. A controller may subscribe to `workflow worker watch --format json` and render its own compact start/progress/settled summaries. This bridge is opt-in and carries only the redacted contract above.

## OpenCode integration

Add `opencode` as a registry harness and `opencode-worker` profile. Its launch builder uses argv only and its documented structured run mode; it inherits Workflow's exact worktree cwd and allowlisted `WORKFLOW_*` environment. It receives the standard external handoff instruction and can achieve a canonical result only through the existing bounded handoff command.

OpenCode must not use a recent-session shortcut, a global session lookup, shell interpolation, or a security-bypass flag. Until validation succeeds:

- `opencode-worker` is valid only in generated fixture registries;
- canonical project `allowed_agent_profiles` do not include it;
- real-project OpenCode writes are rejected by policy; and
- absence of a stable OpenCode session/identity or structured telemetry keeps recovery manual.

Promotion requires a reviewed fixture sequence and a separately approved, preserved real OpenCode canary. It does not alter background-writer policy.

## Implementation stages and gates

1. Correct README/tests so only implemented CLI commands are presented as current; lifecycle-hook/resume/close commands remain explicitly future work.
2. Implement private telemetry schema/store, strict redaction/formatting, adapters, and `worker status/watch` with fake structured events.
3. Add the Pi widget using fake Pi extension APIs and no real process.
4. Add registry/harness/doctor/preview support for fixture-only `opencode-worker`; test argv, safety validation, and profile gating.
5. Implement the fixture generator and deterministic fake workers for Pi, Claude, Codex, and OpenCode.
6. Run deterministic policy/transport fakes, read-only foreground/background delegation fixtures, then a single writer fixture in a fixture-owned worktree.
7. Run an explicitly approved real-Herdr fake-worker smoke.
8. With a separate approval for each, run preserved Pi, Claude, Codex, then OpenCode canaries. Each must be TTY-only, warn about cost, require the selected harness name, and use `--keep`.
9. Review canary evidence and policy before proposing any OpenCode real-project allowlist change or internal background-writer change.

Every implementation stage uses red-green-refactor TDD, targeted tests, full `npm test`, `npm pack --dry-run`, `git diff --check`, specification review, and code-quality review. No real fixture or canary is implied by passing automated tests.

## Failure handling

- Parse/stream/schema/version failure: persist a bounded `unknown` telemetry state; do not infer completion, session identity, usage, or cost.
- Telemetry write failure: retain existing run/handoff truth; surface read-only manual recovery guidance without retrying or destroying resources.
- Widget failure: emit a bounded extension failure/unknown state; never block worker shutdown or result handoff.
- Any fixture assertion failure: preserve only its ownership-marked fixture resources and print safe inspection commands. It never touches canonical project paths.
- Any canary failure: preserve the approved fixture and Herdr references for manual inspection. No automatic kill, close, cleanup, or retry occurs.
