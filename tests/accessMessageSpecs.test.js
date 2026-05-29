const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAccessMessageText,
  getAccessMessageSpec,
} = require("../src/outgate/accessMessageSpecs");

describe("accessMessageSpecs", () => {
  const ctx = {
    locationName: "Gameroom",
    tenantName: "Alex Reed",
    unitLabel: "4B",
    startAt: "2026-05-27T19:00:00Z",
    endAt: "2026-05-27T21:00:00Z",
    timeZone: "UTC",
    pin: "4321",
  };

  it("returns known spec", () => {
    const spec = getAccessMessageSpec("ACCESS_TENANT_RESERVATION_CONFIRMED");
    assert.equal(spec?.templateKey, "ACCESS_TENANT_RESERVATION_CONFIRMED");
  });

  it("builds tenant confirmation copy with pin", () => {
    const text = buildAccessMessageText("ACCESS_TENANT_RESERVATION_CONFIRMED", ctx);
    assert.match(text, /Gameroom/);
    assert.match(text, /4321/);
  });

  it("builds staff approval copy with tenant context", () => {
    const text = buildAccessMessageText("ACCESS_STAFF_APPROVAL_REQUIRED", ctx);
    assert.match(text, /Alex Reed/);
    assert.match(text, /unit 4B/i);
  });
});
