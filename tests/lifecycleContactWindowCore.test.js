const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  isInsideContactWindow,
  snapToContactWindow,
} = require("../src/brain/lifecycle/lifecycleContactWindowCore");

const policyWeekday = {
  earliest: 9,
  latest: 18,
  satAllowed: false,
  satLatest: 13,
  sunAllowed: false,
};

describe("lifecycleContactWindowCore", () => {
  test("weekday 10:30 inside 9–18", () => {
    const d = new Date("2026-04-20T14:30:00"); // Monday
    assert.equal(isInsideContactWindow(d, policyWeekday), true);
  });

  test("weekday 19:00 outside", () => {
    const d = new Date("2026-04-20T19:00:00");
    assert.equal(isInsideContactWindow(d, policyWeekday), false);
  });

  test("Sunday blocked when sunAllowed false", () => {
    const d = new Date("2026-04-19T12:00:00"); // Sunday
    assert.equal(isInsideContactWindow(d, policyWeekday), false);
  });

  test("snap before earliest → same day 9:00", () => {
    const d = new Date("2026-04-20T07:00:00");
    const out = snapToContactWindow(d, policyWeekday);
    assert.equal(out.getHours(), 9);
    assert.equal(out.getMinutes(), 0);
  });
});
