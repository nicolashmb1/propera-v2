/**
 * DEV_TOOLS_HARNESS.gs — Propera Dev / Reporting Utilities
 *
 * OWNS:
 *   - Weekly ops PDF report (Grand Management Group layout)
 *   - Editor test harness: COL sanity, Twilio/doPost emulator, batch inbound scenarios, vendor assign sandbox
 *
 * DOES NOT OWN:
 *   - Production routing (calls handleInboundRouter_ / doPost only when you run a test)
 *
 * ENTRY POINTS:
 *   - runGrandWeeklyReport() — PDF export
 *   - runBatchTests() — canned tenant turns (allowlisted phones only)
 *   - emulatorSend(from, body, mode) — sidebar / manual dry-run through doPost
 *   - oneTest() — single Twilio-shaped event via doPost
 *
 * DEPENDENCIES:
 *   - PROPERA MAIN.gs — COL, MAX_COL, TWILIO_*, LOG_SHEET_ID, DIRECTORY_SHEET_NAME
 *   - GATEWAY_WEBHOOK.gs — doPost
 *   - ROUTER_ENGINE, DIRECTORY_SESSION_DAL, VENDOR_ENGINE, MESSAGING_ENGINE — runtime under test
 *
 * FUTURE MIGRATION NOTE:
 *   - Reporting + harness become scheduled jobs or CI; not part of core runtime
 *
 * SECTIONS IN THIS FILE:
 *   1. Weekly PDF report — merged from MaitenanceReport.gs (Phase 0)
 *   2. Schema / COL alignment checks
 *   3. Twilio emulator + sidebar helper
 *   4. Batch test runner + snapshots
 *   5. Vendor assignment sandbox (manual)
 */

// ─────────────────────────────────────────────────────────────────
// WEEKLY OPS REPORT (Grand) — layout Sheet → PDF
// ─────────────────────────────────────────────────────────────────

