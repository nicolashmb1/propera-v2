const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recomputeDraftExpected,
  expiryMinutesForExpectedStage,
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

test("staff `#` capture: openerNext=SCHEDULE ignored → FINALIZE_DRAFT (no schedule prompt)", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: false,
    pendingTicketRow: 0,
    openerNext: "SCHEDULE",
    staffCaptureNoScheduleAsk: true,
  });
  assert.equal(next, "FINALIZE_DRAFT");
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

test("GAS ~161–171: emergency guard applies to SCHEDULE only, not SCHEDULE_PRETICKET", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: false,
    pendingTicketRow: 0,
    openerNext: "SCHEDULE",
    isEmergencyContinuation: true,
  });
  assert.equal(next, "SCHEDULE_PRETICKET");
});

test("post-ticket row with schedule already set → next empty (GAS ~150–157)", () => {
  const { next, expiryMinutes } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: true,
    pendingTicketRow: 5,
  });
  assert.equal(next, "");
  assert.equal(expiryMinutes, null);
});

test("skipScheduling forces SCHEDULE → EMERGENCY_DONE (GAS ctx skipScheduling)", () => {
  const { next } = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    hasSchedule: false,
    pendingTicketRow: 5,
    skipScheduling: true,
  });
  assert.equal(next, "EMERGENCY_DONE");
});

test("expiryMinutes: 30 for SCHEDULE / SCHEDULE_PRETICKET, else 10", () => {
  assert.equal(expiryMinutesForExpectedStage("SCHEDULE"), 30);
  assert.equal(expiryMinutesForExpectedStage("SCHEDULE_PRETICKET"), 30);
  assert.equal(expiryMinutesForExpectedStage("PROPERTY"), 10);
  assert.equal(expiryMinutesForExpectedStage(""), null);
  const r = recomputeDraftExpected({
    hasIssue: true,
    hasProperty: true,
    hasUnit: true,
    pendingTicketRow: 0,
  });
  assert.equal(r.expiryMinutes, 10);
});
