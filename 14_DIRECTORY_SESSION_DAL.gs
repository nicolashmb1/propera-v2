/**
 * DIRECTORY_SESSION_DAL.gs — Propera Directory, Session, Ctx, SMS entry
 *
 * OWNS:
 *   - isLangCode_, ctx get/upsert/sanitize, session phone normalization and session DAL
 *   - Work item sync from ticket row, wiTransition_, wiSetWaitTenant_, cloneEventWithBody_
 *   - Directory/tenant enrichment: enrichStaffCapTenantIdentity_, upsertTenant_, findTenantCandidates_, dal* cluster, ensureDirectoryRowForPhone_
 *   - Staff capture outbound helpers, template map + render, handleSms_ / handleSmsSafe_
 *
 * DOES NOT OWN:
 *   - M2 router (detectTenantCommand_, handleInboundRouter_) -> stays PROPERA MAIN.gs until ROUTER_ENGINE
 *   - Core orchestrator (classifyTenantSignals_, handleInboundCore_) -> CORE_ORCHESTRATOR.gs
 *
 * ENTRY POINTS:
 *   - ctxGet_(), ctxUpsert_(), sessionGet_(), sessionUpsert_(), dalWithLock_(), handleSmsSafe_()
 *
 * DEPENDENCIES:
 *   - Globals from PROPERA MAIN.gs shell (props, sheets ids, BRAND); functions in other files as called
 *
 * FUTURE MIGRATION NOTE:
 *   - Repository layer for directory + session; SMS entry becomes adapter boundary
 *
 * SECTIONS IN THIS FILE:
 *   1. Lang + ctx + session + work-item helpers
 *   2. Tenant directory, dal*, staff capture, templates, SMS handler
 */

// ─────────────────────────────────────────────────────────────────
// SESSION + CTX + WORK-ITEM HELPERS — phone keys, session rows, WI hooks
// ─────────────────────────────────────────────────────────────────
function isLangCode_(v) {
  const s = String(v || "").trim().toLowerCase();
  return (s === "en" || s === "es" || s === "pt" || s === "fr");
}

function sanitizeCtxPatch_(patch, phone, traceTag) {
  const out = Object.assign({}, patch || {});
  const badKeys = ["activeWorkItemId", "pendingWorkItemId"];

  for (let i = 0; i < badKeys.length; i++) {
    const k = badKeys[i];
    if (k in out) {
      const v = out[k];
      if (isLangCode_(v)) {
        // Tripwire log so we can find the caller later
        try { logDevSms_(phone, "", "CTX_SANITIZE blocked " + k + "=[" + v + "] tag=" + String(traceTag || "")); } catch (_) {}
        out[k] = ""; // prevent poisoning
      }
    }
  }

  // Optional: also block ridiculously short workItemIds (defensive)
  if ("activeWorkItemId" in out) {
    const s = String(out.activeWorkItemId || "").trim();
    if (s && s.length < 6) out.activeWorkItemId = "";
  }
  if ("pendingWorkItemId" in out) {
    const s = String(out.pendingWorkItemId || "").trim();
    if (s && s.length < 6) out.pendingWorkItemId = "";
  }

  return out;
}


function ctxGet_(phoneAny) {
  ensureWorkBackbone_();
  const phone = actorKey_(phoneAny);

  if (phone && __CTX_CACHE__.hasOwnProperty(phone)) return __CTX_CACHE__[phone];

  const sh = getActiveSheetByNameCached_(CTX_SHEET);

  if (!phone) {
    const out0 = {
      phoneE164: "",
      lang: "en",
      activeWorkItemId: "",
      pendingWorkItemId: "",
      pendingExpected: "",
      pendingExpiresAt: "",
      lastIntent: "",
      preferredChannel: "",
      telegramChatId: "",
      lastActorKey: "",
      lastInboundAt: ""
    };
    return out0;
  }

  const r = findRowByValue_(sh, "PhoneE164", phone);
  if (!r) {
    const out1 = {
      phoneE164: phone,
      lang: "en",
      activeWorkItemId: "",
      pendingWorkItemId: "",
      pendingExpected: "",
      pendingExpiresAt: "",
      lastIntent: "",
      preferredChannel: "",
      telegramChatId: "",
      lastActorKey: "",
      lastInboundAt: ""
    };
    __CTX_CACHE__[phone] = out1;
    return out1;
  }

  const map = getHeaderMap_(sh);
  const vals = sh.getRange(r, 1, 1, sh.getLastColumn()).getValues()[0];
  var prefCh = map["PreferredChannel"] ? String(vals[map["PreferredChannel"] - 1] || "").trim() : "";
  var tgChat = map["TelegramChatId"] ? String(vals[map["TelegramChatId"] - 1] || "").trim() : "";
  var lastActorKey = map["LastActorKey"] ? String(vals[map["LastActorKey"] - 1] || "").trim() : "";
  var lastInboundAt = map["LastInboundAt"] ? String(vals[map["LastInboundAt"] - 1] || "").trim() : "";

  const out = {
    row: r,
    phoneE164: String(vals[(map["PhoneE164"] || 1) - 1] || phone),
    lang: String(vals[(map["Lang"] || 8) - 1] || "en") || "en",
    activeWorkItemId: String(vals[(map["ActiveWorkItemId"] || 2) - 1] || ""),
    pendingWorkItemId: String(vals[(map["PendingWorkItemId"] || 3) - 1] || ""),
    pendingExpected: String(vals[(map["PendingExpected"] || 4) - 1] || ""),
    pendingExpiresAt: vals[(map["PendingExpiresAt"] || 5) - 1] || "",
    lastIntent: String(vals[(map["LastIntent"] || 6) - 1] || ""),
    preferredChannel: prefCh,
    telegramChatId: tgChat,
    lastActorKey: lastActorKey,
    lastInboundAt: lastInboundAt
  };

  __CTX_CACHE__[phone] = out;
  return out;
}


function ctxUpsert_(phoneAny, patch, traceTag) {
  ensureWorkBackbone_();

  const sh = getActiveSheetByNameCached_(CTX_SHEET);
  const phone = actorKey_(phoneAny);
  if (!phone) return false;

  try {
    const p = actorKey_(phoneAny || phone || "");
    if (p && __CTX_CACHE__) delete __CTX_CACHE__[p];
  } catch (_) {}

  const clean = sanitizeCtxPatch_(patch, phone, traceTag || "CTX_UPSERT");

  // ------------------------------------------------
  // SAFETY: only TENANT phones may set pending stage
  // ------------------------------------------------
  try {
    const isPendingWrite =
      ("pendingExpected" in clean) ||
      ("pendingExpiresAt" in clean) ||
      ("pendingWorkItemId" in clean);

    if (isPendingWrite) {
      if (typeof isManager_ === "function" && isManager_(phone)) {
        logDevSms_(phone, "", "CTX_BLOCK manager_pending");
        return false;
      }
      if (typeof isVendor_ === "function" && isVendor_(phone)) {
        logDevSms_(phone, "", "CTX_BLOCK vendor_pending");
        return false;
      }
    }
  } catch (_) {}

  withWriteLock_("CTX_UPSERT", () => {
    let r = findRowByValue_(sh, "PhoneE164", phone);

    if (!r) {
      sh.appendRow([phone, "", "", "", "", "", new Date(), "en"]);
      r = sh.getLastRow();
    }

    if (clean.activeWorkItemId !== undefined)
      sh.getRange(r, col_(sh, "ActiveWorkItemId")).setValue(String(clean.activeWorkItemId || ""));

    if (clean.pendingWorkItemId !== undefined)
      sh.getRange(r, col_(sh, "PendingWorkItemId")).setValue(String(clean.pendingWorkItemId || ""));

    if (clean.pendingExpected !== undefined)
      sh.getRange(r, col_(sh, "PendingExpected")).setValue(String(clean.pendingExpected || ""));

    if (clean.pendingExpiresAt !== undefined)
      sh.getRange(r, col_(sh, "PendingExpiresAt")).setValue(clean.pendingExpiresAt || "");

    if (clean.lastIntent !== undefined)
      sh.getRange(r, col_(sh, "LastIntent")).setValue(String(clean.lastIntent || ""));

    if (clean.lang !== undefined)
      sh.getRange(r, col_(sh, "Lang")).setValue(String(clean.lang || "en"));

    const ctxMap = getHeaderMap_(sh);
    if (clean.preferredChannel !== undefined && ctxMap["PreferredChannel"])
      sh.getRange(r, ctxMap["PreferredChannel"]).setValue(String(clean.preferredChannel || "").trim());
    if (clean.telegramChatId !== undefined && ctxMap["TelegramChatId"])
      sh.getRange(r, ctxMap["TelegramChatId"]).setValue(String(clean.telegramChatId || "").trim());
    if (clean.lastActorKey !== undefined && ctxMap["LastActorKey"])
      sh.getRange(r, ctxMap["LastActorKey"]).setValue(String(clean.lastActorKey || "").trim());
    if (clean.lastInboundAt !== undefined && ctxMap["LastInboundAt"])
      sh.getRange(r, ctxMap["LastInboundAt"]).setValue(String(clean.lastInboundAt || "").trim());

    sh.getRange(r, col_(sh, "UpdatedAt")).setValue(new Date());
  });

  return true;
}

// ============================================================
// SESSION DAL (Propera Compass — pre-ticket source of truth)
// Sessions sheet (16 cols): Phone, SessionId, Lane, State, Expected, Intent, Draft, Drafunit, DraftIssue, IssueBufJson, DraftScheduleRaw, ActiveArtifactKey, LastPromptKey, ExpiresAtIso, UnlinkedMediaJson, UpdatedAtIso
// One row per phone; use normalizeSessionPhoneKey_ for lookup.
// ============================================================

var SESSION_COL = {
  PHONE: 1,
  SESSION_ID: 2,
  LANE: 3,
  STATE: 4,
  EXPECTED: 5,
  INTENT: 6,
  DRAFT: 7,
  DRAFT_UNIT: 8,
  DRAFT_ISSUE: 9,
  ISSUE_BUF_JSON: 10,
  DRAFT_SCHEDULE_RAW: 11,
  ACTIVE_ARTIFACT_KEY: 12,
  LAST_PROMPT_KEY: 13,
  EXPIRES_AT_ISO: 14,
  UNLINKED_MEDIA_JSON: 15, // ✅ new
  UPDATED_AT_ISO: 16       // ✅ shifted
};

function normalizeSessionPhoneKey_(phone) {
  var s = String(phone || "").trim();
  if (s.indexOf("+") === 0) s = s.slice(1).trim();
  return s;
}

// Blank UpdatedAtIso sorts as oldest (so "newest" selection is consistent).
var SESSION_OLDEST_ISO = "1970-01-01T00:00:00.000Z";
function sessionUpdatedAtForSort_(iso) {
  var s = String(iso || "").trim();
  return s || SESSION_OLDEST_ISO;
}

