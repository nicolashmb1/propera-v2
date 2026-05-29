/**
 * Access gather — rule checks after LLM/deterministic merge (control truth for handoff).
 */
const {
  ACCESS_INTENT_TYPES,
  parseAccessWindow,
  dateForDayToAnchorIso,
} = require("../../access/parseAccessIntent");
const {
  zonedWallClock,
  wallClockToUtc,
  propertyTimezone,
} = require("../../access/accessLocalTime");
const {
  resolveAmenity,
  resolveAmenityFromText,
} = require("../../access/amenityResolver");
const {
  isAccessRequest,
  isMaintenanceRepairRequest,
} = require("./classifyNonMaintenanceRequest");
const {
  isAvailabilityQuestion,
  isAccessBookingCorrection,
  hasRecentAccessBooking,
  extractDateForDayFromText,
} = require("./accessConversationSignals");
const {
  CONVERSATION_LANE,
  shouldStayInAccessLane,
  withConversationLane,
} = require("./conversationLane");

/**
 * @param {object | null} conv
 * @returns {boolean}
 */
function isAccessSessionActive(conv) {
  const { readAccessRequest } = require("./conversationState");
  const ar = readAccessRequest(conv?.partial_package);
  const intent = String(ar?.intentType || "").trim();
  return !!intent && intent !== ACCESS_INTENT_TYPES.UNKNOWN;
}

/**
 * First-turn access detection.
 *
 * Once a session is in the access lane, `dispatchByActiveLane` routes here directly
 * and bypasses this gate (lane owns interpretation). This gate only decides
 * "is this a brand-new amenity intent?" — not "is this part of an ongoing access thread?".
 *
 * @param {object | null} conv
 * @param {string} bodyText
 */
function shouldRouteToAccessTurn(conv, bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) return false;
  if (isMaintenanceRepairRequest(text)) return false;
  if (isAccessSessionActive(conv)) return true;
  return isAccessRequest(text);
}

/**
 * @param {object} prev
 * @param {object} next
 * @returns {object}
 */
function mergeAccessPartial(prev, next) {
  const p = { ...(prev || {}) };
  const n = next && typeof next === "object" ? next : {};

  const intentType = String(n.intentType || "").trim();
  if (intentType) p.intentType = intentType;

  const locationId = String(n.locationId || "").trim();
  if (locationId) {
    p.locationId = locationId;
    if (String(n.locationHint || "").trim()) {
      p.locationHint = String(n.locationHint).trim();
    }
  }

  const startAt = String(n.startAt || "").trim();
  const endAt = String(n.endAt || "").trim();
  if (startAt && endAt) {
    p.startAt = startAt;
    p.endAt = endAt;
  }

  const dateForDay = String(n.dateForDay || "").trim();
  if (dateForDay) p.dateForDay = dateForDay;

  return p;
}

/**
 * @param {object} partial
 * @param {string} intentType
 * @returns {boolean}
 */
function accessHandoffReady(partial, intentType) {
  const intent = String(intentType || partial?.intentType || "").trim();
  const locationId = String(partial?.locationId || "").trim();

  if (intent === "ACCESS_CLARIFY" || !intent || intent === ACCESS_INTENT_TYPES.UNKNOWN) {
    return false;
  }

  if (intent === ACCESS_INTENT_TYPES.STATUS || intent === ACCESS_INTENT_TYPES.CANCEL) {
    return !!locationId || true;
  }

  if (intent === ACCESS_INTENT_TYPES.LIST_SLOTS) {
    return !!locationId && !!(partial?.dateForDay || partial?.startAt);
  }

  if (intent === ACCESS_INTENT_TYPES.RESERVE) {
    return (
      !!locationId &&
      !!String(partial?.dateForDay || "").trim() &&
      !!String(partial?.startAt || "").trim() &&
      !!String(partial?.endAt || "").trim()
    );
  }

  return false;
}

/**
 * Re-anchor start/end wall times onto partial.dateForDay (fixes LLM wrong calendar day).
 * Day-of-week / YYYY-MM-DD resolution comes from the canonical day pipeline.
 *
 * @param {object} partial
 * @param {Date} [now]
 */
