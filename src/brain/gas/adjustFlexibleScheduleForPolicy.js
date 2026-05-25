/**
 * Bump flexible preferred windows (ANYTIME / ASAP) when the implicit day fails schedule policy.
 * GAS parity: validate before commit; flexible "whenever" should land on next allowed day, not a blocked Sunday.
 */
const {
  validateSchedPolicy_,
} = require("./validateSchedPolicy");
const {
  implicitDayFromParsed,
  formatDayShared,
  startOfDayShared,
  addDaysShared,
} = require("./parsePreferredWindowShared");

const MAX_BUMP_DAYS = 14;

/**
 * @param {Date} dayStart
 * @param {string} propCode
 * @param {object} policySnapshot
 * @param {Date} now
 * @returns {Date|null}
 */
function nextPolicyAllowedDay(dayStart, propCode, policySnapshot, now) {
  let candidate = startOfDayShared(dayStart);
  for (let i = 0; i < MAX_BUMP_DAYS; i++) {
    const sched = { date: candidate };
    const verdict = validateSchedPolicy_(propCode, sched, now, policySnapshot);
    if (verdict.ok) return candidate;
    const key = verdict && verdict.key ? String(verdict.key) : "";
    if (key === "SCHED_REJECT_WEEKEND" || key === "SCHED_REJECT_TOO_SOON") {
      candidate = startOfDayShared(addDaysShared(candidate, 1));
      continue;
    }
    return null;
  }
  return null;
}

/**
 * @param {object|null} d — parsed preferred window
 * @param {object} sched — sched object for validateSchedPolicy_
 * @param {string} raw — tenant text
 * @param {string} stageDay
 * @param {{ now?: Date, timeZone?: string }} opts
 * @param {string} propCode
 * @param {object} policySnapshot
 * @returns {{ parsed: object|null, sched: object, adjusted: boolean }}
 */
function adjustFlexibleScheduleForPolicy(
  d,
  sched,
  raw,
  stageDay,
  opts,
  propCode,
  policySnapshot
) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const tz =
    o.timeZone ||
    (typeof process !== "undefined" && process.env && process.env.TZ) ||
    "UTC";

  if (!d) return { parsed: d, sched, adjusted: false };

  const kind = String(d.kind || "").toUpperCase();
  if (kind !== "ANYTIME" && kind !== "ASAP") {
    return { parsed: d, sched, adjusted: false };
  }

  const implicitDay = implicitDayFromParsed(d, raw, stageDay, now);
  if (!implicitDay) return { parsed: d, sched, adjusted: false };

  const allowedDay = nextPolicyAllowedDay(
    implicitDay,
    propCode,
    policySnapshot,
    now
  );
  if (!allowedDay) return { parsed: d, sched, adjusted: false };

  if (allowedDay.getTime() === implicitDay.getTime()) {
    return {
      parsed: d,
      sched: { ...sched, date: implicitDay },
      adjusted: false,
    };
  }

  const suffix = kind === "ASAP" ? " ASAP" : " anytime";
  const label = formatDayShared(allowedDay, tz) + suffix;
  const parsed = { ...d, label };
  const nextSched = {
    ...sched,
    label,
    date: allowedDay,
  };
  delete nextSched.startHour;
  delete nextSched.endHour;
  return { parsed, sched: nextSched, adjusted: true };
}

module.exports = {
  adjustFlexibleScheduleForPolicy,
  nextPolicyAllowedDay,
};
