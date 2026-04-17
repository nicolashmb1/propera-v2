/**
 * Port of GAS `parsePreferredWindowShared_` — `08_INTAKE_RUNTIME.gs` ~1859–2270.
 *
 * Date math matches GAS: uses JS `Date` local fields (`setHours`, `new Date(y,m,d)`), so **set
 * `process.env.TZ` to the same IANA zone as GAS `Session.getScriptTimeZone()`** for parity
 * (Node honors `TZ` for local time). Labels use `Intl` with `opts.timeZone` (default `process.env.TZ`
 * or `UTC`).
 *
 * Policy: `validateSchedPolicy_` runs in `src/dal/ticketPreferredWindow.js` after parse (commit path).
 */

/**
 * @typedef {{ label: string, start: Date|null, end: Date|null, kind: string }} ParsedPreferredWindow
 */

/**
 * @param {string|null|undefined} text
 * @param {string|null|undefined} stageDay
 * @param {{ now?: Date, timeZone?: string, scheduleLatestHour?: number }} [opts]
 * @returns {ParsedPreferredWindow|null}
 */
function parsePreferredWindowShared(text, stageDay, opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const tz =
    o.timeZone ||
    (typeof process !== "undefined" && process.env && process.env.TZ) ||
    "UTC";
  const latestHourCfg =
    typeof o.scheduleLatestHour === "number" && isFinite(o.scheduleLatestHour)
      ? Math.floor(o.scheduleLatestHour)
      : 17;

  const s0 = String(text || "").trim();
  if (!s0) return null;

  const s = s0
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  if (s.length < 2) return null;

  if (/\b(any ?time|whenever|all day|any time)\b/.test(s)) {
    const baseFromText = parseDayTargetShared(s, stageDay, now);
    const base = baseFromText || resolveDayBaseShared(stageDay, now);
    if (!base) return null;
    const label = formatDayShared(base, tz) + " anytime";
    return { label, start: null, end: null, kind: "ANYTIME" };
  }

  if (
    /\b(now|asap|a\s*s\s*a\s*p|immediately|right now|urgent|emergency)\b/.test(s)
  ) {
    const baseFromText = parseDayTargetShared(s, stageDay, now);
    const base = baseFromText || resolveDayBaseShared(stageDay, now) || now;
    const label = formatDayShared(base, tz) + " ASAP";
    return { label, start: null, end: null, kind: "ASAP" };
  }

  let baseDay = parseDayTargetShared(s, stageDay, now);
  const dayPartTry = parseDayPartShared(s);
  const isNumericDateOnly =
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(s) ||
    /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(s);
  const hasExplicitTimeTokens =
    /\b(am|pm)\b/.test(s) ||
    /:\d{2}/.test(s) ||
    looksRangeishShared(s) ||
    /\b(after|afterwards|before|between)\b/.test(s);
  const isInDaysOnly = /\bin\s+\d+\s+days?\b/.test(s) && !hasExplicitTimeTokens;
  const hasTimeSpec =
    (!isNumericDateOnly && !isInDaysOnly && looksTimeishShared(s)) ||
    looksRangeishShared(s) ||
    /\b(after|afterwards|before|between)\b/.test(s);

  if (!baseDay) {
    const fallback = resolveDayBaseShared(stageDay, now);
    if (dayPartTry || hasTimeSpec || fallback) {
      baseDay = fallback || startOfDayShared(now);
    } else {
      return null;
    }
  }

  const dayPart = parseDayPartShared(s);
  if (dayPart) {
    const range = dayPartRangeShared(baseDay, dayPart);
    const label = formatRangeLabelShared(range.start, range.end, dayPart, tz);
    return { label, start: range.start, end: range.end, kind: "DAYPART" };
  }

  const after = s.match(/\b(after|afterwards)\s+(.+)$/);
  if (after) {
    const t = parseTimeShared(after[2], baseDay);
    if (!t) return null;
    const latestHour = getScheduleLatestHourShared(latestHourCfg);
    const end = new Date(t.getTime());
    end.setHours(latestHour, 0, 0, 0);
    if (end.getTime() < t.getTime()) end.setTime(t.getTime());
    const label =
      formatDayShared(baseDay, tz) + " after " + formatTimeShared(t, tz);
    return { label, start: t, end, kind: "AFTER" };
  }

  const before = s.match(/\b(before)\s+(.+)$/);
  if (before) {
    const t = parseTimeShared(before[2], baseDay);
    if (!t) return null;
    const label =
      formatDayShared(baseDay, tz) + " before " + formatTimeShared(t, tz);
    return { label, start: null, end: t, kind: "BEFORE" };
  }

  const between = s.match(/\b(between)\s+(.+?)\s+(and|to)\s+(.+)$/);
  if (between) {
    const t1 = parseTimeShared(between[2], baseDay);
    const t2 = parseTimeShared(between[4], baseDay);
    if (!t1 || !t2) return null;
    const range = orderRangeShared(t1, t2);
    const label = formatRangeLabelShared(range.start, range.end, undefined, tz);
    return { label, start: range.start, end: range.end, kind: "RANGE" };
  }

  if (looksRangeishShared(s)) {
    const r = parseTimeRangeShared(s, baseDay);
    if (!r) return null;
    const label = formatRangeLabelShared(r.start, r.end, undefined, tz);
    return { label, start: r.start, end: r.end, kind: "RANGE" };
  }

  if (!isNumericDateOnly && !isInDaysOnly) {
    const single = parseTimeShared(s, baseDay);
    if (single) {
      const label =
        formatDayShared(baseDay, tz) + " at " + formatTimeShared(single, tz);
      return { label, start: single, end: null, kind: "AT" };
    }
  }

  if (baseDay) {
    const hasDayToken =
      /\btoday\b/.test(s) ||
      /\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s) ||
      /\bnext\s+week\b/.test(s) ||
      /\bin\s+\d+\s+days?\b/.test(s) ||
      /\b(this\s+)?weekend\b/.test(s) ||
      !!parseWeekdayShared(s, now) ||
      !!parseExplicitDateShared(s, now);
    if (hasDayToken && !dayPartTry && !hasTimeSpec && !looksRangeishShared(s)) {
      const range = dayPartRangeShared(baseDay, "afternoon");
      const label = formatRangeLabelShared(
        range.start,
        range.end,
        "afternoon",
        tz
      );
      return {
        label,
        start: range.start,
        end: range.end,
        kind: "DAYDEFAULT",
      };
    }
  }

  return null;
}

