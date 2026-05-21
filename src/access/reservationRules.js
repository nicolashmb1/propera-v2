/**
 * Pure policy checks — unit-testable without DB.
 */
const { BLOCKING_RESERVATION_STATUSES } = require("./constants");

/**
 * @param {Date} startAt
 * @param {Date} endAt
 * @returns {number}
 */
function durationMinutes(startAt, endAt) {
  return Math.round((endAt.getTime() - startAt.getTime()) / 60000);
}

/**
 * @param {object} policy
 * @param {Date} startAt
 * @param {Date} endAt
 * @param {Date} [now]
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkDuration(policy, startAt, endAt, now = new Date(), opts = {}) {
  if (!(endAt > startAt)) return { ok: false, reason: "invalid_time_range" };
  const mins = durationMinutes(startAt, endAt);
  const minD = Number(policy.min_duration_min) || 0;
  const maxD = Number(policy.max_duration_min) || 0;
  if (minD > 0 && mins < minD) return { ok: false, reason: "duration_too_short" };
  if (maxD > 0 && mins > maxD) return { ok: false, reason: "duration_too_long" };
  if (!opts.allowPastStart && startAt < now) return { ok: false, reason: "start_in_past" };
  return { ok: true };
}

/**
 * @param {object} policy
 * @param {Date} startAt
 * @param {Date} [now]
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkAdvanceWindow(policy, startAt, now = new Date()) {
  const advanceMin = Number(policy.advance_booking_min) || 0;
  const maxDays = Number(policy.advance_booking_max_days) || 0;
  const msUntil = startAt.getTime() - now.getTime();
  if (advanceMin > 0 && msUntil < advanceMin * 60000) {
    return { ok: false, reason: "too_soon" };
  }
  if (maxDays > 0) {
    const maxMs = maxDays * 24 * 60 * 60000;
    if (msUntil > maxMs) return { ok: false, reason: "too_far_ahead" };
  }
  if (!policy.same_day_allowed) {
    const startDay = startAt.toDateString();
    const nowDay = now.toDateString();
    if (startDay === nowDay) return { ok: false, reason: "same_day_not_allowed" };
  }
  return { ok: true };
}

/**
 * @param {object[]} overlapping
 * @param {object} policy
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkCapacity(overlapping, policy) {
  const max = Number(policy.max_concurrent) || 1;
  const blocking = (overlapping || []).filter((r) =>
    BLOCKING_RESERVATION_STATUSES.has(String(r.status || ""))
  );
  if (blocking.length >= max) return { ok: false, reason: "slot_full" };
  return { ok: true };
}

/**
 * @param {object} policy
 * @param {object[]} tenantReservations — same tenant, overlapping window not required for limits
 * @param {Date} startAt
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkTenantLimits(policy, tenantReservations, startAt) {
  const dayMax = policy.max_per_tenant_day;
  const weekMax = policy.max_per_tenant_week;
  const monthMax = policy.max_per_tenant_month;
  const rows = (tenantReservations || []).filter(
    (r) => !["CANCELLED", "COMPLETED", "NO_SHOW"].includes(String(r.status))
  );
  const dayStart = new Date(startAt);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  if (dayMax != null && dayMax > 0) {
    const n = rows.filter(
      (r) => new Date(r.start_at) >= dayStart && new Date(r.start_at) < dayEnd
    ).length;
    if (n >= dayMax) return { ok: false, reason: "tenant_daily_limit" };
  }

  if (weekMax != null && weekMax > 0) {
    const wStart = new Date(startAt);
    const dow = wStart.getDay();
    wStart.setDate(wStart.getDate() - dow);
    wStart.setHours(0, 0, 0, 0);
    const wEnd = new Date(wStart);
    wEnd.setDate(wEnd.getDate() + 7);
    const n = rows.filter(
      (r) => new Date(r.start_at) >= wStart && new Date(r.start_at) < wEnd
    ).length;
    if (n >= weekMax) return { ok: false, reason: "tenant_weekly_limit" };
  }

  if (monthMax != null && monthMax > 0) {
    const mStart = new Date(startAt.getFullYear(), startAt.getMonth(), 1);
    const mEnd = new Date(startAt.getFullYear(), startAt.getMonth() + 1, 1);
    const n = rows.filter(
      (r) => new Date(r.start_at) >= mStart && new Date(r.start_at) < mEnd
    ).length;
    if (n >= monthMax) return { ok: false, reason: "tenant_monthly_limit" };
  }

  return { ok: true };
}

/**
 * Weekly schedule rows: { day_of_week, open_time, close_time }
 * @param {object[]} schedules
 * @param {Date} startAt
 * @param {Date} endAt
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkWeeklySchedule(schedules, startAt, endAt) {
  const rows = schedules || [];
  if (!rows.length) return { ok: true };
  const dow = startAt.getDay();
  const dayRows = rows.filter((s) => Number(s.day_of_week) === dow);
  if (!dayRows.length) return { ok: false, reason: "closed_day" };

  const startMins = startAt.getHours() * 60 + startAt.getMinutes();
  const endMins = endAt.getHours() * 60 + endAt.getMinutes();
  if (endAt.getDate() !== startAt.getDate()) {
    return { ok: false, reason: "must_end_same_day" };
  }

  for (const row of dayRows) {
    const [oh, om] = String(row.open_time || "00:00").split(":").map(Number);
    const [ch, cm] = String(row.close_time || "23:59").split(":").map(Number);
    const openM = oh * 60 + (om || 0);
    const closeM = ch * 60 + (cm || 0);
    if (startMins >= openM && endMins <= closeM) return { ok: true };
  }
  return { ok: false, reason: "outside_hours" };
}

/**
 * @param {object[]} blackouts
 * @param {Date} startAt
 * @param {Date} endAt
 */
