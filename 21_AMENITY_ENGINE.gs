/**
 * AMENITY_ENGINE.gs
 * Amenity reservation flow: config, holds, conflicts, access codes.
 * Extracted from PROPERA MAIN.gs to reduce file size.
 * Depends on: getSheet_, withWriteLock_, ctxGet_, ctxUpsert_,
 *   renderTenantKey_, sendRouterSms_, logDevSms_, parsePreferredWindowShared_/parsePreferredWindow_.
 * Owns: getAmenityHeaderMap_, amenityFindRowByValue_, normalizePhoneKey_, parseMonthNameWindow_, to24_.
 * Uses: AMENITIES_SHEET_NAME, AMENITY_RES_SHEET_NAME, AMENITY_DIR_SHEET_NAME (script-level constants).
 */

// ---------------------------------------------
// CONFIG
// ---------------------------------------------
const AMENITY_STAGE_CACHE_SECONDS = 60 * 60 * 6; // 6 hours
const AMENITY_HOLD_SECONDS = 120;                // 2 minutes
const AMENITY_CODE_CACHE_SECONDS = 60 * 60;      // 1 hour
const AMENITY_DEFAULT_AMENITY_KEY = "PENN_GAMEROOM";

// ---------------------------------------------
// STATUS ENUM (sheet values)
// ---------------------------------------------
const AMENITY_STATUS = {
  HOLD: "HOLD",
  RESERVED: "RESERVED",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED"
};

// ---------------------------------------------
// ACCESS PROVIDER CONFIG
// ---------------------------------------------
const ACCESS_PROVIDER_CONFIG = {
  DEFAULT_PROVIDER: "seam",
  FALLBACK_TO_STATIC: true,
  MAX_RETRY_ATTEMPTS: 2,
  RETRY_BACKOFF_MS: [250, 750],
  RETRY_ON_CODES: [408, 429, 500, 502, 503, 504]
};

// ---------------------------------------------
// SMALL HELPERS (amenity-only)
// ---------------------------------------------
function toBool_(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || "").trim().toLowerCase();
  return (s === "true" || s === "yes" || s === "1" || s === "y");
}

function toDate_(v) {
  if (v instanceof Date) return v;
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function indexMap_(headerRow) {
  const map = {};
  for (let i = 0; i < headerRow.length; i++) {
    const key = String(headerRow[i] || "").trim();
    if (key) map[key] = i;
  }
  return map;
}

// ---------------------------------------------
// MAIN HANDLER (COMPASS-BRIDGE)
// - No direct SMS strings (replyKey only)
// ---------------------------------------------
function handleAmenitySms_(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const phone = String(p.From || "").trim();
  const bodyRaw = String(p.Body || "").trim();
  const s = bodyRaw.toLowerCase().trim();
  if (!phone) return;

  // Compass-safe context read
  let ctx = null;
  try { ctx = ctxGet_(phone); } catch (_) { ctx = null; }
  const lang = amenityGetLang_(ctx);

  // ----------------------------
  // A) Explicit commands only
  // ----------------------------
  if (s === "help reservation" || s === "reservation help" || s === "help gameroom") {
    const amenity = getAmenityConfig_(AMENITY_DEFAULT_AMENITY_KEY) || {
      AmenityKey: AMENITY_DEFAULT_AMENITY_KEY,
      AmenityName: "Game Room",
      PropertyCode: "PENN",
      MaxBlockHours: 4,
      OpenTime: "08:00",
      CloseTime: "22:00"
    };

    return amenityReplyKey_(phone, lang, "AMENITY_HELP_RESERVATION", {
      amenityName: String(amenity.AmenityName || ""),
      propertyCode: String(amenity.PropertyCode || ""),
      maxBlockHours: Number(amenity.MaxBlockHours || 4),
      openTime: String(amenity.OpenTime || "08:00"),
      closeTime: String(amenity.CloseTime || "22:00")
    }, "AMENITY_HELP");
  }

  if (s === "my reservations" || s.startsWith("my reservations")) {
    const upcoming = listUpcomingAmenityReservations_(phone, 5);

    if (!upcoming || !upcoming.length) {
      return amenityReplyKey_(phone, lang, "AMENITY_MY_RES_NONE", {}, "AMENITY_LIST");
    }

    let lines = "";
    upcoming.forEach((r, i) => {
      lines += (i + 1) + ") " + String(r.amenityLabel || "") + " - " + formatWindowLabel_(r.start, r.end) + "\n";
    });

    return amenityReplyKey_(phone, lang, "AMENITY_MY_RES_LIST", { list: lines.trim() }, "AMENITY_LIST");
  }

  if (s === "cancel reservation" || s.startsWith("cancel reservation")) {
    const cancelled = cancelUpcomingAmenityReservation_(phone);

    // Clear amenity state (ship-first safe)
    try { endAmenityFlow_(phone); } catch (_) {}
    try { amenityClearExpected_(phone); } catch (_) {}

    if (!cancelled) {
      return amenityReplyKey_(phone, lang, "AMENITY_CANCEL_NONE", {}, "AMENITY_CANCEL");
    }

    // Best-effort revoke (idempotent)
    try {
      accessProviderRevokeAmenityCode_({
        bookingId: String(cancelled.bookingId || ""),
        seamCodeId: String(cancelled.seamCodeId || ""),
        source: String(cancelled.codeSource || ""),
        codeRevokedAt: cancelled.codeRevokedAt || null
      });
    } catch (_) {}

    return amenityReplyKey_(phone, lang, "AMENITY_CANCEL_OK", {
      amenityLabel: String(cancelled.amenityLabel || ""),
      window: formatWindowLabel_(cancelled.start, cancelled.end)
    }, "AMENITY_CANCEL_OK");
  }

  if (s.startsWith("change reservation") || s.startsWith("reschedule reservation")) {
    const newText = bodyRaw.replace(/^(change reservation|reschedule reservation)\s*/i, "").trim();
    const parsed = safeParseWindow_(newText);

    if (!parsed || !parsed.start) {
      const amenity = getAmenityConfig_(AMENITY_DEFAULT_AMENITY_KEY) || { MaxBlockHours: 4 };
      return amenityReplyKey_(phone, lang, "AMENITY_CHANGE_NEEDS_TIME", {
        maxBlockHours: Number(amenity.MaxBlockHours || 4)
      }, "AMENITY_CHANGE_NEEDS_TIME");
    }

    const out = rescheduleBestAmenityReservation_(phone, parsed.start, parsed.end);
    if (!out || !out.ok) {
      return amenityReplyKey_(phone, lang, "AMENITY_CHANGE_FAILED", {
        detail: String((out && out.msg) ? out.msg : "")
      }, "AMENITY_CHANGE_FAILED");
    }

    return amenityReplyKey_(phone, lang, "AMENITY_CHANGE_OK", {
      amenityLabel: String(out.amenityLabel || ""),
      window: formatWindowLabel_(out.start, out.end)
    }, "AMENITY_CHANGE_OK");
  }

  // ----------------------------
  // B) YES / NO for HOLD confirmation
  // ----------------------------
  if (s === "yes" || s === "confirm") {
    const out = confirmAmenityHold_(phone, lang);
    if (!out || !out.ok) {
      return amenityReplyKey_(phone, lang, String(out && out.replyKey ? out.replyKey : "AMENITY_CONFIRM_FAILED"), (out && out.vars) ? out.vars : {}, "AMENITY_CONFIRM_FAIL");
    }

    // Leave flow once confirmed
    try { endAmenityFlow_(phone); } catch (_) {}
    try { amenityClearExpected_(phone); } catch (_) {}

    return amenityReplyKey_(phone, lang, String(out.replyKey || "AMENITY_CONFIRMED"), out.vars || {}, "AMENITY_CONFIRMED");
  }

  if (s === "no") {
    // Release hold (idempotent)
    try { releaseAmenityHold_(phone); } catch (_) {}
    try { amenityClearExpected_(phone); } catch (_) {}

    return amenityReplyKey_(phone, lang, "AMENITY_HOLD_RELEASED", {}, "AMENITY_HOLD_RELEASED");
  }

  // ----------------------------
  // C) Normal flow: reserve -> time parsing
  // ----------------------------
  const amenityKey = detectAmenityKey_(s) || AMENITY_DEFAULT_AMENITY_KEY;

  const amenity = getAmenityConfig_(amenityKey);
  if (!amenity || amenity.Active !== true) {
    return amenityReplyKey_(phone, lang, "AMENITY_NOT_AVAILABLE", {}, "AMENITY_NOT_AVAILABLE");
  }

  // Are they in amenity flow?
  const inFlowLegacy = !!getAmenityStageCache_(phone) || !!safeGetAmenityStage_(phone);
  const inFlowCtx = isAmenityExpected_(ctx);
  const inFlow = !!(inFlowLegacy || inFlowCtx);

  // Start intent narrow
  const startIntent =
    s.indexOf("gameroom") >= 0 || s.indexOf("game room") >= 0 || s.indexOf("game-room") >= 0 ||
    s.indexOf("reserve") >= 0 || s.indexOf("book") >= 0 || s.indexOf("reservation") >= 0 || s.indexOf("booking") >= 0;

  if (!inFlow && !startIntent) {
    return amenityReplyKey_(phone, lang, "AMENITY_HOW_TO_START", {}, "AMENITY_START");
  }

  // Lock them into amenity flow (legacy + ctx bridge)
  try { setAmenityDirSafe_(phone, { Stage: "ASK_WINDOW", AmenityKey: amenityKey, TempStart: "", TempEnd: "" }); } catch (_) {}
  try { setAmenityStageCache_(phone, "ASK_WINDOW"); } catch (_) {}
  try { amenitySetExpected_(phone, "AMENITY_TIME", 10, ""); } catch (_) {}

  const cleaned = normalizeDateTimeText_(bodyRaw);
  const parsed = safeParseWindow_(cleaned);

  if (!parsed || !parsed.start) {
    return amenityReplyKey_(phone, lang, "AMENITY_ASK_WINDOW", {
      amenityName: String(amenity.AmenityName || ""),
      propertyCode: String(amenity.PropertyCode || ""),
      maxBlockHours: Number(amenity.MaxBlockHours || 4),
      openTime: String(amenity.OpenTime || "08:00"),
      closeTime: String(amenity.CloseTime || "22:00")
    }, "AMENITY_ASK_WINDOW");
  }

  const start = parsed.start;
  const end = parsed.end || new Date(start.getTime() + 60 * 60 * 1000);

  const durHours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);
  if (durHours <= 0) {
    return amenityReplyKey_(phone, lang, "AMENITY_TIME_INVALID", {
      maxBlockHours: Number(amenity.MaxBlockHours || 4)
    }, "AMENITY_TIME_INVALID");
  }

  if (durHours > Number(amenity.MaxBlockHours || 4)) {
    return amenityReplyKey_(phone, lang, "AMENITY_TOO_LONG", {
      maxBlockHours: Number(amenity.MaxBlockHours || 4)
    }, "AMENITY_TOO_LONG");
  }

  if (!isWithinHours_(start, end, amenity.OpenTime, amenity.CloseTime)) {
    return amenityReplyKey_(phone, lang, "AMENITY_OUTSIDE_HOURS", {
      openTime: String(amenity.OpenTime || "08:00"),
      closeTime: String(amenity.CloseTime || "22:00")
    }, "AMENITY_OUTSIDE_HOURS");
  }

  if (hasAmenityConflictIncludingHolds_(amenityKey, start, end)) {
    const suggestions = findClosestAvailableSlots_(amenityKey, start, end, amenity, 3);
    let lines = "";
    if (suggestions && suggestions.length) {
      suggestions.forEach(x => { lines += "- " + formatWindowLabel_(x.start, x.end) + "\n"; });
    }
    return amenityReplyKey_(phone, lang, "AMENITY_SLOT_TAKEN", { suggestions: lines.trim() }, "AMENITY_CONFLICT");
  }

  // Create HOLD row + cache
  const hold = createAmenityHold_(amenityKey, phone, start, end);

  // Expect YES within 2 minutes
  try { amenitySetExpected_(phone, "AMENITY_CONFIRM", 2, String(hold.bookingId || "")); } catch (_) {}

  return amenityReplyKey_(phone, lang, "AMENITY_HOLD_CREATED", {
    amenityName: String(amenity.AmenityName || ""),
    propertyCode: String(amenity.PropertyCode || ""),
    window: formatWindowLabel_(start, end)
  }, "AMENITY_HOLD_CREATED");
}

