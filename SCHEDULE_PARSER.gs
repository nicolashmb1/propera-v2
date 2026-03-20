/**
 * Shared Schedule Parser
 *
 * Extracted from `PROPERA MAIN.gs` so all schedule-like free-text can be normalized into:
 *   { label: string, start: Date|null, end: Date|null, kind: string }
 *
 * This file intentionally uses `Shared`-suffixed helper names to avoid collisions
 * with other experimental parsers that may exist in the repository.
 */
function parsePreferredWindowShared_(text, stageDay) {
  const s0 = String(text || "").trim();
  if (!s0) return null;

  // Normalize common unicode separators so downstream regex can be simpler.
  // - en-dash/emdash/minus variants used by formatRangeLabelShared_.
  const s = s0
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const tz = Session.getScriptTimeZone(); // eslint/unused: preserved from original parser
  const now = new Date();

  // Quick rejects
  if (s.length < 2) return null;

  // "anytime"
  if (/\b(any ?time|whenever|all day|any time)\b/.test(s)) {
    // Prefer explicit date/day in the text (e.g., "Feb 18 anytime", "Friday anytime")
    const baseFromText = parseDayTargetShared_(s, stageDay, now);
    const base = baseFromText || resolveDayBaseShared_(stageDay, now);
    if (!base) return null;

    const label = formatDayShared_(base) + " anytime";
    return { label, start: null, end: null, kind: "ANYTIME" };
  }

  // "now" / "asap" / "urgent" (ASAP window)
  if (/\b(now|asap|a\s*s\s*a\s*p|immediately|right now|urgent|emergency)\b/.test(s)) {
    // Prefer explicit date/day if present (rare, but allow "tomorrow asap")
    const baseFromText = parseDayTargetShared_(s, stageDay, now);
    const base = baseFromText || resolveDayBaseShared_(stageDay, now) || now;

    // Label: "Today ASAP" (or the resolved date)
    const label = formatDayShared_(base) + " ASAP";
    return { label, start: null, end: null, kind: "ASAP" };
  }

  // Day target (today/tomorrow/weekday/date)
  let baseDay = parseDayTargetShared_(s, stageDay, now);
  const dayPartTry = parseDayPartShared_(s);
  // Guard: numeric date-only like "1/15" can look time-ish ("1" hour) to the time regex.
  // When it's purely a date, treat it as day-only (default window later) rather than "at 1pm".
  const isNumericDateOnly =
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(s) ||
    /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(s);
  // Guard: relative day-only phrases like "in 3 days" include a number that can match
  // the time regex; skip time parsing when there are no explicit time tokens.
  const hasExplicitTimeTokens =
    /\b(am|pm)\b/.test(s) ||
    /:\d{2}/.test(s) ||
    looksRangeishShared_(s) ||
    /\b(after|afterwards|before|between)\b/.test(s);
  const isInDaysOnly = /\bin\s+\d+\s+days?\b/.test(s) && !hasExplicitTimeTokens;
  const hasTimeSpec =
    (!isNumericDateOnly && !isInDaysOnly && looksTimeishShared_(s)) ||
    looksRangeishShared_(s) ||
    /\b(after|afterwards|before|between)\b/.test(s);
  if (!baseDay) {
    // If they only said "9-11" / "morning" / "after 3" with no explicit day,
    // assume "today" (or stageDay if provided).
    const fallback = resolveDayBaseShared_(stageDay, now);
    if (dayPartTry || hasTimeSpec || fallback) {
      baseDay = fallback || startOfDayShared_(now);
    } else {
      return null;
    }
  }

  // "morning/afternoon/evening"
  const dayPart = parseDayPartShared_(s);
  if (dayPart) {
    const range = dayPartRangeShared_(baseDay, dayPart);
    const label = formatRangeLabelShared_(range.start, range.end, dayPart);
    return { label, start: range.start, end: range.end, kind: "DAYPART" };
  }

  // After / Before
  const after = s.match(/\b(after|afterwards)\s+(.+)$/);
  if (after) {
    const t = parseTimeShared_(after[2], baseDay);
    if (!t) return null;
    // AFTER is treated as a bounded availability window:
    // start=parsed time, end=same-day latest scheduling hour.
    const latestHour = getScheduleLatestHourShared_();
    const end = new Date(t);
    end.setHours(latestHour, 0, 0, 0);
    if (end.getTime() < t.getTime()) end.setTime(t.getTime()); // clamp; never earlier than start
    const label = formatDayShared_(baseDay) + " after " + formatTimeShared_(t);
    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_("", "", "SCHED_AFTER_RESOLVE_END start=" + t.toISOString() + " end=" + end.toISOString() + " latestHour=" + latestHour);
      }
    } catch (_) {}
    return { label, start: t, end: end, kind: "AFTER" };
  }

  const before = s.match(/\b(before)\s+(.+)$/);
  if (before) {
    const t = parseTimeShared_(before[2], baseDay);
    if (!t) return null;
    const label = formatDayShared_(baseDay) + " before " + formatTimeShared_(t);
    return { label, start: null, end: t, kind: "BEFORE" };
  }

  // Between X and Y
  const between = s.match(/\b(between)\s+(.+?)\s+(and|to)\s+(.+)$/);
  if (between) {
    const t1 = parseTimeShared_(between[2], baseDay);
    const t2 = parseTimeShared_(between[4], baseDay);
    if (!t1 || !t2) return null;
    const range = orderRangeShared_(t1, t2);
    const label = formatRangeLabelShared_(range.start, range.end);
    return { label, start: range.start, end: range.end, kind: "RANGE" };
  }

  // Explicit "X-Y" or "X to Y"
  if (looksRangeishShared_(s)) {
    const r = parseTimeRangeShared_(s, baseDay);
    if (!r) return null;
    const label = formatRangeLabelShared_(r.start, r.end);
    return { label, start: r.start, end: r.end, kind: "RANGE" };
  }

  // Single time: "at 10", "10am"
  if (!isNumericDateOnly && !isInDaysOnly) {
    const single = parseTimeShared_(s, baseDay);
    if (single) {
      const label = formatDayShared_(baseDay) + " at " + formatTimeShared_(single);
      return { label, start: single, end: null, kind: "AT" };
    }
  }

  // Day-only inputs (e.g. "tomorrow", "friday") without any explicit time spec.
  // Default to an "afternoon" window so lifecycle can always schedule an end time.
  if (baseDay) {
    const hasDayToken =
      /\btoday\b/.test(s) ||
      /\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s) ||
      /\bnext\s+week\b/.test(s) ||
      /\bin\s+\d+\s+days?\b/.test(s) ||
      /\b(this\s+)?weekend\b/.test(s) ||
      !!parseWeekdayShared_(s, now) ||
      !!parseExplicitDateShared_(s, now);
    if (hasDayToken && !dayPartTry && !hasTimeSpec && !looksRangeishShared_(s)) {
      const range = dayPartRangeShared_(baseDay, "afternoon");
      const label = formatRangeLabelShared_(range.start, range.end, "afternoon");
      return { label, start: range.start, end: range.end, kind: "DAYDEFAULT" };
    }
  }

  return null;
}

