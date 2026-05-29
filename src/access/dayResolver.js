/**
 * Day pipeline (Piece 2 of the access foundation).
 *
 * Single source of truth for hint -> calendar day in the property's local TZ.
 * Every layer that asks "what day is this?" calls `resolveDay`. Nothing else
 * does its own date math.
 *
 *   Tenant says:                    Agent emits hint:        Day pipeline returns:
 *   "tomorrow"                      "tomorrow"               isoDate, anchorIso, startIso/endIso
 *   "saturday"                      "saturday"               (next saturday after `now`)
 *   "sunday the 31st"               "sunday" OR "2026-05-31" same answer either way
 *   "may 31"                        "2026-05-31"             literal day
 *
 * Downstream layers (validators, brain, queries, narrators) only consume the
 * returned object — they never re-parse the hint.
 *
 * Doctrine:
 *  - Principle 2 (Interpret once)
 *  - Principle 6 (AI is interpretation/expression layer, not control)
 *  - Guardrail 22 (Make everything explicit) — closed-set kind discriminator.
 */
const {
  zonedWallClock,
  wallClockToUtc,
  wallDateInZone,
  propertyTimezone,
} = require("./accessLocalTime");

const WEEKDAY_INDEX = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

const WEEKDAY_NAMES = Object.freeze([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

const DAY_RESOLVE_KIND = Object.freeze({
  TODAY: "today",
  TOMORROW: "tomorrow",
  WEEKDAY: "weekday",
  ISO_DATE: "iso_date",
});

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * @typedef {object} ResolvedDay
 * @property {string} kind          One of DAY_RESOLVE_KIND.
 * @property {string} hint          Original (normalized) hint string.
 * @property {string} isoDate       Canonical YYYY-MM-DD for that calendar day.
 * @property {string} weekday       sunday|monday|...|saturday (in property TZ).
 * @property {string} anchorIso     Noon-local on isoDate, as UTC ISO instant.
 * @property {string} startIso      Midnight-local on isoDate, as UTC ISO instant.
 * @property {string} endIso        Next midnight-local (exclusive day bound).
 * @property {string} localLabel    Human label, e.g. "5/31/2026".
 */

/**
 * Normalize a YYYY-MM-DD string to {year, month, day} or null if invalid.
 * @param {string} s
 */
function parseIsoDate(s) {
  const m = ISO_DATE_RE.exec(String(s || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (
    !Number.isFinite(year) ||
    month < 1 || month > 12 ||
    day < 1 || day > 31
  ) {
    return null;
  }
  return { year, month, day };
}

/**
 * Resolve a tenant day hint into a fully-canonicalized calendar day in the
 * property's local timezone. Falls back to "tomorrow" only if the hint is
 * empty or genuinely unrecognized (does NOT fall back silently on a
 * malformed YYYY-MM-DD — the caller can detect via `kind`).
 *
 * @param {string} hint        Closed set: today | tomorrow | weekday | YYYY-MM-DD.
 *                             Anything else => tomorrow (defensive default).
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {ResolvedDay}
 */
function resolveDay(hint, now = new Date(), timeZone = propertyTimezone()) {
  const raw = String(hint || "").trim().toLowerCase();

  let wall;
  let kind;

  if (!raw || raw === "tomorrow") {
    wall = wallDateInZone(now, 1, timeZone);
    kind = DAY_RESOLVE_KIND.TOMORROW;
  } else if (raw === "today") {
    wall = wallDateInZone(now, 0, timeZone);
    kind = DAY_RESOLVE_KIND.TODAY;
  } else if (ISO_DATE_RE.test(raw)) {
    const parsed = parseIsoDate(raw);
    if (parsed) {
      wall = parsed;
      kind = DAY_RESOLVE_KIND.ISO_DATE;
    } else {
      wall = wallDateInZone(now, 1, timeZone);
      kind = DAY_RESOLVE_KIND.TOMORROW;
    }
  } else if (Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, raw)) {
    const z = zonedWallClock(now, timeZone);
    const diff = (WEEKDAY_INDEX[raw] - z.dayOfWeek + 7) % 7 || 7;
    wall = wallDateInZone(now, diff, timeZone);
    kind = DAY_RESOLVE_KIND.WEEKDAY;
  } else {
    wall = wallDateInZone(now, 1, timeZone);
    kind = DAY_RESOLVE_KIND.TOMORROW;
  }

  const startUtc = wallClockToUtc({ ...wall, hour: 0, minute: 0 }, timeZone);
  const anchorUtc = wallClockToUtc({ ...wall, hour: 12, minute: 0 }, timeZone);

  // Next day's midnight in the same TZ — robust to DST transitions because
  // we re-zone via wallDateInZone (which uses noon-as-anchor to avoid the
  // 23/25-hour edge cases).
  const nextWall = wallDateInZone(anchorUtc, 1, timeZone);
  const endUtc = wallClockToUtc({ ...nextWall, hour: 0, minute: 0 }, timeZone);

  const isoDate = `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
  const anchorZ = zonedWallClock(anchorUtc, timeZone);
  const weekday = WEEKDAY_NAMES[anchorZ.dayOfWeek] || "";
  const localLabel = anchorUtc.toLocaleDateString("en-US", { timeZone });

  return {
    kind,
    hint: raw,
    isoDate,
    weekday,
    anchorIso: anchorUtc.toISOString(),
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
    localLabel,
  };
}

/**
 * UTC day bounds for the calendar day containing `instant` in property TZ.
 * Used when the caller has an arbitrary instant (e.g. a reservation row's
 * startAt) rather than a tenant hint.
 *
 * @param {Date | string | number} instant
 * @param {string} [timeZone]
 * @returns {{ startUtc: Date, endUtc: Date, resolved: ResolvedDay }}
 */
function dayBoundsForInstant(instant, timeZone = propertyTimezone()) {
  const z = zonedWallClock(instant, timeZone);
  const isoDate = `${String(z.year).padStart(4, "0")}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
  const resolved = resolveDay(isoDate, new Date(z.year, z.month - 1, z.day), timeZone);
  return {
    startUtc: new Date(resolved.startIso),
    endUtc: new Date(resolved.endIso),
    resolved,
  };
}

/**
 * Just the resolved day for "today" in property TZ — convenience for the
 * LLM payload's today-context block (so even that uses the same code path).
 *
 * @param {Date} [now]
 * @param {string} [timeZone]
 */
function resolveToday(now = new Date(), timeZone = propertyTimezone()) {
  return resolveDay("today", now, timeZone);
}

module.exports = {
  resolveDay,
  resolveToday,
  dayBoundsForInstant,
  DAY_RESOLVE_KIND,
  WEEKDAY_NAMES,
  WEEKDAY_INDEX,
};