// ---------------------------------------------
// TEMPLATE REPLY BRIDGE (you already have these; included for copy/paste completeness)
// ---------------------------------------------
function amenityReplyKey_(phone, lang, replyKey, vars, tag) {
  const ph = String(phone || "").trim();
  if (!ph) return;

  const l = String(lang || "en").toLowerCase();
  const key = String(replyKey || "").trim();
  if (!key) return;

  const msg = renderTenantKey_(key, l, vars || {});
  return sendRouterSms_(ph, msg, String(tag || "AMENITY"));
}

function amenityGetLang_(ctx) {
  return String((ctx && ctx.lang) || "en").toLowerCase();
}

function amenitySetExpected_(phone, expected, minutes, workItemId) {
  const exp = String(expected || "").trim();
  const mins = Number(minutes || 0) || 0;
  const expiresAt = mins > 0 ? new Date(Date.now() + mins * 60 * 1000) : "";
  return ctxUpsert_(phone, {
    pendingExpected: exp,
    pendingExpiresAt: expiresAt,
    pendingWorkItemId: String(workItemId || "")
  });
}

function amenityClearExpected_(phone) {
  return ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "", pendingWorkItemId: "" });
}

// ---------------------------------------------
// STICKY CACHE HELPERS (legacy) - exclusive set/clear
// ---------------------------------------------
function setAmenityStageCache_(phone, stage) {
  const cache = CacheService.getScriptCache();
  cache.put("amenity_stage_" + normalizePhoneKey_(phone), String(stage || "ASK_WINDOW"), AMENITY_STAGE_CACHE_SECONDS);
}

function clearAmenityStageCache_(phone) {
  const cache = CacheService.getScriptCache();
  cache.remove("amenity_stage_" + normalizePhoneKey_(phone));
}

// ---------------------------------------------
// PHONE + TEXT NORMALIZERS (amenity-only usage)
// ---------------------------------------------
function normalizeTimeRangeSuffix_(t) {
  return String(t || "").replace(
    /\b(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/ig,
    "$1$3-$2$3"
  );
}

function normalizeDateTimeText_(s) {
  let t = String(s || "").trim();
  t = t.replace(/[?!.]+$/g, "").trim();
  t = t.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  t = t.replace(/[–—]/g, "-");
  t = t.replace(/\s+/g, " ").trim();
  t = normalizeTimeRangeSuffix_(t);
  return t;
}

// ---------------------------------------------
// PARSING (prefers your existing parsePreferredWindow_)
// ---------------------------------------------
function safeParseWindow_(text) {
  const cleaned = normalizeDateTimeText_(text);

  try {
    if (typeof parsePreferredWindowShared_ === "function") {
      const out = parsePreferredWindowShared_(cleaned);
      if (out && out.start) return out;
    } else if (typeof parsePreferredWindow_ === "function") {
      // Transitional compatibility: parsePreferredWindow_ delegates to the shared parser
      const out = parsePreferredWindow_(cleaned);
      if (out && out.start) return out;
    }
  } catch (err) {
    try { logDevSms_("(system)", "", "AMEN_PARSE_PREF_FAIL " + String(err && err.message ? err.message : err)); } catch (_) {}
  }

  const fallback = parseMonthNameWindow_(cleaned);
  return fallback || null;
}

// ---------------------------------------------
// HOURS / TIME HELPERS
// ---------------------------------------------
function isWithinHours_(start, end, openVal, closeVal) {
  const open = parseHHMM_(openVal);
  const close = parseHHMM_(closeVal);
  const sMin = start.getHours() * 60 + start.getMinutes();
  const eMin = end.getHours() * 60 + end.getMinutes();
  return (sMin >= open && eMin <= close);
}

function parseHHMM_(v) {
  if (v instanceof Date) return v.getHours() * 60 + v.getMinutes();
  if (typeof v === "number" && isFinite(v)) {
    const minutes = Math.round(v * 24 * 60);
    return Math.max(0, Math.min(24 * 60, minutes));
  }
  const s = String(v || "").trim();

  // allow "8am", "10pm" minimal
  const ap = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ap) {
    const hh = Number(ap[1]);
    const mm = ap[2] ? Number(ap[2]) : 0;
    const a = ap[3].toLowerCase();
    const H = to24_(hh, a);
    return H * 60 + mm;
  }

  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatWindowLabel_(start, end) {
  const tz = Session.getScriptTimeZone();
  const day = Utilities.formatDate(start, tz, "EEE MMM d");
  const s = Utilities.formatDate(start, tz, "h:mm a");
  const e = Utilities.formatDate(end, tz, "h:mm a");
  return day + ", " + s + "-" + e;
}

// ---------------------------------------------
// AMENITIES CONFIG
// REQUIRED columns recommended:
// AmenityKey, PropertyCode, AmenityName, Active, OpenTime, CloseTime, SlotMinutes, MaxBlockHours, AccessCode, DeviceID, UseSmartLock
// ---------------------------------------------
function getAmenityConfig_(amenityKey) {
  const aKey = String(amenityKey || "").trim();
  if (!aKey) return null;

  const sheet = getSheet_(AMENITIES_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (String(row[idx["AmenityKey"]] || "").trim() !== aKey) continue;

    return {
      AmenityKey: aKey,
      PropertyCode: String(row[idx["PropertyCode"]] || "").trim(),
      AmenityName: String(row[idx["AmenityName"]] || "").trim() || aKey,
      Active: toBool_(row[idx["Active"]]),
      OpenTime: row[idx["OpenTime"]] || "08:00",
      CloseTime: row[idx["CloseTime"]] || "22:00",
      SlotMinutes: Number(row[idx["SlotMinutes"]] || 60),
      MaxBlockHours: Number(row[idx["MaxBlockHours"]] || 4),
      AccessCode: String(row[idx["AccessCode"]] || "").trim(),
      DeviceID: String(row[idx["DeviceID"]] || "").trim(),
      UseSmartLock: toBool_(row[idx["UseSmartLock"]])
    };
  }
  return null;
}

function getAmenityAccessCode_(amenityKey) {
  const aKey = String(amenityKey || "").trim();
  if (!aKey) return "";

  const cache = CacheService.getScriptCache();
  const cacheKey = "amenity_code_" + aKey;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const amenity = getAmenityConfig_(aKey);
  const code = (amenity && amenity.AccessCode) ? String(amenity.AccessCode) : "";
  cache.put(cacheKey, code, AMENITY_CODE_CACHE_SECONDS);
  return code;
}

function detectAmenityKey_(bodyLower) {
  const s = String(bodyLower || "").toLowerCase();
  if (s.indexOf("gameroom") >= 0 || s.indexOf("game room") >= 0 || s.indexOf("game-room") >= 0) return "PENN_GAMEROOM";
  return "";
}

// ---------------------------------------------
// DIRECTORY (legacy; optional) - exclusive set/clear
// ---------------------------------------------
function setAmenityDir_(phone, obj) {
  const sheet = getSheet_(AMENITY_DIR_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) throw new Error("AmenityDirectory missing header row");

  const values = sheet.getRange(1, 1, Math.max(lastRow, 1), sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));
  const kPhone = idx["Phone"];

  let rowNum = -1;
  for (let r = 1; r < values.length; r++) {
    if (normalizePhoneKey_(values[r][kPhone]) === normalizePhoneKey_(phone)) { rowNum = r + 1; break; }
  }

  const out = [ phone, obj.Stage || "", obj.AmenityKey || "", obj.TempStart || "", obj.TempEnd || "", new Date() ];
  if (rowNum === -1) sheet.appendRow(out);
  else sheet.getRange(rowNum, 1, 1, out.length).setValues([out]);
}

