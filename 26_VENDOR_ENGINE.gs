/**
 * VENDOR_ENGINE.gs — Propera vendor dispatch & SMS lane
 *
 * OWNS:
 *   - Vendors sheet read model, lookup by id/phone/digits
 *   - Dispatch SMS to vendor, accept/decline/availability parsing
 *   - Tenant + manager notifications tied to vendor decisions
 *   - Last-ticket shorthand for vendor replies
 *
 * DOES NOT OWN (never add these here):
 *   - Staff assignment (→ STAFF_RESOLVER / MAIN assignTicketFromRow_ staff branch)
 *   - Lifecycle policy truth (→ LIFECYCLE_ENGINE); wiTransition_ is invoked as integration
 *
 * ENTRY POINTS:
 *   - readVendors_, getVendorById_, getVendorByPhone_, getVendorByPhoneDigits_
 *   - notifyVendorForTicket_, assignVendorFromRow_
 *   - handleVendorAcceptDecline_, handleVendorAvailabilityOnly_
 *   - notifyTenantVendorScheduled_, notifyManagerVendorDecision_
 *
 * DEPENDENCIES (reads from):
 *   - COL, SHEET column map; getSheetSafe_; tenantMsg_, renderTenantKey_; sendSms_, sendRouterSms_
 *   - normalizePhoneDigits_; ctxGet_; findWorkItemIdByTicketRow_; wiTransition_; logDevSms_; BRAND
 *
 * FUTURE MIGRATION NOTE:
 *   - Becomes vendor-dispatch microservice; sheet reads → vendor directory API
 */

// ─────────────────────────────────────────────────────────────────
// VENDOR ENGINE — Phase 8 extraction from PROPERA MAIN.gs
// ─────────────────────────────────────────────────────────────────
// Vendor messaging (template-key only, GSM-7 safe by template discipline)
function vendorMsg_(key, lang, vars) {
  // Reuse your Templates sheet + renderer (same as tenantMsg_ backing store)
  // Keep vendor content ASCII/GSM-7 in the template bodies.
  return tenantMsg_(String(key || ""), String(lang || "en").toLowerCase(), vars || {});
}

/**
* Build vendor dispatch SMS body via template VENDOR_DISPATCH_REQUEST only.
* GSM-7 safe: cleans placeholders (no em dash, smart quotes, etc.).
* Does not add template row to any file; template must exist on Templates sheet.
*/
function buildVendorDispatchMsg_(lang, data) {
  var safeLang = String(lang || "en").toLowerCase();
  function clean_(s) {
    s = String(s || "");
    s = s.replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        .replace(/[–—]/g, "-")
        .replace(/…/g, "...")
        .replace(/\t/g, " ");
    return s;
  }
  var payload = {
    propertyName: clean_(data.propertyName),
    unit: clean_(data.unit),
    category: clean_(data.category),
    issue: clean_(data.issue),
    exampleWindow: clean_(data.exampleWindow || "Tomorrow 8-10am"),
    exampleReason: clean_(data.exampleReason || "Too busy")
  };
  return renderTenantKey_("VENDOR_DISPATCH_REQUEST", safeLang, payload);
}

function replyVendorKey_(creds, toPhone, key, lang, vars) {
  replyVendor_(creds, toPhone, vendorMsg_(key, lang, vars));
}