// Mergeable columns (for dedupe): State, Expected, Lane, Draft, Drafunit, DraftIssue, IssueBufJson, DraftScheduleRaw, ActiveArtifactKey, ExpiresAtIso
var SESSION_MERGE_COLS = [SESSION_COL.STATE, SESSION_COL.EXPECTED, SESSION_COL.LANE, SESSION_COL.DRAFT, SESSION_COL.DRAFT_UNIT, SESSION_COL.DRAFT_ISSUE, SESSION_COL.ISSUE_BUF_JSON, SESSION_COL.DRAFT_SCHEDULE_RAW, SESSION_COL.ACTIVE_ARTIFACT_KEY, SESSION_COL.EXPIRES_AT_ISO];

// Scan Sessions sheet for rows where Phone (col 1) normalizes to phoneKey. Data rows = 2..lastRow (inclusive via numRows).
// Guard: lastRow < 2 => no getRange.
// Returns { matching: [ { row: number, updatedAtIso: string } ] }.
function sessionScanRowsByPhone_(sh, phoneKey) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { matching: [] };

  var numRows = lastRow - 1;
  var phones = sh.getRange(2, SESSION_COL.PHONE, numRows, 1).getValues();
  var updatedVals = sh.getRange(2, SESSION_COL.UPDATED_AT_ISO, numRows, 1).getValues();
  var matching = [];
  for (var i = 0; i < phones.length; i++) {
    var cellPhone = String(phones[i][0] || "").trim();
    if (normalizeSessionPhoneKey_(cellPhone) === phoneKey) {
      matching.push({
        row: i + 2,
        updatedAtIso: String(updatedVals[i] && updatedVals[i][0] != null ? updatedVals[i][0] : "").trim()
      });
    }
  }
  return { matching: matching };
}

// Pick the session row with newest UpdatedAtIso (primary). Merge non-empty fields from older rows into primary.
function sessionPickNewestAndMerge_(sh, matching) {
  if (!matching || matching.length === 0) return null;
  if (matching.length === 1) return matching[0].row;

  matching = matching.slice().sort(function (a, b) {
    return sessionUpdatedAtForSort_(b.updatedAtIso).localeCompare(sessionUpdatedAtForSort_(a.updatedAtIso), undefined, { numeric: false });
  });
  var primaryRow = matching[0].row;
  var lastCol = Math.max(sh.getLastColumn(), SESSION_COL.UPDATED_AT_ISO);
  var primaryVals = sh.getRange(primaryRow, 1, primaryRow, lastCol).getValues()[0];
  var merged = false;
  for (var o = 1; o < matching.length; o++) {
    var otherVals = sh.getRange(matching[o].row, 1, matching[o].row, lastCol).getValues()[0];
    for (var k = 0; k < SESSION_MERGE_COLS.length; k++) {
      var col = SESSION_MERGE_COLS[k];
      var primaryVal = String(primaryVals[col - 1] != null ? primaryVals[col - 1] : "").trim();
      var otherVal = String(otherVals[col - 1] != null ? otherVals[col - 1] : "").trim();
      if (!primaryVal && otherVal) {
        primaryVals[col - 1] = otherVal;
        merged = true;
      }
    }
  }
  if (merged) {
    for (var k = 0; k < SESSION_MERGE_COLS.length; k++) {
      var col = SESSION_MERGE_COLS[k];
      if (primaryVals[col - 1] != null) sh.getRange(primaryRow, col).setValue(primaryVals[col - 1]);
    }
  }
  return primaryRow;
}

function sessionGet_(phoneAny) {
  ensureWorkBackbone_();
  var phone = normalizeSessionPhoneKey_((typeof phoneKey_ === "function") ? phoneKey_(phoneAny) : phoneAny);
  if (!phone) return null;

  var sh = getActiveSheetByNameCached_(SESSIONS_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;

  var scan = sessionScanRowsByPhone_(sh, phone);
  var matching = scan.matching;

  var r = 0;
  if (matching.length === 0) return null;
  if (matching.length > 1) {
    try { logDevSms_(phone, "", "SESSION_DUPES_GET phone=[" + phone + "] rows=[" + matching.map(function (m) { return m.row; }).join(",") + "]"); } catch (_) {}
    matching = matching.slice().sort(function (a, b) {
      return sessionUpdatedAtForSort_(b.updatedAtIso).localeCompare(sessionUpdatedAtForSort_(a.updatedAtIso), undefined, { numeric: false });
    });
    r = matching[0].row;
  } else {
    r = matching[0].row;
  }

  var lastCol = Math.max(sh.getLastColumn(), SESSION_COL.UPDATED_AT_ISO);
  var vals = sh.getRange(r, 1, r, lastCol).getValues()[0];
  function v(col) { return vals[col - 1]; }
  var rawBuf = String(v(SESSION_COL.ISSUE_BUF_JSON) || "").trim();
  var buf = [];
  try { if (rawBuf) buf = JSON.parse(rawBuf); } catch (_) {}
  if (!Array.isArray(buf)) buf = [];

  return {
    phone: String(v(SESSION_COL.PHONE) || "").trim(),
    stage: String(v(SESSION_COL.STATE) || "").trim(),
    expected: String(v(SESSION_COL.EXPECTED) || "").trim(),
    lane: String(v(SESSION_COL.LANE) || "").trim(),
    draftProperty: String(v(SESSION_COL.DRAFT) || "").trim(),
    draftUnit: String(v(SESSION_COL.DRAFT_UNIT) || "").trim(),
    draftIssue: String(v(SESSION_COL.DRAFT_ISSUE) || "").trim(),
    issueBufJson: rawBuf,
    issueBuf: buf,
    draftScheduleRaw: String(v(SESSION_COL.DRAFT_SCHEDULE_RAW) || "").trim(),
    activeArtifactKey: String(v(SESSION_COL.ACTIVE_ARTIFACT_KEY) || "").trim(),
    expiresAtIso: String(v(SESSION_COL.EXPIRES_AT_ISO) || "").trim(),
    unlinkedMediaJson: String(v(SESSION_COL.UNLINKED_MEDIA_JSON) || "[]").trim(),
    updatedAtIso: String(v(SESSION_COL.UPDATED_AT_ISO) || "").trim(),
    row: r
  };
}

// No-lock variant: does Sessions sheet writes only. Call only when caller already holds a write lock (e.g. inside DRAFT_UPSERT).
function sessionUpsertNoLock_(phoneAny, patch, reason) {
  ensureWorkBackbone_();
  var phone = normalizeSessionPhoneKey_((typeof phoneKey_ === "function") ? phoneKey_(phoneAny) : phoneAny);
  if (!phone) return false;

  var nowIso = new Date().toISOString();
  var sh = getActiveSheetByNameCached_(SESSIONS_SHEET);
  if (!sh) return false;

  var scan = sessionScanRowsByPhone_(sh, phone);
  var matching = scan.matching;

  var r;
  if (matching.length === 0) {
    sh.appendRow([
      phone, "", "", "", "", "", "", "", "", "[]", "", "", "", "", "[]", nowIso
    ]);
    r = sh.getLastRow();
  } else if (matching.length === 1) {
    r = matching[0].row;
  } else {
    try { logDevSms_(phone, "", "SESSION_DUPES phone=[" + phone + "] rows=[" + matching.map(function (m) { return m.row; }).join(",") + "]"); } catch (_) {}
    r = sessionPickNewestAndMerge_(sh, matching);
    if (!r) r = matching[0].row;
    var extraRows = matching.filter(function (m) { return m.row !== r; }).map(function (m) { return m.row; }).sort(function (a, b) { return b - a; });
    for (var e = 0; e < extraRows.length; e++) {
      try { sh.deleteRow(extraRows[e]); } catch (_) {}
    }
    var scan2 = sessionScanRowsByPhone_(sh, phone);
    if (scan2.matching && scan2.matching.length >= 1) {
      r = scan2.matching.length === 1 ? scan2.matching[0].row : (scan2.matching.slice().sort(function (a, b) {
        return sessionUpdatedAtForSort_(b.updatedAtIso).localeCompare(sessionUpdatedAtForSort_(a.updatedAtIso), undefined, { numeric: false });
      })[0].row);
    }
  }

  function setVal(col, val) {
    if (col) sh.getRange(r, col).setValue(val != null ? val : "");
  }

  if (patch.stage !== undefined) setVal(SESSION_COL.STATE, String(patch.stage || "").trim());
  if (patch.expected !== undefined) setVal(SESSION_COL.EXPECTED, String(patch.expected || "").trim());
  if (patch.lane !== undefined) setVal(SESSION_COL.LANE, String(patch.lane || "").trim());
  if (patch.draftProperty !== undefined) setVal(SESSION_COL.DRAFT, String(patch.draftProperty || "").trim());
  if (patch.draftUnit !== undefined) setVal(SESSION_COL.DRAFT_UNIT, String(patch.draftUnit || "").trim());
  if (patch.draftIssue !== undefined) setVal(SESSION_COL.DRAFT_ISSUE, String(patch.draftIssue || "").trim());
  if (patch.issueBufJson !== undefined) setVal(SESSION_COL.ISSUE_BUF_JSON, typeof patch.issueBufJson === "string" ? patch.issueBufJson : (Array.isArray(patch.issueBufJson) ? JSON.stringify(patch.issueBufJson) : "[]"));
  if (patch.draftScheduleRaw !== undefined) setVal(SESSION_COL.DRAFT_SCHEDULE_RAW, String(patch.draftScheduleRaw || "").trim());
  if (patch.activeArtifactKey !== undefined) setVal(SESSION_COL.ACTIVE_ARTIFACT_KEY, String(patch.activeArtifactKey || "").trim());
  if (patch.expiresAtIso !== undefined) setVal(SESSION_COL.EXPIRES_AT_ISO, String(patch.expiresAtIso || "").trim());
  if (patch.unlinkedMediaJson !== undefined) setVal(
    SESSION_COL.UNLINKED_MEDIA_JSON,
    typeof patch.unlinkedMediaJson === "string"
      ? patch.unlinkedMediaJson
      : (Array.isArray(patch.unlinkedMediaJson) ? JSON.stringify(patch.unlinkedMediaJson) : "[]")
  );

  // Always write UpdatedAtIso on every upsert (unconditional)
  setVal(SESSION_COL.UPDATED_AT_ISO, nowIso);
  try { logDevSms_(phone, "", "SESSION_UPSERT reason=[" + String(reason || "") + "]"); } catch (_) {}
  return true;
}

function sessionUpsert_(phoneAny, patch, reason) {
  var phone = (typeof phoneKey_ === "function") ? phoneKey_(phoneAny) : String(phoneAny || "").trim();
  if (!phone) return false;
  withWriteLock_("SESSION_UPSERT", function () {
    sessionUpsertNoLock_(phone, patch, reason);
  });
  return true;
}

function getPropertyIdByCode_(propertyCode) {
  const code = String(propertyCode || "").trim();
  if (!code) return "";

  const sh = SpreadsheetApp.getActive().getSheetByName("Properties");
  if (!sh) return "";

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return "";

  const vals = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  // Columns:
  // A = PropertyID
  // B = PropertyCode
  // C = PropertyName

  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][1] || "").trim() === code) {
      return String(vals[i][0] || "").trim(); // PROP_*
    }
  }
  return "";
}

