import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTicketBundle } from "../src/workflow/tickets.js";

test("normalizes related tickets without changing primary identity", () => {
  assert.deepEqual(normalizeTicketBundle({
    primary: "SHARY-123",
    related: ["SHARY-152", "SHARY-140", "SHARY-140"],
    maxTickets: 10,
  }), {
    primary: "SHARY-123",
    related: ["SHARY-140", "SHARY-152"],
    all: ["SHARY-123", "SHARY-140", "SHARY-152"],
  });
});

test("rejects the primary in the related set and bounded overflow", () => {
  assert.throws(() => normalizeTicketBundle({ primary: "A-1", related: ["A-1"], maxTickets: 10 }), /primary/i);
  assert.throws(() => normalizeTicketBundle({ primary: "A-1", related: ["A-2", "A-3"], maxTickets: 2 }), /maximum.*2/i);
});

test("rejects empty, unsafe, and invalid bundle inputs", () => {
  assert.throws(() => normalizeTicketBundle({ primary: "", maxTickets: 10 }), /primary|task|empty/i);
  assert.throws(() => normalizeTicketBundle({ primary: "A-1", related: ["../escape"], maxTickets: 10 }), /task|traversal|path/i);
  assert.throws(() => normalizeTicketBundle({ primary: "A-1", related: ["A-2"], maxTickets: 0 }), /positive|bundle|max/i);
});

test("sorts normalized related tickets deterministically", () => {
  assert.deepEqual(normalizeTicketBundle({
    primary: "A-1",
    related: ["A 3", "A-20", "A 3", "A-2"],
    maxTickets: 10,
  }), {
    primary: "A-1",
    related: ["A-2", "A-20", "A-3"],
    all: ["A-1", "A-2", "A-20", "A-3"],
  });
});