function checkBlackouts(blackouts, startAt, endAt) {
  for (const b of blackouts || []) {
    const bs = new Date(b.start_at);
    const be = new Date(b.end_at);
    if (startAt < be && endAt > bs) {
      return { ok: false, reason: "blackout" };
    }
  }
  return { ok: true };
}

/**
 * @param {object} policy
 * @param {object} ctx
 * @param {Date} startAt
 * @param {Date} endAt
 * @param {object} data
 * @param {Date} [now]
 */
function evaluateCanReserve(policy, ctx, startAt, endAt, data, now = new Date()) {
  if (!policy) return { allowed: false, reason: "no_policy" };
  const staffOverride = !!ctx.staffOverride;
  const durOpts = { allowPastStart: staffOverride };

  let r = checkDuration(policy, startAt, endAt, now, durOpts);
  if (!r.ok) return { allowed: false, reason: r.reason };

  if (!staffOverride) {
    r = checkAdvanceWindow(policy, startAt, now);
    if (!r.ok) return { allowed: false, reason: r.reason };
  }

  r = checkBlackouts(data.blackouts, startAt, endAt);
  if (!r.ok) return { allowed: false, reason: r.reason };

  r = checkWeeklySchedule(data.schedules, startAt, endAt);
  if (!r.ok) return { allowed: false, reason: r.reason };

  r = checkCapacity(data.overlapping, policy);
  if (!r.ok) return { allowed: false, reason: r.reason };

  if (ctx.tenantId) {
    r = checkTenantLimits(policy, data.tenantReservations, startAt);
    if (!r.ok) return { allowed: false, reason: r.reason };
  }

  const depositAmount = Number(policy.deposit_amount) || 0;
  return {
    allowed: true,
    requiresApproval: !!policy.requires_approval,
    depositAmount,
  };
}

module.exports = {
  durationMinutes,
  checkDuration,
  checkAdvanceWindow,
  checkCapacity,
  checkTenantLimits,
  checkWeeklySchedule,
  checkBlackouts,
  evaluateCanReserve,
};
