/**
 * Operating hours for a property-local calendar day — deterministic facts for list_slots.
 */

const { zonedWallClock } = require("./accessLocalTime");

/**
 * @param {string} hhmm  "08:00" or "23:00:00"
 * @returns {string}  e.g. "8:00 AM"
 */
function formatScheduleWallTime(hhmm) {
  const parts = String(hhmm || "00:00").trim().split(":");
  const hour = Number(parts[0]);
  const minute = Number(parts[1] || 0);
  if (!Number.isFinite(hour)) return String(hhmm || "");
  const d = new Date(2000, 0, 1, hour, minute);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Normalize schedule rows from DB or DAL (snake_case or camelCase).
 * @param {object} row
 */
function scheduleRowDayOfWeek(row) {
  if (row == null || typeof row !== "object") return -1;
  if (row.day_of_week != null) return Number(row.day_of_week);
  if (row.dayOfWeek != null) return Number(row.dayOfWeek);
  return -1;
}

/**
 * @param {object[]} schedules
 * @param {number} dayOfWeek  0=Sun … 6=Sat (property-local, matches access_schedules)
 * @returns {{ closed: boolean, ranges: Array<{ open: string, close: string }>, label: string }}
 */
function resolveOperatingHoursForDay(schedules, dayOfWeek) {
  const dow = Number(dayOfWeek);
  const rows = (schedules || []).filter((s) => scheduleRowDayOfWeek(s) === dow);

  if (!rows.length) {
    // No schedule rows at all for this location → treat as always open (policy-only).
    const anySchedules = (schedules || []).length > 0;
    if (anySchedules) {
      return { closed: true, ranges: [], label: "" };
    }
    return { closed: false, ranges: [], label: "" };
  }

  const ranges = rows
    .map((row) => ({
      open: formatScheduleWallTime(row.open_time || row.openTime),
      close: formatScheduleWallTime(row.close_time || row.closeTime),
    }))
    .filter((r) => r.open && r.close);

  const label = ranges.map((r) => `${r.open}–${r.close}`).join(", ");
  return { closed: false, ranges, label };
}

/**
 * @param {string} anchorIso  noon-local anchor for the day
 * @param {object[]} schedules
 * @param {string} [timeZone]
 */
function resolveOperatingHoursForAnchor(anchorIso, schedules, timeZone) {
  const anchor = new Date(anchorIso);
  const dow = zonedWallClock(anchor, timeZone).dayOfWeek;
  return resolveOperatingHoursForDay(schedules, dow);
}

module.exports = {
  formatScheduleWallTime,
  resolveOperatingHoursForDay,
  resolveOperatingHoursForAnchor,
};