function syncActiveWorkItemFromTicketRow_(phoneAny, ticketRow, propertyCode, unit) {
  const phone = phoneKey_(phoneAny);
  if (!phone) return false;

  const ctx = ctxGet_(phone);
  const wi = ctx && ctx.activeWorkItemId ? String(ctx.activeWorkItemId) : "";
  if (!wi) return false;

  const pCode = String(propertyCode || "").trim();
  const u = String(unit || "").trim();

  const propertyId = getPropertyIdByCode_(pCode);
  const unitId = (pCode && u) ? (pCode + "-" + u) : "";

  return workItemUpdate_(wi, {
    propertyId: propertyId || "",
    unitId: unitId || "",
    ticketRow: (ticketRow && ticketRow > 1) ? Number(ticketRow) : ""
  });
}

// =============================================================================
//  HELPER: findWorkItemIdByTicketRow_
//  Looks up WorkItemId from the WorkItems sheet given a ticket sheet row number.
// =============================================================================
function findWorkItemIdByTicketRow_(ticketRow) {
  var row = Number(ticketRow || 0);
  if (row < 2) return "";

  try {
    var wiSh = SpreadsheetApp.getActive().getSheetByName(WORKITEMS_SHEET);
    if (!wiSh) return "";

    var wiLastRow = wiSh.getLastRow();
    if (wiLastRow < 2) return "";

    var wiMap = getHeaderMap_(wiSh);
    var trCol = (wiMap["TicketRow"] || 9) - 1;
    var idCol = (wiMap["WorkItemId"] || 1) - 1;

    var wiData = wiSh.getRange(2, 1, wiLastRow - 1, wiSh.getLastColumn()).getValues();
    for (var i = 0; i < wiData.length; i++) {
      if (Number(wiData[i][trCol]) === row) {
        return String(wiData[i][idCol] || "").trim();
      }
    }
  } catch (_) {}
  return "";
}

// =============================================================================
//  HELPER: wiTransition_
//  Generic WorkItem state+substate transition with a single deterministic log.
// =============================================================================
function wiTransition_(wiId, state, substate, phone, logTag) {
  var id = String(wiId || "").trim();
  if (!id) return false;

  var patch = { state: String(state || ""), substate: String(substate || "") };
  if (String(state || "").toUpperCase() === "DONE") patch.status = "COMPLETED";
  var ok = workItemUpdate_(id, patch);

  if (ok) {
    try {
      logDevSms_(
        String(phone || "(system)"),
        "",
        String(logTag || "WI_TRANSITION") +
          " wi=[" + id + "]" +
          " state=" + String(state || "") +
          " sub=" + String(substate || "")
      );
    } catch (_) {}
  }
  return ok;
}

// =============================================================================
//  HELPER: wiSetWaitTenant_
//  Finds the active WI for a phone (via ctx) and sets WAIT_TENANT + substate.
// =============================================================================
function wiSetWaitTenant_(phone, substate) {
  try {
    var ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
    if (!ctx) return false;

    var wi = String(ctx.pendingWorkItemId || ctx.activeWorkItemId || "").trim();
    if (!wi) return false;

    var ok = workItemUpdate_(wi, { state: "WAIT_TENANT", substate: String(substate || "") });
    if (ok) {
      try {
        logDevSms_(
          String(phone || ""),
          "",
          "WI_WAIT_TENANT wi=[" + wi + "] sub=" + String(substate || "")
        );
      } catch (_) {}
    }
    return ok;
  } catch (_) {}
  return false;
}

function renderKeyOrFallback_(key, lang, fallbackText) {
  try {
    var s = (typeof renderTenantKey_ === "function") ? renderTenantKey_(key, lang || "en", {}) : "";
    s = String(s || "").trim();
    // If key missing, some implementations return the key or empty.
    if (!s || s === key) return String(fallbackText || "").trim();
    return s;
  } catch (_) {
    return String(fallbackText || "").trim();
  }
}

function isDigitReply_(s, d) {
  var v = String(s || "").trim();
  return v === String(d);
}

function cloneEventWithBody_(e, newBody, opts) {
  opts = opts || {};
  const e2 = Object.assign({}, e || {});
  e2.parameter = Object.assign({}, (e && e.parameter) ? e.parameter : {});
  e2.parameter.Body = String(newBody || "");

  if (opts.mode) e2.parameter._mode = String(opts.mode);
  if (opts.internal === true) e2.parameter._internal = "1"; // sanctioned router injection
  if (opts.allowInternal === true) e2.parameter._allowInternal = "1";

  return e2;
}
// ─────────────────────────────────────────────────────────────────
// DIRECTORY DAL + STAFF CAPTURE + TEMPLATES + SMS ENTRY
// ─────────────────────────────────────────────────────────────────
function enrichStaffCapTenantIdentity_(sheet, loggedRow, workItemId, propName, unit, opts) {
  opts = opts || {};
  var tenantNameHint = String(opts.tenantNameHint || "").trim();
  var tenantNameTrusted = !!opts.tenantNameTrusted;
  var locationType = String((opts.locationType || "UNIT")).toUpperCase();

  function isRealPhone_(val) {
    var d = String(val || "").replace(/\D/g, "");
    return (d.length === 11 && d.charAt(0) === "1") || (d.length === 10);
  }

  if (!sheet || !loggedRow || loggedRow < 2) return;
  if (!workItemId) return;
  var pName = String(propName || "").trim();
  if (!pName) {
    if (typeof workItemUpdate_ === "function") {
      try {
        var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
        var meta = {};
        try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
        meta.tenantLookupStatus = "SKIPPED_NO_PROPERTY";
        workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
      } catch (_) {}
    }
    return;
  }
  var u = String(unit || "").trim();
  if (!u) {
    if (typeof workItemUpdate_ === "function") {
      try {
        var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
        var meta = {};
        try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
        meta.tenantLookupStatus = "SKIPPED_NO_UNIT";
        workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
      } catch (_) {}
    }
    return;
  }
  if (locationType === "COMMON_AREA") {
    if (typeof workItemUpdate_ === "function") {
      try {
        var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
        var meta = {};
        try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
        meta.tenantLookupStatus = "SKIPPED_COMMON_AREA";
        workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
      } catch (_) {}
    }
    return;
  }

  var ticketPhone = "";
  var wiPhone = "";
  try {
    if (typeof COL !== "undefined" && COL.PHONE && loggedRow <= sheet.getLastRow()) {
      ticketPhone = String(sheet.getRange(loggedRow, COL.PHONE).getValue() || "").trim();
    }
  } catch (_) {}
  if (isRealPhone_(ticketPhone)) {
    if (typeof workItemUpdate_ === "function") {
      try {
        var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
        var meta = {};
        try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
        meta.tenantLookupStatus = "SKIPPED_ALREADY_HAS_PHONE";
        workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
      } catch (_) {}
    }
    return;
  }
  try {
    var wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null;
    if (wi && wi.phoneE164 && isRealPhone_(wi.phoneE164)) {
      var meta = {};
      try { if (wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
      meta.tenantLookupStatus = "SKIPPED_ALREADY_HAS_PHONE";
      workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
      return;
    }
  } catch (_) {}

  var candidates = [];
  try {
    candidates = (typeof findTenantCandidates_ === "function") ? findTenantCandidates_(pName, u, tenantNameHint) : [];
  } catch (_) { candidates = []; }

  var status = "";
  var matchedPhone = null;
  var matchedName = null;

  if (tenantNameHint) {
    if (candidates.length !== 1 || !candidates[0] || (candidates[0].score || 0) < 85) {
      status = (candidates.length === 0) ? "NO_MATCH" : (candidates.length > 1) ? "AMBIGUOUS" : "SKIPPED_LOW_CONFIDENCE";
    } else {
      matchedPhone = candidates[0].phone;
      matchedName = candidates[0].name;
      status = "MATCHED";
    }
  } else {
    candidates = (typeof findTenantCandidates_ === "function") ? findTenantCandidates_(pName, u, "") : [];
    if (candidates.length !== 1 || !candidates[0]) {
      status = (candidates.length === 0) ? "NO_MATCH" : "AMBIGUOUS";
    } else {
      matchedPhone = candidates[0].phone;
      matchedName = candidates[0].name;
      status = "MATCHED";
    }
  }

  var wi = null;
  try { wi = (typeof workItemGetById_ === "function") ? workItemGetById_(workItemId) : null; } catch (_) {}
  var meta = {};
  try { if (wi && wi.metadataJson) meta = JSON.parse(wi.metadataJson); } catch (_) {}
  meta.tenantNameHint = tenantNameHint;
  meta.tenantNameTrusted = tenantNameTrusted;
  meta.tenantLookupStatus = status;
  if (matchedName != null) meta.tenantLookupMatchedName = matchedName;
  if (matchedPhone != null) meta.tenantLookupMatchedPhone = matchedPhone;

  if (status === "MATCHED" && matchedPhone && typeof workItemUpdate_ === "function") {
    var normPhone = (matchedPhone.indexOf("+1") === 0) ? matchedPhone : "+1" + String(matchedPhone).replace(/\D/g, "").slice(-10);
    try {
      withWriteLock_("STAFFCAP_TENANT_ENRICH", function () {
        if (typeof COL !== "undefined" && COL.PHONE && sheet && loggedRow >= 2 && loggedRow <= sheet.getLastRow()) {
          sheet.getRange(loggedRow, COL.PHONE).setValue(normPhone);
        }
      });
    } catch (_) {}
    try {
      workItemUpdate_(workItemId, { phoneE164: normPhone, metadataJson: JSON.stringify(meta) });
    } catch (_) {}
  } else {
    try {
      if (typeof workItemUpdate_ === "function") workItemUpdate_(workItemId, { metadataJson: JSON.stringify(meta) });
    } catch (_) {}
  }
}

function upsertTenant_(propertyName, unit, phone, name) {
  const sh = ensureTenantsSheet_();
  const p = String(propertyName || "").trim();
  const u = String(unit || "").trim().toUpperCase();
  const ph = normalizePhone_(phone || "");
  const nm = String(name || "").trim();

  if (!p || !u || !ph) return;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    sh.appendRow([p, u, ph, nm, new Date(), "", "Yes"]);
    return;
  }

  const data = sh.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < data.length; i++) {
    const rp = String(data[i][0] || "").trim();
    const ru = String(data[i][1] || "").trim().toUpperCase();
    const rph = normalizePhone_(data[i][2] || "");
    if (rp === p && ru === u && rph === ph) {
      // update name if blank, update UpdatedAt, set Active Yes
      if (!String(data[i][3] || "").trim() && nm) sh.getRange(i + 2, 4).setValue(nm);
      sh.getRange(i + 2, 5).setValue(new Date());
      sh.getRange(i + 2, 7).setValue("Yes");
      return;
    }
  }

  // not found -> create new row (supports multiple phones per unit)
  sh.appendRow([p, u, ph, nm, new Date(), "", "Yes"]);
}

