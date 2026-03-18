/**
 * TestHarness.gs — Propera test runner (manual run only).
 * Runs 4–6 cases per cluster, captures markers-only timeline and state snapshots,
 * writes one report to Google Drive. Does NOT change production behavior.
 *
 * Public entry points (no trailing underscore): runHealthCheck, runClusterDraft, runClusterContinuation.
 * Log sheet name discovered from flushDevSmsLogs_ in core: "DevSmsLog" in LOG_SHEET_ID.
 */

// Marker prefixes we keep for "markers only" timeline (from Status or Message in DevSmsLog)
var TEST_MARKER_PREFIXES_ = [
  "MARK_", "COMPILE_TURN", "DRAFT_UPSERT", "STATE_RESOLVED", "PT_",
  "FINALIZE_DRAFT_OK", "PENDING_SET", "WI_", "SCHED_", "TICKET_CREATE",
  "ROUTER_", "CORE_SEES"
];

var TEST_MARKER_TRUNCATE_ = 80;

/**
 * Discover log sheet name: used by logDevSms_ / flushDevSmsLogs_ in core.
 * @return {string} Sheet tab name (e.g. "DevSmsLog") or empty if not found
 */
function getDevLogSheetName_() {
  try {
    if (typeof LOG_SHEET_ID === "undefined" || !LOG_SHEET_ID) return "";
    var ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    var names = ["DevSmsLog", "DevLog", "Logs", "SmsLog"];
    for (var i = 0; i < names.length; i++) {
      var sh = ss.getSheetByName(names[i]);
      if (sh) return names[i];
    }
  } catch (_) {}
  return "";
}

/**
 * Create a fake Twilio webhook event for testing.
 * Uses Script Properties TWILIO_WEBHOOK_SECRET (twhsec) and TWILIO_SID (AccountSid).
 * @param {string} fromE164
 * @param {string} body
 * @param {string} mode defaults "TENANT"
 * @return {Object} { parameter: { twhsec, AccountSid, From, Body, MessageSid, _mode } }
 */
function makeFakeTwilioEvent_(fromE164, body, mode) {
  mode = mode || "TENANT";
  var props = PropertiesService.getScriptProperties();
  var twhsec = props.getProperty("TWILIO_WEBHOOK_SECRET") || "";
  var accountSid = props.getProperty("TWILIO_SID") || "";
  var sid = "TEST_" + new Date().getTime() + "_" + Math.random().toString(36).slice(2, 10);
  return {
    parameter: {
      twhsec: twhsec,
      AccountSid: accountSid,
      From: String(fromE164 || "").trim(),
      Body: String(body || "").trim(),
      MessageSid: sid,
      _mode: String(mode)
    }
  };
}

/**
 * Invoke production entrypoint with a fake event. Uses same path as doPost.
 * @param {Object} fakeEvent event with .parameter
 */
function invokeInbound_(fakeEvent) {
  if (typeof doPost !== "function") return;
  try {
    doPost(fakeEvent);
  } catch (_) {}
}

/**
 * Capture "markers only" from DevSmsLog between sinceDate and now for phoneDigits.
 * @param {Date} sinceDate
 * @param {string} phoneDigits last 10 digits (or normalized)
 * @return {string} Single line joined with " | ", each segment truncated to ~80 chars; or [NO_LOG_SHEET_FOUND]
 */