/** Coerce sheet value to Date (for use when this file runs alone). */
function toDateReport_(v) {
  if (v instanceof Date) return v;
  if (v == null || v === "") return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const GRAND_REPORT_CFG = {
  TICKETS_SHEET_NAME: "Sheet1",
  REPORT_FOLDER_ID: "13ouJhCTz6hskoxVW6EIF2NiuECOGuVQ0",

  // Brand colors (hex without #)
  COLOR: {
    NAVY:        "#1A2B4A",   // header backgrounds, title bar
    GOLD:        "#C9A84C",   // accent stripe
    LIGHT_BLUE:  "#EBF0FA",   // alternating row tint
    WHITE:       "#FFFFFF",
    COMPLETED:   "#D4EDDA",   // soft green bg for completed status
    OPEN:        "#FFF3CD",   // soft amber bg for open status
    IN_PROGRESS: "#CCE5FF",   // soft blue
    WAITING:     "#F8D7DA",   // soft red/pink
    HEADER_TEXT: "#FFFFFF",
    BODY_TEXT:   "#1A1A2E",
    SUBHEAD_BG:  "#2C3E6B",   // section header rows
    SUMMARY_BG:  "#F0F4FA",
  },

  COL: {
    PROPERTY:       2,
    UNIT:           3,
    ISSUE:          4,
    CATEGORY:       5,
    CATEGORY_FINAL: 22,
    TICKET_ID:      15,
    STATUS:         16,
    CLOSED_AT:      25,
    CREATED_AT:     26,
    TICKET_KEY:     50
  }
};

// ======================================================
// ENTRYPOINT
// ======================================================
function runGrandWeeklyReport() {

  const ss    = SpreadsheetApp.getActive();
  const sh    = ss.getSheetByName(GRAND_REPORT_CFG.TICKETS_SHEET_NAME);
  if (!sh) throw new Error("Sheet not found: " + GRAND_REPORT_CFG.TICKETS_SHEET_NAME);
  const rows  = sh.getDataRange().getValues();
  rows.shift(); // remove header row

  const { start, end, snapshot } = getMondayWindow_(new Date());

  const weekly      = [];
  const openBacklog = [];

  rows.forEach(r => {
    const created = toDateForReport_(r[GRAND_REPORT_CFG.COL.CREATED_AT]);
    const status  = String(r[GRAND_REPORT_CFG.COL.STATUS] || "").toLowerCase();

    if (created && created >= start && created < end) weekly.push(r);
    if (status !== "completed") openBacklog.push(r);
  });

  const completedCount = weekly.filter(r =>
    String(r[GRAND_REPORT_CFG.COL.STATUS] || "").toLowerCase() === "completed"
  ).length;
  const openFromWeek = weekly.length - completedCount;

  // ── Build a temporary Spreadsheet for layout ─────────────────────────────
  const tmpSS    = SpreadsheetApp.create("_grand_report_tmp");
  const tmpSheet = tmpSS.getSheets()[0];
  tmpSheet.setName("Report");

  // Landscape + letter via page setup
  const ps = tmpSheet.getParent().getSpreadsheetLocale();  // not used, just note
  // We set page orientation via PDF export URL params below.

  let cursor = 1; // current row (1-indexed)

  // ── TITLE BLOCK ──────────────────────────────────────────────────────────
  cursor = writeTitleBlock_(tmpSheet, cursor, start, end, snapshot);

  // ── SUMMARY KPI CARDS ────────────────────────────────────────────────────
  cursor = writeSummaryBlock_(tmpSheet, cursor, weekly.length, completedCount, openFromWeek, snapshot);

  // ── WEEKLY TICKETS TABLE ─────────────────────────────────────────────────
  cursor = writeSectionHeader_(tmpSheet, cursor, "WEEKLY TICKETS  —  Feb 9 → Feb 16, 2026");
  cursor = writeWeeklyTable_(tmpSheet, cursor, weekly);

  cursor++; // blank spacer row

  // ── OPEN BACKLOG TABLE ───────────────────────────────────────────────────
  cursor = writeSectionHeader_(tmpSheet, cursor, "OPEN BACKLOG SNAPSHOT  —  As of " + fmtDate_(snapshot));
  cursor = writeOpenTable_(tmpSheet, cursor, openBacklog, snapshot);

  // ── FOOTER ───────────────────────────────────────────────────────────────
  cursor++;
  writeFooter_(tmpSheet, cursor, snapshot);

  // ── Set column widths (A–I) ───────────────────────────────────────────────
  setColumnWidths_(tmpSheet);

  // ── Export to PDF ─────────────────────────────────────────────────────────
  SpreadsheetApp.flush();
  const pdfBlob = exportSheetAsPdf_(tmpSS, tmpSheet);

  const pdfName =
    "The Grand - Weekly Ops Report (" + fmtDate_(start) + " to " + fmtDate_(end) + ").pdf";

  const folder = DriveApp.getFolderById(GRAND_REPORT_CFG.REPORT_FOLDER_ID);
  folder.createFile(pdfBlob).setName(pdfName);

  // Clean up temp spreadsheet
  DriveApp.getFileById(tmpSS.getId()).setTrashed(true);

  Logger.log("✅ Report saved: " + pdfName);
}


// ======================================================
// BLOCK WRITERS
// ======================================================

/** Big navy title bar spanning columns A–I */
function writeTitleBlock_(sh, row, start, end, snapshot) {
  const C = GRAND_REPORT_CFG.COLOR;

  // Row 1 — Main title
  const titleRange = sh.getRange(row, 1, 1, 9);
  titleRange.merge()
    .setValue("THE GRAND MANAGEMENT GROUP")
    .setBackground(C.NAVY)
    .setFontColor(C.HEADER_TEXT)
    .setFontSize(18)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(row, 42);
  row++;

  // Row 2 — Gold accent stripe
  const accentRange = sh.getRange(row, 1, 1, 9);
  accentRange.merge()
    .setValue("Weekly Operations Report")
    .setBackground(C.GOLD)
    .setFontColor(C.NAVY)
    .setFontSize(12)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(row, 26);
  row++;

  // Row 3 — Reporting window
  const metaRange = sh.getRange(row, 1, 1, 9);
  metaRange.merge()
    .setValue(
      "Reporting Window:  " + fmtDate_(start) + "  →  " + fmtDate_(end) +
      "       |       Backlog Snapshot As Of:  " + fmtDate_(snapshot)
    )
    .setBackground(C.NAVY)
    .setFontColor("#AABBD0")
    .setFontSize(9)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setFontStyle("italic");
  sh.setRowHeight(row, 22);
  row++;

  return row + 1; // +1 blank spacer
}

/** Three KPI summary boxes side-by-side */
function writeSummaryBlock_(sh, row, total, completed, stillOpen, snapshot) {
  const C = GRAND_REPORT_CFG.COLOR;

  // Label row
  sh.getRange(row, 1, 1, 3).merge().setValue("Total Created").setBackground(C.SUBHEAD_BG)
    .setFontColor(C.HEADER_TEXT).setFontSize(9).setHorizontalAlignment("center").setFontWeight("bold");
  sh.getRange(row, 4, 1, 3).merge().setValue("Completed").setBackground(C.SUBHEAD_BG)
    .setFontColor(C.HEADER_TEXT).setFontSize(9).setHorizontalAlignment("center").setFontWeight("bold");
  sh.getRange(row, 7, 1, 3).merge().setValue("Still Open from Week").setBackground(C.SUBHEAD_BG)
    .setFontColor(C.HEADER_TEXT).setFontSize(9).setHorizontalAlignment("center").setFontWeight("bold");
  sh.setRowHeight(row, 20);
  row++;

  // Value row
  sh.getRange(row, 1, 1, 3).merge().setValue(total)
    .setBackground(C.SUMMARY_BG).setFontSize(28).setFontWeight("bold")
    .setFontColor(C.NAVY).setHorizontalAlignment("center").setVerticalAlignment("middle");
  sh.getRange(row, 4, 1, 3).merge().setValue(completed)
    .setBackground("#EAF7EE").setFontSize(28).setFontWeight("bold")
    .setFontColor("#1A6B35").setHorizontalAlignment("center").setVerticalAlignment("middle");
  sh.getRange(row, 7, 1, 3).merge().setValue(stillOpen)
    .setBackground("#FFF8E7").setFontSize(28).setFontWeight("bold")
    .setFontColor("#8B5E0A").setHorizontalAlignment("center").setVerticalAlignment("middle");
  sh.setRowHeight(row, 52);
  row++;

  return row + 1; // spacer
}

/** Dark navy full-width section header */
function writeSectionHeader_(sh, row, label) {
  const C = GRAND_REPORT_CFG.COLOR;
  sh.getRange(row, 1, 1, 9).merge()
    .setValue("  " + label)
    .setBackground(C.SUBHEAD_BG)
    .setFontColor(C.HEADER_TEXT)
    .setFontSize(10)
    .setFontWeight("bold")
    .setVerticalAlignment("middle");
  sh.setRowHeight(row, 24);
  return row + 1;
}

/** Column header row — navy bg, white bold text */
function writeTableHeader_(sh, row, labels) {
  const C = GRAND_REPORT_CFG.COLOR;
  const headerRange = sh.getRange(row, 1, 1, labels.length);
  headerRange.setValues([labels])
    .setBackground(C.NAVY)
    .setFontColor(C.HEADER_TEXT)
    .setFontSize(8)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(row, 20);
  return row + 1;
}

/** Weekly tickets table */
function writeWeeklyTable_(sh, row, weekly) {
  const C   = GRAND_REPORT_CFG.COLOR;
  const labels = ["Ticket ID", "Property", "Unit", "Issue", "Category", "Status", "Created", "Closed", "Res. Days"];
  row = writeTableHeader_(sh, row, labels);

  weekly.forEach((r, i) => {
    const status    = String(r[GRAND_REPORT_CFG.COL.STATUS] || "").trim();
    const createdDt = toDateForReport_(r[GRAND_REPORT_CFG.COL.CREATED_AT]);
    const closedDt  = toDateForReport_(r[GRAND_REPORT_CFG.COL.CLOSED_AT]);
    const resDays   = (createdDt && closedDt)
      ? Math.max(0, Math.round((closedDt - createdDt) / 86400000))
      : "";
    const ticket    = r[GRAND_REPORT_CFG.COL.TICKET_ID] || ("KEY:" + (r[GRAND_REPORT_CFG.COL.TICKET_KEY] || ""));
    const cat       = r[GRAND_REPORT_CFG.COL.CATEGORY_FINAL] || r[GRAND_REPORT_CFG.COL.CATEGORY] || "Uncategorized";

    const values = [
      String(ticket).trim(),
      shortPropertyName_(String(r[GRAND_REPORT_CFG.COL.PROPERTY] || "").trim()),
      String(r[GRAND_REPORT_CFG.COL.UNIT] || "").trim(),
      String(r[GRAND_REPORT_CFG.COL.ISSUE] || "").trim(),
      String(cat).trim(),
      status,
      fmtDate_(createdDt),
      fmtDate_(closedDt) || "—",
      resDays === "" ? "—" : resDays + "d"
    ];

    const rowRange = sh.getRange(row, 1, 1, 9);
    const bg = (i % 2 === 0) ? C.WHITE : C.LIGHT_BLUE;
    rowRange.setValues([values])
      .setFontSize(8)
      .setFontColor(C.BODY_TEXT)
      .setVerticalAlignment("middle")
      .setWrap(true);

    // Row background
    rowRange.setBackground(bg);

    // Status cell color
    applyStatusColor_(sh.getRange(row, 6), status);

    sh.setRowHeight(row, 36);
    row++;
  });

  // Bottom border
  sh.getRange(row - weekly.length, 1, weekly.length, 9)
    .setBorder(true, true, true, true, true, true, "#C8D0E0", SpreadsheetApp.BorderStyle.SOLID);

  return row;
}

/** Open backlog table */
function writeOpenTable_(sh, row, openRows, snapshot) {
  const C      = GRAND_REPORT_CFG.COLOR;
  const labels = ["Ticket ID", "Property", "Unit", "Issue", "Category", "Status", "Created", "Days Open", "Age"];
  row = writeTableHeader_(sh, row, labels);

  openRows.forEach((r, i) => {
    const status    = String(r[GRAND_REPORT_CFG.COL.STATUS] || "").trim();
    const createdDt = toDateForReport_(r[GRAND_REPORT_CFG.COL.CREATED_AT]);
    const daysOpen  = createdDt
      ? Math.max(0, Math.floor((snapshot - createdDt) / 86400000))
      : "";
    const ticket    = r[GRAND_REPORT_CFG.COL.TICKET_ID] || ("KEY:" + (r[GRAND_REPORT_CFG.COL.TICKET_KEY] || ""));
    const cat       = r[GRAND_REPORT_CFG.COL.CATEGORY_FINAL] || r[GRAND_REPORT_CFG.COL.CATEGORY] || "Uncategorized";

    const ageBadge = daysOpen === "" ? "—"
      : daysOpen >= 30 ? "🔴 " + daysOpen + "d"
      : daysOpen >= 14 ? "🟡 " + daysOpen + "d"
      : daysOpen + "d";

    const values = [
      String(ticket).trim(),
      shortPropertyName_(String(r[GRAND_REPORT_CFG.COL.PROPERTY] || "").trim()),
      String(r[GRAND_REPORT_CFG.COL.UNIT] || "").trim(),
      String(r[GRAND_REPORT_CFG.COL.ISSUE] || "").trim(),
      String(cat).trim(),
      status,
      fmtDate_(createdDt) || "—",
      daysOpen === "" ? "—" : String(daysOpen),
      ageBadge
    ];

    const bg = (i % 2 === 0) ? C.WHITE : C.LIGHT_BLUE;
    const rowRange = sh.getRange(row, 1, 1, 9);
    rowRange.setValues([values])
      .setFontSize(8)
      .setFontColor(C.BODY_TEXT)
      .setVerticalAlignment("middle")
      .setWrap(true)
      .setBackground(bg);

    applyStatusColor_(sh.getRange(row, 6), status);

    // Highlight very old tickets (30+ days) with a faint red row tint
    if (typeof daysOpen === "number" && daysOpen >= 30) {
      rowRange.setBackground("#FFF0F0");
    }

    sh.setRowHeight(row, 36);
    row++;
  });

  sh.getRange(row - openRows.length, 1, openRows.length, 9)
    .setBorder(true, true, true, true, true, true, "#C8D0E0", SpreadsheetApp.BorderStyle.SOLID);

  return row;
}

/** Footer row with generation timestamp */
function writeFooter_(sh, row, snapshot) {
  const C = GRAND_REPORT_CFG.COLOR;
  sh.getRange(row, 1, 1, 9).merge()
    .setValue("Generated by Propera Compass  •  " + fmtDateTime_(snapshot) + "  •  The Grand Management Group")
    .setFontSize(7)
    .setFontColor("#8899AA")
    .setHorizontalAlignment("center")
    .setFontStyle("italic");
}


// ======================================================
// STYLING HELPERS
// ======================================================

/** Color-code the status cell */
function applyStatusColor_(cell, status) {
  const C = GRAND_REPORT_CFG.COLOR;
  const s = status.toLowerCase();
  if (s === "completed") {
    cell.setBackground(C.COMPLETED).setFontColor("#155724").setFontWeight("bold");
  } else if (s === "in progress") {
    cell.setBackground(C.IN_PROGRESS).setFontColor("#004085").setFontWeight("bold");
  } else if (s === "waiting on tenant") {
    cell.setBackground(C.WAITING).setFontColor("#721C24").setFontWeight("bold");
  } else if (s === "open") {
    cell.setBackground(C.OPEN).setFontColor("#856404").setFontWeight("bold");
  }
}

/** Set column widths for the report sheet (px) */
function setColumnWidths_(sh) {
  // Cols: A=TicketID, B=Property, C=Unit, D=Issue, E=Category, F=Status, G=Created, H=Closed/DaysOpen, I=ResDays/Age
  const widths = [115, 80, 40, 180, 80, 90, 72, 72, 55];
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

/**
 * Shorten "The Grand at Murray" → "Murray" etc. to save column space.
 * Remove this if you want full names.
 */
function shortPropertyName_(full) {
  return full.replace(/^The Grand at\s*/i, "");
}


// ======================================================
// PDF EXPORT  (Sheets → PDF via Drive export URL)
// ======================================================
function exportSheetAsPdf_(ss, sheet) {
  SpreadsheetApp.flush();

  const ssId  = ss.getId();
  const gid   = sheet.getSheetId();
  const token = ScriptApp.getOAuthToken();

  // Export params: landscape, letter, fit-to-width, no gridlines, no headers
  const url =
    "https://docs.google.com/spreadsheets/d/" + ssId +
    "/export?exportFormat=pdf&format=pdf" +
    "&size=letter" +
    "&portrait=false" +            // landscape
    "&fitw=true" +                 // fit width
    "&sheetnames=false" +
    "&printtitle=false" +
    "&pagenumbers=true" +          // page numbers in footer
    "&gridlines=false" +           // no gridlines (we drew our own borders)
    "&fzr=false" +                 // don't repeat frozen rows
    "&gid=" + gid;

  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error("PDF export failed: " + response.getResponseCode() + " " + response.getContentText());
  }

  return response.getBlob().setName("report.pdf");
}


// ======================================================
// DATE WINDOW (Monday → Monday)
// ======================================================
function getMondayWindow_(asOf) {
  const d = new Date(asOf);
  d.setHours(0, 0, 0, 0);

  const end = new Date(d);
  const day = (end.getDay() + 6) % 7;
  end.setDate(end.getDate() - day);

  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  return { start, end, snapshot: d };
}


// ======================================================
// DATE HELPERS
// ======================================================
function fmtDate_(d) {
  if (!d) return "";
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "MMM d, yyyy");
}