function buildTicketList_(sheet, mode) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return "No tickets yet.";

  const nRows = lastRow - 1;
  const data = sheet.getRange(2, 1, nRows, COL.HANDOFF_SENT).getValues();


  const now = new Date();
  const out = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    const ticketId = String(row[COL.TICKET_ID - 1] || "").trim();
    const status = String(row[COL.STATUS - 1] || "").trim() || "New";
    const unit = String(row[COL.UNIT - 1] || "").trim() || "?";
    const lastUpdate = row[COL.LAST_UPDATE - 1];

    const isClosed = /^(closed|completed)$/i.test(status);

    if (mode === "open") {
      if (isClosed) continue;
    } else if (mode === "waiting") {
      if (isClosed) continue;
      if (!/^waiting\b/i.test(status)) continue;
    }

    // ID should always exist, but fallback if blank
    const ref = ticketId || "(no id)";

    // Age like: now / 12m / 3h / 2d / 1mo
    const age = (lastUpdate instanceof Date) ? formatAge_(now, lastUpdate) : "?";

    out.push(`• ${ref} | ${unit} | ${status} | ${age}`);

    if (out.length >= 12) break;
  }

  if (!out.length) {
    return mode === "waiting" ? "No waiting tickets right now." : "No open tickets right now.";
  }

  const title = (mode === "waiting") ? "LIST WAITING" : "LIST OPEN";
  return title + "\n" + "ID | Unit | Status | Age\n" + out.join("\n");
}

function formatAge_(now, then) {
  const ms = now - then;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "now";
  if (min < 60) return min + "m";

  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h";

  const day = Math.floor(hr / 24);
  if (day < 30) return day + "d";

  const mo = Math.floor(day / 30);
  return mo + "mo";
}


