import { WorkflowError } from "./errors.js";

export const RUN_STATES = Object.freeze({
  PLANNED: "planned",
  LAUNCHING: "launching",
  RUNNING: "running",
  IDLE_AWAITING_HANDOFF: "idle-awaiting-handoff",
  NEEDS_INPUT: "needs-input",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
  MANUAL_HANDOFF_REQUIRED: "manual-handoff-required",
  RESULT_STALE: "result-stale",
});

// The board's default view, defined next to the states so a new state has to be classified
// deliberately rather than defaulting in or out.
// NOT a state-machine property: completed/failed/interrupted can all transition back to
// running via resume (see ALLOWED below). This is a presentation decision about what an
// operator wants to see as currently in play, not a terminal/non-terminal split the state
// machine itself defines. `planned` is live: a run that never launched is either about to or
// is residue, and both want attention.
export const LIVE_RUN_STATES = Object.freeze(new Set([
  RUN_STATES.PLANNED,
  RUN_STATES.LAUNCHING,
  RUN_STATES.RUNNING,
  RUN_STATES.IDLE_AWAITING_HANDOFF,
  RUN_STATES.NEEDS_INPUT,
  RUN_STATES.BLOCKED,
  RUN_STATES.MANUAL_HANDOFF_REQUIRED,
  RUN_STATES.RESULT_STALE,
]));

const ALLOWED = Object.freeze({
  [RUN_STATES.PLANNED]: new Set([RUN_STATES.LAUNCHING, RUN_STATES.FAILED]),
  [RUN_STATES.LAUNCHING]: new Set([RUN_STATES.RUNNING, RUN_STATES.FAILED, RUN_STATES.INTERRUPTED]),
  [RUN_STATES.RUNNING]: new Set([
    RUN_STATES.IDLE_AWAITING_HANDOFF,
    RUN_STATES.NEEDS_INPUT,
    RUN_STATES.COMPLETED,
    RUN_STATES.BLOCKED,
    RUN_STATES.FAILED,
    RUN_STATES.INTERRUPTED,
    RUN_STATES.MANUAL_HANDOFF_REQUIRED,
    RUN_STATES.RESULT_STALE,
  ]),
  [RUN_STATES.IDLE_AWAITING_HANDOFF]: new Set([
    RUN_STATES.RUNNING,
    RUN_STATES.NEEDS_INPUT,
    RUN_STATES.COMPLETED,
    RUN_STATES.BLOCKED,
    RUN_STATES.FAILED,
    RUN_STATES.INTERRUPTED,
    RUN_STATES.MANUAL_HANDOFF_REQUIRED,
    RUN_STATES.RESULT_STALE,
  ]),
  [RUN_STATES.NEEDS_INPUT]: new Set([RUN_STATES.RUNNING, RUN_STATES.INTERRUPTED, RUN_STATES.RESULT_STALE]),
  [RUN_STATES.COMPLETED]: new Set([RUN_STATES.RUNNING, RUN_STATES.RESULT_STALE]),
  [RUN_STATES.BLOCKED]: new Set([RUN_STATES.RUNNING, RUN_STATES.RESULT_STALE]),
  [RUN_STATES.FAILED]: new Set([RUN_STATES.RUNNING, RUN_STATES.RESULT_STALE]),
  [RUN_STATES.INTERRUPTED]: new Set([RUN_STATES.RUNNING]),
  [RUN_STATES.MANUAL_HANDOFF_REQUIRED]: new Set([RUN_STATES.RUNNING]),
  [RUN_STATES.RESULT_STALE]: new Set([RUN_STATES.RUNNING]),
});

const STATE_VALUES = new Set(Object.values(RUN_STATES));

function fail(message) {
  throw new WorkflowError("run-state", message);
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
}

function assertKnownState(state, context) {
  if (typeof state !== "string" || !STATE_VALUES.has(state)) {
    fail(`Unknown ${context}`);
  }
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  fail("transition timestamp is required");
}

export function transitionRun(run, nextState, patch = {}) {
  assertObject(run, "run");
  assertObject(patch, "transition patch");
  assertKnownState(run.state, "current run state");
  assertKnownState(nextState, "next run state");

  if (run.state === nextState) {
    fail(`Illegal run state transition from ${run.state} to ${nextState}`);
  }
  if (!ALLOWED[run.state].has(nextState)) {
    fail(`Illegal run state transition from ${run.state} to ${nextState}`);
  }

  const at = normalizeTimestamp(patch.updatedAt ?? patch.timestamp ?? new Date());
  const { state: _state, stateHistory: _stateHistory, ...safePatch } = patch;
  const stateHistory = Array.isArray(run.stateHistory) ? run.stateHistory : [];

  return {
    ...run,
    ...safePatch,
    state: nextState,
    updatedAt: at,
    stateHistory: [
      ...stateHistory,
      { from: run.state, to: nextState, at },
    ],
  };
}

export function isRunState(value) {
  return STATE_VALUES.has(value);
}

// Non-throwing counterpart to transitionRun's legality check. Callers that must not
// let an illegal transition throw (e.g. fire-and-forget event handlers) can decide
// what to do about it themselves instead of relying on a caught exception.
export function canTransition(from, to) {
  return ALLOWED[from]?.has(to) ?? false;
}
