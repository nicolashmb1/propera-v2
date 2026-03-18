// ======================================================
// THE GRAND MANAGEMENT GROUP — WEEKLY REPORT v2
// Uses a temp Sheet for layout (instead of Doc) so we get
// full column-width, color, and font control before PDF export.
// Monday → Monday window.
// Standalone: keep in separate .gs file from main Propera script.
// ======================================================

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