function fmtDateYYYYMMDD_(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function fmtDateMMDDYY_(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const yy = String(dt.getFullYear()).slice(-2);
  return `${mm}${dd}${yy}`;
}

function makeTicketId_(propertyNameOrCode, now, rowIndex) {
  const when = (now instanceof Date) ? now : new Date(now);

  const r = parseInt(rowIndex, 10);
  const suffix = (isFinite(r) && r >= 2) ? String(r).padStart(4, "0") : "0000";

  let prefix = "";
  try {
    const p = (typeof getPropertyByNameOrKeyword_ === "function")
      ? getPropertyByNameOrKeyword_(propertyNameOrCode)
      : null;

    // ✅ Prefer TicketPrefix column
    prefix = p && p.ticketPrefix ? String(p.ticketPrefix).trim().toUpperCase() : "";
    // Fallback: property code only if it's already a short prefix
    if (!prefix && p && p.code) prefix = String(p.code).trim().toUpperCase();
  } catch (_) {}

  // final guard: keep it strict
  if (!prefix || !/^[A-Z0-9]{3,5}$/.test(prefix)) prefix = "UNK";

  return `${prefix}-${fmtDateMMDDYY_(when)}-${suffix}`;
}


function computeDueBy_(now, classification) {
  const d = new Date(now);

  if (classification?.emergency) {
    d.setMinutes(d.getMinutes() + 30); // emergency due in 30 min
    return d;
  }
  if (classification?.urgency === "Urgent") {
    d.setHours(d.getHours() + 4); // urgent due in 4 hours
    return d;
  }
  return ""; // Normal: blank
}

function setStatus_(sheet, rowIndex, status) {
  sheet.getRange(rowIndex, COL.STATUS).setValue(status);
  sheet.getRange(rowIndex, COL.LAST_UPDATE).setValue(new Date());
}


function isAfterHours_(d) {
  const day = d.getDay(); // 0 = Sun, 6 = Sat
  const hour = d.getHours();

  // Weekend = after-hours
  if (day === 0 || day === 6) return true;

  // Before 8am or after 6pm
  return (hour < 8 || hour >= 18);
}


function findDirectoryRowByPhone_(dirSheet, phone) {
  var targetRaw = String(phone || "").trim();
  var isScap = /^SCAP:/i.test(targetRaw);
  var targetNorm = isScap ? targetRaw : normalizePhone_(targetRaw);
  var lastRow = dirSheet.getLastRow();
  if (lastRow < 2) return 0;
  var col = (typeof DIR_COL !== "undefined" && DIR_COL.PHONE) ? DIR_COL.PHONE : 1;
  var numRows = lastRow - 1;
  var vals = dirSheet.getRange(2, col, numRows, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    var cellRaw = String(vals[i][0] || "").trim();
    if (isScap) {
      if (cellRaw === targetRaw) return i + 2;
    } else {
      if (normalizePhone_(cellRaw) === targetNorm) return i + 2;
    }
  }
  return 0;
}


function looksLikeUnitReply_(text) {
  const s = String(text || "").trim();
  if (!s) return false;

  // Must be 1-6 chars alnum (e.g., 210, 3B, 402A)
  if (!/^[A-Za-z0-9]{1,6}$/.test(s)) return false;

  // Reject property menu digits (dynamic: 1..N)
  if (/^\d+$/.test(s)) {
    const list = (typeof getActiveProperties_ === "function") ? getActiveProperties_() : [];
    const n = parseInt(s, 10);
    if (n >= 1 && n <= (list ? list.length : 0)) return false;
  }

  // Reject common junk words
  const bad = ["yes", "no", "ok", "okay", "thanks", "thankyou", "hello", "hi", "help", "service"];
  if (bad.includes(s.toLowerCase())) return false;

  // If contains letters, allow (3B, 402A)
  if (/[A-Za-z]/.test(s)) return true;

  // If numeric only, require >= 2 digits
  if (/^\d+$/.test(s)) return s.length >= 2 && s.length <= 5;

  return false;
}

function getDirPendingRow_(dirSheet, dirRow) {
  if (!dirRow) return 0;
  const v = dirSheet.getRange(dirRow, 7).getValue(); // Col G
  const n = parseInt(v, 10);
  return isFinite(n) ? n : 0;
}

function setDirPendingRow_(dirSheet, dirRow, rowNum) {
  if (!dirRow) return;
  dirSheet.getRange(dirRow, 7).setValue(rowNum ? Number(rowNum) : "");
}

// ✅ Propera Compass: clear stage fields but KEEP the active ticket pointer (PendingRow)
// Do NOT clear PendingIssue (col 5) here — preserves issue across unit/schedule turns.
function clearDirPending_(dirSheet, dirRow) {
  if (!dirRow) return;

  // E PendingIssue — leave intact to avoid wiping issue on later turns
  // dirSheet.getRange(dirRow, 5).setValue(""); // REMOVED: no empty overwrite
  // dirSheet.getRange(dirRow, 6).setValue(""); // PendingUnit (optional — leave commented)
  dirSheet.getRange(dirRow, 8).setValue(""); // PendingStage
}

// ✅ Only call this when you truly want to drop the pointer (cancel/close/start over)
function clearDirTicketPointer_(dirSheet, dirRow) {
  if (!dirRow) return;
  dirSheet.getRange(dirRow, 7).setValue(""); // PendingRow
}

/** Normalize Directory PendingRow + PendingStage: clear ghost pointer if ticket closed/missing, or restore a sensible stage if pointer valid but stage blank. */
function normalizeDirTicketPointer_(sheetTickets, dir, dirRow, phone) {
  var pr = dalGetPendingRow_(dir, dirRow) || 0;
  var st = String(dalGetPendingStage_(dir, dirRow) || "").trim().toUpperCase();
  if (pr < 2) return { ok: true, pendingRow: 0, pendingStage: "" };

  var status = "";
  try { status = String(sheetTickets.getRange(pr, COL.STATUS).getValue() || "").trim().toLowerCase(); } catch (e) { status = ""; }
  var closed = (status === "completed" || status === "canceled" || status === "cancelled" || status === "done" || status === "closed");

  if (!status || closed || pr < 2) {
    dalWithLock_("NORM_CLEAR_GHOST_PTR", function () {
      dalSetPendingRowNoLock_(dir, dirRow, "");
      dalSetPendingStageNoLock_(dir, dirRow, "");
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE NORM_CLEAR_GHOST_PTR row=" + dirRow + " pr=" + pr + " status=" + status); } catch (_) {}
    });
    return { ok: true, pendingRow: 0, pendingStage: "" };
  }

  if (!st) {
    var restoredStage = "SCHEDULE";
    try {
      var pref = String(sheetTickets.getRange(pr, COL.PREF_WINDOW).getValue() || "").trim();
      if (pref) restoredStage = "DETAIL";
    } catch (_) {}
    dalWithLock_("NORM_SET_STAGE_FROM_PTR", function () {
      dalSetPendingStageNoLock_(dir, dirRow, restoredStage);
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE NORM_SET_STAGE_FROM_PTR row=" + dirRow + " pr=" + pr + " stage=" + restoredStage); } catch (_) {}
    });
    st = restoredStage;
  }

  return { ok: true, pendingRow: pr, pendingStage: st };
}


function getTwilioMessageSid_(e) {
  return safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid");
}

/*******************************************************
* isVendor_
* Determines if a phone belongs to a registered vendor.
* Deterministic, safe, no side effects.
*******************************************************/
function isVendor_(phoneE164) {
  try {
    if (!phoneE164) return false;

    // Normalize to digits
    const digits = String(normalizePhoneDigits_(phoneE164) || "").trim();
    if (!digits) return false;

    // Use last 10 digits (US-safe)
    const d10 = digits.slice(-10);
    if (!d10) return false;

    const vendor = getVendorByPhoneDigits_(d10);
    return !!vendor;

  } catch (_) {
    return false; // Never allow vendor check to crash router
  }
}



function isManager_(phoneAny) {
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = String(phoneAny || "").trim();

    // Allow either a single manager phone OR a CSV list
    const single = String(props.getProperty("ONCALL_NUMBER") || props.getProperty("MANAGER_PHONE") || "").trim();
    const csv    = String(props.getProperty("MANAGER_PHONES") || "").trim();
    // Telegram manager ids (digits or TG:<digits>), comma-separated.
    // Example: MANAGER_TELEGRAM_IDS=7108534136,1234567890
    const tgCsv  = String(props.getProperty("MANAGER_TELEGRAM_IDS") || props.getProperty("MANAGER_TG_IDS") || "").trim();

    const candidates = []
      .concat(single ? [single] : [])
      .concat(csv ? csv.split(",") : [])
      .map(s => String(s || "").trim())
      .filter(Boolean);

    var tgDigits = "";
    if (/^TG:/i.test(raw)) tgDigits = raw.replace(/^TG:\s*/i, "").replace(/\D/g, "");
    if (tgDigits) {
      const tgCandidates = (tgCsv ? tgCsv.split(",") : [])
        .map(s => String(s || "").trim().replace(/^TG:\s*/i, "").replace(/\D/g, ""))
        .filter(Boolean);
      for (let ti = 0; ti < tgCandidates.length; ti++) {
        if (tgCandidates[ti] === tgDigits) return true;
      }
    }

    const me10 = String(normalizePhoneDigits_(raw)).slice(-10);
    if (!me10) return false;

    for (let i = 0; i < candidates.length; i++) {
      const c10 = String(normalizePhoneDigits_(candidates[i] || "")).slice(-10);
      if (c10 && c10 === me10) return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Compatibility wrappers (Compass-safe)
// -----------------------------------------------------------------------------
function isManagerPhone_(phoneAny) { return isManager_(phoneAny); }
function isVendorPhone_(phoneAny)  { return isVendor_(phoneAny); }





function escRe_(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function ensureDirectoryForTenant_(dir, tenantPhone, propertyNameMaybe) {
  const phone = normalizePhone_(tenantPhone);
  if (!phone) return 0;

  let dirRow = findDirectoryRowByPhone_(dir, phone);
  if (!dirRow) {
    dir.appendRow([phone, "", propertyNameMaybe || "", new Date(), "", "", "", "", "", ""]);
    dirRow = dir.getLastRow();
  } else {
    if (propertyNameMaybe) {
      dalWithLock_("DIR_UPDATE_PROPERTY_NAME", function () {
        dalSetPendingPropertyNoLock_(dir, dirRow, { name: propertyNameMaybe });
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE DIR_UPDATE_PROPERTY_NAME row=" + dirRow); } catch (_) {}
      });
    } else {
      dalWithLock_("DIR_TOUCH_ROW", function () {
        dalSetLastUpdatedNoLock_(dir, dirRow);
      });
    }
  }
  return dirRow;
}


function phoneDigits10_(phoneAny) {
  const d = String(normalizePhoneDigits_(phoneAny || "") || "").trim();
  return d ? d.slice(-10) : "";
}

function isKnownTenantPhone_(phoneAny) {
  try {
    const d10 = phoneDigits10_(phoneAny);
    if (!d10) return false;
    const t = lookupTenantByPhoneDigits_(d10);
    return !!t;
  } catch (_) {
    return false;
  }
}


function withWelcome_(welcomeLine, msg) {
  const w = String(welcomeLine || "").trim();
  const m = String(msg || "").trim();
  if (!m) return "";
  return w ? (w + "\n\n" + m) : m;
}

function sendLoggedThenAskWindow_(sid, token, fromNum, toNum, lang, vars) {
  const L = String(lang || "en").toLowerCase();
  const V = vars || {};
  const confirm = tenantMsg_("TENANT_TICKET_LOGGED_CONFIRM", L, V);
  const askWindow = tenantMsg_("ASK_WINDOW", L, V);
  sendSms_(sid, token, fromNum, toNum, confirm + "\n\n" + askWindow);
}

function looksActionableIssue_(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return false;

  if (isResolvedOrDismissedClause_(t)) return false;

  // Very short messages are usually not actionable
  if (t.length < 6) return false;

  // Obvious acknowledgements / filler
  if (/^(ok|okay|k|yes|no|yep|nope|sure|thanks|thank you|cool|great|\?)$/.test(t)) return false;

  // Strong maintenance verbs / intents (include "maintenance" so "MAINTENANCE" alone is actionable)
  if (/(leak|leaking|drip|dripping|clog|backup|flood|water|toilet|sink|shower|tub|heater|\bac\b|a\/c|\bheat\b|no heat|no hot|hot water|electric|outlet|breaker|sparks|smoke|gas|odor|mold|roach|bug|mouse|lock|door|key|window|broken|not working|doesn'?t work|maintenance)/.test(t)) {
    return true;
  }

  // If it has a problem verb, treat as actionable (include "stop working" / "stops working")
  if (/(not working|doesn'?t work|broken|won'?t|wont|stopped|stop\s+working|stops?\s+working|leak|clog|smell|noise|sparks|tripping|overflow|backup|no heat|no hot|not heating|not cooling|doesn'?t drain|not draining)/.test(t)) return true;

  // Do not admit as actionable from length/word count alone (classification must supply defect signals)
  return false;
}

/** True when the clause only asks for a visit/schedule, not a second problem (e.g. "please have maintenance schedule to check it"). */
function isScheduleIntentOnly_(s) {
  var t = String(s || "").toLowerCase().trim();
  if (!t || t.length > 120) return false;
  if ((typeof looksActionableIssue_ === "function") && looksActionableIssue_(t)) return false;
  if (/\b(leak|clog|broken|not working|stopped|ac\b|heat\b|toilet|sink|gym|lobby|hallway)\b/.test(t)) return false;
  var scheduleAsk =
    /\b(please\s+)?(have\s+)?(maintenance\s+)?(schedule|someone)\s+(to\s+)?(check|come|look|fix|repair|inspect)/.test(t) ||
    /\b(when\s+can\s+(someone|you|maintenance)\s+come)\b/.test(t) ||
    /\b(please\s+)?(schedule|send)\s+(someone|maintenance|a\s+tech)/.test(t) ||
    /\b(need\s+someone\s+to\s+check)\b/.test(t) ||
    /\b(can\s+someone\s+come\s+(out|by))\b/.test(t);
  return scheduleAsk;
}

/** Return true if text looks like a schedule/window reply (today, tomorrow, weekday, time). Compass-safe. */
function isScheduleLike_(s) {
  var t = String(s || "").toLowerCase().trim();
  if (!t) return false;
  if (/today|tomorrow/.test(t)) return true;
  if (/\b(mon|tue|wed|thu|fri|sat|sun)(sday|sday)?\b/.test(t)) return true;
  if (/\b(morning|afternoon|evening)\b/.test(t)) return true;
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t)) return true;
  if (/\b\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)?\b/.test(t)) return true;
  return false;
}

/** Strict schedule/window detector used ONLY for suppression + schedule writes. */
function isScheduleWindowLike_(s) {
  var t = String(s || "").toLowerCase().trim();
  if (!t) return false;

  var hasDay =
    /today|tomorrow/.test(t) ||
    /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/.test(t);

  var hasTime =
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(t) ||
    /\b\d{1,2}\s*-\s*\d{1,2}\s*(am|pm)?\b/.test(t);

  var hasAvailability =
    /\b(available|availability|free|home|around|can you come|come by|stop by|anytime)\b/.test(t);

  var hasDayPart = /\b(morning|afternoon|evening)\b/.test(t);

  // daypart alone is NOT enough
  if (hasDayPart && (hasDay || hasTime || hasAvailability)) return true;

  // day or time alone is enough
  if (hasDay || hasTime) return true;

  return false;
}

function isWeakIssue_(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return true;

  var weakList = [
    "hi",
    "hello",
    "hey",
    "help",
    "need help",
    "hi need help",
    "please",
    "anyone"
  ];

  if (weakList.indexOf(v) !== -1) return true;
  if (v.length <= 12 && v.indexOf(" ") === -1) return true;
  return false;
}

function looksSpecificIssue_(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return false;

  var keywords = [
    "sink",
    "toilet",
    "leak",
    "clog",
    "water",
    "heat",
    "ac",
    "electric",
    "smell",
    "fire",
    "alarm",
    "door",
    "lock",
    "washer",
    "dryer",
    "fridge",
    "oven",
    "stove",
    "pipe",
    "ceiling",
    "wall",
    "window"
  ];

  for (var i = 0; i < keywords.length; i++) {
    if (v.indexOf(keywords[i]) !== -1) return true;
  }

  if (v.length > 15 && v.indexOf(" ") !== -1) return true;

  return false;
}

function safeParam_(e, key) {
  if (!e || !e.parameter || !e.parameter[key]) return "";
  return String(e.parameter[key]).trim();
}

function getSheet_(name) {
  var sh = getLogSheetByNameCached_(name);
  if (!sh) throw new Error('Sheet tab not found: "' + name + '"');
  return sh;
}


function setDirPendingStage_(dirSheet, dirRow, stage) {
  if (!dirRow) return;
  dirSheet.getRange(dirRow, 8).setValue(stage || "");
}

function getDirPendingStage_(dirSheet, dirRow) {
  if (!dirRow) return "";
  return String(dirSheet.getRange(dirRow, 8).getValue() || "").trim();
}


function normalizePhone_(p) {
  let s = String(p || "").trim();
  if (!s) return "";

  const digits = s.replace(/[^\d]/g, "");

  // Reject anything that isn't plausibly a phone number
  // (prevents SCAP:D3 -> +13, "17" -> +17, etc.)
  if (digits.length < 10) return "";

  // US 10-digit
  if (digits.length === 10) return "+1" + digits;

  // US 11-digit starting with 1
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;

  // E164-ish: keep plus if present and length is reasonable
  if (s.startsWith("+") && digits.length >= 11) return "+" + digits;

  // Otherwise reject (don't guess country codes)
  return "";
}

/**
 * US-local digits only (10 chars) for matching vendors/tenants and +1 concatenation.
 * Strips non-digits; 11-digit starting with 1 → drop leading 1; longer → last 10 digits.
 */
function normalizePhoneDigits_(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d || d.length < 10) return "";
  if (d.length === 10) return d;
  if (d.length === 11 && d.charAt(0) === "1") return d.slice(1);
  return d.slice(-10);
}

function phoneKey_(raw) {
  const digits = String(normalizePhone_(raw) || "").replace(/\D/g, "");
  if (digits.length === 10) return "1" + digits;
  if (digits.length === 11 && digits.indexOf("1") === 0) return digits;
  return digits || "";
}

/** Prefixed synthetic IDs (SCAP:, TG:, APP:) stay as-is; else phoneKey_. */
function actorKey_(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^(SCAP:|TG:|APP:)/i.test(s)) return s;
  return phoneKey_(s);
}

/****************************
* Tenant language (Spanish-ready)
* For now: always English (no behavior change)
****************************/
const DIR_COL = {
  PHONE: 1,
  PROPERTY_CODE: 2,
  PROPERTY_NAME: 3,
  LAST_UPDATED: 4,
  PENDING_ISSUE: 5,
  PENDING_UNIT: 6,
  PENDING_ROW: 7,
  PENDING_STAGE: 8,
  HANDOFF_SENT: 9,
  WELCOME_SENT: 10,
  ACTIVE_TICKET_KEY: 11,
  ISSUE_BUF_JSON: 12,
  DRAFT_SCHEDULE_RAW: 13,
  UNIT: 14  // canonical identity unit (draft-only is PENDING_UNIT)
};

// ============================================================
// DAL — Data Access Layer (Propera Compass)
// Purpose: centralize Sheets reads/writes + logging + locks
// After this point, do not use getRange on Directory/Tickets directly
// inside business logic; add DAL wrappers instead.
// ============================================================

var DAL_LOG_LEN = 50;

function dalWithLock_(label, fn) {
  return withWriteLock_(label, fn);
}

/** Return directory row index for phone (1-based), or 0. Reuses findDirectoryRowByPhone_. */
function dalGetDirRowByPhone_(dirSheet, phone) {
  if (typeof findDirectoryRowByPhone_ !== "function") return 0;
  return findDirectoryRowByPhone_(dirSheet, phone) || 0;
}

/** Read PendingRow (col G). */
function dalGetPendingRow_(dirSheet, dirRow) {
  if (!dirRow || dirRow < 2) return 0;
  if (typeof getDirPendingRow_ === "function") return getDirPendingRow_(dirSheet, dirRow) || 0;
  var v = dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ROW : 7).getValue();
  var n = parseInt(v, 10);
  return isFinite(n) ? n : 0;
}

/** Internal: write PendingRow (col G) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
function dalSetPendingRowNoLock_(dirSheet, dirRow, pendingRow) {
  if (!dirRow || dirRow < 2) return;
  var val = (pendingRow != null && pendingRow !== "") ? Number(pendingRow) : "";
  dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ROW : 7).setValue(val);
}

/** Internal: set LastUpdated (col D) only. No lock, no log. Call once at end of grouped NoLock writes. */
function dalSetLastUpdatedNoLock_(dirSheet, dirRow) {
  if (!dirRow || dirRow < 2) return;
  dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.LAST_UPDATED : 4).setValue(new Date());
}