function fmtDateTime_(d) {
  if (!d) return "";
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "MMM d, yyyy 'at' h:mm a");
}

function toDateForReport_(v) {
  return (typeof toDate_ === "function" ? toDate_ : toDateReport_)(v);
}

// ─────────────────────────────────────────────────────────────────
// SCHEMA / COL — quick alignment check (run from editor)
// ─────────────────────────────────────────────────────────────────

function assertColMapAligned_() {
  const vals = Object.keys(COL).map(function (k) { return COL[k]; }).filter(function (v) { return typeof v === "number"; });
  const max = Math.max.apply(null, vals);
  if (max !== MAX_COL) {
    throw new Error("COL map mismatch: MAX_COL=" + MAX_COL + " but max COL index=" + max);
  }
}

/** Run once after changing Sheet1 columns or COL map. */
function runSchemaCheckOnce() {
  assertColMapAligned_();
  Logger.log("COL map aligned OK");
}

// ─────────────────────────────────────────────────────────────────
// TWILIO EMULATOR — same entry as live webhook (doPost)
// ─────────────────────────────────────────────────────────────────

function oneTest() {
  const sp = PropertiesService.getScriptProperties();
  const twhsec = String(sp.getProperty("TWILIO_WEBHOOK_SECRET") || "").trim();
  if (!twhsec) throw new Error("Missing Script Property: TWILIO_WEBHOOK_SECRET");

  const sid = "SM" + Utilities.getUuid().replace(/-/g, "").slice(0, 32);

  const fakeEvent = {
    parameter: {
      twhsec: twhsec,
      AccountSid: String(sp.getProperty("TWILIO_SID") || TWILIO_SID || "").trim(),
      From: "+9084330005",
      Body: "tomorrow morning",
      MessageSid: sid,
      _mode: "TENANT",
      _dryrun: "1"
    }
  };

  Logger.log("ONE_TEST start sid=" + sid);
  const resp = doPost(fakeEvent);
  try {
    if (resp && typeof resp.getContent === "function") {
      Logger.log("ONE_TEST resp=" + resp.getContent());
    } else {
      Logger.log("ONE_TEST resp=" + JSON.stringify(resp));
    }
  } catch (_) {}
  Logger.log("ONE_TEST done sid=" + sid);
}

