const ACCESS_INTENT_TYPES = {
  RESERVE: "ACCESS_RESERVE",
  CANCEL: "ACCESS_CANCEL",
  STATUS: "ACCESS_STATUS",
  LIST_SLOTS: "ACCESS_LIST_SLOTS",
  UNKNOWN: "ACCESS_UNKNOWN",
};

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const AMENITY_WORD_RE =
  /\b(gameroom|game\s*room|sauna|terrace|party\s+room|amenity|gym|fitness|pool|laundry)\b/i;

const AVAILABILITY_RE =
  /\b(available|availability|what times?|what time|when can i|open slots?|free times?|what'?s open|operating hours?|what hours?|from what time|to what time)\b/i;

/**
 * Lightweight intent hint for fallback only — access gather LLM owns nuance when enabled.
 * @param {string} bodyText
 * @param {{ locationId?: string, locationHint?: string, accessSessionActive?: boolean }} [ctx]
 */
function detectAccessIntent(bodyText, ctx = {}) {
  const text = String(bodyText || "").trim();
  if (!text) return ACCESS_INTENT_TYPES.UNKNOWN;

  const hasLocation =
    !!String(ctx.locationId || "").trim() || !!String(ctx.locationHint || "").trim();
  const inSession = !!ctx.accessSessionActive;

  if (/\b(cancel|drop|remove)\b.*\b(reserv(e|ation)|booking|book)\b/i.test(text)) {
    return ACCESS_INTENT_TYPES.CANCEL;
  }
  if (
    /\b(status|when is|what time is|do i have|my)\b.*\b(reserv(e|ation)|booking|book)\b/i.test(
      text
    )
  ) {
    return ACCESS_INTENT_TYPES.STATUS;
  }
  if (AVAILABILITY_RE.test(text) && (hasLocation || inSession || AMENITY_WORD_RE.test(text))) {
    return ACCESS_INTENT_TYPES.LIST_SLOTS;
  }
  if (/\b(book|reserve|reservation|booking)\b/i.test(text)) {
    return ACCESS_INTENT_TYPES.RESERVE;
  }
  if (AMENITY_WORD_RE.test(text)) {
    return ACCESS_INTENT_TYPES.RESERVE;
  }
  return ACCESS_INTENT_TYPES.UNKNOWN;
}

/**
 * @param {string} bodyText
 * @param {object} [existing]
 */
function inferAccessIntent(bodyText, existing = {}) {
  const detected = detectAccessIntent(bodyText, {
    locationId: existing.locationId,
    locationHint: existing.locationHint,
    accessSessionActive: !!existing.intentType,
  });
  if (detected !== ACCESS_INTENT_TYPES.UNKNOWN) return detected;
  const prior = String(existing.intentType || "").trim();
  if (prior && prior !== ACCESS_INTENT_TYPES.UNKNOWN) return prior;
  return ACCESS_INTENT_TYPES.UNKNOWN;
}

function normalizeHour(hour, meridiem, fallbackMeridiem) {
  let h = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)));
  const md = String(meridiem || fallbackMeridiem || "").trim().toLowerCase();
  if (md === "pm" && h < 12) h += 12;
  if (md === "am" && h === 12) h = 0;
  return h;
}

/**
 * Bare "2-4" / "3-5" without am/pm — treat as afternoon for amenity booking.
 * @param {string} text
 * @param {number} startHour 1-12 from regex
 * @param {number} endHour 1-12 from regex
 * @param {string} startMeridiem
 * @param {string} endMeridiem
 */
function inferMeridiemForBareRange(text, startHour, endHour, startMeridiem, endMeridiem) {
  if (startMeridiem || endMeridiem) {
    return { startMeridiem, endMeridiem };
  }
  const lower = String(text || "").toLowerCase();
  if (/\b(am|pm|morning|afternoon|evening|tonight)\b/.test(lower)) {
    return { startMeridiem, endMeridiem };
  }
  const s = Number(startHour);
  const e = Number(endHour);
  // Afternoon shorthand only (2-4, 3-5) — not 10-12 (morning) or 8-10 (ambiguous).
  if (s >= 1 && s <= 6 && e >= 2 && e <= 9 && e > s) {
    return { startMeridiem: "pm", endMeridiem: "pm" };
  }
  return { startMeridiem, endMeridiem };
}

const {
  wallClockToUtc,
  wallDateInZone,
  zonedWallClock,
  propertyTimezone,
} = require("./accessLocalTime");

function resolveBaseWallDate(text, now, timeZone = propertyTimezone()) {
  const lower = String(text || "").toLowerCase();
  const current = now instanceof Date ? now : new Date(now);

  if (/\btoday\b/.test(lower)) return wallDateInZone(current, 0, timeZone);
  if (/\btomorrow\b/.test(lower)) return wallDateInZone(current, 1, timeZone);

  const z = zonedWallClock(current, timeZone);
  for (const [weekday, index] of Object.entries(WEEKDAY_INDEX)) {
    if (new RegExp(`\\b${weekday}\\b`, "i").test(lower)) {
      const diff = (index - z.dayOfWeek + 7) % 7 || 7;
      return wallDateInZone(current, diff, timeZone);
    }
  }

  return null;
}