function resolveDayBaseShared(stageDay, now) {
  const d = String(stageDay || "").toLowerCase();
  if (d.includes("today")) return startOfDayShared(now);
  if (/tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr/.test(d)) {
    return startOfDayShared(addDaysShared(now, 1));
  }
  return null;
}

function parseDayTargetShared(s, stageDay, now) {
  const explicit = parseExplicitDateShared(s, now);
  if (explicit) return startOfDayShared(explicit);

  const wd = parseWeekdayShared(s, now);
  if (wd) return startOfDayShared(wd);

  if (/\bnext\s+week\b/.test(s)) return startOfDayShared(addDaysShared(now, 7));
  const inDays = s.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays && inDays[1]) {
    const n = parseInt(inDays[1], 10);
    if (isFinite(n) && n >= 0) return startOfDayShared(addDaysShared(now, n));
  }
  if (/\b(this\s+)?weekend\b/.test(s)) {
    const start = startOfDayShared(now);
    const curDay = start.getDay();
    let delta = 6 - curDay;
    if (delta <= 0) delta += 7;
    return startOfDayShared(addDaysShared(start, delta));
  }

  if (/\btoday\b/.test(s)) return startOfDayShared(now);
  if (/\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s)) {
    return startOfDayShared(addDaysShared(now, 1));
  }

  const fallback = resolveDayBaseShared(stageDay, now);
  if (fallback) return fallback;

  return null;
}

function parseExplicitDateShared(s, now) {
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const da = +m[3];
    return new Date(y, mo - 1, da);
  }

  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const mo = +m[1];
    const da = +m[2];
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y = 2000 + y;
    return new Date(y, mo - 1, da);
  }

  const monthMap = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  const monthTokenRe =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const mon = new RegExp(
    "\\b(" + monthTokenRe + ")\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b",
    "i"
  ).exec(s);
  if (mon) {
    const token = String(mon[1] || "").toLowerCase();
    const midx =
      monthMap[token] != null ? monthMap[token] : monthMap[token.slice(0, 3)];
    if (midx == null) return null;
    const day = parseInt(mon[2], 10);
    const hasYear = !!mon[3];
    const year = hasYear ? parseInt(mon[3], 10) : now.getFullYear();
    const d = new Date(year, midx, day);
    if (isFinite(d.getTime())) {
      if (!hasYear && d.getTime() < startOfDayShared(now).getTime()) {
        const d2 = new Date(year + 1, midx, day);
        if (isFinite(d2.getTime())) return d2;
      }
      return d;
    }
  }

  return null;
}