function captureMarkersSince_(sinceDate, phoneDigits) {
  var sheetName = getDevLogSheetName_();
  if (!sheetName) return "[NO_LOG_SHEET_FOUND]";
  try {
    if (typeof LOG_SHEET_ID === "undefined" || !LOG_SHEET_ID) return "[NO_LOG_SHEET_FOUND]";
    var ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    var sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return "";
    var digits = String(phoneDigits || "").replace(/\D/g, "").slice(-10);
    var lastRow = sh.getLastRow();
    var rows = sh.getRange(2, 1, lastRow, 5).getValues();
    var segments = [];
    for (var i = 0; i < rows.length; i++) {
      var ts = rows[i][0];
      if (ts && (ts instanceof Date) && ts < sinceDate) continue;
      var toCol = String(rows[i][1] || "").replace(/\D/g, "").slice(-10);
      if (toCol !== digits) continue;
      var msg = String(rows[i][2] || "");
      var status = String(rows[i][3] || "");
      var combined = status + " " + msg;
      var keep = false;
      for (var p = 0; p < TEST_MARKER_PREFIXES_.length; p++) {
        if (combined.indexOf(TEST_MARKER_PREFIXES_[p]) >= 0) { keep = true; break; }
      }
      if (!keep) continue;
      var seg = (status + (msg ? " " + msg : "")).trim();
      if (seg.length > TEST_MARKER_TRUNCATE_) seg = seg.slice(0, TEST_MARKER_TRUNCATE_) + "...";
      segments.push(seg);
    }
    return segments.join(" | ");
  } catch (_) {
    return "[NO_LOG_SHEET_FOUND]";
  }
}

/**
 * Snapshot state for a phone: Directory, ctx, WorkItem, Ticket.
 * @param {string} phoneE164
 * @return {string} Compact JSON string (one line)
 */