function clearAmenityDir_(phone) {
  const sheet = getSheet_(AMENITY_DIR_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));
  const kPhone = idx["Phone"];

  for (let r = values.length - 1; r >= 1; r--) {
    if (normalizePhoneKey_(values[r][kPhone]) === normalizePhoneKey_(phone)) {
      sheet.deleteRow(r + 1);
      return;
    }
  }
}

function setAmenityDirSafe_(phone, obj) {
  try { setAmenityDir_(phone, obj); } catch (err) { try { logDevSms_("(system)", "", "AMEN_DIR_SET_FAIL " + String(err)); } catch (_) {} }
}

// ---------------------------------------------
// CONFLICT CHECKS (PRODUCTION-LINE)
// - hasAmenityConflict_ ignores HOLD rows by design
// - includes StartDateTime/EndDateTime preferred
// - blocks ACTIVE/RESERVED/CONFIRMED (for backwards compatibility)
// ---------------------------------------------
function hasAmenityConflict_(amenityKey, start, end, ignoreBookingId) {
  const aKey = String(amenityKey || "").trim();
  const ign = String(ignoreBookingId || "").trim();

  if (!aKey || !(start instanceof Date) || isNaN(start.getTime()) || !(end instanceof Date) || isNaN(end.getTime())) return false;

  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));

  const kAmenity = idx["AmenityKey"];
  const kStatus  = idx["Status"];
  const kBooking = idx["BookingID"];
  const kResId   = idx["ResId"];

  const kStartDT = idx["StartDateTime"];
  const kEndDT   = idx["EndDateTime"];
  const kStart   = idx["Start"];
  const kEnd     = idx["End"];

  if (kAmenity == null || kStatus == null) return false;

  const s = start.getTime();
  const e = end.getTime();

  const BLOCK = { "ACTIVE": true, "RESERVED": true, "CONFIRMED": true };

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (String(row[kAmenity] || "").trim() !== aKey) continue;

    const status = String(row[kStatus] || "").trim().toUpperCase();
    if (!BLOCK[status]) continue;

    // ignore self (used in dal conflicts)
    const bid = (kBooking != null) ? String(row[kBooking] || "").trim() : "";
    const rid = (kResId != null) ? String(row[kResId] || "").trim() : "";
    const id = bid || rid;
    if (ign && id && id === ign) continue;

    const rsVal = (kStartDT != null && row[kStartDT]) ? row[kStartDT] : row[kStart];
    const reVal = (kEndDT != null && row[kEndDT]) ? row[kEndDT] : row[kEnd];

    const rsD = toDate_(rsVal);
    const reD = toDate_(reVal);
    if (!rsD || !reD) continue;

    const rs = rsD.getTime();
    const re = reD.getTime();
    if (s < re && e > rs) return true;
  }

  return false;
}

// HOLD included only if unexpired (ExpiresAt >= now). If ExpiresAt missing, HOLD conflicts (safe).
function hasAmenityConflictIncludingHolds_(amenityKey, start, end) {
  const aKey = String(amenityKey || "").trim();
  if (!aKey || !(start instanceof Date) || isNaN(start.getTime()) || !(end instanceof Date) || isNaN(end.getTime())) return false;

  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));

  const kAmenity = idx["AmenityKey"];
  const kStatus  = idx["Status"];
  const kExp     = idx["ExpiresAt"];

  const kStartDT = idx["StartDateTime"];
  const kEndDT   = idx["EndDateTime"];
  const kStart   = idx["Start"];
  const kEnd     = idx["End"];

  if (kAmenity == null || kStatus == null) return false;

  const nowMs = Date.now();
  const s = start.getTime();
  const e = end.getTime();

  const BLOCK_ALWAYS = { "ACTIVE": true, "RESERVED": true, "CONFIRMED": true };

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (String(row[kAmenity] || "").trim() !== aKey) continue;

    const status = String(row[kStatus] || "").trim().toUpperCase();
    let blocks = false;

    if (BLOCK_ALWAYS[status]) {
      blocks = true;
    } else if (status === "HOLD") {
      if (kExp == null) {
        blocks = true;
      } else {
        const expD = toDate_(row[kExp]);
        const expMs = expD ? expD.getTime() : NaN;
        if (isFinite(expMs) && expMs >= nowMs) blocks = true;
      }
    } else {
      continue;
    }

    if (!blocks) continue;

    const rsVal = (kStartDT != null && row[kStartDT]) ? row[kStartDT] : row[kStart];
    const reVal = (kEndDT != null && row[kEndDT]) ? row[kEndDT] : row[kEnd];

    const rsD = toDate_(rsVal);
    const reD = toDate_(reVal);
    if (!rsD || !reD) continue;

    const rs = rsD.getTime();
    const re = reD.getTime();
    if (s < re && e > rs) return true;
  }

  return false;
}

// ---------------------------------------------
// SUGGESTIONS (bounded)
// ---------------------------------------------
function findClosestAvailableSlots_(amenityKey, desiredStart, desiredEnd, amenity, limit) {
  const out = [];
  const slotMin = Math.max(15, Number(amenity.SlotMinutes || 60));
  const durMin = Math.max(15, Math.round((desiredEnd.getTime() - desiredStart.getTime()) / 60000));
  const maxChecks = 80;

  let t = new Date(desiredStart.getTime());
  for (let i = 0; i < maxChecks && out.length < (limit || 3); i++) {
    t = new Date(t.getTime() + slotMin * 60000);
    const end = new Date(t.getTime() + durMin * 60000);

    if (!isWithinHours_(t, end, amenity.OpenTime, amenity.CloseTime)) {
      const nextDay = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 0, 0);
      const openMin = parseHHMM_(amenity.OpenTime);
      nextDay.setHours(Math.floor(openMin / 60), openMin % 60, 0, 0);
      t = nextDay;
      continue;
    }

    if (!hasAmenityConflictIncludingHolds_(amenityKey, t, end)) {
      out.push({ start: t, end: end });
    }
  }

  return out;
}

// ---------------------------------------------
// HOLD CREATION (writes under lock)
// - BookingID canonical (uses ResId value)
// - Sets CodeSource="pending" on hold creation when column exists
// - Writes StartDateTime/EndDateTime when present
// ---------------------------------------------
function makeAmenityResId_(amenityKey, start) {
  const tz = Session.getScriptTimeZone();
  const ymd = Utilities.formatDate(start, tz, "yyyyMMdd");
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return String(amenityKey) + "-" + ymd + "-" + rand;
}

function createAmenityHold_(amenityKey, phone, start, end) {
  const aKey = String(amenityKey || "").trim();
  const ph = String(phone || "").trim();
  if (!aKey || !ph || !(start instanceof Date) || isNaN(start.getTime()) || !(end instanceof Date) || isNaN(end.getTime())) {
    throw new Error("createAmenityHold_: invalid args");
  }

  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  if (sheet.getLastRow() < 1) throw new Error("AmenityReservations missing header row");

  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = indexMap_(header.map(String));

  // Required minimums
  if (idx["AmenityKey"] == null || idx["Phone"] == null || idx["Status"] == null || idx["CreatedAt"] == null) {
    throw new Error("AmenityReservations missing required columns (AmenityKey/Phone/Status/CreatedAt)");
  }

  const resId = makeAmenityResId_(aKey, start);
  const bookingId = (idx["BookingID"] != null) ? resId : resId; // canonical = resId either way
  const expiresAt = new Date(Date.now() + Number(AMENITY_HOLD_SECONDS || 120) * 1000);

  const row = new Array(sheet.getLastColumn()).fill("");

  if (idx["ResId"] != null) row[idx["ResId"]] = resId;
  if (idx["BookingID"] != null) row[idx["BookingID"]] = bookingId;

  row[idx["AmenityKey"]] = aKey;
  row[idx["Phone"]] = ph;

  if (idx["Start"] != null) row[idx["Start"]] = start;
  if (idx["End"] != null) row[idx["End"]] = end;
  if (idx["StartDateTime"] != null) row[idx["StartDateTime"]] = start;
  if (idx["EndDateTime"] != null) row[idx["EndDateTime"]] = end;

  row[idx["Status"]] = AMENITY_STATUS.HOLD;

  if (idx["AccessCodeSnapshot"] != null) row[idx["AccessCodeSnapshot"]] = ""; // filled on confirm
  if (idx["CodeSource"] != null) row[idx["CodeSource"]] = "pending";

  row[idx["CreatedAt"]] = new Date();
  if (idx["ExpiresAt"] != null) row[idx["ExpiresAt"]] = expiresAt;

  // Optional updatedAt column
  if (idx["UpdatedAt"] != null) row[idx["UpdatedAt"]] = new Date();

  withWriteLock_("AMENITY_HOLD_APPEND", () => {
    sheet.appendRow(row);
  });

  setAmenityHoldCache_(ph, {
    bookingId: bookingId,
    resId: resId,
    amenityKey: aKey,
    startMs: start.getTime(),
    endMs: end.getTime(),
    expiresAtMs: expiresAt.getTime()
  });

  return { bookingId: bookingId, resId: resId, expiresAt: expiresAt };
}