function resolveDayBaseShared_(stageDay, now) {
  const d = String(stageDay || "").toLowerCase();
  if (d.includes("today")) return startOfDayShared_(now);
  if (/tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr/.test(d)) return startOfDayShared_(addDaysShared_(now, 1));
  return null;
}

function parseDayTargetShared_(s, stageDay, now) {
  // If message includes a date or weekday, use that
  const explicit = parseExplicitDateShared_(s, now);
  if (explicit) return startOfDayShared_(explicit);

  const wd = parseWeekdayShared_(s, now);
  if (wd) return startOfDayShared_(wd);

  // Relative windows
  if (/\bnext\s+week\b/.test(s)) return startOfDayShared_(addDaysShared_(now, 7));
  const inDays = s.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays && inDays[1]) {
    const n = parseInt(inDays[1], 10);
    if (isFinite(n) && n >= 0) return startOfDayShared_(addDaysShared_(now, n));
  }
  if (/\b(this\s+)?weekend\b/.test(s)) {
    // Default to upcoming Saturday
    const start = startOfDayShared_(now);
    const curDay = start.getDay(); // 0=Sun..6=Sat
    let delta = 6 - curDay;
    if (delta <= 0) delta += 7;
    return startOfDayShared_(addDaysShared_(start, delta));
  }

  if (/\btoday\b/.test(s)) return startOfDayShared_(now);
  if (/\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s)) return startOfDayShared_(addDaysShared_(now, 1));

  // If no explicit day but stageDay exists (SCHEDULE_TODAY / TOMORROW)
  const fallback = resolveDayBaseShared_(stageDay, now);
  if (fallback) return fallback;

  return null;
}

function parseExplicitDateShared_(s, now) {
  // formats: 1/15, 01/15, 1/15/2026, 2026-01-15
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const y = +m[1], mo = +m[2], da = +m[3];
    return new Date(y, mo - 1, da);
  }

  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const mo = +m[1], da = +m[2];
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y = 2000 + y;
    return new Date(y, mo - 1, da);
  }

  // Month name date (handles both abbreviations and full names):
  // e.g. "Thu Mar 19, 9:00 AM–12:00 PM" or "Mar 19, 2026"
  const monthMap = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };
  const monthTokenRe = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const mon = new RegExp("\\b(" + monthTokenRe + ")\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b", "i").exec(s);
  if (mon) {
    const token = String(mon[1] || "").toLowerCase();
    const midx = monthMap[token] != null ? monthMap[token] : monthMap[token.slice(0, 3)];
    if (midx == null) return null;
    const day = parseInt(mon[2], 10);
    const hasYear = !!mon[3];
    const year = hasYear ? parseInt(mon[3], 10) : now.getFullYear();
    const d = new Date(year, midx, day);
    if (isFinite(d.getTime())) {
      // If no year was provided and the computed date is in the past, assume next year.
      if (!hasYear && d.getTime() < startOfDayShared_(now).getTime()) {
        const d2 = new Date(year + 1, midx, day);
        if (isFinite(d2.getTime())) return d2;
      }
      return d;
    }
  }

  return null;
}

