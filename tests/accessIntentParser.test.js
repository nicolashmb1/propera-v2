const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ACCESS_INTENT_TYPES,
  detectAccessIntent,
  parseAccessWindow,
  dateForDayToAnchorIso,
} = require("../src/access/parseAccessIntent");
const { zonedWallClock } = require("../src/access/accessLocalTime");

describe("access parseAccessIntent", () => {
  it("detects reserve intent", () => {
    assert.equal(
      detectAccessIntent("book gameroom tomorrow 3-5 pm"),
      ACCESS_INTENT_TYPES.RESERVE
    );
  });

  it("detects cancel intent", () => {
    assert.equal(
      detectAccessIntent("please cancel my gym reservation"),
      ACCESS_INTENT_TYPES.CANCEL
    );
  });

  it("detects status intent", () => {
    assert.equal(
      detectAccessIntent("when is my sauna booking"),
      ACCESS_INTENT_TYPES.STATUS
    );
  });

  it("detects list_slots in active session without amenity name", () => {
    assert.equal(
      detectAccessIntent("what times are available?", {
        locationId: "aca90432-7fca-43e0-9336-37645727b6cc",
        accessSessionActive: true,
      }),
      ACCESS_INTENT_TYPES.LIST_SLOTS
    );
  });

  it("parses tomorrow time range", () => {
    const out = parseAccessWindow(
      "book gameroom tomorrow 3-5 pm",
      new Date("2026-05-26T10:00:00Z"),
      "America/New_York"
    );
    assert.equal(Boolean(out && out.startAt && out.endAt), true);
    const { zonedWallClock } = require("../src/access/accessLocalTime");
    const z = zonedWallClock(out.startAt, "America/New_York");
    assert.equal(z.hour, 15);
    assert.equal(z.minute, 0);
  });

  it("parses after X till Y pm with tomorrow", () => {
    const out = parseAccessWindow(
      "tomorrow after 3 till 5 pm",
      new Date("2026-05-26T10:00:00Z"),
      "America/New_York"
    );
    assert.equal(Boolean(out && out.startAt && out.endAt), true);
    const { zonedWallClock } = require("../src/access/accessLocalTime");
    const start = zonedWallClock(out.startAt, "America/New_York");
    const end = zonedWallClock(out.endAt, "America/New_York");
    assert.equal(start.hour, 15);
    assert.equal(end.hour, 17);
  });

  it("infers pm for bare afternoon-style range without meridiem", () => {
    const out = parseAccessWindow(
      "tomorrow 2-4",
      new Date("2026-05-26T10:00:00Z"),
      "America/New_York"
    );
    assert.equal(Boolean(out && out.startAt && out.endAt), true);
    const { zonedWallClock } = require("../src/access/accessLocalTime");
    const start = zonedWallClock(out.startAt, "America/New_York");
    const end = zonedWallClock(out.endAt, "America/New_York");
    assert.equal(start.hour, 14);
    assert.equal(end.hour, 16);
  });

  it("parses part-of-day availability window", () => {
    const out = parseAccessWindow(
      "what is free saturday afternoon",
      new Date("2026-05-26T10:00:00Z")
    );
    assert.equal(Boolean(out && out.startAt && out.endAt), true);
    const start = new Date(out.startAt);
    const end = new Date(out.endAt);
    assert.equal(end.getTime() - start.getTime(), 5 * 60 * 60 * 1000);
  });

  it("resolves bare weekday token to next occurrence (Wed -> Sunday)", () => {
    // Wednesday 2026-05-27 17:00 UTC = 1 PM EDT — squarely on Wednesday in NY.
    const now = new Date("2026-05-27T17:00:00Z");
    const iso = dateForDayToAnchorIso("sunday", now, "America/New_York");
    const z = zonedWallClock(iso, "America/New_York");
    assert.equal(z.year, 2026);
    assert.equal(z.month, 5);
    assert.equal(z.day, 31);
    assert.equal(z.dayOfWeek, 0); // 0 = Sunday
  });

  it("resolves bare YYYY-MM-DD token directly", () => {
    const now = new Date("2026-05-27T17:00:00Z");
    const iso = dateForDayToAnchorIso("2026-05-31", now, "America/New_York");
    const z = zonedWallClock(iso, "America/New_York");
    assert.equal(z.year, 2026);
    assert.equal(z.month, 5);
    assert.equal(z.day, 31);
  });

  it("resolves saturday from Wednesday to next Saturday", () => {
    const now = new Date("2026-05-27T17:00:00Z");
    const iso = dateForDayToAnchorIso("saturday", now, "America/New_York");
    const z = zonedWallClock(iso, "America/New_York");
    assert.equal(z.day, 30);
    assert.equal(z.dayOfWeek, 6);
  });
});