function parsePartOfDayWindow(text, baseWall, timeZone = propertyTimezone()) {
  const lower = String(text || "").toLowerCase();
  if (/\bmorning\b/.test(lower)) {
    return {
      startAt: wallClockToUtc({ ...baseWall, hour: 8, minute: 0 }, timeZone).toISOString(),
      endAt: wallClockToUtc({ ...baseWall, hour: 12, minute: 0 }, timeZone).toISOString(),
    };
  }
  if (/\bafternoon\b/.test(lower)) {
    return {
      startAt: wallClockToUtc({ ...baseWall, hour: 12, minute: 0 }, timeZone).toISOString(),
      endAt: wallClockToUtc({ ...baseWall, hour: 17, minute: 0 }, timeZone).toISOString(),
    };
  }
  if (/\bevening\b/.test(lower) || /\btonight\b/.test(lower)) {
    return {
      startAt: wallClockToUtc({ ...baseWall, hour: 17, minute: 0 }, timeZone).toISOString(),
      endAt: wallClockToUtc({ ...baseWall, hour: 21, minute: 0 }, timeZone).toISOString(),
    };
  }
  return null;
}

function parseAccessWindow(bodyText, now = new Date(), timeZone = propertyTimezone()) {
  const text = String(bodyText || "").trim();
  if (!text) return null;

  const baseWall = resolveBaseWallDate(text, now, timeZone);

  const afterTillMatch = text.match(
    /\bafter\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:till|until|to)\s*(?:maybe\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
  );
  if (baseWall && afterTillMatch) {
    const endMeridiem = afterTillMatch[6] || afterTillMatch[3] || "pm";
    const startMeridiem = afterTillMatch[3] || endMeridiem;
    const startAt = wallClockToUtc(
      {
        ...baseWall,
        hour: normalizeHour(afterTillMatch[1], startMeridiem, endMeridiem),
        minute: Number(afterTillMatch[2] || 0),
      },
      timeZone
    );
    const endAt = wallClockToUtc(
      {
        ...baseWall,
        hour: normalizeHour(afterTillMatch[4], endMeridiem, startMeridiem),
        minute: Number(afterTillMatch[5] || 0),
      },
      timeZone
    );
    if (endAt > startAt) {
      return { startAt: startAt.toISOString(), endAt: endAt.toISOString() };
    }
  }

  const rangeMatch = text.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
  );
  const rangeCompactPm =
    !rangeMatch && text.match(/\b(\d{1,2})\s*-\s*(\d{1,2})\s*p\b/i);
  if (baseWall && (rangeMatch || rangeCompactPm)) {
    const m = rangeMatch || [
      rangeCompactPm[0],
      rangeCompactPm[1],
      undefined,
      undefined,
      rangeCompactPm[2],
      undefined,
      "pm",
    ];
    const inferred = inferMeridiemForBareRange(
      text,
      m[1],
      m[4],
      m[3] || "",
      m[6] || ""
    );
    const startMeridiem = inferred.startMeridiem || m[6] || "";
    const endMeridiem = inferred.endMeridiem || m[6] || m[3] || "";
    const startAt = wallClockToUtc(
      {
        ...baseWall,
        hour: normalizeHour(m[1], startMeridiem, endMeridiem),
        minute: Number(m[2] || 0),
      },
      timeZone
    );
    const endAt = wallClockToUtc(
      {
        ...baseWall,
        hour: normalizeHour(m[4], endMeridiem, startMeridiem),
        minute: Number(m[5] || 0),
      },
      timeZone
    );
    if (endAt > startAt) {
      return {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      };
    }
  }

  if (baseWall) {
    return parsePartOfDayWindow(text, baseWall, timeZone);
  }

  return null;
}

/**
 * Resolve a date_for_day hint to a noon-local UTC ISO anchor.
 *
 * Thin wrapper over the canonical day pipeline (`resolveDay`) — kept as an
 * export for back-compat. New callers should use `resolveDay` directly to
 * get isoDate / startIso / endIso / localLabel alongside the anchor.
 *
 * @param {string} dateForDay
 * @param {Date} [now]
 * @param {string} [timeZone]
 */
function dateForDayToAnchorIso(dateForDay, now = new Date(), timeZone = propertyTimezone()) {
  const { resolveDay } = require("./dayResolver");
  return resolveDay(dateForDay, now, timeZone).anchorIso;
}

module.exports = {
  ACCESS_INTENT_TYPES,
  detectAccessIntent,
  inferAccessIntent,
  parseAccessWindow,
  dateForDayToAnchorIso,
  propertyTimezone,
};