function parseWeekdayShared_(s, now) {
  const days = [
    ["sun", "sunday"],
    ["mon", "monday"],
    ["tue", "tues", "tuesday"],
    ["wed", "wednesday"],
    ["thu", "thurs", "thursday"],
    ["fri", "friday"],
    ["sat", "saturday"]
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

  const start = startOfDayShared_(now);
  const cur = start.getDay();
  let delta = target - cur;
  if (delta < 0) delta += 7;
  if (delta === 0) delta = 7; // if they say "Friday" on Friday, assume next Friday
  return addDaysShared_(start, delta);
}

function parseDayPartShared_(s) {
  if (/\bmorning\b/.test(s)) return "morning";
  if (/\bafternoon\b/.test(s)) return "afternoon";
  if (/\bevening\b/.test(s) || /\bnight\b/.test(s)) return "evening";
  return null;
}

function dayPartRangeShared_(baseDay, part) {
  const start = new Date(baseDay);
  const end = new Date(baseDay);
  if (part === "morning") { start.setHours(9,0,0,0); end.setHours(12,0,0,0); }
  if (part === "afternoon") { start.setHours(12,0,0,0); end.setHours(17,0,0,0); }
  if (part === "evening") { start.setHours(17,0,0,0); end.setHours(20,0,0,0); }
  return { start, end };
}

function looksTimeishShared_(s) {
  return /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bnoon\b)|(\bmidday\b)/i.test(s);
}

function looksRangeishShared_(s) {
  // Support hyphen and the renderer's en-dash/emdash (– / —).
  return /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bbetween\b.+\b(and|to)\b)/i.test(s);
}

function parseTimeWindowOnDayShared_(s, baseDay) {
  const r = parseTimeRangeShared_(s, baseDay);
  if (r) return { label: formatRangeLabelShared_(r.start, r.end), start: r.start, end: r.end, kind: "RANGE" };

  const t = parseTimeShared_(s, baseDay);
  if (t) return { label: formatDayShared_(baseDay) + " at " + formatTimeShared_(t), start: t, end: null, kind: "AT" };

  return null;
}

function parseTimeRangeShared_(s, baseDay) {
  // "9-11", "9am-11am", "9 to 11", "9:30-11"
  // Support hyphen and the renderer's en-dash/emdash (– / —).
  let m = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (!m) return null;

  const t1 = parseTimeShared_(m[1], baseDay);
  const t2 = parseTimeShared_(m[2], baseDay);
  if (!t1 || !t2) return null;

  // If second time had no am/pm, and first had it, inherit
  return orderRangeShared_(t1, t2);
}

function parseTimeShared_(raw, baseDay) {
  const s = String(raw || "").toLowerCase().trim();

  if (/\bnoon\b/.test(s)) {
    const d = new Date(baseDay); d.setHours(12,0,0,0); return d;
  }

  // "at 10am" -> "10am"
  const clean = s.replace(/\bat\b/g, "").trim();

  // 10, 10am, 10:30, 10:30am
  const m = clean.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;

  let hh = +m[1];
  const mm = m[2] ? +m[2] : 0;
  const ap = m[3] || "";

  if (hh < 0 || hh > 12 || mm < 0 || mm > 59) return null;

  let H = hh;

  if (ap === "pm" && hh !== 12) H = hh + 12;
  if (ap === "am" && hh === 12) H = 0;

  // If no am/pm and hour looks like business time (7-18), accept as-is best guess:
  if (!ap) {
    // interpret 1-6 as pm by default (common tenant behavior)
    if (hh >= 1 && hh <= 6) H = hh + 12;
    else H = hh; // 7-12 stays
  }

  const d = new Date(baseDay);
  d.setHours(H, mm, 0, 0);
  return d;
}

function orderRangeShared_(a, b) {
  if (a.getTime() <= b.getTime()) return { start: a, end: b };
  return { start: b, end: a };
}

function startOfDayShared_(d) {
  const x = new Date(d);
  x.setHours(0,0,0,0);
  return x;
}

function addDaysShared_(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function formatDayShared_(d) {
  // Example: "Fri Jan 15"
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "EEE MMM d");
}

function formatTimeShared_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "h:mm a");
}

function formatRangeLabelShared_(start, end, part) {
  // Example: "Fri Jan 15, 9:00 AM–11:00 AM"
  const day = formatDayShared_(start);
  if (end) return day + ", " + formatTimeShared_(start) + "–" + formatTimeShared_(end);
  return day + ", " + formatTimeShared_(start);
}

function getScheduleLatestHourShared_() {
  var latest = 17; // safe fallback when config missing/invalid
  try {
    if (typeof ppGet_ === "function") {
      var raw = ppGet_("GLOBAL", "SCHED_LATEST_HOUR", 17);
      var n = Number(raw);
      if (isFinite(n) && n >= 0 && n <= 23) latest = Math.floor(n);
    }
  } catch (_) {}
  return latest;
}

