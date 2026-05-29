const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  reinterpretLlmUtcIsoAsLocalWallClock,
  zonedWallClock,
} = require("../src/access/accessLocalTime");
const { checkWeeklySchedule } = require("../src/access/reservationRules");

describe("accessLocalTime", () => {
  it("reinterprets LLM Z suffix as America/New_York wall clock", () => {
    const iso = reinterpretLlmUtcIsoAsLocalWallClock(
      "2026-05-28T10:00:00.000Z",
      "America/New_York"
    );
    const z = zonedWallClock(iso, "America/New_York");
    assert.equal(z.hour, 10);
    assert.equal(z.minute, 0);
  });

  it("allows 10am-12pm Eastern within 08:00-23:00 schedule", () => {
    const start = new Date(
      reinterpretLlmUtcIsoAsLocalWallClock("2026-05-28T10:00:00.000Z", "America/New_York")
    );
    const end = new Date(
      reinterpretLlmUtcIsoAsLocalWallClock("2026-05-28T12:00:00.000Z", "America/New_York")
    );
    const dow = zonedWallClock(start, "America/New_York").dayOfWeek;
    const schedules = [{ day_of_week: dow, open_time: "08:00", close_time: "23:00" }];
    const r = checkWeeklySchedule(schedules, start, end, "America/New_York");
    assert.equal(r.ok, true);
  });
});
