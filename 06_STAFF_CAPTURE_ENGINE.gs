/**
 * STAFF_CAPTURE_ENGINE.gs — Propera Layer 3 (Staff Capture + Vision Pipeline)
 *
 * OWNS:
 *   - Deferred StaffMediaVisionQueue sheet (enqueue, tick, status transitions)
 *   - Twilio media URL extraction / synthetic event for vision adapter
 *   - staffMediaVisionWorkerRunPipeline_ (draft upsert + optional finalize after vision)
 *
 * DOES NOT OWN (never add these here):
 *   - staffCaptureDraftTag_ / staffCaptureDispatchOutboundIntent_ (DIRECTORY_SESSION_DAL.gs)
 *   - BRAND / tenant templates
 *   - AI transport fetch (AI_MEDIA_TRANSPORT.gs); intake compile (INTAKE_RUNTIME / CANONICAL_INTAKE)
 *
 * ENTRY POINTS:
 *   - enqueueStaffMediaVisionJob_(e, job)
 *   - processStaffMediaVisionQueueTick_() — invoked from aiEnrichmentWorker
 *
 * DEPENDENCIES (reads from):
 *   - PROPERA MAIN.gs — SHEET_NAME, DIRECTORY_SHEET_NAME, getSheet_, safeParam_, withWriteLock_
 *   - DIRECTORY_SESSION_DAL.gs — staff capture outbound helpers, BRAND via globals
 *   - CANONICAL_INTAKE_ENGINE / TICKET_FINALIZE_ENGINE — draftUpsertFromTurn_, finalizeDraftAndCreateTicket_, etc.
 *   - AI_MEDIA_TRANSPORT — imageSignalAdapter_, mergeMediaIntoBody_, parseCanonicalMediaArrayFromEvent_
 *
 * FUTURE MIGRATION NOTE:
 *   - Async worker service: queue + vision pipeline; replace sheet queue with job store
 *
 * SECTIONS IN THIS FILE:
 *   1. Flags + media URL helpers
 *   2. StaffMediaVisionQueue sheet + enqueue
 *   3. Worker pipeline + queue tick
 */


  // =========================================================
  // STAFF MEDIA VISION QUEUE (Phase 4 — defer Twilio fetch + OpenAI vision off STAFF_CAPTURE)
  // Enable: ScriptProperties STAFF_MEDIA_VISION_DEFER = "1"
  // Sheet: StaffMediaVisionQueue (created on first enqueue)
  // Processed by aiEnrichmentWorker (same 1-min trigger as AiQueue)
  // =========================================================

  const STAFF_MEDIA_VISION_QUEUE_SHEET = "StaffMediaVisionQueue";

  function staffMediaVisionDeferEnabled_() {
    try {
      return String(PropertiesService.getScriptProperties().getProperty("STAFF_MEDIA_VISION_DEFER") || "").trim() === "1";
    } catch (_) {
      return false;
    }
  }

  function extractMediaUrlsFromTwilioEvent_(e) {
    if (typeof parseCanonicalMediaArrayFromEvent_ === "function") {
      var c = parseCanonicalMediaArrayFromEvent_(e);
      if (c && c.length) return c.map(function (m) { return m.url; });
    }
    var out = [];
    var n = parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) || 0;
    for (var i = 0; i < n; i++) {
      var u = String(safeParam_(e, "MediaUrl" + i) || "").trim();
      if (u) out.push(u);
    }
    return out;
  }

  function buildSyntheticTwilioEventForMediaUrls_(urls) {
    var e = { parameter: {} };
    var arr = Array.isArray(urls) ? urls : [];
    var canon = [];
    for (var j = 0; j < arr.length; j++) {
      var u = String(arr[j] || "").trim();
      if (u) canon.push({ url: u, contentType: "", mimeType: "", source: "twilio" });
    }
    e.parameter.NumMedia = String(canon.length);
    for (var i = 0; i < canon.length; i++) {
      e.parameter["MediaUrl" + i] = canon[i].url;
    }
    if (canon.length) e.parameter._mediaJson = JSON.stringify(canon);
    return e;
  }

  function ensureStaffMediaVisionQueueSheet_() {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(STAFF_MEDIA_VISION_QUEUE_SHEET);
    if (sh) return sh;
    return withWriteLock_("SMVQ_CREATE", function() {
      var s2 = ss.getSheetByName(STAFF_MEDIA_VISION_QUEUE_SHEET);
      if (!s2) s2 = ss.insertSheet(STAFF_MEDIA_VISION_QUEUE_SHEET);
      if (s2.getLastRow() < 1) {
        s2.appendRow([
          "CreatedAt", "DraftId", "DraftPhone", "StaffPhoneE164", "PayloadText", "MediaUrlsJson",
          "Kind", "MessageSid", "Status", "Attempts", "LastError", "UpdatedAt"
        ]);
      }
      return s2;
    });
  }

  function staffMediaVisionJobPendingForSid_(sid) {
    var s = String(sid || "").trim();
    if (!s) return false;
    var sh = SpreadsheetApp.getActive().getSheetByName(STAFF_MEDIA_VISION_QUEUE_SHEET);
    if (!sh || sh.getLastRow() < 2) return false;
    var last = sh.getLastRow();
    var start = Math.max(2, last - 80);
    var n = last - start + 1;
    var vals = sh.getRange(start, 1, n, 12).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      var st = String(vals[i][8] || "").trim();
      var wsid = String(vals[i][7] || "").trim();
      if (st === "PENDING" && wsid === s) return true;
    }
    return false;
  }

  function enqueueStaffMediaVisionJob_(e, job) {
    if (!staffMediaVisionDeferEnabled_()) return false;
    var urls = extractMediaUrlsFromTwilioEvent_(e);
    if (!urls.length) return false;
    var sid = String(safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid") || "").trim();
    if (sid && staffMediaVisionJobPendingForSid_(sid)) return false;
    var sh = ensureStaffMediaVisionQueueSheet_();
    var now = new Date();
    sh.appendRow([
      now,
      String(job.draftId || "").trim(),
      String(job.draftPhone || "").trim(),
      String(job.staffPhone || "").trim(),
      String(job.payloadText || "").trim(),
      JSON.stringify(urls),
      String(job.kind || "FULL").trim(),
      sid,
      "PENDING",
      0,
      "",
      now
    ]);
    return true;
  }

  /**
   * Staff # capture: after deferred vision, same pipeline as sync STAFF_CAPTURE (draft upsert + optional finalize).
   * inboundKey uses STAFFCAP_VISION so duplicate finalize is distinct from live SMS SIDs.
   */
  function staffMediaVisionWorkerRunPipeline_(sheet, dir, originPhoneStaff, draftPhone, draftId, mergedPayloadText, staffMediaFacts, mediaUrlList, jobRow) {
    var baseVars = { brandName: BRAND.name, teamName: BRAND.team };
    var props = PropertiesService.getScriptProperties();
    var OPENAI_API_KEY = props.getProperty("OPENAI_API_KEY");
    var TWILIO_SID = props.getProperty("TWILIO_SID");
    var TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
    var TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");
    var ONCALL_NUMBER = props.getProperty("ONCALL_NUMBER");

    var dirRow = (typeof findDirectoryRowByPhone_ === "function") ? findDirectoryRowByPhone_(dir, draftPhone) : 0;
    if (!dirRow || dirRow < 2) {
      dirRow = ensureDirectoryRowForPhone_(dir, draftPhone);
    }
    if (!dirRow || dirRow < 2) {
      staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_INGEST_ERROR", { draftTag: staffCaptureDraftTag_(draftId) }, null);
      return { ok: false, skipSms: true };
    }

    var dirPendingRow0 = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
    if (dirPendingRow0 >= 2) {
      var propCodeAf = String(dir.getRange(dirRow, 2).getValue() || "").trim();
      var issueAf = String(dir.getRange(dirRow, 5).getValue() || "").trim();
      var unitAf = String(dir.getRange(dirRow, 6).getValue() || "").trim();
      var missingAf = [];
      if (!propCodeAf) missingAf.push("property");
      if (!unitAf) missingAf.push("unit");
      if (!issueAf) missingAf.push("issue");
      var _dtVis = staffCaptureDraftTag_(draftId);
      staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_ALREADY_FINAL", {
        draftTag: _dtVis,
        loggedRow: String(dirPendingRow0),
        missingBlock: staffCaptureAlreadyFinalMissingBlock_(_dtVis, missingAf)
      }, null);
      return { ok: true, skipSms: true };
    }

    var turnFacts = compileTurn_(mergedPayloadText, draftPhone, "en", baseVars, null);
    turnFacts.meta = turnFacts.meta || {};
    var _numMediaStaff = Array.isArray(mediaUrlList) ? mediaUrlList.length : 0;
    turnFacts.meta.mediaUrls = Array.isArray(mediaUrlList) ? mediaUrlList.slice() : [];

    if (typeof maybeAttachMediaFactsToTurn_ === "function") maybeAttachMediaFactsToTurn_(turnFacts, staffMediaFacts);

    var issueBlankOrWeak = !turnFacts.issue || (typeof isWeakIssue_ === "function" && isWeakIssue_(turnFacts.issue));
    var mergedTrim = String(mergedPayloadText || "").trim();
    var mergedUsable = mergedTrim.length > 0 && (typeof isWeakIssue_ !== "function" ? mergedTrim.length >= 8 : !isWeakIssue_(mergedTrim));
    if (issueBlankOrWeak && mergedUsable) {
      turnFacts.issue = mergedTrim;
    }

    var mediaConfident = (typeof staffMediaFacts.confidence === "number" && staffMediaFacts.confidence >= 0.6);
    if (mediaConfident && !turnFacts.property && turnFacts.meta && turnFacts.meta.mediaPropertyHint) {
      var hintProp = (typeof resolvePropertyHintToObj_ === "function") ? resolvePropertyHintToObj_(turnFacts.meta.mediaPropertyHint) : null;
      if (hintProp && hintProp.code) {
        turnFacts.property = { code: hintProp.code, name: hintProp.name || "" };
      }
    }
    if (mediaConfident && !turnFacts.unit && turnFacts.meta && turnFacts.meta.mediaUnitHint) {
      var mediaUnitVal = String(turnFacts.meta.mediaUnitHint || "").trim();
      if (mediaUnitVal) {
        turnFacts.unit = (typeof normalizeUnit_ === "function") ? normalizeUnit_(mediaUnitVal) : mediaUnitVal;
      }
    }

    var weakStaff = !mergedTrim || (typeof isWeakIssue_ === "function" && isWeakIssue_(mergedTrim));
    turnFacts.meta.hasMediaOnly = (_numMediaStaff > 0) && weakStaff;
    if (staffMediaFacts.syntheticBody && (typeof isWeakIssue_ === "function" && !isWeakIssue_(staffMediaFacts.syntheticBody))) turnFacts.meta.hasMediaOnly = false;

    draftUpsertFromTurn_(dir, dirRow, turnFacts, mergedPayloadText, draftPhone, { staffCapture: true });

    try {
      recomputeDraftExpected_(dir, dirRow, draftPhone);
    } catch (_) {}

    var propCode = String(dir.getRange(dirRow, 2).getValue() || "").trim();
    var issueVal = String(dir.getRange(dirRow, 5).getValue() || "").trim();
    var unitVal = String(dir.getRange(dirRow, 6).getValue() || "").trim();
    var dirPendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;

    var missing = [];
    if (!propCode) missing.push("property");
    if (!unitVal) missing.push("unit");
    if (!issueVal) missing.push("issue");

    var createdTicket = false;
    var ticketId = "";

    if (dirRow >= 2 && !missing.length && dirPendingRow < 2) {
      var staffCapInboundKey = "STAFFCAP_VISION:" + draftId + ":J" + jobRow;
      var staffMediaUrl = turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0] ? String(turnFacts.meta.mediaUrls[0]).trim() : "";
      var mediaTenantHint = (turnFacts.meta && turnFacts.meta.mediaTenantNameHint) ? String(turnFacts.meta.mediaTenantNameHint).trim() : "";
      var textTenantHint = "";
      if (!mediaTenantHint && typeof extractStaffTenantNameHintFromText_ === "function") {
        textTenantHint = extractStaffTenantNameHintFromText_(mergedPayloadText);
        if (textTenantHint) {
          try { logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_TEXT_NAME_HINT name=[" + textTenantHint.slice(0, 30) + "]"); } catch (_) {}
        }
      }
      var finalTenantHint = mediaTenantHint || textTenantHint || "";
      var result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, draftPhone, originPhoneStaff, Object.assign(firstMediaFieldsFromTurnFacts_(turnFacts), {
        inboundKey: staffCapInboundKey,
        OPENAI_API_KEY: OPENAI_API_KEY,
        TWILIO_SID: TWILIO_SID,
        TWILIO_TOKEN: TWILIO_TOKEN,
        TWILIO_NUMBER: TWILIO_NUMBER,
        ONCALL_NUMBER: ONCALL_NUMBER,
        createdByManager: true,
        lang: "en",
        baseVars: baseVars,
        firstMediaUrl: staffMediaUrl,
        mediaType: (staffMediaFacts && staffMediaFacts.mediaType) ? String(staffMediaFacts.mediaType || "").trim() : "",
        mediaCategoryHint: (staffMediaFacts && staffMediaFacts.issueHints && staffMediaFacts.issueHints.category) ? String(staffMediaFacts.issueHints.category || "").trim() : "",
        mediaSubcategoryHint: (staffMediaFacts && staffMediaFacts.issueHints && staffMediaFacts.issueHints.subcategory) ? String(staffMediaFacts.issueHints.subcategory || "").trim() : "",
        mediaUnitHint: (staffMediaFacts && staffMediaFacts.unitHint) ? String(staffMediaFacts.unitHint || "").trim() : "",
        tenantNameHint: finalTenantHint,
        tenantNameTrusted: !!(turnFacts.meta && turnFacts.meta.mediaTenantNameTrusted) || !!textTenantHint
      }));
      if (result && result.ok && Number(result.loggedRow || 0) >= 2 && String(result.ticketId || "").trim()) {
        createdTicket = true;
        ticketId = String(result.ticketId || "").trim();
      }
    }

    var _dtvz = staffCaptureDraftTag_(draftId);
    if (createdTicket) {
      staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_TICKET_CREATED", { ticketId: ticketId, draftTag: _dtvz }, null);
    } else {
      staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_DRAFT_PROGRESS", {
        draftTag: _dtvz,
        missingList: staffCaptureMissingListHuman_(missing) || "None",
        missingLines: staffCaptureDraftProgressMissingLines_(_dtvz, missing),
        visionNote: ""
      }, null);
    }
    return { ok: true, skipSms: true };
  }

  function processStaffMediaVisionQueueTick_() {
    var sh = ensureStaffMediaVisionQueueSheet_();
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return false;

    var start = Math.max(2, lastRow - 60);
    var n = lastRow - start + 1;
    var vals = sh.getRange(start, 1, n, 12).getValues();
    var row = 0;
    var idx = -1;
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][8] || "").trim() === "PENDING") {
        row = start + i;
        idx = i;
        break;
      }
    }
    if (!row || idx < 0) return false;

    var attempts = Number(vals[idx][9] || 0) || 0;
    var staffPhoneForErr = String(vals[idx][3] || "").trim();

    withWriteLock_("SMVQ_MARK_RUNNING", function() {
      sh.getRange(row, 9).setValue("RUNNING");
      sh.getRange(row, 10).setValue(attempts + 1);
      sh.getRange(row, 12).setValue(new Date());
    });

    try {
      var draftId = String(vals[idx][1] || "").trim();
      var draftPhone = String(vals[idx][2] || "").trim();
      var staffPhone = String(vals[idx][3] || "").trim();
      var payloadText = String(vals[idx][4] || "").trim();
      var urlsJson = String(vals[idx][5] || "").trim();
      var kind = String(vals[idx][6] || "FULL").trim().toUpperCase();

      var urlList = [];
      try {
        urlList = JSON.parse(urlsJson);
      } catch (_) {}
      if (!Array.isArray(urlList) || !urlList.length) throw new Error("bad_media_urls");

      var syntheticE = buildSyntheticTwilioEventForMediaUrls_(urlList);
      var staffMediaFacts = (typeof imageSignalAdapter_ === "function") ? imageSignalAdapter_(syntheticE, payloadText, staffPhone) : { hasMedia: false, syntheticBody: "" };
      var mergedPayloadText = payloadText;

      if (kind === "ENRICH") {
        var dir0 = getSheet_(DIRECTORY_SHEET_NAME);
        var dr = (typeof findDirectoryRowByPhone_ === "function") ? findDirectoryRowByPhone_(dir0, draftPhone) : 0;
        var issueFromDir = "";
        if (dr >= 2) issueFromDir = String(dir0.getRange(dr, 5).getValue() || "").trim();
        var seed = issueFromDir || payloadText;
        mergedPayloadText = (typeof mergeMediaIntoBody_ === "function") ? mergeMediaIntoBody_(seed, staffMediaFacts) : seed;
      } else {
        mergedPayloadText = (typeof mergeMediaIntoBody_ === "function") ? mergeMediaIntoBody_(payloadText, staffMediaFacts) : payloadText;
      }

      var sheet = getSheet_(SHEET_NAME);
      var dir = getSheet_(DIRECTORY_SHEET_NAME);

      var out = { ok: false, line: "", skipSms: true };
      withWriteLock_("STAFF_CAPTURE_INGEST_" + draftId, function() {
        out = staffMediaVisionWorkerRunPipeline_(sheet, dir, staffPhone, draftPhone, draftId, mergedPayloadText, staffMediaFacts, urlList, row);
      });

      try {
        logDevSms_(staffPhone, "", "STAFF_MEDIA_VISION_DONE row=" + row + " draftId=" + draftId + " kind=" + kind);
      } catch (_) {}

      withWriteLock_("SMVQ_MARK_DONE", function() {
        sh.getRange(row, 9).setValue("DONE");
        sh.getRange(row, 11).setValue("");
        sh.getRange(row, 12).setValue(new Date());
      });
    } catch (err) {
      var em = String(err && err.message ? err.message : err);

      if (attempts + 1 >= 3) {
        withWriteLock_("SMVQ_MARK_FAILED", function() {
          sh.getRange(row, 9).setValue("FAILED");
          sh.getRange(row, 11).setValue(em.slice(0, 500));
          sh.getRange(row, 12).setValue(new Date());
        });
        try {
          var _dFail = String(vals[idx][1] || "").trim();
          var _sFail = String(vals[idx][3] || "").trim();
          if (_sFail) {
            staffCaptureDispatchOutboundIntent_(_sFail, "STAFF_CAPTURE_INGEST_ERROR", { draftTag: staffCaptureDraftTag_(_dFail) }, null);
          }
        } catch (_) {}
      } else {
        withWriteLock_("SMVQ_MARK_PENDING", function() {
          sh.getRange(row, 9).setValue("PENDING");
          sh.getRange(row, 11).setValue(em.slice(0, 500));
          sh.getRange(row, 12).setValue(new Date());
        });
      }
      try {
        logDevSms_(staffPhoneForErr, "", "STAFF_MEDIA_VISION_ERR " + em);
      } catch (_) {}
    }

    return true;
  }