function getHoldBookingId_(hold) {
  const bid = String((hold && (hold.bookingId || hold.BookingID)) || "").trim();
  const rid = String((hold && (hold.resId || hold.ResId)) || "").trim();
  return bid || rid;
}

function releaseAmenityHold_(phone) {
  const ph = String(phone || "").trim();
  const hold = getAmenityHoldCache_(ph);
  if (!hold) return;

  const bookingId = getHoldBookingId_(hold);
  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const row = amenityFindRowByValue_(sheet, "BookingID", bookingId);
  const map = getAmenityHeaderMap_(sheet);

  // best-effort mark CANCELLED if still HOLD
  if (row && map["Status"]) {
    withWriteLock_("AMENITY_HOLD_RELEASE", () => {
      const st = String(sheet.getRange(row, map["Status"]).getValue() || "").trim().toUpperCase();
      if (st === AMENITY_STATUS.HOLD) {
        sheet.getRange(row, map["Status"]).setValue(AMENITY_STATUS.CANCELLED);
        if (map["CancelledAt"]) sheet.getRange(row, map["CancelledAt"]).setValue(new Date());
        if (map["UpdatedAt"]) sheet.getRange(row, map["UpdatedAt"]).setValue(new Date());
        if (map["CodeSource"]) sheet.getRange(row, map["CodeSource"]).setValue("none");
      }
    });
  }

  clearAmenityHoldCache_(ph);
  try { clearAmenityStageCache_(ph); } catch (_) {}
  try { clearAmenityDir_(ph); } catch (_) {}
}

// ---------------------------------------------
// CONFIRM HOLD (PRODUCTION-LINE)
// - Final conflict check (ignores HOLD rows, blocks ACTIVE/RESERVED/CONFIRMED)
// - Transition HOLD -> RESERVED (under lock)
// - Create code via accessProviderCreateAmenityCode_ (outside lock)
// - Write AccessCodeSnapshot + (optional AccessCode/SeamCodeID/CodeSource) under lock
// - Returns { ok, replyKey, vars } only
// ---------------------------------------------
function confirmAmenityHold_(phone, lang) {
  const ph = String(phone || "").trim();
  const l = String(lang || "en").toLowerCase();
  if (!ph) return { ok: false, replyKey: "AMENITY_CONFIRM_FAILED", vars: {} };

  const hold = getAmenityHoldCache_(ph);
  if (!hold) return { ok: false, replyKey: "AMENITY_NO_HOLD_FOUND", vars: {} };

  const nowMs = Date.now();
  if (hold.expiresAtMs && hold.expiresAtMs < nowMs) {
    try { clearAmenityHoldCache_(ph); } catch (_) {}
    return { ok: false, replyKey: "AMENITY_HOLD_EXPIRED_RETRY", vars: {} };
  }

  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const rowNum = amenityFindRowByValue_(sheet, "BookingID", getHoldBookingId_(hold));
  if (!rowNum) {
    try { clearAmenityHoldCache_(ph); } catch (_) {}
    return { ok: false, replyKey: "AMENITY_BOOKING_NOT_FOUND", vars: {} };
  }

  const map = getAmenityHeaderMap_(sheet);
  if (!map["Status"] || !map["AmenityKey"]) {
    try { clearAmenityHoldCache_(ph); } catch (_) {}
    return { ok: false, replyKey: "AMENITY_SCHEMA_MISSING", vars: {} };
  }

  // Read row snapshot (no lock needed for read)
  const row = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];

  const status = String(row[map["Status"] - 1] || "").trim().toUpperCase();
  const amenityKey = String(row[map["AmenityKey"] - 1] || "").trim();

  const start = (map["StartDateTime"] ? toDate_(row[map["StartDateTime"] - 1]) : null) || (map["Start"] ? toDate_(row[map["Start"] - 1]) : null);
  const end = (map["EndDateTime"] ? toDate_(row[map["EndDateTime"] - 1]) : null) || (map["End"] ? toDate_(row[map["End"] - 1]) : null);

  if (!amenityKey || !start || !end) {
    withWriteLock_("AMENITY_CONFIRM_BAD_ROW", () => {
      sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.CANCELLED);
      if (map["CancelledAt"]) sheet.getRange(rowNum, map["CancelledAt"]).setValue(new Date());
      if (map["CodeSource"]) sheet.getRange(rowNum, map["CodeSource"]).setValue("none");
      if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
    });
    try { clearAmenityHoldCache_(ph); } catch (_) {}
    return { ok: false, replyKey: "AMENITY_BOOKING_NOT_FOUND", vars: {} };
  }

  // If not HOLD anymore, treat as idempotent confirm:
  // - If already RESERVED/ACTIVE/CONFIRMED, return confirmed with current code
  if (status !== AMENITY_STATUS.HOLD) {
    const bid = getHoldBookingId_(hold);
    const access = getReservationAccessState_(bid);
    try { clearAmenityHoldCache_(ph); } catch (_) {}

    const amenity = getAmenityConfig_(amenityKey);
    const label = amenity ? (String(amenity.AmenityName || "") + " (" + String(amenity.PropertyCode || "") + ")") : amenityKey;

    return {
      ok: true,
      replyKey: "AMENITY_CONFIRMED",
      vars: {
        bookingId: bid,
        amenityLabel: label,
        window: formatWindowLabel_(start, end),
        code: String((access && access.code) ? access.code : ""),
        codeSource: String((access && access.source) ? access.source : "none")
      }
    };
  }

  // Final conflict check ignores HOLD rows and self
  const bookingId = getHoldBookingId_(hold);
  if (hasAmenityConflict_(amenityKey, start, end, bookingId)) {
    withWriteLock_("AMENITY_CONFIRM_CONFLICT", () => {
      sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.CANCELLED);
      if (map["CancelledAt"]) sheet.getRange(rowNum, map["CancelledAt"]).setValue(new Date());
      if (map["CodeSource"]) sheet.getRange(rowNum, map["CodeSource"]).setValue("none");
      if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
    });
    try { clearAmenityHoldCache_(ph); } catch (_) {}
    return { ok: false, replyKey: "AMENITY_SLOT_TAKEN_RACE", vars: {} };
  }

  // Transition HOLD -> RESERVED under lock (ship-first)
  withWriteLock_("AMENITY_CONFIRM_TO_RESERVED", () => {
    sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.RESERVED);
    if (map["CodeSource"]) sheet.getRange(rowNum, map["CodeSource"]).setValue("pending");
    if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
  });

  // Build reservation object for provider (outside lock)
  const amenity = getAmenityConfig_(amenityKey);
  const reservation = {
    bookingId: bookingId,
    amenityKey: amenityKey,
    start: start,
    end: end,
    property: amenity ? String(amenity.PropertyCode || "") : "",
    unit: "",
    tenantName: ""
  };

  const codeResult = accessProviderCreateAmenityCode_(reservation);

  if (!codeResult || codeResult.success !== true) {
    // Revert to HOLD so user can retry confirm (or you can CANCELLED; ship-first uses HOLD)
    withWriteLock_("AMENITY_CONFIRM_CODE_FAIL", () => {
      sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.HOLD);
      if (map["CodeSource"]) sheet.getRange(rowNum, map["CodeSource"]).setValue("none");
      if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
    });

    return { ok: false, replyKey: "AMENITY_CODE_CREATION_FAILED", vars: { error: String(codeResult && codeResult.error ? codeResult.error : "unknown") } };
  }

  // Write code + source under lock
  withWriteLock_("AMENITY_CONFIRM_CODE_WRITE", () => {
    if (map["AccessCodeSnapshot"]) sheet.getRange(rowNum, map["AccessCodeSnapshot"]).setValue(String(codeResult.code || ""));
    if (map["AccessCode"]) sheet.getRange(rowNum, map["AccessCode"]).setValue(String(codeResult.code || ""));
    if (map["SeamCodeID"]) sheet.getRange(rowNum, map["SeamCodeID"]).setValue(String(codeResult.seamCodeId || ""));
    if (map["CodeSource"]) sheet.getRange(rowNum, map["CodeSource"]).setValue(String(codeResult.source || "none"));
    // Keep RESERVED here; lifecycle moves to ACTIVE at start
    sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.RESERVED);
    if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
  });

  try { clearAmenityHoldCache_(ph); } catch (_) {}

  const label = amenity ? (String(amenity.AmenityName || "") + " (" + String(amenity.PropertyCode || "") + ")") : amenityKey;

  return {
    ok: true,
    replyKey: "AMENITY_CONFIRMED",
    vars: {
      bookingId: bookingId,
      amenityKey: amenityKey,
      amenityLabel: label,
      window: formatWindowLabel_(start, end),
      code: String(codeResult.code || ""),
      codeSource: String(codeResult.source || "none")
    }
  };
}

