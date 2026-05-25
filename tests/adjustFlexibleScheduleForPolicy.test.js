"use strict";

process.env.TZ = "America/New_York";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePreferredWindowShared,
} = require("../src/brain/gas/parsePreferredWindowShared");
const {
  adjustFlexibleScheduleForPolicy,
} = require("../src/brain/gas/adjustFlexibleScheduleForPolicy");

/** Sun May 24, 2026 noon Eastern */
const SUNDAY = new Date(2026, 4, 24, 12, 0, 0);

const POLICY_NO_SUNDAY = {
  earliestHour: 9,
  latestHour: 17,
  allowWeekends: false,
  schedSatAllowed: false,
  schedSunAllowed: false,
  minLeadHours: 0,
  maxDaysOut: 14,
  schedSatLatestHour: 17,
};

describe("adjustFlexibleScheduleForPolicy", () => {
  it("whenever on Sunday → Monday anytime when Sunday blocked", () => {
    const raw = "i dont know whenever they can";
    const stageDay = "Today";
    const opts = { now: SUNDAY, timeZone: "America/New_York" };
    const d = parsePreferredWindowShared(raw, stageDay, opts);
    assert.ok(d);
    assert.equal(d.kind, "ANYTIME");
    assert.match(String(d.label), /Sun May 24/i);

    const { parsed, adjusted } = adjustFlexibleScheduleForPolicy(
      d,
      { label: raw },
      raw,
      stageDay,
      opts,
      "MORRIS",
      POLICY_NO_SUNDAY
    );

    assert.equal(adjusted, true);
    assert.match(String(parsed.label), /Mon May 25/i);
    assert.match(String(parsed.label), /anytime/i);
    assert.doesNotMatch(String(parsed.label), /Sun May 24/i);
  });

  it("does not bump when implicit day already policy-allowed", () => {
    const friday = new Date(2026, 4, 22, 10, 0, 0);
    const raw = "Monday anytime";
    const stageDay = null;
    const opts = { now: friday, timeZone: "America/New_York" };
    const d = parsePreferredWindowShared(raw, stageDay, opts);
    assert.ok(d);

    const { parsed, adjusted } = adjustFlexibleScheduleForPolicy(
      d,
      {},
      raw,
      stageDay,
      opts,
      "MORRIS",
      POLICY_NO_SUNDAY
    );

    assert.equal(adjusted, false);
    assert.match(String(parsed.label), /Mon May 25/i);
  });
});