/** Write PendingRow (col G); locked + DAL_WRITE log. */
function dalSetPendingRow_(dirSheet, dirRow, pendingRow, phone, reason) {
  if (!dirRow || dirRow < 2) return;
  var val = (pendingRow != null && pendingRow !== "") ? Number(pendingRow) : "";
  dalWithLock_("DAL_SET_PENDING_ROW", function () {
    dalSetPendingRowNoLock_(dirSheet, dirRow, pendingRow);
    dalSetLastUpdatedNoLock_(dirSheet, dirRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingRow row=" + dirRow + " val=[" + String(val).slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Read PendingStage (col H). */
function dalGetPendingStage_(dirSheet, dirRow) {
  if (!dirRow || dirRow < 2) return "";
  if (typeof getDirPendingStage_ === "function") return String(getDirPendingStage_(dirSheet, dirRow) || "").trim();
  return String(dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_STAGE : 8).getValue() || "").trim();
}

/** Internal: write PendingStage (col H) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
function dalSetPendingStageNoLock_(dirSheet, dirRow, stage) {
  if (!dirRow || dirRow < 2) return;
  var val = String(stage != null ? stage : "").trim();
  dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_STAGE : 8).setValue(val);
}

/** Write PendingStage (col H); locked + DAL_WRITE log. */
function dalSetPendingStage_(dirSheet, dirRow, stage, phone, reason) {
  if (!dirRow || dirRow < 2) return;
  var val = String(stage != null ? stage : "").trim();
  dalWithLock_("DAL_SET_PENDING_STAGE", function () {
    dalSetPendingStageNoLock_(dirSheet, dirRow, stage);
    dalSetLastUpdatedNoLock_(dirSheet, dirRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingStage row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Read property code (col B) and name (col C). */
function dalGetPendingProperty_(dirSheet, dirRow) {
  if (!dirRow || dirRow < 2) return { code: "", name: "" };
  var c = typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_CODE : 2;
  var n = typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_NAME : 3;
  return {
    code: String(dirSheet.getRange(dirRow, c).getValue() || "").trim(),
    name: String(dirSheet.getRange(dirRow, n).getValue() || "").trim()
  };
}

/** Internal: write property code (col B) and/or name (col C) only. payload: { code: "", name: "" }. No lock, no log, no LastUpdated. */
function dalSetPendingPropertyNoLock_(dirSheet, dirRow, payload) {
  if (!dirRow || dirRow < 2) return;
  if (payload && payload.code !== undefined) dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_CODE : 2).setValue(String(payload.code || "").trim());
  if (payload && payload.name !== undefined) dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PROPERTY_NAME : 3).setValue(String(payload.name || "").trim());
}

/** Write property code (col B) and/or name (col C). payload: { code: "", name: "" }. Locked + log. */
function dalSetPendingProperty_(dirSheet, dirRow, payload, phone, reason) {
  if (!dirRow || dirRow < 2) return;
  var code = (payload && payload.code !== undefined) ? String(payload.code || "").trim() : "";
  var name = (payload && payload.name !== undefined) ? String(payload.name || "").trim() : "";
  dalWithLock_("DAL_SET_PENDING_PROPERTY", function () {
    dalSetPendingPropertyNoLock_(dirSheet, dirRow, payload);
    dalSetLastUpdatedNoLock_(dirSheet, dirRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingProperty row=" + dirRow + " val=[" + (code || name).slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Read PendingUnit (col F). */
function dalGetPendingUnit_(dirSheet, dirRow) {
  if (!dirRow || dirRow < 2) return "";
  return String(dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_UNIT : 6).getValue() || "").trim();
}

/** Internal: write PendingUnit (col F) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
function dalSetPendingUnitNoLock_(dirSheet, dirRow, unit) {
  if (!dirRow || dirRow < 2) return;
  var val = String(unit != null ? unit : "").trim();
  dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_UNIT : 6).setValue(val);
}

/** Write PendingUnit (col F); locked + log. */
function dalSetPendingUnit_(dirSheet, dirRow, unit, phone, reason) {
  if (!dirRow || dirRow < 2) return;
  var val = String(unit != null ? unit : "").trim();
  dalWithLock_("DAL_SET_PENDING_UNIT", function () {
    dalSetPendingUnitNoLock_(dirSheet, dirRow, unit);
    dalSetLastUpdatedNoLock_(dirSheet, dirRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingUnit row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Invalid-unit guard (no "0", "na", etc.). */
function isInvalidUnit_(u) {
  const s = String(u || "").trim().toLowerCase();
  return !s || s === "0" || s === "00" || s === "000" || s === "na" || s === "n/a" ||
        s === "none" || s === "unknown" || s === "-" || s === "?";
}

/** Read canonical Unit (col 14). */
function dalGetUnit_(dirSheet, dirRow) {
  if (!dirRow || dirRow < 2) return "";
  return String(dirSheet.getRange(dirRow, DIR_COL.UNIT).getValue() || "").trim();
}

/** Internal: write canonical Unit (learn-only in caller). No lock. */
function dalSetUnitNoLock_(dirSheet, dirRow, unit) {
  if (!dirRow || dirRow < 2) return;
  const val = String(unit != null ? unit : "").trim();
  if (isInvalidUnit_(val)) return;
  dirSheet.getRange(dirRow, DIR_COL.UNIT).setValue(val);
}

/** Write canonical Unit (learn-only: do not overwrite existing). Locked + log. */
function dalSetUnit_(dirSheet, dirRow, unit, phone, reason) {
  if (!dirRow || dirRow < 2) return;
  const val = String(unit != null ? unit : "").trim();
  if (isInvalidUnit_(val)) return;

  dalWithLock_("DAL_SET_UNIT", function () {
    const cur = String(dirSheet.getRange(dirRow, DIR_COL.UNIT).getValue() || "").trim();
    if (cur) return;

    dalSetUnitNoLock_(dirSheet, dirRow, val);
    dalSetLastUpdatedNoLock_(dirSheet, dirRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE field=Unit row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Read PendingIssue (col E). */
function dalGetPendingIssue_(dirSheet, dirRow) {
  if (!dirRow || dirRow < 2) return "";
  return String(dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ISSUE : 5).getValue() || "").trim();
}

/** Internal: overwrite PendingIssue (col E) only. No lock, no log, no LastUpdated. Call inside dalWithLock_; set LastUpdated once at end of group. */
function dalSetPendingIssueNoLock_(dirSheet, dirRow, issue) {
  if (!dirRow || dirRow < 2) return;
  var val = String(issue != null ? issue : "").trim();
  if (val.length > 500) val = val.slice(0, 500);
  dirSheet.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.PENDING_ISSUE : 5).setValue(val);
}

/** Overwrite PendingIssue (col E); locked + log. */
function dalSetPendingIssue_(dirSheet, dirRow, issue, phone, reason) {
  if (!dirRow || dirRow < 2) return;
  var val = String(issue != null ? issue : "").trim();
  if (val.length > 500) val = val.slice(0, 500);
  dalWithLock_("DAL_SET_PENDING_ISSUE", function () {
    dalSetPendingIssueNoLock_(dirSheet, dirRow, issue);
    dalSetLastUpdatedNoLock_(dirSheet, dirRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingIssue row=" + dirRow + " val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Append to PendingIssue with " | " separator; locked + log. Truncates combined to 500. */
function dalAppendPendingIssue_(dirSheet, dirRow, fragment, phone, reason) {
  if (!dirRow || dirRow < 2 || !fragment) return;
  var sep = " | ";
  var existing = dalGetPendingIssue_(dirSheet, dirRow);
  var combined = existing ? (existing + sep + String(fragment).trim()) : String(fragment).trim();
  if (combined.length > 500) combined = combined.slice(0, 500);
  dalWithLock_("DAL_APPEND_PENDING_ISSUE", function () {
    dalSetPendingIssueNoLock_(dirSheet, dirRow, combined);
    dalSetLastUpdatedNoLock_(dirSheet, dirRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE field=PendingIssue append row=" + dirRow + " val=[" + String(fragment).slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Tenant language; wrapper (no Directory column today). */
function dalGetLang_(dirSheet, dirRow, phone) {
  if (typeof getTenantLang_ === "function") return getTenantLang_(dirSheet, dirRow, phone, "");
  return "en";
}

// --- Ticket DAL (minimal) ---

/** Snapshot of ticket row fields already used (property, unit, issue, schedule, status). */
function dalTicketGetRowSnapshot_(ticketSheet, row) {
  if (!ticketSheet || !row || row < 2 || typeof COL === "undefined") return { property: "", unit: "", issue: "", schedule: "", status: "" };
  try {
    return {
      property: String(ticketSheet.getRange(row, COL.PROPERTY).getValue() || "").trim(),
      unit: String(ticketSheet.getRange(row, COL.UNIT).getValue() || "").trim(),
      issue: String(ticketSheet.getRange(row, COL.MSG).getValue() || "").trim(),
      schedule: String(ticketSheet.getRange(row, COL.PREF_WINDOW).getValue() || "").trim(),
      status: String(ticketSheet.getRange(row, COL.STATUS).getValue() || "").trim()
    };
  } catch (_) {
    return { property: "", unit: "", issue: "", schedule: "", status: "" };
  }
}

/** Set ticket PreferredWindow; locked + log. */
function dalTicketSetSchedule_(ticketSheet, row, scheduleText, phone, reason) {
  if (!ticketSheet || !row || row < 2 || typeof COL === "undefined") return;
  var val = String(scheduleText != null ? scheduleText : "").trim();
  dalWithLock_("DAL_TICKET_SET_SCHEDULE", function () {
    ticketSheet.getRange(row, COL.PREF_WINDOW).setValue(val);
    ticketSheet.getRange(row, COL.LAST_UPDATE).setValue(new Date());
    try { logDevSms_(phone || "", "", "DAL_WRITE ticket row=" + row + " field=PREF_WINDOW val=[" + val.slice(0, DAL_LOG_LEN) + "] reason=" + (reason || "")); } catch (_) {}
  });
}

/** Append to ServiceNotes if column exists; locked + log. */
function dalTicketAppendNote_(ticketSheet, row, note, phone, reason) {
  if (!ticketSheet || !row || row < 2 || typeof COL === "undefined" || !COL.SERVICE_NOTES) return;
  var existing = String(ticketSheet.getRange(row, COL.SERVICE_NOTES).getValue() || "").trim();
  var combined = existing ? (existing + "\n" + String(note).trim()) : String(note).trim();
  if (combined.length > 5000) combined = combined.slice(-5000);
  dalWithLock_("DAL_TICKET_APPEND_NOTE", function () {
    ticketSheet.getRange(row, COL.SERVICE_NOTES).setValue(combined);
    ticketSheet.getRange(row, COL.LAST_UPDATE).setValue(new Date());
    try { logDevSms_(phone || "", "", "DAL_WRITE ticket row=" + row + " field=SERVICE_NOTES append reason=" + (reason || "")); } catch (_) {}
  });
}

// ============================================================

/** Parse staff-capture draft id from payload: "d123", "#d123", "d123: rest", "#d26 Morris" → { draftId: "D123", rest: "rest" }. */
function parseStaffCapDraftId_(s) {
  var t = String(s || "").trim();
  var match = t.match(/^#?d(\d+)\s*[:\-]?\s*(.*)$/i);
  if (match) return { draftId: "D" + match[1], rest: String(match[2] || "").trim() };
  return { draftId: "", rest: t };
}

/** True only when payload is truly empty after trim. Short values like 'Morris' or '219' are NOT status-only. */
function isStaffDraftStatusOnlyPayload_(payloadText) {
  return String(payloadText || "").trim().length === 0;
}

/** Next staff-capture draft id (STAFFCAP_SEQ in Script Properties). */
function nextStaffCapDraftId_() {
  // Atomic increment (prevents two concurrent staff messages generating same D#)
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sp = PropertiesService.getScriptProperties();
    var v = String(sp.getProperty("STAFFCAP_SEQ") || "0").trim();
    var seq = parseInt(v, 10) || 0;
    seq += 1;
    sp.setProperty("STAFFCAP_SEQ", String(seq));
    return "D" + seq;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/** Ensure a Directory row exists for phone; create minimal stub if missing. Safe for staff capture. */
function ensureDirectoryRowForPhone_(dir, phone) {
  var targetRaw = String(phone || "").trim();
  var isScap = /^SCAP:/i.test(targetRaw);
  var isPortalPm = /^PORTAL_PM:/i.test(targetRaw);
  var exactKeyOnly = isScap || isPortalPm;
  var targetNorm = exactKeyOnly ? targetRaw : normalizePhone_(targetRaw);
  var lastRow = dir.getLastRow();
  var col = (typeof DIR_COL !== "undefined" && DIR_COL.PHONE) ? DIR_COL.PHONE : 1;
  var matches = [];
  if (lastRow >= 2) {
    try {
      var numRows = lastRow - 1;
      var vals = dir.getRange(2, col, numRows, 1).getValues();
      for (var i = 0; i < vals.length; i++) {
        var cellRaw = String(vals[i][0] || "").trim();
        if (exactKeyOnly) {
          if (cellRaw === targetRaw) matches.push(i + 2);
        } else {
          if (normalizePhone_(cellRaw) === targetNorm) matches.push(i + 2);
        }
      }
    } catch (_) {}
  }
  if (matches.length > 0) {
    if (matches.length > 1) {
      try { logDevSms_(phone || "", "", "DIR_DUP_PHONE key=[" + targetRaw + "] count=[" + matches.length + "] first=[" + matches[0] + "] last=[" + matches[matches.length - 1] + "]"); } catch (_) {}
    }
    return matches[0];
  }

  // Allocate newRow inside lock so concurrent requests get different rows (avoids ACTIVE_TICKET_EXISTS race).
  var newRow;
  dalWithLock_("DIR_CREATE_STUB", function () {
    newRow = dir.getLastRow() + 1;
    dir.getRange(newRow, typeof DIR_COL !== "undefined" ? DIR_COL.PHONE : 1).setValue(phone);
    dalSetLastUpdatedNoLock_(dir, newRow);
    try { logDevSms_(phone || "", "", "DAL_WRITE DIR_CREATE_STUB newRow=" + newRow); } catch (_) {}
  });
  return newRow;
}

// Later: add LANGUAGE: 10 (K)


// For now returns "en" always (no behavior change)
function getTenantLang_(dirSheet, dirRow, phone, bodyRaw) {
  return "en";
}

/****************************
* Tenant message templates
****************************/
const BRAND = {
  name: "The Grand Automated System",
  team: "The Grand Service Team"
};

function staffCaptureDraftTag_(draftId) {
  var d = String(draftId || "").trim();
  if (!d) return "";
  return d.charAt(0) === "#" ? d : ("#" + d);
}

function staffCaptureMissingListHuman_(missing) {
  var labels = { property: "Property", unit: "Unit", issue: "Issue", schedule: "Schedule" };
  var arr = Array.isArray(missing) ? missing : [];
  return arr
    .map(function (m) {
      var kk = String(m || "").trim().toLowerCase();
      return labels[kk] || (kk ? kk.charAt(0).toUpperCase() + kk.slice(1) : "");
    })
    .filter(Boolean)
    .join(", ");
}

/** One line per missing slot: "#D26 Missing Property" (newline-separated). */
function staffCaptureMissingLinesBlock_(draftTag, missing) {
  var tag = String(draftTag || "").trim();
  if (!tag) return "";
  var labels = { property: "Property", unit: "Unit", issue: "Issue", schedule: "Schedule" };
  var arr = Array.isArray(missing) ? missing : [];
  var lines = [];
  for (var i = 0; i < arr.length; i++) {
    var kk = String(arr[i] || "").trim().toLowerCase();
    var lab = labels[kk] || (kk ? kk.charAt(0).toUpperCase() + kk.slice(1) : "");
    if (lab) lines.push(tag + " Missing " + lab);
  }
  return lines.join("\n");
}

function staffCaptureStatusMissingLines_(draftTag, missing) {
  var block = staffCaptureMissingLinesBlock_(draftTag, missing);
  if (block) return block;
  return String(draftTag || "").trim() ? (String(draftTag).trim() + " No missing fields.") : "No missing fields.";
}

function staffCaptureAlreadyFinalMissingBlock_(draftTag, missing) {
  var block = staffCaptureMissingLinesBlock_(draftTag, missing);
  if (!block) return "";
  return "\n" + block;
}

function staffCaptureDraftProgressMissingLines_(draftTag, missing) {
  var tag = String(draftTag || "").trim();
  var block = staffCaptureMissingLinesBlock_(tag, missing);
  if (block) return block;
  return tag ? (tag + " Draft updated.") : "Draft updated.";
}

function staffCaptureVisionNoteVars_(enqueued, draftTag) {
  if (!enqueued || !draftTag) return { visionNote: "" };
  var sfx = "";
  try {
    if (typeof tenantMsg_ === "function") {
      sfx = String(tenantMsg_("STAFF_CAPTURE_VISION_SUFFIX", "en", { draftTag: draftTag }) || "").trim();
    }
  } catch (_) {}
  return { visionNote: sfx ? (" " + sfx) : "" };
}

/**
 * Staff #capture / OCR follow-ups: user-visible acks via Outgate + Templates only.
 */
function staffCaptureDispatchOutboundIntent_(staffActorRef, intentType, vars, inboundEvent) {
  var ref = String(staffActorRef || "").trim();
  if (!ref || !intentType) return false;
  var ch = "";
  try {
    if (inboundEvent && typeof getResolvedInboundChannel_ === "function") {
      ch = String(getResolvedInboundChannel_(inboundEvent) || "").trim().toUpperCase();
    }
  } catch (_) {}
  if (!ch || (ch !== "WA" && ch !== "TELEGRAM" && ch !== "SMS")) {
    if (/^TG:/i.test(ref)) ch = "TELEGRAM";
    else if (/^whatsapp:/i.test(ref)) ch = "WA";
    else ch = "SMS";
  }
  if (ch === "WHATSAPP") ch = "WA";
  var v = vars && typeof vars === "object" ? vars : {};
  var intent = {
    intentType: String(intentType).trim(),
    recipientType: "STAFF",
    recipientRef: ref,
    lang: "en",
    deliveryPolicy: "NO_HEADER",
    vars: Object.assign({ brandName: BRAND.name, teamName: BRAND.team }, v),
    channel: ch,
    meta: { source: "STAFF_CAPTURE", flow: "STAFF_CAPTURE", stage: String(intentType || "") }
  };
  if (ch === "TELEGRAM" && /^TG:/i.test(ref)) {
    var tid = String(ref.replace(/^TG:\s*/i, "").replace(/\D/g, "") || "").trim();
    if (tid) intent.telegramChatId = tid;
  }
  var out = typeof dispatchOutboundIntent_ === "function" ? dispatchOutboundIntent_(intent) : { ok: false };
  if (!out || !out.ok) {
    try {
      logDevSms_(ref, "", "STAFF_CAPTURE_OUTGATE_FAIL intent=[" + intentType + "] err=[" + String((out && out.error) || "") + "]");
    } catch (_) {}
  }
  return !!(out && out.ok);
}

/**
* tenantMsg_(key, lang, vars)
* - key: one of the keys above
* - lang: "en" (future: "es")
* - vars: optional object for template variables
*/
// Templates sheet columns (1-indexed):
// A TemplateID | B TemplateKey | C TemplateName | D TemplateBody

const TEMPLATES_SHEET_NAME = "Templates";

function tenantMsg_(key, lang, vars) {
  const k = String(key || "").trim();
  const L = String(lang || "en").trim().toLowerCase();
  const dataIn = vars || {};

  // Always inject brand defaults (caller can override)
  const data = Object.assign({
    brandName: BRAND.name,
    teamName: BRAND.team
  }, dataIn);

  const map = getTemplateMapCached_();

  // Primary: TemplateKey; fallback: TemplateName
  let body = "";
  if (map.byKey && map.byKey[k]) body = map.byKey[k];
  else if (map.byName && map.byName[k]) body = map.byName[k];

  if (!body) {
    // Avoid noisy template-missing logs for common-area creation; runtime has a minimal safe fallback for this key.
    if (k !== "TICKET_CREATED_COMMON_AREA" && String(k).indexOf("STAFF_CAPTURE_") !== 0) {
      try { logDevSms_("", "TEMPLATE_MISSING key=[" + k + "] lang=[" + L + "] Add this key to Templates sheet.", "ERR_TEMPLATE"); } catch (_) {}
    }
    // No long hardcoded tenant-facing copy in MAIN. All tenant text must live in Templates sheet.
    // Minimal safe fallback only when key is missing (GSM-7 safe, no 911/safety wording).
    if (k === "TICKET_CREATED_COMMON_AREA") {
      body = "We have logged your request. Thank you." + (data.ticketId ? " Ticket ID: {ticketId}." : "");
    } else if (k === "CLEANING_WORKITEM_ACK") {
      body = "We have logged this cleaning request. Staff have been notified.";
    } else if (k === "EMERGENCY_TENANT_ACK") {
      body = "We have been notified. Thank you." + (data.ticketId ? " Ticket ID: {ticketId}." : "");
    } else if (k === "STAFF_CAPTURE_TICKET_CREATED") {
      body = "Ticket Created: {ticketId}";
    } else if (k === "STAFF_CAPTURE_DRAFT_PROGRESS") {
      body = "{missingLines}{visionNote}";
    } else if (k === "STAFF_CAPTURE_VISION_QUEUED") {
      body = "{draftTag} Photo received. Analysis in progress; you will get another message when it finishes.";
    } else if (k === "STAFF_CAPTURE_VISION_SUFFIX") {
      body = "Photo analysis is still running in the background.";
    } else if (k === "STAFF_CAPTURE_DRAFT_STATUS") {
      body = "{draftTag} {ticketHint}\n{missingLines}\nHave: property={haveProp} unit={haveUnit} issue={haveIssue}.";
    } else if (k === "STAFF_CAPTURE_ALREADY_FINAL") {
      body = "{draftTag} Ticket already created (row {loggedRow}).{missingBlock}";
    } else if (k === "STAFF_CAPTURE_INGEST_ERROR") {
      body = "{draftTag} Capture could not be saved. Try again or use the portal.";
    } else {
      return ""; // safe non-user-text fallback
    }
  }

  body = sanitizeTemplateBody_(body);
  return renderTemplatePlaceholders_(body, data);
}

function getTemplateMapCached_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = "TEMPLATE_MAP_V2";
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
  const sh = ss.getSheetByName(TEMPLATES_SHEET_NAME);
  if (!sh) return { byKey: {}, byName: {} };

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 4) return { byKey: {}, byName: {} };

  const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const byKey = {};
  const byName = {};

  for (let i = 0; i < rows.length; i++) {
    const templateKey  = String(rows[i][1] || "").trim(); // col B
    const templateName = String(rows[i][2] || "").trim(); // col C
    const templateBody = String(rows[i][3] || "");        // col D

    if (templateKey) byKey[templateKey] = templateBody;
    if (templateName) byName[templateName] = templateBody;
  }

  const map = { byKey, byName };
  try { cache.put(cacheKey, JSON.stringify(map), 300); } catch (_) {} // 5 min
  return map;
}

function sanitizeTemplateBody_(body) {
  let s = String(body || "");

  // Strip wrapping quotes if sheet stored them like: "Hello\nWorld"
  s = s.replace(/^\s*"\s*([\s\S]*?)\s*"\s*$/, "$1");

  // Normalize Windows newlines
  s = s.replace(/\r\n/g, "\n");

  // Trim trailing whitespace-only lines
  s = s.replace(/[ \t]+\n/g, "\n");

  return s;
}

function renderTemplatePlaceholders_(body, vars) {
  const s = String(body || "");
  const v = vars || {};
  return s.replace(/\{([a-zA-Z0-9_]+)\}/g, function(_, name) {
    const val = v[name];
    return (val === undefined || val === null) ? "" : String(val);
  });
}


// Central message dictionary (English only for now)


/****************************
* SMS HANDLER (SMART)
****************************/
/****************************
* SMS HANDLER (SMART) — CLEAN VERSION (PATCHED)
****************************/
function handleSms_(e) {
  return handleSmsSafe_(e);
}

// Crash shield wrapper (Compass safety layer)
function handleSmsSafe_(e) {
  const started = new Date();
  let from = "", body = "", sid = "";
  try {
    from = safeParam_(e, "From") || "";
    body = safeParam_(e, "Body") || "";
    sid  = safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid") || "";

    // Always log inbound once
    try { logDevSms_(from, body, "INBOUND"); } catch (_) {}

    // Core
    return handleInboundCore_(e);

  } catch (err) {
    // Always log crash
    try { logDevSms_(from, String(err && err.stack ? err.stack : err), "CRASH"); } catch (_) {}
    try {
      if (typeof debugLogToSheet_ === "function") {
        debugLogToSheet_(
          "HANDLE_SMS_SAFE_CRASH_TRACE",
          String((typeof globalThis !== "undefined" && globalThis.__traceId) ? globalThis.__traceId : from || ""),
          "adapter=" + String((e && e.parameter && e.parameter._channel) ? String(e.parameter._channel).trim() : ((typeof globalThis !== "undefined" && globalThis.__traceAdapter) ? globalThis.__traceAdapter : "")) +
            " err=" + String(err && err.stack ? err.stack : err).slice(0, 200)
        );
      }
    } catch (_) {}

    // Soft fallback reply (template-driven) — via Outgate when available
    try {
      const baseVars = { brandName: BRAND.name, teamName: BRAND.team, __welcomeLine: welcomeLine };
      var _ogErrChannel = (typeof getResolvedInboundChannel_ === "function") ? String(getResolvedInboundChannel_(e) || "SMS").trim().toUpperCase() : "SMS";
      if (_ogErrChannel !== "WA" && _ogErrChannel !== "TELEGRAM") _ogErrChannel = "SMS";
      var _ogErr = (typeof dispatchOutboundIntent_ === "function" && from) ? dispatchOutboundIntent_({ intentType: "ERROR_TRY_AGAIN", recipientType: "TENANT", recipientRef: from, lang: "en", channel: _ogErrChannel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "handleSmsSafe_", stage: "CRASH", flow: "FALLBACK" } }) : { ok: false };
      if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_GENERIC_TRY_AGAIN", "en", baseVars));
    } catch (_) {}

    return;
  }
}


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// DAL helpers
// ─────────────────────────────────────────────────────────────────


  function findTenantCandidates_(propertyName, unit, queryName) {
    const sh = ensureTenantsSheet_();

    // Normalize unit the same way everywhere
    const u = normalizeUnit_(String(unit || "").trim());
    if (!u) return [];

    // Resolve property to canonical property code using your existing resolver
    const prop = getPropertyByNameOrKeyword_(String(propertyName || "").trim());
    if (!prop) return [];

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];

    // Tenants columns:
    // 1 Property, 2 Unit, 3 Phone, 4 Name, 5 UpdateAt, 6 Notes, 7 Active
    const data = sh.getRange(2, 1, lastRow - 1, 7).getValues();

    const qn = String(queryName || "").trim();
    const qnLower = qn.toLowerCase();

    const found = [];

    for (let i = 0; i < data.length; i++) {
      const rpName = String(data[i][0] || "").trim();
      const ru = normalizeUnit_(String(data[i][1] || "").trim());

      // Phone in your sheet can be:
      //  - 19083380300 (11 digits starting with 1)
      //  - 9083380300  (10 digits)
      //  - +19083380300
      const d10 = String(normalizePhoneDigits_(data[i][2] || "") || "").slice(-10);
      if (!d10) continue;

      const rname = String(data[i][3] || "").trim();

      if (!isTenantActive_(data[i][6])) continue;

      if (ru !== u) continue;

      const rp = getPropertyByNameOrKeyword_(rpName);
      if (!rp || rp.code !== prop.code) continue;

      // Name scoring: if no queryName provided, accept all with neutral score
      const score = qn ? scoreNameMatch_(qnLower, rname) : 100;
      if (qn && score <= 0) continue;

      // Store as +1XXXXXXXXXX (consistent everywhere)
      found.push({ phone: "+1" + d10, name: rname, score: score });
    }

    // Dedupe by phone, keep best score
    const best = {};
    found.forEach(x => {
      if (!best[x.phone] || x.score > best[x.phone].score) best[x.phone] = x;
    });

    return Object.keys(best)
      .map(k => best[k])
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }




  function lookupTenantByPhoneDigits_(phoneDigits) {
    const sh = getSheet_("Tenants");
    const last = sh.getLastRow();
    if (last < 2) return null;

    const target = String(phoneDigits || "").replace(/\D/g, "").slice(-10);
    if (!target) return null;

    const n = last - 1;

    const COL_PROPERTY_NAME = 1;
    const COL_UNIT = 2;
    const COL_PHONE = 3;
    const COL_ACTIVE = 7;

    const phones = sh.getRange(2, COL_PHONE, n, 1).getValues();
    const actives = sh.getRange(2, COL_ACTIVE, n, 1).getValues();

    for (let i = 0; i < n; i++) {
      const a = String(actives[i][0] || "").trim().toLowerCase();
      const isActive = (actives[i][0] === true) || (a === "true" || a === "yes" || a === "y" || a === "1");
      if (!isActive) continue;

      const raw = phones[i][0];
      const d = normalizePhoneDigits_(raw);
      const d10 = d ? String(d).slice(-10) : "";

      if (d10 && d10 === target) {
        const row = i + 2;
        const propertyName = String(sh.getRange(row, COL_PROPERTY_NAME).getValue() || "").trim();
        const unit = String(sh.getRange(row, COL_UNIT).getValue() || "").trim();

        const p = getPropertyByNameOrKeyword_(propertyName);
        if (!p) return null;

        return { propertyCode: p.code, propertyName: p.name, unit };
      }
    }
    return null;
  }





  function ensureTenantsSheet_() {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    let sh = ss.getSheetByName(TENANTS_SHEET_NAME);

    if (!sh) {
      sh = ss.insertSheet(TENANTS_SHEET_NAME);
      sh.appendRow([
        "Property",
        "Unit",
        "Phone",
        "Name",
        "UpdatedAt",
        "Notes",
        "Active"
      ]);
    }

    return sh;
  }





  function getSheetSafe_(name) {
    try {
      const ss = SpreadsheetApp.getActive();
      const sh = ss.getSheetByName(name);
      return sh || null;
    } catch (_) {
      return null;
    }
  }


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (dependency wave 2)
// tenant matching helpers
// ─────────────────────────────────────────────────────────────────


  function isTenantActive_(activeRaw) {
    if (activeRaw === true) return true;
    var a = String(activeRaw || "").trim().toLowerCase();
    return (a === "yes" || a === "true" || a === "y" || a === "1");
  }




  function normalizeName_(s) {
    return String(s || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  }



  function scoreNameMatch_(queryName, rowName) {
    const q = normalizeName_(queryName);
    const r = normalizeName_(rowName);
    if (!q || !r) return 0;
    if (q === r) return 100;
    if (r.startsWith(q) || q.startsWith(r)) return 85;   // john vs johnathan
    if (r.includes(q) || q.includes(r)) return 70;
    return 0;
  }





  function isAddressInContext_(text, addr) {
    const t = String(text || "").toLowerCase();
    const num = String(addr.num);

    // must contain the number as a whole token
    if (!new RegExp("\\b" + num + "\\b").test(t)) return false;

    // A) number near a hint (0–3 words between)
    // catches: "618 westfield", "702 pennsylvania", "318 west grand"
    for (let i = 0; i < (addr.hints || []).length; i++) {
      const h = String(addr.hints[i]).toLowerCase();
      const re1 = new RegExp("\\b" + num + "\\b(?:\\s+\\w+){0,3}\\s+" + escRe_(h) + "\\b", "i");
      const re2 = new RegExp("\\b" + escRe_(h) + "\\b(?:\\s+\\w+){0,3}\\s+\\b" + num + "\\b", "i");
      if (re1.test(t) || re2.test(t)) return true;
    }

    // B) number followed by street suffix
    // catches: "705 newark ave", "57 murray st"
    for (let j = 0; j < (addr.suffixes || []).length; j++) {
      const suf = String(addr.suffixes[j]).toLowerCase();
      const reS = new RegExp("\\b" + num + "\\b(?:\\s+\\w+){0,2}\\s+\\b" + escRe_(suf) + "\\b", "i");
      if (reS.test(t)) return true;
    }

    return false;
  }