// Reads Vendors tab into a normalized object list
function readVendors_() {
  const sh = getSheetSafe_("Vendors");
  if (!sh) return [];

  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];

  const headers = values[0].map(h => String(h || "").trim());
  const idx = {};
  headers.forEach((h, i) => { if (h) idx[h] = i; });

  // Required columns
  const iId = idx["VendorId"];
  const iName = idx["VendorName"];
  const iPhone = idx["PhoneE164"];
  const iActive = idx["Active"];

  if ([iId, iName, iPhone, iActive].some(v => v === undefined)) {
    // Missing required headers
    return [];
  }

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    const id = String(row[iId] || "").trim();
    if (!id) continue;

    const name = String(row[iName] || "").trim();
    const phone = normalizePhoneE164_(String(row[iPhone] || "").trim());
    const activeRaw = row[iActive];

    const active =
      activeRaw === true ||
      String(activeRaw || "").toLowerCase().trim() === "true" ||
      String(activeRaw || "").toLowerCase().trim() === "yes" ||
      String(activeRaw || "").trim() === "1";

    out.push({
      id,
      name: name || id,
      phone,          // +1xxxxxxxxxx
      phoneDigits: normalizePhoneDigits_(phone), // 10/11 digits (for matching inbound)
      active
    });
  }
  return out;
}

function normalizePhoneE164_(phone) {
  const d = String(phone || "").replace(/[^\d]/g, "");
  if (!d) return "";
  // If 10 digits, assume US
  if (d.length === 10) return "+1" + d;
  // If 11 digits starting with 1
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  // Otherwise best effort
  return phone.startsWith("+") ? phone : ("+" + d);
}

// Lookup vendor by VendorId (for manager assignment)
function getVendorById_(vendorId) {
  const id = String(vendorId || "").trim();
  if (!id) return null;

  const vendors = readVendors_();
  for (let i = 0; i < vendors.length; i++) {
    if (vendors[i].active && vendors[i].id === id) return vendors[i];
  }
  return null;
}

// Lookup vendor by inbound phone (for vendor SMS replies)
function getVendorByPhone_(fromPhoneRaw) {
  const digits = normalizePhoneDigits_(fromPhoneRaw);
  if (!digits) return null;

  const vendors = readVendors_();
  for (let i = 0; i < vendors.length; i++) {
    if (!vendors[i].active) continue;
    if (vendors[i].phoneDigits && vendors[i].phoneDigits.endsWith(digits.slice(-10))) {
      return vendors[i];
    }
  }
  return null;
}

function notifyVendorForTicket_(creds, vendor, ctx) {
  try {
    const vPhone = String(vendor && vendor.phone ? vendor.phone : "").trim();
    const vId = String(vendor && vendor.id ? vendor.id : "").trim();
    const tId = String(ctx && ctx.ticketId ? ctx.ticketId : "").trim();

    // ------------------------------------------------
    // DISPATCH GUARD - prevent duplicate vendor SMS
    // ------------------------------------------------
    var sheet = ctx && ctx.sheet;
    var row = ctx && ctx.row;
    var dispatchMarker = "VDISP:" + vId;
    var notes = "";
    if (sheet && row) {
      notes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
      if (notes.indexOf(dispatchMarker) !== -1) {
        logDevSms_(
          "",
          "",
          "VENDOR_DISPATCH_SKIPPED ticket=" + tId +
          " vendor=" + vId +
          " reason=already_dispatched"
        );
        return;
      }
    }

    // Always log start marker (even in DEV_MODE)
    logDevSms_(
      vPhone || "(missing phone)",
      "DBG_NOTIFY_VENDOR start ticket=" + tId + " vendor=" + vId,
      "DBG_NOTIFY_VENDOR"
    );

    if (!creds) {
      logDevSms_(vPhone || "(missing phone)", "DBG_NOTIFY_VENDOR missing creds", "DBG_NOTIFY_VENDOR");
      return;
    }
    if (!vPhone) {
      logDevSms_("(missing phone)", "DBG_NOTIFY_VENDOR vendor.phone is blank", "DBG_NOTIFY_VENDOR");
      return;
    }

    const sid = creds.TWILIO_SID;
    const token = creds.TWILIO_TOKEN;
    const fromNumber = creds.TWILIO_NUMBER;

    // Build message (safe + deterministic)
    const propertyDisplayName = String((ctx && ctx.property) || "").trim();
    const unit = String((ctx && ctx.unit) || "").trim();
    const category = String((ctx && ctx.category) || "").trim();
    const issueShort = String((ctx && ctx.msg) || "").trim();

    // Debug what we received
    logDevSms_(
      vPhone,
      "DBG_NOTIFY_VENDOR ctx.category=[" + category + "] ctx.msg.len=" + issueShort.length,
      "DBG_NOTIFY_VENDOR"
    );

    // ✅ Save last ticket for YES/NO shorthand
    try { setVendorLastTicket_(vendor, tId); } catch (_) {}

    var vendorLang = "en";
    var msg = buildVendorDispatchMsg_(vendorLang, {
      propertyName: propertyDisplayName,
      unit: unit,
      category: category,
      issue: issueShort,
      exampleWindow: "Tomorrow 8-10am",
      exampleReason: "Cannot make it"
    });

    sendRouterSms_(vPhone, msg, "VENDOR_DISPATCH_REQUEST");
    logDevSms_(
      vPhone,
      "",
      "VENDOR_DISPATCH_SENT ticket=" + tId + " vendor=" + String(vendor && (vendor.name || vendor.id) || "")
    );
    // mark dispatch so it cannot send twice
    if (sheet && row) {
      var newNotes = notes ? notes + " | " + dispatchMarker : dispatchMarker;
      sheet.getRange(row, COL.VENDOR_NOTES).setValue(newNotes);
    }
  } catch (e) {
    try { logDevSms_("(crash)", "notifyVendorForTicket_ crash: " + e, "DBG_NOTIFY_VENDOR"); } catch (_) {}
    Logger.log("notifyVendorForTicket_ crash: " + e);
  }
}

