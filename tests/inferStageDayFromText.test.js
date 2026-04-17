/**
 * GAS `inferStageDayFromText_` parity — `17_PROPERTY_SCHEDULE_ENGINE.gs`
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  inferStageDayFromText_,
} = require("../src/brain/gas/inferStageDayFromText");

describe("inferStageDayFromText_", () => {
  test("tomorrow variants → Tomorrow", () => {
    assert.equal(inferStageDayFromText_("see you tomorrow", null), "Tomorrow");
    assert.equal(inferStageDayFromText_("tmrw 9-11", null), "Tomorrow");
  });
  test("today → Today", () => {
    assert.equal(inferStageDayFromText_("today afternoon", null), "Today");
  });
  test("fallback day word", () => {
    assert.equal(inferStageDayFromText_("9-11", "tomorrow"), "Tomorrow");
    assert.equal(inferStageDayFromText_("9-11", ""), "Today");
  });
});
