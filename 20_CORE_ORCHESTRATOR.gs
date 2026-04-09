/**
 * CORE_ORCHESTRATOR.gs — Propera Layer 12 (Core inbound orchestration)
 *
 * OWNS:
 *   - classifyTenantSignals_ (tone / frustration signals, no I/O)
 *   - handleInboundCore_(e) — full maintenance intake spine (compile, draft, stages, outgate intents)
 *
 * DOES NOT OWN (never add these here):
 *   - Gateway auth, router entry (ROUTER_ENGINE / GATEWAY_WEBHOOK)
 *   - Pure ticket finalize DAL (TICKET_FINALIZE_ENGINE) — called from here
 *   - Lifecycle authority (LIFECYCLE_ENGINE)
 *
 * ENTRY POINTS:
 *   - handleInboundCore_(e) — called from handleSmsSafe_ (DIRECTORY_SESSION_DAL), webhooks, adapters
 *   - classifyTenantSignals_(bodyTrim, ctx)
 *
 * DEPENDENCIES (reads from):
 *   - PROPERA MAIN.gs — COL, SHEET_NAME, helpers above this cut (replyAskPropertyMenu_, findTenantCandidates_, …)
 *   - CANONICAL_INTAKE_ENGINE, INTAKE_RUNTIME, PROPERTY_SCHEDULE_ENGINE, MESSAGING_ENGINE, OUTGATE, etc.
 *
 * FUTURE MIGRATION NOTE:
 *   - Standalone orchestration service; keep deterministic spine; adapters stay thin
 *
 * SECTIONS IN THIS FILE:
 *   1. Tenant signal classification
 *   2. handleInboundCore_ — stage routing, draft, dispatch
 */


  // ===================================================================
  // ===== M3 — CORE PIPELINE (Orchestrator) ============================
  // @MODULE:M3
  // Flow:
  // compileTurn_()
  // draftUpsertFromTurn_()
  // recomputeDraftExpected_()
  // resolveEffectiveTicketState_()
  // ===================================================================

  /**
  * classifyTenantSignals_
  * Pure function — no reads, no writes, no side effects.
  * Returns tone enum + priorRef string for template injection.
  */
  function classifyTenantSignals_(bodyTrim, ctx) {
    var NULL_SIGNALS = { isRecurring: false, isPostService: false, isFrustrated: false, isUrgent: false, tone: "", priorRef: "" };

    try {
      var b = String(bodyTrim || "").trim();

      // Guard: internal turns, single-digit picks, empty body
      if (!b) return NULL_SIGNALS;
      if (/^[1-5]$/.test(b)) return NULL_SIGNALS;
      if (b === "service" || b === "maintenance" || b === "leasing") return NULL_SIGNALS;
      if (ctx && ctx.internal === true) return NULL_SIGNALS;

      var lower = b.toLowerCase();

      var isUrgent      = /\b(flood(ing)?|no heat|no hot water|emergency|gas leak|leak|fire)\b/i.test(b);
      var isPostService = (function() {
        var serviceTokens = /\b(fixed|repaired?|came|visited|maintenance|plumber|tech|service|serviceman|repairman)\b/i.test(b);
        var pastTokens    = /\b(after|since|last time|already|before|when you)\b/i.test(b);
        return serviceTokens && pastTokens;
      })();
      var isRecurring   = /\b(still|again|same|back again|keeps?|keeps? happening|same issue|same problem)\b/i.test(b);
      var isFrustrated  = /\b(ridiculous|frustrated?|never works?|always broken|unacceptable|tired of|sick of)\b/i.test(b);

      // Strict precedence
      var tone = "";
      if (isUrgent)      tone = "urgent";
      else if (isPostService) tone = "postService";
      else if (isRecurring)   tone = "recurring";
      else if (isFrustrated)  tone = "frustrated";

      // priorRef: ID snippet only, no reads needed
      var priorRef = "";
      try {
        var wiId = String((ctx && (ctx.activeWorkItemId || ctx.pendingWorkItemId)) || "").trim();
        if (wiId) {
          var shortId = wiId.slice(-6).toUpperCase();
          priorRef = " (ref " + shortId + ")";
        }
      } catch (_) {}

      return { isRecurring: isRecurring, isPostService: isPostService, isFrustrated: isFrustrated, isUrgent: isUrgent, tone: tone, priorRef: priorRef };

    } catch (_) {
      return NULL_SIGNALS;
    }
  }

  function handleInboundCore_(e) {

    const t0 = Date.now();   // ⏱️ START TIMER

    // IMPORTANT: SID cache is written ONLY if the run finishes without crashing.
    let hadError = false;
    let sidKey = "";

    try {
      const props = PropertiesService.getScriptProperties();

      const OPENAI_API_KEY = props.getProperty("OPENAI_API_KEY");
      const TWILIO_SID = props.getProperty("TWILIO_SID");
      const TWILIO_TOKEN = props.getProperty("TWILIO_TOKEN");
      const TWILIO_NUMBER = props.getProperty("TWILIO_NUMBER");
      const ONCALL_NUMBER = props.getProperty("ONCALL_NUMBER");

      const sheet = getSheet_(SHEET_NAME);
      const dir = getSheet_(DIRECTORY_SHEET_NAME);

      const fromRaw = safeParam_(e, "From");
      let bodyRaw = String(globalThis.__bodyOverride || safeParam_(e, "Body") || "").trim();
      var overrideU = String(globalThis.__bodyOverride || "").toUpperCase();
      if (overrideU === "ATTACHMENT_ONLY") bodyRaw = ""; // ✅ parsing sees empty
      const isStaffCapture =
        String(safeParam_(e, "_staffCapture") || "").trim() === "1";
      let tenantPhoneForPayload = "";
      const phone = (e && e.parameter && e.parameter._phoneE164) ? String(e.parameter._phoneE164).trim() : normalizePhone_(fromRaw);

      try {
        if (e && e.parameter) ensureCanonicalMediaJsonOnParameters_(e.parameter);
      } catch (_em) {}

      const originPhone = phone;
      const fromIsManager = isManager_(originPhone);
      let requesterPhone = phone;
      let domainDecision = null; // inner operational domain router decision (MAINT / CLEANING / future)

      // Router identity lane (Propera Compass)
      const mode = String((e && e.parameter && e.parameter._mode) || "TENANT").toUpperCase();
      const channel = (typeof getResolvedInboundChannel_ === "function")
        ? getResolvedInboundChannel_(e)
        : String((e && e.parameter && e.parameter._channel) || "SMS").toUpperCase();

  // ✅ RECURSION / INTERNAL REPLAY GUARD — allow sanctioned internal replay
  const p0 = (e && e.parameter) ? e.parameter : {};
  const isInternal = String(p0._internal || p0.__internal || "") === "1";
  const allowInternal = String(p0._allowInternal || "") === "1";

  try { logDevSms_(phone, String(bodyRaw || ""), "BUILD " + (typeof BUILD_MARKER !== "undefined" ? BUILD_MARKER : "v=2026-02-12_A")); } catch (_) {}

  // 🔎 TEMP DEBUG (place BEFORE skip so we always see values)
  try {
    logDevSms_(originPhone, bodyRaw,
      "CORE_SEES internal=[" + String(p0._internal || p0.__internal || "") + "]" +
      " allow=[" + String(p0._allowInternal || "") + "]" +
      " mode=[" + String(p0._mode || "") + "]" +
      " reason=[" + String(p0._replayReason || "") + "]"
    );
  } catch (_) {}

  if (isInternal && !allowInternal) {
    try { logDevSms_(originPhone, bodyRaw, "CORE_SKIP_INTERNAL"); } catch (_) {}
    return;
  }


      let createdByManagerFlag = false;

      const baseVars = { brandName: BRAND.name, teamName: BRAND.team };
      const _channel = channel;


      if (!phone) return;
      var _mediaCountGate = (typeof parseCanonicalMediaArrayFromEvent_ === "function")
        ? parseCanonicalMediaArrayFromEvent_(e).length
        : (parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) || 0);
      if (!bodyRaw && !(_mediaCountGate > 0)) return;

      // Pin last inbound surface for timer/async Outgate (Phase 4: PreferredChannel + TelegramChatId)
      try {
        if (mode === "TENANT" && typeof ctxUpsert_ === "function") {
          var _prefCh = String(_channel || "SMS").trim().toUpperCase();
          if (_prefCh !== "WA" && _prefCh !== "TELEGRAM") _prefCh = "SMS";
          // preferredChannel/telegramChatId are durable reply-channel memory for delayed outbound.
          // lastActorKey/lastInboundAt are lightweight audit breadcrumbs.
          var _actorKey = (typeof actorKey_ === "function") ? actorKey_(fromRaw) : String(fromRaw || "").trim();
          if (!_actorKey) _actorKey = String(phone || "").trim();
          var _ctxPatch = {
            preferredChannel: _prefCh,
            lastActorKey: _actorKey,
            lastInboundAt: new Date().toISOString()
          };
          if (_prefCh === "TELEGRAM") {
            var _tcid = String(safeParam_(e, "_telegramChatId") || "").trim();
            if (_tcid) _ctxPatch.telegramChatId = _tcid;
          } else {
            _ctxPatch.telegramChatId = "";
          }
          ctxUpsert_(phone, _ctxPatch, "INBOUND_CHANNEL_PIN");
        }
      } catch (_ctxPin) {}

      // ============================================================
      // STAFF CAPTURE INGEST (early, before any stage handler logic)
      // ============================================================
      if (isStaffCapture) {

        var originPhoneStaff = originPhone;
        var rawPayload = String(bodyRaw || "").trim();

        var parsed0 = parseStaffCapDraftId_(rawPayload);
        var draftId0 = parsed0.draftId;
        if (!draftId0) draftId0 = nextStaffCapDraftId_();

        // Lock per draft id (prevents duplicate ticket creation + races on same draft)
        try {
          withWriteLock_("STAFF_CAPTURE_INGEST_" + draftId0, function() {

          // Re-parse inside lock (rawPayload unchanged; safe)
          var parsed = parseStaffCapDraftId_(rawPayload);
          var draftId = parsed.draftId || draftId0;
          var payloadText = parsed.rest;
          var draftPhone = "SCAP:" + draftId;

          // 2) Resolve or create directory row (needed for status query and upsert)
          var dirRow = ensureDirectoryRowForPhone_(dir, draftPhone);

          // 5) Determine completeness from Directory (source of truth)
          var propCode = String(dir.getRange(dirRow, 2).getValue() || "").trim();   // B
          var propName = String(dir.getRange(dirRow, 3).getValue() || "").trim();    // C
          var issueVal = String(dir.getRange(dirRow, 5).getValue() || "").trim();   // E
          var unitVal  = String(dir.getRange(dirRow, 6).getValue() || "").trim();    // F
          var dirPendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0; // G
          var schedRaw = String(dir.getRange(dirRow, 13).getValue() || "").trim();   // M

          var missing = [];
          if (!propCode) missing.push("property");
          if (!unitVal)  missing.push("unit");
          if (!issueVal) missing.push("issue");

          var payloadTrim = String(payloadText || "").trim();
          var payloadIsEmpty = (typeof isStaffDraftStatusOnlyPayload_ === "function") ? isStaffDraftStatusOnlyPayload_(payloadTrim) : (payloadTrim.length === 0);

          var hasMediaStaff = (typeof parseCanonicalMediaArrayFromEvent_ === "function")
            ? (parseCanonicalMediaArrayFromEvent_(e).length > 0)
            : (parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) > 0);
          var deferStaffVision = hasMediaStaff && (typeof staffMediaVisionDeferEnabled_ === "function") && staffMediaVisionDeferEnabled_();
          var visionDeferralActive = deferStaffVision;

          if (deferStaffVision && payloadIsEmpty) {
            var qOkFull = false;
            try {
              if (typeof enqueueStaffMediaVisionJob_ === "function") {
                qOkFull = enqueueStaffMediaVisionJob_(e, {
                  draftId: draftId,
                  draftPhone: draftPhone,
                  staffPhone: originPhoneStaff,
                  payloadText: payloadText,
                  kind: "FULL"
                });
              }
            } catch (_q) {
              try { logDevSms_(originPhoneStaff, "", "STAFF_MEDIA_VISION_ENQUEUE_ERR " + String(_q && _q.message ? _q.message : _q)); } catch (_) {}
            }
            if (qOkFull) {
              try { logDevSms_(originPhoneStaff, "", "STAFF_MEDIA_VISION_QUEUED kind=FULL draftId=" + draftId); } catch (_) {}
              staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_VISION_QUEUED", { draftTag: staffCaptureDraftTag_(draftId) }, e);
              return;
            }
            visionDeferralActive = false;
          }

          // Propera Compass — Image Signal Adapter (sync unless STAFF_MEDIA_VISION_DEFER=1 defers to queue)
          var staffMediaFacts = { hasMedia: false, syntheticBody: "" };
          var mergedPayloadText = payloadText;
          if (hasMediaStaff && typeof imageSignalAdapter_ === "function" && typeof mergeMediaIntoBody_ === "function") {
            if (!visionDeferralActive) {
              staffMediaFacts = imageSignalAdapter_(e, payloadText, originPhoneStaff);
              mergedPayloadText = mergeMediaIntoBody_(payloadText, staffMediaFacts);
            } else {
              try { logDevSms_(originPhoneStaff, "", "STAFF_MEDIA_VISION_DEFERRED syncVision=0 textPayload=1"); } catch (_) {}
            }
          }
          if (!payloadTrim && mergedPayloadText && staffMediaFacts.syntheticBody) {
            try { logDevSms_(originPhoneStaff, (mergedPayloadText || "").slice(0, 60), "STAFF_CAPTURE_MEDIA_ONLY_SCREENSHOT"); } catch (_) {}
          }
          if (mergedPayloadText !== payloadText && staffMediaFacts.syntheticBody) {
            try { logDevSms_(originPhoneStaff, (mergedPayloadText || "").slice(0, 60), "STAFF_CAPTURE_MEDIA_SYNTH text=[" + (mergedPayloadText || "").slice(0, 50) + "]"); } catch (_) {}
          }

          // Only send draft-status reply when payload is truly empty AND no usable synthetic from media (short text like "Morris", "219", "after 3:30 pm" is continuation)
          var hasUsableSynthetic = staffMediaFacts.syntheticBody && (typeof isWeakIssue_ === "function" && !isWeakIssue_(staffMediaFacts.syntheticBody));
          var statusOnly = payloadIsEmpty && !hasUsableSynthetic;
          if (statusOnly) {
            var _dtSt = staffCaptureDraftTag_(draftId);
            staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_DRAFT_STATUS", {
              draftTag: _dtSt,
              ticketHint: (dirPendingRow >= 2) ? ("Ticket already created (row " + dirPendingRow + ").") : "Not created yet.",
              missingList: staffCaptureMissingListHuman_(missing) || "None",
              missingLines: staffCaptureStatusMissingLines_(_dtSt, missing),
              haveProp: propCode || "?",
              haveUnit: unitVal || "?",
              haveIssue: issueVal ? "Y" : "?"
            }, e);
            return; // Important: do not run compileTurn_ / finalize on empty update
          }

          try { logDevSms_(originPhoneStaff, (mergedPayloadText || "").slice(0, 80), "STAFF_CAPTURE_CONTINUATION_PAYLOAD text=[" + (mergedPayloadText || "").slice(0, 60) + "]"); } catch (_) {}

          // Idempotency: once a ticket exists, don't allow post-create updates via staff ingest.
          if (dirPendingRow >= 2) {
            var _dtAf = staffCaptureDraftTag_(draftId);
            staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_ALREADY_FINAL", {
              draftTag: _dtAf,
              loggedRow: String(dirPendingRow),
              missingBlock: staffCaptureAlreadyFinalMissingBlock_(_dtAf, missing)
            }, e);
            return;
          }

          // 1) Compile turn using existing brain
          var turnFacts = compileTurn_(mergedPayloadText, draftPhone, "en", baseVars, null);
          turnFacts.meta = turnFacts.meta || {};
          var _canonStaff = (typeof parseCanonicalMediaArrayFromEvent_ === "function") ? parseCanonicalMediaArrayFromEvent_(e) : [];
          var _numMediaStaff = _canonStaff.length || (parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) || 0);
          var _mediaUrlsStaff = _canonStaff.length
            ? _canonStaff.map(function (x) { return x.url; })
            : (function () {
                var o = [];
                for (var _si = 0; _si < _numMediaStaff; _si++) {
                  var _u = String(safeParam_(e, "MediaUrl" + _si) || "").trim();
                  if (_u) o.push(_u);
                }
                return o;
              })();
          turnFacts.meta.mediaUrls = _mediaUrlsStaff;

          // Attach media facts to turn for downstream
          if (typeof maybeAttachMediaFactsToTurn_ === "function") maybeAttachMediaFactsToTurn_(turnFacts, staffMediaFacts);

          // STAFF CAPTURE debug: log media-derived hints
          try {
            var _propH = (turnFacts.meta && turnFacts.meta.mediaPropertyHint) ? String(turnFacts.meta.mediaPropertyHint).trim() : "";
            var _unitH = (turnFacts.meta && turnFacts.meta.mediaUnitHint) ? String(turnFacts.meta.mediaUnitHint).trim() : "";
            var _tenantH = (turnFacts.meta && turnFacts.meta.mediaTenantNameHint) ? String(turnFacts.meta.mediaTenantNameHint).trim() : "";
            if (_propH || _unitH || _tenantH) logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_MEDIA_HINTS prop=[" + _propH + "] unit=[" + _unitH + "] tenant=[" + _tenantH + "]");
          } catch (_) {}

          // STAFF CAPTURE fallback: issue from merged payload when compileTurn_ left it blank/weak
          var issueBlankOrWeak = !turnFacts.issue || (typeof isWeakIssue_ === "function" && isWeakIssue_(turnFacts.issue));
          var mergedTrim = String(mergedPayloadText || "").trim();
          var mergedUsable = mergedTrim.length > 0 && (typeof isWeakIssue_ !== "function" ? mergedTrim.length >= 8 : !isWeakIssue_(mergedTrim));
          if (issueBlankOrWeak && mergedUsable) {
            turnFacts.issue = mergedTrim;
            turnFacts.meta = turnFacts.meta || {};
            turnFacts.meta.staffSynthIssue = true;
            try { logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_SYNTH_ISSUE_APPLIED"); } catch (_) {}
          }

          // STAFF CAPTURE fallback: property/unit from media hints only when confidence >= 0.6 (avoids misread numbers e.g. 310→31O)
          var mediaConfident = (typeof staffMediaFacts.confidence === "number" && staffMediaFacts.confidence >= 0.6);
          if (mediaConfident && !turnFacts.property && turnFacts.meta && turnFacts.meta.mediaPropertyHint) {
            var hintProp = (typeof resolvePropertyHintToObj_ === "function") ? resolvePropertyHintToObj_(turnFacts.meta.mediaPropertyHint) : null;
            if (hintProp && hintProp.code) {
              turnFacts.property = { code: hintProp.code, name: hintProp.name || "" };
              try { logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_MEDIA_PROP_APPLIED prop=[" + (hintProp.code || "") + "]"); } catch (_) {}
            }
          }
          if (mediaConfident && !turnFacts.unit && turnFacts.meta && turnFacts.meta.mediaUnitHint) {
            var mediaUnitVal = String(turnFacts.meta.mediaUnitHint || "").trim();
            if (mediaUnitVal) {
              turnFacts.unit = (typeof normalizeUnit_ === "function") ? normalizeUnit_(mediaUnitVal) : mediaUnitVal;
              try { logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_MEDIA_UNIT_APPLIED unit=[" + (turnFacts.unit || "") + "]"); } catch (_) {}
            }
          }

          var weakStaff = !payloadTrim || (typeof isWeakIssue_ === "function" && isWeakIssue_(payloadTrim));
          turnFacts.meta.hasMediaOnly = (_numMediaStaff > 0) && weakStaff;
          if (staffMediaFacts.syntheticBody && (typeof isWeakIssue_ === "function" && !isWeakIssue_(staffMediaFacts.syntheticBody))) turnFacts.meta.hasMediaOnly = false;

          // 3) Draft upsert (staffCapture so multi-issue gets combined title)
          draftUpsertFromTurn_(dir, dirRow, turnFacts, mergedPayloadText, draftPhone, { staffCapture: true });

          // 4) Recompute expected stage
          try { recomputeDraftExpected_(dir, dirRow, draftPhone); } catch (_) {}

          // Re-read Directory after upsert (may have changed)
          propCode = String(dir.getRange(dirRow, 2).getValue() || "").trim();
          propName = String(dir.getRange(dirRow, 3).getValue() || "").trim();
          issueVal = String(dir.getRange(dirRow, 5).getValue() || "").trim();
          unitVal  = String(dir.getRange(dirRow, 6).getValue() || "").trim();
          dirPendingRow = parseInt(String(dir.getRange(dirRow, 7).getValue() || "0"), 10) || 0;
          schedRaw = String(dir.getRange(dirRow, 13).getValue() || "").trim();
          missing = [];
          if (!propCode) missing.push("property");
          if (!unitVal)  missing.push("unit");
          if (!issueVal) missing.push("issue");

          // Promote to real ticket ONLY when triad complete and no ticket exists yet (canonical factory)
          var createdTicket = false;
          var ticketId = "";
          var loggedRow = 0;

          if (dirRow >= 2 && !missing.length && dirPendingRow < 2) {
            var sid = String(safeParam_(e, "MessageSid") || safeParam_(e, "SmsMessageSid") || "").trim();
            var staffCapInboundKey = sid
              ? ("STAFFCAP:" + draftId + ":" + sid)
              : (function() {
                  var payload = String(originPhoneStaff || "") + "|" + draftId + "|" + payloadText;
                  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, payload, Utilities.Charset.UTF_8);
                  var hex12 = digest.slice(0, 6).map(function(b) { return ("0" + ((b + 256) % 256).toString(16)).slice(-2); }).join("").slice(0, 12);
                  return "STAFFCAP_FALLBACK:" + draftId + ":" + hex12;
                })();

            var staffMediaUrl = (turnFacts.meta && turnFacts.meta.mediaUrls && turnFacts.meta.mediaUrls[0]) ? String(turnFacts.meta.mediaUrls[0]).trim() : "";
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
              loggedRow = Number(result.loggedRow || 0) || 0;

              schedRaw = String(dir.getRange(dirRow, 13).getValue() || "").trim();
            }
          }

          // Phase 1: do not require schedule for staff capture
          // if (!missing.length && !schedRaw) missing.push("schedule");

          var _draftTag = staffCaptureDraftTag_(draftId);
          var _visionEnq = false;
          if (visionDeferralActive && hasMediaStaff && !payloadIsEmpty) {
            try {
              if (typeof enqueueStaffMediaVisionJob_ === "function" &&
                  enqueueStaffMediaVisionJob_(e, {
                    draftId: draftId,
                    draftPhone: draftPhone,
                    staffPhone: originPhoneStaff,
                    payloadText: payloadText,
                    kind: "ENRICH"
                  })) {
                _visionEnq = true;
                try { logDevSms_(originPhoneStaff, "", "STAFF_MEDIA_VISION_QUEUED kind=ENRICH draftId=" + draftId); } catch (_) {}
              }
            } catch (_en) {
              try { logDevSms_(originPhoneStaff, "", "STAFF_MEDIA_VISION_ENQUEUE_ERR enr " + String(_en && _en.message ? _en.message : _en)); } catch (_) {}
            }
          }

          if (createdTicket) {
            staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_TICKET_CREATED", { ticketId: ticketId, draftTag: _draftTag }, e);
          } else {
            var _vNote = staffCaptureVisionNoteVars_(_visionEnq, _draftTag).visionNote;
            staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_DRAFT_PROGRESS", {
              draftTag: _draftTag,
              missingList: staffCaptureMissingListHuman_(missing) || "None",
              missingLines: staffCaptureDraftProgressMissingLines_(_draftTag, missing),
              visionNote: _vNote
            }, e);
          }

          try {
            logDevSms_(originPhoneStaff, payloadText.slice(0, 60),
              "STAFF_CAPTURE_CONFIRM draftId=[" + draftId + "] missing=[" + (missing.join("|") || "none") +
              "] prop=[" + (propCode || "") + "] unit=[" + (unitVal || "") + "] sched=[" + (schedRaw ? "Y" : "N") + "]" +
              (createdTicket ? " ticketId=[" + ticketId + "]" : ""));
          } catch (_) {}

          });
        } catch (err) {
          try {
            logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_INGEST_ERR msg=[" + (err && err.message ? err.message : String(err)) + "]");
            if (err && err.stack) logDevSms_(originPhoneStaff, "", "STAFF_CAPTURE_INGEST_STACK " + String(err.stack).slice(0, 900));
          } catch (_) {}
          try {
            staffCaptureDispatchOutboundIntent_(originPhoneStaff, "STAFF_CAPTURE_INGEST_ERROR", { draftTag: staffCaptureDraftTag_(draftId0 || "") }, e);
          } catch (_) {}
        }

        return;
      }



      

  // Legacy manager SMS new-ticket flow removed. Portal + lifecycle own manager ops.
  const bodyTrim0 = String(bodyRaw || "").trim();
  if (fromIsManager && /^new\s*ticket\b/i.test(bodyTrim0)) {
    try {
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
        "Manager SMS new-ticket flow is retired. Please use the PM portal."
      );
    } catch (_) {}
    return;
  }

  // ✅ Canonical digits + canonical trimmed body
  const digits = normalizePhoneDigits_(phone);
  let bodyTrim = String(bodyRaw || "").trim(); // must be LET
  // ✅ Detect manager-created synthetic ticket ASAP (must be BEFORE confirm gate)
  let createdByManager = createdByManagerFlag;

  if (bodyTrim.startsWith(MGR_NEW_TICKET_PREFIX)) {
    createdByManager = true;
    createdByManagerFlag = true;
    bodyTrim = bodyTrim.replace(MGR_NEW_TICKET_PREFIX, "").trim();
  }

  // =====================================
  // VENDOR COMMAND HANDLER (vendor-only; never tenant pipeline)
  // =====================================
  try {
    const d10 = String(normalizePhoneDigits_(phone) || "").slice(-10);
    const vendor = getVendorByPhoneDigits_(d10);

    if (vendor) {
      const creds = { TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER };

      // 1) Normal YES/NO handler (existing)
      let handled = handleVendorAcceptDecline_(vendor, sheet, bodyTrim, creds);

      // ✅ ALWAYS stop if handled (vendor must never fall through)
      if (handled) {
        try { logDevSms_(phone, "VENDOR_GATE handled=true", "VENDOR_GATE"); } catch (_) {}
        return;
      }

      // 2) NEW: availability-only counts as YES
      handled = handleVendorAvailabilityOnly_(vendor, sheet, bodyTrim, creds);

      if (!handled) {
        // 3) Not understood -> instructions
        replyVendor_(
          creds,
          vendor.phone,
          tenantMsg_("VENDOR_CONFIRM_INSTRUCTIONS", "en", {
            brandName: BRAND.name,
            teamName: BRAND.team
          })
        );
      }

      try { logDevSms_(phone, "VENDOR_GATE handled=" + String(handled), "VENDOR_GATE"); } catch (_) {}
      return; // ✅ ALWAYS stop for vendor numbers
    }
  } catch (e) {
    try { logDevSms_(phone, "Vendor handler crash: " + e, "VENDOR_CMD_CRASH"); } catch (_) {}
    // ✅ HARD STOP: never let vendor numbers fall into tenant pipeline
    return;
  }





  const cache = CacheService.getScriptCache();
  const isInternalReplay = String(safeParam_(e, "_internal") || safeParam_(e, "__internal") || "") === "1";



  var _obTgtCore = buildTenantOutboundTarget_(e, originPhone, { bodyForNosid: bodyTrim });
  const inboundKey = _obTgtCore.inboundDedupeKey || ("SID:SMS:NOSID:" + (typeof _nosidDigest_ === "function" ? _nosidDigest_(String(safeParam_(e, "From") || "").toLowerCase(), bodyTrim) : String((bodyTrim || "").length)));
  const sidSafe = _obTgtCore.dedupeId;
  var ch = _obTgtCore.dedupeChannel || "SMS";
  var sidForLayer1 = sidSafe && String(sidSafe).indexOf("NOSID:") !== 0 ? String(sidSafe) : "";
  const sid = sidForLayer1;

  // trace id for this execution (lets us correlate logs)
  const trace = Utilities.getUuid().slice(0, 8);
  // Outbound logging correlation id (prefer transport-level eid if adapters set it)
  try {
    if (typeof globalThis !== "undefined") {
      globalThis.__properaTurnTrace = trace;
      globalThis.__properaTurnEid = (globalThis.__inboundEventEid && String(globalThis.__inboundEventEid).trim())
        ? String(globalThis.__inboundEventEid).trim()
        : String(trace);
    }
  } catch (_) {}
  const bodyShort = String(bodyTrim || "").slice(0, 80);

  // --------- DEDUPE LAYER 0: Burst duplicate (same phone + same body, short window) ----------
  const burstBody = String(bodyTrim || "").toLowerCase().replace(/\s+/g, " ").trim();
  const burstFpRaw = originPhone + "|" + burstBody;
  const burstFp = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, burstFpRaw)
  );
  const burstKey = "BURST_" + burstFp;

  if (!isInternalReplay) {
    if (cache.get(burstKey)) {
      try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=1 sidHit=0 fpHit=0 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}
      return;
    }
    cache.put(burstKey, "1", 20);
  }


  // --------- DEDUPE LAYER 1: transport-stable id retries (Twilio SID or Telegram update id) ----------
  if (!isInternalReplay && sidForLayer1) {
    sidKey = "TWILIO_SID_" + ch + "_" + sidForLayer1;

    if (cache.get(sidKey)) {
      try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=0 sidHit=1 fpHit=0 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}
      return;
    }

    // DO NOT cache.put here — finally will put sidKey only if no crash
  }


  // --------- DEDUPE LAYER 2: fingerprint ----------
  if (!isInternalReplay) {
    const fpRaw = originPhone + "|" + bodyTrim + "|" + sidSafe;
    const fp = Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, fpRaw)
    );
    const fpKey = "FP_" + fp;

    if (cache.get(fpKey)) {
      try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=0 sidHit=0 fpHit=1 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}
      return;
    }
    cache.put(fpKey, "1", 120);
  }

  try { logDevSms_(originPhone, bodyShort, "DEDUP_RESULT trace=" + trace + " sid=" + String(sid || "") + " burst=0 sidHit=0 fpHit=0 inboundKey=" + inboundKey + " internal=" + String(isInternalReplay)); } catch (_) {}

  // Legacy manager SMS command lane removed. Portal + lifecycle are canonical owners.
  if (fromIsManager && !createdByManager) {
    try {
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, originPhone,
        "Manager SMS commands are retired. Please use the PM portal."
      );
    } catch (_) {}
    return;
  }





  // -------------------------
  // 1) Directory lookup + create (LOCKED DECISION)
  // -------------------------
  let dirRow = 0;

  try {
    withWriteLock_("DIR_FIND_OR_CREATE", () => {
      dirRow = findDirectoryRowByPhone_(dir, phone);

      if (!dirRow) {
        const phoneRaw = String(phone || "").trim();
        const phoneStored = /^SCAP:/i.test(phoneRaw) ? phoneRaw : normalizePhone_(phoneRaw);

        dir.appendRow([phoneStored, "", "", new Date(), "", "", "", "", "", ""]);
        dirRow = dir.getLastRow();
      }
    });
  } catch (err) {
    Logger.log("DIR_FIND_OR_CREATE_ERR " + err);
    try { logDevSms_(phone, bodyRaw || "", "DIR_FIND_OR_CREATE_ERR", String(err)); } catch (_) {}
  }

  // continue with your existing reads
  let propertyCode = "";
  let propertyName = "";
  let pendingIssue = "";
  let pendingUnit = "";
  let pendingRow = 0;

  if (dirRow > 0) {
    var norm = normalizeDirTicketPointer_(sheet, dir, dirRow, phone);
    var propDir = dalGetPendingProperty_(dir, dirRow);
    propertyCode = propDir.code;
    propertyName = propDir.name;
    pendingIssue = dalGetPendingIssue_(dir, dirRow);
    pendingUnit  = dalGetPendingUnit_(dir, dirRow);
    pendingRow   = dalGetPendingRow_(dir, dirRow);

    try {
      dalWithLock_("DIR_TOUCH", function () {
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE DIR_TOUCH row=" + dirRow); } catch (_) {}
      });
    } catch (err) {
      Logger.log("DIR_TOUCH_ERR " + err);
      try { logDevSms_(phone, bodyRaw || "", "DIR_TOUCH_ERR", String(err)); } catch (_) {}
    }
  }

  let pendingStage = getDirPendingStage_(dir, dirRow);
  try {
    baseVars.__pendingCollectStage = "";
    baseVars.__priorPendingIssue = "";
    baseVars.__priorPendingPropertyCode = "";
    baseVars.__priorPendingPropertyName = "";
    baseVars.__priorPendingUnit = "";
    if (mode === "TENANT" && dirRow > 0) {
      var _ctxSlot = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      var _expSlot = String((_ctxSlot && _ctxSlot.pendingExpected) || pendingStage || "").trim().toUpperCase();
      baseVars.__pendingCollectStage = _expSlot;
      var _sSlot = {};
      if (typeof sessionGet_ === "function") {
        try { _sSlot = sessionGet_(phone) || {}; } catch (_) { _sSlot = {}; }
      }
      var _pip = String(pendingIssue || _sSlot.draftIssue || "").trim();
      baseVars.__priorPendingIssue = _pip;
      baseVars.__priorPendingPropertyCode = String(propertyCode || _sSlot.draftProperty || "").trim();
      baseVars.__priorPendingPropertyName = String(propertyName || "").trim();
      baseVars.__priorPendingUnit = String(pendingUnit || _sSlot.draftUnit || "").trim();
    }
  } catch (_) {}
  var compassNoReopenIntake = String(safeParam_(e, "_compassNoReopenIntake") || "").trim() === "1";
  var numMediaEarly = (typeof parseCanonicalMediaArrayFromEvent_ === "function")
    ? parseCanonicalMediaArrayFromEvent_(e).length
    : (parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) || 0);

  // -------------------------
  // language + welcome line (must be before CONTEXT COMPILER so lang is defined for compileTurn_)
  // Package turnFacts.lang overrides for rendering after compile (single detection in properaBuildIntakePackage_).
  // -------------------------
  let lang = getTenantLang_(dir, dirRow, phone, bodyRaw);
  let welcomeLine = getWelcomeLineOnce_(dir, dirRow, lang);

  // Phase 0 — CIG No-Op Fast Lane (immediate relief, deterministic)
  try {
    const killRaw = String((props && typeof props.getProperty === "function") ? props.getProperty("CIG_NOOP_ENABLED") : "").trim().toLowerCase();
    const noopEnabled = !(killRaw === "0" || killRaw === "false" || killRaw === "off" || killRaw === "no");
    const msgTrim = String(bodyTrim || "").trim();
    const msgLenOk = msgTrim && msgTrim.length < 30;
    const noMediaOk = !(numMediaEarly > 0);
    if (noopEnabled && msgLenOk && noMediaOk) {
      const ctx0 = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      const fast = (typeof cigNoOpFastLane_ === "function") ? cigNoOpFastLane_(phone, msgTrim, ctx0) : { handled: false };
      if (fast && fast.handled) {
        const move = String(fast.move || "").trim() || "ACK";
        try { logDevSms_(phone, msgTrim, "CIG_NOOP_FAST move=[" + move + "] reason=[deterministic_no_pending]"); } catch (_) {}

        // Outbound proof: safe template reply via Outgate, no LLM, no package build.
        const _ogFast = (typeof dispatchOutboundIntent_ === "function")
          ? dispatchOutboundIntent_({
              intentType: move,
              templateKey: move, // ensures OUTGATE can render even if semantic map not yet updated
              recipientType: "TENANT",
              recipientRef: phone,
              lang: lang,
              channel: (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : _channel,
              deliveryPolicy: "NO_HEADER",
              vars: Object.assign({}, baseVars),
              meta: { source: "HANDLE_INBOUND_CORE", stage: "CIG_NOOP_FAST", flow: "MAINTENANCE_INTAKE" }
            })
          : { ok: false };

        if (_ogFast && _ogFast.ok) return;
        try { logDevSms_(phone, msgTrim, "CIG_NOOP_FAST_OUTGATE_FAIL move=[" + move + "]"); } catch (_) {}
      }
    }
  } catch (_) {}

  const dayWord = scheduleDayWord_(new Date()); // Today/Tomorrow
  const dayLine = dayWord
    ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, baseVars, { dayWord: dayWord })))
    : "";

  // =============================================================================
  //  CONTEXT COMPILER (Compass-safe, additive)
  // Propera Compass — Image Signal Adapter (Phase 1): merge media synthetic body before compileTurn_
  // Short-reply lane: skip compile + opener + shadow + domain when router set _compassNoReopenIntake
  // =============================================================================
  var mediaFacts = { hasMedia: false, syntheticBody: "" };
  var mergedBodyTrim = bodyTrim;
  let turnFacts = { property: null, unit: "", schedule: null, issue: "", isGreeting: false, isAck: false };
  var earlyCleaningHandled = false;
  try {
    if (typeof runIntakeOrchestration_ === "function") {
      var _intakeOrch = runIntakeOrchestration_({
        e: e,
        mode: mode,
        dir: dir,
        dirRow: dirRow,
        phone: phone,
        originPhone: originPhone,
        bodyTrim: bodyTrim,
        OPENAI_API_KEY: OPENAI_API_KEY,
        baseVars: baseVars,
        propertyCode: propertyCode,
        propertyName: propertyName,
        pendingUnit: pendingUnit,
        pendingStage: pendingStage,
        pendingRow: pendingRow,
        lang: lang,
        welcomeLine: welcomeLine,
        compassNoReopenIntake: compassNoReopenIntake,
        channel: _channel,
        OPS_CLEANING_LIVE_DIVERT_ENABLED: OPS_CLEANING_LIVE_DIVERT_ENABLED,
        numMediaEarly: numMediaEarly
      }) || {};
      mediaFacts = _intakeOrch.mediaFacts || mediaFacts;
      mergedBodyTrim = _intakeOrch.mergedBodyTrim != null ? _intakeOrch.mergedBodyTrim : mergedBodyTrim;
      turnFacts = _intakeOrch.turnFacts || turnFacts;
      lang = _intakeOrch.lang || lang;
      welcomeLine = _intakeOrch.welcomeLine || welcomeLine;
      domainDecision = (_intakeOrch.domainDecision !== undefined) ? _intakeOrch.domainDecision : domainDecision;
      earlyCleaningHandled = !!_intakeOrch.earlyCleaningHandled;
    }
  } catch (_) {}
  if (earlyCleaningHandled) return;

  // Captured slots THIS inbound (for smarter re-asks; deterministic).
  // Derived from final turnFacts (same as compileTurn_ output after merge; normalized unit, explicit property, issue).
  var cap = { hasProp: false, propCode: "", propName: "", hasUnit: false, unit: "", hasIssue: false, issue: "", issueHint: "", hasSchedule: false };
  var openerNextStage = "";
  try {
    if (typeof buildIntakePromptContext_ === "function") {
      var _ipc = buildIntakePromptContext_(turnFacts) || {};
      cap = _ipc.cap || cap;
      openerNextStage = String(_ipc.openerNextStage || "");
    }
  } catch (_) {}

  function packagedAskVarsForTurn_(hint) {
    if (typeof intakePackagedAskVars_ === "function") {
      return intakePackagedAskVars_(baseVars, turnFacts, hint);
    }
    return Object.assign({}, baseVars || {}, { issueHint: String(hint || "").trim() });
  }

  // ── DRAFT ACCUMULATOR + STATE RESOLVER (Compass draft-first) ──
  // Run after compileTurn_ produces turnFacts.
  // Session: initial snapshot for draft; Phase 4 refreshes after draft + after recompute so resolver matches sheet/ctx.
  var _resolverCtx = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
  var _session = (typeof sessionGet_ === "function") ? (sessionGet_(phone) || {}) : {};
  try {
    if (typeof runIntakeCommunicationGate_ === "function") {
      var _gateOrch = runIntakeCommunicationGate_({
        phone: phone,
        mode: mode,
        dirRow: dirRow,
        bodyTrim: bodyTrim,
        mergedBodyTrim: mergedBodyTrim,
        turnFacts: turnFacts,
        resolverCtx: _resolverCtx,
        session: _session,
        channel: _channel,
        props: props
      }) || {};
      _resolverCtx = _gateOrch.resolverCtx || _resolverCtx;
      _session = _gateOrch.session || _session;
      baseVars.priorRef = String(_gateOrch.priorRef || "");
      baseVars.tone = String(_gateOrch.tone || "");
      if (_gateOrch.handled) return;
    } else {
      const signals = classifyTenantSignals_(bodyTrim, _resolverCtx);
      baseVars.priorRef = signals.priorRef;
      baseVars.tone = signals.tone;
    }
  } catch (_) {}

  // 1) Fill draft fields + recompute + canonical stage authority (orchestrated).
  var prevStageBeforeRecompute = "";
  var didAppendIssueThisTurn = false;
  var openerCommittedStage = "";
  var _canonicalStageForAuthority = "";
  try {
    if (typeof runDraftStageAuthority_ === "function") {
      var _draftOrch = runDraftStageAuthority_({
        mode: mode,
        dir: dir,
        dirRow: dirRow,
        pendingRow: pendingRow,
        phone: phone,
        compassNoReopenIntake: compassNoReopenIntake,
        turnFacts: turnFacts,
        mergedBodyTrim: mergedBodyTrim,
        openerNextStage: openerNextStage,
        resolverCtx: _resolverCtx,
        session: _session
      }) || {};
      prevStageBeforeRecompute = String(_draftOrch.prevStageBeforeRecompute || "");
      didAppendIssueThisTurn = !!_draftOrch.didAppendIssueThisTurn;
      openerCommittedStage = String(_draftOrch.openerCommittedStage || "");
      _canonicalStageForAuthority = String(_draftOrch.canonicalStageForAuthority || "");
      _resolverCtx = _draftOrch.resolverCtx || _resolverCtx;
      _session = _draftOrch.session || _session;
    }
  } catch (_) {}

  // Opener authority short-circuit:
  // once opener commits progression stage for this turn, emit prompt directly and stop.
  try {
    if (typeof runOpenerDirectPrompt_ === "function") {
      var _openerDirect = runOpenerDirectPrompt_({
        mode: mode,
        openerCommittedStage: openerCommittedStage,
        phone: phone,
        sidSafe: sidSafe || "",
        pendingRow: pendingRow,
        resolverCtx: _resolverCtx,
        e: e,
        bodyTrim: bodyTrim,
        lang: lang,
        channel: _channel,
        baseVars: baseVars,
        cap: cap,
        packagedAskVarsForTurn: packagedAskVarsForTurn_
      }) || { handled: false };
      if (_openerDirect && _openerDirect.handled) return;
    }
  } catch (_) {}

  // 2) Single canonical state decision
  const ticketState = resolveEffectiveTicketState_(dir, dirRow, _resolverCtx, _session);

  // Keep effectiveStage as the variable name — all downstream handlers use it unchanged
  let effectiveStage = ticketState.stage;
  pendingStage = effectiveStage;

  try { writeTimeline_("STATE", { effectiveStage: effectiveStage || "", pendingExpected: (_resolverCtx && _resolverCtx.pendingExpected) || "" }, null); } catch (_) {}
  try { writeTimeline_("HANDLER", { fn: effectiveStage || "NEW" }, null); } catch (_) {}

  // Manager->tenant override: force empty stage (Rule A)
  try {
    const o = String(originPhone || "").trim();
    const ph = String(phone || "").trim();
    if (mode === "MANAGER" && o && ph && o !== ph) {
      try { logDevSms_(o, bodyTrim, "MANAGER_TENANT_OVERRIDE was=[" + effectiveStage + "]"); } catch (_) {}
      effectiveStage = "";
      pendingStage = "";
    }
  } catch (_) {}

  // -------------------------
  // Reply helper + "never silent" tracking (TENANT FLOW)
  // MUST run before STAGE_ADVANCE_GUARD: runStageAdvanceGuard_ calls replyFn(reply_) which
  // requires _outboundFns from buildCoreReplyFns_. If guard runs first, reply_() no-ops and
  // tenants get empty TwiML / no SMS (ASK_PROPERTY_GOT_UNIT, etc.).
  // -------------------------
  var replied = false;
  var _outboundFns = (typeof buildCoreReplyFns_ === "function")
    ? buildCoreReplyFns_({
        e: e,
        channel: _channel,
        lang: lang,
        effectiveStage: effectiveStage,
        phone: phone,
        safeTrunc: (typeof safeTrunc_ === "function") ? safeTrunc_ : null
      })
    : null;
  function tenantReplyChannelThisTurn_() {
    if (_outboundFns && typeof _outboundFns.tenantReplyChannelThisTurn_ === "function") return _outboundFns.tenantReplyChannelThisTurn_();
    return String(_channel || "SMS").trim().toUpperCase();
  }
  function dispatchOperationalText_(recipientType, recipientRef, text, policy, intentType) {
    if (_outboundFns && typeof _outboundFns.dispatchOperationalText_ === "function") return _outboundFns.dispatchOperationalText_(recipientType, recipientRef, text, policy, intentType);
    return false;
  }
  function replyTo_(toPhone, text) {
    if (_outboundFns && typeof _outboundFns.replyTo_ === "function") _outboundFns.replyTo_(toPhone, text);
  }
  function reply_(text) {
    replied = true;
    if (_outboundFns && typeof _outboundFns.reply_ === "function") _outboundFns.reply_(text);
    if (_outboundFns && typeof _outboundFns.isReplied_ === "function") replied = !!_outboundFns.isReplied_();
  }
  function replyNoHeader_(text) {
    replied = true;
    if (_outboundFns && typeof _outboundFns.replyNoHeader_ === "function") _outboundFns.replyNoHeader_(text);
    if (_outboundFns && typeof _outboundFns.isReplied_ === "function") replied = !!_outboundFns.isReplied_();
  }

  // STAGE ADVANCE GUARD: only for conversational prompt stages (PROPERTY, UNIT, SCHEDULE).
  // Never guard system transition stages (FINALIZE_DRAFT, EMERGENCY_DONE, CLOSE) — they must run.
  try {
    if (typeof runStageAdvanceGuard_ === "function") {
      var _stageGuard = runStageAdvanceGuard_({
        mode: mode,
        dirRow: dirRow,
        prevStageBeforeRecompute: prevStageBeforeRecompute,
        effectiveStage: effectiveStage,
        phone: phone,
        sidSafe: sidSafe || "",
        e: e,
        bodyTrim: bodyTrim,
        cap: cap,
        baseVars: baseVars,
        lang: lang,
        channel: _channel,
        ticketState: ticketState,
        pendingRow: pendingRow,
        resolverCtx: _resolverCtx,
        turnFacts: turnFacts,
        packagedAskVarsForTurn: packagedAskVarsForTurn_,
        replyFn: reply_
      }) || { handled: false, markReplied: false };
      if (_stageGuard.markReplied) replied = true;
      if (_stageGuard.handled) return;
    }
  } catch (_) {}

  try {
    logDevSms_(phone, bodyTrim,
      "STATE_RESOLVED type=[" + ticketState.stateType + "] stage=[" + ticketState.stage + "]" +
      " pendingRow=[" + String(dalGetPendingRow_(dir, dirRow) || "") + "]" +
      " draftIssue=[" + String(dalGetPendingIssue_(dir, dirRow) || "").slice(0, 30) + "]" +
      " activeWI=[" + String(_resolverCtx.activeWorkItemId || "") + "]"
    );
  } catch (_) {}

  try {
    logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((_resolverCtx && _resolverCtx.pendingExpected) || ""), "");
  } catch (_) {}

  // -------------------------
  // 1.1) CTX STABILIZATION (Compass-safe)
  // If Directory shows no active conversation, do NOT carry stale ctx pointers.
  // -------------------------
  try {
    const pr = Number(pendingRow || 0) || 0;
    const ps = String(effectiveStage || "").trim(); // use effectiveStage, not pendingStage

    const hasActiveDir = !!(ps || pr);

    if (!hasActiveDir && ctx) {
      ctx.pendingExpected = "";
      ctx.pendingExpiresAt = "";
      ctx.pendingWorkItemId = "";
      ctx.activeWorkItemId = "";
      try { logDevSms_(originPhone, String(bodyTrim || ""), "CTX_STABILIZE cleared (no dir stage/row) trace=" + trace); } catch (_) {}
    }
  } catch (_) {}

  // -------------------------------------------------
  // Stability lock: never create tickets from ACK-only
  // unless we're in a pending stage (TENANT only)
  // -------------------------------------------------
  try {
    if (mode === "TENANT") {
      const ackOnly = looksLikeAckOnly_(String(bodyTrim || "").toLowerCase().trim());
      const ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      const hasPending = !!(ctx && ctx.pendingExpected && String(ctx.pendingExpected).trim());

      if (ackOnly && !hasPending) {
        var _ogA = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TENANT_ACK_NO_PENDING", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ACK_ONLY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogA && _ogA.ok)) reply_(renderTenantKey_("TENANT_ACK_NO_PENDING", lang, baseVars));
        try { logDevSms_(originPhone, String(bodyTrim || ""), "CORE_ACK_ONLY_NO_PENDING"); } catch (_) {}
        return;
      }
    }
  } catch (_) {}


  // -----------------------------
  // TENANT COMMANDS + AWAITING
  // -----------------------------
  try {
    if (typeof handleTenantCommandsAndAwaiting_ === "function") {
      var _cmdRes = handleTenantCommandsAndAwaiting_({
        sheet: sheet,
        dir: dir,
        dirRow: dirRow,
        digits: digits,
        phone: phone,
        bodyTrim: bodyTrim,
        dayWord: dayWord,
        lang: lang,
        dayLine: dayLine,
        replyFn: reply_
      }) || { handled: false };
      if (_cmdRes && _cmdRes.handled) return;
    }
  } catch (_) {}


  // -------------------------
  // 1.4) Tenant DB lookup
  // -------------------------

  // =========================
  // PRE-GATES (schedule force + confirm gate skip)
  // =========================
  try {
    if (typeof runIntakePreGates_ === "function") {
      var _preGates = runIntakePreGates_({
        mode: mode,
        e: e,
        dir: dir,
        dirRow: dirRow,
        bodyTrim: bodyTrim,
        resolverCtx: _resolverCtx,
        effectiveStage: effectiveStage,
        pendingStage: pendingStage,
        phone: phone,
        lang: lang,
        channel: _channel,
        baseVars: baseVars,
        turnFacts: turnFacts,
        replyNoHeaderFn: replyNoHeader_
      }) || { handled: false, effectiveStage: effectiveStage, pendingStage: pendingStage };
      effectiveStage = String(_preGates.effectiveStage || effectiveStage);
      pendingStage = String(_preGates.pendingStage || pendingStage);
      if (_preGates.handled) return;
    }
  } catch (_) {}



  // ── UNIT-ONLY SALVAGE block DELETED (Step F) ──
  // draftUpsertFromTurn_() now captures unit on every message before any stage logic runs.
  // The salvage block is unreachable.




  // -------------------------
  // 3.5) HANDLE PENDING STAGES
  // -------------------------


  // -------------------------
  // EMERGENCY_DONE: treat any inbound as a follow-up note (no new ticket)
  // GUARD: Emergency follow-up must never create new ticket; never open schedule stage.
  // - NEVER creates a new ticket
  // - Always uses Directory.PendingRow pointer; append only via safe helper
  // - Keeps PendingStage="EMERGENCY_DONE" so future inbound stays follow-up
  // - If pointer missing: log EMERGENCY_CONTINUATION_POINTER_MISSING, ask PROPERTY, stay EMERGENCY_DONE
  // -------------------------
  if (pendingStage === "EMERGENCY_DONE") {
    try { logDevSms_(phone, bodyTrim, "EMERGENCY_CONTINUATION_HIT"); } catch (_) {}
    const now = new Date();
    const pr = dalGetPendingRow_(dir, dirRow);
    const add = String(bodyTrim || "").trim();

    // If pointer missing, safest: ask PROPERTY but KEEP EMERGENCY_DONE stage. Never open new ticket.
    if (pr < 2) {
      try { logDevSms_(phone, "", "EMERGENCY_CONTINUATION_POINTER_MISSING action=ask_property stay=EMERGENCY_DONE"); } catch (_) {}
      reply_(replyAskPropertyMenu_(lang, baseVars));

      try { dalSetPendingStage_(dir, dirRow, "EMERGENCY_DONE", phone, "EMERGENCY_DONE_NO_PTR_KEEP_STAGE"); } catch (_) {}

      // ctx expects PROPERTY next (so PROPERTY handler can recover pointer)
      try {
        const ctxNow = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
        ctxUpsert_(phone, {
          pendingWorkItemId: String(ctxNow.pendingWorkItemId || ctxNow.activeWorkItemId || "").trim(),
          pendingExpected: "PROPERTY",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "EMERGENCY_DONE_NO_PTR_EXPECT_PROPERTY");
        try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
      } catch (_) {}

      return;
    }

    // Append follow-up to ticket (and update last update) under lock
    if (add) {
      withWriteLock_("EMERGENCY_DONE_APPEND", () => {
        const prevMsg = String(sheet.getRange(pr, COL.MSG).getValue() || "").trim();
        const combined = prevMsg ? (prevMsg + " | Follow-up: " + add) : ("Follow-up: " + add);

        sheet.getRange(pr, COL.MSG).setValue(combined);
        sheet.getRange(pr, COL.LAST_UPDATE).setValue(now);
      });
      try { logDevSms_(phone, add.slice(0, 60), "EMERGENCY_FOLLOWUP_APPENDED row=" + pr); } catch (_) {}
    }

    // Keep ticket active
    setStatus_(sheet, pr, "In Progress");

    // Keep Directory pointer + stage stable (locked)
    try {
      dalWithLock_("EMERGENCY_DONE_KEEP_STAGE", function () {
        dalSetPendingRowNoLock_(dir, dirRow, pr);
        dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE EMERGENCY_DONE_KEEP_STAGE row=" + dirRow + " pr=" + pr); } catch (_) {}
        try { logDevSms_(phone || "", "", "EMERGENCY_CONTINUATION_KEEP stage=EMERGENCY_DONE"); } catch (_) {}
      });
    } catch (_) {}

    // ✅ Optional: forward follow-up to oncall (recommended)
    // NOTE: This message is NOT tenant-facing, but still consider migrating to a manager template system later.
    if (add) {
      try {
        const tid  = String(sheet.getRange(pr, COL.TICKET_ID).getValue() || "").trim();
        const prop = String(sheet.getRange(pr, COL.PROPERTY).getValue() || "").trim();
        const unitNow = String(sheet.getRange(pr, COL.UNIT).getValue() || "").trim();

        const mgrMsg = tenantMsg_("EMERGENCY_FOLLOWUP_TO_ONCALL", "en", {
          ticketId: tid,
          phone: phone,
          propertyName: prop,
          unit: unitNow,
          msg: add
        });
        if (typeof dispatchOutboundIntent_ === "function") {
          dispatchOutboundIntent_({
            intentType: "CORE_TEXT_REPLY",
            recipientType: "TENANT",
            recipientRef: ONCALL_NUMBER,
            channel: "SMS",
            lang: "en",
            deliveryPolicy: "DIRECT_SEND",
            preRenderedBody: mgrMsg,
            vars: {},
            meta: { source: "handleInboundCore_", stage: "EMERGENCY_DONE", flow: "ONCALL_NOTIFY" }
          });
        }
      } catch (_) {}
    }

    var _ogEu = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_UPDATE_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "EMERGENCY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    if (!(_ogEu && _ogEu.ok)) reply_(renderTenantKey_("EMERGENCY_UPDATE_ACK", lang, baseVars));
    return;
  }

  // ===================================================================
  // ===== M7 — WORKFLOW (Stage Handlers + Ticket Creation) =============
  // @MODULE:M7
  // Responsibilities:
  // - PROPERTY / UNIT / ISSUE / SCHEDULE handlers
  // - finalizeDraftAndCreateTicket_()
  // - processTicket_()
  // ===================================================================

  // ⚠️ IMPORTANT: Do NOT gate on pendingRow here.
  // PROPERTY/UNIT/ISSUE stages must run even when PendingRow is missing
  // so they can self-heal the ticket pointer.
  // (CUTOVER SEAM removed — now handled by resolveEffectiveTicketState_)

  // ——— Safety net: ticket-bound stage (SCHEDULE/DETAIL) without PendingRow ———
  var ticketBoundNoRow = (effectiveStage === "SCHEDULE" || effectiveStage === "DETAIL") && (pendingRow < 2);
  if (ticketBoundNoRow) {
    try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "STAGE_REQUIRES_ROW_BUT_NONE stage=[" + effectiveStage + "] action=NORMALIZE_TO_ISSUE"); } catch (_) {}
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    if (_og && _og.ok) replied = true;
    try { dalSetPendingStage_(dir, dirRow, "", phone, "NORMALIZE_STAGE_NO_ROW"); } catch (_) {}
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "normalize_stage_requires_row"); } catch (_) {}
    return;
  }

  // ——— SCHEDULE_DRAFT_MULTI: parse schedule, create one merged ticket, clear stage ———
  if (effectiveStage === "SCHEDULE_DRAFT_MULTI") {
    var bufSdmDir = (typeof getIssueBuffer_ === "function") ? (getIssueBuffer_(dir, dirRow) || []) : [];
    var bufSdmSess = [];
    if (typeof sessionGet_ === "function") {
      try {
        var _sSdm0 = sessionGet_(phone);
        if (_sSdm0 && _sSdm0.issueBuf && Array.isArray(_sSdm0.issueBuf)) bufSdmSess = _sSdm0.issueBuf;
      } catch (_) {}
    }
    var bufSdm = bufSdmDir.length >= bufSdmSess.length ? bufSdmDir : bufSdmSess;
    var stageDaySdm = "Today";
    try {
      if (typeof inferStageDayFromText_ === "function") {
        var inferredSdm = inferStageDayFromText_(String(bodyTrim || "").trim());
        if (inferredSdm) stageDaySdm = inferredSdm;
      }
    } catch (_) {}
    var schedSdm = (typeof parsePreferredWindowShared_ === "function") ? parsePreferredWindowShared_(String(bodyTrim || "").trim(), stageDaySdm) : null;
    var accessNotesSdm = String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.DRAFT_SCHEDULE_RAW : 13).getValue() || "").trim();
    if (!accessNotesSdm && typeof sessionGet_ === "function") {
      try { var _sSdm = sessionGet_(phone); if (_sSdm && _sSdm.draftScheduleRaw) accessNotesSdm = String(_sSdm.draftScheduleRaw || "").trim(); } catch (_) {}
    }
    var ansLower = String(bodyTrim || "").trim().toLowerCase();
    var isYesConfirm = (ansLower === "yes" || ansLower === "y" || ansLower.startsWith("yes ") || ansLower === "confirm");
    if ((!schedSdm || !schedSdm.label) && !(accessNotesSdm && isYesConfirm)) {
      var reaskMsg = accessNotesSdm
        ? (renderTenantKey_("CONFIRM_WINDOW_FROM_NOTE", lang, Object.assign({}, baseVars, { accessNotes: accessNotesSdm })) || renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars))
        : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
      var _ogR = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SCHEDULE_DRAFT_REASK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { accessNotes: accessNotesSdm }), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogR && _ogR.ok)) replyNoHeader_(reaskMsg);
      return;
    }
    var labelSdm = (schedSdm && schedSdm.label) ? String(schedSdm.label || "").trim() : (accessNotesSdm && isYesConfirm ? accessNotesSdm : "");
    var propObjSdm = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
    var propCodeSdm = String(propObjSdm && propObjSdm.code ? propObjSdm.code : "").trim().toUpperCase() || "GLOBAL";
    var recheckTextSdm = String(labelSdm || accessNotesSdm || "").trim();
    if (recheckTextSdm && typeof schedPolicyRecheckWindowFromText_ === "function") {
      var prSdm = schedPolicyRecheckWindowFromText_(phone, propCodeSdm, recheckTextSdm, new Date());
      if (prSdm && !prSdm.ok) {
        var vkSdm = String(prSdm.verdict && prSdm.verdict.key ? prSdm.verdict.key : "").trim() || "SCHED_REJECT_WEEKEND";
        var vvSdm = (prSdm.verdict && prSdm.verdict.vars) ? prSdm.verdict.vars : {};
        try { logDevSms_(phone, "", "SCHED_POLICY_RECHECK_REPLY sent=1 stage=SCHEDULE_DRAFT_MULTI key=" + vkSdm); } catch (_) {}
        var _ogPol = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: vkSdm, templateKey: vkSdm, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, vvSdm), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogPol && _ogPol.ok)) replyNoHeader_(renderTenantKey_(vkSdm, lang, Object.assign({}, baseVars || {}, vvSdm)));
        return;
      }
    }
    var inboundKeySdm = "DRAFT:" + phone + "|TS:" + Date.now();
    var resultSdm = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, Object.assign(firstMediaFieldsFromTurnFacts_(turnFacts), {
      inboundKey: inboundKeySdm,
      lang: lang,
      baseVars: baseVars,
      multiScheduleCaptured: true,
      capturedScheduleLabel: labelSdm,
      mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
      mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
      mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
      mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
    }));
    if (!resultSdm.ok) {
      if (String(resultSdm.reason || "") === "SCHEDULE_POLICY_BLOCK") {
        var vkPol = String(resultSdm.policyKey || "SCHED_REJECT_WEEKEND").trim();
        var vvPol = resultSdm.policyVars || {};
        try { logDevSms_(phone, "", "SCHED_POLICY_RECHECK_REPLY sent=1 path=[finalize_return] key=" + vkPol); } catch (_) {}
        var _ogPolF = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: vkPol, templateKey: vkPol, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, vvPol), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogPolF && _ogPolF.ok)) replyNoHeader_(renderTenantKey_(vkPol, lang, Object.assign({}, baseVars || {}, vvPol)));
        return;
      }
      try { logDevSms_(phone, bodyTrim, "SCHEDULE_DRAFT_MULTI_FINALIZE_FAIL reason=[" + String(resultSdm.reason || "") + "]"); } catch (_) {}
      var accessNotesFail = String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.DRAFT_SCHEDULE_RAW : 13).getValue() || "").trim();
      if (!accessNotesFail && typeof sessionGet_ === "function") {
        try { var _sFail = sessionGet_(phone); if (_sFail && _sFail.draftScheduleRaw) accessNotesFail = String(_sFail.draftScheduleRaw || "").trim(); } catch (_) {}
      }
      var failMsg = accessNotesFail
        ? (renderTenantKey_("CONFIRM_WINDOW_FROM_NOTE", lang, Object.assign({}, baseVars, { accessNotes: accessNotesFail })) || renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars))
        : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
      var _ogF = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SCHEDULE_DRAFT_FAIL", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { accessNotes: accessNotesFail }), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogF && _ogF.ok)) replyNoHeader_(failMsg);
      return;
    }
    try {
      ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "schedule_draft_multi_done");
    } catch (_) {}
    if (resultSdm.splitTicketCommit && resultSdm.splitCount >= 2) {
      var sdmIssue = String((turnFacts && turnFacts.issue) || bodyTrim || "").trim();
      var sdmUnit = String((turnFacts && turnFacts.unit) || dalGetPendingUnit_(dir, dirRow) || dalGetUnit_(dir, dirRow) || "").trim();
      var sdmPropN = String((propObjSdm && propObjSdm.name) || "").trim();
      if (emitSplitFinalizeDraftTenantMessages_(e, phone, bodyTrim, sheet, dir, dirRow, lang, baseVars, resultSdm, sdmIssue, sdmUnit, sdmPropN, _channel, null)) {
        try {
          if (compassNoReopenIntake) {
            logDevSms_(phone, String(bodyTrim || "").slice(0, 16), "SHORT_REPLY_RESOLVED action=[confirm_schedule_multi]");
          }
        } catch (_) {}
        return;
      }
    }
    var countSdm = Math.max(bufSdmDir.length, bufSdmSess.length, (bufSdm && bufSdm.length) ? bufSdm.length : 0);
    if (countSdm < 1) countSdm = 1;
    try {
      if (resultSdm && resultSdm.ok && resultSdm.issueBufferCount != null) {
        var _ibcSdm = parseInt(String(resultSdm.issueBufferCount), 10);
        if (isFinite(_ibcSdm) && _ibcSdm >= 1) countSdm = _ibcSdm;
      }
    } catch (_) {}
    try {
      logDevSms_(phone, "", "MULTI_CONFIRM_COUNT dir=" + bufSdmDir.length + " sess=" + bufSdmSess.length + " mergedPick=" + ((bufSdm && bufSdm.length) ? bufSdm.length : 0) + " finalizeBuf=" + String(resultSdm && resultSdm.issueBufferCount != null ? resultSdm.issueBufferCount : "") + " used=" + countSdm);
    } catch (_) {}
    var confirmVars = Object.assign({}, baseVars, { count: String(countSdm), issueCount: String(countSdm), itemCount: String(countSdm), when: labelSdm });
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "MULTI_CREATED_CONFIRM", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: confirmVars, meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE_DRAFT_MULTI", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    try {
      if (compassNoReopenIntake) {
        logDevSms_(phone, String(bodyTrim || "").slice(0, 16), "SHORT_REPLY_RESOLVED action=[confirm_schedule_multi]");
      }
    } catch (_) {}
    return;
  }

  if (effectiveStage === "PROPERTY" || effectiveStage === "UNIT" || effectiveStage === "ISSUE") {

    // -------------------------
    // PROPERTY (Propera Compass SAFE) — ctx-driven continuation
    // Accepts: "1".."5", "penn", "the grand at penn", "penn 301", "1 apt 301"
    // Rules:
    // - Single canonical handler
    // - Directory writes under lock
    // - PROPERTY stage may ONLY create a ticket if PendingIssue exists but PendingRow is missing
    // - Directory.PendingRow is the active ticket pointer
    // - Next steps are driven by ctx.pendingExpected (PROPERTY/UNIT/ISSUE/DETAIL/SCHEDULE_*)
    // -------------------------
    if (effectiveStage === "PROPERTY") {

      let recovResult = null; // PATCH 4: set when we call finalize; used to respect nextStage
      try {
        try { logDevSms_(phone, "DBG_B ENTER PROPERTY body=[" + String(bodyTrim || "") + "]", "DBG_B"); } catch (_) {}

        const raw   = String(bodyRaw || "");
        const trim  = String(bodyTrim || "").trim();
        const lower = trim.toLowerCase();

        // Always re-read fresh
        let pendingRow     = dalGetPendingRow_(dir, dirRow);
        const pendingIssue = dalGetPendingIssue_(dir, dirRow); // PendingIssue (E)

        // -------------------------
        // Resolve property (sheet-driven; NO PROPERTIES global)
        // -------------------------
        const propsList = getActiveProperties_();
        if (!propsList || !propsList.length) {
          var _ogErr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_NO_PROPERTIES", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_NO_PROPERTIES_CONFIGURED", lang, baseVars));
          return;
        }

        const tokens = lower.split(/\s+/).filter(Boolean);

        // menu digit ONLY if it's a standalone token (so "301" won't trigger "3")
        const digit = tokens.find(t => /^[1-5]$/.test(t)) || "";

        let pObj = null;

        // ✅ Menu pick: deterministic order from Properties sheet
        if (digit) {
          const idx = parseInt(digit, 10) - 1;
          if (idx >= 0 && idx < propsList.length) pObj = propsList[idx];
        }

        // ✅ Exact match against variants + code/name/ticketPrefix
        if (!pObj) {
          for (const p of propsList) {
            const variants = []
              .concat(p._variants || [])
              .concat([p.code, p.name, p.ticketPrefix])
              .filter(Boolean)
              .map(x => String(x).toLowerCase().trim());

            if (variants.includes(lower)) { pObj = p; break; }
          }
        }

        // ✅ Contains match (e.g. "the grand at penn", "penn 301")
        if (!pObj) {
          for (const p of propsList) {
            const variants = []
              .concat(p._variants || [])
              .concat([p.code, p.name, p.ticketPrefix])
              .filter(Boolean)
              .map(x => String(x).toLowerCase().trim());

            if (variants.some(v => v && lower.includes(v))) { pObj = p; break; }
          }
        }

        // ✅ Last resort: your existing resolver (if present)
        if (!pObj) {
          const localProp = resolvePropertyFromText_(raw) || resolvePropertyFromText_(trim);
          if (localProp) {
            try {
              const p2 = getPropertyByNameOrKeyword_(localProp);
              if (p2) pObj = p2;
            } catch (_) {}
          }
        }

        // If still no property match, ask menu again + set ctx expected=PROPERTY
  // If still no property match, ask menu again + set ctx expected=PROPERTY
  if (!pObj) {

    var unitCandidate = dalGetPendingUnit_(dir, dirRow);
    var tfUnitNoMatch = (turnFacts && turnFacts.unit) ? String(turnFacts.unit).trim() : "";
    if (!unitCandidate && tfUnitNoMatch) {
      dalSetPendingUnit_(dir, dirRow, tfUnitNoMatch, phone, "UNIT_FROM_TURNFACTS");
      unitCandidate = tfUnitNoMatch;
    }

    const pr0 = dalGetPendingRow_(dir, dirRow);
    if (unitCandidate && pr0 >= 2) {
      try {
        withWriteLock_("TICKET_SET_UNIT_FROM_PROPERTY_NO_MATCH", () => {
          sheet.getRange(pr0, COL.UNIT).setValue(unitCandidate);
          sheet.getRange(pr0, COL.LAST_UPDATE).setValue(new Date());
        });
      } catch (_) {}
    }
    if (unitCandidate) {
      try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_UNIT_FROM_PROPERTY_NO_MATCH unit=[" + unitCandidate + "]"); } catch (_) {}
    }


    const v = Object.assign({}, baseVars, unitCandidate ? { unit: unitCandidate } : {});

    // Tone-aware prefix: signals first, then captured facts, then plain menu
    const _propPrefixKey =
      signals.tone === "urgent"       ? "ASK_PROPERTY_URGENT"       :
      signals.tone === "postService"  ? "ASK_PROPERTY_POST_SERVICE" :
      signals.tone === "recurring"    ? "ASK_PROPERTY_RECURRING"    :
      signals.tone === "frustrated"   ? "ASK_PROPERTY_FRUSTRATED"   :
      (unitCandidate && String(unitCandidate).trim()) ? "ASK_PROPERTY_GOT_UNIT"   :
      (cap && cap.hasIssue)           ? "ASK_PROPERTY_GOT_ISSUE"    :
      null;

    reply_(replyAskPropertyMenu_(lang, v, _propPrefixKey ? { prefixKey: _propPrefixKey } : {}));

    try {
      const ctxNow = ctxGet_(phone);
      ctxUpsert_(phone, {
        pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
        pendingExpected: "PROPERTY",
        pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        lastIntent: "MAINT"
      });
      try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=PROPERTY_STAGE_NO_MATCH"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
    } catch (_) {}

    return;
  }


        const propertyCode = String(pObj.code || "").trim();
        const propertyName = String(pObj.name || "").trim();
        try { logDevSms_(phone, "DBG_PROPERTY RESOLVED code=" + propertyCode + " name=" + propertyName, "DBG_PROPERTY"); } catch (_) {}

        // -------------------------
        // Persist property to Directory (under lock)
        // -------------------------
        dalSetPendingProperty_(dir, dirRow, { code: propertyCode, name: propertyName }, phone, "DIR_SET_PROPERTY");

        // ✅ Clear PROPERTY expectation on success (prevents loops)
        try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "PROPERTY_RESOLVED"); } catch (_) {}

        // -------------------------
        // Compass-safe recovery: if no pendingRow, only continue if PendingIssue exists
        // -------------------------
        // Fallback: if Directory issue missing, trust draft/session issue
        if (!pendingIssue) {
          try {
            const s = (typeof sessionGet_ === "function" ? sessionGet_(phone) : null) || {};
            if (s && s.draftIssue) pendingIssue = String(s.draftIssue || "").trim();
          } catch (_) {}
        }
        if (pendingRow < 2) {
          if (!pendingIssue) {
            var _ogErr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_LOST_REQUEST", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_LOST_OPEN_REQUEST", lang, baseVars));

            dalSetPendingStage_(dir, dirRow, "", phone, "DIR_CLEAR_STAGE_AFTER_LOST_PTR");

            try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }); } catch (_) {}
            return;
          }

          // Response-first acknowledgment before heavier finalize/policy/lifecycle work.
          // Prevents a long silent gap after property+unit turn (e.g., "Penn 302").
          try {
            var _ackRecov = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, {
              intentType: "FAST_ACK_CREATE_IN_PROGRESS",
              recipientType: "TENANT",
              recipientRef: phone,
              lang: lang,
              channel: _channel,
              deliveryPolicy: "NO_HEADER",
              vars: Object.assign({}, baseVars || {}),
              meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "PROPERTY_RECOVERY_FINALIZE_ACK" }
            }) : { ok: false };
            if (_ackRecov && _ackRecov.ok) {
              try { logDevSms_(phone, "", "PROPERTY_RECOV_FAST_ACK_SENT"); } catch (_) {}
            } else {
              try { logDevSms_(phone, "", "PROPERTY_RECOV_FAST_ACK_SKIP reason=dispatch_fail"); } catch (_) {}
            }
          } catch (_) {}

          // Canonical ticket creation via finalizeDraftAndCreateTicket_ (Step B)
          recovResult = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, Object.assign(firstMediaFieldsFromTurnFacts_(turnFacts), {
            inboundKey, OPENAI_API_KEY, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER,
            lang: lang, baseVars: baseVars
          }));

          if (!recovResult.ok) throw new Error("PROPERTY recovery: finalize failed reason=[" + (recovResult.reason || "") + "]");

          // ✅ Multi-issue defer: send combined summary + schedule prompt and STOP.
          // (This mirrors Occurrence #3 behavior.)
          if (recovResult.multiIssuePending) {
            const nextStageMi = String(recovResult.nextStage || "").trim().toUpperCase();
            try { logDevSms_(phone, "", "PROPERTY_RECOV_MULTI_DEFER nextStage=[" + nextStageMi + "]"); } catch (_) {}

            if (nextStageMi === "UNIT") {
              var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
              if (_og && _og.ok) replied = true;
              return;
            }

            if (nextStageMi === "SCHEDULE" || nextStageMi === "SCHEDULE_DRAFT_MULTI") {
              var combinedMi = (recovResult.summaryMsg && String(recovResult.summaryMsg).trim())
                ? String(recovResult.summaryMsg).trim()
                : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
              try { logDevSms_(phone, combinedMi.slice(0, 120), "MULTI_COMBINED_OUT_RECOV"); } catch (_) {}
              var _ogMi = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combinedMi }), meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
              if (!(_ogMi && _ogMi.ok)) replyNoHeader_(combinedMi);
              return;
            }

            // Fallback: just respect stage and exit
            return;
          }

          // Normal path: ticket row exists
          pendingRow = recovResult.loggedRow;
          if (pendingRow < 2 || !sheet || pendingRow > sheet.getLastRow()) {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            return;
          }
        }

        const hasTicketPtr = (pendingRow >= 2 && sheet && pendingRow <= sheet.getLastRow());

        // -------------------------
        // Ticket: set property + upgrade ticket id (only when valid pendingRow)
        // -------------------------
        if (hasTicketPtr) {
          withWriteLock_("TICKET_SET_PROPERTY_AND_UPGRADE_ID", () => {
            sheet.getRange(pendingRow, COL.PROPERTY).setValue(propertyName);

            const before = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();
            upgradeTicketIdIfUnknown_(sheet, pendingRow, propertyName);
            const after  = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();

            try {
              logDevSms_(phone, "TICKET_UPGRADE row=" + pendingRow + " before=[" + before + "] after=[" + after + "] prop=[" + propertyName + "]", "DBG_TICKETID");
            } catch (_) {}
          });
          try { logDevSms_(phone, bodyTrim, "PROP_WRITE_TICKET ok row=[" + pendingRow + "]"); } catch (_) {}

          // Sync active work item — property known (unit may still be blank)
          try {
            syncActiveWorkItemFromTicketRow_(
              phone,
              pendingRow,
              propertyCode,
              dalGetPendingUnit_(dir, dirRow)
            );
          } catch (_) {}
        } else {
          try { logDevSms_(phone, bodyTrim, "PROP_WRITE_TICKET skip no_ptr row=[" + pendingRow + "]"); } catch (_) {}
        }

        // -------------------------
        // PATCH 4: Respect recovResult.nextStage (do not re-read cleared Directory)
        // -------------------------
        if (recovResult) {
          const nextStage = String(recovResult.nextStage || "").trim();
          dalWithLock_("PROPERTY_RECOV_SET_STAGE", function () {
            dalSetPendingStageNoLock_(dir, dirRow, nextStage);
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE PROPERTY_RECOV_SET_STAGE row=" + dirRow + " stage=" + String(nextStage).slice(0, DAL_LOG_LEN)); } catch (_) {}
          });
          try {
            const ctxNowU = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowU && ctxNowU.activeWorkItemId) ? String(ctxNowU.activeWorkItemId) : "",
              pendingExpected: nextStage,
              pendingExpiresAt: new Date(Date.now() + (nextStage === "SCHEDULE" || nextStage === "SCHEDULE_DRAFT_MULTI" ? 30 : 10) * 60 * 1000),
              lastIntent: "MAINT"
            });
          } catch (_) {}
          if (nextStage === "") {
            if (!(recovResult && recovResult.ackOwnedByPolicy)) {
              var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String((recovResult && recovResult.ticketId) || "") }), meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
              try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
            } else {
              try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (recovResult.createdWi || "") + " rule=" + (recovResult.policyRuleId || "")); } catch (_) {}
            }
          } else if (nextStage === "UNIT") {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            if (_og && _og.ok) replied = true;
          } else {
            const dayLineRecov = dayWord
              ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, baseVars, { dayWord })))
              : "";
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { dayLine: dayLineRecov }), meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          }
          return;
        }

        // -------------------------
        // UNIT (ctx-driven) — only when we did NOT just finalize (recovResult null)
        // -------------------------
        pendingUnit = dalGetPendingUnit_(dir, dirRow);
        var tfUnit = (turnFacts && turnFacts.unit) ? String(turnFacts.unit).trim() : "";
        if (!pendingUnit && tfUnit) {
          dalSetPendingUnit_(dir, dirRow, tfUnit, phone, "UNIT_FROM_TURNFACTS");
          pendingUnit = tfUnit;
        }

        // Ask unit if still missing
        if (!pendingUnit) {
          dalSetPendingStage_(dir, dirRow, "UNIT", phone, "PROPERTY_NEXT_UNIT");
          if (hasTicketPtr) setStatus_(sheet, pendingRow, "Waiting Tenant");
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (_og && _og.ok) replied = true;

          try {
            const ctxNowU = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowU && ctxNowU.activeWorkItemId) ? String(ctxNowU.activeWorkItemId) : "",
              pendingExpected: "UNIT",
              pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "UNIT"); } catch (_) {}
          } catch (_) {}

          return;
        }

        // Sync work item now that unit is known
        if (hasTicketPtr) {
          try {
            syncActiveWorkItemFromTicketRow_(phone, pendingRow, propertyCode, pendingUnit);
          } catch (_) {}
        }

        // -------------------------
        // ISSUE (ctx-driven)
        // -------------------------
        const issueText = dalGetPendingIssue_(dir, dirRow);
        if (!issueText) {
          dalSetPendingStage_(dir, dirRow, "ISSUE", phone, "UNIT_NEXT_ISSUE");
          if (hasTicketPtr) setStatus_(sheet, pendingRow, "Waiting Tenant");
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (_og && _og.ok) replied = true;

          try {
            const ctxNowI = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowI && ctxNowI.activeWorkItemId) ? String(ctxNowI.activeWorkItemId) : "",
              pendingExpected: "ISSUE",
              pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=ISSUE src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
          } catch (_) {}

          return;
        }

        // Ticket MSG (internal storage)
        if (hasTicketPtr) {
          withWriteLock_("TICKET_SET_MSG", () => {
            sheet.getRange(pendingRow, COL.MSG).setValue("Unit " + pendingUnit + " - " + issueText);
          });
        }

        // -------------------------
        // Emergency short-circuit (template-key only)
        // -------------------------
        if (hasTicketPtr && isEmergencyContext_(sheet, pendingRow)) {
          dalWithLock_("EMERGENCY_DONE_SET_PTR_STAGE", function () {
            dalSetPendingRowNoLock_(dir, dirRow, pendingRow);
            dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE EMERGENCY_DONE_SET_PTR_STAGE row=" + dirRow + " pr=" + pendingRow); } catch (_) {}
          });
          setStatus_(sheet, pendingRow, "In Progress");

          const tid = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();
          if (tid) { var _ogE = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED_WITH_TICKET", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: tid }), meta: { source: "HANDLE_INBOUND_CORE", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE && _ogE.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID", lang, { ...baseVars, ticketId: tid })); }
          else     { var _ogE2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "EMERGENCY_DONE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE2 && _ogE2.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED", lang, baseVars)); }

          try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }); } catch (_) {}
          return;
        }

        // -------------------------
        // Decide schedule vs detail
        // -------------------------
        let isClear = issueIsClear_("", 0, issueText) || !!String((turnFacts && turnFacts.issue) || "").trim();

        // ✅ FIX: never reference OPENAI_API_KEY directly
        if (!isClear) {
          try {
            const props = PropertiesService.getScriptProperties();
            const apiKey = String(props.getProperty("OPENAI_API_KEY") || "").trim();
            if (apiKey) {
              var ex = smartExtract_(apiKey, issueText);
              if (ex) isClear = issueIsClear_(ex.issueSummary, ex.issueConfidence, issueText) || !!String((turnFacts && turnFacts.issue) || "").trim();
            }
          } catch (_) {}
        }

        if (hasTicketPtr) setStatus_(sheet, pendingRow, "Waiting Tenant");

        if (isClear) {
          const schedStage = "SCHEDULE";

          try {
            dalSetPendingStage_(dir, dirRow, schedStage, phone, "DIR_SET_STAGE_AFTER_PROPERTY");
          } catch (_) {}

          // ✅ SINGLE schedule prompt (no duplicate, no dayLine var) — Phase 2b: semantic intent
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

          try {
            const ctxNowS = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowS && ctxNowS.activeWorkItemId) ? String(ctxNowS.activeWorkItemId) : "",
              pendingExpected: "SCHEDULE",
              pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
          } catch (_) {}

        } else {
          dalSetPendingStage_(dir, dirRow, "DETAIL", phone, "SCHEDULE_NEXT_DETAIL");
          reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

          try {
            const ctxNowD = ctxGet_(phone);
            ctxUpsert_(phone, {
              pendingWorkItemId: (ctxNowD && ctxNowD.activeWorkItemId) ? String(ctxNowD.activeWorkItemId) : "",
              pendingExpected: "DETAIL",
              pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
              lastIntent: "MAINT"
            });
            try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=PROPERTY_STAGE"); } catch (_) {}
            try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
          } catch (_) {}
        }

        return;

      } catch (err) {
        try { logDevSms_(phone, "PROPERTY_STAGE_CRASH err=" + err + " stack=" + (err && err.stack), "ERR_PROPERTY"); } catch (_) {}
        var _ogErr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_TRY_AGAIN", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "PROPERTY", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogErr && _ogErr.ok)) reply_(renderTenantKey_("ERR_GENERIC_TRY_AGAIN", lang, baseVars));
        return;
      }
    }



  // -------------------------
  // UNIT (Propera Compass SAFE) — ctx-driven
  // - NEVER creates a new ticket
  // - Only writes to the ACTIVE ticket row (Directory.PendingRow)
  // - Directory is source of truth for Issue (PendingIssue) + Unit (PendingUnit)
  // - ✅ FIX: persist stage transitions in Directory to prevent loops
  // - ✅ FIX: do NOT reference OPENAI_API_KEY directly (avoid ReferenceError)
  // - ✅ FIX: CTX-first stage read via effectiveStage seam
  // - ✅ FIX: template-key only schedule prompt (no dayLine stacking)
  // -------------------------
  if (effectiveStage === "UNIT") {
    const now = new Date();

    // 0) Get ACTIVE ticket row from Directory (single source of truth)
    const pendingRow = dalGetPendingRow_(dir, dirRow);
    if (pendingRow < 2) {
      try { logDevSms_(phone, bodyTrim.slice(0, 40), "LOST_TRACK_BLOCKED exp=UNIT stage=UNIT action=REPROMPT_UNIT"); } catch (_) {}
      try { logInvariantFail_(phone, sidSafe || "", "LOST_TRACK_BLOCKED", "exp=UNIT pendingRow=" + pendingRow); } catch (_) {}
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (_og && _og.ok) replied = true;
      try {
        var ctxUnit = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxUnit && ctxUnit.activeWorkItemId) ? String(ctxUnit.activeWorkItemId) : "",
          pendingExpected: "UNIT",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "UNIT_REPROMPT_NO_PTR");
      } catch (_) {}
      return;
    }

    var dirUnit = dalGetPendingUnit_(dir, dirRow);
    var tfUnit = (turnFacts && turnFacts.unit) ? String(turnFacts.unit).trim() : "";
    if (!dirUnit && tfUnit) {
      dalSetPendingUnit_(dir, dirRow, tfUnit, phone, "UNIT_FROM_TURNFACTS");
      dirUnit = tfUnit;
    }
    const unitCandidate = dirUnit ? normalizeUnit_(dirUnit) : "";

    if (!unitCandidate) {

      // ── CROSS-STAGE FACTS (Compass-safe): save property/issue even if unit is missing ──
      try {

        // A) Save PROPERTY if tenant provided it here (and Directory is blank)
        if (turnFacts && turnFacts.property && turnFacts.property.code) {
          const _propUnit = dalGetPendingProperty_(dir, dirRow);
          const dirPropCode = _propUnit.code;
          if (!dirPropCode) {
            const tProp = turnFacts.property;

            dalWithLock_("DIR_SET_PROPERTY_FROM_UNIT_STAGE", function () {
              dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(tProp.code || "").trim(), name: String(tProp.name || "").trim() });
              dalSetLastUpdatedNoLock_(dir, dirRow);
              try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_PROPERTY_FROM_UNIT_STAGE row=" + dirRow); } catch (_) {}
            });

            // also update ticket row property if we have a pendingRow pointer
            if (pendingRow >= 2) {
              try {
                withWriteLock_("TICKET_SET_PROPERTY_FROM_UNIT_STAGE", () => {
                  const pName = String(tProp.name || "").trim();
                  if (pName) sheet.getRange(pendingRow, COL.PROPERTY).setValue(pName);
                });
              } catch (_) {}
            }

            try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_PROPERTY_FROM_UNIT code=[" + tProp.code + "]"); } catch (_) {}
          }
        }

        // B) Save ISSUE if tenant provided it here (and PendingIssue is blank)
        const issueCandidateUnit = String((turnFacts && turnFacts.issue) || "").trim();
        if (issueCandidateUnit) {
          const prevIssue = dalGetPendingIssue_(dir, dirRow);
          if (!prevIssue) {
            dalWithLock_("DIR_SET_ISSUE_FROM_UNIT_STAGE", function () {
              dalSetPendingIssueNoLock_(dir, dirRow, issueCandidateUnit);
              dalSetLastUpdatedNoLock_(dir, dirRow);
              try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_ISSUE_FROM_UNIT_STAGE row=" + dirRow); } catch (_) {}
            });
            try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[UNIT_STAGE_CROSS] val=[" + issueCandidateUnit.slice(0, 40) + "]"); } catch (_) {}
            try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_ISSUE_FROM_UNIT"); } catch (_) {}
          }
        }

      } catch (_) {}

      // Still need UNIT — re-ask
      if (cap && cap.hasProp) {
        const v = Object.assign({}, baseVars, { propertyName: cap.propName || cap.propCode });
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: v || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
      } else {
        var _og2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og2 && _og2.ok) replied = true;
      }

      // Expect UNIT again (deterministic)
      try {
        const ctxNow = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
          pendingExpected: "UNIT",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=UNIT_STAGE_REASK"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "UNIT"); } catch (_) {}
      } catch (_) {}

      return;
    }


    const unitFinal = normalizeUnit_(unitCandidate);

    // 2) Persist unit to Directory (source of truth) under lock
    dalSetPendingUnit_(dir, dirRow, unitFinal, phone, "DIR_SET_UNIT");
    try {
      dalSetUnit_(dir, dirRow, unitFinal, phone, "CANON_UNIT_LEARNED_FROM_UNIT_STAGE");
    } catch (_) {}

    // ✅ Clear UNIT expectation on success (prevents loops)
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "UNIT_RESOLVED"); } catch (_) {}

    // 3) Write unit to ticket row + update last update (locked)
    withWriteLock_("TICKET_SET_UNIT", () => {
      sheet.getRange(pendingRow, COL.UNIT).setValue(unitFinal);
      sheet.getRange(pendingRow, COL.LAST_UPDATE).setValue(now);
    });

    // WORK ENGINE SYNC — unit confirmed
    try {
      const _propPCode = dalGetPendingProperty_(dir, dirRow);
      const pCodeNow = _propPCode.code;
      syncActiveWorkItemFromTicketRow_(phone, pendingRow, pCodeNow, unitFinal);
    } catch (_) {}

    // Stage discipline: do NOT advance to SCHEDULE unless Directory.PendingIssue (col 5) is non-empty
    const dirIssue = dalGetPendingIssue_(dir, dirRow);
    if (!dirIssue) {
      setStatus_(sheet, pendingRow, "Waiting Tenant");
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (_og && _og.ok) replied = true;
      try {
        dalSetPendingStage_(dir, dirRow, "ISSUE", phone, "DIR_SET_STAGE_ISSUE");
      } catch (eStage) {
        try { logDevSms_(phone, bodyTrim, "DIR_SET_STAGE_ISSUE_ERR " + String(eStage && eStage.message ? eStage.message : eStage)); } catch (_) {}
      }
      try {
        const ctxNow2 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=ISSUE src=UNIT_STAGE_NO_ISSUE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
      } catch (_) {}
      return;
    }

    // dirIssue non-empty — advance to SCHEDULE (template-key only: ASK_WINDOW or ASK_WINDOW_WITH_DAYHINT, no dayLine stacking)
    if (pendingRow >= 2) {
      dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "DIR_SET_STAGE_SCHEDULE_FROM_UNIT");
      try {
        const ctxNow2 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
          lastIntent: "MAINT"
        });
      } catch (_) {}
      try {
        const wiId = (ctxGet_(phone) || {}).activeWorkItemId;
        if (wiId && typeof workItemUpdate_ === "function") workItemUpdate_(wiId, { state: "WAIT_TENANT", substate: "SCHEDULE" });
      } catch (_) {}
      setStatus_(sheet, pendingRow, "Waiting Tenant");
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return;
    }

    // 5) Ensure ticket message is consistent (internal storage)
    withWriteLock_("TICKET_SET_MSG_FROM_DIR", () => {
      sheet.getRange(pendingRow, COL.MSG).setValue("Unit " + unitFinal + " - " + dirIssue);
    });

    // 6) Emergency stop (template-only, NO schedule)
    // Trigger if: ticket already looks emergency OR Directory issue is emergency OR ctx.flowMode emergency
    let forceEmergency = false;
    let eKind = "";

    try {
      const dirIssueNow = dalGetPendingIssue_(dir, dirRow);
      eKind = detectEmergencyKind_(dirIssueNow) || detectEmergencyKind_(String(sheet.getRange(pendingRow, COL.MSG).getValue() || ""));
      forceEmergency = !!eKind || isEmergencyContext_(sheet, pendingRow);

      // Also honor ctx latch if present
      try {
        const ctxNowE = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
        if (String(ctxNowE.flowMode || "").toUpperCase() === "EMERGENCY") forceEmergency = true;
        if (!eKind) eKind = String(ctxNowE.emergencyKind || "").trim();
      } catch (_) {}
    } catch (_) {}

    if (forceEmergency) {

      // ✅ Latch emergency on the ticket + ctx (authoritative)
      try { latchEmergency_(sheet, pendingRow, phone, eKind || "EMERGENCY"); } catch (_) {}

      // ✅ Put Directory into EMERGENCY_DONE so every future inbound becomes follow-up note
      try {
        dalWithLock_("DIR_SET_EMERGENCY_DONE", function () {
          dalSetPendingRowNoLock_(dir, dirRow, pendingRow);
          dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_EMERGENCY_DONE row=" + dirRow); } catch (_) {}
        });
      } catch (_) {}

      setStatus_(sheet, pendingRow, "In Progress");

      const tid = String(sheet.getRange(pendingRow, COL.TICKET_ID).getValue() || "").trim();
      if (tid) { var _ogE = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED_WITH_TICKET", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: tid }), meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE && _ogE.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID", lang, { ...baseVars, ticketId: tid })); }
      else     { var _ogE2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_CONFIRMED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (!(_ogE2 && _ogE2.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_CONFIRMED_DISPATCHED", lang, baseVars)); }

      try {
        ctxUpsert_(phone, {
          flowMode: "EMERGENCY",
          emergencyKind: eKind || "EMERGENCY",
          pendingExpected: "",
          pendingExpiresAt: "",
          pendingWorkItemId: ""
        }, "EMERGENCY_CONFIRMED_UNIT_STAGE");
      } catch (_) {}

      return;
    }

    // 7) Decide schedule vs detail (ctx-driven)
    let isClear = issueIsClear_("", 0, dirIssue) || !!String((turnFacts && turnFacts.issue) || "").trim();

    // ✅ FIX: do NOT reference OPENAI_API_KEY directly (avoid ReferenceError)
    if (!isClear) {
      try {
        const props = PropertiesService.getScriptProperties();
        const apiKey = String(props.getProperty("OPENAI_API_KEY") || "").trim();
        if (apiKey) {
          var exU = smartExtract_(apiKey, dirIssue);
          if (exU) isClear = issueIsClear_(exU.issueSummary, exU.issueConfidence, dirIssue) || !!String((turnFacts && turnFacts.issue) || "").trim();
        }
      } catch (_) {}
    }

    setStatus_(sheet, pendingRow, "Waiting Tenant");

    if (isClear) {

      // ✅ Unified schedule stage (Propera Compass aligned)
      const schedStage = "SCHEDULE";

      // Directory = source of truth
      try {
        dalWithLock_("DIR_SET_STAGE_AFTER_UNIT", function () {
          dalSetPendingRowNoLock_(dir, dirRow, pendingRow);
          dalSetPendingStageNoLock_(dir, dirRow, schedStage);
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_STAGE_AFTER_UNIT row=" + dirRow); } catch (_) {}
        });
      } catch (_) {}

      // ✅ template-key only schedule prompt (no dayLine stacking) — Phase 2b: semantic intent
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

      // ctx expectation = SCHEDULE
      try {
        const ctxNow3 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow3 && ctxNow3.activeWorkItemId)
            ? String(ctxNow3.activeWorkItemId)
            : "",
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=UNIT_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      } catch (_) {}

    } else {
      reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

      try {
        const ctxNow4 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow4 && ctxNow4.activeWorkItemId) ? String(ctxNow4.activeWorkItemId) : "",
          pendingExpected: "DETAIL",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=UNIT_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
      } catch (_) {}
    }

    return;
  }


  // -------------------------
  // ISSUE (Propera Compass SAFE) — ctx-driven
  // - Always write to active row from Directory.PendingRow (col 7)
  // - If missing, store issue in Directory and force PROPERTY stage (fail-safe)
  // - ✅ FIX: CTX-first stage read via effectiveStage seam
  // - ✅ FIX: template-key only schedule prompt (no tenantMsg_, no dayLine stacking)
  // -------------------------
  if (effectiveStage === "ISSUE") {
    var issueText = String(bodyTrim || "").trim();
    var issueLower = issueText.toLowerCase();

    // Guard: do not treat intent tokens as tenant issue text
    // (e.g., legacy internal injection "service"/"maintenance")
    var looksLikeIntentToken =
      (issueLower === "service") ||
      (issueLower === "maintenance") ||
      (issueLower === "leasing") ||
      (issueLower === "reservation") ||
      (issueLower === "amenities") ||
      (issueLower === "amenity");

    if (looksLikeIntentToken) {
      const _issueAskKey = { urgent: "ASK_ISSUE_URGENT", postService: "ASK_ISSUE_POST_SERVICE", recurring: "ASK_ISSUE_RECURRING", frustrated: "ASK_ISSUE_FRUSTRATED" }[signals.tone] || "ASK_ISSUE_GENERIC";
      reply_(renderTenantKey_(_issueAskKey, lang, baseVars));
      try {
        const ctxNowTok = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNowTok && ctxNowTok.activeWorkItemId) ? String(ctxNowTok.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
        try { logDevSms_(phone, issueText, "ISSUE_WRITE_SKIP site=[ISSUE_STAGE_RESOLVED] reason=[intent_token]"); } catch (_) {}
      } catch (_) {}
      return;
    }

    const meta2 = (turnFacts && turnFacts.meta) ? turnFacts.meta : {};

    // ✅ Normalize ATTACHMENT_ONLY so it NEVER becomes issue text.
    // If this turn has media and the body override is ATTACHMENT_ONLY, treat as "no issue text" + media-only.
    try {
      var _it = String(issueText || "").trim();
      var _itU = _it.toUpperCase();
      var _mu = (meta2 && Array.isArray(meta2.mediaUrls)) ? meta2.mediaUrls : [];
      if (_itU === "ATTACHMENT_ONLY" && _mu.length > 0) {
        issueText = "";
        meta2.hasMediaOnly = true;
      }
    } catch (_) {}

    // ✅ Photo-only path (ASK_ISSUE_FROM_PHOTO) — but first persist attachments to active ticket if we have one.
    if (!issueText && meta2 && meta2.hasMediaOnly === true) {

      // Persist attachments even when no issue text (so AppSheet shows the photo)
      try {
        var _mu2 = (meta2 && Array.isArray(meta2.mediaUrls)) ? meta2.mediaUrls : [];
        var _ar = dalGetPendingRow_(dir, dirRow);
        if (_ar >= 2 && _mu2.length > 0) {
          withWriteLock_("TICKET_APPEND_ATTACH_FROM_PHOTO_ONLY", () => {
            const abCol = 28; // COL.ATTACHMENTS

            // Prefer meta2.channel; fallback derive from From
            var abChannel = (meta2 && meta2.channel) ? String(meta2.channel) : "";
            if (!abChannel && typeof safeParam_ === "function") {
              var _from = String(safeParam_(e, "From") || "").trim().toLowerCase();
              abChannel = (_from.indexOf("whatsapp:") === 0) ? "whatsapp" : "sms";
            }

            var existing = String(sheet.getRange(_ar, abCol).getValue() || "").trim();
            var lines = existing ? existing.split("\n").filter(Boolean) : [];
            for (var u = 0; u < _mu2.length; u++) {
              var url = String(_mu2[u] || "").trim();
              if (!url) continue;
              if (existing.indexOf(url) === -1) {
                var line = new Date().toISOString() + " | " + (abChannel ? abChannel.toUpperCase() : "MEDIA") + " | " + url;
                lines.push(line);
              }
            }
            if (lines.length > 0) sheet.getRange(_ar, abCol).setValue(lines.slice(-10).join("\n"));
            sheet.getRange(_ar, COL.LAST_UPDATE).setValue(new Date());
          });
        }
      } catch (_) {}

      reply_(renderTenantKey_("ASK_ISSUE_FROM_PHOTO", lang, baseVars));
      try {
        const ctxNowP = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNowP && ctxNowP.activeWorkItemId) ? String(ctxNowP.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
      } catch (_) {}
      return;
    }

    if (!issueText) {
      const _issueAskKey = { urgent: "ASK_ISSUE_URGENT", postService: "ASK_ISSUE_POST_SERVICE", recurring: "ASK_ISSUE_RECURRING", frustrated: "ASK_ISSUE_FRUSTRATED" }[signals.tone] || "ASK_ISSUE_GENERIC";
      reply_(renderTenantKey_(_issueAskKey, lang, baseVars));

      try {
        const ctxNow0 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow0 && ctxNow0.activeWorkItemId) ? String(ctxNow0.activeWorkItemId) : "",
          pendingExpected: "ISSUE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "ISSUE"); } catch (_) {}
      } catch (_) {}

      return;
    }

    // Parse and use best clause/title — never write raw bodyTrim (avoids "bible overwrite")
    var resolvedIssue = issueText;
    var parsed = (turnFacts && turnFacts.issueMeta) ? turnFacts.issueMeta : null;
    if (parsed && (parsed.bestClauseText || parsed.title)) {
      resolvedIssue = String(parsed.bestClauseText || parsed.title || "").trim();
      if (typeof normalizeIssueText_ === "function") {
        try { resolvedIssue = normalizeIssueText_(resolvedIssue); } catch (_) {}
      }
    }
    if (!resolvedIssue && typeof normalizeIssueText_ === "function") {
      try { resolvedIssue = normalizeIssueText_(issueText); } catch (_) {}
    }
    if (!resolvedIssue) resolvedIssue = issueText;

    // Always keep issue text in Directory (E) so we don't lose it
    const prevDirIssue = dalGetPendingIssue_(dir, dirRow);
    const mergedIssue = prevDirIssue ? (prevDirIssue + " | " + resolvedIssue) : resolvedIssue;
    const mergedTrim = String(mergedIssue || "").trim();

    if (mergedTrim) {
      dalSetPendingIssue_(dir, dirRow, mergedIssue, phone, "DIR_SET_ISSUE");
      try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[ISSUE_STAGE_RESOLVED] val=[" + mergedTrim.slice(0, 40) + "]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE_SKIP site=[ISSUE_STAGE_RESOLVED] reason=[empty_issueText]"); } catch (_) {}
    }

  // ✅ Clear ISSUE expectation on success (prevents loops)
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "ISSUE_RESOLVED"); } catch (_) {}

    // ── CROSS-STAGE FACTS (Compiler): save property/unit if tenant included them ──
    try {
      const now_i = new Date();

      // A) Save PROPERTY if tenant provided it and Directory is blank
      if (turnFacts && turnFacts.property && turnFacts.property.code) {
        const _propIssue = dalGetPendingProperty_(dir, dirRow);
        const dirPropCode_i = _propIssue.code;
        if (!dirPropCode_i) {
          dalWithLock_("DIR_SET_PROPERTY_FROM_ISSUE_STAGE", function () {
            dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(turnFacts.property.code || "").trim(), name: String(turnFacts.property.name || "").trim() });
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_PROPERTY_FROM_ISSUE_STAGE row=" + dirRow); } catch (_) {}
          });
          // Also update ticket row if pointer exists
          const pr_i = dalGetPendingRow_(dir, dirRow);
          if (pr_i >= 2) {
            try {
              withWriteLock_("TICKET_SET_PROPERTY_FROM_ISSUE_STAGE", () => {
                sheet.getRange(pr_i, COL.PROPERTY).setValue(String(turnFacts.property.name || "").trim());
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_PROPERTY_FROM_ISSUE code=[" + turnFacts.property.code + "]"); } catch (_) {}
        }
      }

      // B) Save UNIT if tenant provided it and Directory unit is blank
      if (turnFacts && turnFacts.unit) {
        const dirUnit_i = dalGetPendingUnit_(dir, dirRow);
        if (!dirUnit_i) {
          const u_i = normalizeUnit_(turnFacts.unit);
          dalSetPendingUnit_(dir, dirRow, u_i, phone, "DIR_SET_UNIT_FROM_ISSUE_STAGE");
          const pr_i2 = dalGetPendingRow_(dir, dirRow);
          if (pr_i2 >= 2) {
            try {
              withWriteLock_("TICKET_SET_UNIT_FROM_ISSUE_STAGE", () => {
                sheet.getRange(pr_i2, COL.UNIT).setValue(u_i);
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_UNIT_FROM_ISSUE unit=[" + u_i + "]"); } catch (_) {}
        }
      }

    } catch (_) {}

    // Compass: always locate active ticket row from Directory pointer
    const activeRow = dalGetPendingRow_(dir, dirRow);

    // Fail-safe: if pointer missing, only prompt property when we truly lack it
    if (activeRow < 2) {
      var _dirProp = dalGetPendingProperty_(dir, dirRow);
      var _dirPropCode = String(_dirProp && _dirProp.code ? _dirProp.code : "").trim();
      var _dirPropName = String(_dirProp && _dirProp.name ? _dirProp.name : "").trim();
      var _ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      var effectiveProp = (_ctx && _ctx.propertyCode) ? String(_ctx.propertyCode).trim() : (_dirPropCode || _dirPropName || "");
      var dirProp = _dirPropCode || _dirPropName || "";
      try { logDevSms_(phone, "", "ISSUE_STAGE_PROP_PTR effective=[" + effectiveProp + "] ctx=[" + (_ctx && _ctx.propertyCode ? String(_ctx.propertyCode) : "") + "] dir=[" + dirProp + "]"); } catch (_) {}

      if (!effectiveProp) {
        reply_(replyAskPropertyMenu_(lang, baseVars));
        try {
          const ctxNow = ctxGet_(phone);
          ctxUpsert_(phone, {
            pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
            pendingExpected: "PROPERTY",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=ISSUE_STAGE_LOST_PTR"); } catch (_) {}
          try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
        } catch (_) {}
        return;
      }

      // Property exists — proceed to next needed field (UNIT if missing) or create ticket
      var _dirUnit = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
      var _dirIssue = String(dalGetPendingIssue_(dir, dirRow) || "").trim();
      if (!_dirIssue && typeof sessionGet_ === "function") {
        try { var _s = sessionGet_(phone); if (_s && _s.draftIssue) _dirIssue = String(_s.draftIssue || "").trim(); } catch (_) {}
      }
      if (!_dirUnit) {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars || {}, { propertyName: _dirPropName || _dirPropCode }), meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try {
          ctxUpsert_(phone, {
            pendingWorkItemId: "",
            pendingExpected: "UNIT",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=ISSUE_STAGE_HAS_PROP"); } catch (_) {}
          try { wiSetWaitTenant_(phone, "UNIT"); } catch (_) {}
        } catch (_) {}
        return;
      }
      if (!_dirIssue) {
        reply_(replyAskPropertyMenu_(lang, baseVars));
        try {
          const ctxNow = ctxGet_(phone);
          ctxUpsert_(phone, {
            pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
            pendingExpected: "PROPERTY",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=ISSUE_STAGE_LOST_PTR"); } catch (_) {}
          try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
        } catch (_) {}
        return;
      }

      // property + unit + issue — create ticket via canonical path
      var _recov = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, Object.assign(firstMediaFieldsFromTurnFacts_(turnFacts), {
        inboundKey: inboundKey,
        OPENAI_API_KEY: OPENAI_API_KEY,
        TWILIO_SID: TWILIO_SID,
        TWILIO_TOKEN: TWILIO_TOKEN,
        TWILIO_NUMBER: TWILIO_NUMBER,
        ONCALL_NUMBER: ONCALL_NUMBER,
        lang: lang,
        baseVars: baseVars,
        mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
        mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
        mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
        mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
      }));
      if (_recov && _recov.ok && _recov.multiIssuePending) {
        var _nextMi = String(_recov.nextStage || "").trim().toUpperCase();
        if (_nextMi === "UNIT") { var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (_og && _og.ok) replied = true; return; }
        if (_nextMi === "SCHEDULE" || _nextMi === "SCHEDULE_DRAFT_MULTI") {
          var _combined = (_recov.summaryMsg && String(_recov.summaryMsg).trim())
            ? String(_recov.summaryMsg).trim()
            : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
          var _ogComb = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: _combined }), meta: { source: "HANDLE_INBOUND_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          if (!(_ogComb && _ogComb.ok)) replyNoHeader_(_combined);
          return;
        }
        return;
      }
      if (_recov && _recov.ok && _recov.loggedRow >= 2) {
        var _nextSt = String(_recov.nextStage || "").trim().toUpperCase();
        if (_nextSt === "") {
          if (!_recov.ackOwnedByPolicy) {
            var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(_recov.ticketId || "") }), meta: { source: "HANDLE_INBOUND_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
            try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
          } else {
            try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (_recov.createdWi || "") + " rule=" + (_recov.policyRuleId || "")); } catch (_) {}
          }
          return;
        }
        if (_nextSt === "UNIT") { var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false }; if (_og && _og.ok) replied = true; return; }
        if (_nextSt === "SCHEDULE") {
          var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
          return;
        }
        return;
      }
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_INBOUND_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return;
    }

    // Append to ticket message (locked)
    withWriteLock_("TICKET_APPEND_MSG_FROM_ISSUE", () => {
      const prevMsg = String(sheet.getRange(activeRow, COL.MSG).getValue() || "").trim();
      var nextMsg = prevMsg;
      if (issueText) nextMsg = prevMsg ? (prevMsg + " | " + issueText) : issueText;
      if (nextMsg !== prevMsg) sheet.getRange(activeRow, COL.MSG).setValue(nextMsg);

      sheet.getRange(activeRow, COL.LAST_UPDATE).setValue(new Date());

      var mediaUrls = (turnFacts && turnFacts.meta && Array.isArray(turnFacts.meta.mediaUrls)) ? turnFacts.meta.mediaUrls : [];
      if (activeRow >= 2 && mediaUrls.length > 0) {
        const abCol = 28;
        // Prefer turnFacts.meta.channel; fallback derive from From at write time so AB never shows MEDIA when we know channel
        var abChannel = (meta2 && meta2.channel) ? String(meta2.channel) : "";
        if (!abChannel && typeof safeParam_ === "function") {
          var _from = String(safeParam_(e, "From") || "").trim().toLowerCase();
          abChannel = (_from.indexOf("whatsapp:") === 0) ? "whatsapp" : "sms";
        }
        var existing = String(sheet.getRange(activeRow, abCol).getValue() || "").trim();
        var lines = existing ? existing.split("\n").filter(Boolean) : [];
        for (var u = 0; u < mediaUrls.length; u++) {
          var url = String(mediaUrls[u] || "").trim();
          if (!url) continue;
          if (existing.indexOf(url) === -1) {
            var line = new Date().toISOString() + " | " + (abChannel ? abChannel.toUpperCase() : "MEDIA") + " | " + url;
            lines.push(line);
          }
        }
        if (lines.length > 0) {
          var out = lines.slice(-10).join("\n");
          sheet.getRange(activeRow, abCol).setValue(out);
        }
      }
    });

    setStatus_(sheet, activeRow, "Waiting Tenant");

    // Emergency finalize check
    if (isEmergencyContext_(sheet, activeRow)) {
      if (typeof finishEmergencyIfReady_ === "function") {
        if (finishEmergencyIfReady_(sheet, dir, dirRow, activeRow, lang)) return;
      }
    }

    // Decide schedule vs detail
    const fullText = String(sheet.getRange(activeRow, COL.MSG).getValue() || "").trim();
    let isClear = issueIsClear_("", 0, fullText) || !!String((turnFacts && turnFacts.issue) || "").trim();

    // ✅ SAFE: avoid ReferenceError (no direct OPENAI_API_KEY reference)
    if (!isClear) {
      try {
        const props = PropertiesService.getScriptProperties();
        const apiKey = String(props.getProperty("OPENAI_API_KEY") || "").trim();
        if (apiKey) {
          var exI = smartExtract_(apiKey, fullText);
          if (exI) {
            isClear =
              issueIsClear_(exI.issueSummary, exI.issueConfidence, fullText) ||
              !!String((turnFacts && turnFacts.issue) || "").trim();
          }
        }
      } catch (_) {}
    }

    if (isClear) {
      const schedStage = "SCHEDULE";

      // ✅ critical: Directory is source of truth for stage
      try {
        dalSetPendingStage_(dir, dirRow, schedStage, phone, "DIR_SET_STAGE_AFTER_ISSUE");
      } catch (_) {}

      // ✅ template-key only schedule prompt (no tenantMsg_, no dayLine) — Phase 2b: semantic intent
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

      try {
        const ctxNow2 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=ISSUE_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      } catch (_) {}

      return;

    } else {

      // ✅ CRITICAL: persist stage so the next reply routes to DETAIL
      try {
        dalSetPendingStage_(dir, dirRow, "DETAIL", phone, "DIR_SET_STAGE_DETAIL_FROM_ISSUE");
      } catch (_) {}

      reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

      try {
        const ctxNow3 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow3 && ctxNow3.activeWorkItemId) ? String(ctxNow3.activeWorkItemId) : "",
          pendingExpected: "DETAIL",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=ISSUE_STAGE"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
      } catch (_) {}

      return;
    }
  }
  }

  // -------------------------
  // DETAIL (Propera Compass SAFE) — ctx-driven
  // - Always write to active row from Directory.PendingRow (col 7)
  // - If missing, fail-safe to PROPERTY (do NOT write to sheet)
  // - ✅ FIX: set Directory.PendingStage = "SCHEDULE" (NOT SCHEDULE_*)
  // - ✅ FIX: ctx.pendingExpected = "SCHEDULE" (NOT SCHEDULE_*)
  // - ✅ FIX: CTX-first stage read via effectiveStage seam
  // - ✅ FIX: template-key only schedule prompt (no tenantMsg_, no dayLine stacking)
  // -------------------------
  if (effectiveStage === "DETAIL") {
    const detail = String(bodyTrim || "").trim();

    if (!detail) {
      reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));

      // Expect DETAIL again
      try {
        const ctxNow0 = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow0 && ctxNow0.activeWorkItemId) ? String(ctxNow0.activeWorkItemId) : "",
          pendingExpected: "DETAIL",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { wiSetWaitTenant_(phone, "DETAIL"); } catch (_) {}
      } catch (_) {}

      return;
    }

  // ✅ Clear DETAIL expectation on success (prevents loops)
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "DETAIL_RESOLVED"); } catch (_) {}

    // ── CROSS-STAGE FACTS (Compiler): save property/unit if tenant included them ──
    try {
      const now_d = new Date();

      // A) Save PROPERTY if tenant provided it and Directory is blank
      if (turnFacts && turnFacts.property && turnFacts.property.code) {
        const _propDetail = dalGetPendingProperty_(dir, dirRow);
        const dirPropCode_d = _propDetail.code;
        if (!dirPropCode_d) {
          dalWithLock_("DIR_SET_PROPERTY_FROM_DETAIL_STAGE", function () {
            dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(turnFacts.property.code || "").trim(), name: String(turnFacts.property.name || "").trim() });
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE DIR_SET_PROPERTY_FROM_DETAIL_STAGE row=" + dirRow); } catch (_) {}
          });
          const pr_d = dalGetPendingRow_(dir, dirRow);
          if (pr_d >= 2) {
            try {
              withWriteLock_("TICKET_SET_PROPERTY_FROM_DETAIL_STAGE", () => {
                sheet.getRange(pr_d, COL.PROPERTY).setValue(String(turnFacts.property.name || "").trim());
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_PROPERTY_FROM_DETAIL code=[" + turnFacts.property.code + "]"); } catch (_) {}
        }
      }

      // B) Save UNIT if tenant provided it and Directory unit is blank
      if (turnFacts && turnFacts.unit) {
        const dirUnit_d = dalGetPendingUnit_(dir, dirRow);
        if (!dirUnit_d) {
          const u_d = normalizeUnit_(turnFacts.unit);
          dalSetPendingUnit_(dir, dirRow, u_d, phone, "DIR_SET_UNIT_FROM_DETAIL_STAGE");
          const pr_d2 = dalGetPendingRow_(dir, dirRow);
          if (pr_d2 >= 2) {
            try {
              withWriteLock_("TICKET_SET_UNIT_FROM_DETAIL_STAGE", () => {
                sheet.getRange(pr_d2, COL.UNIT).setValue(u_d);
              });
            } catch (_) {}
          }
          try { logDevSms_(phone, bodyTrim, "CROSS_STAGE_UNIT_FROM_DETAIL unit=[" + u_d + "]"); } catch (_) {}
        }
      }

    } catch (_) {}

    const activeRow = dalGetPendingRow_(dir, dirRow);

    if (activeRow < 2) {
      reply_(replyAskPropertyMenu_(lang, baseVars));

      try {
        const ctxNow = ctxGet_(phone);
        ctxUpsert_(phone, {
          pendingWorkItemId: (ctxNow && ctxNow.activeWorkItemId) ? String(ctxNow.activeWorkItemId) : "",
          pendingExpected: "PROPERTY",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=DETAIL_STAGE_LOST_PTR"); } catch (_) {}
        try { wiSetWaitTenant_(phone, "PROPERTY"); } catch (_) {}
      } catch (_) {}

      return;
    }

    // Append detail to ticket message (internal storage)
    withWriteLock_("TICKET_APPEND_DETAIL", () => {
      const prevMsg = String(sheet.getRange(activeRow, COL.MSG).getValue() || "").trim();
      const combined = prevMsg ? (prevMsg + " | Detail: " + detail) : ("Detail: " + detail);
      sheet.getRange(activeRow, COL.MSG).setValue(combined);
      sheet.getRange(activeRow, COL.LAST_UPDATE).setValue(new Date());
    });

    setStatus_(sheet, activeRow, "Waiting Tenant");

    // Emergency finalize check
    if (isEmergencyContext_(sheet, activeRow)) {
      if (typeof finishEmergencyIfReady_ === "function") {
        if (finishEmergencyIfReady_(sheet, dir, dirRow, activeRow, lang)) return;
      }
    }

    // ✅ IMPORTANT: unify schedule stage
    try {
      dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "DIR_SET_STAGE_SCHEDULE_FROM_DETAIL");
    } catch (_) {}

    // ✅ template-key only schedule prompt (no tenantMsg_, no dayLine) — Phase 2b: semantic intent
    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, dayWord ? { dayWord: dayWord } : {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "DETAIL", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

    try {
      const ctxNow2 = ctxGet_(phone);
      ctxUpsert_(phone, {
        pendingWorkItemId: (ctxNow2 && ctxNow2.activeWorkItemId) ? String(ctxNow2.activeWorkItemId) : "",
        pendingExpected: "SCHEDULE",
        pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        lastIntent: "MAINT"
      });
      try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=DETAIL_STAGE"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
    } catch (_) {}

    return;
  }



  // -------------------------
  // SCHEDULE stage — extracted sub-functions (verbatim logic, no behavior change)
  // -------------------------
  function handleScheduleAddIssue_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, dirStage, ctxExp, reAskScheduleFn) {
    // Failsafe: do not append schedule-like content as SCHEDULE_ADD
    if ((typeof isScheduleLike_ === "function") && isScheduleLike_(String(rawTrim || "").trim())) return false;
    // Failsafe: skip SCHEDULE_ADD append if last buffer item was just added (within 5s) from SCHEDULE (draftUpsert already appended)
    if (typeof getIssueBuffer_ === "function") {
      var buf = getIssueBuffer_(dir, dirRow);
      if (buf && buf.length > 0) {
        var last = buf[buf.length - 1];
        var lastStage = String(last && last.sourceStage ? last.sourceStage : "").trim();
        var lastCreated = 0;
        try { lastCreated = (last && last.createdAt) ? new Date(last.createdAt).getTime() : 0; } catch (_) {}
        if (lastStage === "SCHEDULE" && (Date.now() - lastCreated) <= 5000) return false;
      }
    }
    withWriteLock_("SCHEDULE_ADD_ISSUEBUF", function () {
      if (typeof appendIssueBufferItem_ === "function") appendIssueBufferItem_(dir, dirRow, rawTrim, "SCHEDULE_ADD");
    });
    reAskScheduleFn("ADDED_ISSUE_WAITING_SCHEDULE");
    return true;
  }

  function handleScheduleMultiBuffer_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, stageDay, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER) {
    if (!looksLikeWindowReply_(rawTrim, stageDay)) return false;
    const label = windowLabel_(rawTrim, stageDay);
    if (!label) return false;
    var multiBuf = (typeof getIssueBuffer_ === "function") ? getIssueBuffer_(dir, dirRow) : [];
    var _multiProp = dalGetPendingProperty_(dir, dirRow);
    var multiPropCode = _multiProp.code;
    var multiPropName = _multiProp.name;
    var multiUnit = dalGetPendingUnit_(dir, dirRow);
    if (multiBuf.length < 2 || !multiPropCode) return false;

    // Policy validation before creating visits/tickets
    var propCode = String(multiPropCode || "").trim().toUpperCase() || "GLOBAL";
    var sched = { label: label };
    if (typeof parsePreferredWindowShared_ === "function") {
      try {
        var d = parsePreferredWindowShared_(rawTrim, stageDay);
        if (d) {
          if (d.start && d.start instanceof Date) { sched.date = d.start; sched.startHour = d.start.getHours(); }
          if (d.end && d.end instanceof Date) { sched.date = sched.date || d.end; sched.endHour = d.end.getHours(); }
        }
      } catch (_) {}
    }
    var verdict = (typeof validateSchedPolicy_ === "function") ? validateSchedPolicy_(propCode, sched, new Date()) : { ok: true };
    if (!verdict.ok) {
      var _vk = String(verdict.key || "").trim();
      var _ogV = (typeof dispatchOutboundIntent_ === "function" && _vk) ? dispatchOutboundIntent_({ intentType: _vk, templateKey: _vk, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, verdict.vars || {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogV && _ogV.ok)) { replyNoHeader_(renderTenantKey_(verdict.key, lang, Object.assign({}, baseVars, verdict.vars || {}))); }
      try { logDevSms_(phone, rawTrim, "SCHED_POLICY_DENY key=[" + verdict.key + "] prop=[" + propCode + "] multi=1"); } catch (_) {}
      try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      try {
        var ctxNow = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        var wiPick = ctxNow ? (String(ctxNow.pendingWorkItemId || "").trim() || String(ctxNow.activeWorkItemId || "").trim()) : "";
        if (typeof ctxUpsert_ === "function") ctxUpsert_(phone, { pendingWorkItemId: wiPick, pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000) }, "SCHED_POLICY_REJECT_MULTI");
      } catch (_) {}
      return true;
    }
    var visitsSh = (typeof ensureVisitsSheet_ === "function") ? ensureVisitsSheet_() : null;
    var visitId = (typeof createVisit_ === "function" && visitsSh)
      ? createVisit_(visitsSh, multiPropCode, multiPropName, multiUnit, label, phone) : "";
    if (!visitId) visitId = "V_" + Date.now();
    try { logDevSms_(phone, "", "VISIT_CREATE visitId=" + visitId); } catch (_) {}
    var sp = PropertiesService.getScriptProperties();
    var creds = {
      OPENAI_API_KEY: sp.getProperty("OPENAI_API_KEY") || "",
      TWILIO_SID: TWILIO_SID || "",
      TWILIO_TOKEN: TWILIO_TOKEN || "",
      TWILIO_NUMBER: TWILIO_NUMBER || "",
      ONCALL_NUMBER: ONCALL_NUMBER || ""
    };
    var ticketIds = [];
    var msgRaw = "";
    withWriteLock_("VISIT_CHILD_TICKETS", () => {
      for (var idx = 0; idx < multiBuf.length; idx++) {
        var it = multiBuf[idx];
        msgRaw = (it && it.rawText) ? String(it.rawText).trim() : "";
        if (!msgRaw) continue;
        var childInboundKey = "VISIT:" + visitId + ":ISSUE:" + (idx + 1);
        var childLocType = "";
        if (typeof inferLocationTypeDeterministic_ === "function") {
          try {
            var childFast = inferLocationTypeDeterministic_(msgRaw);
            var childLt = childFast && childFast.locationType ? String(childFast.locationType).toUpperCase() : "";
            if (childLt === "UNIT" || childLt === "COMMON_AREA") childLocType = childLt;
          } catch (_) {}
        }
        var t = processTicket_(sheet, sp, creds, {
          from: phone,
          tenantPhone: phone,
          propertyName: multiPropName,
          unitFromText: multiUnit,
          messageRaw: msgRaw,
          createdByManager: false,
          inboundKey: childInboundKey,
          locationType: childLocType
        });
        var row = (t && t.rowIndex) ? t.rowIndex : (t && t.row) ? t.row : 0;
        if (row >= 2) {
          if (sheet.getLastColumn() < COL.VISIT_ID) { try { sheet.getRange(1, COL.VISIT_ID).setValue("VisitId"); } catch (_) {} }
          sheet.getRange(row, COL.VISIT_ID).setValue(visitId);
          var tid = (t && t.ticketId) ? String(t.ticketId).trim() : "";
          if (tid) ticketIds.push(tid);
          try { logDevSms_(phone, msgRaw.slice(0, 40), "CHILD_TICKET_CREATE i=" + (idx + 1) + " inbound=" + childInboundKey + " tid=" + tid + " row=" + row); } catch (_) {}
        }
      }
    });
    dalWithLock_("VISIT_CLEAR_DIR", function () {
      dalSetPendingIssueNoLock_(dir, dirRow, "");
      try { logDevSms_(phone, msgRaw, "ISSUE_WRITE site=[VISIT_CLEAR_DIR] val=[CLEAR_VISIT]"); } catch (_) {}
      dalSetPendingRowNoLock_(dir, dirRow, "");
      dalSetPendingStageNoLock_(dir, dirRow, "");
      if (typeof setIssueBuffer_ === "function") setIssueBuffer_(dir, dirRow, []);
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(phone || "", "", "DAL_WRITE VISIT_CLEAR_DIR row=" + dirRow); } catch (_) {}
    });
    try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "VISIT_RESOLVED"); } catch (_) {}
    var _visitVars = Object.assign({}, baseVars, { visitId: visitId, ticketIds: ticketIds.join(", "), label: label });
    var _ogVisit = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
      intentType: "VISIT_CONFIRM", recipientType: "TENANT", recipientRef: phone, lang: lang,
      channel: _channel, deliveryPolicy: "NO_HEADER",
      vars: _visitVars, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" }
    }) : { ok: false };
    if (!(_ogVisit && _ogVisit.ok)) {
      var _confirmMsg = (typeof renderTenantKey_ === "function") ? renderTenantKey_("VISIT_CONFIRM_MULTI", lang, _visitVars) : ("Visit " + visitId + " scheduled for " + label + ". Tickets: " + ticketIds.join(", "));
      replied = true;
      if (typeof sendRouterSms_ === "function") sendRouterSms_(phone, _confirmMsg, "VISIT_CONFIRM_MULTI", _channel); else replyNoHeader_(_confirmMsg);
    } else { replied = true; }
    try { logDevSms_(phone, "", "VISIT_CONFIRM_SENT"); } catch (_) {}
    try {
      if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") {
        advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang);
      }
    } catch (_) {}
    return true;
  }

  // -------------------------
  // SCHEDULE (Propera Compass SAFE) — ctx-driven
  // - Single stage only: "SCHEDULE"
  // - Always uses Directory.PendingRow pointer
  // - Always sets LastUpdate
  // - clearDirPending_ must NOT clear PendingRow
  // ✅ FIXES:
  //   1) If Directory.PendingStage is blank, recover it from ctx.pendingExpected ("SCHEDULE")
  //   2) Parsing uses a neutral anchor ("Today")
  //   3) TicketId lookup MUST happen BEFORE any directory clear/advance
  //   4) After schedule confirmed, advance WI out of WAIT_TENANT (ACTIVE_WORK)
  //   5) De-dup re-ask schedule paths
  //   6) ✅ NO template stacking: use ASK_WINDOW_*_WITH_DAYHINT keys (not dayLine injection)
  // -------------------------
  if (String(effectiveStage || pendingStage || "").toUpperCase() === "SCHEDULE") {
    const now = new Date();
    const rawTrim = String(bodyTrim || "").trim();

    // Helper: compute dayWord once (used only to select template key)
    function dayWordNow_() {
      try { return String(scheduleDayWord_(new Date()) || "").trim(); } catch (_) { return ""; }
    }

    // Helper: render schedule ask without template stacking
    function renderAskWindow_(keyBase) {
      const dw = dayWordNow_();
      const key = dw ? (keyBase + "_WITH_DAYHINT") : keyBase;
      return renderTenantKey_(key, lang, Object.assign({}, baseVars, { dayWord: dw }));
    }

    // Helper: re-ask schedule + keep ctx expectation — Phase 2b: semantic intent
    function reAskSchedule_(reason) {
      var _dw = dayWordNow_();
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, _dw ? { dayWord: _dw } : {}), meta: { source: "HANDLE_INBOUND_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };

      try {
        const ctxNow = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
        const wiPick =
          String(ctxNow.pendingWorkItemId || "").trim() ||
          String(ctxNow.activeWorkItemId || "").trim();

        ctxUpsert_(phone, {
          pendingWorkItemId: wiPick,
          pendingExpected: "SCHEDULE",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "SCHEDULE_REASK_" + String(reason || ""));
        try { wiSetWaitTenant_(phone, "SCHEDULE"); } catch (_) {}
      } catch (_) {}
    }

    // 1) New issue added while waiting for schedule
    if (mode === "TENANT" && dirRow > 0) {
      var dirStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
      var ctxExp = "";
      try {
        var ctxSch = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
        if (ctxSch && ctxSch.pendingExpected) ctxExp = String(ctxSch.pendingExpected || "").trim().toUpperCase();
      } catch (_) {}
      var expectSchedule = (dirStage === "SCHEDULE") || (ctxExp === "SCHEDULE") || (String(ctxExp || "").indexOf("SCHEDULE") >= 0);
      var notScheduleLike = !(turnFacts && turnFacts.schedule && String(turnFacts.schedule.raw || "").trim());
      var actionable = !!String((turnFacts && turnFacts.issue) || "").trim();
      var notChitchat = (typeof isPureChitchat_ === "function") && !isPureChitchat_(rawTrim);
      var notNumericOnly = !/^\d{1,6}$/.test(String(rawTrim || "").replace(/\s/g, ""));
      if (expectSchedule && notScheduleLike && actionable && notChitchat && notNumericOnly && pendingRow >= 2 && !didAppendIssueThisTurn) {
        if (handleScheduleAddIssue_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, dirStage, ctxExp, reAskSchedule_)) return;
      }
    }

    // ✅ 0) Recover stage if it got wiped (Directory.PendingStage blank)
    try {
      if (dirRow > 0) {
        const stageCell = dalGetPendingStage_(dir, dirRow);
        if (!stageCell) {
          const ctxNowStage = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
          const exp = String(ctxNowStage.pendingExpected || "").trim().toUpperCase();

          if (exp === "SCHEDULE") {
            dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "DIR_RECOVER_STAGE_SCHEDULE");
            try { logDevSms_(phone, rawTrim, "DIR_STAGE_RECOVERED stage=[SCHEDULE]"); } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // ✅ Always use Directory.PendingRow pointer
    const activeRow = dalGetPendingRow_(dir, dirRow);

    // 2) Multi-issue buffer path (no active ticket row yet)
    if (activeRow < 2) {
      const stageDay = "Today";
      if (handleScheduleMultiBuffer_(sheet, dir, dirRow, phone, rawTrim, lang, baseVars, stageDay, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER)) return;
      reAskSchedule_("MISSING_PENDING_ROW");
      return;
    }

    // Never treat manager commands as schedule replies
    if (looksLikeManagerCommand_(rawTrim)) {
      reAskSchedule_("MANAGER_COMMAND");
      return;
    }

    // 3) Single ticket schedule confirm
    var dayWordSchedule = "";
    try { dayWordSchedule = String(scheduleDayWord_(new Date()) || "").trim(); } catch (_) {}
    var _hsSt = handleScheduleSingleTicket_(e, sheet, dir, dirRow, phone, activeRow, rawTrim, lang, baseVars, dayWordSchedule, now, signals);
    if (_hsSt && _hsSt.handled) {
      replied = true;
      return;
    }

    // Re-ask schedule and keep expected=SCHEDULE (do not drop to menu)
    reAskSchedule_("PARSE_FAIL");
    return;
  }

  // =========================================================
  // FINALIZE_DRAFT (deterministic finalize: draft complete, no ticket yet)
  // Creates ticket and advances to SCHEDULE using existing finalizeDraftAndCreateTicket_.
  // Pre-ticket: draft fields from Session; finalize overlays Session internally.
  // =========================================================
  if (effectiveStage === "FINALIZE_DRAFT") {
    try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_ENTER pendingRow=[" + pendingRow + "]"); } catch (_) {}

    // Short-reply lane: pure "thanks" with no-reopen must never call finalize again (duplicate ticket risk).
    if (compassNoReopenIntake && String(safeParam_(e, "_compassShortReplyClass") || "").trim() === "thanks") {
      try { logDevSms_(phone, String(bodyTrim || "").slice(0, 28), "FINALIZE_DRAFT_SKIP short_social=[thanks]"); } catch (_) {}
      var _ogSoc = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({
        intentType: "THANKS",
        templateKey: "THANKS",
        recipientType: "TENANT",
        recipientRef: phone,
        lang: lang,
        channel: _channel,
        deliveryPolicy: "NO_HEADER",
        vars: Object.assign({}, baseVars || {}),
        meta: { source: "HANDLE_INBOUND_CORE", stage: "FINALIZE_DRAFT", flow: "SHORT_SOCIAL_NO_REOPEN" }
      }) : { ok: false };
      if (_ogSoc && _ogSoc.ok) replied = true;
      if (!(_ogSoc && _ogSoc.ok) && typeof replyNoHeader_ === "function") {
        replyNoHeader_(renderTenantKey_("THANKS", lang, Object.assign({}, baseVars || {})));
      }
      try {
        e.parameter._compassNoReopenIntake = "";
        e.parameter._compassShortReplyExpected = "";
        e.parameter._compassShortReplyClass = "";
      } catch (_) {}
      return;
    }

    var s = null;
    var _fdProp  = dalGetPendingProperty_(dir, dirRow);
    var propCode = _fdProp.code;
    var propName = _fdProp.name;
    var issue    = dalGetPendingIssue_(dir, dirRow);
    var unit     = dalGetPendingUnit_(dir, dirRow);

    var hasIssue = Boolean(issue) || (typeof getIssueBuffer_ === "function" && getIssueBuffer_(dir, dirRow) && getIssueBuffer_(dir, dirRow).length >= 1);
    if (pendingRow <= 0 && typeof sessionGet_ === "function") {
      s = sessionGet_(phone) || {};
      if (s.draftProperty && !propCode) propCode = String(s.draftProperty || "").trim();
      if (s.draftIssue) issue = String(s.draftIssue || "").trim();
      if (s.draftUnit && !unit) unit = String(s.draftUnit || "").trim();
      if (s.issueBuf && s.issueBuf.length >= 1) hasIssue = true;
      if (!propName && propCode && typeof getPropertyByCode_ === "function") {
        var p = getPropertyByCode_(propCode);
        if (p && p.name) propName = String(p.name || "").trim();
      }
    }

    if (!propCode || !hasIssue) {
      try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_MISSING_FIELDS propCode=[" + (propCode || "") + "] issue=[" + (issue ? "1" : "0") + "] hasIssue=[" + (hasIssue ? "1" : "0") + "]"); } catch (_) {}
      try { recomputeDraftExpected_(dir, dirRow, phone, s); } catch (_) {}
      var pendingUnitF = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
      var canonUnitF   = String(dalGetUnit_(dir, dirRow) || "").trim();
      var hasUnitF     = Boolean(pendingUnitF || canonUnitF);
      var next = (s && s.expected) ? String(s.expected).toUpperCase().trim() : (!propCode ? "PROPERTY" : !hasIssue ? "ISSUE" : (hasUnitF ? "FINALIZE_DRAFT" : "UNIT"));
      if (next === "PROPERTY") {
        reply_(replyAskPropertyMenu_(lang, baseVars));
      } else if (next === "ISSUE") {
        const _issueAskKey = { urgent: "ASK_ISSUE_URGENT", postService: "ASK_ISSUE_POST_SERVICE", recurring: "ASK_ISSUE_RECURRING", frustrated: "ASK_ISSUE_FRUSTRATED" }[signals.tone] || "ASK_ISSUE_GENERIC";
        reply_(renderTenantKey_(_issueAskKey, lang, baseVars));
      } else if (next === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
      } else if (next === "FINALIZE_DRAFT") {
        // hasUnitF true: fall through to finalize (do not ask unit)
      } else {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      }
      if (next !== "FINALIZE_DRAFT") return;
    }

    const result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, Object.assign(firstMediaFieldsFromTurnFacts_(turnFacts), {
      inboundKey,
      lang: lang,
      baseVars: baseVars,
      locationText: bodyTrim,
      mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
      mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
      mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
      mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
    }));
    try {
      logDevSms_(phone, bodyTrim, "FINALIZE_RESULT ok=[" + (result && result.ok ? "1" : "0") + "] reason=[" + String((result && result.reason) || "") + "] multi=[" + (result && result.multiIssuePending ? "1" : "0") + "] ticketId=[" + String((result && result.ticketId) || "") + "]");
    } catch (_) {}
    if (result.ok && result.loggedRow >= 2) {
      try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_CREATED pendingRow=[" + result.loggedRow + "]"); } catch (_) {}
    }
    if (!result.ok) {
      if (String(result.reason || "") === "SCHEDULE_POLICY_BLOCK") {
        var vkFd = String(result.policyKey || "SCHED_REJECT_WEEKEND").trim();
        var vvFd = result.policyVars || {};
        try { logDevSms_(phone, "", "SCHED_POLICY_RECHECK_REPLY sent=1 path=[FINALIZE_DRAFT] key=" + vkFd); } catch (_) {}
        var _ogPolFd = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: vkFd, templateKey: vkFd, recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, vvFd), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogPolFd && _ogPolFd.ok)) replyNoHeader_(renderTenantKey_(vkFd, lang, Object.assign({}, baseVars || {}, vvFd)));
        try { recomputeDraftExpected_(dir, dirRow, phone, s); } catch (_) {}
        return;
      }
      var _fdReason = String((result && result.reason) || "").trim();
      try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_SKIP reason=[" + _fdReason + "]"); } catch (_) {}
      var _fdHardFail = (_fdReason === "ROW_ERR_SPLIT" || _fdReason === "SPLIT_NO_ROWS" || _fdReason === "MISSING_UNIT_FOR_SPLIT" || _fdReason === "ROW_ERR");
      if (_fdHardFail) {
        var _ogFdErr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogFdErr && _ogFdErr.ok) && typeof replyNoHeader_ === "function") {
          try { replyNoHeader_(renderTenantKey_("ERROR_DRAFT_FINALIZE_FAILED", lang, baseVars || {})); } catch (_) {}
        }
        try { recomputeDraftExpected_(dir, dirRow, phone, s); } catch (_) {}
        return;
      }
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      try { recomputeDraftExpected_(dir, dirRow, phone, s); } catch (_) {}
      return;
    }
    if (emitSplitFinalizeDraftTenantMessages_(e, phone, bodyTrim, sheet, dir, dirRow, lang, baseVars, result, issue, unit, propName, _channel, null)) return;
    if (result.multiIssuePending) {
      if (result.nextStage === "SCHEDULE" || result.nextStage === "SCHEDULE_DRAFT_MULTI") {
        var combined = (result.summaryMsg && String(result.summaryMsg).trim()) ? String(result.summaryMsg).trim() : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
        try { logDevSms_(phone, combined.slice(0, 120), "MULTI_COMBINED_OUT"); } catch (_) {}
        var _ogC2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combined }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogC2 && _ogC2.ok)) replyNoHeader_(combined);
        return;
      }
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      return;
    }

    if (result.nextStage === "") {
      if (!result.ackOwnedByPolicy) {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(result.ticketId || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (result.createdWi || "") + " rule=" + (result.policyRuleId || "")); } catch (_) {}
      }
      return;
    }

    // Emergency: never ask for schedule; send emergency ack only
    if (result.nextStage === "EMERGENCY_DONE") {
      var eTid = String(result.ticketId || "").trim();
      try { logDevSms_(phone, "", "FINALIZE_DRAFT_EMERGENCY_DONE tid=" + eTid); } catch (_) {}
      var _ogEt = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_TENANT_ACK", templateKey: "EMERGENCY_TENANT_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: eTid }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogEt && _ogEt.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_TENANT_ACK", lang, Object.assign({}, baseVars, { ticketId: eTid })));
      return;
    }

    finalizeDraftScheduleConfirmOrAskTenant_(phone, sheet, dir, dirRow, lang, baseVars, result, issue, unit, propName, _channel, null, {
      replyNoHeader: replyNoHeader_
    });
    return;
  }

  // =========================================================
  // NEW_TICKET_FLOW (Propera Compass â€” Draft-First)
  // Only reaches here when ticketState.stateType === "NEW".
  // Draft accumulator already ran above (draftUpsertFromTurn_).
  // =========================================================
  if (ticketState.stateType === "NEW") {

    try { logDevSms_(phone, "MARK_F NEW_TICKET_FLOW bodyTrim=[" + String(bodyTrim||"") + "]", "MARK_F"); } catch (_) {}

    // --------------------------------------------------
    // Operational domain dispatch (Phase 1 – CLEANING)
    // If CLEANING is strongly selected, bypass maintenance ticket creation
    // and create a cleaning work item instead.
    // --------------------------------------------------
    var domainDispatchResult = null;
    try {
      domainDispatchResult = dispatchOperationalDomain_(domainDecision, {
        phone: phone,
        originPhone: originPhone,
        lang: lang,
        baseVars: baseVars,
        mode: mode,
        propertyCode: String(dir.getRange(dirRow, 2).getValue() || "").trim(),
        propertyName: String(dir.getRange(dirRow, 3).getValue() || "").trim(),
        pendingUnit: String(dalGetPendingUnit_(dir, dirRow) || "").trim(),
        bodyTrim: bodyTrim,
        mediaFacts: mediaFacts,
        turnFacts: turnFacts,
        channel: (turnFacts.meta && turnFacts.meta.channel) ? String(turnFacts.meta.channel || "").toUpperCase() : "SMS"
      });
    } catch (_) {}

    if (domainDispatchResult && domainDispatchResult.handled === true) {
      if (typeof clearMaintenanceDraftResidue_ === "function") clearMaintenanceDraftResidue_(dir, dirRow, phone);
      try {
        var _ogC = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "CLEANING_WORKITEM_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "CLEANING_DISPATCH", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogC && _ogC.ok)) replyNoHeader_(renderTenantKey_("CLEANING_WORKITEM_ACK", lang, baseVars));
      } catch (_) {}
      return;
    }

    const rawTrim = String(bodyTrim || "").trim();

    // â”€â”€ A) Guardrail â”€â”€
    var hasInterpretedIssue = !!String((turnFacts && turnFacts.issue) || "").trim();
    if (isPureChitchat_(rawTrim) && !hasInterpretedIssue) {
      var _ogH3 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "SHOW_HELP", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "NEW_TICKET_FLOW", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogH3 && _ogH3.ok)) replyNoHeader_(renderTenantKey_("HELP_INTRO", lang, baseVars));
      return;
    }
    if (!hasInterpretedIssue) {
      var _ogP = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "PROMPT_SEND_MAINT_FORMAT", templateKey: "PROMPT_SEND_MAINT_FORMAT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "NEW_TICKET_FLOW", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogP && _ogP.ok)) replyNoHeader_(renderTenantKey_("PROMPT_SEND_MAINT_FORMAT", lang, baseVars));
      return;
    }

    // B) Clear stale draft fields before starting fresh
    if (dirRow > 0) {
      dalWithLock_("CLEAR_STALE_DRAFT", function () {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[CLEAR_STALE_DRAFT] val=[CLEAR_NEW_FLOW]"); } catch (_) {}
        dalSetPendingUnitNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE CLEAR_STALE_DRAFT row=" + dirRow); } catch (_) {}
      });
      // Re-run draft accumulator on the cleared state so THIS message fills the draft
      try { draftUpsertFromTurn_(dir, dirRow, turnFacts, bodyTrim, phone); } catch (_) {}
      try { logDevSms_(phone, bodyTrim, "STALE_DRAFT_CLEARED_AND_REFILLED"); } catch (_) {}
    }

    // â”€â”€ C) Emergency precheck (before property gate) â”€â”€
    var emergencyPre = (turnFacts && turnFacts.safety) ? turnFacts.safety : { isEmergency: false, emergencyType: "" };
    const propCodeNow = String(dir.getRange(dirRow, 2).getValue() || "").trim();

    if (mode === "TENANT" && !propCodeNow && emergencyPre.isEmergency) {
      var emType = String(emergencyPre.emergencyType || "").trim();
      try { logDevSms_(phone, rawTrim, "EMERGENCY_PREALERT emergencyType=[" + emType + "]"); } catch (_) {}
      try { logDevSms_(phone, "", "EMERGENCY_WAIT_LOCATION expected=PROPERTY emergencyType=[" + emType + "]"); } catch (_) {}
      if (dirRow > 0) {
        dalWithLock_("EMERG_PRECHECK_STORE", function () {
          var existingIssue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
          if (!existingIssue && rawTrim) {
            dalSetPendingIssueNoLock_(dir, dirRow, rawTrim);
            try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[EMERG_PRECHECK_STORE] val=[" + rawTrim.slice(0, 40) + "]"); } catch (_) {}
          }
          dalSetPendingRowNoLock_(dir, dirRow, "");
          dalSetPendingStageNoLock_(dir, dirRow, "PROPERTY");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(phone || "", "", "DAL_WRITE EMERG_PRECHECK_STORE row=" + dirRow); } catch (_) {}
        });
      }
      try {
        const mgrMsg = tenantMsgSafe_("EMERGENCY_PREALERT_UNKNOWN_PROPERTY", "en",
          Object.assign({}, baseVars, { phone, msg: rawTrim, emergencyKind: emType }),
          "EMERGENCY_PREALERT_UNKNOWN_PROPERTY");
        if (typeof dispatchOutboundIntent_ === "function") {
          dispatchOutboundIntent_({
            intentType: "CORE_TEXT_REPLY",
            recipientType: "TENANT",
            recipientRef: ONCALL_NUMBER,
            channel: "SMS",
            lang: "en",
            deliveryPolicy: "DIRECT_SEND",
            preRenderedBody: mgrMsg,
            vars: {},
            meta: { source: "handleInboundCore_", stage: "EMERG_PRECHECK", flow: "ONCALL_NOTIFY" }
          });
        }
      } catch (_) {}
      try {
        ctxUpsert_(phone, {
          flowMode: "EMERGENCY", emergencyKind: emType,
          pendingWorkItemId: "",
          pendingExpected: "PROPERTY",
          pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "EMERG_PRECHECK_EXPECT_PROPERTY");
      } catch (_) {}
      try {
        const safety = tenantMsgSafe_("SAFETY_GAS_CO_FIRE", lang, baseVars, "SAFETY_GAS_CO_FIRE");
        replyNoHeader_(String(safety || "").trim() + "\n\n" + replyAskPropertyMenu_(lang, baseVars));
      } catch (_) { reply_(replyAskPropertyMenu_(lang, baseVars)); }
      return;
    }

    // â”€â”€ D) Decide what's still missing â”€â”€
    const nextMissing = draftDecideNextStage_(phone, dir, dirRow);

    if (nextMissing !== "READY") {
      // Write stage BEFORE asking (crash-resilient)
      dalSetPendingStage_(dir, dirRow, nextMissing, phone, "NTF_SET_PENDING_STAGE");
      try {
        ctxUpsert_(phone, {
          pendingExpected:   nextMissing,
          pendingExpiresAt:  new Date(Date.now() + 10 * 60 * 1000),
          lastIntent:        "MAINT"
        }, "NTF_MISSING_" + nextMissing);
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=" + nextMissing + " src=NTF_DRAFT"); } catch (_) {}
      } catch (_) {}

      if (nextMissing === "PROPERTY")      reply_(replyAskPropertyMenu_(lang, baseVars));
      else if (nextMissing === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
      }
      else /* ISSUE */ {
        var _og2 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og2 && _og2.ok) replied = true;
      }
      return;
    }

    // â”€â”€ E) READY â€” check tenant is not mid-conversation â”€â”€
    const preBusyRow   = dalGetPendingRow_(dir, dirRow);
    const preBusyStage = String(dalGetPendingStage_(dir, dirRow) || "").trim();
    const tenantIsBusy = !!(preBusyStage || preBusyRow > 0);

    // DUP60 content dedup
    const effectiveMessage = String(bodyRaw || "").trim();
    const dkeyRaw = [
      phone,
      propCodeNow,
      String(dalGetPendingUnit_(dir, dirRow) || "").toLowerCase(),
      String(dalGetPendingIssue_(dir, dirRow) || "").toLowerCase()
    ].join("|");
    const dkey = "DUP60_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, dkeyRaw));
    if (cache.get(dkey)) {
      var _ogDup = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "DUPLICATE_REQUEST_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "NEW_TICKET_FLOW", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogDup && _ogDup.ok)) reply_(renderTenantKey_("DUPLICATE_REQUEST_ACK", lang, baseVars));
      return;
    }
    cache.put(dkey, "1", 60 * 60);

    // Clear old pointer before creating (skip if manager + tenant busy â€” queue instead)
    if (dirRow > 0 && !(mode === "MANAGER" && tenantIsBusy)) {
      withWriteLock_("NTF_CLEAR_PTR", () => {
        dirSet_(dir, dirRow, { pendingRow: "", pendingStage: "", now: new Date() });
      });
    }

    // â"€â"€ F) Create ticket â"€â"€
    const result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, phone, Object.assign(firstMediaFieldsFromTurnFacts_(turnFacts), {
      inboundKey, OPENAI_API_KEY, TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, ONCALL_NUMBER,
      createdByManager: (mode === "MANAGER"), lang: lang, baseVars: baseVars, locationText: rawTrim,
      mediaType: (mediaFacts && mediaFacts.mediaType) ? String(mediaFacts.mediaType || "").trim() : "",
      mediaCategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.category) ? String(mediaFacts.issueHints.category || "").trim() : "",
      mediaSubcategoryHint: (mediaFacts && mediaFacts.issueHints && mediaFacts.issueHints.subcategory) ? String(mediaFacts.issueHints.subcategory || "").trim() : "",
      mediaUnitHint: (mediaFacts && mediaFacts.unitHint) ? String(mediaFacts.unitHint || "").trim() : ""
    }));
    try {
      logDevSms_(
        phone,
        "",
        "TRACE_AFTER_FINALIZE dtMs=" + String(Date.now() - t0) +
          " ok=" + String(result && result.ok ? 1 : 0) +
          " adapter=" + String((e && e.parameter && e.parameter._channel) ? String(e.parameter._channel).trim() : ((typeof globalThis !== "undefined" && globalThis.__traceAdapter) ? globalThis.__traceAdapter : "")) +
          " traceId=" + String((typeof globalThis !== "undefined" && globalThis.__traceId) ? globalThis.__traceId : "")
      );
    } catch (_) {}

    if (!result.ok) {
      if (result.reason === "ACTIVE_TICKET_EXISTS") {
        // Re-route to continuation handler â€" do NOT return
        try { logDevSms_(phone, bodyTrim, "NTF_BLOCKED_REROUTE stage=[" + effectiveStage + "]"); } catch (_) {}
      } else {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_DRAFT_FINALIZE_FAILED", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        return;
      }
    }
    var ntfIssueForSplit = String((turnFacts && turnFacts.issue) || rawTrim || "").trim();
    var ntfUnitForSplit = String((turnFacts && turnFacts.unit) || dalGetUnit_(dir, dirRow) || dalGetPendingUnit_(dir, dirRow) || "").trim();
    var ntfPropForSplit = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
    var ntfPropNameForSplit = String(ntfPropForSplit && ntfPropForSplit.name ? ntfPropForSplit.name : "").trim();
    if (result.ok && emitSplitFinalizeDraftTenantMessages_(e, phone, bodyTrim, sheet, dir, dirRow, lang, baseVars, result, ntfIssueForSplit, ntfUnitForSplit, ntfPropNameForSplit, _channel, null)) {
      return;
    }
    if (result.multiIssuePending) {
      if (result.nextStage === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        return;
      }
      if (result.nextStage === "SCHEDULE" || result.nextStage === "SCHEDULE_DRAFT_MULTI") {
        var combined = (result.summaryMsg && String(result.summaryMsg).trim()) ? String(result.summaryMsg).trim() : renderTenantKey_("ASK_WINDOW_SIMPLE", lang, baseVars);
        try { logDevSms_(phone, combined.slice(0, 120), "MULTI_COMBINED_OUT"); } catch (_) {}
        var _ogC3 = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { summaryText: combined }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogC3 && _ogC3.ok)) replyNoHeader_(combined);
        return;
      }
      return;
    }

    if (!isStaffCapture) {
    const loggedRow = result.loggedRow || 0;
    const ticketId = result.ticketId || "";
    const createdWi = result.createdWi || "";
    const nextStage = result.nextStage || "";

    // â”€â”€ G) Queue branch â”€â”€
    if (mode === "MANAGER" && tenantIsBusy) {
      withWriteLock_("QUEUE_MARK", () => {
        sheet.getRange(loggedRow, COL.STATUS).setValue("Queued");
        sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(new Date());
      });
      if (createdWi) { try { workItemUpdate_(createdWi, { state: "QUEUED", substate: "" }); } catch (_) {} }
      const mgrNotifyPhone = originPhone || phone;
      sendSms_(TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, mgrNotifyPhone,
        tenantMsg_("MGR_TICKET_QUEUED_OK", "en", { ...baseVars, ticketId }));
      return;
    }

    // â”€â”€ H) Emergency override â”€â”€
    try {
      const pt = result.ticket || {};
      const c  = pt.classification || null;
      if (pt.ok && c && c.emergency) {
        if (dirRow > 0) {
          dalWithLock_("NTF_EMERGENCY_DIR", function () {
            dalSetPendingRowNoLock_(dir, dirRow, loggedRow);
            dalSetPendingStageNoLock_(dir, dirRow, "EMERGENCY_DONE");
            dalSetLastUpdatedNoLock_(dir, dirRow);
            try { logDevSms_(phone || "", "", "DAL_WRITE NTF_EMERGENCY_DIR row=" + dirRow); } catch (_) {}
          });
        }
        if (createdWi) { try { workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" }); } catch (_) {} }
        try {
          ctxUpsert_(phone, {
            activeWorkItemId: createdWi || "", pendingWorkItemId: createdWi || "",
            pendingExpected: "EMERGENCY_DONE",
            pendingExpiresAt: new Date(Date.now() + 60 * 60 * 1000), lastIntent: "MAINT"
          }, "NTF_EMERGENCY");
        } catch (_) {}
        const eTid = String(sheet.getRange(loggedRow, COL.TICKET_ID).getValue() || "").trim();
        var _ogEtN = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "EMERGENCY_TENANT_ACK", templateKey: "EMERGENCY_TENANT_ACK", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: eTid }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (!(_ogEtN && _ogEtN.ok)) replyNoHeader_(renderTenantKey_("EMERGENCY_TENANT_ACK", lang, Object.assign({}, baseVars, { ticketId: eTid })));
        return;
      }
    } catch (_) {}

    // â”€â”€ I) AI enrichment (async) â”€â”€

    // â”€â”€ J) Ask next question â”€â”€
    if (nextStage === "UNIT") {
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (_og && _og.ok) replied = true;
      return;
    }
    if (nextStage === "") {
      if (!result.ackOwnedByPolicy) {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_COMMON_AREA", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { ticketId: String(ticketId || "") }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try { if (dirRow > 0 && typeof advanceTenantQueueOrClear_ === "function") advanceTenantQueueOrClear_(sheet, dir, dirRow, phone, lang); } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "ACK_SUPPRESSED_BY_POLICY workItemId=" + (createdWi || "") + " rule=" + (result.policyRuleId || "")); } catch (_) {}
      }
      return;
    }

    const dayLine = dayWord
      ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, baseVars, { dayWord })))
      : "";

    if (String(mode || "").toUpperCase() === "MANAGER") {
      const intro = renderTenantKey_("MGR_CREATED_TICKET_INTRO", lang, baseVars);
      const ask   = renderTenantKey_("ASK_WINDOW_SIMPLE", lang, Object.assign({}, baseVars, { dayLine }));
      var _mgrBody = String(intro || "").trim() + "\n\n" + String(ask || "").trim();
      var _ogMgr = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { managerIntro: _mgrBody }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      if (!(_ogMgr && _ogMgr.ok)) replyNoHeader_(_mgrBody);
      return;
    }

    var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars, { dayLine: dayLine }), meta: { source: "HANDLE_SMS_CORE", stage: "FINALIZE_DRAFT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
    return;

    }

  } // closes if (ticketState.stateType === "NEW") / NEW_TICKET_FLOW

  // ===================================================================
  // If we reach here, we were mid-conversation but no stage handler caught it.
  // Compass fallback: use ctx.pendingExpected (deterministic), never create a new ticket here.
  // ✅ Single-stage SCHEDULE only (no SCHEDULE_* propagation)
  // ===================================================================
  try {
    const pr2 = dalGetPendingRow_(dir, dirRow);
    const ctx2 = ctxGet_(phone) || {};
    const exp2raw = String(ctx2.pendingExpected || "").trim().toUpperCase();

    // Normalize any legacy schedule expectations to "SCHEDULE"
    const exp2 = (exp2raw === "SCHEDULE" || exp2raw.indexOf("SCHEDULE_") === 0) ? "SCHEDULE" : exp2raw;

    const dayLine2 = dayWord
      ? ("\n(If you prefer, you can also say: “" + dayWord + " morning / afternoon / evening”.)")
      : "";

    if (pr2 > 1) {

      if (exp2 === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try {
          ctxUpsert_(phone, {
            pendingExpected: "UNIT",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=UNIT src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      if (exp2 === "DETAIL") {
        reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));
        try {
          ctxUpsert_(phone, {
            pendingExpected: "DETAIL",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=DETAIL src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      if (exp2 === "ISSUE") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try {
          ctxUpsert_(phone, {
            pendingExpected: "ISSUE",
            pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=ISSUE src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      if (exp2 === "SCHEDULE") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dayLine: dayLine2 }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try {
          ctxUpsert_(phone, {
            pendingExpected: "SCHEDULE",
            pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
            lastIntent: "MAINT"
          });
          try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=SCHEDULE src=FALLBACK_CTX"); } catch (_) {}
        } catch (_) {}
        return;
      }

      // Last resort: Directory stage (legacy support)
      const stage2raw = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
      const stage2 = (stage2raw === "SCHEDULE" || stage2raw.indexOf("SCHEDULE_") === 0) ? "SCHEDULE" : stage2raw;

      if (stage2 === "UNIT") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: baseVars || {}, meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        if (_og && _og.ok) replied = true;
        try { ctxUpsert_(phone, { pendingExpected: "UNIT", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
        return;
      }

      if (stage2 === "DETAIL") {
        reply_(renderTenantKey_("ASK_DETAIL", lang, baseVars));
        try { ctxUpsert_(phone, { pendingExpected: "DETAIL", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
        return;
      }

      if (stage2 === "SCHEDULE") {
        var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dayLine: dayLine2 }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
        try { ctxUpsert_(phone, { pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
        return;
      }

      // Unknown but active ticket → safest schedule prompt, canonical expectation — Phase 2b: semantic intent
      var _og = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: _channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars, { dayLine: dayLine2 }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } }) : { ok: false };
      try { ctxUpsert_(phone, { pendingExpected: "SCHEDULE", pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
      return;

    } else {
      // No active pointer → safest prompt is property menu
      reply_(replyAskPropertyMenu_(lang, baseVars));
      try {
        ctxUpsert_(phone, { pendingExpected: "PROPERTY", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" });
        try { logDevSms_(phone, bodyTrim, "PENDING_SET expected=PROPERTY src=FALLBACK_NO_PTR"); } catch (_) {}
      } catch (_) {}
      return;
    }

  } catch (_) {
    // Ultra-safe fallback
    reply_(replyAskPropertyMenu_(lang, baseVars));
    try { ctxUpsert_(phone, { pendingExpected: "PROPERTY", pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000), lastIntent: "MAINT" }); } catch (_) {}
    return;
  }



  } catch (err) {
    hadError = true;
    try { if (globalThis.__chaos && globalThis.__chaos.enabled && typeof writeTimeline_ === "function") writeTimeline_("ERROR", { err: (typeof safeTrunc_ === "function" ? safeTrunc_(err && err.stack ? err.stack : err, 600) : String(err).slice(0, 600)) }, null); } catch (_) {}
    Logger.log("handleSmsCore_ error: " + err);
    return;

  } finally {

    try {
      if (e && e.parameter) {
        e.parameter._compassNoReopenIntake = "";
        e.parameter._compassShortReplyExpected = "";
        e.parameter._compassShortReplyClass = "";
      }
    } catch (_) {}

    // ⏱️ PERF: total runtime of handleSmsCore_
    try {
      logDevSms_(
        originPhone || "",
        bodyRaw || "",
        "PERF ms=" + (Date.now() - t0) + (sidKey ? (" sidKey=" + sidKey) : ""),
        ""
      );
    } catch (_) {}

    // ✅ Only cache SID if we did NOT crash
    if (!hadError && sidKey) {
      try {
        CacheService.getScriptCache().put(sidKey, "1", 60 * 60);
      } catch (_) {}
    }

    try {
      if (globalThis.__chaos && globalThis.__chaos.enabled) {
        var ctxForSnap = (typeof ctxGet_ === "function" && phone) ? ctxGet_(phone) : null;
        var snapDir = (typeof snapDir_ === "function" && dir && dirRow) ? snapDir_(dir, dirRow) : {};
        var snapCtx = (typeof snapCtx_ === "function") ? snapCtx_(ctxForSnap) : {};
        var snapDraft = (typeof snapDraft_ === "function" && dir && dirRow) ? snapDraft_(dir, dirRow) : {};
        var snapWi = (typeof snapWi_ === "function" && ctxForSnap && ctxForSnap.activeWorkItemId) ? snapWi_({ workItemId: ctxForSnap.activeWorkItemId }) : {};
        var snapObj = { dir: snapDir, ctx: snapCtx, draft: snapDraft, wi: snapWi };
        writeTimeline_("SNAP", { pendingExpected: (ctxForSnap && ctxForSnap.pendingExpected) || "", pendingStage: (snapDir && snapDir.pendingStage) || "" }, snapObj);
        writeTimeline_("TEST_END", { result: hadError ? "ERROR" : "OK" }, { result: hadError ? "ERROR" : "OK" });
      }
    } catch (_) {}

    // ✅ Flush buffered DevSms logs (single write)
    try {
      flushDevSmsLogs_();
    } catch (_) {}
  }
  } // ✅ closes handleSmsCore_


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// Property menu reply helper
// ─────────────────────────────────────────────────────────────────




  function replyAskPropertyMenu_(lang, baseVars, opts) {
    var o = opts || {};
    var vars = baseVars || {};
    var langNorm = String(lang || "en").toLowerCase();
    if (langNorm.indexOf("-") > 0) langNorm = langNorm.split("-")[0];
    var askAttempt = Number(o.askAttempt) || 1;

    var conv = (typeof buildPropertyConversationalOptions_ === "function") ? buildPropertyConversationalOptions_() : { line: "", labels: [] };
    var convLine = String((conv && conv.line) || "").trim();
    var unitNum = (vars && vars.unit != null) ? String(vars.unit).trim() : "";
    var firstLabel = (conv && conv.labels && conv.labels.length > 0) ? String(conv.labels[0] || "").trim() : "";
    var secondLabel = (conv && conv.labels && conv.labels.length > 1) ? String(conv.labels[1] || "").trim() : "";

    function bodyConversational_() {
      if (!convLine) return "";
      var isEs = langNorm === "es";

      if (askAttempt >= 3) {
        if (isEs) return "Responde solo con el nombre del edificio, por ejemplo: " + (firstLabel || "Penn") + " o " + (secondLabel || "Morris") + ".";
        return "Reply with just the building name, for example: " + (firstLabel || "Penn") + " or " + (secondLabel || "Morris") + ".";
      }

      if (askAttempt === 2) {
        if (isEs) return "Necesito el nombre del edificio para registrar tu solicitud — " + convLine + ".";
        return "I need the building name to place this request correctly — " + convLine + ".";
      }

      if (isEs) {
        if (unitNum) return "Unidad " + unitNum + " — ¿en cuál edificio estás: " + convLine + "?";
        return "¿En cuál edificio estás — " + convLine + "?";
      }
      if (unitNum) return "Unit " + unitNum + " — which building are you in: " + convLine + "?";
      return "Which building are you in — " + convLine + "?";
    }

    if (convLine) {
      var bodyQ = bodyConversational_();
      if (askAttempt >= 2) return bodyQ;
      var skipPrefix = o.prefixKey && String(o.prefixKey).trim().toUpperCase() === "ASK_PROPERTY_GOT_UNIT" && !!unitNum;
      var prefix = "";
      if (o.prefixKey && !skipPrefix) {
        try {
          prefix = String(renderTenantKey_(String(o.prefixKey), lang, baseVars || {}) || "").trim();
        } catch (_) {}
      }
      if (prefix) return prefix + "\n\n" + bodyQ;
      return bodyQ;
    }

    var menu = String(buildPropertyMenuLines_() || "").trim();
    var propertyMenu = menu ? ("\n" + menu + "\n") : "\nReply with your property name (example: Penn).\n";
    var unitLine2 = unitNum ? ("We got your unit: " + unitNum + ".\n") : "";
    var menuMsg = renderTenantKey_("ASK_PROPERTY_MENU", lang, Object.assign({}, vars, {
      propertyMenu: propertyMenu,
      unitLine: unitLine2
    }));
    var prefix2 = "";
    try {
      if (o.prefixKey) prefix2 = String(renderTenantKey_(String(o.prefixKey), lang, baseVars || {}) || "").trim();
    } catch (_) {}
    if (prefix2) return prefix2 + "\n\n" + menuMsg;
    return menuMsg;
  }