// ---------------------------------------------
// CANCEL / LIST / RESCHEDULE (uses BookingID + StartDateTime preferred)
// ---------------------------------------------
function listUpcomingAmenityReservations_(phone, limit) {
  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));

  const kPhone = idx["Phone"];
  const kStatus = idx["Status"];
  const kAmenity = idx["AmenityKey"];
  const kBooking = idx["BookingID"];
  const kResId = idx["ResId"];

  const kStartDT = idx["StartDateTime"];
  const kEndDT = idx["EndDateTime"];
  const kStart = idx["Start"];
  const kEnd = idx["End"];

  const target = normalizePhoneKey_(phone);
  const now = Date.now();

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    if (normalizePhoneKey_(values[r][kPhone]) !== target) continue;

    const st = String(values[r][kStatus] || "").trim().toUpperCase();
    if (st !== AMENITY_STATUS.RESERVED && st !== AMENITY_STATUS.ACTIVE && st !== "CONFIRMED") continue;

    const start = (kStartDT != null && values[r][kStartDT]) ? toDate_(values[r][kStartDT]) : toDate_(values[r][kStart]);
    const end = (kEndDT != null && values[r][kEndDT]) ? toDate_(values[r][kEndDT]) : toDate_(values[r][kEnd]);
    if (!start || !end) continue;

    if (start.getTime() < now) continue;

    const amenityKey = String(values[r][kAmenity] || "").trim();
    const amenity = getAmenityConfig_(amenityKey);
    const label = amenity ? (String(amenity.AmenityName || "") + " (" + String(amenity.PropertyCode || "") + ")") : amenityKey;

    const bookingId = (kBooking != null) ? String(values[r][kBooking] || "").trim() : "";
    const resId = (kResId != null) ? String(values[r][kResId] || "").trim() : "";

    rows.push({
      bookingId: bookingId || resId,
      start: start,
      end: end,
      amenityLabel: label
    });
  }

  rows.sort((a, b) => a.start.getTime() - b.start.getTime());
  return rows.slice(0, Math.max(1, limit || 5));
}

function cancelUpcomingAmenityReservation_(phone) {
  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));

  const kPhone = idx["Phone"];
  const kStatus = idx["Status"];
  const kAmenity = idx["AmenityKey"];
  const kBooking = idx["BookingID"];
  const kResId = idx["ResId"];
  const kSeam = idx["SeamCodeID"];
  const kCodeSource = idx["CodeSource"];
  const kRevokedAt = idx["CodeRevokedAt"];

  const kStartDT = idx["StartDateTime"];
  const kEndDT = idx["EndDateTime"];
  const kStart = idx["Start"];
  const kEnd = idx["End"];

  const target = normalizePhoneKey_(phone);
  const now = Date.now();

  let bestRow = 0;
  let bestStartMs = null;

  for (let r = 1; r < values.length; r++) {
    if (normalizePhoneKey_(values[r][kPhone]) !== target) continue;

    const st = String(values[r][kStatus] || "").trim().toUpperCase();
    if (st !== AMENITY_STATUS.RESERVED && st !== AMENITY_STATUS.HOLD && st !== "CONFIRMED") continue;

    const start = (kStartDT != null && values[r][kStartDT]) ? toDate_(values[r][kStartDT]) : toDate_(values[r][kStart]);
    const end = (kEndDT != null && values[r][kEndDT]) ? toDate_(values[r][kEndDT]) : toDate_(values[r][kEnd]);
    if (!start || !end) continue;

    if (start.getTime() < now) continue;

    const sm = start.getTime();
    if (!bestRow || sm < bestStartMs) {
      bestRow = r + 1;
      bestStartMs = sm;
    }
  }

  if (!bestRow) return null;

  const map = getAmenityHeaderMap_(sheet);

  withWriteLock_("AMENITY_CANCEL", () => {
    sheet.getRange(bestRow, map["Status"]).setValue(AMENITY_STATUS.CANCELLED);
    if (map["CancelledAt"]) sheet.getRange(bestRow, map["CancelledAt"]).setValue(new Date());
    if (map["UpdatedAt"]) sheet.getRange(bestRow, map["UpdatedAt"]).setValue(new Date());
    if (map["ExpiresAt"]) sheet.getRange(bestRow, map["ExpiresAt"]).setValue(""); // clear hold expiry if any
  });

  const row = values[bestRow - 1];

  const amenityKey = String(row[kAmenity] || "").trim();
  const amenity = getAmenityConfig_(amenityKey);
  const label = amenity ? (String(amenity.AmenityName || "") + " (" + String(amenity.PropertyCode || "") + ")") : amenityKey;

  const start = (kStartDT != null && row[kStartDT]) ? toDate_(row[kStartDT]) : toDate_(row[kStart]);
  const end = (kEndDT != null && row[kEndDT]) ? toDate_(row[kEndDT]) : toDate_(row[kEnd]);

  const bookingId = (kBooking != null) ? String(row[kBooking] || "").trim() : "";
  const resId = (kResId != null) ? String(row[kResId] || "").trim() : "";

  return {
    bookingId: bookingId || resId,
    amenityKey: amenityKey,
    amenityLabel: label,
    start: start,
    end: end,
    seamCodeId: (kSeam != null) ? String(row[kSeam] || "") : "",
    codeSource: (kCodeSource != null) ? String(row[kCodeSource] || "") : "",
    codeRevokedAt: (kRevokedAt != null) ? row[kRevokedAt] : null
  };
}

function rescheduleBestAmenityReservation_(phone, newStart, newEnd) {
  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: false, msg: "no_reservations" };

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));

  const kPhone = idx["Phone"];
  const kStatus = idx["Status"];
  const kAmenity = idx["AmenityKey"];
  const kBooking = idx["BookingID"];
  const kResId = idx["ResId"];

  const kStartDT = idx["StartDateTime"];
  const kEndDT = idx["EndDateTime"];
  const kStart = idx["Start"];
  const kEnd = idx["End"];

  const target = normalizePhoneKey_(phone);
  const now = Date.now();

  let bestRow = 0;
  let bestStartMs = null;
  let bestIsUpcoming = false;

  for (let r = 1; r < values.length; r++) {
    if (normalizePhoneKey_(values[r][kPhone]) !== target) continue;

    const st = String(values[r][kStatus] || "").trim().toUpperCase();
    if (st !== AMENITY_STATUS.RESERVED && st !== "CONFIRMED") continue;

    const start = (kStartDT != null && values[r][kStartDT]) ? toDate_(values[r][kStartDT]) : toDate_(values[r][kStart]);
    if (!start) continue;

    const sm = start.getTime();
    const isUpcoming = sm >= now;

    if (!bestRow) { bestRow = r + 1; bestStartMs = sm; bestIsUpcoming = isUpcoming; continue; }

    if (isUpcoming && !bestIsUpcoming) { bestRow = r + 1; bestStartMs = sm; bestIsUpcoming = true; continue; }

    if (isUpcoming && bestIsUpcoming) { if (sm < bestStartMs) { bestRow = r + 1; bestStartMs = sm; } continue; }

    if (!isUpcoming && !bestIsUpcoming) { if (sm > bestStartMs) { bestRow = r + 1; bestStartMs = sm; } }
  }

  if (!bestRow) return { ok: false, msg: "no_reservations" };

  const row = values[bestRow - 1];
  const amenityKey = String(row[kAmenity] || "").trim();
  const amenity = getAmenityConfig_(amenityKey);
  if (!amenity || amenity.Active !== true) return { ok: false, msg: "amenity_not_available" };

  const end = newEnd || new Date(newStart.getTime() + 60 * 60 * 1000);
  const durHours = (end.getTime() - newStart.getTime()) / (60 * 60 * 1000);

  if (durHours <= 0) return { ok: false, msg: "invalid_window" };
  if (durHours > Number(amenity.MaxBlockHours || 4)) return { ok: false, msg: "too_long" };
  if (!isWithinHours_(newStart, end, amenity.OpenTime, amenity.CloseTime)) return { ok: false, msg: "outside_hours" };

  const bookingId = (kBooking != null) ? String(row[kBooking] || "").trim() : "";
  const resId = (kResId != null) ? String(row[kResId] || "").trim() : "";
  const ignoreId = (bookingId || resId);

  if (hasAmenityConflict_(amenityKey, newStart, end, ignoreId)) {
    return { ok: false, msg: "conflict" };
  }

  const map = getAmenityHeaderMap_(sheet);
  withWriteLock_("AMENITY_RESCHEDULE", () => {
    if (map["StartDateTime"]) sheet.getRange(bestRow, map["StartDateTime"]).setValue(newStart);
    if (map["EndDateTime"]) sheet.getRange(bestRow, map["EndDateTime"]).setValue(end);
    if (map["Start"]) sheet.getRange(bestRow, map["Start"]).setValue(newStart);
    if (map["End"]) sheet.getRange(bestRow, map["End"]).setValue(end);
    if (map["UpdatedAt"]) sheet.getRange(bestRow, map["UpdatedAt"]).setValue(new Date());
  });

  const label = String(amenity.AmenityName || "") + " (" + String(amenity.PropertyCode || "") + ")";
  return { ok: true, amenityLabel: label, start: newStart, end: end };
}

