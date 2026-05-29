/**
 * Property-local wall clock for access policy (hours) and tenant phrasing.
 * Uses PROPERA_TZ — do not rely on ambiguous Date#getHours() vs UTC ISO from LLM.
 */
const { properaTimezone } = require("../config/env");

const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * @param {Date|string} date
 * @param {string} [timeZone]
 */
function zonedWallClock(date, timeZone = properaTimezone()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    dayOfWeek: DOW_MAP[map.weekday] ?? 0,
    minutesSinceMidnight: Number(map.hour) * 60 + Number(map.minute),
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

/**
 * UTC instant for a wall-clock slot on a calendar day in property TZ.
 * @param {{ year: number, month: number, day: number, hour: number, minute?: number }} wall
 * @param {string} [timeZone]
 */
function wallClockToUtc(wall, timeZone = properaTimezone()) {
  const minute = Number(wall.minute || 0);
  let guess = new Date(
    Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day), Number(wall.hour), minute)
  );
  for (let i = 0; i < 4; i++) {
    const z = zonedWallClock(guess, timeZone);
    const targetMin = Number(wall.hour) * 60 + minute;
    const diffMin = targetMin - z.minutesSinceMidnight;
    const dayShift =
      z.dateKey !==
      `${String(wall.year)}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`
        ? diffMin > 0
          ? -1440
          : 1440
        : 0;
    guess = new Date(guess.getTime() + (diffMin + dayShift) * 60000);
  }
  return guess;
}

/**
 * LLM often returns `...T10:00:00.000Z` meaning "10:00 local" not UTC. Re-anchor in property TZ.
 * @param {string} iso
 * @param {string} [timeZone]
 */
function reinterpretLlmUtcIsoAsLocalWallClock(iso, timeZone = properaTimezone()) {
  const s = String(iso || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return s;
  const utc = wallClockToUtc(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5] || 0),
    },
    timeZone
  );
  return utc.toISOString();
}

/**
 * Calendar day in property TZ (optionally offset).
 * @param {Date} [now]
 * @param {number} [dayOffset]
 * @param {string} [timeZone]
 */
function wallDateInZone(now = new Date(), dayOffset = 0, timeZone = properaTimezone()) {
  const z = zonedWallClock(now, timeZone);
  const noon = wallClockToUtc(
    { year: z.year, month: z.month, day: z.day, hour: 12, minute: 0 },
    timeZone
  );
  if (!dayOffset) {
    return { year: z.year, month: z.month, day: z.day };
  }
  const shifted = new Date(noon.getTime() + dayOffset * 86400000);
  const z2 = zonedWallClock(shifted, timeZone);
  return { year: z2.year, month: z2.month, day: z2.day };
}

function formatUtcInPropertyZone(iso, timeZone = properaTimezone()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso || "");
  return d.toLocaleString("en-US", {
    timeZone,
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * UTC bounds [start, end) for the property-local calendar day containing `instant`.
 *
 * Thin wrapper over the canonical day pipeline (`dayBoundsForInstant`). Kept
 * as an export for back-compat; new callers should pull from `dayResolver`
 * directly so they also get the resolved isoDate / weekday / localLabel.
 *
 * @param {Date|string} instant
 * @param {string} [timeZone]
 * @returns {{ startUtc: Date, endUtc: Date }}
 */
function propertyDayBoundsUtc(instant, timeZone = properaTimezone()) {
  const { dayBoundsForInstant } = require("./dayResolver");
  const { startUtc, endUtc } = dayBoundsForInstant(instant, timeZone);
  return { startUtc, endUtc };
}

function formatUtcTimeInPropertyZone(iso, timeZone = properaTimezone()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso || "");
  return d.toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
}

module.exports = {
  zonedWallClock,
  wallClockToUtc,
  reinterpretLlmUtcIsoAsLocalWallClock,
  wallDateInZone,
  propertyDayBoundsUtc,
  formatUtcInPropertyZone,
  formatUtcTimeInPropertyZone,
  propertyTimezone: properaTimezone,
};