/**
 * Builds Twilio-shaped parameters; uses SIM_WEBHOOK_SECRET when SIM_MODE + SIM_ALLOW_PHONES apply.
 * @returns {string} TwiML XML or JSON string
 */
function emulateTwilioInbound_(from, body, mode) {
  const sp = PropertiesService.getScriptProperties();
  const simSec = String(sp.getProperty("SIM_WEBHOOK_SECRET") || "").trim();
  const twhsec = (typeof simEnabled_ === "function" && simEnabled_() && simSec) ? simSec
    : String(sp.getProperty("TWILIO_WEBHOOK_SECRET") || "").trim();

  const accountSid = String(sp.getProperty("TWILIO_SID") || "").trim();
  const sid = "EMU_" + Utilities.getUuid().replace(/-/g, "").slice(0, 28);

  const fakeEvent = {
    parameter: {
      twhsec: twhsec,
      AccountSid: accountSid,
      From: String(from || "").trim(),
      Body: String(body || "").trim(),
      MessageSid: sid,
      _mode: String(mode || "TENANT"),
      _dryrun: "1"
    }
  };

  const resp = doPost(fakeEvent);
  try {
    if (resp && typeof resp.getContent === "function") return resp.getContent();
  } catch (_) {}
  return typeof resp !== "undefined" ? JSON.stringify(resp) : "";
}

