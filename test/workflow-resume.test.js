import assert from "node:assert/strict";
import { test } from "node:test";
import { planResume } from "../src/workflow/resume.js";
import { WorkflowError } from "../src/workflow/errors.js";

function deps({ observation, run }) {
  return {
    store: { async read() { return run; } },
    transport: {
      start() {}, deliverFollowUp() {}, requestGracefulClose() {},
      async observeExact() { return observation; },
    },
  };
}

test("a live session is resumed by focus; a dead one relaunches; a mismatch refuses", async () => {
  const identity = { kind: "pi-session", sessionId: "s1" };
  const run = { id: "r1", harness: "pi", transportIdentity: identity };
  assert.equal((await planResume({ ...deps({ observation: { state: "idle", identity }, run }), runId: "r1" })).action, "focus");
  assert.equal((await planResume({ ...deps({ observation: { state: "missing", identity }, run }), runId: "r1" })).action, "relaunch");
  assert.equal((await planResume({ ...deps({ observation: { state: "mismatch", identity }, run }), runId: "r1" })).action, "refuse");
});

test("a run with no transportIdentity is refused with a resume-category WorkflowError", async () => {
  const run = { id: "r1", harness: "pi" };
  const promise = planResume({ ...deps({ observation: { state: "idle" }, run }), runId: "r1" });
  await assert.rejects(promise, (err) => err instanceof WorkflowError && err.category === "resume");
});