// ---------------------------------------------
// ACCESS PROVIDER ADAPTER (Seam + fallback, idempotent)
// Uses BookingID as lookup key.
// Writes AccessCode + SeamCodeID + CodeSource under lock.
// ---------------------------------------------
function accessProviderCreateAmenityCode_(reservation) {
  const bookingId = String(reservation.bookingId || "").trim();
  const amenityKey = String(reservation.amenityKey || "").trim();
  if (!bookingId || !amenityKey) return { success: false, error: "bad_args" };

  // 1) Idempotency: already has code?
  const existing = getReservationAccessState_(bookingId);
  if (existing && existing.code && existing.source !== "none" && existing.source !== "pending") {
    try { logDevSms_("(system)", "", "ACCESS_IDEMP booking=[" + bookingId + "] source=" + existing.source); } catch (_) {}
    return {
      success: true,
      seamCodeId: existing.seamCodeId || "",
      code: existing.code || "",
      source: existing.source || "none",
      isExisting: true
    };
  }

  // 2) Get amenity config
  const amenity = getAmenityConfig_(amenityKey);
  if (!amenity) return { success: false, error: "amenity_not_found" };

  // 3) Smart lock availability gate
  const useSmartLock = amenity.UseSmartLock === true || String(amenity.UseSmartLock || "").toUpperCase() === "TRUE";
  const deviceId = String(amenity.DeviceID || "").trim();
  const seamConfigured = isSeamConfigured_();

  if (!useSmartLock || !deviceId || !seamConfigured) {
    if (ACCESS_PROVIDER_CONFIG.FALLBACK_TO_STATIC) {
      const staticCode = getAmenityAccessCode_(amenityKey);
      withWriteLock_("ACCESS_STATIC_WRITE", () => {
        writeReservationAccessCode_(bookingId, { seamCodeId: "", code: staticCode, source: "static" });
      });
      return { success: true, seamCodeId: "", code: staticCode, source: "static" };
    }
    return { success: false, error: "smart_lock_unavailable" };
  }

  // 4) Mark pending (under lock)
  const pendingMarked = withWriteLock_("ACCESS_PENDING", () => markReservationCodePending_(bookingId));
  if (!pendingMarked) return { success: false, error: "could_not_mark_pending" };

  // 5) Create Seam code (outside lock)
  const unit = String(reservation.unit || "");
  const property = String(reservation.property || "");
  const codeName = (property ? property + "-" : "") + (unit || "UNIT") + "-" + bookingId;

  const seamResult = seamCreateAccessCodeWithRetry_({
    deviceId: deviceId,
    startsAt: reservation.start,
    endsAt: reservation.end,
    name: codeName
  });

  // 6) Write result (inside lock)
  if (seamResult && seamResult.seamCodeId) {
    withWriteLock_("ACCESS_SEAM_SUCCESS", () => {
      writeReservationAccessCode_(bookingId, {
        seamCodeId: seamResult.seamCodeId,
        code: seamResult.code,
        source: "seam"
      });
    });

    return { success: true, seamCodeId: seamResult.seamCodeId, code: seamResult.code, source: "seam" };
  }

  // Seam failed -> fallback
  if (ACCESS_PROVIDER_CONFIG.FALLBACK_TO_STATIC) {
    const staticCode = getAmenityAccessCode_(amenityKey);
    withWriteLock_("ACCESS_FALLBACK_STATIC", () => {
      writeReservationAccessCode_(bookingId, { seamCodeId: "", code: staticCode, source: "static" });
    });
    return { success: true, seamCodeId: "", code: staticCode, source: "static" };
  }

  return { success: false, error: "seam_failed_no_fallback" };
}

function accessProviderRevokeAmenityCode_(reservation) {
  const bookingId = String(reservation.bookingId || "").trim();
  const seamCodeId = String(reservation.seamCodeId || "").trim();
  const source = String(reservation.source || "").trim();

  if (!bookingId) return false;

  // idempotent
  if (reservation.codeRevokedAt) return true;

  if (source !== "seam" || !seamCodeId) {
    withWriteLock_("ACCESS_REVOKE_STATIC", () => markReservationCodeRevoked_(bookingId));
    return true;
  }

  const deleted = seamDeleteAccessCode_(seamCodeId);

  withWriteLock_("ACCESS_REVOKE_SEAM", () => markReservationCodeRevoked_(bookingId));

  try { logDevSms_("(system)", "", "ACCESS_REVOKE booking=[" + bookingId + "] seamCodeId=[" + seamCodeId + "] deleted=" + deleted); } catch (_) {}

  return true;
}

// Reservation access helpers (sheet-backed)
function getReservationAccessState_(bookingId) {
  const bid = String(bookingId || "").trim();
  if (!bid) return null;

  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const row = amenityFindRowByValue_(sheet, "BookingID", bid);
  if (!row) return null;

  const map = getAmenityHeaderMap_(sheet);
  const data = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];

  const seamCodeId = map["SeamCodeID"] ? String(data[map["SeamCodeID"] - 1] || "") : "";
  const code =
    map["AccessCode"] ? String(data[map["AccessCode"] - 1] || "") :
    (map["AccessCodeSnapshot"] ? String(data[map["AccessCodeSnapshot"] - 1] || "") : "");

  const source = map["CodeSource"] ? String(data[map["CodeSource"] - 1] || "none") : "none";
  const revokedAt = map["CodeRevokedAt"] ? data[map["CodeRevokedAt"] - 1] : null;

  return { seamCodeId: seamCodeId, code: code, source: source, revokedAt: revokedAt };
}

function markReservationCodePending_(bookingId) {
  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const row = amenityFindRowByValue_(sheet, "BookingID", bookingId);
  if (!row) return false;

  const map = getAmenityHeaderMap_(sheet);
  if (!map["CodeSource"]) return true; // if missing, treat as ok

  sheet.getRange(row, map["CodeSource"]).setValue("pending");
  if (map["UpdatedAt"]) sheet.getRange(row, map["UpdatedAt"]).setValue(new Date());
  return true;
}

function writeReservationAccessCode_(bookingId, codeData) {
  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const row = amenityFindRowByValue_(sheet, "BookingID", bookingId);
  if (!row) return false;

  const map = getAmenityHeaderMap_(sheet);

  if (map["SeamCodeID"]) sheet.getRange(row, map["SeamCodeID"]).setValue(String(codeData.seamCodeId || ""));
  if (map["AccessCode"]) sheet.getRange(row, map["AccessCode"]).setValue(String(codeData.code || ""));
  if (map["AccessCodeSnapshot"]) sheet.getRange(row, map["AccessCodeSnapshot"]).setValue(String(codeData.code || ""));
  if (map["CodeSource"]) sheet.getRange(row, map["CodeSource"]).setValue(String(codeData.source || "none"));
  if (map["UpdatedAt"]) sheet.getRange(row, map["UpdatedAt"]).setValue(new Date());

  return true;
}

function markReservationCodeRevoked_(bookingId) {
  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const row = amenityFindRowByValue_(sheet, "BookingID", bookingId);
  if (!row) return false;

  const map = getAmenityHeaderMap_(sheet);

  if (map["CodeRevokedAt"]) {
    const existing = sheet.getRange(row, map["CodeRevokedAt"]).getValue();
    if (!existing) sheet.getRange(row, map["CodeRevokedAt"]).setValue(new Date());
  }
  if (map["UpdatedAt"]) sheet.getRange(row, map["UpdatedAt"]).setValue(new Date());

  return true;
}

// ---------------------------------------------
// SEAM API CLIENT (retry/backoff)
// ---------------------------------------------
function seamApiRequest_(endpoint, method, payload) {
  const apiKey = getSeamApiKey_();
  if (!apiKey) return null;

  const url = "https://connect.getseam.com" + endpoint;

  const baseOptions = {
    method: String(method || "GET").toLowerCase(),
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      "Seam-SDK-Name": "propera-compass",
      "Seam-SDK-Version": "1.0.0"
    },
    muteHttpExceptions: true,
    validateHttpsCertificates: true
  };

  if (payload && (method === "POST" || method === "PUT" || method === "PATCH")) {
    baseOptions.payload = JSON.stringify(payload);
  }

  const maxAttempts = Number(ACCESS_PROVIDER_CONFIG.MAX_RETRY_ATTEMPTS || 0) + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(url, baseOptions);
      const code = resp.getResponseCode();
      const body = resp.getContentText();

      if (code >= 200 && code < 300) {
        try { return JSON.parse(body); } catch (_) { return null; }
      }

      const shouldRetry = ACCESS_PROVIDER_CONFIG.RETRY_ON_CODES.indexOf(code) >= 0;
      if (shouldRetry && attempt < maxAttempts) {
        const backoffMs = ACCESS_PROVIDER_CONFIG.RETRY_BACKOFF_MS[attempt - 1] || 750;
        Utilities.sleep(backoffMs);
        continue;
      }

      return null;
    } catch (err) {
      if (attempt < maxAttempts) {
        const backoffMs = ACCESS_PROVIDER_CONFIG.RETRY_BACKOFF_MS[attempt - 1] || 750;
        Utilities.sleep(backoffMs);
        continue;
      }
      return null;
    }
  }
  return null;
}