function testDryRunNoTwilio_() {
  const phone = "+19084330005";
  const xml = emulateTwilioInbound_(phone, "sink clogged", "TENANT");
  Logger.log("testDryRunNoTwilio_ resp=" + xml);
}

/**
 * Sidebar emulator entry: full pipeline dry-run, returns TwiML + extracted message text.
 */
function emulatorSend(from, body, mode) {
  try { flushDevSmsLogs_(); } catch (_) {}

  var twiml = "";
  try {
    twiml = emulateTwilioInbound_(from, body, mode);
  } catch (err) {
    try { logDevSms_(String(from || ""), String(body || ""), "EMU_CRASH", String(err && err.stack ? err.stack : err)); } catch (_) {}
    try { flushDevSmsLogs_(); } catch (_) {}
    return { twiml: "", message: "", error: String(err && err.message ? err.message : err) };
  }

  try { flushDevSmsLogs_(); } catch (_) {}

    var message;
    try {
      var m = (twiml || "").match(/<Message[^>]*>([\s\S]*?)<\/Message>/);
      if (m && m[1]) message = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
    } catch (_) {}

    // TwiML escapes &, <, >, etc.; unescape for sidebar display (matches what tenant sees)
    if (message) {
      message = String(message)
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'");
    }

    return { twiml: twiml || "", message: message || "" };
}

