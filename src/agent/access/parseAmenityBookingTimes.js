/**
 * Build access reservation start/end ISO from staff-supplied date + times.
 */
const {
  wallDateInZone,
  wallClockToUtc,
  formatUtcInPropertyZone,
} = require("../../access/accessLocalTime");

/**
 * @param {string} raw
 * @returns {{ hour: number, minute: number } | null}
 */
function parseClockTime(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;

  let m = s.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    const ampm = String(m[3] || "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2] || 0);
    const ampm = String(m[3]).toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  return null;
}

/**
 * @param {string} raw
 * @param {Date} [now]
 */
function parseBookingDate(raw, now = new Date()) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;

  if (s === "today") return wallDateInZone(now, 0);
  if (s === "tomorrow") return wallDateInZone(now, 1);

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }

  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : wallDateInZone(now, 0).year;
    if (year < 100) year += 2000;
    return { year, month, day };
  }

  return null;
}

function accessFriendlyReason(code) {
  const map = {
    slot_full: "That time slot is already booked.",
    outside_hours: "Outside location hours for that day.",
    duration_too_short: "Booking is shorter than the minimum block.",
    duration_too_long: "Booking exceeds the maximum block.",
    too_soon: "Not enough advance notice.",
    too_far_ahead: "Too far in the future.",
    blackout: "Location is closed for that period.",
    tenant_daily_limit: "Tenant reached the daily booking limit.",
    tenant_weekly_limit: "Tenant reached the weekly booking limit.",
    closed_day: "Location is closed that day.",
    invalid_input: "Invalid time range.",
    no_policy: "No policy configured for this location.",
    start_in_past: "Start time is in the past.",
    same_day_not_allowed: "Same-day booking is not allowed for this amenity.",
  };
  const key = String(code || "").trim();
  return map[key] || key.replace(/_/g, " ");
}

/**
 * @param {object} o
 * @param {string} o.bookingDate — YYYY-MM-DD, today, tomorrow
 * @param {string} o.startTime
 * @param {string} o.endTime
 * @param {Date} [o.now]
 */
function buildAmenityBookingTimes(o) {
  const bookingDate = parseBookingDate(o?.bookingDate || o?.booking_date || o?.date, o?.now);
  const startClock = parseClockTime(o?.startTime || o?.start_time);
  const endClock = parseClockTime(o?.endTime || o?.end_time);

  if (!bookingDate) {
    return { ok: false, error: "bad_date", message: "Need booking date — today, tomorrow, or YYYY-MM-DD." };
  }
  if (!startClock || !endClock) {
    return {
      ok: false,
      error: "bad_time",
      message: "Need start and end times — e.g. 3pm and 5pm.",
    };
  }

  const startAt = wallClockToUtc({
    year: bookingDate.year,
    month: bookingDate.month,
    day: bookingDate.day,
    hour: startClock.hour,
    minute: startClock.minute,
  });
  const endAt = wallClockToUtc({
    year: bookingDate.year,
    month: bookingDate.month,
    day: bookingDate.day,
    hour: endClock.hour,
    minute: endClock.minute,
  });

  if (!(endAt > startAt)) {
    return { ok: false, error: "bad_range", message: "End time must be after start time." };
  }

  const label = `${formatUtcInPropertyZone(startAt.toISOString())} – ${formatUtcInPropertyZone(endAt.toISOString())}`;

  return {
    ok: true,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    label,
    bookingDateKey: `${bookingDate.year}-${String(bookingDate.month).padStart(2, "0")}-${String(bookingDate.day).padStart(2, "0")}`,
  };
}

module.exports = {
  parseClockTime,
  parseBookingDate,
  buildAmenityBookingTimes,
  accessFriendlyReason,
};