function seamCreateAccessCodeWithRetry_(opts) {
  if (!opts || !opts.deviceId || !opts.startsAt || !opts.endsAt) return null;

  const startsAtISO = new Date(opts.startsAt).toISOString();
  const endsAtISO = new Date(opts.endsAt).toISOString();

  const payload = {
    device_id: String(opts.deviceId),
    name: String(opts.name || "Amenity Access"),
    starts_at: startsAtISO,
    ends_at: endsAtISO,
    code_type: "time_bound",
    prefer_native_scheduling: true
  };

  const response = seamApiRequest_("/access_codes/create", "POST", payload);
  if (!response || !response.access_code) return null;

  const ac = response.access_code;
  return {
    seamCodeId: String(ac.access_code_id || ""),
    code: String(ac.code || ""),
    deviceId: String(ac.device_id || "")
  };
}

function seamDeleteAccessCode_(seamCodeId) {
  if (!isSeamConfigured_() || !seamCodeId) return false;

  const payload = { access_code_id: String(seamCodeId) };
  const response = seamApiRequest_("/access_codes/delete", "POST", payload);

  // treat ok/action_attempt as success-ish
  return !!(response && (response.ok === true || response.action_attempt));
}

function isSeamConfigured_() {
  return !!getSeamApiKey_();
}

function getSeamApiKey_() {
  try {
    const key = PropertiesService.getScriptProperties().getProperty("SEAM_API_KEY");
    return key ? String(key).trim() : null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// PHASE 7 — From PROPERA MAIN: router detector, AmenityDirectory, sheet
// header/row helpers (getAmenityHeaderMap_/amenityFindRowByValue_), hold
// cache + clear, bounded lifecycle processor, template-key notifications.
// ─────────────────────────────────────────────────────────────────

/************************************
* AMENITY RESERVATION ENGINE (PRODUCTION-LINE, COMPASS-BRIDGE)
* - Command-first routing (no keyword-noise)
* - TemplateKey-only messaging via amenityReplyKey_ -> renderTenantKey_ -> sendRouterSms_
* - HOLD -> RESERVED -> ACTIVE -> EXPIRED lifecycle
* - Access provider adapter (Seam + fallback) with idempotency
* - Uses StartDateTime/EndDateTime when available (fallback Start/End)
* - Uses BookingID as canonical id (fallback ResId)
* - Uses withWriteLock_ for ALL writes
*
* REQUIRED EXISTING FUNCTIONS (from your core):
* - withWriteLock_(tag, fn)
* - getSheet_(name)
* - renderTenantKey_(key, lang, vars)
* - sendRouterSms_(to, msg, tag)
* - ctxGet_(phone)
* - ctxUpsert_(phone, patch)
* - logDevSms_(from, body, note)  (optional but recommended)
*
* REQUIRED SHEETS:
* - AMENITY_RES_SHEET_NAME (AmenityReservations)
* - AMENITIES_SHEET_NAME   (Amenities)
* - AMENITY_DIR_SHEET_NAME (AmenityDirectory)  (optional legacy support)
************************************/

// ---------------------------------------------
// ROUTER DETECTOR (command-first + sticky + explicit confirm)
// Use this from your router if you want, but you already have router detectors.
// ---------------------------------------------
function looksLikeAmenityReservation_(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const bodyRaw = String(p.Body || "").trim();
  const s = bodyRaw.toLowerCase().trim();
  const from = String(p.From || "").trim();

  if (!from && !s) return false;

  // If confirming an existing hold, always route here
  if ((s === "yes" || s === "confirm" || s === "no") && from && getAmenityHoldCache_(from)) return true;

  // Explicit commands (no ambiguity)
  if (
    s === "help reservation" || s === "reservation help" || s === "help gameroom" ||
    s === "my reservations" || s.startsWith("my reservations") ||
    s.startsWith("cancel reservation") ||
    s.startsWith("change reservation") || s.startsWith("reschedule reservation")
  ) return true;

  // Sticky routing via cache OR AmenityDirectory stage OR ctx.pendingExpected
  if (from && getAmenityStageCache_(from)) return true;

  try {
    const ctx = ctxGet_(from);
    if (isAmenityExpected_(ctx)) return true;
  } catch (_) {}

  try {
    if (from) {
      const dir = getAmenityDir_(from);
      if (dir && String(dir.Stage || "").trim()) return true;
    }
  } catch (_) {}

  if (!s) return false;

  // Start intent (kept narrow; do NOT hijack random time strings)
  const mentionsAmenity =
    s.indexOf("gameroom") >= 0 || s.indexOf("game room") >= 0 || s.indexOf("game-room") >= 0 ||
    s.indexOf("terrace") >= 0 || s.indexOf("party") >= 0;

  const mentionsReserve =
    s.indexOf("reserve") >= 0 || s.indexOf("reservation") >= 0 || s.indexOf("book") >= 0 || s.indexOf("booking") >= 0;

  return (mentionsAmenity || mentionsReserve);
}

function isAmenityExpected_(ctx) {
  try {
    const exp = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();
    if (exp.indexOf("AMENITY_") !== 0) return false;

    const ex = (ctx && ctx.pendingExpiresAt) ? new Date(ctx.pendingExpiresAt) : null;
    if (ex && isFinite(ex.getTime()) && Date.now() > ex.getTime()) return false;

    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------
// STICKY CACHE HELPERS (legacy) - get/safeGet stay for router
// ---------------------------------------------
function getAmenityStageCache_(phone) {
  const cache = CacheService.getScriptCache();
  return cache.get("amenity_stage_" + normalizePhoneKey_(phone));
}
function safeGetAmenityStage_(phone) {
  try {
    const d = getAmenityDir_(phone);
    return String((d && d.Stage) ? d.Stage : "").trim();
  } catch (_) {
    return "";
  }
}

// ---------------------------------------------
// PHONE NORMALIZER (shared)
// ---------------------------------------------
function normalizePhoneKey_(p) {
  const digits = String(p || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function parseMonthNameWindow_(s) {
  const now = new Date();
  const months = {
    jan:0,january:0, feb:1,february:1, mar:2,march:2, apr:3,april:3,
    may:4, jun:5,june:5, jul:6,july:6, aug:7,august:7,
    sep:8,september:8, oct:9,october:9, nov:10,november:10, dec:11,december:11
  };

  const re = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[\s,]+(\d{1,2})(?:[\s,]+(\d{4}))?[\s,]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const m = String(s || "").match(re);
  if (!m) return null;

  const mon = months[m[1].toLowerCase()];
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : now.getFullYear();

  let h1 = Number(m[4]), min1 = m[5] ? Number(m[5]) : 0, ap1 = m[6] ? m[6].toLowerCase() : "";
  let h2 = Number(m[7]), min2 = m[8] ? Number(m[8]) : 0, ap2 = m[9] ? m[9].toLowerCase() : "";

  if (!ap1 && ap2) ap1 = ap2;
  if (ap1 && !ap2) ap2 = ap1;

  if (!ap1 && !ap2) {
    if (h1 >= 1 && h1 <= 9) ap1 = "pm";
    if (h2 >= 1 && h2 <= 9) ap2 = "pm";
  }

  const start = new Date(year, mon, day, to24_(h1, ap1), min1, 0, 0);
  const end   = new Date(year, mon, day, to24_(h2, ap2), min2, 0, 0);

  if (!m[3] && start.getTime() < now.getTime() - 6 * 60 * 60 * 1000) {
    start.setFullYear(year + 1);
    end.setFullYear(year + 1);
  }

  return { start: start, end: end, kind: "monthname" };
}

function to24_(h, ap) {
  let hh = Number(h);
  const a = String(ap || "").toLowerCase();
  if (a === "am") { if (hh === 12) hh = 0; }
  if (a === "pm") { if (hh !== 12) hh += 12; }
  return hh;
}

// ---------------------------------------------
// DIRECTORY (legacy; optional) - getAmenityDir_ stays for router
// ---------------------------------------------
function getAmenityDir_(phone) {
  const sheet = getSheet_(AMENITY_DIR_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { Phone: phone, Stage: "", AmenityKey: "", TempStart: "", TempEnd: "" };

  const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const idx = indexMap_(values[0].map(String));

  const kPhone = idx["Phone"];
  for (let r = 1; r < values.length; r++) {
    if (normalizePhoneKey_(values[r][kPhone]) === normalizePhoneKey_(phone)) {
      return {
        Phone: phone,
        Stage: String(values[r][idx["Stage"]] || "").trim(),
        AmenityKey: String(values[r][idx["AmenityKey"]] || "").trim(),
        TempStart: values[r][idx["TempStart"]],
        TempEnd: values[r][idx["TempEnd"]]
      };
    }
  }
  return { Phone: phone, Stage: "", AmenityKey: "", TempStart: "", TempEnd: "" };
}

// 1-based map (for range writes)
function getAmenityHeaderMap_(sheet) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  for (let i = 0; i < header.length; i++) {
    const k = String(header[i] || "").trim();
    if (k) map[k] = i + 1;
  }
  return map;
}

function amenityFindRowByValue_(sheet, colName, value) {
  const v = String(value || "").trim();
  if (!v) return 0;

  const map = getAmenityHeaderMap_(sheet);
  const col = map[String(colName || "").trim()];
  if (!col) return 0;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const vals = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "").trim() === v) return i + 2;
  }
  return 0;
}

// ---------------------------------------------
// HOLD CACHE (trio stays for router)
// ---------------------------------------------
function setAmenityHoldCache_(phone, obj) {
  const cache = CacheService.getScriptCache();
  cache.put("amenity_hold_" + normalizePhoneKey_(phone), JSON.stringify(obj || {}), AMENITY_HOLD_SECONDS);
}
function getAmenityHoldCache_(phone) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get("amenity_hold_" + normalizePhoneKey_(phone));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function clearAmenityHoldCache_(phone) {
  const cache = CacheService.getScriptCache();
  cache.remove("amenity_hold_" + normalizePhoneKey_(phone));
}

// ---------------------------------------------
// LIFECYCLE PROCESSOR (bounded + safe)
// - HOLD timeout -> CANCELLED
// - RESERVED -> ACTIVE at start
// - ACTIVE -> EXPIRED at end (revokes code)
// - Notifications are template-key only
// ---------------------------------------------
const AMENITY_LIFECYCLE_CONFIG = {
  MAX_ROWS_PER_RUN: 25
};

function processAmenityLifecycle() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const map = getAmenityHeaderMap_(sheet);
    if (!map["Status"] || !map["BookingID"] || !map["Phone"]) return;

    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const now = Date.now();

    let processed = 0;

    for (let i = 0; i < data.length && processed < AMENITY_LIFECYCLE_CONFIG.MAX_ROWS_PER_RUN; i++) {
      const rowNum = i + 2;
      const row = data[i];

      const bookingId = String(row[map["BookingID"] - 1] || "").trim();
      const status = String(row[map["Status"] - 1] || "").trim().toUpperCase();
      const phone = String(row[map["Phone"] - 1] || "").trim();

      const startD = map["StartDateTime"] ? toDate_(row[map["StartDateTime"] - 1]) : (map["Start"] ? toDate_(row[map["Start"] - 1]) : null);
      const endD = map["EndDateTime"] ? toDate_(row[map["EndDateTime"] - 1]) : (map["End"] ? toDate_(row[map["End"] - 1]) : null);
      if (!bookingId || !startD || !endD) continue;

      const startMs = startD.getTime();
      const endMs = endD.getTime();

      // HOLD -> CANCELLED on expiry
      if (status === AMENITY_STATUS.HOLD && map["ExpiresAt"]) {
        const expD = toDate_(row[map["ExpiresAt"] - 1]);
        const expMs = expD ? expD.getTime() : NaN;
        if (isFinite(expMs) && now >= expMs) {
          withWriteLock_("AMEN_LIFE_HOLD_EXPIRE", () => {
            sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.CANCELLED);
            if (map["CancelledAt"]) sheet.getRange(rowNum, map["CancelledAt"]).setValue(new Date());
            if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
            if (map["CodeSource"]) sheet.getRange(rowNum, map["CodeSource"]).setValue("none");
          });
          processed++;
          continue;
        }
      }

      // RESERVED -> ACTIVE at start time (only if within window)
      if (status === AMENITY_STATUS.RESERVED) {
        if (now >= startMs && now < endMs) {
          withWriteLock_("AMEN_LIFE_ACTIVATE", () => {
            sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.ACTIVE);
            if (map["ActivatedAt"]) sheet.getRange(rowNum, map["ActivatedAt"]).setValue(new Date());
            if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
          });

          // Notify activation once
          if (map["NotifyActivatedAt"] && !row[map["NotifyActivatedAt"] - 1] && phone) {
            queueAmenityNotification_(bookingId, phone, "ACTIVATED");
            withWriteLock_("AMEN_LIFE_MARK_NOTIF_ACT", () => {
              sheet.getRange(rowNum, map["NotifyActivatedAt"]).setValue(new Date());
              if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
            });
          }

          processed++;
          continue;
        }
      }

      // ACTIVE -> EXPIRED at end time
      if (status === AMENITY_STATUS.ACTIVE) {
        if (now >= endMs) {
          // Revoke code (best effort)
          const seamCodeId = map["SeamCodeID"] ? String(row[map["SeamCodeID"] - 1] || "") : "";
          const codeSource = map["CodeSource"] ? String(row[map["CodeSource"] - 1] || "") : "";
          const revokedAt = map["CodeRevokedAt"] ? row[map["CodeRevokedAt"] - 1] : null;

          try {
            accessProviderRevokeAmenityCode_({
              bookingId: bookingId,
              seamCodeId: seamCodeId,
              source: codeSource,
              codeRevokedAt: revokedAt
            });
          } catch (_) {}

          withWriteLock_("AMEN_LIFE_EXPIRE", () => {
            sheet.getRange(rowNum, map["Status"]).setValue(AMENITY_STATUS.EXPIRED);
            if (map["ExpiredAt"]) sheet.getRange(rowNum, map["ExpiredAt"]).setValue(new Date());
            if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
          });

          // Notify end once
          if (map["NotifyEndedAt"] && !row[map["NotifyEndedAt"] - 1] && phone) {
            queueAmenityNotification_(bookingId, phone, "ENDED");
            withWriteLock_("AMEN_LIFE_MARK_NOTIF_END", () => {
              sheet.getRange(rowNum, map["NotifyEndedAt"]).setValue(new Date());
              if (map["UpdatedAt"]) sheet.getRange(rowNum, map["UpdatedAt"]).setValue(new Date());
            });
          }

          processed++;
          continue;
        }
      }
    }
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ---------------------------------------------
// NOTIFICATIONS (template-key only)
// ---------------------------------------------
function queueAmenityNotification_(bookingId, phone, eventType) {
  const bid = String(bookingId || "").trim();
  const ph = String(phone || "").trim();
  if (!bid || !ph) return;

  // Determine lang from ctx
  let lang = "en";
  try { lang = amenityGetLang_(ctxGet_(ph)); } catch (_) {}

  const sheet = getSheet_(AMENITY_RES_SHEET_NAME);
  const rowNum = amenityFindRowByValue_(sheet, "BookingID", bid);
  if (!rowNum) return;

  const map = getAmenityHeaderMap_(sheet);
  const data = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];

  const amenityKey = map["AmenityKey"] ? String(data[map["AmenityKey"] - 1] || "").trim() : "";
  const start = (map["StartDateTime"] ? toDate_(data[map["StartDateTime"] - 1]) : null) || (map["Start"] ? toDate_(data[map["Start"] - 1]) : null);
  const end = (map["EndDateTime"] ? toDate_(data[map["EndDateTime"] - 1]) : null) || (map["End"] ? toDate_(data[map["End"] - 1]) : null);

  const amenity = getAmenityConfig_(amenityKey);
  const label = amenity ? (String(amenity.AmenityName || "") + " (" + String(amenity.PropertyCode || "") + ")") : (amenityKey || "Amenity");

  const code =
    (map["AccessCode"] ? String(data[map["AccessCode"] - 1] || "").trim() : "") ||
    (map["AccessCodeSnapshot"] ? String(data[map["AccessCodeSnapshot"] - 1] || "").trim() : "") ||
    getAmenityAccessCode_(amenityKey);

  if (eventType === "ACTIVATED") {
    return amenityReplyKey_(ph, lang, "AMENITY_ACTIVE_NOW", {
      amenityLabel: label,
      window: (start && end) ? formatWindowLabel_(start, end) : "",
      code: code
    }, "AMENITY_ACTIVATED");
  }

  if (eventType === "ENDED") {
    return amenityReplyKey_(ph, lang, "AMENITY_ENDED", {
      amenityLabel: label
    }, "AMENITY_ENDED");
  }
}


