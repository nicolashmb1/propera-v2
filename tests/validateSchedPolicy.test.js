/**
 * GAS `validateSchedPolicy_` parity — `17_PROPERTY_SCHEDULE_ENGINE.gs`
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateSchedPolicy_,
  validateSchedWeekendAllowed_,
} = require("../src/brain/gas/validateSchedPolicy");

function basePol(over) {
  return Object.assign(
    {
      earliestHour: 9,
      latestHour: 18,
      allowWeekends: false,
      schedSatAllowed: false,
      schedSunAllowed: false,
      minLeadHours: 12,
      maxDaysOut: 14,
      schedSatLatestHour: NaN,
    },
    over || {}
  );
}

const now = new Date("2026-06-10T14:00:00.000Z"); // Wed

describe("validateSchedWeekendAllowed_", () => {
  test("legacy allow weekends", () => {
    const pol = basePol({ allowWeekends: true, schedSatAllowed: false });
    assert.equal(validateSchedWeekendAllowed_("PENN", 6, pol), true);
  });
  test("Saturday requires schedSatAllowed", () => {
    const pol = basePol({ schedSatAllowed: false });
    assert.equal(validateSchedWeekendAllowed_("PENN", 6, pol), false);
    assert.equal(validateSchedWeekendAllowed_("PENN", 6, basePol({ schedSatAllowed: true })), true);
  });
});

describe("validateSchedPolicy_", () => {
  test("hours inside window", () => {
    const d = new Date("2026-06-15T15:00:00.000Z"); // Mon next week
    const sched = { date: d, startHour: 10, endHour: 11 };
    const v = validateSchedPolicy_("PENN", sched, now, basePol());
    assert.equal(v.ok, true);
  });

  test("SCHED_REJECT_TOO_SOON", () => {
    const d = new Date(now.getTime() + 2 * 3600 * 1000); // 2h out, need 12h
    const sched = { date: d, startHour: 10, endHour: 11 };
    const v = validateSchedPolicy_("PENN", sched, now, basePol());
    assert.equal(v.ok, false);
    assert.equal(v.key, "SCHED_REJECT_TOO_SOON");
  });

  test("SCHED_REJECT_HOURS start before earliest", () => {
    const d = new Date("2026-06-15T15:00:00.000Z");
    const sched = { date: d, startHour: 7, endHour: 11 };
    const v = validateSchedPolicy_("PENN", sched, now, basePol({ earliestHour: 9 }));
    assert.equal(v.ok, false);
    assert.equal(v.key, "SCHED_REJECT_HOURS");
  });

  test("Saturday cap SCHED_SAT_LATEST_HOUR", () => {
    const sat = new Date("2026-06-13T15:00:00.000Z"); // Saturday
    assert.equal(sat.getDay(), 6);
    const sched = { date: sat, startHour: 10, endHour: 14 };
    const v = validateSchedPolicy_("PENN", sched, now, basePol({
      schedSatAllowed: true,
      latestHour: 18,
      schedSatLatestHour: 13,
    }));
    assert.equal(v.ok, false);
    assert.equal(v.key, "SCHED_REJECT_HOURS");
  });
});
