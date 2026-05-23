/**
 * Ops-TZ hour boundaries for open-deck day chart (end-of-hour snapshots).
 */

/**
 * @param {string} timeZone IANA
 * @returns {{ y: number, m: number, d: number, h: number, min: number, sec: number }}
 */
function getZonedParts(utcMs, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    f.formatToParts(new Date(utcMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    min: Number(parts.minute),
    sec: Number(parts.second),
  };
}

/**
 * UTC ms for local `dateStr` + clock time in `timeZone`.
 * @param {string} dateStr YYYY-MM-DD
 */
function zonedLocalToUtcMs(dateStr, hour, minute, second, ms, timeZone) {
  const [ty, tm, td] = dateStr.split("-").map((x) => Number(x));
  let utc = Date.parse(`${dateStr}T12:00:00.000Z`);
  for (let i = 0; i < 8; i++) {
    const p = getZonedParts(utc, timeZone);
    const wantMin =
      ty * 525600 + tm * 43200 + td * 1440 + hour * 60 + minute;
    const haveMin = p.y * 525600 + p.m * 43200 + p.d * 1440 + p.h * 60 + p.min;
    utc += (wantMin - haveMin) * 60 * 1000;
    utc += (second - p.sec) * 1000 + (ms - 0);
  }
  return utc;
}

/** End of hour `hour` on `dateStr` in ops TZ (e.g. hour 8 → 08:59:59.999). */
function endOfHourUtcMs(dateStr, hour, timeZone) {
  return zonedLocalToUtcMs(dateStr, hour, 59, 59, 999, timeZone);
}

/** Calendar date YYYY-MM-DD for `utcMs` in ops TZ. */
function opsDateString(utcMs, timeZone) {
  const p = getZonedParts(utcMs, timeZone);
  const m = String(p.m).padStart(2, "0");
  const d = String(p.d).padStart(2, "0");
  return `${p.y}-${m}-${d}`;
}

/** Local hour 0–23 for instant in ops TZ. */
function opsHour(utcMs, timeZone) {
  return getZonedParts(utcMs, timeZone).h;
}

/**
 * @param {number} hour 0–23
 * @returns {string}
 */
function formatHourLabel(hour) {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

module.exports = {
  getZonedParts,
  endOfHourUtcMs,
  opsDateString,
  opsHour,
  formatHourLabel,
  zonedLocalToUtcMs,
};