function testNotifyVendor_debug2() {
  const vendor = getVendorById_("VEND_PLUMB_01");
  notifyVendorForTicket_(
    { TWILIO_SID: "TEST", TWILIO_TOKEN: "TEST", TWILIO_NUMBER: "+10000000000" },
    vendor,
    { ticketId: "TEST-123", property: "The Grand at Penn", unit: "305", category: "Plumbing", msg: "Leak test" }
  );
  Logger.log("done debug2");
}

function getVendorByPhoneDigits_(digits10) {
  const want = String(digits10 || "").replace(/\D/g, "").slice(-10);
  if (!want) return null;

  // ✅ MUST use the same vendor source as getVendorById_
  const vendors = readVendors_(); // <-- this is key
  if (!vendors || !vendors.length) return null;

  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    if (!v) continue;
    if (v.active === false) continue;

    const dA = String(v.phoneDigits || "").replace(/\D/g, "").slice(-10);
    const dB = String(v.phone || "").replace(/\D/g, "").slice(-10);

    if (dA === want || dB === want) return v;
  }
  return null;
}



function findTicketRowById_(sheet, ticketId) {
  const tid = String(ticketId || "").trim();
  if (!tid) return 0;

  const tf = sheet.getRange(1, COL.TICKET_ID, sheet.getLastRow(), 1)
    .createTextFinder(tid)
    .matchEntireCell(true)
    .findNext();

  return tf ? tf.getRow() : 0;
}