function parseWeekdayShared(s, now) {
  const days = [
    ["sun", "sunday"],
    ["mon", "monday"],
    ["tue", "tues", "tuesday"],
    ["wed", "wednesday"],
    ["thu", "thurs", "thursday"],
    ["fri", "friday"],
    ["sat", "saturday"],
  ];

  let target = -1;
  for (let i = 0; i < days.length; i++) {
    for (const name of days[i]) {
      if (new RegExp("\\b" + name + "\\b").test(s)) {
        target = i;
        break;
      }
    }
    if (target >= 0) break;
  }
  if (target < 0) return null;

  const start = startOfDayShared(now);
  const cur = start.getDay();
  let delta = target - cur;
  if (delta < 0) delta += 7;
  if (delta === 0) delta = 7;
  return addDaysShared(start, delta);
}

function parseDayPartShared(s) {
  if (/\bmorning\b/.test(s)) return "morning";
  if (/\bafternoon\b/.test(s)) return "afternoon";
  if (/\bevening\b/.test(s) || /\bnight\b/.test(s)) return "evening";
  return null;
}

function dayPartRangeShared(baseDay, part) {
  const start = new Date(baseDay.getTime());
  const end = new Date(baseDay.getTime());
  if (part === "morning") {
    start.setHours(9, 0, 0, 0);
    end.setHours(12, 0, 0, 0);
  }
  if (part === "afternoon") {
    start.setHours(12, 0, 0, 0);
    end.setHours(17, 0, 0, 0);
  }
  if (part === "evening") {
    start.setHours(17, 0, 0, 0);
    end.setHours(20, 0, 0, 0);
  }
  return { start, end };
}

function looksTimeishShared(s) {
  return (
    /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bnoon\b)|(\bmidday\b)/i.test(s)
  );
}

function looksRangeishShared(s) {
  return (
    /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bbetween\b.+\b(and|to)\b)/i.test(
      s
    )
  );
}

function parseTimeRangeShared(s, baseDay) {
  const m = s.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i
  );
  if (!m) return null;

  const t1 = parseTimeShared(m[1], baseDay);
  const t2 = parseTimeShared(m[2], baseDay);
  if (!t1 || !t2) return null;

  return orderRangeShared(t1, t2);
}

function parseTimeShared(raw, baseDay) {
  const str = String(raw || "").toLowerCase().trim();

  if (/\bnoon\b/.test(str)) {
    const d = new Date(baseDay.getTime());
    d.setHours(12, 0, 0, 0);
    return d;
  }

  const clean = str.replace(/\bat\b/g, "").trim();

  const m = clean.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;

  let hh = +m[1];
  const mm = m[2] ? +m[2] : 0;
  const ap = m[3] || "";

  if (hh < 0 || hh > 12 || mm < 0 || mm > 59) return null;

  let H = hh;

  if (ap === "pm" && hh !== 12) H = hh + 12;
  if (ap === "am" && hh === 12) H = 0;

  if (!ap) {
    if (hh >= 1 && hh <= 6) H = hh + 12;
    else H = hh;
  }

  const d = new Date(baseDay.getTime());
  d.setHours(H, mm, 0, 0);
  return d;
}

function orderRangeShared(a, b) {
  if (a.getTime() <= b.getTime()) return { start: a, end: b };
  return { start: b, end: a };
}

function startOfDayShared(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDaysShared(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function formatDayShared(d, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).formatToParts(d);
  const w = parts.find((p) => p.type === "weekday").value;
  const mo = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  return `${w} ${mo} ${day}`;
}

function formatTimeShared(d, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(d);
}

function formatRangeLabelShared(start, end, _part, timeZone) {
  const day = formatDayShared(start, timeZone);
  if (end) {
    return (
      day + ", " + formatTimeShared(start, timeZone) + "–" + formatTimeShared(end, timeZone)
    );
  }
  return day + ", " + formatTimeShared(start, timeZone);
}

function getScheduleLatestHourShared(configured) {
  const n = Number(configured);
  if (isFinite(n) && n >= 0 && n <= 23) return Math.floor(n);
  return 17;
}

module.exports = {
  parsePreferredWindowShared,
  _test: {
    startOfDayShared,
    addDaysShared,
    formatDayShared,
  },
};