// ─────────────────────────────────────────────────────────────────
// BATCH TEST RUNNER — allowlisted phones only; uses router entry path
// ─────────────────────────────────────────────────────────────────

var TEST_ALLOWLIST_ = ["+9084330005", "+9084330006", "+9084330007"];

function makeFakeTwilioEvent(fromE164, body, mode) {
  mode = mode || "TENANT";
  const sid = "TEST_" + new Date().getTime() + "_" + Math.random().toString(36).slice(2, 10);
  return {
    parameter: {
      twhsec: (typeof TWILIO_WEBHOOK_SECRET !== "undefined") ? TWILIO_WEBHOOK_SECRET : "test_sec",
      AccountSid: (typeof TWILIO_SID !== "undefined") ? TWILIO_SID : "test_sid",
      From: String(fromE164 || "").trim(),
      Body: String(body || "").trim(),
      MessageSid: sid,
      _mode: String(mode)
    }
  };
}

function snapshotState(phoneE164) {
  const phone = (typeof normalizePhone_ === "function") ? normalizePhone_(phoneE164) : String(phoneE164 || "").trim();
  const out = { directoryRow: {}, ctx: {}, workItem: null, recentDevLogs: [] };
  const N = 80;

  try {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    const dir = ss.getSheetByName(DIRECTORY_SHEET_NAME);
    if (dir && typeof findDirectoryRowByPhone_ === "function") {
      const dirRow = findDirectoryRowByPhone_(dir, phone);
      if (dirRow > 0) {
        const rowVals = dir.getRange(dirRow, 1, dirRow, 10).getValues()[0];
        out.directoryRow = {
          Phone: String(rowVals[0] || "").trim(),
          PropertyCode: String(rowVals[1] || "").trim(),
          PropertyName: String(rowVals[2] || "").trim(),
          LastUpdated: rowVals[3] || "",
          PendingIssue: String(rowVals[4] || "").trim(),
          Unit: String(rowVals[5] || "").trim(),
          PendingRow: parseInt(rowVals[6] || "0", 10) || 0,
          PendingStage: String(rowVals[7] || "").trim(),
          ActiveTicketKey: String(rowVals[8] || "").trim()
        };
      }
    }
  } catch (_) {}

  try {
    out.ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : {};
  } catch (_) {}

  if (out.ctx && out.ctx.activeWorkItemId) {
    try {
      out.workItem = (typeof workItemGetById_ === "function") ? workItemGetById_(out.ctx.activeWorkItemId) : null;
    } catch (_) {}
  }

  try {
    const logSh = SpreadsheetApp.openById(LOG_SHEET_ID).getSheetByName("DevSmsLog");
    if (logSh && logSh.getLastRow() >= 2) {
      const digits = String(phoneE164 || phone || "").replace(/\D/g, "").slice(-10);
      const lastRow = logSh.getLastRow();
      const startRow = Math.max(2, lastRow - N + 1);
      const rows = logSh.getRange(startRow, 1, lastRow, 5).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        const toCol = String(rows[i][1] || "").replace(/\D/g, "").slice(-10);
        if (toCol && toCol === digits) {
          out.recentDevLogs.unshift({ ts: rows[i][0], to: rows[i][1], msg: rows[i][2], status: rows[i][3], extra: rows[i][4] });
        }
      }
      if (out.recentDevLogs.length > N) out.recentDevLogs = out.recentDevLogs.slice(-N);
    }
  } catch (_) {}

  return out;
}