function alignAccessWindowToDateForDay(partial, now = new Date()) {
  const dateForDay = String(partial?.dateForDay || "").trim();
  if (!dateForDay) return partial;

  const startAt = String(partial?.startAt || "").trim();
  const endAt = String(partial?.endAt || "").trim();
  if (!startAt || !endAt) return partial;

  const tz = propertyTimezone();
  const { resolveDay } = require("../../access/dayResolver");
  const day = resolveDay(dateForDay, now, tz);
  const [year, month, dayNum] = day.isoDate.split("-").map(Number);
  const baseWall = { year, month, day: dayNum };

  const startZ = zonedWallClock(startAt, tz);
  const endZ = zonedWallClock(endAt, tz);
  const newStart = wallClockToUtc(
    { ...baseWall, hour: startZ.hour, minute: startZ.minute },
    tz
  );
  const newEnd = wallClockToUtc({ ...baseWall, hour: endZ.hour, minute: endZ.minute }, tz);
  if (!(newEnd > newStart)) return partial;

  return {
    ...partial,
    startAt: newStart.toISOString(),
    endAt: newEnd.toISOString(),
  };
}

/**
 * LLM-on path: location + date_for_day only — never parse times from raw text.
 */
function supplementAccessLocationAndDay(partial, bodyText, locations) {
  const next = { ...(partial || {}) };
  const text = String(bodyText || "").trim();
  if (!text) return next;

  if (!next.locationId) {
    // Prefer the explicit hint that came from the LLM / prior partial; fall
    // back to scanning the raw message. Either way the resolver closed-fails
    // on unknown amenities — no silent substitution.
    let loc = null;
    const hint = String(next.locationHint || "").trim();
    if (hint) {
      const r = resolveAmenity(hint, locations);
      if (r.ok) loc = r.location;
    }
    if (!loc && text) {
      const r = resolveAmenityFromText(text, locations);
      if (r.ok) loc = r.location;
    }
    if (loc) {
      next.locationId = String(loc.id || "").trim();
      next.locationHint = String(loc.name || loc.slug || "").trim();
    }
  }

  if (!next.dateForDay) {
    const dayHint = extractDateForDayFromText(text);
    if (dayHint) next.dateForDay = dayHint;
    else if (/\btoday\b/i.test(text)) next.dateForDay = "today";
    else if (/\btomorrow\b/i.test(text)) next.dateForDay = "tomorrow";
  }

  if (isAvailabilityQuestion(text) || next.intentType === ACCESS_INTENT_TYPES.LIST_SLOTS) {
    if (!next.dateForDay) next.dateForDay = "tomorrow";
  }

  return next;
}

/**
 * LLM-off fallback: location, day, and regex time parse.
 */
function supplementAccessPartialDeterministic(partial, bodyText, locations) {
  const next = supplementAccessLocationAndDay(partial, bodyText, locations);
  const text = String(bodyText || "").trim();
  const hasWindow =
    !!String(next.startAt || "").trim() && !!String(next.endAt || "").trim();
  if (hasWindow || !text) return next;

  let parseText = text;
  if (
    !/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      text
    ) &&
    next.dateForDay
  ) {
    parseText = `${next.dateForDay} ${text}`;
  }

  const window = parseAccessWindow(parseText);
  if (window?.startAt && window?.endAt) {
    next.startAt = window.startAt;
    next.endAt = window.endAt;
  }

  return next;
}

/**
 * @param {object} partial
 * @param {object[]} locations
 * @returns {string}
 */
function accessLocationDisplayName(partial, locations) {
  const id = String(partial?.locationId || "").trim();
  if (id) {
    const hit = (locations || []).find((l) => String(l.id || "").trim() === id);
    if (hit?.name) return String(hit.name).trim();
  }
  return String(partial?.locationHint || "that amenity").trim() || "that amenity";
}

function stampAccessLane(partial) {
  return withConversationLane(partial, CONVERSATION_LANE.ACCESS);
}

module.exports = {
  isAccessSessionActive,
  shouldRouteToAccessTurn,
  stampAccessLane,
  mergeAccessPartial,
  dateForDayToAnchorIso,
  alignAccessWindowToDateForDay,
  accessHandoffReady,
  supplementAccessLocationAndDay,
  supplementAccessPartialDeterministic,
  accessLocationDisplayName,
};
