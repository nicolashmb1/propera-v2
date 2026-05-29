const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { propertyDayBoundsUtc, zonedWallClock } = require("../src/access/accessLocalTime");

describe("propertyDayBoundsUtc", () => {
  it("covers full property-local day for Eastern anchor", () => {
    const anchor = "2026-05-28T16:00:00.000Z";
    const { startUtc, endUtc } = propertyDayBoundsUtc(anchor, "America/New_York");
    const startZ = zonedWallClock(startUtc, "America/New_York");
    const endZ = zonedWallClock(endUtc, "America/New_York");
    assert.equal(startZ.hour, 0);
    assert.equal(startZ.minute, 0);
    assert.equal(startZ.day, 28);
    assert.equal(endZ.day, 29);
    assert.equal(endZ.hour, 0);
  });
});
