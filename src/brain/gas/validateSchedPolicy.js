/**
 * Port of GAS `validateSchedWeekendAllowed_` + `validateSchedPolicy_` — `17_PROPERTY_SCHEDULE_ENGINE.gs`
 * ~501–556. Policy numbers come from `getSchedPolicySnapshot` (`property_policy` / ppGet parity).
 */

/**
 * @typedef {{
 *   earliestHour: number,
 *   latestHour: number,
 *   allowWeekends: boolean,
 *   schedSatAllowed: boolean,
 *   schedSunAllowed: boolean,
 *   minLeadHours: number,
 *   maxDaysOut: number,
 *   schedSatLatestHour: number,
 * }} SchedPolicySnapshot
 */

/**
 * JS getDay(): 0=Sun, 6=Sat. Honors SCHED_SAT_ALLOWED / SCHED_SUN_ALLOWED + GLOBAL; legacy SCHED_ALLOW_WEEKENDS = both days.
 * @param {string} propCode
 * @param {number} jsDay
 * @param {SchedPolicySnapshot} pol
 */
function validateSchedWeekendAllowed_(propCode, jsDay, pol) {
  const legacy = !!pol.allowWeekends;
  if (legacy) return true;
  if (jsDay === 6) return !!pol.schedSatAllowed;
  if (jsDay === 0) return !!pol.schedSunAllowed;
  return true;
}

/**
 * @param {string} propCode
 * @param {{ date?: Date, startHour?: number|null, endHour?: number|null }} sched
 * @param {Date} now
 * @param {SchedPolicySnapshot} pol
 * @returns {{ ok: true } | { ok: false, key: string, vars: SchedPolicySnapshot }}
 */
function validateSchedPolicy_(propCode, sched, now, pol) {
  const earliest = pol.earliestHour;
  const latest = pol.latestHour;
  const leadHrs = pol.minLeadHours;
  const maxDays = pol.maxDaysOut;

  const vars = {
    earliestHour: earliest,
    latestHour: latest,
    allowWeekends: pol.allowWeekends,
    schedSatAllowed: pol.schedSatAllowed,
    schedSunAllowed: pol.schedSunAllowed,
    minLeadHours: leadHrs,
    maxDaysOut: maxDays,
  };

  let latestEff = latest;
  const targetDate =
    sched && sched.date instanceof Date && isFinite(sched.date.getTime())
      ? sched.date
      : null;

  if (targetDate) {
    const day = targetDate.getDay();
    const isWknd = day === 0 || day === 6;
    if (isWknd && !validateSchedWeekendAllowed_(propCode, day, pol)) {
      return { ok: false, key: "SCHED_REJECT_WEEKEND", vars };
    }

    if (day === 6) {
      const satCap = pol.schedSatLatestHour;
      if (isFinite(satCap)) latestEff = Math.min(Number(latest), satCap);
    }

    const deltaMs = targetDate.getTime() - now.getTime();
    if (deltaMs < leadHrs * 3600 * 1000) {
      return { ok: false, key: "SCHED_REJECT_TOO_SOON", vars };
    }
    if (deltaMs > maxDays * 86400 * 1000) {
      return { ok: false, key: "SCHED_REJECT_TOO_FAR", vars };
    }
  }

  const hStart =
    sched && isFinite(Number(sched.startHour)) ? Number(sched.startHour) : null;
  const hEnd =
    sched && isFinite(Number(sched.endHour)) ? Number(sched.endHour) : null;

  if (hStart != null && hStart < earliest) {
    return { ok: false, key: "SCHED_REJECT_HOURS", vars };
  }
  if (hEnd != null && hEnd > latestEff) {
    return { ok: false, key: "SCHED_REJECT_HOURS", vars };
  }

  return { ok: true };
}

module.exports = {
  validateSchedPolicy_,
  validateSchedWeekendAllowed_,
};
