const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkDuration,
  checkAdvanceWindow,
  checkCapacity,
  checkWeeklySchedule,
  checkBlackouts,
  evaluateCanReserve,
} = require("../src/access/reservationRules");

const basePolicy = {
  min_duration_min: 30,
  max_duration_min: 120,
  advance_booking_min: 60,
  advance_booking_max_days: 14,
  same_day_allowed: true,
  max_concurrent: 1,
  requires_approval: false,
  deposit_amount: 0,
};

describe("access reservationRules", () => {
  it("rejects duration below minimum", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    const start = new Date("2026-05-21T15:00:00Z");
    const end = new Date("2026-05-21T15:15:00Z");
    const r = checkDuration(basePolicy, start, end, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "duration_too_short");
  });

  it("rejects booking too soon", () => {
    const now = new Date("2026-05-21T10:00:00Z");
    const start = new Date("2026-05-21T10:30:00Z");
    const r = checkAdvanceWindow(basePolicy, start, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "too_soon");
  });

  it("rejects when concurrent slot full", () => {
    const r = checkCapacity(
      [{ status: "CONFIRMED" }],
      { max_concurrent: 1 }
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "slot_full");
  });

  it("rejects outside weekly hours", () => {
    const start = new Date(2026, 4, 21, 6, 0, 0);
    const end = new Date(2026, 4, 21, 7, 0, 0);
    const schedules = [{ day_of_week: start.getDay(), open_time: "08:00", close_time: "23:00" }];
    const r = checkWeeklySchedule(schedules, start, end);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "outside_hours");
  });

  it("rejects blackout overlap", () => {
    const start = new Date("2026-05-21T14:00:00Z");
    const end = new Date("2026-05-21T16:00:00Z");
    const r = checkBlackouts(
      [{ start_at: "2026-05-21T15:00:00Z", end_at: "2026-05-21T17:00:00Z" }],
      start,
      end
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "blackout");
  });

  it("allows valid window with staff override skipping advance", () => {
    const now = new Date(2026, 4, 21, 10, 0, 0);
    const start = new Date(2026, 4, 21, 10, 20, 0);
    const end = new Date(2026, 4, 21, 11, 0, 0);
    const dow = start.getDay();
    const out = evaluateCanReserve(
      basePolicy,
      { staffOverride: true },
      start,
      end,
      {
        overlapping: [],
        tenantReservations: [],
        schedules: [{ day_of_week: dow, open_time: "08:00", close_time: "23:00" }],
        blackouts: [],
      },
      now
    );
    assert.equal(out.allowed, true);
    assert.equal(out.requiresApproval, false);
  });
});