function buildTestReport(results) {
  const lines = [];
  lines.push("========== BATCH TEST REPORT " + new Date().toISOString() + " ==========");
  if (!results || !results.length) {
    lines.push("(no results)");
    return lines.join("\n");
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push("");
    lines.push("--- Case " + (i + 1) + ": " + (r.name || "Unnamed") + " ---");
    lines.push("Input: From=" + (r.from || "") + " Body=" + (r.body || ""));
    const markers = (r.logMarkers || []).slice(-20);
    if (markers.length) {
      lines.push("Markers: " + markers.join(" | "));
    }
    if (r.snapshot) {
      if (r.snapshot.directoryRow && Object.keys(r.snapshot.directoryRow).length) {
        lines.push("Dir: " + JSON.stringify(r.snapshot.directoryRow));
      }
      if (r.snapshot.ctx && Object.keys(r.snapshot.ctx).length) {
        lines.push("Ctx: " + JSON.stringify(r.snapshot.ctx));
      }
      if (r.snapshot.workItem) {
        lines.push("WI: " + JSON.stringify(r.snapshot.workItem));
      }
      if (r.snapshot.recentDevLogs && r.snapshot.recentDevLogs.length) {
        const lastLogs = r.snapshot.recentDevLogs.slice(-8);
        lastLogs.forEach(function (log) {
          lines.push("  Log: " + (log.status || "") + " " + (log.msg ? String(log.msg).slice(0, 40) : ""));
        });
      }
    }
  }
  lines.push("");
  lines.push("========== END REPORT ==========");
  return lines.join("\n");
}