function snapshotState_(phoneE164) {
  var phone = (typeof normalizePhone_ === "function") ? normalizePhone_(phoneE164) : String(phoneE164 || "").trim();
  var out = { dir: {}, ctx: {}, workItem: null, ticket: null };

  try {
    if (typeof LOG_SHEET_ID !== "undefined" && LOG_SHEET_ID && typeof DIRECTORY_SHEET_NAME !== "undefined") {
      var ss = SpreadsheetApp.openById(LOG_SHEET_ID);
      var dir = ss.getSheetByName(DIRECTORY_SHEET_NAME);
      if (dir && typeof findDirectoryRowByPhone_ === "function") {
        var dirRow = findDirectoryRowByPhone_(dir, phone);
        if (dirRow > 0) {
          var rowVals = dir.getRange(dirRow, 1, dirRow, 9).getValues()[0];
          out.dir = {
            Phone: String(rowVals[0] || "").trim(),
            PropertyCode: String(rowVals[1] || "").trim(),
            PropertyName: String(rowVals[2] || "").trim(),
            LastUpdated: rowVals[3] ? String(rowVals[3]) : "",
            PendingIssue: String(rowVals[4] || "").trim(),
            Unit: String(rowVals[5] || "").trim(),
            PendingRow: parseInt(rowVals[6] || "0", 10) || 0,
            PendingStage: String(rowVals[7] || "").trim(),
            ActiveTicketKey: String(rowVals[8] || "").trim()
          };
        }
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

  var pendingRow = out.dir && out.dir.PendingRow ? parseInt(out.dir.PendingRow, 10) : 0;
  if (pendingRow >= 2 && typeof LOG_SHEET_ID !== "undefined" && LOG_SHEET_ID && typeof SHEET_NAME !== "undefined") {
    try {
      var tss = SpreadsheetApp.openById(LOG_SHEET_ID);
      var tsh = tss.getSheetByName(SHEET_NAME);
      if (tsh && typeof COL !== "undefined") {
        var ticketId = String(tsh.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();
        var unit = String(tsh.getRange(pendingRow, COL.UNIT).getValue() || "").trim();
        var property = String(tsh.getRange(pendingRow, COL.PROPERTY).getValue() || "").trim();
        var status = String(tsh.getRange(pendingRow, COL.STATUS).getValue() || "").trim();
        var msg = String(tsh.getRange(pendingRow, COL.MSG).getValue() || "").trim();
        var prefWindow = (COL.PREF_WINDOW && tsh.getLastColumn() >= COL.PREF_WINDOW)
          ? String(tsh.getRange(pendingRow, COL.PREF_WINDOW).getValue() || "").trim() : "";
        out.ticket = { ticketId: ticketId, unit: unit, property: property, status: status, msg: msg, prefWindow: prefWindow };
      }
    } catch (_) {}
  }

  return JSON.stringify(out);
}

/**
 * Run one case: invoke, flush, capture markers, snapshot, evaluate expects.
 * @param {Object} caseDef { name, from, body, mode, mustContainMarkers?, mustNotContainMarkers?, assertFn?(snapshotObj)? }
 * @return {Object} { name, from, body, markers, snapshotJson, snapshotObj, pass, reason }
 */
function runOneCase_(caseDef) {
  var name = caseDef.name || "Unnamed";
  var from = caseDef.from || "";
  var body = caseDef.body || "";
  var mode = caseDef.mode || "TENANT";
  var digits = String(from || "").replace(/\D/g, "").slice(-10);

  var sinceDate = new Date();
  var ev = makeFakeTwilioEvent_(from, body, mode);
  invokeInbound_(ev);
  if (typeof flushDevSmsLogs_ === "function") {
    try { flushDevSmsLogs_(); } catch (_) {}
  }
  var markers = captureMarkersSince_(sinceDate, digits);
  var snapshotJson = snapshotState_(from);
  var snapshotObj = {};
  try { snapshotObj = JSON.parse(snapshotJson); } catch (_) {}

  var pass = true;
  var reason = "";

  if (caseDef.mustContainMarkers && Array.isArray(caseDef.mustContainMarkers)) {
    for (var i = 0; i < caseDef.mustContainMarkers.length; i++) {
      if (markers.indexOf(caseDef.mustContainMarkers[i]) < 0) {
        pass = false;
        reason = "missing marker: " + caseDef.mustContainMarkers[i];
        break;
      }
    }
  }
  if (pass && caseDef.mustNotContainMarkers && Array.isArray(caseDef.mustNotContainMarkers)) {
    for (var j = 0; j < caseDef.mustNotContainMarkers.length; j++) {
      if (markers.indexOf(caseDef.mustNotContainMarkers[j]) >= 0) {
        pass = false;
        reason = "forbidden marker: " + caseDef.mustNotContainMarkers[j];
        break;
      }
    }
  }
  if (pass && typeof caseDef.assertFn === "function") {
    try {
      var err = caseDef.assertFn(snapshotObj);
      if (err) { pass = false; reason = err; }
    } catch (e) {
      pass = false;
      reason = (e && e.message) ? e.message : String(e);
    }
  }

  return { name: name, from: from, body: body, markers: markers, snapshotJson: snapshotJson, snapshotObj: snapshotObj, pass: pass, reason: reason };
}

/**
 * Build report text from results array.
 * @param {Array<Object>} results from runOneCase_
 * @param {string} title
 * @return {string}
 */
function buildReport_(results, title) {
  var lines = [];
  lines.push("========== " + (title || "Test Report") + " " + new Date().toISOString() + " ==========");
  if (!results || !results.length) {
    lines.push("(no results)");
    return lines.join("\n");
  }
  var passCount = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    passCount += r.pass ? 1 : 0;
    lines.push("");
    lines.push("--- Case " + (i + 1) + ": " + (r.name || "Unnamed") + " ---");
    lines.push("Input: From=" + (r.from || "") + " Body=" + (r.body || ""));
    lines.push("Markers: " + (r.markers || ""));
    lines.push("Snapshot: " + (r.snapshotJson || "").slice(0, 500) + (r.snapshotJson && r.snapshotJson.length > 500 ? "..." : ""));
    lines.push((r.pass ? "PASS" : "FAIL") + (r.reason ? " " + r.reason : ""));
  }
  lines.push("");
  lines.push("Summary: " + passCount + "/" + results.length + " passed");
  lines.push("========== END ==========");
  return lines.join("\n");
}

// --- Public entry points (no trailing underscore) ---

/**
 * Cluster A: Draft pipeline (new issue -> property -> unit -> schedule).
 * Single phone +9084330005, 4 cases, no reset between.
 * @return {Array<Object>} results
 */
function runClusterDraft() {
  var phone = "+9084330005";
  var cases = [
    { name: "A1 new issue", from: phone, body: "sink is leaking", mode: "TENANT" },
    { name: "A2 property", from: phone, body: "the grand at penn", mode: "TENANT" },
    { name: "A3 unit", from: phone, body: "201", mode: "TENANT" },
    { name: "A4 schedule", from: phone, body: "tomorrow morning", mode: "TENANT" }
  ];
  var results = [];
  for (var i = 0; i < cases.length; i++) {
    results.push(runOneCase_(cases[i]));
  }
  return results;
}

/**
 * Cluster B: Continuation / "property reply must not pollute issue".
 * Phone +9084330006, 3 cases. B2 must NOT set PendingIssue to "the grand at penn"; B3 must reach SCHEDULE.
 * @return {Array<Object>} results
 */
function runClusterContinuation() {
  var phone = "+9084330006";
  var cases = [
    { name: "B1 new issue", from: phone, body: "sink clogged", mode: "TENANT" },
    {
      name: "B2 property reply (no pollute)",
      from: phone,
      body: "the grand at penn",
      mode: "TENANT",
      mustNotContainMarkers: ["DRAFT_UPSERT issue=[the grand at penn]"],
      assertFn: function (snap) {
        var pi = (snap && snap.dir && snap.dir.PendingIssue) ? String(snap.dir.PendingIssue) : "";
        if (pi === "the grand at penn") return "PendingIssue must not be 'the grand at penn'";
        return null;
      }
    },
    {
      name: "B3 unit -> SCHEDULE",
      from: phone,
      body: "201",
      mode: "TENANT",
      assertFn: function (snap) {
        var stage = (snap && snap.dir && snap.dir.PendingStage) ? String(snap.dir.PendingStage).toUpperCase() : "";
        var expected = (snap && snap.ctx && snap.ctx.pendingExpected) ? String(snap.ctx.pendingExpected).toUpperCase() : "";
        if (stage !== "SCHEDULE") return "PendingStage expected SCHEDULE, got " + stage;
        if (expected !== "SCHEDULE") return "pendingExpected expected SCHEDULE, got " + expected;
        return null;
      }
    }
  ];
  var results = [];
  for (var j = 0; j < cases.length; j++) {
    results.push(runOneCase_(cases[j]));
  }
  return results;
}

/**
 * Run both clusters, write one report to Drive, log URL and short summary only.
 * File: Propera_TestReport_<ISO>.txt
 */
function runHealthCheck() {
  var iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  var draftResults = runClusterDraft();
  var contResults = runClusterContinuation();

  var totalPass = 0, totalCases = 0;
  for (var i = 0; i < draftResults.length; i++) { totalCases++; if (draftResults[i].pass) totalPass++; }
  for (var k = 0; k < contResults.length; k++) { totalCases++; if (contResults[k].pass) totalPass++; }

  var lines = [];
  lines.push("========== Propera Health Check " + new Date().toISOString() + " ==========");
  lines.push("");
  lines.push("--- Cluster A: Draft ---");
  lines.push(buildReport_(draftResults, "Cluster Draft"));
  lines.push("");
  lines.push("--- Cluster B: Continuation ---");
  lines.push(buildReport_(contResults, "Cluster Continuation"));
  lines.push("");
  lines.push("TOTAL: " + totalPass + "/" + totalCases + " passed");
  lines.push("========== END ==========");

  var report = lines.join("\n");
  var fileName = "Propera_TestReport_" + iso + ".txt";
  var file = null;
  try {
    file = DriveApp.createFile(fileName, report, MimeType.PLAIN_TEXT);
  } catch (e) {
    try { DriveApp.getRootFolder(); } catch (_) {}
    file = DriveApp.createFile(fileName, report, MimeType.PLAIN_TEXT);
  }
  var url = file ? file.getUrl() : "";
  Logger.log("Report URL: " + url);
  Logger.log("Summary: " + totalPass + "/" + totalCases + " passed");
  for (var a = 0; a < draftResults.length; a++) {
    Logger.log("  A" + (a + 1) + " " + (draftResults[a].pass ? "PASS" : "FAIL") + " " + (draftResults[a].name || ""));
  }
  for (var b = 0; b < contResults.length; b++) {
    Logger.log("  B" + (b + 1) + " " + (contResults[b].pass ? "PASS" : "FAIL") + " " + (contResults[b].name || ""));
  }
  return report;
}