function handleVendorAcceptDecline_(vendor, sheet, bodyTrim, creds) {
  const text = String(bodyTrim || "").trim();
  if (!text) return false;

  const up = text.toUpperCase();
  const vLang = String(vendor && vendor.lang ? vendor.lang : "en").toLowerCase();

  // Helper: determine ticket id from explicit command or last ticket
  function resolveTicketId_(explicitTid) {
    const tid = String(explicitTid || "").trim();
    if (tid) return tid;
    return getVendorLastTicket_(vendor); // may be ""
  }

  // Helper: basic ticketId token check (keeps it simple + safe)
  function looksLikeTicketId_(tok) {
    const t = String(tok || "").trim();
    return (t.length >= 6 && t.indexOf("-") >= 0);
  }

  // -----------------------------
  // YES / NO shorthand
  // YES [ticketId] [availability...]
  // NO  [ticketId] [optional reason...]
  // -----------------------------
  let m = up.match(/^(YES|Y|NO|N)\b(?:\s+(.+))?$/i);
  if (m) {
    const head = String(m[1] || "").toUpperCase();
    const rest = String(m[2] || "").trim(); // everything after YES/NO

    // Optional ticketId as first token after YES/NO
    let explicitTid = "";
    let tailRaw = rest;

    if (rest) {
      const parts = rest.split(/\s+/);
      const first = parts[0];
      if (looksLikeTicketId_(first)) {
        explicitTid = first;
        tailRaw = rest.substring(first.length).trim();
      }
    }

    const ticketId = resolveTicketId_(explicitTid);

    if (!ticketId) {
      replyVendorKey_(creds, vendor.phone, "VENDOR_NEED_TICKET_ID", vLang, {});
      return true;
    }

    const row = findTicketRowById_(sheet, ticketId);
    if (row < 2) {
      replyVendorKey_(creds, vendor.phone, "VENDOR_TICKET_NOT_FOUND", vLang, { ticketId: ticketId });
      return true;
    }

    // NO / N => Decline (reason optional)
    if (head === "NO" || head === "N") {
      const reasonRaw = String(tailRaw || "").trim();

      sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
      sheet.getRange(row, COL.VENDOR_STATUS).setValue("Declined");

      sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
      const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
      const noteLine =
        "Declined by " + (vendor.name || "Vendor") +
        (reasonRaw ? (": " + reasonRaw) : "") +
        " @ " + new Date().toLocaleString();
      sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

      replyVendorKey_(creds, vendor.phone, "VENDOR_DECLINE_RECORDED", vLang, { ticketId: ticketId });

      // ✅ Manager alert (decline)  (OPTIONAL: template this too later)
      notifyManagerVendorDecision_(
        creds,
        ticketId + " declined by " + (vendor.name || "Vendor") + (reasonRaw ? (" - " + reasonRaw) : "")
      );

      // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor declined, internal must reassign)
      try {
        var decWiId = findWorkItemIdByTicketRow_(row);
        if (decWiId) wiTransition_(decWiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
      } catch (_) {}

      return true;
    }

    // YES / Y => Accept (availability required)
    const apptRaw = String(tailRaw || "").trim();

    if (!apptRaw) {
      replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_NEED_WINDOW", vLang, { ticketId: ticketId });

      // ▸ PATCH: WI → WAIT_VENDOR / AVAILABILITY (accepted but no window yet)
      try {
        var avWiId = findWorkItemIdByTicketRow_(row);
        if (avWiId) wiTransition_(avWiId, "WAIT_VENDOR", "AVAILABILITY", String(vendor.phone || ""), "WI_WAIT_VENDOR");
      } catch (_) {}

      return true; // ⚠️ no manager alert yet (no window)
    }

    sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
    sheet.getRange(row, COL.VENDOR_STATUS).setValue("Accepted");

    sheet.getRange(row, COL.VENDOR_APPT).setNumberFormat("@");
    sheet.getRange(row, COL.VENDOR_APPT).setValue(apptRaw);

    sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
    const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
    const noteLine = "Accepted by " + (vendor.name || "Vendor") + " @ " + new Date().toLocaleString();
    sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

    sheet.getRange(row, COL.STATUS).setValue("Scheduled");

    replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_SCHEDULED", vLang, { appt: apptRaw, ticketId: ticketId });

    // ✅ Tenant confirmation (vendor accepted + window)
    notifyTenantVendorScheduled_(sheet, row, ticketId, (vendor.name || "Vendor"), apptRaw);

    // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor confirmed, ops takes over)
    try {
      var accWiId = findWorkItemIdByTicketRow_(row);
      if (accWiId) wiTransition_(accWiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
    } catch (_) {}

    return true;
  }

  // -----------------------------
  // ACCEPT <ticketId> <appt...>
  // -----------------------------
  m = up.match(/^ACCEPT\s+(\S+)(?:\s+(.+))?$/i);
  if (m) {
    const ticketId = resolveTicketId_(m[1]);
    const apptRaw = String(text.replace(/^ACCEPT\s+\S+/i, "") || "").trim();

    const row = findTicketRowById_(sheet, ticketId);
    if (row < 2) {
      replyVendorKey_(creds, vendor.phone, "VENDOR_TICKET_NOT_FOUND", vLang, { ticketId: ticketId });
      return true;
    }

    if (!apptRaw) {
      replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_NEED_WINDOW_ACCEPT_CMD", vLang, { ticketId: ticketId });

      // ▸ PATCH: WI → WAIT_VENDOR / AVAILABILITY (accepted but no window)
      try {
        var av2WiId = findWorkItemIdByTicketRow_(row);
        if (av2WiId) wiTransition_(av2WiId, "WAIT_VENDOR", "AVAILABILITY", String(vendor.phone || ""), "WI_WAIT_VENDOR");
      } catch (_) {}

      return true; // ⚠️ no manager alert yet (no window)
    }

    sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
    sheet.getRange(row, COL.VENDOR_STATUS).setValue("Accepted");

    sheet.getRange(row, COL.VENDOR_APPT).setNumberFormat("@");
    sheet.getRange(row, COL.VENDOR_APPT).setValue(apptRaw);

    sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
    const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
    const noteLine = "Accepted by " + (vendor.name || "Vendor") + " @ " + new Date().toLocaleString();
    sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

    sheet.getRange(row, COL.STATUS).setValue("Scheduled");

    replyVendorKey_(creds, vendor.phone, "VENDOR_ACCEPT_SCHEDULED", vLang, { appt: apptRaw, ticketId: ticketId });

    // ✅ Tenant confirmation (vendor accepted + window)
    notifyTenantVendorScheduled_(sheet, row, ticketId, (vendor.name || "Vendor"), apptRaw);

    // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor confirmed, ops takes over)
    try {
      var acc2WiId = findWorkItemIdByTicketRow_(row);
      if (acc2WiId) wiTransition_(acc2WiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
    } catch (_) {}

    return true;
  }

  // -----------------------------
  // DECLINE <ticketId> <optional reason>
  // -----------------------------
  m = up.match(/^DECLINE\s+(\S+)(?:\s+(.+))?$/i);
  if (m) {
    const ticketId = resolveTicketId_(m[1]);
    const reasonRaw = String(text.replace(/^DECLINE\s+\S+/i, "") || "").trim();

    const row = findTicketRowById_(sheet, ticketId);
    if (row < 2) {
      replyVendorKey_(creds, vendor.phone, "VENDOR_TICKET_NOT_FOUND", vLang, { ticketId: ticketId });
      return true;
    }

    sheet.getRange(row, COL.VENDOR_STATUS).setNumberFormat("@");
    sheet.getRange(row, COL.VENDOR_STATUS).setValue("Declined");

    sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
    const prevNotes = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
    const noteLine =
      "Declined by " + (vendor.name || "Vendor") +
      (reasonRaw ? (": " + reasonRaw) : "") +
      " @ " + new Date().toLocaleString();
    sheet.getRange(row, COL.VENDOR_NOTES).setValue(prevNotes ? (prevNotes + " | " + noteLine) : noteLine);

    replyVendorKey_(creds, vendor.phone, "VENDOR_DECLINE_RECORDED", vLang, { ticketId: ticketId });

    // ✅ Manager alert (decline)
    notifyManagerVendorDecision_(
      creds,
      ticketId + " declined by " + (vendor.name || "Vendor") + (reasonRaw ? (" - " + reasonRaw) : "")
    );

    // ▸ PATCH: WI → WAIT_INTERNAL / DISPATCH (vendor declined, internal must reassign)
    try {
      var dec2WiId = findWorkItemIdByTicketRow_(row);
      if (dec2WiId) wiTransition_(dec2WiId, "WAIT_INTERNAL", "DISPATCH", String(vendor.phone || ""), "WI_VENDOR_HANDOFF");
    } catch (_) {}

    return true;
  }

  return false; // not a vendor command
}




function replyVendor_(creds, toPhone, text) {
  const msg = String(text || "").trim();
  if (!msg) return;

  // ✅ DO NOT log here. sendSms_ already logs (DEV_MODE or LIVE_ATTEMPT).
  sendSms_(
    creds && creds.TWILIO_SID,
    creds && creds.TWILIO_TOKEN,
    creds && creds.TWILIO_NUMBER,
    toPhone,
    msg
  );
}


function handleVendorAvailabilityOnly_(vendor, sheet, bodyTrim, creds) {
  const avail = extractVendorAvailabilityText_(bodyTrim);
  if (!avail) return false;

  const vendorId = String(vendor && vendor.id ? vendor.id : "").trim();
  if (!vendorId) return false;

  const rows = findActiveVendorTicketRows_(sheet, vendorId) || [];

  // 0 active assignments -> can't schedule anything
  if (!rows.length) {
    replyVendor_(creds, vendor.phone, tenantMsg_("VENDOR_CONFIRM_INSTRUCTIONS", "en", {
      brandName: BRAND.name,
      teamName: BRAND.team
    }));
    try { logDevSms_(vendor.phone, "VENDOR_AVAIL_ONLY no_active avail=[" + avail + "]", "VENDOR_AVAIL"); } catch (_) {}
    return true;
  }

  // 2+ active assignments -> require ticket id (no guessing)
  if (rows.length > 1) {
    const list = rows.slice(0, 5).map(r => {
      const tid = String(sheet.getRange(r, COL.TICKET_ID).getValue() || "").trim();
      return tid ? ("- " + tid) : ("- Row " + r);
    }).join("\n");

    replyVendor_(creds, vendor.phone, tenantMsg_("VENDOR_MULTI_PENDING_NEED_TID", "en", {
      availability: avail,
      ticketList: list
    }));

    try { logDevSms_(vendor.phone, "VENDOR_AVAIL_ONLY multi_active n=" + rows.length + " avail=[" + avail + "]", "VENDOR_AVAIL"); } catch (_) {}
    return true;
  }

  // Exactly 1 active assignment -> implicit YES
  try { logDevSms_(vendor.phone, "VENDOR_AVAIL_ONLY implicit_yes avail=[" + avail + "]", "VENDOR_AVAIL"); } catch (_) {}
  return !!handleVendorAcceptDecline_(vendor, sheet, "YES " + avail, creds);
}

function findActiveVendorTicketRows_(sheet, vendorId) {
  const sh = sheet || SpreadsheetApp.getActive().getSheetByName("Sheet1");
  const vid = String(vendorId || "").trim();
  if (!sh || !vid) return [];

  const last = sh.getLastRow();
  if (last < 2) return [];

  const aTypeCol = COL.ASSIGNED_TYPE;
  const aIdCol   = COL.ASSIGNED_ID;
  const vStatCol = COL.VENDOR_STATUS;

  // Minimal guards
  if (!aTypeCol || !aIdCol || !vStatCol) return [];

  const aType = sh.getRange(2, aTypeCol, last - 1, 1).getValues();
  const aId   = sh.getRange(2, aIdCol,   last - 1, 1).getValues();
  const vStat = sh.getRange(2, vStatCol, last - 1, 1).getValues();

  const out = [];
  for (let i = 0; i < last - 1; i++) {
    const type = String(aType[i][0] || "").trim().toLowerCase();
    const id   = String(aId[i][0]   || "").trim();
    const vs   = String(vStat[i][0] || "").trim().toLowerCase();

    // Active = assigned to this vendor + not finished
    // Adjust if your statuses differ
    const isAssigned = (type === "vendor" && id === vid);
    const isActive   = (vs === "" || vs === "contacted" || vs === "accepted" || vs === "scheduled");

    if (isAssigned && isActive) out.push(i + 2); // row index in sheet
  }

  // newest first (usually best)
  out.sort((r1, r2) => r2 - r1);
  return out;
}


function extractVendorAvailabilityText_(s) {
  const t = String(s || "").trim();
  if (!t) return "";

  const x = t.replace(/[–—]/g, "-").toLowerCase();

  const hasDay =
    /\b(today|tomorrow|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/.test(x);

  const hasPart = /\b(morning|afternoon|evening)\b/.test(x);

  const hasTime =
    // Range: 8-10am, 8:30-10, 8 - 10pm
    /\b\d{1,2}(:\d{2})?\s?(am|pm)?\s?-\s?\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(x) ||
    // With minutes: 10:30am
    /\b\d{1,2}:\d{2}\s?(am|pm)\b/.test(x) ||
    // ✅ NEW: Simple time: 2pm, 2 pm, 11am
    /\b\d{1,2}\s?(am|pm)\b/.test(x);

  return (hasDay && (hasTime || hasPart)) ? t : "";
}


function vendorLastTicketKey_(vendor) {
  const vid = String(vendor && vendor.id ? vendor.id : "").trim();
  return vid ? ("VENDOR_LAST_TICKET_" + vid) : "";
}

function setVendorLastTicket_(vendor, ticketId) {
  const key = vendorLastTicketKey_(vendor);
  const tid = String(ticketId || "").trim();
  if (!key || !tid) return;
  PropertiesService.getScriptProperties().setProperty(key, tid);
}

function getVendorLastTicket_(vendor) {
  const key = vendorLastTicketKey_(vendor);
  if (!key) return "";
  return String(PropertiesService.getScriptProperties().getProperty(key) || "").trim();
}

function notifyManagerVendorDecision_(creds, text) {
  const to = String(PropertiesService.getScriptProperties().getProperty("ONCALL_NUMBER") || "").trim();
  if (!to || !text) return;

  sendSms_(
    creds && creds.TWILIO_SID,
    creds && creds.TWILIO_TOKEN,
    creds && creds.TWILIO_NUMBER,
    to,
    String(text || "").trim(),
    "MANAGER_ALERT"
  );
}

// ===================================================================
// ===== VENDOR → TENANT CONFIRMATION (Compass-aligned) ===============
// Trigger: vendor sends YES <availability> for a dispatched ticket.
// Location: vendor lane handler calls this after writing ticket fields.
// ===================================================================
function notifyTenantVendorScheduled_(sheet, row, ticketId, vendorName, apptRaw) {
  try {
    const toPhone = String(sheet.getRange(row, COL.PHONE).getValue() || "").trim();
    if (!toPhone) return;

    // Dedupe: if we already sent a tenant confirmation for this ticket, do nothing.
    // (We store a marker in VendorNotes to avoid adding new columns.)
    const notesCell = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "");
    if (notesCell && /TENANT_CONF_SENT/i.test(notesCell)) return;

    const ctx = ctxGet_(toPhone);
    const lang = String((ctx && ctx.lang) || "en").toLowerCase();

    const property = String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim();
    const unit = String(sheet.getRange(row, COL.UNIT).getValue() || "").trim();
    const category = String(sheet.getRange(row, COL.CAT_FINAL).getValue() || sheet.getRange(row, COL.CAT).getValue() || "").trim();

    const msg = renderTenantKey_(
      "TENANT_VENDOR_SCHEDULED",
      lang,
      {
        property: property,
        unit: unit,
        category: category,
        appt: String(apptRaw || "").trim(),
        vendorName: String(vendorName || "").trim(),
        ticketId: String(ticketId || "").trim()
      }
    );

    sendRouterSms_(toPhone, msg, "TENANT_VENDOR_SCHEDULED");

    // Mark sent (best-effort) so duplicate vendor YES replies don't spam the tenant.
    try {
      const stamp = "TENANT_CONF_SENT @ " + new Date().toLocaleString();
      const cur = String(sheet.getRange(row, COL.VENDOR_NOTES).getValue() || "").trim();
      sheet.getRange(row, COL.VENDOR_NOTES).setNumberFormat("@");
      sheet.getRange(row, COL.VENDOR_NOTES).setValue(cur ? (cur + " | " + stamp) : stamp);
    } catch (_) {}
  } catch (err) {
    try { logDevSms_("", "", "TENANT_VENDOR_SCHEDULED_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
  }
}

function assignVendorFromRow_(creds, sheet, row, opt) {
  assignTicketFromRow_(creds, sheet, row, opt);
}


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// assignTicketFromRow_ (full; staff + vendor)
// ─────────────────────────────────────────────────────────────────



  function assignTicketFromRow_(creds, sheet, row, opt) {
    opt = opt || {};
    const mode = opt.mode || "MANUAL"; // MANUAL | AUTO
    const assignedBy = opt.assignedBy || (mode === "AUTO" ? "AUTO" : "Manager");

    const assignedType = String(sheet.getRange(row, COL.ASSIGNED_TYPE).getValue() || "").trim(); // Vendor | Staff
    const assignedId   = String(sheet.getRange(row, COL.ASSIGNED_ID).getValue() || "").trim();
    if (!assignedType || !assignedId) return;

    const ticketId = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
    const property = String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim();
    const unit     = String(sheet.getRange(row, COL.UNIT).getValue() || "").trim();

    // ✅ ONLY use Category (your AI handler sets this)
    const cat      = String(sheet.getRange(row, COL.CAT).getValue() || "").trim();

    const msg      = String(sheet.getRange(row, COL.MSG).getValue() || "").trim();

    const vendorStatusCell = sheet.getRange(row, COL.VENDOR_STATUS);
    const vendorStatusNow  = String(vendorStatusCell.getValue() || "").trim();

    // -------------------------
    // VENDOR ASSIGNMENT
    // -------------------------
    if (assignedType === "Vendor") {
      const vendor = getVendorById_(assignedId);
      if (!vendor) {
        vendorStatusCell.setNumberFormat("@");
        vendorStatusCell.setValue("VendorNotFound");
        return;
      }

      const assigneeName = String(vendor.name || assignedId).trim();

      // Write assignment fields
      sheet.getRange(row, COL.ASSIGNED_TO).setValue(assigneeName);     // legacy
      sheet.getRange(row, COL.ASSIGNED_NAME).setValue(assigneeName);
      sheet.getRange(row, COL.ASSIGNED_AT).setValue(new Date());
      sheet.getRange(row, COL.ASSIGNED_BY).setValue(assignedBy);

      // ✅ Send only once
      if (!vendorStatusNow) {
        vendorStatusCell.setNumberFormat("@");
        vendorStatusCell.setValue("Contacted");

        notifyVendorForTicket_(creds, vendor, {
          ticketId: ticketId,
          property: property,
          unit: unit,
          category: cat,   // ✅ will now show "Plumbing"
          msg: msg,
          sheet: sheet,
          row: row
        });

        // ▸ PATCH: WI → WAIT_VENDOR / ACCEPT (vendor was just contacted)
        try {
          var wiId = findWorkItemIdByTicketRow_(row);
          if (wiId) {
            wiTransition_(wiId, "WAIT_VENDOR", "ACCEPT", String(vendor.phone || ""), "WI_WAIT_VENDOR");
          }
        } catch (_) {}
      }
      return;
    }

    // -------------------------
    // STAFF ASSIGNMENT (NO SMS)
    // -------------------------
    if (assignedType === "Staff") {
      const staff = getStaffById_(assignedId);
      if (!staff) return;

      const assigneeName = String(staff.name || assignedId).trim();

      sheet.getRange(row, COL.ASSIGNED_TO).setValue(assigneeName);     // legacy
      sheet.getRange(row, COL.ASSIGNED_NAME).setValue(assigneeName);
      sheet.getRange(row, COL.ASSIGNED_AT).setValue(new Date());
      sheet.getRange(row, COL.ASSIGNED_BY).setValue(assignedBy);
      return;
    }
  }