function resetTestState(phoneE164) {
  const phone = (typeof normalizePhone_ === "function") ? normalizePhone_(phoneE164) : String(phoneE164 || "").trim();
  const allowed = TEST_ALLOWLIST_.some(function (p) {
    const n = (typeof normalizePhone_ === "function") ? normalizePhone_(p) : p;
    return n === phone || String(p || "").replace(/\D/g, "").slice(-10) === String(phone || "").replace(/\D/g, "").slice(-10);
  });
  if (!allowed) return false;
  try {
    const dir = getSheet_(DIRECTORY_SHEET_NAME);
    const dirRow = (typeof findDirectoryRowByPhone_ === "function") ? findDirectoryRowByPhone_(dir, phone) : 0;
    if (dirRow > 0) {
      dalWithLock_("TEST_RESET_DIR", function () {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        try { logDevSms_(phone, "", "ISSUE_WRITE site=[TEST_RESET_DIR] val=[CLEAR_TEST]"); } catch (_) {}
        dalSetPendingUnitNoLock_(dir, dirRow, "");
        dalSetPendingRowNoLock_(dir, dirRow, 0);
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE TEST_RESET_DIR row=" + dirRow); } catch (_) {}
      });
    }
    if (typeof ctxUpsert_ === "function") {
      ctxUpsert_(phone, { pendingExpected: "" }, "TEST_RESET");
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Runs canned tenant messages through handleInboundRouter_ (same path as gateway after validation).
 */
function runBatchTests() {
  const RESET_BEFORE = true;
  const testPhone = "+9084330005";
  const allowed = TEST_ALLOWLIST_.some(function (p) {
    const n = (typeof normalizePhone_ === "function") ? normalizePhone_(p) : p;
    const ph = (typeof normalizePhone_ === "function") ? normalizePhone_(testPhone) : testPhone;
    return n === ph || String(p || "").replace(/\D/g, "").slice(-10) === String(ph || "").replace(/\D/g, "").slice(-10);
  });
  if (!allowed) {
    Logger.log("runBatchTests: abort — phone " + testPhone + " not in TEST_ALLOWLIST_");
    return "ABORT: phone not in allowlist";
  }
  if (RESET_BEFORE) {
    resetTestState(testPhone);
  }

  const cases = [
    { name: "NEW issue only", from: "+9084330005", body: "sink is leaking", mode: "TENANT" },
    { name: "PROPERTY answer", from: "+9084330005", body: "the grand at penn", mode: "TENANT" },
    { name: "UNIT answer", from: "+9084330005", body: "201", mode: "TENANT" },
    { name: "SCHEDULE answer", from: "+9084330005", body: "tomorrow morning", mode: "TENANT" },
    { name: "Greeting (no ticket)", from: "+9084330005", body: "hey", mode: "TENANT" }
  ];

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const ev = makeFakeTwilioEvent(c.from, c.body, c.mode);
    try {
      if (typeof handleInboundRouter_ === "function") {
        handleInboundRouter_(ev);
      }
    } catch (err) {
      try { logDevSms_(c.from, c.body, "BATCH_TEST_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
    }
    try { flushDevSmsLogs_(); } catch (_) {}
    const snap = snapshotState(c.from);
    const markers = (snap.recentDevLogs || []).map(function (l) { return l.status; }).filter(Boolean);
    results.push({ name: c.name, from: c.from, body: c.body, snapshot: snap, logMarkers: markers });
  }

  const report = buildTestReport(results);
  Logger.log(report);
  return report;
}

function pickServerText(resp) {
  if (!resp) return "";
  if (typeof resp === "string") return resp;
  if (resp.message) return resp.message;
  if (resp.twiml) {
    const m = (resp.twiml || "").match(/<Message[^>]*>([\s\S]*?)<\/Message>/);
    return m && m[1] ? m[1].trim() : "";
  }
  return "";
}

function emuPing() {
  Logger.log("EMU_PING hit " + new Date().toISOString());
  return "pong " + new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────
// VENDOR ASSIGN SANDBOX — creates a test row, runs assignVendorFromRow_
// ─────────────────────────────────────────────────────────────────

function createAssignTestTicket_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName("Sheet1");
  if (!sheet) throw new Error("Sheet1 not found");

  const row = sheet.getLastRow() + 1;
  const tid = "TEST-ASSIGN-" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");

  sheet.getRange(row, COL.TS).setValue(new Date());
  sheet.getRange(row, COL.PHONE).setValue("+19999999999");
  sheet.getRange(row, COL.PROPERTY).setValue("The Grand at Penn");
  sheet.getRange(row, COL.UNIT).setValue("305");
  sheet.getRange(row, COL.MSG).setValue("Leak test for assignment");
  sheet.getRange(row, COL.CAT).setValue("Plumbing");
  sheet.getRange(row, COL.TICKET_ID).setValue(tid);
  sheet.getRange(row, COL.STATUS).setValue("TEST");

  sheet.getRange(row, COL.ASSIGNED_TO).setValue("");
  sheet.getRange(row, COL.ASSIGNED_TYPE).setValue("");
  sheet.getRange(row, COL.ASSIGNED_ID).setValue("");
  sheet.getRange(row, COL.ASSIGNED_NAME).setValue("");
  sheet.getRange(row, COL.ASSIGNED_AT).setValue("");
  sheet.getRange(row, COL.ASSIGNED_BY).setValue("");
  sheet.getRange(row, COL.VENDOR_STATUS).setValue("");
  sheet.getRange(row, COL.VENDOR_APPT).setValue("");
  sheet.getRange(row, COL.VENDOR_NOTES).setValue("");

  Logger.log("Created test ticket row=" + row + " TicketID=" + tid);
  return { row: row, tid: tid };
}

function deleteRow_(sheet, row) {
  if (!sheet || row < 2) return;
  sheet.deleteRow(row);
}

/** Manual sandbox: set Vendor on row, call assignVendorFromRow_. */
function runAssignVendorSandboxTest() {
  const sheet = SpreadsheetApp.getActive().getSheetByName("Sheet1");
  const t = createAssignTestTicket_();

  const vendorId = "VEND_PLUMB_01";
  const vendor = getVendorById_(vendorId);

  logDevSms_("+19999999999", "RUN_ASSIGN_TEST start " + t.tid, "DBG_ASSIGN_TEST");

  sheet.getRange(t.row, COL.ASSIGNED_TYPE).setValue("Vendor");
  sheet.getRange(t.row, COL.ASSIGNED_ID).setValue(vendorId);
  sheet.getRange(t.row, COL.VENDOR_STATUS).setValue("");

  const creds = { TWILIO_SID: "TEST", TWILIO_TOKEN: "TEST", TWILIO_NUMBER: "+10000000000" };
  if (typeof assignVendorFromRow_ === "function") {
    assignVendorFromRow_(creds, sheet, t.row, { mode: "MANUAL", assignedBy: "SANDBOX_TEST" });
  }

  const assignedName = String(sheet.getRange(t.row, COL.ASSIGNED_NAME).getValue() || "").trim();
  const vendorStatus = String(sheet.getRange(t.row, COL.VENDOR_STATUS).getValue() || "").trim();

  Logger.log("AssignedName=" + assignedName);
  Logger.log("VendorStatus=" + vendorStatus);
  Logger.log("Test TicketID=" + t.tid + " Row=" + t.row);

  if (vendor) {
    logDevSms_(String(vendor.phone || ""), "RUN_ASSIGN_TEST expected vendor notify " + t.tid, "DBG_ASSIGN_TEST");
  } else {
    logDevSms_("(no vendor)", "RUN_ASSIGN_TEST vendor not found " + vendorId, "DBG_ASSIGN_TEST");
  }

  try { flushDevSmsLogs_(); } catch (_) {}
}
