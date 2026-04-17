const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recomputeDraftExpected,
} = require("../src/brain/core/recomputeDraftExpected");

test("empty draft → ISSUE", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: false,
    hasProperty: false,
    hasUnit: false,
    pendingTicketRow: 0,
  });
  assert.equal(next, "ISSUE");
});

test("issue only → PROPERTY", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: false,
    hasUnit: false,
    pendingTicketRow: 0,
  });
  assert.equal(next, "PROPERTY");
});

test("issue + property → UNIT", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: false,
    pendingTicketRow: 0,
  });
  assert.equal(next, "UNIT");
});

test("all three pre-ticket → FINALIZE_DRAFT", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    pendingTicketRow: 0,
  });
  assert.equal(next, "FINALIZE_DRAFT");
});

test("all three pre-ticket + openerNext=SCHEDULE → SCHEDULE_PRETICKET", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    pendingTicketRow: 0,
    openerNext: "SCHEDULE",
  });
  assert.equal(next, "SCHEDULE_PRETICKET");
});

test("pre-ticket with schedule already filled does not stay SCHEDULE_PRETICKET", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: true,
    pendingTicketRow: 0,
    openerNext: "SCHEDULE",
  });
  assert.equal(next, "FINALIZE_DRAFT");
});

test("post-ticket row without schedule → SCHEDULE", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: false,
    pendingTicketRow: 5,
  });
  assert.equal(next, "SCHEDULE");
});

test("emergency continuation skips SCHEDULE → EMERGENCY_DONE", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: false,
    pendingTicketRow: 5,
    isEmergencyContinuation: true,
  });
  assert.equal(next, "EMERGENCY_DONE");
});

test("emergency continuation skips SCHEDULE_PRETICKET → EMERGENCY_DONE", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: false,
    pendingTicketRow: 0,
    openerNext: "SCHEDULE",
    isEmergencyContinuation: true,
  });
  assert.equal(next, "EMERGENCY_DONE");
});
