const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveOperatingHoursForDay,
  resolveOperatingHoursForAnchor,
} = require("../../src/access/scheduleForDay");

describe("scheduleForDay", () => {
  const gameRoomWeek = [];
  for (let dow = 0; dow <= 6; dow++) {
    gameRoomWeek.push({ day_of_week: dow, open_time: "08:00", close_time: "23:00" });
  }

  it("formats operating hours for a weekday", () => {
    const info = resolveOperatingHoursForDay(gameRoomWeek, 3);
    assert.equal(info.closed, false);
    assert.match(info.label, /8:00 AM/);
    assert.match(info.label, /11:00 PM/);
  });

  it("marks day closed when schedule has no row for that dow", () => {
    const info = resolveOperatingHoursForDay(
      [{ day_of_week: 0, open_time: "08:00", close_time: "23:00" }],
      3
    );
    assert.equal(info.closed, true);
  });

  it("resolves from anchor iso in property tz", () => {
    // 2026-05-31 noon UTC anchor → Sunday in America/New_York (May 31 2026 is Sunday)
    const info = resolveOperatingHoursForAnchor(
      "2026-05-31T16:00:00.000Z",
      gameRoomWeek,
      "America/New_York"
    );
    assert.equal(info.closed, false);
    assert.ok(info.label.length > 0);
  });
});