// ---------------------------------------------
// GLOBAL CLEANUP
// ---------------------------------------------
function endAmenityFlow_(phone) {
  const ph = String(phone || "").trim();
  if (!ph) return;
  try { clearAmenityHoldCache_(ph); } catch (_) {}
  try { clearAmenityStageCache_(ph); } catch (_) {}
  try { clearAmenityDir_(ph); } catch (_) {}
}


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// Amenity command detectors
// ─────────────────────────────────────────────────────────────────



  function hasActiveAmenityFlow_(phone) {
    // Sticky routing via cache OR AmenityDirectory
    if (getAmenityStageCache_(phone)) return true;
    try {
      const dir = getAmenityDir_(phone);
      return !!String(dir && dir.Stage ? dir.Stage : "").trim();
    } catch (_) {
      return false;
    }
  }




  function isAmenityCommand_(s) {
    // Commands we WILL support (explicit)
    // - RESERVE GAMEROOM <time>
    // - CANCEL RESERVATION
    // - CHANGE RESERVATION <new time>
    // - HELP RESERVATION
    return (
      s.startsWith("reserve ") ||
      s === "reserve" ||
      s.startsWith("book ") ||
      s.startsWith("cancel reservation") ||
      s.startsWith("cancel booking") ||
      s.startsWith("change reservation") ||
      s.startsWith("change booking") ||
      s.startsWith("reschedule reservation") ||
      s.startsWith("help reservation") ||
      s.startsWith("reservation help") ||
      s.startsWith("my reservations")
    );
  }





  function looksLikeAmenityByKeywords_(s) {
    // Only used when there is no active flow and no explicit commands
    return (
      s.includes("gameroom") ||
      s.includes("game room") ||
      s.includes("game-room") ||
      s.includes("terrace") ||
      s.includes("party") ||
      s.includes("reservation") ||
      s.includes("book") ||
      s.includes("reserve")
    );
  }
