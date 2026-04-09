/**
 * TICKET_FINALIZE_ENGINE.gs — Propera Draft Recompute, Finalize, Portal PM, Ops Domain
 *
 * OWNS:
 *   - getLogSheet_ cache, recomputeDraftExpected_, finalize split/single ticket, portal PM CRUD
 *   - Work items backbone, operational domain router (cleaning vs maintenance), clearMaintenanceDraftResidue_
 *
 * DOES NOT OWN:
 *   - Session ctx get/upsert -> DIRECTORY_SESSION_DAL.gs (later)
 *
 * ENTRY POINTS:
 *   - recomputeDraftExpected_(), finalizeDraftAndCreateSplitTickets_(), portalPm*(), routeOperationalDomain_()
 *
 * DEPENDENCIES:
 *   - Globals from PROPERA MAIN.gs shell; dal*, STAFF_RESOLVER, LIFECYCLE as called
 *
 * FUTURE MIGRATION NOTE:
 *   - Ticket/work-order service; sheet writes behind repository
 *
 * SECTIONS IN THIS FILE:
 *   1. Log sheet helper
 *   2. Recompute draft expected
 *   3. Finalize and portal PM
 *   4. Visits/work items & operational domain
 */
// One open per execution for ticket sheet (avoids reopen each inbound).
function getLogSheet_() {
  if (!globalThis.__logSheetCache) {
    const ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    globalThis.__logSheetCache = ss.getSheetByName(SHEET_NAME);
  }
  return globalThis.__logSheetCache;
}

// ============================================================
// RECOMPUTE DRAFT EXPECTED (Propera Compass — FIX B)
// Intake order: Issue → Property → Unit → Schedule.
// Reads Directory and (when pendingRow>0) ticket row for completeness.
// pendingRow>0 does NOT imply schedule present; schedule = ticket PREF_WINDOW.
// ============================================================
// issueAlignOpt: optional { issueMeta, checkpoint, openerNext } from same inbound (compile / Phase 3).
// openerNext can enforce authoritative pre-ticket progression (e.g., SCHEDULE_PRETICKET).
function recomputeDraftExpected_(dir, dirRow, phone, sessionOpt, issueAlignOpt) {
  if (!dirRow || dirRow < 2 || !dir) return;
  try {
    var pendingRow = dalGetPendingRow_(dir, dirRow);
    var currentStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
    var session = (sessionOpt != null) ? sessionOpt : ((typeof sessionGet_ === "function") ? sessionGet_(phone) : null);
    if (pendingRow <= 0 && session && (session.stage || session.expected)) {
      currentStage = String(session.stage || session.expected || "").trim().toUpperCase();
    }
    try {
      logDevSms_(phone, "", "RECOMPUTE_ENTRY stage=[" + currentStage + "]");
    } catch (_) {}
    if (currentStage === "EMERGENCY_DONE") return;

    var hasIssue = Boolean(dalGetPendingIssue_(dir, dirRow));
    var hasProperty = Boolean(dalGetPendingProperty_(dir, dirRow).code);
    var pendingUnit = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
    var canonUnit   = String(dalGetUnit_(dir, dirRow) || "").trim();
    var hasUnit     = Boolean(pendingUnit || canonUnit);
    var hasSchedule = false;

    if (pendingRow <= 0 && session) {
      if (session.draftIssue) hasIssue = true;
      if (session.draftProperty) hasProperty = true;
      if (session.draftUnit) hasUnit = true;
      if (session.draftScheduleRaw) hasSchedule = true;
      var buf = session.issueBuf;
      if (buf && buf.length >= 1) hasIssue = true;
    }

    if (pendingRow >= 2 && typeof COL !== "undefined") {
      try {
        const sheet = getLogSheet_();
        if (sheet && pendingRow <= sheet.getLastRow()) {
          const ticketMsg = String(sheet.getRange(pendingRow, COL.MSG).getValue() || "").trim();
          const ticketUnit = String(sheet.getRange(pendingRow, COL.UNIT).getValue() || "").trim();
          const ticketSched = String(sheet.getRange(pendingRow, COL.PREF_WINDOW).getValue() || "").trim();
          if (!hasIssue && ticketMsg) hasIssue = true;
          if (!hasIssue) hasIssue = true; // ticket exists → issue committed; avoid fallback to ISSUE after finalize clears dir col 5
          if (!hasUnit && ticketUnit) hasUnit = true;
          hasSchedule = Boolean(ticketSched);
        }
      } catch (_) {}
    } else {
      hasSchedule = Boolean(String(dir.getRange(dirRow, typeof DIR_COL !== "undefined" ? DIR_COL.DRAFT_SCHEDULE_RAW : 13).getValue() || "").trim());
    }

    // Aligned issue count for logs only (Phase3 checkpoint / issueMeta / ISSUEBUF / draft parity). Does not change hasIssue / stage transitions.
    // Priority: (1) checkpoint.issuesCount — opt.checkpoint, ctx, or global lane (2) issueMeta max(clauses, problemSpanCount) can raise understated checkpoint (3) legacy buffer + draft fallback.
    var issueCountForLog = 0;
    var issueCountSource = "fallback";
    try {
      var laneCp = null;
      if (issueAlignOpt && issueAlignOpt.checkpoint && typeof issueAlignOpt.checkpoint === "object") {
        laneCp = issueAlignOpt.checkpoint;
      }
      var ctxSnap = null;
      try {
        ctxSnap = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
      } catch (_) {}
      var icCheckpoint = NaN;
      if (laneCp && laneCp.issuesCount != null) icCheckpoint = Number(laneCp.issuesCount);
      else if (ctxSnap && ctxSnap.issuesCount != null) icCheckpoint = Number(ctxSnap.issuesCount);
      if (isFinite(icCheckpoint) && icCheckpoint > 0) {
        issueCountForLog = Math.min(24, Math.floor(icCheckpoint));
        issueCountSource = "checkpoint";
      }
      if (issueAlignOpt && issueAlignOpt.issueMeta) {
        var im0 = issueAlignOpt.issueMeta;
        var clen0 = Array.isArray(im0.clauses) ? im0.clauses.length : 0;
        var pspan0 = (im0.problemSpanCount != null) ? Number(im0.problemSpanCount) : NaN;
        var metaBest0 = Math.max(clen0, (isFinite(pspan0) && pspan0 > 0) ? Math.floor(pspan0) : 0);
        if (metaBest0 > issueCountForLog) {
          issueCountForLog = Math.min(24, metaBest0);
          issueCountSource = "issueMeta";
        }
      }
      if (issueCountForLog < 1 && typeof getIssueBuffer_ === "function") {
        var dBuf = getIssueBuffer_(dir, dirRow) || [];
        if (dBuf.length >= 1) {
          issueCountForLog = Math.min(24, dBuf.length);
          issueCountSource = "fallback";
        }
      }
      if (issueCountForLog < 1 && pendingRow <= 0 && session && session.issueBuf && session.issueBuf.length >= 1) {
        issueCountForLog = Math.min(24, session.issueBuf.length);
        issueCountSource = "fallback";
      }
      if (issueCountForLog < 1) {
        issueCountForLog = hasIssue ? 1 : 0;
        issueCountSource = "fallback";
      }
    } catch (_) {
      issueCountForLog = hasIssue ? 1 : 0;
      issueCountSource = "fallback";
    }
    try {
      logDevSms_(phone, "", "RECOMPUTE_ISSUE_SOURCE source=" + issueCountSource + " count=" + issueCountForLog);
    } catch (_) {}

let next = "";
var openerNext = "";
try { openerNext = String((issueAlignOpt && issueAlignOpt.openerNext) || "").trim().toUpperCase(); } catch (_) {}

if (!hasIssue) next = "ISSUE";
else if (!hasProperty) next = "PROPERTY";
else if (!hasUnit) next = "UNIT";
else {
  if (pendingRow > 0 && !hasSchedule) {
    next = "SCHEDULE";
  } else if (pendingRow <= 0) {
    next = (openerNext === "SCHEDULE") ? "SCHEDULE_PRETICKET" : "FINALIZE_DRAFT";
  } else {
    next = "";
  }
}

// GUARD: Emergency must never transition to SCHEDULE. Durable-first (Directory, Ticket, WI, then ctx).
if (next === "SCHEDULE") {
  try {
    var _ctx = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
    var _em = (typeof isEmergencyContinuation_ === "function") ? isEmergencyContinuation_(dir, dirRow, _ctx, phone) : { isEmergency: false, source: "" };
    if (_em.isEmergency || (_ctx && _ctx.skipScheduling === true)) {
      next = "EMERGENCY_DONE";
      try { logDevSms_(phone, "", "EMERGENCY_STAGE_OVERRIDE prev=[SCHEDULE] next=[EMERGENCY_DONE] source=[" + (_em.source || "ctx") + "]"); } catch (_) {}
      try { logDevSms_(phone, "", "EMERGENCY_SKIP_SCHEDULE reason=[emergency_continuation]"); } catch (_) {}
    }
  } catch (_) {}
}

// compute expiry BEFORE any return paths
const expiryMins = (next === "SCHEDULE" || next === "SCHEDULE_PRETICKET") ? 30 : 10;
const pendingExpiresAtIso =
  next ? new Date(Date.now() + expiryMins * 60 * 1000).toISOString() : "";

// DRAFT-ONLY RULE: once an active ticket exists, recompute must NOT destabilize stage ownership.
// For active tickets (pendingRow >= 2), only allow explicit continuation stages to be written.
if (pendingRow >= 2) {
  const contWhitelist = ["UNIT", "SCHEDULE", "DETAIL", "EMERGENCY_DONE"];
  if (!next) {
    try { logDevSms_(phone, "", "EXPECT_RECOMPUTED_NEXT_EMPTY keep_stage current=[" + currentStage + "]"); } catch (_) {}
    return;
  }
  if (contWhitelist.indexOf(String(next).toUpperCase()) === -1) {
    try { logDevSms_(phone, "", "EXPECT_RECOMPUTED_BLOCKED active_ticket next=[" + next + "] current=[" + currentStage + "]"); } catch (_) {}
    try { logInvariantFail_(phone, "", "EXPECT_RECOMPUTED_BLOCKED", "next=" + next + " current=" + currentStage); } catch (_) {}
    return;
  }
}

// Early exit if stage unchanged (keep Session + ctx synced for pre-ticket)
if (next === currentStage) {
  if (pendingRow <= 0 && typeof sessionUpsert_ === "function") {
    sessionUpsert_(phone, {
      stage: next,
      expected: next,
      expiresAtIso: pendingExpiresAtIso
    }, "recomputeDraftExpected_sync");
  }
  if (typeof ctxUpsert_ === "function") {
    ctxUpsert_(phone, {
      pendingExpected: next,
      pendingExpiresAt: pendingExpiresAtIso
    }, "recomputeDraftExpected_sync");
  }
  try {
    logDevSms_(phone, "", "EXPECT_RECOMPUTED_SKIP same_stage=[" + next + "]");
  } catch (_) {}
  return;
}


    if (pendingRow <= 0) {
      if (typeof sessionUpsert_ === "function") {
        sessionUpsert_(phone, {
          stage: next,
          expected: next,
          expiresAtIso: pendingExpiresAtIso
        }, "recomputeDraftExpected_");
      }
      if (typeof ctxUpsert_ === "function") {
        ctxUpsert_(phone, {
          pendingExpected: next,
          pendingExpiresAt: pendingExpiresAtIso
        }, "recomputeDraftExpected_cache");
      }
    } else {
      dalSetPendingStage_(dir, dirRow, next, phone, "recomputeDraftExpected_");
      if (typeof ctxUpsert_ === "function") {
        ctxUpsert_(phone, {
          pendingExpected: next,
          pendingExpiresAt: pendingExpiresAtIso
        }, "recomputeDraftExpected_");
      }
    }
    try {
      logDevSms_(phone, "", "EXPECT_RECOMPUTED expected=[" + next + "] reason=[draft_completeness] issue=[" + issueCountForLog + "] prop=[" + (hasProperty ? "1" : "0") + "] unit=[" + (hasUnit ? "1" : "0") + "] sched=[" + (hasSchedule ? "1" : "0") + "]");
    } catch (_) {}
  } catch (_) {}
}

// ============================================================
// RESOLVE EFFECTIVE TICKET STATE (Propera Compass)
// ===================================================================
// ===== M6 — STATE RESOLVER ==========================================
// @MODULE:M6
// Responsibilities:
// - Determine effectiveStage deterministically
//
// STRICT RULE:
// - READ ONLY
// - NO writes
// - NO replies
// ===================================================================
// Single canonical resolver — called once per inbound after
// compileTurn_ + draftUpsertFromTurn_.
//
// Returns:
//   { stateType: "CONTINUATION" | "DRAFT" | "NEW", stage: string }
// ============================================================
// ===================================================================
// ===== M4 — COMPILER (StructuredSignal + turn-facts projection) =====
// @MODULE:M4
// Responsibilities:
// - Project properaBuildIntakePackage_ / pre-built package into stable turnFacts
// - Attach structuredSignal for brain and commit paths (no re-interpretation here)
//
// Forbidden:
// - Raw-text interpretation
// - Secondary extraction / parallel parsers
// - Sheet writes
// - Routing decisions
// ===================================================================
// CONTEXT COMPILER / CIG context helpers moved to INTAKE_RUNTIME.gs

// ============================================================
// WORKITEM ASSIGNMENT (policy-driven)
// ============================================================

/**
* Resolve WorkItem ownership using PropertyPolicy.
* Phase 1: property default owner only (ASSIGN_DEFAULT_OWNER).
* Later: add rule-sheet matching first, then fall back to this default.
*
* Returns:
*  { ownerType, ownerId, assignedByPolicy, assignedAt }
*/
function resolveWorkItemAssignment_(propCode, ctx) {
  // ctx reserved for future (issueType, locationType, etc.)
  var p = String(propCode || "").trim().toUpperCase() || "GLOBAL";

  // Policy-driven ownerId (no hardcode of people)
  var ownerId = String(ppGet_(p, "ASSIGN_DEFAULT_OWNER", ppGet_("GLOBAL", "ASSIGN_DEFAULT_OWNER", "QUEUE_TRIAGE")) || "")
    .trim()
    .toUpperCase() || "QUEUE_TRIAGE";

  var ownerType = "QUEUE";
  if (ownerId.indexOf("STAFF_") === 0) ownerType = "STAFF";
  else if (ownerId.indexOf("VEND_") === 0) ownerType = "VENDOR";
  else if (ownerId.indexOf("TEAM_") === 0) ownerType = "TEAM";

  var assignedByPolicy = "KV:ASSIGN_DEFAULT_OWNER";
  var assignedAt = new Date();

  // Deterministic audit log (no tenant messaging here); skip if no phone (GSM-safe)
  var phoneForLog = String((ctx && ctx.phoneE164) || "").trim();
  if (phoneForLog) {
    try {
      logDevSms_(phoneForLog, "", "POLICY_ASSIGN ownerType=" + ownerType + " ownerId=" + ownerId + " prop=" + p + " by=" + assignedByPolicy);
    } catch (_) {}
  }

  return { ownerType: ownerType, ownerId: ownerId, assignedByPolicy: assignedByPolicy, assignedAt: assignedAt };
}

/** Resolve display name for Sheet1 AssignedName: from Staff tab (StaffId→StaffName) or Vendors; no hardcoded names. */
function resolveAssigneeDisplayName_(ownerType, ownerId) {
  if (!ownerId) return "";
  var id = String(ownerId || "").trim();
  var type = String(ownerType || "").trim().toUpperCase();
  if (type === "STAFF" && typeof getStaffById_ === "function") {
    try {
      var staff = getStaffById_(id);
      if (staff && staff.name) return String(staff.name).trim();
    } catch (_) {}
    return id;
  }
  if (type === "VENDOR" && typeof getVendorById_ === "function") {
    try {
      var vendor = getVendorById_(id);
      if (vendor && vendor.name) return String(vendor.name).trim();
    } catch (_) {}
    return id;
  }
  return id;
}

/**
 * Create N real tickets from canonical splitIssues[] (shared prop/tenant; per-issue MSG, unit, location).
 * Dedupe: unique THREAD_ID per sibling via inboundKey + |SPLIT|index.
 * Sibling linkage: SERVICE_NOTES JSON { intakeGroupKey, splitIndex, splitCount } + WI metadata.
 */
function finalizeDraftAndCreateSplitTickets_(sheet, dir, dirRow, phone, from, opts, splitIssues, propCode, propName, tenantCanonUnit, buf, issueBufferCountForFinalize, issue, locationTextHint, splitSource) {
  opts = opts || {};
  var sp = PropertiesService.getScriptProperties();
  var now = new Date();
  var intakeGroupKey = (typeof Utilities !== "undefined" && Utilities.getUuid) ? Utilities.getUuid() : ("IGK:" + String(now.getTime()));
  var baseInbound = String(opts.inboundKey || ("DRAFT:" + phone + "|TS:" + now.getTime())).trim();
  var n = splitIssues.length;
  try { logDevSms_(phone, "", "MULTI_ISSUE_SPLIT_COMMIT start groupKey=" + intakeGroupKey.slice(0, 8) + " n=" + n + " src=" + String(splitSource || "")); } catch (_) {}

  var preSchedRawFinalize = "";
  if (opts.multiScheduleCaptured && opts.capturedScheduleLabel) {
    preSchedRawFinalize = String(opts.capturedScheduleLabel || "").trim();
  }
  if (!preSchedRawFinalize && typeof DIR_COL !== "undefined" && dir && dirRow >= 2) {
    try {
      preSchedRawFinalize = String(dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).getValue() || "").trim();
    } catch (_) {}
  }
  if (preSchedRawFinalize && typeof schedPolicyRecheckWindowFromText_ === "function") {
    var _polFinS = schedPolicyRecheckWindowFromText_(phone, String(propCode || "").trim().toUpperCase() || "GLOBAL", preSchedRawFinalize, new Date());
    if (_polFinS && !_polFinS.ok) {
      try { logDevSms_(phone, "", "SCHED_POLICY_RECHECK_BLOCK split_finalize reason=" + String((_polFinS.verdict && _polFinS.verdict.key) || "")); } catch (_) {}
      return {
        ok: false,
        reason: "SCHEDULE_POLICY_BLOCK",
        policyKey: (_polFinS.verdict && _polFinS.verdict.key) || "",
        policyVars: (_polFinS.verdict && _polFinS.verdict.vars) || {}
      };
    }
  }
  try {
    logDevSms_(phone, "", "SPLIT_FINALIZE_PAST_POLICY n=" + n + " schedRaw=[" + String(preSchedRawFinalize || "").slice(0, 60) + "]");
  } catch (_) {}

  var createdRows = [];
  var ticketIds = [];
  var workItemIds = [];
  var anyEmergency = false;
  var emergencyTypeLatch = "EMERGENCY";
  var ticketsOut = [];

  var asn = null;
  var _srPatch = null;
  try {
    if (typeof srBuildWorkItemOwnerPatch_ === "function") {
      _srPatch = srBuildWorkItemOwnerPatch_({ propertyId: propCode, domain: "MAINTENANCE" });
    }
  } catch (_) {}
  if (_srPatch && _srPatch.ownerType) {
    asn = {
      ownerType: _srPatch.ownerType,
      ownerId: _srPatch.ownerId,
      assignedByPolicy: _srPatch.assignedByPolicy,
      assignedAt: _srPatch.assignedAt
    };
  } else {
    try {
      asn = resolveWorkItemAssignment_(propCode, { phoneE164: phone });
    } catch (_) {
      asn = { ownerType: "QUEUE", ownerId: "QUEUE_TRIAGE", assignedByPolicy: "ERR:FALLBACK", assignedAt: new Date() };
    }
  }

  for (var ti = 0; ti < n; ti++) {
    var si = splitIssues[ti];
    if (!si) continue;
    var msg = String(si.normalizedTitle || si.rawText || "").trim();
    if (!msg) continue;
    var uRow = si.inUnit ? String(tenantCanonUnit || "").trim() : "";
    var ltRow = String(si.locationType || "UNIT").toUpperCase();
    if (ltRow !== "UNIT" && ltRow !== "COMMON_AREA") ltRow = "UNIT";
    if (typeof properaNormalizeLocationTypeForTicket_ === "function") {
      ltRow = properaNormalizeLocationTypeForTicket_(ltRow);
    }
    if (ltRow !== "UNIT" && ltRow !== "COMMON_AREA") ltRow = "UNIT";
    if (ltRow === "COMMON_AREA") uRow = "";

    var skid = String(ti);
    try {
      if (typeof issueTextKey_ === "function") skid = String(issueTextKey_(msg) || String(ti)).replace(/[^\w\-]+/g, "_").slice(0, 48) || String(ti);
    } catch (_) {}
    var inboundKeySplit = baseInbound + "|SPLIT|" + ti + "|" + skid;

    var piUrg = String(si.urgency || "normal").toLowerCase();
    var parsedIssueForGate = {
      category: String(si.category || "").trim(),
      urgency: (piUrg === "urgent" || piUrg === "high") ? "Urgent" : "Normal"
    };

    var firstUrl = "";
    var firstCt = "";
    var firstSrc = "";
    var attFacts = null;
    if (ti === 0) {
      firstUrl = String(opts.firstMediaUrl || "").trim();
      firstCt = String(opts.firstMediaContentType || "").trim();
      firstSrc = String(opts.firstMediaSource || "").trim();
      var mediaTypeForAttach = String(opts.mediaType || "").trim();
      var mediaCategoryHintForAttach = String(opts.mediaCategoryHint || "").trim();
      var mediaSubcategoryHintForAttach = String(opts.mediaSubcategoryHint || "").trim();
      var mediaUnitHintForAttach = String(opts.mediaUnitHint || "").trim();
      if (mediaTypeForAttach || mediaCategoryHintForAttach || mediaSubcategoryHintForAttach || mediaUnitHintForAttach) {
        attFacts = {
          mediaType: mediaTypeForAttach,
          issueHints: { category: mediaCategoryHintForAttach, subcategory: mediaSubcategoryHintForAttach },
          unitHint: mediaUnitHintForAttach
        };
      }
    }

    var ticket = processTicket_(sheet, sp, {
      OPENAI_API_KEY: opts.OPENAI_API_KEY || String(sp.getProperty("OPENAI_API_KEY") || ""),
      TWILIO_SID: opts.TWILIO_SID || String(sp.getProperty("TWILIO_SID") || ""),
      TWILIO_TOKEN: opts.TWILIO_TOKEN || String(sp.getProperty("TWILIO_TOKEN") || ""),
      TWILIO_NUMBER: opts.TWILIO_NUMBER || String(sp.getProperty("TWILIO_NUMBER") || ""),
      ONCALL_NUMBER: opts.ONCALL_NUMBER || String(sp.getProperty("ONCALL_NUMBER") || "")
    }, {
      from: phone,
      tenantPhone: phone,
      propertyName: propName,
      propertyCode: propCode,
      unitFromText: uRow,
      messageRaw: msg,
      createdByManager: !!opts.createdByManager,
      inboundKey: inboundKeySplit,
      parsedIssue: parsedIssueForGate,
      locationType: ltRow,
      firstMediaUrl: firstUrl,
      firstMediaContentType: firstCt,
      firstMediaSource: firstSrc,
      attachmentMediaFacts: attFacts
    });

    var rawRow = ticket != null ? (ticket.rowIndex != null ? ticket.rowIndex : ticket.row) : undefined;
    var loggedRow = parseInt(String(rawRow || "").trim(), 10) || 0;
    if (!loggedRow || loggedRow < 2) {
      try { logDevSms_(phone, msg, "MULTI_ISSUE_SPLIT_TICKET_FAIL idx=" + (ti + 1) + "/" + n); } catch (_) {}
      return { ok: false, reason: "ROW_ERR_SPLIT", splitIndexFailed: ti };
    }

    var ticketId = String(ticket && ticket.ticketId ? ticket.ticketId : "").trim();
    try { logDevSms_(phone, "", "MULTI_ISSUE_TICKET_CREATED idx=" + (ti + 1) + "/" + n + " ticketId=" + ticketId + " row=" + loggedRow); } catch (_) {}
    try { logDevSms_(phone, "", "SPLIT_GROUP_CREATED splitIndex=" + (ti + 1) + "/" + n + " ticketId=[" + ticketId + "] row=[" + loggedRow + "] msg=[" + String(msg || "").slice(0, 80) + "]"); } catch (_) {}

    try {
      if (typeof COL !== "undefined" && COL.SERVICE_NOTES) {
        var snObj = { intakeGroupKey: intakeGroupKey, splitIndex: ti + 1, splitCount: n, parentInboundKey: baseInbound, splitSource: String(splitSource || "") };
        sheet.getRange(loggedRow, COL.SERVICE_NOTES).setValue(JSON.stringify(snObj));
      }
    } catch (_) {}

    if (preSchedRawFinalize || (opts.multiScheduleCaptured && opts.capturedScheduleLabel)) {
      var lab = String(opts.capturedScheduleLabel || preSchedRawFinalize || "").trim();
      if (lab) {
        try {
          withWriteLock_("SPLIT_SCHEDULE_APPLY", function () {
            sheet.getRange(loggedRow, COL.PREF_WINDOW).setValue(lab);
            sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(now);
          });
        } catch (_) {}
        try {
          syncScheduledEndAtFromRawWindow_(sheet, loggedRow, lab);
        } catch (_) {}
      }
    }

    var isEm = !!(ticket && ticket.classification && ticket.classification.emergency);
    if (isEm) {
      anyEmergency = true;
      emergencyTypeLatch = (ticket.classification.emergencyType) ? String(ticket.classification.emergencyType).trim() : "EMERGENCY";
      try {
        if (typeof latchEmergency_ === "function") latchEmergency_(sheet, loggedRow, phone, emergencyTypeLatch);
      } catch (_) {}
    }

    try {
      if (typeof enqueueAiEnrichment_ === "function") enqueueAiEnrichment_(ticketId, propCode, propName, uRow, phone, msg);
    } catch (_) {}

    var postCreateScheduledEndAt = null;
    try {
      var _finalSchedLabel = String(sheet.getRange(loggedRow, COL.PREF_WINDOW).getValue() || "").trim();
      if (_finalSchedLabel && typeof parsePreferredWindowShared_ === "function") {
        var _schedParsed = parsePreferredWindowShared_(_finalSchedLabel, null);
        if (_schedParsed && _schedParsed.end instanceof Date && isFinite(_schedParsed.end.getTime())) {
          postCreateScheduledEndAt = _schedParsed.end;
        }
      }
    } catch (_) {}

    var createdWi = "";
    try {
      createdWi = workItemCreate_({
        type: "MAINT",
        status: "OPEN",
        state: "STAFF_TRIAGE",
        substate: "",
        phoneE164: phone,
        propertyId: propCode,
        unitId: uRow,
        ticketRow: loggedRow,
        ticketKey: (ticket && ticket.ticketKey) ? String(ticket.ticketKey).trim() : "",
        metadataJson: JSON.stringify({
          source: opts.createdByManager ? "MGR_DRAFT" : "DRAFT",
          inboundKey: inboundKeySplit,
          intakeGroupKey: intakeGroupKey,
          splitIndex: ti + 1,
          splitCount: n,
          parentInboundKey: baseInbound
        }),
        ownerType: (asn && asn.ownerType) || "",
        ownerId: (asn && asn.ownerId) || "",
        assignedByPolicy: (asn && asn.assignedByPolicy) || "",
        assignedAt: (asn && asn.assignedAt) || ""
      });
    } catch (errWi) {
      try { logDevSms_(phone, msg, "FINALIZE_SPLIT_WI_ERR " + String(errWi && errWi.message ? errWi.message : errWi)); } catch (_) {}
    }

    var wiCached = null;
    try { wiCached = (typeof workItemGetById_ === "function" && createdWi) ? workItemGetById_(createdWi) : null; } catch (_) {}

    try {
      if (createdWi && _srPatch && _srPatch._resolverResult && typeof srLogAssignmentEvent_ === "function") {
        srLogAssignmentEvent_(createdWi, _srPatch._resolverResult);
      }
    } catch (_) {}

    if (isEm && createdWi && typeof workItemUpdate_ === "function") {
      try {
        workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" });
      } catch (_) {}
    }

    var pol = { ackOwned: false, ackSent: false, ruleId: "" };
    try {
      if (createdWi && typeof maybePolicyRun_ === "function") {
        var wiForPolicy = wiCached || {
          workItemId: createdWi,
          state: "STAFF_TRIAGE",
          substate: "",
          phoneE164: phone,
          propertyId: propCode,
          unitId: uRow,
          ticketRow: loggedRow,
          ownerType: (asn && asn.ownerType) || "",
          ownerId: (asn && asn.ownerId) || "",
          createdAt: new Date()
        };
        if (ticket && ticket.classification && typeof ticket.classification.category === "string") {
          wiForPolicy.categoryFromTicket = String(ticket.classification.category).trim().toLowerCase();
        }
        var policyResult = maybePolicyRun_("WORKITEM_CREATED", { phoneE164: phone, lang: "en" }, wiForPolicy, propCode);
        if (policyResult && typeof policyResult === "object") {
          pol.ackOwned = !!policyResult.ackOwned;
          pol.ackSent = !!policyResult.ackSent;
          pol.ruleId = String(policyResult.ruleId || "");
        }
      }
    } catch (_) {}

    if (isEm && createdWi && typeof workItemUpdate_ === "function") {
      try { workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" }); } catch (_) {}
    }

    try {
      if (createdWi && loggedRow >= 2 && sheet && typeof COL !== "undefined" && asn) {
        var aType = String((asn.ownerType) || "").trim();
        if (aType === "STAFF" || aType === "VENDOR") {
          var assigneeName = (typeof resolveAssigneeDisplayName_ === "function") ? resolveAssigneeDisplayName_(aType, asn.ownerId) : String(asn.ownerId || "");
          var aAt = asn.assignedAt instanceof Date ? asn.assignedAt : (asn.assignedAt ? new Date(asn.assignedAt) : new Date());
          var aBy = String(asn.assignedByPolicy || "KV:ASSIGN_DEFAULT_OWNER").trim();
          var oId = String(asn.ownerId || "").trim();
          if (COL.ASSIGNED_TO) sheet.getRange(loggedRow, COL.ASSIGNED_TO, 1, 1).setValues([[assigneeName]]);
          if (COL.ASSIGNED_TYPE && COL.ASSIGNED_ID && COL.ASSIGNED_NAME && COL.ASSIGNED_AT && COL.ASSIGNED_BY) {
            sheet.getRange(loggedRow, COL.ASSIGNED_TYPE, 1, 5).setValues([[aType, oId, assigneeName, aAt, aBy]]);
          }
        }
      }
    } catch (_) {}

    if (createdWi && asn && asn.ownerId && !isEm) {
      try {
        var hasSched = false;
        var resolvedScheduledEndAt = null;
        if (postCreateScheduledEndAt instanceof Date && isFinite(postCreateScheduledEndAt.getTime())) {
          resolvedScheduledEndAt = postCreateScheduledEndAt;
          hasSched = true;
        }
        var wiNow = (typeof workItemGetById_ === "function") ? workItemGetById_(createdWi) : wiCached;
        var wiStateNow = wiNow ? String(wiNow.state || "").trim().toUpperCase() : "";
        var wiStatusNow = wiNow ? String(wiNow.status || "").trim().toUpperCase() : "";
        var isTerminalNow = (wiStateNow === "DONE" || wiStateNow === "COMPLETED" || wiStatusNow === "COMPLETED");
        if (hasSched && resolvedScheduledEndAt && !isTerminalNow) {
          if (wiStateNow !== "ACTIVE_WORK") {
            try {
              workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "" });
              if (typeof onWorkItemActiveWork_ === "function") {
                onWorkItemActiveWork_(createdWi, propCode, { scheduledEndAt: resolvedScheduledEndAt });
              }
            } catch (_) {}
          }
        } else if (!hasSched && typeof onWorkItemCreatedUnscheduled_ === "function" && !isTerminalNow) {
          try { onWorkItemCreatedUnscheduled_(createdWi, propCode); } catch (_) {}
        }
      } catch (_) {}
    }

    createdRows.push(loggedRow);
    ticketIds.push(ticketId);
    workItemIds.push(createdWi || "");
    ticketsOut.push(ticket);
  }

  if (!createdRows.length) {
    return { ok: false, reason: "SPLIT_NO_ROWS" };
  }

  var firstRow = createdRows[0];
  var firstTicketId = ticketIds[0] || "";
  var firstWi = workItemIds[0] || "";
  var nextStage = "";
  if (anyEmergency) {
    nextStage = "EMERGENCY_DONE";
  } else {
    var anyInUnit = false;
    for (var aj = 0; aj < splitIssues.length; aj++) {
      if (splitIssues[aj] && splitIssues[aj].inUnit) { anyInUnit = true; break; }
    }
    nextStage = anyInUnit ? "SCHEDULE" : "";
  }

  dalWithLock_("FINALIZE_DIR_SET_PTR_SPLIT", function () {
    var lastDirCol = typeof DIR_COL !== "undefined" ? DIR_COL.UNIT : 14;
    var row = dir.getRange(dirRow, 1, 1, lastDirCol).getValues()[0];
    if (!row || row.length < lastDirCol) row = [];
    while (row.length < lastDirCol) row.push("");
    var idx = function (c) { return (c >= 1 && c <= row.length) ? c - 1 : -1; };
    if (idx(DIR_COL.LAST_UPDATED) >= 0) row[idx(DIR_COL.LAST_UPDATED)] = now;
    if (firstRow >= 2 && idx(DIR_COL.PENDING_ISSUE) >= 0) row[idx(DIR_COL.PENDING_ISSUE)] = "";
    if (idx(DIR_COL.PENDING_UNIT) >= 0) row[idx(DIR_COL.PENDING_UNIT)] = "";
    if (idx(DIR_COL.PENDING_ROW) >= 0) row[idx(DIR_COL.PENDING_ROW)] = firstRow;
    if (idx(DIR_COL.PENDING_STAGE) >= 0) row[idx(DIR_COL.PENDING_STAGE)] = String(nextStage || "").trim();
    if (idx(DIR_COL.ISSUE_BUF_JSON) >= 0) row[idx(DIR_COL.ISSUE_BUF_JSON)] = "[]";
    if (!(opts && opts.createdByManager) && tenantCanonUnit && !isInvalidUnit_(tenantCanonUnit)) {
      var curCanon = idx(DIR_COL.UNIT) >= 0 ? String(row[idx(DIR_COL.UNIT)] || "").trim() : "";
      if (!curCanon && idx(DIR_COL.UNIT) >= 0) {
        row[idx(DIR_COL.UNIT)] = String(tenantCanonUnit).trim();
      }
    }
    dir.getRange(dirRow, 1, 1, lastDirCol).setValues([row]);
  });

  try {
    if (typeof sessionUpsert_ === "function") {
      sessionUpsert_(phone, {
        activeArtifactKey: firstTicketId || ("ROW:" + firstRow),
        draftIssue: "",
        issueBufJson: "[]",
        draftScheduleRaw: "",
        stage: "",
        expected: "",
        expiresAtIso: ""
      }, "finalize_session_close_split");
    }
  } catch (_) {}

  var splitRowsJson = (nextStage === "SCHEDULE" && n >= 2) ? JSON.stringify(createdRows) : "";
  try {
    if (splitRowsJson) {
      CacheService.getScriptCache().put("SPLIT_BUNDLE_ROWS_" + String(phone), splitRowsJson, 1800);
    }
  } catch (_) {}
  try {
    ctxUpsert_(phone, {
      activeWorkItemId: firstWi || "",
      pendingWorkItemId: firstWi || "",
      pendingExpected: nextStage,
      pendingExpiresAt: new Date(Date.now() + (nextStage === "SCHEDULE" ? 30 : 10) * 60 * 1000),
      lastIntent: "MAINT"
    }, "FINALIZE_DRAFT_SPLIT");
  } catch (_) {}

  var itemsText = splitIssues.map(function (it, idx) {
    var t = String(it && it.normalizedTitle ? it.normalizedTitle : "").trim().slice(0, 80);
    return t ? ((idx + 1) + ") " + t + " — " + String(ticketIds[idx] || "")) : "";
  }).filter(Boolean).join("\n");

  try { logDevSms_(phone, "", "MULTI_ISSUE_OUTBOUND_SENT count=" + n + " firstTid=" + firstTicketId); } catch (_) {}
  try { logDevSms_(phone, issue, "FINALIZE_SPLIT_OK rows=" + createdRows.join(",") + " n=" + n); } catch (_) {}

  return {
    ok: true,
    loggedRow: firstRow,
    ticketId: firstTicketId,
    createdWi: firstWi,
    nextStage: nextStage,
    splitTicketCommit: true,
    splitCount: n,
    ticketIds: ticketIds,
    createdRows: createdRows,
    workItemIds: workItemIds,
    itemsText: itemsText,
    intakeGroupKey: intakeGroupKey,
    issueBufferCount: issueBufferCountForFinalize,
    ticket: ticketsOut[0],
    ackOwnedByPolicy: false,
    policyRuleId: "",
    ownerType: (asn && asn.ownerType) ? String(asn.ownerType) : "",
    ownerId: (asn && asn.ownerId) ? String(asn.ownerId) : ""
  };
}

// ============================================================
// FINALIZE DRAFT AND CREATE TICKET (Propera Compass)
// Single canonical ticket creator. Called only when
// draftDecideNextStage_ returns "READY".
//
// IMPORTANT — phone/from rule:
//   Always pass TENANT phone as both `phone` and `from`.
//
// Returns: { ok, loggedRow, ticketId, createdWi, nextStage, reason?, ticket? }
// ============================================================
function finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phone, from, opts) {
  opts = opts || {};
  var locationScopeMixedFlag = false;
  var __finalizeT0 = Date.now();
  var __finalizeAdapter = (typeof globalThis !== "undefined" && globalThis.__traceAdapter) ? String(globalThis.__traceAdapter).trim() : "";
  var __finalizeTraceId = (typeof globalThis !== "undefined" && globalThis.__traceId) ? String(globalThis.__traceId).trim() : "";
  var locationTextHint = String(opts.locationText || "").trim();

  var existingPendingRow = dalGetPendingRow_(dir, dirRow);
  var existingStage = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();

  // ── Guard: never finalize when a ticket row already exists (idempotency) ──
  // Exception: Portal/PM (createdByManager) may create another ticket for the same tenant (e.g. second issue).
  if (existingPendingRow >= 2 && !opts.createdByManager) {
    try { logDevSms_(phone, "", "FINALIZE_DRAFT_BLOCKED row=[" + existingPendingRow + "] stage=[" + existingStage + "]"); } catch (_) {}
    try { logInvariantFail_(phone, "", "NO_NEW_TICKET_WHEN_PENDINGROW", "row=" + existingPendingRow + " stage=" + existingStage); } catch (_) {}
    return { ok: false, reason: "ACTIVE_TICKET_EXISTS" };
  }

  var propCol = dalGetPendingProperty_(dir, dirRow);
  var propCode = propCol.code;
  var propName = propCol.name;
  var pendingUnit = dalGetPendingUnit_(dir, dirRow);
  var canonUnit   = dalGetUnit_(dir, dirRow);
  var unit        = String((pendingUnit || canonUnit) || "").trim();
  var issue    = dalGetPendingIssue_(dir, dirRow);
  var issueSource = "pending";
  var buf      = (typeof getIssueBuffer_ === "function") ? getIssueBuffer_(dir, dirRow) : [];
  if (existingPendingRow < 2 && typeof sessionGet_ === "function") {
    try {
      var _finSess = sessionGet_(phone);
      if (_finSess) {
        if (_finSess.draftIssue) { issue = String(_finSess.draftIssue || "").trim(); issueSource = "session"; }
        if (_finSess.issueBuf && _finSess.issueBuf.length) {
          var dirBufLen = (buf && buf.length) || 0;
          if (dirBufLen < _finSess.issueBuf.length) buf = _finSess.issueBuf;
        }
        if (_finSess.draftProperty && !propCode) propCode = String(_finSess.draftProperty || "").trim();
        if (_finSess.draftUnit && !unit) unit = String(_finSess.draftUnit || "").trim();
      }
    } catch (_) {}
  }
  const hasIssue = Boolean(issue) || (buf && buf.length >= 1);
  // Canonical multi-issue count for downstream SMS (e.g. MULTI_CREATED_CONFIRM): same merge as ticket body,
  // not the pre-finalize dir/session snapshot in SCHEDULE_DRAFT_MULTI (session can shrink while sheet still has 2).
  var issueBufferCountForFinalize = (buf && buf.length) ? buf.length : (String(issue || "").trim() ? 1 : 0);

  if (buf && buf.length >= 1) {
    try { logDevSms_(phone, "", "ISSUEBUF_COUNT n=" + buf.length + " reason=[finalize]"); } catch (_) {}
  }

  if (!propCode || !hasIssue) {
    try { logDevSms_(phone, "", "FINALIZE_DRAFT_SKIP propCode=[" + propCode + "] issue=[" + issue + "] bufLen=" + (buf ? buf.length : 0)); } catch (_) {}
    return { ok: false, reason: "MISSING_FIELDS" };
  }

  var issueForTicket = "";
  var compiledLocType = String(opts.locationType || "UNIT").toUpperCase();
  if (typeof properaNormalizeLocationTypeForTicket_ === "function") {
    compiledLocType = properaNormalizeLocationTypeForTicket_(compiledLocType);
  }
  if (compiledLocType !== "UNIT" && compiledLocType !== "COMMON_AREA") compiledLocType = "UNIT";

  // ── Multi-issue → multi-ticket: StructuredSignal.issues only (no commit-time re-parse) ──
  var splitPackCtx = Object.assign({}, opts || {}, {
    pendingPropertyCode: propCode,
    pendingPropertyName: propName,
    pendingUnit: unit
  });
  var splitPack = (typeof properaCommitIssuesFromPackage_ === "function")
    ? properaCommitIssuesFromPackage_(splitPackCtx, phone)
    : { issues: [], source: "" };

  // Never trust intake-only ticketGroupsPreview alone: it can be stale (e.g. last append atom
  // only) while dir/session issueBuf and merged draft still carry multiple distinct problems.
  var _recon = reconcileTicketGroupsForFinalize_(phone, buf, splitPack, issue);
  var ticketGroupsPreview = (_recon && Array.isArray(_recon.ticketGroupsPreview)) ? _recon.ticketGroupsPreview : [];
  var splitDecisionSource = (_recon && _recon.splitDecisionSource) ? String(_recon.splitDecisionSource) : "finalize_reconciled";

  var groupCount = ticketGroupsPreview.length;
  if (groupCount >= 2) {
    // Critical rule: split decision is based on ticket groups, not issue clauses.
    var splitIssues = buildSplitIssuesFromTicketGroupsPreview_(ticketGroupsPreview);
    issueBufferCountForFinalize = groupCount;

    var needUnitSplit = false;
    for (var _sxi = 0; _sxi < splitIssues.length; _sxi++) {
      if (splitIssues[_sxi] && splitIssues[_sxi].inUnit) { needUnitSplit = true; break; }
    }
    if (needUnitSplit && !String(unit || "").trim()) {
      try { logDevSms_(phone, "", "MULTI_ISSUE_SPLIT_ABORT reason=MISSING_UNIT"); } catch (_) {}
      return { ok: false, reason: "MISSING_UNIT_FOR_SPLIT" };
    }

    try { logDevSms_(phone, "", "SPLIT_DECISION groupCount=" + String(groupCount) + " source=[" + String(splitDecisionSource) + "]"); } catch (_) {}
    try { logDevSms_(phone, "", "SPLIT_DECISION_SOURCE source=[" + String(splitDecisionSource) + "]"); } catch (_) {}

    var splitRes = finalizeDraftAndCreateSplitTickets_(sheet, dir, dirRow, phone, from, opts, splitIssues, propCode, propName, unit, buf, issueBufferCountForFinalize, issue, locationTextHint, splitDecisionSource);
    try {
      if (splitRes && splitRes.ok) canonicalSplitPreviewClear_(phone, "FINALIZE_DRAFT_SPLIT_CLEAR");
    } catch (_) {}
    return splitRes;
  }

  // Single group: use canonical group text as the deterministic ticket issue message.
  if (groupCount === 1 && ticketGroupsPreview[0]) {
    issueForTicket = String(ticketGroupsPreview[0].groupMessageRaw || ticketGroupsPreview[0].groupTitle || "").trim();
  }

  // Legacy merge: portal/manager or schedule-captured path with multiple buffer rows but single canonical issue
  if (!issueForTicket && buf && buf.length >= 2 && opts && (opts.createdByManager === true || (opts.multiScheduleCaptured === true && opts.capturedScheduleLabel))) {
    issueForTicket = mergedIssueFromBuffer_(issue, buf, 900);
  }
  if (!issueForTicket) {
    issueForTicket = String(issue || "").trim() || ((buf && buf.length >= 1 && buf[0] && buf[0].rawText) ? String(buf[0].rawText).trim() : "");
  }
  var usedSource = String(issue || "").trim() ? issueSource : "buf";
  try { logDevSms_(phone, "", "ISSUE_FOR_TICKET source=[" + usedSource + "]"); } catch (_) {}

  // Enrich single-issue ticket MSG with details if available (keeps title clean)
  if (buf && buf.length === 1 && buf[0] && buf[0].details) {
    var det = String(buf[0].details || "").trim();
    if (det) {
      // Keep deterministic length
      if (det.length > 450) det = det.slice(0, 450);
      issueForTicket = issueForTicket + "\n\nDetails: " + det;
    }
  }
  if (!issueForTicket) issueForTicket = String(issue || "").trim();

  var locType = compiledLocType;
  try { logDevSms_(phone, "", "LOC_TYPE opener=[" + locType + "]"); } catch (_) {}

  // Mixed scope: classify merged ticket text (what we write to MSG). Raw SMS in locationTextHint lacks "Additional items:" and caused bogus spans + duplicate "Common area (also reported):" in Sheet1/AppSheet.
  var mixedScopeInput = String(issueForTicket || "").trim() || String(locationTextHint || "").trim();
  var mixedScope = (typeof inferLocationMixedScope_ === "function") ? inferLocationMixedScope_(mixedScopeInput) : { isMixed: false };
  if (mixedScope && mixedScope.isMixed) {
    locType = "UNIT";
    locationScopeMixedFlag = true;
    try { logDevSms_(phone, "", "LOC_TYPE_MIXED_SCOPE thread=UNIT commonParts=" + (mixedScope.commonAreaSpans ? mixedScope.commonAreaSpans.length : 0) + " unitParts=" + (mixedScope.unitSpans ? mixedScope.unitSpans.length : 0)); } catch (_) {}
  }

  if (locType === "COMMON_AREA") {
    unit = ""; // do not store unit on common-area ticket
  }

  // ── Schedule policy recheck before ticket row (stored/captured window may predate this turn) ──
  var preSchedRawFinalize = "";
  if (opts && opts.multiScheduleCaptured && opts.capturedScheduleLabel) {
    preSchedRawFinalize = String(opts.capturedScheduleLabel || "").trim();
  }
  if (!preSchedRawFinalize && typeof DIR_COL !== "undefined" && dir && dirRow >= 2) {
    try {
      preSchedRawFinalize = String(dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).getValue() || "").trim();
    } catch (_) {}
  }
  if (preSchedRawFinalize && typeof schedPolicyRecheckWindowFromText_ === "function") {
    var _polFin = { ok: true, verdict: { ok: true } };
    try {
      _polFin = schedPolicyRecheckWindowFromText_(phone, String(propCode || "").trim().toUpperCase() || "GLOBAL", preSchedRawFinalize, new Date());
    } catch (recEx) {
      try {
        logDevSms_(phone, "", "SCHED_POLICY_RECHECK_CALL_ERR finalize_pre_ticket err=[" + String(recEx && recEx.message ? recEx.message : recEx).slice(0, 220) + "]");
      } catch (_) {}
      _polFin = { ok: true, verdict: { ok: true } };
    }
    if (_polFin && !_polFin.ok) {
      try { logDevSms_(phone, "", "SCHED_POLICY_RECHECK_BLOCK finalize_pre_ticket reason=" + String((_polFin.verdict && _polFin.verdict.key) || "") + " raw=[" + preSchedRawFinalize.slice(0, 80) + "]"); } catch (_) {}
      return {
        ok: false,
        reason: "SCHEDULE_POLICY_BLOCK",
        policyKey: (_polFin.verdict && _polFin.verdict.key) || "",
        policyVars: (_polFin.verdict && _polFin.verdict.vars) || {}
      };
    }
    try { logDevSms_(phone, "", "SCHED_POLICY_RECHECK_PASS finalize_pre_ticket prop=" + String(propCode || "").trim()); } catch (_) {}
  }

  // ── Create ticket row via canonical processTicket_() ──
  const sp = PropertiesService.getScriptProperties();
  var parsedIssueForGate = undefined;
  // Prefer caller/portal category when provided (fixes wrong CAT when form sends category or we skip LLM)
  if (opts.parsedIssue) {
    var pi = opts.parsedIssue;
    var piCat = (pi.category != null && pi.category !== undefined) ? String(pi.category).trim() : "";
    var piUrg = (pi.urgency != null && pi.urgency !== undefined) ? String(pi.urgency).trim() : "";
    if (piCat || piUrg) {
      if (!parsedIssueForGate) parsedIssueForGate = { category: "", urgency: "Normal" };
      if (piCat) parsedIssueForGate.category = piCat;
      if (piUrg) parsedIssueForGate.urgency = (piUrg.toUpperCase() === "URGENT" || piUrg.toLowerCase() === "high") ? "Urgent" : "Normal";
    }
  }
  // Propera Compass — Image Signal Adapter (Phase 1): optional first media URL for ticket attachment column
  var firstMediaUrl = String(opts.firstMediaUrl || "").trim() || (Array.isArray(opts.mediaUrls) && opts.mediaUrls[0] ? String(opts.mediaUrls[0]).trim() : "");
  var firstMediaContentType = String(opts.firstMediaContentType || "").trim();
  var firstMediaSource = String(opts.firstMediaSource || "").trim();
  // Optional compact media facts for attachment naming (Phase 1).
  var mediaTypeForAttach = String(opts.mediaType || "").trim();
  var mediaCategoryHintForAttach = String(opts.mediaCategoryHint || "").trim();
  var mediaSubcategoryHintForAttach = String(opts.mediaSubcategoryHint || "").trim();
  var mediaUnitHintForAttach = String(opts.mediaUnitHint || "").trim();
  var attachmentMediaFacts = null;
  if (mediaTypeForAttach || mediaCategoryHintForAttach || mediaSubcategoryHintForAttach || mediaUnitHintForAttach) {
    attachmentMediaFacts = {
      mediaType: mediaTypeForAttach,
      issueHints: {
        category: mediaCategoryHintForAttach,
        subcategory: mediaSubcategoryHintForAttach
      },
      unitHint: mediaUnitHintForAttach
    };
  }

  var ticket = null;
  try {
    ticket = processTicket_(sheet, sp, {
      OPENAI_API_KEY: opts.OPENAI_API_KEY || String(sp.getProperty("OPENAI_API_KEY") || ""),
      TWILIO_SID:     opts.TWILIO_SID     || String(sp.getProperty("TWILIO_SID")     || ""),
      TWILIO_TOKEN:   opts.TWILIO_TOKEN   || String(sp.getProperty("TWILIO_TOKEN")   || ""),
      TWILIO_NUMBER:  opts.TWILIO_NUMBER  || String(sp.getProperty("TWILIO_NUMBER")  || ""),
      ONCALL_NUMBER:  opts.ONCALL_NUMBER  || String(sp.getProperty("ONCALL_NUMBER")  || "")
    }, {
      from:             phone,
      tenantPhone:      phone,
      propertyName:     propName,
      propertyCode:     propCode,
      unitFromText:     unit,
      messageRaw:       issueForTicket,
      createdByManager: !!(opts.createdByManager),
      inboundKey:       opts.inboundKey || ("DRAFT:" + phone + "|TS:" + Date.now()),
      parsedIssue:         parsedIssueForGate,
      locationType:        locType,
      firstMediaUrl:       firstMediaUrl,
      firstMediaContentType: firstMediaContentType,
      firstMediaSource:    firstMediaSource,
      attachmentMediaFacts: attachmentMediaFacts
    });
  } catch (ptEx) {
    try {
      logDevSms_(phone, issue, "FINALIZE_DRAFT_PROCESS_TICKET_EX err=[" + String(ptEx && ptEx.message ? ptEx.message : ptEx).slice(0, 240) + "]");
    } catch (_) {}
    return { ok: false, reason: "ROW_ERR" };
  }

  var rawRow = ticket != null ? (ticket.rowIndex != null ? ticket.rowIndex : ticket.row) : undefined;
  var loggedRow = parseInt(String(rawRow || "").trim(), 10) || 0;
  if (!loggedRow || loggedRow < 2) {
    try { logDevSms_(phone, issue, "FINALIZE_DRAFT_ROW_ERR " + JSON.stringify(ticket || {})); } catch (_) {}
    return { ok: false, reason: "ROW_ERR" };
  }

  const ticketId  = String(ticket && ticket.ticketId ? ticket.ticketId : "").trim();
  // GUARD: Emergency must never result in SCHEDULE or tenant receiving scheduling SMS.
  // --- MULTI SCHEDULE OVERRIDE (SCHEDULE_DRAFT_MULTI path) ---
  let nextStage = "";
  var isEmergencyTicket = !!(ticket && ticket.classification && ticket.classification.emergency);
  var emergencyTypeForLatch = (ticket && ticket.classification && ticket.classification.emergencyType) ? String(ticket.classification.emergencyType).trim() : "EMERGENCY";

  if (isEmergencyTicket) {
    nextStage = "EMERGENCY_DONE";
    try { logDevSms_(phone, "", "EMERGENCY_LATCH_START type=[" + emergencyTypeForLatch + "] nextStage=EMERGENCY_DONE"); } catch (_) {}
  } else if (locType === "COMMON_AREA") {
    nextStage = "";
  } else {
    nextStage = unit ? "SCHEDULE" : "UNIT";
  }
  if (!isEmergencyTicket && opts && opts.multiScheduleCaptured === true && opts.capturedScheduleLabel) {
    if (nextStage === "SCHEDULE") {
      try { logDevSms_(phone, "", "SDM_GUARD_BLOCKED_REOPEN_SCHEDULE"); } catch (_) {}
      nextStage = "";
    }
  }
  const now       = new Date();

  // ── Write state BEFORE any SMS (crash-resilient) — single lock; one read + one write for Directory row (batched) ──
  dalWithLock_("FINALIZE_DIR_SET_PTR", function () {
    if (loggedRow >= 2) {
      try { logDevSms_(phone, issue, "ISSUE_WRITE site=[finalizeDraftAndCreateTicket_] val=[CLEAR_POST_COMMIT]"); } catch (_) {}
    } else {
      try { logDevSms_(phone, issue, "ISSUE_WRITE_SKIP site=[finalizeDraftAndCreateTicket_] reason=[loggedRow<2]"); } catch (_) {}
    }
    var lastDirCol = typeof DIR_COL !== "undefined" ? DIR_COL.UNIT : 14;
    // getRange(row, column, numRows, numColumns) — use 1 row
    var row = dir.getRange(dirRow, 1, 1, lastDirCol).getValues()[0];
    if (!row || row.length < lastDirCol) row = [];
    while (row.length < lastDirCol) row.push("");
    var idx = function (c) { return (c >= 1 && c <= row.length) ? c - 1 : -1; };
    if (idx(DIR_COL.LAST_UPDATED) >= 0) row[idx(DIR_COL.LAST_UPDATED)] = now;
    if (loggedRow >= 2 && idx(DIR_COL.PENDING_ISSUE) >= 0) row[idx(DIR_COL.PENDING_ISSUE)] = "";
    if (idx(DIR_COL.PENDING_UNIT) >= 0) row[idx(DIR_COL.PENDING_UNIT)] = "";
    if (idx(DIR_COL.PENDING_ROW) >= 0) row[idx(DIR_COL.PENDING_ROW)] = (loggedRow != null && loggedRow !== "") ? Number(loggedRow) : "";
    if (idx(DIR_COL.PENDING_STAGE) >= 0) row[idx(DIR_COL.PENDING_STAGE)] = String(nextStage != null ? nextStage : "").trim();
    if (idx(DIR_COL.ISSUE_BUF_JSON) >= 0) row[idx(DIR_COL.ISSUE_BUF_JSON)] = "[]";
    if (!(opts && opts.createdByManager) && unit && !isInvalidUnit_(unit)) {
      var curCanon = idx(DIR_COL.UNIT) >= 0 ? String(row[idx(DIR_COL.UNIT)] || "").trim() : "";
      if (!curCanon && idx(DIR_COL.UNIT) >= 0) {
        row[idx(DIR_COL.UNIT)] = String(unit).trim();
        try { logDevSms_(phone || "", "", "DAL_WRITE field=Unit row=" + dirRow + " val=[" + String(unit).slice(0, DAL_LOG_LEN) + "] reason=FINALIZE_LEARN_CANON_UNIT"); } catch (_) {}
      }
    }
    dir.getRange(dirRow, 1, 1, lastDirCol).setValues([row]);
    try { logDevSms_(phone || "", "", "DAL_WRITE FINALIZE_DIR_SET_PTR row=" + dirRow + " issue= unit= pendingRow=" + loggedRow + " stage=" + String(nextStage).slice(0, DAL_LOG_LEN)); } catch (_) {}
    if (isEmergencyTicket) try { logDevSms_(phone || "", "", "EMERGENCY_DIR_LATCH row=" + loggedRow + " stage=EMERGENCY_DONE"); } catch (_) {}
  });

  // Emergency latch: Sheet1 EMER/EMER_TYPE + ctx (processTicket_ already wrote EMER; latch ensures ctx + consistency)
  if (isEmergencyTicket && sheet && loggedRow >= 2 && typeof latchEmergency_ === "function") {
    try {
      latchEmergency_(sheet, loggedRow, phone, emergencyTypeForLatch);
      try { logDevSms_(phone, "", "EMERGENCY_LATCH_OK row=" + loggedRow); } catch (_) {}
    } catch (_) {}
  }

  // Close Session: active ticket set, clear draft fields so pre-ticket draft does not reappear
  try {
    if (typeof sessionUpsert_ === "function") {
      sessionUpsert_(phone, {
        activeArtifactKey: ticketId || ("ROW:" + loggedRow),
        draftIssue: "",
        issueBufJson: "[]",
        draftScheduleRaw: "",
        stage: "",
        expected: "",
        expiresAtIso: ""
      }, "finalize_session_close");
    }
  } catch (_) {}

  try {
    // Compass: single AI enrichment enqueue path (canonical)
    enqueueAiEnrichment_(ticketId, propCode, propName, unit, phone, issueForTicket);
  } catch (_) {}

  // Keep a canonical in-memory scheduled end fact for post-create lifecycle branching.
  var postCreateScheduledEndAt = null;

  // Apply draft schedule to ticket when pointer just set and ticket PREF_WINDOW empty
  if (loggedRow >= 2 && typeof COL !== "undefined" && typeof DIR_COL !== "undefined") {
    try {
      const sheet = getLogSheet_();
      if (sheet && loggedRow <= sheet.getLastRow()) {
        const ticketWindow = String(sheet.getRange(loggedRow, COL.PREF_WINDOW).getValue() || "").trim();
        if (!ticketWindow && opts && opts.multiScheduleCaptured === true && opts.capturedScheduleLabel) {
          withWriteLock_("MULTI_SCHEDULE_APPLY", () => {
            sheet.getRange(loggedRow, COL.PREF_WINDOW).setValue(String(opts.capturedScheduleLabel));
            sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(now);
          });
        } else if (!ticketWindow) {
          const draftRaw = String(dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).getValue() || "").trim();
          if (draftRaw) {
            withWriteLock_("DRAFT_SCHEDULE_APPLY", () => {
              sheet.getRange(loggedRow, COL.PREF_WINDOW).setValue(draftRaw);
              sheet.getRange(loggedRow, COL.LAST_UPDATE).setValue(now);
              dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).setValue("");
            });
            try { logDevSms_(phone, issue, "DRAFT_SCHEDULE_APPLIED_TO_TICKET"); } catch (_) {}
          }
        }
        // Always sync ScheduledEndAt from the ticket's final PreferredWindow value.
        // Covers create paths where PREF_WINDOW was already populated upstream.
        try {
          var _finalSchedLabel = String(sheet.getRange(loggedRow, COL.PREF_WINDOW).getValue() || "").trim();
          if (_finalSchedLabel && typeof parsePreferredWindowShared_ === "function") {
            try {
              var _schedParsed = parsePreferredWindowShared_(_finalSchedLabel, null);
              if (_schedParsed && _schedParsed.end instanceof Date && isFinite(_schedParsed.end.getTime())) {
                postCreateScheduledEndAt = _schedParsed.end;
              }
            } catch (_) {}
          }
          syncScheduledEndAtFromRawWindow_(sheet, loggedRow, _finalSchedLabel);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── Resolve assignment (policy-based) ──
  // STAFF_RESOLVER.gs takes priority for maintenance tickets.
  // Falls back to resolveWorkItemAssignment_() if resolver returns nothing.
  var asn = null;
  var _srPatch = null;
  try {
    if (typeof srBuildWorkItemOwnerPatch_ === "function") {
      _srPatch = srBuildWorkItemOwnerPatch_({
        propertyId: propCode,
        domain:     "MAINTENANCE"
      });
    }
  } catch (_) {}

  if (_srPatch && _srPatch.ownerType) {
    asn = {
      ownerType:        _srPatch.ownerType,
      ownerId:          _srPatch.ownerId,
      assignedByPolicy: _srPatch.assignedByPolicy,
      assignedAt:       _srPatch.assignedAt
    };
  } else {
    // Fallback: legacy KV-based resolver
    try {
      asn = resolveWorkItemAssignment_(propCode, { phoneE164: phone });
    } catch (_) {
      asn = { ownerType: "QUEUE", ownerId: "QUEUE_TRIAGE", assignedByPolicy: "ERR:FALLBACK", assignedAt: new Date() };
    }
  }

  // ── Create WorkItem (Primary: STAFF_TRIAGE so ownership engine can triage) ──
  var createdWi = "";
  try {
    createdWi = workItemCreate_({
      type:         "MAINT",
      status:       "OPEN",
      state:        "STAFF_TRIAGE",
      substate:     nextStage,
      phoneE164:    phone,
      propertyId:   propCode,
      unitId:       unit,
      ticketRow:    loggedRow,
      ticketKey:    (ticket && ticket.ticketKey) ? String(ticket.ticketKey).trim() : "",
      metadataJson: JSON.stringify({
        source:     opts.createdByManager ? "MGR_DRAFT" : "DRAFT",
        inboundKey: String(opts.inboundKey || "")
      }),

      // persisted ownership fields (policy-driven)
      ownerType:         (asn && asn.ownerType) || "",
      ownerId:           (asn && asn.ownerId) || "",
      assignedByPolicy:  (asn && asn.assignedByPolicy) || "",
      assignedAt:        (asn && asn.assignedAt) || ""
    });
  } catch (err) {
    try { logDevSms_(phone, issue, "FINALIZE_WI_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
  }

  // Single read for policy + Sheet1 assignment (avoid second workItemGetById_)
  var wiCached = null;
  try { wiCached = (typeof workItemGetById_ === "function") ? workItemGetById_(createdWi) : null; } catch (_) {}

  // Log STAFF_RESOLVER assignment decision to PolicyEventLog
  try {
    if (createdWi && _srPatch && _srPatch._resolverResult && typeof srLogAssignmentEvent_ === "function") {
      srLogAssignmentEvent_(createdWi, _srPatch._resolverResult);
    }
  } catch (_) {}

  // Emergency: WI must be ACTIVE_WORK/EMERGENCY. GUARD: never allow WAIT_TENANT or SCHEDULE for emergency.
  if (isEmergencyTicket && createdWi && typeof workItemUpdate_ === "function") {
    try {
      workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" });
      try { logDevSms_(phone, "", "EMERGENCY_WI_UPDATE wi=" + createdWi + " state=ACTIVE_WORK substate=EMERGENCY"); } catch (_) {}
    } catch (_) {}
  }

  // ── PolicyEngine v1 hook (safe/no-op when POLICY_ENGINE_ENABLED is false) ──
  var pol = { ackOwned: false, ackSent: false, ruleId: "" };
  try {
    if (createdWi && typeof maybePolicyRun_ === "function") {
      var wiForPolicy = wiCached;
      if (!wiForPolicy) {
        wiForPolicy = {
          workItemId: createdWi,
          state: "STAFF_TRIAGE",
          substate: nextStage,
          phoneE164: phone,
          propertyId: propCode,
          unitId: unit,
          ticketRow: loggedRow,
          ownerType: (asn && asn.ownerType) || "",
          ownerId: (asn && asn.ownerId) || "",
          createdAt: new Date()
        };
      } else {
        wiForPolicy.ownerType = (asn && asn.ownerType) || String(wiForPolicy.ownerType || "");
        wiForPolicy.ownerId = (asn && asn.ownerId) || String(wiForPolicy.ownerId || "");
        wiForPolicy.createdAt = wiForPolicy.createdAt || new Date();
      }
      // Pass authoritative category from ticket so policy matches on actual classification (e.g. Electrical), not stale/wrong sheet value
      if (ticket && ticket.classification && typeof ticket.classification.category === "string") {
        wiForPolicy.categoryFromTicket = String(ticket.classification.category).trim().toLowerCase();
      }

      var __policyT0 = Date.now();
      var policyResult = maybePolicyRun_("WORKITEM_CREATED", { phoneE164: phone, lang: "en" }, wiForPolicy, propCode);
      if (policyResult && typeof policyResult === "object") {
        pol.ackOwned = !!policyResult.ackOwned;
        pol.ackSent = !!policyResult.ackSent;
        pol.ruleId = String(policyResult.ruleId || "");
      }
      try { logDevSms_(phone, "", "TRACE_POLICY_RUN dtMs=" + String(Date.now() - __policyT0) + " adapter=" + __finalizeAdapter + " traceId=" + __finalizeTraceId); } catch (_) {}
    }
  } catch (policyErr) {
    try { logDevSms_(phone, "", "POLICY_HOOK_ERR " + String(policyErr && policyErr.message ? policyErr.message : policyErr)); } catch (_) {}
  }

  // Defensive: re-enforce emergency WI state after policy so policy cannot set WAIT_TENANT/SCHEDULE for emergency tickets
  if (isEmergencyTicket && createdWi && typeof workItemUpdate_ === "function") {
    try {
      workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "EMERGENCY" });
      try { logDevSms_(phone, "", "EMERGENCY_WI_STATE_ENFORCED wi=" + createdWi + " state=ACTIVE_WORK substate=EMERGENCY"); } catch (_) {}
    } catch (_) {}
  }

  // ── Staff-capture tenant identity enrichment (never blocks; never overwrites existing real phone) ──
  if (opts.createdByManager && createdWi && loggedRow >= 2 && typeof enrichStaffCapTenantIdentity_ === "function") {
    try {
      enrichStaffCapTenantIdentity_(sheet, loggedRow, createdWi, propName, unit, {
        tenantNameHint: opts.tenantNameHint || "",
        tenantNameTrusted: !!opts.tenantNameTrusted,
        locationType: locType
      });
    } catch (_) {}
  }

  // ── Write assignment to Sheet1 (batched; use asn — we just set WI from asn, no second workItemGetById_) ──
  try {
    if (createdWi && loggedRow >= 2 && sheet && typeof COL !== "undefined" && asn) {
      var aType = String((asn.ownerType) || "").trim();
      if (aType === "STAFF" || aType === "VENDOR") {
        var assigneeName = (typeof resolveAssigneeDisplayName_ === "function") ? resolveAssigneeDisplayName_(aType, asn.ownerId) : String(asn.ownerId || "");
        var aAt = asn.assignedAt instanceof Date ? asn.assignedAt : (asn.assignedAt ? new Date(asn.assignedAt) : new Date());
        var aBy = String(asn.assignedByPolicy || "KV:ASSIGN_DEFAULT_OWNER").trim();
        var oId = String(asn.ownerId || "").trim();
        // getRange(row, column, numRows, numColumns)
        if (COL.ASSIGNED_TO) sheet.getRange(loggedRow, COL.ASSIGNED_TO, 1, 1).setValues([[assigneeName]]);
        if (COL.ASSIGNED_TYPE && COL.ASSIGNED_ID && COL.ASSIGNED_NAME && COL.ASSIGNED_AT && COL.ASSIGNED_BY) {
          sheet.getRange(loggedRow, COL.ASSIGNED_TYPE, 1, 5).setValues([[aType, oId, assigneeName, aAt, aBy]]);
        }
        try { logDevSms_(phone, "", "SHEET1_ASSIGN row=" + loggedRow + " type=" + aType + " name=" + assigneeName); } catch (_) {}
      }
    }
  } catch (sheetAssignErr) {
    try { logDevSms_(phone, "", "SHEET1_ASSIGN_ERR " + String(sheetAssignErr && sheetAssignErr.message ? sheetAssignErr.message : sheetAssignErr)); } catch (_) {}
  }

  // ── Update ctx ──
  try {
    ctxUpsert_(phone, {
      activeWorkItemId:  createdWi || "",
      pendingWorkItemId: createdWi || "",
      pendingExpected:   nextStage,
      pendingExpiresAt:  new Date(Date.now() + (nextStage === "SCHEDULE" || nextStage === "SCHEDULE_DRAFT_MULTI" ? 30 : 10) * 60 * 1000),
      lastIntent:        "MAINT"
    }, "FINALIZE_DRAFT");
  } catch (_) {}

  // ── Post-create lifecycle branch (business-fact based, channel-neutral) ──
  // assigned + scheduled + non-emergency => ACTIVE_WORK + ACTIVE_WORK_ENTERED
  // assigned + unscheduled + non-emergency => UNSCHEDULED hook (existing behavior)
  if (createdWi && asn && asn.ownerId && !isEmergencyTicket) {
    var resolvedScheduledEndAt = null;
    var hasSched = false;
    try {
      if (postCreateScheduledEndAt instanceof Date && isFinite(postCreateScheduledEndAt.getTime())) {
        resolvedScheduledEndAt = postCreateScheduledEndAt;
        hasSched = true;
      } else if (sheet && loggedRow >= 2) {
        var schedCol = (typeof resolveScheduledEndAtCol_ === "function") ? resolveScheduledEndAtCol_(sheet) : (typeof COL !== "undefined" ? Number(COL.SCHEDULED_END_AT || 0) : 0);
        if (schedCol > 0) {
          var schedVal = sheet.getRange(loggedRow, schedCol).getValue();
          if (schedVal instanceof Date && isFinite(schedVal.getTime())) {
            resolvedScheduledEndAt = schedVal;
            hasSched = true;
          }
        }
      }
    } catch (_) {}

    try {
      var wiNow = (typeof workItemGetById_ === "function") ? workItemGetById_(createdWi) : wiCached;
      var wiStateNow = wiNow ? String(wiNow.state || "").trim().toUpperCase() : "";
      var wiStatusNow = wiNow ? String(wiNow.status || "").trim().toUpperCase() : "";
      var isTerminalNow = (wiStateNow === "DONE" || wiStateNow === "COMPLETED" || wiStatusNow === "COMPLETED");

      if (hasSched && resolvedScheduledEndAt && !isTerminalNow) {
        if (wiStateNow === "ACTIVE_WORK") {
          try { logDevSms_(phone, "", "POST_CREATE_LIFECYCLE_SKIP wi=" + createdWi + " reason=ALREADY_ACTIVE_WORK"); } catch (_) {}
        } else {
          try {
            workItemUpdate_(createdWi, { state: "ACTIVE_WORK", substate: "" });
            if (typeof onWorkItemActiveWork_ === "function") {
              var __lifeT0 = Date.now();
              onWorkItemActiveWork_(createdWi, propCode, { scheduledEndAt: resolvedScheduledEndAt });
              try { logDevSms_(phone, "", "TRACE_LIFECYCLE_onWorkItemActiveWork dtMs=" + String(Date.now() - __lifeT0) + " adapter=" + __finalizeAdapter + " traceId=" + __finalizeTraceId); } catch (_) {}
            }
            logDevSms_(phone, "", "POST_CREATE_LIFECYCLE_SCHEDULED_ENTER_ACTIVE wi=" + createdWi + " runAt=" + resolvedScheduledEndAt.toISOString());
          } catch (schedErr) {
            try { logDevSms_(phone, "", "POST_CREATE_LIFECYCLE_ERROR wi=" + createdWi + " branch=SCHEDULED err=" + String(schedErr && schedErr.message ? schedErr.message : schedErr)); } catch (_) {}
          }
        }
      } else if (!hasSched && typeof onWorkItemCreatedUnscheduled_ === "function" && !isTerminalNow) {
        try {
          var __lifeT0u = Date.now();
          onWorkItemCreatedUnscheduled_(createdWi, propCode);
          try { logDevSms_(phone, "", "TRACE_LIFECYCLE_onWorkItemCreatedUnscheduled dtMs=" + String(Date.now() - __lifeT0u) + " adapter=" + __finalizeAdapter + " traceId=" + __finalizeTraceId); } catch (_) {}
          try { logDevSms_(phone, "", "POST_CREATE_LIFECYCLE_UNSCHEDULED wi=" + createdWi); } catch (_) {}
        } catch (e) {
          try { logDevSms_(phone, "", "UNSCHEDULED_HOOK_ERR " + String(e && e.message ? e.message : e)); } catch (_) {}
          try { logDevSms_(phone, "", "POST_CREATE_LIFECYCLE_ERROR wi=" + createdWi + " branch=UNSCHEDULED err=" + String(e && e.message ? e.message : e)); } catch (_) {}
        }
      } else {
        try {
          logDevSms_(phone, "", "POST_CREATE_LIFECYCLE_SKIP wi=" + createdWi + " reason=" + (isTerminalNow ? "TERMINAL" : "NO_BRANCH_TAKEN"));
        } catch (_) {}
      }
    } catch (postCreateErr) {
      try { logDevSms_(phone, "", "POST_CREATE_LIFECYCLE_ERROR wi=" + createdWi + " err=" + String(postCreateErr && postCreateErr.message ? postCreateErr.message : postCreateErr)); } catch (_) {}
    }
  }

  try { logDevSms_(phone, issue, "FINALIZE_DRAFT_OK row=[" + loggedRow + "] tid=[" + ticketId + "] wi=[" + createdWi + "] next=[" + nextStage + "]"); } catch (_) {}

  // Ticket creation boundary: clear canonical split preview to prevent stale grouping on later turns.
  try { canonicalSplitPreviewClear_(phone, "FINALIZE_DRAFT_SINGLE_CLEAR"); } catch (_) {}

  return { ok: true, loggedRow, ticketId, createdWi, nextStage, locationType: locType, locationScopeMixed: locationScopeMixedFlag, issueBufferCount: issueBufferCountForFinalize, ticket, ackOwnedByPolicy: pol.ackOwned, policyRuleId: pol.ruleId, ownerType: (asn && asn.ownerType) ? String(asn.ownerType) : "", ownerId: (asn && asn.ownerId) ? String(asn.ownerId) : "" };
}

// ============================================================
// PORTAL PM CREATE TICKET (Signal Layer adapter)
// Form payload → Directory draft → finalizeDraftAndCreateTicket_.
// Does NOT synthesize Twilio events; does NOT call handleSmsCore_.
// Returns { ticketId, ticketRow, workItemId, nextStage, ownerType, ownerId }.
// ============================================================
function portalPmCreateTicketFromForm_(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "invalid_payload" };

  var phoneE164 = (payload.phoneE164 || "").toString().trim();
  var property = (payload.property || "").toString().trim();
  var message = (payload.message || "").toString().trim();
  if (!phoneE164 || !property || !message) return { ok: false, reason: "Missing required fields: phoneE164, property, message" };

  property = property.toUpperCase();
  var unit = (payload.unit != null && payload.unit !== undefined) ? String(payload.unit).trim() : "";
  var urgency = (payload.urgency || "NORMAL").toString().trim().toUpperCase() || "NORMAL";
  var status = (payload.status || "OPEN").toString().trim() || "OPEN";
  if (payload.preferredWindow === undefined || payload.preferredWindow === null) {
    payload.preferredWindow = "";
  } else {
    payload.preferredWindow = String(payload.preferredWindow).trim();
  }

  var sheet, dir, dirRow;
  try {
    sheet = getSheet_(SHEET_NAME);
    dir = getSheet_(DIRECTORY_SHEET_NAME);
  } catch (sheetErr) {
    return { ok: false, reason: (sheetErr && sheetErr.message) ? sheetErr.message : "sheet_error" };
  }
  // Use a unique key per request so we always get a NEW directory row (no existing pending ticket).
  // This avoids ACTIVE_TICKET_EXISTS when the tenant's row has a stale PendingRow or we match by phone.
  var draftPhone = "PORTAL_PM:" + Date.now() + "_" + (typeof Utilities !== "undefined" && Utilities.getUuid ? Utilities.getUuid() : String(Math.random()).slice(2, 11));
  dirRow = ensureDirectoryRowForPhone_(dir, draftPhone);
  if (!dirRow || dirRow < 2) return { ok: false, reason: "directory_row_failed" };

  // Resolve property to canonical code + full name (e.g. MORR or Morris → MORRIS + The Grand at Morris)
  var propCode = property;
  var propName = property;
  if (typeof getActiveProperties_ === "function") {
    var pl = getActiveProperties_() || [];
    var inputUpper = String(property || "").trim().toUpperCase().replace(/\s+/g, "");
    for (var i = 0; i < pl.length; i++) {
      var c = String(pl[i].code || "").trim().toUpperCase().replace(/\s+/g, "");
      var tp = String(pl[i].ticketPrefix || "").trim().toUpperCase().replace(/\s+/g, "");
      var sn = (pl[i].shortName != null && pl[i].shortName !== "") ? String(pl[i].shortName || "").trim().toUpperCase().replace(/\s+/g, "") : "";
      if (c === inputUpper || tp === inputUpper || (sn && sn === inputUpper)) {
        propCode = String(pl[i].code || "").trim();
        propName = String(pl[i].name || "").trim() || propCode;
        break;
      }
    }
    if (propName === property && typeof getPropertyByNameOrCode_ === "function") {
      var pRes = getPropertyByNameOrCode_(property);
      if (pRes) {
        propCode = String(pRes.code || "").trim();
        propName = String(pRes.name || "").trim() || propCode;
      }
    }
  }

  // Shared emergency evaluation (same as SMS) so portal-created emergency tickets get EMER/EMER_TYPE and no schedule
  var portalSafety = { isEmergency: false, emergencyType: "", skipScheduling: false };
  try {
    if (typeof evaluateEmergencySignal_ === "function") {
      var sig = evaluateEmergencySignal_(message, { phone: phoneE164 });
      if (sig && sig.isEmergency) portalSafety = { isEmergency: true, emergencyType: String(sig.emergencyType || "").trim(), skipScheduling: !!sig.skipScheduling };
    }
    try { logDevSms_(phoneE164, message.slice(0, 60), "PORTAL_EMERGENCY_EVAL emergency=" + (portalSafety.isEmergency ? "1" : "0") + " type=[" + (portalSafety.emergencyType || "") + "]"); } catch (_) {}
  } catch (_) {}

  // Prefer parsed schedule label (e.g. "Tue Mar 10, 12:00 PM–5:00 PM") over raw text ("tomorrow afternoon") for storage
  var preferredWindowRaw = (payload.preferredWindow != null && payload.preferredWindow !== undefined) ? String(payload.preferredWindow).trim() : "";
  var preferredWindowValue = preferredWindowRaw;
  if (preferredWindowRaw && typeof parsePreferredWindowShared_ === "function") {
    try {
      var parsed = parsePreferredWindowShared_(preferredWindowRaw, null);
      if (parsed && parsed.label) preferredWindowValue = String(parsed.label).trim();
    } catch (_) {}
  }
  var turnFacts = {
    property: { code: propCode, name: propName },
    unit: unit,
    issue: message,
    schedule: preferredWindowValue ? { raw: preferredWindowValue } : null,
    safety: portalSafety
  };
  draftUpsertFromTurn_(dir, dirRow, turnFacts, message, phoneE164, { structuredIntake: true });
  if (typeof DIR_COL !== "undefined" && DIR_COL.DRAFT_SCHEDULE_RAW && preferredWindowValue) {
    dalWithLock_("PORTAL_PM_SCHEDULE", function () {
      dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).setValue(preferredWindowValue);
      dalSetLastUpdatedNoLock_(dir, dirRow);
    });
  }

  var inboundKey = "PORTAL_PM:" + Date.now();
  var result;
  try {
    result = finalizeDraftAndCreateTicket_(sheet, dir, dirRow, phoneE164, phoneE164, {
      createdByManager: true,
      inboundKey: inboundKey,
      parsedIssue: {
        category: (payload.category != null) ? String(payload.category).trim() : "",
        urgency: (payload.urgency && String(payload.urgency).toUpperCase() === "URGENT") ? "Urgent" : "Normal"
      }
    });
  } catch (finalizeErr) {
    return { ok: false, reason: (finalizeErr && finalizeErr.message) ? finalizeErr.message : "finalize_error" };
  }

  if (!result || !result.ok) return { ok: false, reason: (result && result.reason) ? result.reason : "creation_failed" };

  if (result.nextStage === "EMERGENCY_DONE") {
    try { logDevSms_(phoneE164, "", "PORTAL_EMERGENCY_LATCH ticketId=" + (result.ticketId || "") + " row=" + (result.loggedRow || "")); } catch (_) {}
  }

  var ticketId = (result.ticketId || "").toString().trim();
  var ticketRow = result.loggedRow != null ? result.loggedRow : (result.ticketRow != null ? result.ticketRow : null);
  // Fallback: if row is missing but we have a ticketId, resolve row via Sheet1 to keep attachments + downstream flows aligned.
  if ((!ticketRow || ticketRow < 2) && ticketId) {
    try { ticketRow = findTicketRowByTicketId_(sheet, ticketId); } catch (_) {}
  }
  var workItemId = (result.createdWi || "").toString().trim();
  var nextStage = (result.nextStage != null) ? String(result.nextStage).trim() : "";
  var ownerType = "";
  var ownerId = "";

  ownerType = String(result.ownerType || "").trim();
  ownerId = String(result.ownerId || "").trim();

  // Write attachment URLs: accept payload.attachments or payload.attachmentUrls (e.g. from pm.uploadAttachment).
  // Always write to the same ticket sheet (sheet) used for creation — never to a log sheet.
  var attachmentList = [];
  if (payload.attachments && (Array.isArray(payload.attachments) ? payload.attachments.length : 1)) {
    attachmentList = Array.isArray(payload.attachments) ? payload.attachments.slice() : [String(payload.attachments)];
  }
  if (payload.attachmentUrls && (Array.isArray(payload.attachmentUrls) ? payload.attachmentUrls.length : 1)) {
    var urls = Array.isArray(payload.attachmentUrls) ? payload.attachmentUrls : [String(payload.attachmentUrls)];
    attachmentList = attachmentList.concat(urls);
  }
  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_(phoneE164, "", "PORTAL_ATTACH_IN count=" + attachmentList.length + " attachments=" + JSON.stringify(payload.attachments || []) + " attachmentUrls=" + JSON.stringify(payload.attachmentUrls || []));
    }
  } catch (_) {}
  if (result.ok && ticketRow >= 2 && attachmentList.length > 0 && typeof COL !== "undefined" && COL.ATTACHMENTS) {
    try {
      if (sheet && ticketRow <= sheet.getLastRow()) {
        var attVal = attachmentList.join("\n");
        sheet.getRange(ticketRow, COL.ATTACHMENTS).setValue(attVal);
        if (typeof logDevSms_ === "function") {
          logDevSms_(phoneE164, "", "PORTAL_ATTACH_WRITE row=" + ticketRow + " col=" + COL.ATTACHMENTS + " count=" + attachmentList.length + " sheet=" + (sheet.getName ? sheet.getName() : "Sheet1"));
        }
      }
    } catch (attachErr) {
      if (typeof logDevSms_ === "function") {
        try { logDevSms_(phoneE164, "", "PORTAL_ATTACH_WRITE_FAIL err=" + (attachErr && attachErr.message ? attachErr.message : String(attachErr))); } catch (_) {}
      }
    }
  }

  try {
    logDevSms_(phoneE164, "", "PM_CREATE_TICKET ticketId=" + (ticketId || "") + " row=" + (ticketRow != null ? ticketRow : "") + " wi=" + (workItemId || "") + " prop=" + property + " unit=" + unit);
  } catch (_) {}

  return {
    ok: true,
    ticketId: ticketId,
    ticketRow: ticketRow,
    workItemId: workItemId,
    nextStage: nextStage,
    ownerType: ownerType,
    ownerId: ownerId
  };
}

// ============================================================
// PORTAL PM: update / complete / delete ticket (Minimum Safe Edit)
// ============================================================
/** Returns 1-based Sheet1 row for ticketId, or 0 if not found. Uses exact ticketId match only. */
function findTicketRowByTicketId_(sheet, ticketId) {
  if (!sheet || !ticketId || typeof ticketId !== 'string') return 0;
  var tid = String(ticketId).trim();
  if (!tid) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var ids = sheet.getRange(2, COL.TICKET_ID, lastRow, COL.TICKET_ID).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === tid) return i + 2;
  }
  return 0;
}

/** Returns 1-based Sheet1 row for the given TicketKey, or 0 if not found. For lifecycle/policy lookup only (runtime resolution). */
function findTicketRowByTicketKey_(sheet, ticketKey) {
  if (!sheet || !ticketKey || typeof ticketKey !== "string") return 0;
  var key = String(ticketKey).trim();
  if (!key) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var col = (typeof COL !== "undefined" && COL.TICKET_KEY) ? COL.TICKET_KEY : 0;
  if (!col || col < 1) return 0;
  var vals = sheet.getRange(2, col, lastRow, col).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "").trim() === key) return i + 2;
  }
  return 0;
}

/** Returns array of 1-based row numbers where ticketId matches exactly. Used for delete safety (exactly-one check). */
function findTicketRowsByTicketId_(sheet, ticketId) {
  var out = [];
  if (!sheet || !ticketId || typeof ticketId !== 'string') return out;
  var tid = String(ticketId).trim();
  if (!tid) return out;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  var ids = sheet.getRange(2, COL.TICKET_ID, lastRow, COL.TICKET_ID).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === tid) out.push(i + 2);
  }
  return out;
}

/**
* Portal PM: append attachment URLs to an existing ticket row.
* Reads current Attachments cell, parses newline/comma-separated, merges with new URLs, dedupes, writes back.
* Never overwrites; append only. Preserves path-style and Drive URLs.
*/
function portalPmAddAttachmentToTicket_(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid_payload' };
  var ticketId = (payload.ticketId || '').toString().trim();
  var newUrls = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!ticketId) return { ok: false, reason: 'missing_ticketId' };
  if (newUrls.length === 0) return { ok: false, reason: 'attachments_required' };
  newUrls = newUrls.map(function (u) { return String(u).trim(); }).filter(Boolean);
  if (newUrls.length === 0) return { ok: false, reason: 'attachments_required' };

  if (typeof logDevSms_ === 'function') {
    try { logDevSms_('', '', 'PM_ADD_ATTACH_IN ticketId=' + ticketId + ' count=' + newUrls.length); } catch (_) {}
  }

  var sheet;
  try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }
  if (typeof COL === 'undefined' || !COL.ATTACHMENTS) return { ok: false, reason: 'COL.ATTACHMENTS not defined' };

  var ticketRow = findTicketRowByTicketId_(sheet, ticketId);
  if (!ticketRow || ticketRow < 2) {
    if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_ADD_ATTACH_FAIL err=ticket_not_found'); } catch (_) {} }
    return { ok: false, reason: 'ticket_not_found' };
  }
  if (typeof logDevSms_ === 'function') {
    try { logDevSms_('', '', 'PM_ADD_ATTACH_FOUND row=' + ticketRow); } catch (_) {}
  }

  var existingVal = '';
  try {
    if (ticketRow <= sheet.getLastRow()) {
      existingVal = String(sheet.getRange(ticketRow, COL.ATTACHMENTS).getValue() || '').trim();
    }
  } catch (e) {
    if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_ADD_ATTACH_FAIL err=' + (e && e.message ? e.message : 'read_cell')); } catch (_) {} }
    return { ok: false, reason: (e && e.message) ? e.message : 'read_failed' };
  }

  var existing = existingVal ? existingVal.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean) : [];
  var seen = {};
  var merged = [];
  for (var i = 0; i < existing.length; i++) {
    var x = existing[i];
    if (!seen[x]) { seen[x] = true; merged.push(x); }
  }
  var addedCount = 0;
  for (var j = 0; j < newUrls.length; j++) {
    var u = newUrls[j];
    if (!seen[u]) { seen[u] = true; merged.push(u); addedCount++; }
  }

  if (addedCount === 0) {
    return { ok: true, ticketId: ticketId, ticketRow: ticketRow, attachments: merged, addedCount: 0 };
  }

  var attVal = merged.join('\n');
  try {
    sheet.getRange(ticketRow, COL.ATTACHMENTS).setValue(attVal);
  } catch (e) {
    if (typeof logDevSms_ === 'function') { try { logDevSms_('', '', 'PM_ADD_ATTACH_FAIL err=' + (e && e.message ? e.message : 'write_cell')); } catch (_) {} }
    return { ok: false, reason: (e && e.message) ? e.message : 'write_failed' };
  }
  if (typeof logDevSms_ === 'function') {
    try { logDevSms_('', '', 'PM_ADD_ATTACH_WRITE row=' + ticketRow + ' added=' + addedCount + ' total=' + merged.length); } catch (_) {}
  }

  return { ok: true, ticketId: ticketId, ticketRow: ticketRow, attachments: merged, addedCount: addedCount };
}

/**
 * Resolve ScheduledEndAt column on Sheet1 with header-based fallback.
 */
function resolveScheduledEndAtCol_(sheet) {
  var schedEndCol = (typeof COL !== "undefined" && COL.SCHEDULED_END_AT) ? Number(COL.SCHEDULED_END_AT) : 0;
  try {
    if (sheet && typeof getHeaderMap_ === "function") {
      var hMap = getHeaderMap_(sheet) || {};
      var dynamicCol = Number(hMap["ScheduledEndAt"] || hMap["SCHEDULED_END_AT"] || 0);
      if (dynamicCol > 0) schedEndCol = dynamicCol;
    }
  } catch (_) {}
  return schedEndCol;
}

/**
 * Keep structured ScheduledEndAt in sync with PreferredWindow text.
 */
function syncScheduledEndAtFromRawWindow_(sheet, row, scheduleRaw) {
  if (!sheet || !row || row < 2) return;
  var schedEndCol = resolveScheduledEndAtCol_(sheet);
  if (schedEndCol <= 0) {
    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_("", "", "SCHED_SYNC_SKIP_NO_COL row=" + row + " sheet=" + (sheet && sheet.getName ? sheet.getName() : ""));
      }
    } catch (_) {}
    return;
  }

  var schedRaw = String(scheduleRaw != null ? scheduleRaw : "").trim();
  var schedParsed = null;
  try {
    if (typeof logDevSms_ === "function") {
      logDevSms_("", "", "SCHED_SYNC_START row=" + row + " col=" + schedEndCol + " sheet=" + (sheet && sheet.getName ? sheet.getName() : "") + " raw=[" + schedRaw.slice(0, 120) + "]");
    }
  } catch (_) {}
  try {
    schedParsed = (schedRaw && typeof parsePreferredWindowShared_ === "function")
      ? parsePreferredWindowShared_(schedRaw, null)
      : null;
  } catch (parseErr) {
    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_("", "", "SCHED_SYNC_PARSE_ERR row=" + row + " err=" + String(parseErr && parseErr.message ? parseErr.message : parseErr));
      }
    } catch (_) {}
  }
  try {
    if (typeof logDevSms_ === "function") {
      var startIso = (schedParsed && schedParsed.start instanceof Date && isFinite(schedParsed.start.getTime())) ? schedParsed.start.toISOString() : "";
      var endIso = (schedParsed && schedParsed.end instanceof Date && isFinite(schedParsed.end.getTime())) ? schedParsed.end.toISOString() : "";
      logDevSms_("", "", "SCHED_SYNC_PARSED row=" + row + " kind=" + String(schedParsed && schedParsed.kind || "") + " label=[" + String(schedParsed && schedParsed.label || "").slice(0, 120) + "] start=" + startIso + " end=" + endIso);
    }
  } catch (_) {}

  if (schedParsed && schedParsed.end instanceof Date) {
    try {
      sheet.getRange(row, schedEndCol).setValue(schedParsed.end);
      try {
        if (typeof logDevSms_ === "function") {
          logDevSms_("", "", "SCHED_SYNC_WRITE_OK row=" + row + " col=" + schedEndCol + " end=" + schedParsed.end.toISOString());
        }
      } catch (_) {}
    } catch (writeErr) {
      try {
        if (typeof logDevSms_ === "function") {
          logDevSms_("", "", "SCHED_SYNC_WRITE_ERR row=" + row + " col=" + schedEndCol + " err=" + String(writeErr && writeErr.message ? writeErr.message : writeErr));
        }
      } catch (_) {}
    }
  } else {
    try {
      sheet.getRange(row, schedEndCol).clearContent();
      try {
        if (typeof logDevSms_ === "function") {
          logDevSms_("", "", "SCHED_SYNC_CLEAR row=" + row + " col=" + schedEndCol + " raw=[" + schedRaw.slice(0, 120) + "]");
        }
      } catch (_) {}
    } catch (clearErr) {
      try {
        if (typeof logDevSms_ === "function") {
          logDevSms_("", "", "SCHED_SYNC_CLEAR_ERR row=" + row + " col=" + schedEndCol + " err=" + String(clearErr && clearErr.message ? clearErr.message : clearErr));
        }
      } catch (_) {}
    }
  }
}

var PORTAL_EDIT_ALLOWED_STATUS_ = ['Open', 'Scheduled', 'In Progress', 'Completed', 'Waiting Parts', 'Cancelled', 'Waiting on Tenant', 'Canceled', 'Waiting Vendor'];
var PORTAL_EDIT_ALLOWED_URGENCY_ = ['Low', 'Normal', 'High'];
var PORTAL_EDIT_ALLOWED_CATEGORY_ = ['Appliance', 'Cleaning', 'Eletrical', 'General', 'HVAC', 'Lock/Key', 'Plumbing', 'Paint/Repair', 'Pest', 'Safety', 'Others'];

function portalPmUpdateTicket_(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_payload' };
  var ticketId = (body.ticketId || '').toString().trim();
  if (!ticketId) return { ok: false, reason: 'missing_ticketId' };

  var sheet;
  try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }

  var row = findTicketRowByTicketId_(sheet, ticketId);
  if (!row) return { ok: false, reason: 'ticket_not_found' };

  var allowedKeys = { status: true, urgency: true, category: true, issue: true, serviceNote: true, schedule: true };
  for (var k in body) {
    if (k !== 'token' && k !== 'ticketId' && body.hasOwnProperty(k) && !allowedKeys[k]) {
      return { ok: false, reason: 'invalid_field_' + k };
    }
  }

  var statusVal = body.status != null ? String(body.status).trim() : null;
  var urgencyVal = body.urgency != null ? String(body.urgency).trim() : null;
  var categoryVal = body.category != null ? String(body.category).trim() : null;
  if (statusVal !== null) {
    var sLower = statusVal.toLowerCase();
    if (sLower === 'canceled') statusVal = 'Cancelled';
    else if (sLower === 'waiting tenant') statusVal = 'Waiting on Tenant';
    if (PORTAL_EDIT_ALLOWED_STATUS_.indexOf(statusVal) < 0) return { ok: false, reason: 'invalid_status' };
  }
  if (urgencyVal !== null && PORTAL_EDIT_ALLOWED_URGENCY_.indexOf(urgencyVal) < 0) return { ok: false, reason: 'invalid_urgency' };
  if (categoryVal !== null && PORTAL_EDIT_ALLOWED_CATEGORY_.indexOf(categoryVal) < 0) return { ok: false, reason: 'invalid_category' };

  var oldCategory = '';
  var oldStatus = '';
  try {
    oldCategory = String(sheet.getRange(row, COL.CAT).getValue() || '').trim();
    if (!oldCategory && typeof COL.CAT_FINAL === 'number') oldCategory = String(sheet.getRange(row, COL.CAT_FINAL).getValue() || '').trim();
    oldStatus = String(sheet.getRange(row, COL.STATUS).getValue() || '').trim();
  } catch (_) {}

  var categoryChanged = (categoryVal !== null && categoryVal !== oldCategory);
  var stillOpen = (statusVal !== null ? statusVal : oldStatus);
  stillOpen = String(stillOpen).toLowerCase();
  var isOpen = ['completed', 'cancelled', 'canceled', 'resolved'].indexOf(stillOpen) < 0;

  // Issue text: COL.MSG (Message) is the canonical editable issue field in Sheet1; no separate Issue column in COL.
  withWriteLock_('PORTAL_PM_UPDATE_TICKET', function () {
    if (statusVal !== null) sheet.getRange(row, COL.STATUS).setValue(statusVal);
    if (urgencyVal !== null) sheet.getRange(row, COL.URG).setValue(urgencyVal);
    if (categoryVal !== null) {
      sheet.getRange(row, COL.CAT).setValue(categoryVal);
      if (typeof COL.CAT_FINAL === 'number') sheet.getRange(row, COL.CAT_FINAL).setValue(categoryVal);
    }
    if (body.issue !== undefined) sheet.getRange(row, COL.MSG).setValue(String(body.issue != null ? body.issue : '').trim());
    if (body.serviceNote !== undefined) sheet.getRange(row, COL.SERVICE_NOTES).setValue(String(body.serviceNote != null ? body.serviceNote : '').trim());
    if (body.schedule !== undefined) {
      var _schedRaw = String(body.schedule != null ? body.schedule : '').trim();
      sheet.getRange(row, COL.PREF_WINDOW).setValue(_schedRaw);
      // Parse and write structured end datetime for lifecycle engine.
      try { syncScheduledEndAtFromRawWindow_(sheet, row, _schedRaw); } catch (_) {}
    }
    sheet.getRange(row, COL.LAST_UPDATE).setValue(new Date());
  });

  if (categoryChanged && isOpen && typeof maybePolicyRun_ === 'function') {
    try {
      var propCode = String(sheet.getRange(row, COL.PROPERTY).getValue() || '').trim().toUpperCase();
      var wiId = typeof findWorkItemIdByTicketRow_ === 'function' ? findWorkItemIdByTicketRow_(row) : '';
      var wiForPolicy = null;
      if (wiId && typeof workItemGetById_ === 'function') wiForPolicy = workItemGetById_(wiId);
      if (!wiForPolicy) {
        wiForPolicy = {
          workItemId: wiId || ('WI_PORTAL_' + row),
          ticketRow: row,
          propertyId: propCode,
          state: 'STAFF_TRIAGE',
          categoryFromTicket: (categoryVal !== null ? categoryVal : oldCategory).toLowerCase()
        };
      } else {
        wiForPolicy.categoryFromTicket = (categoryVal !== null ? categoryVal : oldCategory).toLowerCase();
      }
      maybePolicyRun_('WORKITEM_CREATED', { phoneE164: '', lang: 'en' }, wiForPolicy, propCode);
    } catch (policyErr) {
      try { if (typeof logDevSms_ === 'function') logDevSms_('', '', 'PORTAL_PM_POLICY_RERUN_ERR ' + String(policyErr && policyErr.message ? policyErr.message : policyErr)); } catch (_) {}
    }
  }

  return { ok: true, ticketId: ticketId };
}

function portalPmCompleteTicket_(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_payload' };
  var ticketId = (body.ticketId || '').toString().trim();
  if (!ticketId) return { ok: false, reason: 'missing_ticketId' };

  var sheet;
  try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }

  var row = findTicketRowByTicketId_(sheet, ticketId);
  if (!row) return { ok: false, reason: 'ticket_not_found' };

  var now = new Date();
  withWriteLock_('PORTAL_PM_COMPLETE_TICKET', function () {
    sheet.getRange(row, COL.STATUS).setValue('Completed');
    sheet.getRange(row, COL.CLOSED_AT).setValue(now);
    sheet.getRange(row, COL.LAST_UPDATE).setValue(now);
  });

  // Reuse existing completion path: if a work item is linked to this ticket, set it to DONE via wiTransition_.
  try {
    var wiId = typeof findWorkItemIdByTicketRow_ === 'function' ? findWorkItemIdByTicketRow_(row) : '';
    if (wiId && typeof wiTransition_ === 'function') {
      wiTransition_(wiId, 'DONE', '', '', 'PORTAL_PM_COMPLETE');
    }
  } catch (_) {}

  return { ok: true, ticketId: ticketId };
}

function portalPmDeleteTicket_(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid_payload' };
  var ticketId = (body.ticketId || '').toString().trim();
  if (!ticketId) return { ok: false, reason: 'missing_ticketId' };

  var sheet;
  try { sheet = getSheet_(SHEET_NAME); } catch (e) { return { ok: false, reason: (e && e.message) || 'sheet_error' }; }

  var rows = findTicketRowsByTicketId_(sheet, ticketId);
  if (rows.length === 0) return { ok: false, reason: 'ticket_not_found' };
  if (rows.length > 1) return { ok: false, reason: 'multiple_ticket_matches' };

  var row = rows[0];
  withWriteLock_('PORTAL_PM_DELETE_TICKET', function () {
    sheet.deleteRow(row);
  });
  return { ok: true, ticketId: ticketId };
}

// ============================================================
// NEW ISSUE INTENT DETECTOR (Propera Compass)
// Catches "also my heater broken" / "another problem" etc.
// ============================================================
function looksLikeNewIssueIntent_(bodyTrim) {
  const t = String(bodyTrim || "").toLowerCase().trim();
  return /\b(new request|new ticket|new issue|new problem|separate issue|another issue|another problem|also my|also the|second issue|unrelated)\b/.test(t);
}

/************************************
* PROPERA — WORK ENGINE (PHASE 1)
* - Adds WorkItems + ConversationContext tables
* - Header-based column lookup (no brittle COL for these new tables)
************************************/

const WORKITEMS_SHEET = "WorkItems";
const CTX_SHEET = "ConversationContext";
const SESSIONS_SHEET = "Sessions";

// --------------------------------------------------
// Operational domain router (Phase 1 – Compass)
// --------------------------------------------------
const OPS_DOMAIN_ROUTER_ENABLED = true;          // Global gate for inner operational router
const OPS_CLEANING_LIVE_DIVERT_ENABLED = true;   // When false: log-only, always fall back to MAINTENANCE

const OPS_DOMAIN = {
  MAINTENANCE: "MAINTENANCE",
  CLEANING: "CLEANING",
  COMPLIANCE: "COMPLIANCE",
  ACCESS: "ACCESS",
  TURNOVER: "TURNOVER",
  PREVENTIVE: "PREVENTIVE"
};

// Cache header maps for speed
const __hdrCache = {};

/** Get or create sheet by name */
function getOrCreateSheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (sh) return sh;

  return withWriteLock_("SHEET_CREATE_" + name, () => {
    let s2 = ss.getSheetByName(name);
    if (!s2) s2 = ss.insertSheet(name);

    if (headers && s2.getLastRow() < 1) {
      s2.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    return s2;
  });
}

/** Ensure Visits sheet exists in same workbook as ticket log (LOG_SHEET_ID). Returns sheet. */
function ensureVisitsSheet_() {
  var ss;
  try {
    var id = typeof LOG_SHEET_ID !== "undefined" ? LOG_SHEET_ID : null;
    ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
    if (!ss) return null;
  } catch (_) { ss = SpreadsheetApp.getActive(); }
  var sh = ss.getSheetByName(VISITS_SHEET_NAME);
  if (sh) return sh;
  return withWriteLock_("SHEET_CREATE_VISITS", function () {
    sh = ss.getSheetByName(VISITS_SHEET_NAME);
    if (!sh) sh = ss.insertSheet(VISITS_SHEET_NAME);
    if (sh.getLastRow() < 1) {
      sh.getRange(1, 1, 1, 7).setValues([["VisitId", "PropertyCode", "PropertyName", "Unit", "ScheduleWindowLabel", "CreatedAt", "Phone"]]);
    }
    return sh;
  });
}

/** Create one Visit record; call inside withWriteLock_ or ensure caller holds lock. Returns visitId. */
function createVisit_(visitsSheet, propCode, propName, unit, scheduleLabel, phone) {
  if (!visitsSheet) return "";
  var visitId = "V_" + Utilities.getUuid().slice(0, 8);
  var now = new Date();
  visitsSheet.appendRow([
    visitId,
    String(propCode || "").trim(),
    String(propName || "").trim(),
    String(unit || "").trim(),
    String(scheduleLabel || "").trim(),
    now,
    String(phone || "").trim()
  ]);
  return visitId;
}


/** Build a header->colIndex map (1-indexed) */
function getHeaderMap_(sheet) {
  const key = sheet.getName();
  const lastCol = sheet.getLastColumn();

  const cached = __hdrCache[key];
  if (cached && cached.lastCol === lastCol) return cached.map;

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h || "").trim());

  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });

  __hdrCache[key] = { lastCol, map };
  return map;
}


function col_(sheet, headerName) {
  const map = getHeaderMap_(sheet);
  const c = map[headerName];
  if (!c) throw new Error(`Missing header "${headerName}" in sheet "${sheet.getName()}"`);
  return c;
}


// Per-execution lookup memo (NOT persisted, cleared at end of doPost)
var __FINDROW_CACHE__ = {};

/** Find row by exact match in a column (returns sheet row number or 0) */
function findRowByValue_(sheet, headerName, value) {
  const needle = String(value || "").trim();
  if (!needle) return 0;

  // Cache key is sheetId + headerName + needle
  let sid = "";
  try { sid = String(sheet.getSheetId()); } catch (_) { sid = "unknown"; }
  const ck = sid + "|" + String(headerName || "").trim() + "|" + needle;
  if (__FINDROW_CACHE__.hasOwnProperty(ck)) return __FINDROW_CACHE__[ck];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const c = col_(sheet, headerName);
  if (!c || c < 1) return 0;

  const rng = sheet.getRange(2, c, lastRow - 1, 1);

  // Fast path: TextFinder in Sheets (avoids pulling entire column into JS)
  let foundRow = 0;
  try {
    const cell = rng.createTextFinder(needle).matchEntireCell(true).findNext();
    if (cell) foundRow = cell.getRow();
  } catch (e) {
    // Fallback: old scan
    const vals = rng.getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || "").trim() === needle) { foundRow = i + 2; break; }
    }
  }

  // Do not cache misses (0). Same execution often appends a row after the first lookup;
  // a cached 0 forces duplicate appends on Ctx / IntakeMemory / etc. Positive hits stay cached.
  if (foundRow >= 2) __FINDROW_CACHE__[ck] = foundRow;
  return foundRow;
}

/** Ensure backbone sheets exist */
function ensureWorkBackbone_() {
  getOrCreateSheet_(WORKITEMS_SHEET, [
    "WorkItemId","Type","Status","State","Substate","PhoneE164","PropertyId","UnitId","TicketRow","MetadataJson","CreatedAt","UpdatedAt",
    "OwnerType","OwnerId","AssignedByPolicy","AssignedAt","TicketKey"
  ]);
  // Upgrade-in-place: append missing headers at end (TicketKey last so we never shift existing columns)
  try {
    var wiSh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
    if (wiSh && wiSh.getLastRow() >= 1) {
      var lastCol = wiSh.getLastColumn();
      var row1 = wiSh.getRange(1, 1, 1, lastCol).getValues()[0];
      var hdr = row1.map(function (x) { return String(x || "").trim(); });
      var needOwner = ["OwnerType", "OwnerId", "AssignedByPolicy", "AssignedAt"];
      if (hdr.indexOf("TicketKey") < 0) needOwner.push("TicketKey");
      var missing = [];
      for (var i = 0; i < needOwner.length; i++) {
        if (hdr.indexOf(needOwner[i]) < 0) missing.push(needOwner[i]);
      }
      if (missing.length > 0) {
        withWriteLock_("WORKITEMS_UPGRADE_HEADERS", function () {
          var nextCol = wiSh.getLastColumn() + 1;
          for (var j = 0; j < missing.length; j++) {
            wiSh.getRange(1, nextCol + j, 1, nextCol + j).setValue(missing[j]);
          }
        });
      }
    }
  } catch (_) {}

  getOrCreateSheet_(CTX_SHEET, [
    "PhoneE164","Lang","ActiveWorkItemId","PendingWorkItemId","PendingExpected","PendingExpiresAt","LastIntent","UpdatedAt",
    "PreferredChannel","TelegramChatId",
    "LastActorKey","LastInboundAt"
  ]);
  try {
    var ctxSh = getActiveSheetByNameCached_(CTX_SHEET);
    if (ctxSh && ctxSh.getLastRow() >= 1) {
      var ctxLastCol = ctxSh.getLastColumn();
      var ctxRow1 = ctxSh.getRange(1, 1, 1, ctxLastCol).getValues()[0];
      var ctxHdr = ctxRow1.map(function (x) { return String(x || "").trim(); });
      var ctxNeed = ["PreferredChannel", "TelegramChatId", "LastActorKey", "LastInboundAt"];
      var ctxMissing = [];
      for (var ci = 0; ci < ctxNeed.length; ci++) {
        if (ctxHdr.indexOf(ctxNeed[ci]) < 0) ctxMissing.push(ctxNeed[ci]);
      }
      if (ctxMissing.length > 0) {
        withWriteLock_("CTX_UPGRADE_HEADERS", function () {
          var nc = ctxSh.getLastColumn() + 1;
          for (var cj = 0; cj < ctxMissing.length; cj++) {
            ctxSh.getRange(1, nc + cj, 1, nc + cj).setValue(ctxMissing[cj]);
          }
        });
      }
    }
  } catch (_) {}
  getOrCreateSheet_(SESSIONS_SHEET, [
    "Phone","Stage","Expected","Lane","DraftProperty","DraftUnit","DraftIssue","IssueBufJson","DraftScheduleRaw","ActiveArtifactKey","ExpiresAtIso","UpdatedAtIso"
  ]);
}


function workItemCreate_(obj) {
  ensureWorkBackbone_();
  var sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
  var id = obj.workItemId || ("WI_" + Utilities.getUuid().slice(0, 8));
  var now = new Date();

  var row = [
    id,
    String(obj.type || "MAINT").trim(),
    String(obj.status || "OPEN").trim(),
    String(obj.state || "INTAKE").trim(),
    String(obj.substate || "").trim(),
    String(obj.phoneE164 || "").trim(),
    String(obj.propertyId || "").trim(),
    String(obj.unitId || "").trim(),
    obj.ticketRow ? Number(obj.ticketRow) : "",
    String(obj.metadataJson || "").trim(),
    now,
    now,

    // ownership fields
    String(obj.ownerType || "").trim(),
    String(obj.ownerId || "").trim(),
    String(obj.assignedByPolicy || "").trim(),
    (obj.assignedAt instanceof Date) ? obj.assignedAt : (obj.assignedAt ? new Date(obj.assignedAt) : ""),

    // TicketKey last (append-only; avoids shifting columns)
    String(obj.ticketKey || "").trim()
  ];

  withWriteLock_("WORKITEM_CREATE", function () {
    sh.appendRow(row);
  });
  return id;
}

function workItemGetById_(workItemId) {
  ensureWorkBackbone_();
  const sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
  const r = findRowByValue_(sh, "WorkItemId", workItemId);
  if (!r) return null;

  const map = getHeaderMap_(sh);
  const lastCol = sh.getLastColumn();
  const vals = sh.getRange(r, 1, 1, lastCol).getValues()[0];

  function v_(key) {
    var c = map[key];
    return (c >= 1 && c <= vals.length) ? vals[c - 1] : undefined;
  }
  // minimal object (include assignment fields for Sheet1 sync; ticketKey = canonical WI↔ticket link)
  return {
    row: r,
    workItemId: v_("WorkItemId"),
    type: v_("Type"),
    status: v_("Status"),
    state: v_("State"),
    substate: v_("Substate"),
    phoneE164: v_("PhoneE164"),
    propertyId: v_("PropertyId"),
    unitId: v_("UnitId"),
    ticketRow: v_("TicketRow"),
    ticketKey: v_("TicketKey"),
    metadataJson: v_("MetadataJson"),
    ownerType: v_("OwnerType"),
    ownerId: v_("OwnerId"),
    assignedByPolicy: v_("AssignedByPolicy"),
    assignedAt: v_("AssignedAt")
  };
}

function workItemUpdate_(workItemId, patch) {
  ensureWorkBackbone_();
  const sh = getActiveSheetByNameCached_(WORKITEMS_SHEET);
  const r = findRowByValue_(sh, "WorkItemId", workItemId);
  if (!r) return false;

  withWriteLock_("WORKITEM_UPDATE", () => {
    if (patch.status !== undefined) sh.getRange(r, col_(sh, "Status")).setValue(String(patch.status));
    if (patch.state !== undefined) sh.getRange(r, col_(sh, "State")).setValue(String(patch.state));
    if (patch.substate !== undefined) sh.getRange(r, col_(sh, "Substate")).setValue(String(patch.substate));
    if (patch.phoneE164 !== undefined) sh.getRange(r, col_(sh, "PhoneE164")).setValue(String(patch.phoneE164 || ""));
    if (patch.propertyId !== undefined) sh.getRange(r, col_(sh, "PropertyId")).setValue(String(patch.propertyId));
    if (patch.unitId !== undefined) sh.getRange(r, col_(sh, "UnitId")).setValue(String(patch.unitId));
    if (patch.ticketRow !== undefined) sh.getRange(r, col_(sh, "TicketRow")).setValue(patch.ticketRow ? Number(patch.ticketRow) : "");
    if (patch.ticketKey !== undefined) sh.getRange(r, col_(sh, "TicketKey")).setValue(String(patch.ticketKey || "").trim());
    if (patch.metadataJson !== undefined) sh.getRange(r, col_(sh, "MetadataJson")).setValue(String(patch.metadataJson || ""));
    sh.getRange(r, col_(sh, "UpdatedAt")).setValue(new Date());
  });

  return true;
}

// ============================================================
// Operational Domain Router (Compass – Phase 1)
// Slot-based, future-extensible between MAINT / CLEANING etc.
// ============================================================

// Cleaning subtype (Phase 1 v1): PET_WASTE | TRASH | SPILL | BIOHAZARD | GENERAL
function inferCleaningSubtype_(text) {
  var t = String(text || "").toLowerCase().trim();
  if (!t) return "GENERAL";
  if (/\b(poop|feces|faeces|dog\s*waste|pet\s*waste|animal\s*waste|urine|pee)\b/.test(t)) return "PET_WASTE";
  if (/\b(blood|biohazard|hazardous)\b/.test(t)) return "BIOHAZARD";
  if (/\b(trash|garbage|litter|debris)\b/.test(t)) return "TRASH";
  if (/\b(spill|vomit|mess|dirty|filthy|cleanup|clean\s*up)\b/.test(t)) return "SPILL";
  return "GENERAL";
}

function getOperationalDomainSlots_() {
  // Slot registry: enabled domains first, then stubs (disabled).
  return [
    {
      domain: OPS_DOMAIN.MAINTENANCE,
      enabled: true,
      priority: 100,
      reviewOnly: false,
      dispatchTarget: "MAINT_PIPELINE",
      hardMatch: function (signal, ctx) {
        var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
        if (!text) return null;
        var re = /\b(leak|leaking|clogged|broken|not working|no heat|no hot water|smoke detector|outlet|heater|furnace|ac|air conditioner|fridge|refrigerator|stove|dishwasher)\b/;
        if (re.test(text)) return { matched: true, code: "MAINT_KEYWORD_STRONG" };
        return null;
      },
      veto: function (signal, ctx) {
        return null;
      },
      score: function (signal, ctx) {
        var reasons = [];
        var score = 0;
        var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
        if (!text) return { score: 0, reasons: ["no_text"] };

        var maintWords = [
          "leak", "leaking", "clogged", "broken", "not working", "stop working", "stopped working", "no heat",
          "no hot water", "heater", "furnace", "radiator", "smoke detector", "beeping", "outlet", "socket",
          "sink", "toilet", "shower", "tub", "bathroom", "kitchen", "fridge", "refrigerator", "stove",
          "oven", "dishwasher", "window", "door", "lock"
        ];
        for (var i = 0; i < maintWords.length; i++) {
          if (text.indexOf(maintWords[i]) >= 0) {
            score += 2;
            reasons.push("kw:" + maintWords[i]);
          }
        }

        var broad = String(signal && signal.locationScopeBroad || "").toUpperCase();
        if (broad === "UNIT") {
          score += 2;
          reasons.push("loc_broad_unit");
        }

        if (!reasons.length) reasons.push("baseline");
        return { score: score, reasons: reasons };
      }
    },
    {
      domain: OPS_DOMAIN.CLEANING,
      enabled: true,
      priority: 90,
      reviewOnly: false,
      dispatchTarget: "CLEANING_WORKITEM",
      hardMatch: function (signal, ctx) {
        var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
        if (!text) return null;
        var re = /\b(poop|feces|faeces|trash|garbage|litter|spill|vomit|urine|pee|blood|mess|dirty|filthy|debris)\b/;
        if (re.test(text)) return { matched: true, code: "CLEANING_KEYWORD_STRONG" };
        return null;
      },
      veto: function (signal, ctx) {
        // If explicit repair language present, do not let CLEANING steal it.
        var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
        if (!text) return null;
        var maintRe = /\b(leak|leaking|clogged|broken|not working|no heat|no hot water|heater|furnace|radiator|smoke detector|outlet|socket|stove|dishwasher)\b/;
        if (maintRe.test(text)) return { code: "VETO_REPAIR_LANGUAGE" };
        return null;
      },
      score: function (signal, ctx) {
        var reasons = [];
        var score = 0;
        var text = String((signal && (signal.turnFacts && signal.turnFacts.issue)) || signal.mergedBody || signal.rawBody || "").toLowerCase();
        if (!text) return { score: 0, reasons: ["no_text"] };

        var cleaningWords = [
          "poop", "feces", "faeces", "trash", "garbage", "litter", "spill", "vomit",
          "urine", "pee", "blood", "mess", "dirty", "filthy", "debris", "cleanup", "clean up", "sanit"
        ];
        for (var i = 0; i < cleaningWords.length; i++) {
          if (text.indexOf(cleaningWords[i]) >= 0) {
            score += 3;
            reasons.push("kw:" + cleaningWords[i]);
          }
        }

        var broad = String(signal && signal.locationScopeBroad || "").toUpperCase();
        var refined = String(signal && signal.locationScopeRefined || "").toUpperCase();
        if (broad === "COMMON_AREA") {
          score += 2;
          reasons.push("loc_broad_common_area");
        }
        if (refined && refined !== "UNIT" && refined !== "UNKNOWN") {
          score += 1;
          reasons.push("loc_refined_" + refined);
        }

        var subtype = (typeof inferCleaningSubtype_ === "function") ? inferCleaningSubtype_(text) : "GENERAL";
        if (!reasons.length) reasons.push("baseline");
        return { score: score, reasons: reasons, subtype: subtype };
      }
    },
    // --- Future domains (stubs; disabled) ---
    { domain: OPS_DOMAIN.COMPLIANCE, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "COMPLIANCE_STUB",
      hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } },
    { domain: OPS_DOMAIN.ACCESS, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "ACCESS_STUB",
      hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } },
    { domain: OPS_DOMAIN.TURNOVER, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "TURNOVER_STUB",
      hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } },
    { domain: OPS_DOMAIN.PREVENTIVE, enabled: false, priority: 50, reviewOnly: true, dispatchTarget: "PREVENTIVE_STUB",
      hardMatch: function () { return null; }, veto: function () { return null; }, score: function () { return { score: 0, reasons: ["stub"] }; } }
  ];
}

function buildDomainSignal_(opts) {
  opts = opts || {};
  var bodyTrim = String(opts.bodyTrim || "").trim();
  var mergedBodyTrim = String(opts.mergedBodyTrim || bodyTrim).trim();
  var turnFacts = opts.turnFacts || {};
  var mediaFacts = opts.mediaFacts || {};
  var phone = String(opts.phone || "").trim();
  var lang = String(opts.lang || "en").trim();

  var loc = (turnFacts && turnFacts.location) ? turnFacts.location : null;
  var broadFromPkg = String((loc && (loc.locationType || loc.locationScopeBroad)) || "UNIT").toUpperCase();
  var refinedFromPkg = String((loc && (loc.locationArea || loc.locationScopeRefined)) || broadFromPkg).toUpperCase();
  var locScope = {
    locationScopeBroad: broadFromPkg,
    locationScopeRefined: refinedFromPkg,
    locationText: String((loc && loc.locationText) || opts.locationTextHint || mergedBodyTrim || bodyTrim),
    locationSource: String((loc && loc.locationSource) || "opener"),
    locationConfidence: Number((loc && loc.locationConfidence) || 0.5),
    placeKey: (loc && loc.locationArea) ? (broadFromPkg + ":" + String(loc.locationArea).toUpperCase()) : ""
  };

  var signal = {
    rawBody: bodyTrim,
    mergedBody: mergedBodyTrim,
    phoneE164: phone,
    lang: lang,
    mode: String(opts.mode || "").toUpperCase(),
    propertyCode: String(opts.propertyCode || "").trim(),
    propertyName: String(opts.propertyName || "").trim(),
    pendingUnit: String(opts.pendingUnit || "").trim(),
    dirRow: Number(opts.dirRow || 0) || 0,
    pendingStage: String(opts.pendingStage || "").trim(),
    ticketStateType: String(opts.ticketStateType || "").trim(),
    turnFacts: turnFacts,
    mediaFacts: mediaFacts,
    ctx: opts.ctx || null,

    locationScopeBroad: locScope.locationScopeBroad,
    locationScopeRefined: locScope.locationScopeRefined,
    locationText: locScope.locationText,
    locationSource: locScope.locationSource,
    locationConfidence: locScope.locationConfidence,
    placeKey: locScope.placeKey,
    domainHint: (typeof properaNormalizeDomainHint_ === "function")
      ? properaNormalizeDomainHint_(turnFacts.domainHint)
      : String(turnFacts.domainHint != null ? turnFacts.domainHint : "UNKNOWN").toUpperCase().trim(),
    intakePackageAuthoritative: !!(turnFacts && turnFacts.__properaIntakePackage)
  };

  try {
    logDevSms_(phone, (mergedBodyTrim || "").slice(0, 80),
      "DOMAIN_SIGNAL_BUILT broad=[" + signal.locationScopeBroad + "] refined=[" + signal.locationScopeRefined + "] src=[" + signal.locationSource + "] conf=" + signal.locationConfidence + " domainHint=[" + String(signal.domainHint || "") + "]");
  } catch (_) {}

  return signal;
}

function routeOperationalDomain_(domainSignal, opts) {
  opts = opts || {};
  if (!OPS_DOMAIN_ROUTER_ENABLED || !domainSignal) {
    return {
      detectedDomain: OPS_DOMAIN.MAINTENANCE,
      subtype: "",
      confidence: 0.5,
      selectedEngine: "MAINT_PIPELINE",
      reasons: ["router_disabled"],
      reviewOnly: false,
      fallbackDomain: OPS_DOMAIN.MAINTENANCE,
      locationScopeBroad: (domainSignal && domainSignal.locationScopeBroad) || "UNKNOWN",
      locationScopeRefined: (domainSignal && domainSignal.locationScopeRefined) || "UNKNOWN",
      locationText: (domainSignal && domainSignal.locationText) || "",
      placeKey: (domainSignal && domainSignal.placeKey) || "",
      locationSource: (domainSignal && domainSignal.locationSource) || "none",
      locationConfidence: Number(domainSignal && domainSignal.locationConfidence) || 0,
      preserveMaintenancePath: true,
      evidenceSummary: "",
      issueSummary: (domainSignal && domainSignal.turnFacts && domainSignal.turnFacts.issue) || (domainSignal && domainSignal.mergedBody) || "",
      domainHint: (typeof properaNormalizeDomainHint_ === "function")
        ? properaNormalizeDomainHint_((domainSignal && domainSignal.turnFacts && domainSignal.turnFacts.domainHint) || (domainSignal && domainSignal.domainHint))
        : String((domainSignal && domainSignal.domainHint) || "UNKNOWN").toUpperCase().trim(),
      domainHintApplied: false,
      advisoryDomainHint: ""
    };
  }

  var slots = getOperationalDomainSlots_();
  var ctx = { mode: opts.mode || "", phone: domainSignal.phoneE164 || "" };

  var tfPkg = domainSignal.turnFacts || {};
  var pkgAuth = !!(domainSignal.intakePackageAuthoritative || tfPkg.__properaIntakePackage);
  var hintPkg = String(domainSignal.domainHint || tfPkg.domainHint || "UNKNOWN").toUpperCase().trim();
  if (typeof properaNormalizeDomainHint_ === "function") hintPkg = properaNormalizeDomainHint_(hintPkg);

  function domainDecisionFromIntakeHint_(detected, confidence, reasonsArr, preserveMaint, hintApplied, advisory) {
    var iss = String(tfPkg.issue || tfPkg.issueHint || domainSignal.mergedBody || "").trim();
    var finalSub = "";
    if (detected === OPS_DOMAIN.CLEANING && typeof inferCleaningSubtype_ === "function") {
      finalSub = inferCleaningSubtype_(iss) || "";
    }
    var dec = {
      detectedDomain: detected,
      subtype: finalSub,
      confidence: confidence,
      selectedEngine: detected === OPS_DOMAIN.CLEANING ? "CLEANING_WORKITEM" : "MAINT_PIPELINE",
      reasons: reasonsArr.slice(),
      reviewOnly: false,
      fallbackDomain: OPS_DOMAIN.MAINTENANCE,
      locationScopeBroad: (domainSignal && domainSignal.locationScopeBroad) || "UNKNOWN",
      locationScopeRefined: (domainSignal && domainSignal.locationScopeRefined) || "UNKNOWN",
      locationText: (domainSignal && domainSignal.locationText) || "",
      placeKey: (domainSignal && domainSignal.placeKey) || "",
      locationSource: (domainSignal && domainSignal.locationSource) || "none",
      locationConfidence: Number(domainSignal && domainSignal.locationConfidence) || 0,
      preserveMaintenancePath: preserveMaint,
      evidenceSummary: "",
      issueSummary: iss,
      domainHint: hintPkg,
      domainHintApplied: !!hintApplied,
      advisoryDomainHint: String(advisory || "").trim()
    };
    if (dec.detectedDomain !== OPS_DOMAIN.MAINTENANCE && dec.preserveMaintenancePath) {
      try { logDevSms_(ctx.phone, "", "DOMAIN_ROUTE_FALLBACK src=[" + dec.detectedDomain + "] dst=[MAINTENANCE] reason=[preserve_path]"); } catch (_) {}
      dec.detectedDomain = OPS_DOMAIN.MAINTENANCE;
      dec.selectedEngine = "MAINT_PIPELINE";
    }
    try {
      logDevSms_(ctx.phone, "", "DOMAIN_ROUTE_SELECTED domain=[" + dec.detectedDomain + "] conf=" + dec.confidence.toFixed(2) +
        " broad=[" + dec.locationScopeBroad + "] refined=[" + dec.locationScopeRefined + "] reasons=[" + String((dec.reasons || []).join("|")).slice(0, 80) + "] hintApplied=" + (hintApplied ? "1" : "0"));
    } catch (_) {}
    return dec;
  }

  if (pkgAuth && hintPkg === "MAINTENANCE") {
    return domainDecisionFromIntakeHint_(OPS_DOMAIN.MAINTENANCE, 0.82, ["domain_hint_package_MAINTENANCE"], true, true, "");
  }
  if (pkgAuth && hintPkg === "CLEANING") {
    return domainDecisionFromIntakeHint_(OPS_DOMAIN.CLEANING, 0.78, ["domain_hint_package_CLEANING"], false, true, "");
  }
  if (pkgAuth && (hintPkg === "AMENITY" || hintPkg === "LEASING")) {
    return domainDecisionFromIntakeHint_(OPS_DOMAIN.MAINTENANCE, 0.55, ["domain_hint_package_" + hintPkg + "_advisory"], true, false, hintPkg);
  }

  var signalForSlots = domainSignal;
  if (pkgAuth && (hintPkg === "UNKNOWN" || hintPkg === "GENERAL" || hintPkg === "CONFLICT")) {
    var semOnly = String(tfPkg.semanticTextEnglish || tfPkg.issue || tfPkg.issueHint || "").trim();
    if (semOnly) {
      signalForSlots = Object.assign({}, domainSignal, { mergedBody: semOnly, rawBody: semOnly });
    }
  }

  var bestDomain = OPS_DOMAIN.MAINTENANCE;
  var bestScore = -1;
  var bestReasons = ["baseline"];
  var bestSubtype = "";
  var bestReviewOnly = false;
  var hadCleaningCandidate = false;
  var cleaningScore = -1;
  var maintScore = -1;

  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    if (!s || !s.domain) continue;
    if (!s.enabled) continue;

    var veto = null;
    try { veto = s.veto(signalForSlots, ctx); } catch (_) {}
    if (veto && veto.code) {
      try { logDevSms_(ctx.phone, "", "DOMAIN_SLOT_SCORE domain=[" + s.domain + "] score=VETO reason=[" + veto.code + "] broad=[" + String(signalForSlots.locationScopeBroad || "") + "] refined=[" + String(signalForSlots.locationScopeRefined || "") + "]"); } catch (_) {}
      continue;
    }

    var slotScore = { score: 0, reasons: ["no_score"] };
    try { slotScore = s.score(signalForSlots, ctx) || slotScore; } catch (_) {}

    try {
      logDevSms_(ctx.phone, "", "DOMAIN_SLOT_SCORE domain=[" + s.domain + "] score=" + String(slotScore.score || 0) +
        " reasons=[" + String((slotScore.reasons || []).join("|")).slice(0, 80) + "] broad=[" + String(signalForSlots.locationScopeBroad || "") + "] refined=[" + String(signalForSlots.locationScopeRefined || "") + "]");
    } catch (_) {}

    if (s.domain === OPS_DOMAIN.MAINTENANCE) maintScore = Number(slotScore.score || 0);
    if (s.domain === OPS_DOMAIN.CLEANING) {
      cleaningScore = Number(slotScore.score || 0);
      if (cleaningScore >= 4) hadCleaningCandidate = true;
    }

    if (slotScore.score > bestScore) {
      bestScore = slotScore.score;
      bestDomain = s.domain;
      bestReasons = slotScore.reasons || ["slot"];
      bestSubtype = slotScore.subtype || "";
      bestReviewOnly = !!s.reviewOnly || !!slotScore.reviewOnly;
    }
  }

  var detectedDomain = OPS_DOMAIN.MAINTENANCE;
  var confidence = 0.5;
  var reasons = bestReasons.slice();
  var preserveMaintenancePath = true;

  var divertEligible = 0;
  if (hadCleaningCandidate && cleaningScore >= 4 && cleaningScore >= (maintScore + 2)) {
    detectedDomain = OPS_DOMAIN.CLEANING;
    confidence = Math.min(0.99, 0.6 + (cleaningScore / 10));
    preserveMaintenancePath = false;
    divertEligible = 1;
  } else {
    detectedDomain = OPS_DOMAIN.MAINTENANCE;
    confidence = Math.min(0.95, 0.5 + Math.max(0, maintScore) / 10);
    preserveMaintenancePath = true;
    if (hadCleaningCandidate) reasons.push("cleaning_fallback_to_maint");
  }

  var scoreGap = (cleaningScore - maintScore);
  try {
    logDevSms_(ctx.phone, "", "DOMAIN_SCORE_GAP maintScore=" + String(maintScore) + " cleaningScore=" + String(cleaningScore) + " scoreGap=" + String(scoreGap) + " divertEligible=" + String(divertEligible));
  } catch (_) {}

  var finalSubtype = bestSubtype || "";
  if (detectedDomain === OPS_DOMAIN.CLEANING && !finalSubtype && typeof inferCleaningSubtype_ === "function") {
    var issueText = (domainSignal && domainSignal.turnFacts && domainSignal.turnFacts.issue) || (domainSignal && domainSignal.mergedBody) || "";
    finalSubtype = inferCleaningSubtype_(issueText);
  }

  var decision = {
    detectedDomain: detectedDomain,
    subtype: finalSubtype || "",
    confidence: confidence,
    selectedEngine: detectedDomain === OPS_DOMAIN.CLEANING ? "CLEANING_WORKITEM" : "MAINT_PIPELINE",
    reasons: reasons,
    reviewOnly: bestReviewOnly,
    fallbackDomain: OPS_DOMAIN.MAINTENANCE,
    locationScopeBroad: (domainSignal && domainSignal.locationScopeBroad) || "UNKNOWN",
    locationScopeRefined: (domainSignal && domainSignal.locationScopeRefined) || "UNKNOWN",
    locationText: (domainSignal && domainSignal.locationText) || "",
    placeKey: (domainSignal && domainSignal.placeKey) || "",
    locationSource: (domainSignal && domainSignal.locationSource) || "none",
    locationConfidence: Number(domainSignal && domainSignal.locationConfidence) || 0,
    preserveMaintenancePath: preserveMaintenancePath,
    evidenceSummary: "",
    issueSummary: (domainSignal && domainSignal.turnFacts && domainSignal.turnFacts.issue) || (domainSignal && domainSignal.mergedBody) || "",
    domainHint: hintPkg,
    domainHintApplied: false,
    advisoryDomainHint: ""
  };

  try {
    logDevSms_(ctx.phone, "", "DOMAIN_ROUTE_SELECTED domain=[" + decision.detectedDomain + "] conf=" + decision.confidence.toFixed(2) +
      " broad=[" + decision.locationScopeBroad + "] refined=[" + decision.locationScopeRefined + "] reasons=[" + String((decision.reasons || []).join("|")).slice(0, 80) + "]");
  } catch (_) {}

  if (decision.detectedDomain !== OPS_DOMAIN.MAINTENANCE && decision.preserveMaintenancePath) {
    try { logDevSms_(ctx.phone, "", "DOMAIN_ROUTE_FALLBACK src=[" + decision.detectedDomain + "] dst=[MAINTENANCE] reason=[preserve_path]"); } catch (_) {}
    decision.detectedDomain = OPS_DOMAIN.MAINTENANCE;
    decision.selectedEngine = "MAINT_PIPELINE";
  }

  return decision;
}

function dispatchOperationalDomain_(decision, routeCtx) {
  routeCtx = routeCtx || {};
  if (!decision || !OPS_DOMAIN_ROUTER_ENABLED) {
    return { handled: false };
  }

  var phone = String(routeCtx.phone || "").trim();

  try {
    logDevSms_(phone, "", "DOMAIN_DISPATCH_START domain=[" + (decision.detectedDomain || "") + "] conf=" + String(decision.confidence || ""));
  } catch (_) {}

  if (decision.detectedDomain === OPS_DOMAIN.CLEANING) {
    if (!OPS_CLEANING_LIVE_DIVERT_ENABLED || decision.reviewOnly || decision.confidence < 0.75) {
      try { logDevSms_(phone, "", "DOMAIN_DISPATCH_CLEANING_FALLBACK conf=" + String(decision.confidence || "") + " reviewOnly=" + String(decision.reviewOnly || false)); } catch (_) {}
      return { handled: false };
    }

    var createResult = createCleaningWorkItemFromDomain_(decision, routeCtx);
    var wiId = (createResult && createResult.workItemId) ? String(createResult.workItemId).trim() : "";
    var deduped = !!(createResult && createResult.deduped);

    if (deduped) {
      try { logDevSms_(phone, "", "CLEANING_DEDUPE_ACK"); } catch (_) {}
      return { handled: true, deduped: true };
    }

    if (!wiId) {
      try { logDevSms_(phone, "", "CLEANING_ROUTE_ABORTED reason=[workitem_create_failed]"); } catch (_) {}
      return { handled: false };
    }

    try {
      logDevSms_(phone, "", "DOMAIN_DISPATCH_CLEANING wiId=[" + wiId + "] broad=[" + (decision.locationScopeBroad || "") + "] refined=[" + (decision.locationScopeRefined || "") + "] subtype=[" + (decision.subtype || "") + "]");
      logDevSms_(phone, "", "CLEANING_WORKITEM_CREATED wiId=[" + wiId + "] domain=[CLEANING]");
    } catch (_) {}

    return {
      handled: true,
      cleaningWorkItemId: wiId
    };
  }

  // Default / MAINTENANCE path: let existing draft/ticket spine run.
  try {
    logDevSms_(phone, "", "DOMAIN_DISPATCH_MAINT domain=[" + (decision.detectedDomain || "MAINTENANCE") + "]");
  } catch (_) {}

  return { handled: false };
}

function createCleaningWorkItemFromDomain_(decision, routeCtx) {
  routeCtx = routeCtx || {};
  var phone = String(routeCtx.phone || "").trim();
  var propCode = String(routeCtx.propertyCode || "").trim();
  var propName = String(routeCtx.propertyName || "").trim();
  var unitVal = "";
  if (String(decision.locationScopeBroad || "").toUpperCase() === "UNIT") {
    unitVal = String(routeCtx.pendingUnit || routeCtx.unit || "").trim();
  }

  var issueSummary = String(decision.issueSummary || routeCtx.bodyTrim || "").slice(0, 300);

  // Lightweight dedupe: same phone + time window + normalized issue + property + location + first media URL
  var normIssue = String(issueSummary || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
  var firstMedia = "";
  try {
    if (routeCtx.mediaFacts && routeCtx.mediaFacts.mediaUrls && routeCtx.mediaFacts.mediaUrls[0]) firstMedia = String(routeCtx.mediaFacts.mediaUrls[0]).trim();
    else if (routeCtx.turnFacts && routeCtx.turnFacts.meta && routeCtx.turnFacts.meta.mediaUrls && routeCtx.turnFacts.meta.mediaUrls[0]) firstMedia = String(routeCtx.turnFacts.meta.mediaUrls[0]).trim();
  } catch (_) {}
  var timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  var fpParts = [phone, String(timeBucket), normIssue, propCode, String(decision.locationScopeRefined || ""), firstMedia];
  var fpRaw = fpParts.join("|");
  var fpHash = "";
  try { fpHash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, fpRaw)); } catch (_) { fpHash = fpRaw.slice(0, 32); }
  var dedupeKey = "CLEANING_DEDUPE_" + fpHash;
  try {
    var cache = CacheService.getDocumentCache();
    if (cache && cache.get(dedupeKey)) {
      try { logDevSms_(phone, "", "CLEANING_DEDUPE_HIT key=" + dedupeKey.slice(0, 40)); } catch (_) {}
      return { workItemId: "", deduped: true };
    }
  } catch (_) {}

  var mediaUrls = [];
  try {
    if (routeCtx.mediaFacts && routeCtx.mediaFacts.mediaUrls && routeCtx.mediaFacts.mediaUrls.length) {
      mediaUrls = routeCtx.mediaFacts.mediaUrls;
    } else if (routeCtx.turnFacts && routeCtx.turnFacts.meta && routeCtx.turnFacts.meta.mediaUrls) {
      mediaUrls = routeCtx.turnFacts.meta.mediaUrls;
    }
  } catch (_) {}

  var metadata = {
    domain: OPS_DOMAIN.CLEANING,
    subtype: decision.subtype || "",
    propertyCode: propCode,
    propertyName: propName,
    locationScopeBroad: decision.locationScopeBroad || "UNKNOWN",
    locationScopeRefined: decision.locationScopeRefined || "UNKNOWN",
    locationText: decision.locationText || "",
    placeKey: decision.placeKey || "",
    issueSummary: issueSummary,
    locationSource: decision.locationSource || "",
    locationConfidence: Number(decision.locationConfidence || 0),
    mediaUrls: mediaUrls,
    phoneE164: phone,
    sourceChannel: routeCtx.channel || "",
    source: "SMS_CORE",
    state: "NEW"
  };

  var asn = null;
  try {
    if (typeof resolveWorkItemAssignment_ === "function" && propCode) {
      asn = resolveWorkItemAssignment_(propCode, { phoneE164: phone, domain: OPS_DOMAIN.CLEANING });
    }
  } catch (_) {
    asn = null;
  }

  var ownerType = (asn && asn.ownerType) || "STAFF";
  var ownerId = (asn && asn.ownerId) || "";
  var assignedByPolicy = (asn && asn.assignedByPolicy) || "OPS_CLEANING_DEFAULT";
  var assignedAt = (asn && asn.assignedAt) || new Date();

  var wiId = "";
  try {
    wiId = workItemCreate_({
      type: "CLEANING",
      status: "OPEN",
      state: "STAFF_TRIAGE",
      substate: "NEW",
      phoneE164: phone,
      propertyId: propCode,
      unitId: unitVal,
      ticketRow: "",
      metadataJson: JSON.stringify(metadata),
      ownerType: ownerType,
      ownerId: ownerId,
      assignedByPolicy: assignedByPolicy,
      assignedAt: assignedAt
    });
  } catch (err) {
    try { logDevSms_(phone, "", "CLEANING_WORKITEM_CREATE_ERR " + String(err)); } catch (_) {}
    return { workItemId: "", deduped: false };
  }

  try {
    var cache = CacheService.getDocumentCache();
    if (cache) cache.put(dedupeKey, "1", 600);
  } catch (_) {}

  // Optional: update ctx so future turns know about active cleaning work item
  try {
    if (typeof ctxUpsert_ === "function" && phone) {
      ctxUpsert_(phone, {
        activeWorkItemId: wiId,
        pendingWorkItemId: wiId,
        pendingExpected: "",
        pendingExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        lastIntent: "CLEANING"
      }, "OPS_CLEANING_CREATE");
    }
  } catch (_) {}

  return { workItemId: wiId, deduped: false };
}

/** Clear maintenance draft residue for a directory row after cleaning dispatch (Phase 1). */
function clearMaintenanceDraftResidue_(dir, dirRow, phone) {
  if (!dir || !dirRow || dirRow < 2) return;
  try {
    dalWithLock_("CLEANING_CLEAR_DRAFT_RESIDUE", function () {
      dalSetPendingIssueNoLock_(dir, dirRow, "");
      dalSetPendingUnitNoLock_(dir, dirRow, "");
      dalSetPendingStageNoLock_(dir, dirRow, "");
      dalSetPendingRowNoLock_(dir, dirRow, "");
      if (typeof DIR_COL !== "undefined" && DIR_COL.DRAFT_SCHEDULE_RAW) {
        dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).setValue("");
      }
      dalSetLastUpdatedNoLock_(dir, dirRow);
    });
    try { logDevSms_(phone || "", "", "CLEANING_CLEAR_DRAFT_RESIDUE row=" + dirRow); } catch (_) {}
  } catch (_) {}
}



// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// Ticket row + tenant queue helpers
// ─────────────────────────────────────────────────────────────────


  function findTenantTicketRows_(sheet, phone, opt) {
    opt = opt || {};
    const key = phoneKey_(phone);
    if (!key) return [];

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const n = lastRow - 1;

    const phoneVals  = sheet.getRange(2, COL.PHONE, n, 1).getValues();
    const statusVals = sheet.getRange(2, COL.STATUS, n, 1).getValues();

    function isTerminal_(stAny) {
      const st = String(stAny || "").trim().toLowerCase();
      if (!st) return false;
      return (
        st.includes("done") ||
        st.includes("closed") ||
        st.includes("completed") ||
        st.includes("complete") ||
        st.includes("canceled") ||
        st.includes("cancelled")
      );
    }

    const rows = [];
    for (let i = 0; i < n; i++) {
      const rowKey = phoneKey_(phoneVals[i][0]);
      if (rowKey !== key) continue;

      const st = String(statusVals[i][0] || "").trim().toLowerCase();
      if (!opt.includeClosed && isTerminal_(st)) continue;

      rows.push(i + 2);
    }

    // newest first
    rows.sort((a, b) => b - a);
    return rows;
  }



  function readTicketForTenant_(sheet, row) {
    if (!row || row < 2) return {};
    return {
      rowIndex: row,
      ticketId: String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim(),
      status: String(sheet.getRange(row, COL.STATUS).getValue() || "").trim(),
      prefWindow: String(sheet.getRange(row, COL.PREF_WINDOW).getValue() || "").trim(),
      property: String(sheet.getRange(row, COL.PROPERTY).getValue() || "").trim(),
      unit: String(sheet.getRange(row, COL.UNIT).getValue() || "").trim()
    };
  }



  function advanceTenantQueueOrClear_(sheet, dir, dirRow, tenantPhone, lang) {
    const phone = phoneKey_(tenantPhone);
    if (!phone || !dirRow || dirRow < 2) {
      // Fallback: at minimum clear stale directory + ctx (no tenant SMS here)
      try { dalSetPendingStage_(dir, dirRow, "", phone, "QUEUE_OR_CLEAR_FALLBACK"); } catch (_) {}
      try {
        ctxUpsert_(phone, {
          pendingWorkItemId: "",
          pendingExpected: "",
          pendingExpiresAt: "",
          activeWorkItemId: ""
        }, "QUEUE_OR_CLEAR_FALLBACK");
      } catch (_) {}
      return null;
    }

    // ── READ (no lock needed): find next queued ticket ──
    const nextRow = findNextQueuedTicketRow_(sheet, tenantPhone);

    // ── LOCK: atomic state transition (sheet + Directory in one lock; dir uses NoLock setters + one LastUpdated + one log) ──
    const claimed = dalWithLock_("QUEUE_ADVANCE_OR_CLEAR", function () {
      const now = new Date();

      if (!nextRow) {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetPendingRowNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(tenantPhone || "", "", "DAL_WRITE QUEUE_ADVANCE_OR_CLEAR row=" + dirRow); } catch (_) {}
        return null;
      }

      const currentStatus = String(sheet.getRange(nextRow, COL.STATUS).getValue() || "").trim().toLowerCase();
      if (currentStatus !== "queued") {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetPendingRowNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(tenantPhone || "", "", "DAL_WRITE QUEUE_ADVANCE_OR_CLEAR row=" + dirRow); } catch (_) {}
        return null;
      }

      sheet.getRange(nextRow, COL.STATUS).setValue("In Progress");
      sheet.getRange(nextRow, COL.LAST_UPDATE).setValue(now);

      dalSetPendingRowNoLock_(dir, dirRow, nextRow);
      dalSetPendingStageNoLock_(dir, dirRow, "SCHEDULE");
      dalSetPendingIssueNoLock_(dir, dirRow, "");
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_(tenantPhone || "", "", "DAL_WRITE QUEUE_ADVANCE_OR_CLEAR row=" + dirRow); } catch (_) {}

      return {
        nextRow: nextRow,
        ticketId: String(sheet.getRange(nextRow, COL.TICKET_ID).getValue() || "").trim()
      };
    });

    // ── UNLOCKED: clear old ctx always (safe reset) ──
    try {
      ctxUpsert_(phone, {
        pendingWorkItemId: "",
        pendingExpected: "",
        pendingExpiresAt: "",
        activeWorkItemId: ""
      }, "QUEUE_OR_CLEAR_CTX_RESET");
    } catch (_) {}

    if (!claimed) {
      try { logDevSms_(phone, "", "QUEUE_DRAIN_NONE"); } catch (_) {}
      return null;
    }

    // ── UNLOCKED: find WorkItem for claimed ticket + set state ──
    let nextWi = "";
    try {
      const wiSh = SpreadsheetApp.getActive().getSheetByName(WORKITEMS_SHEET);
      if (wiSh) {
        const wiLastRow = wiSh.getLastRow();
        if (wiLastRow >= 2) {
          const wiData = wiSh.getRange(2, 1, wiLastRow - 1, wiSh.getLastColumn()).getValues();
          const wiMap = getHeaderMap_(wiSh);

          for (let i = 0; i < wiData.length; i++) {
            const tr = Number(wiData[i][(wiMap["TicketRow"] || 9) - 1]);
            if (tr === claimed.nextRow) {
              nextWi = String(wiData[i][(wiMap["WorkItemId"] || 1) - 1] || "").trim();
              try { workItemUpdate_(nextWi, { state: "WAIT_TENANT", substate: "SCHEDULE" }); } catch (_) {}
              break;
            }
          }
        }
      }
    } catch (_) {}

    // ── UNLOCKED: set ctx expectation for SCHEDULE ──
    try {
      ctxUpsert_(phone, {
        activeWorkItemId: nextWi,
        pendingWorkItemId: nextWi,
        pendingExpected: "SCHEDULE",
        pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        lastIntent: "MAINT"
      }, "QUEUE_ADVANCE_CTX");
    } catch (_) {}

    // ── UNLOCKED: tenant SMS (TEMPLATE ONLY, no hardcoded tenant strings) ──
    try {
      const freshVars = { brandName: BRAND.name, teamName: BRAND.team };

      const dayWord = scheduleDayWord_(new Date());
      const dayLine = dayWord
        ? ("\n" + renderTenantKey_("ASK_WINDOW_DAYLINE_HINT", lang, Object.assign({}, freshVars, { dayWord: dayWord })))
        : "";

      const out = renderTenantKey_("QUEUE_NEXT_TICKET_SCHEDULE_PROMPT", lang, Object.assign({}, freshVars, {
        dayLine: dayLine
      }));

      replyNoHeaderGlobal_(phone, out);

      try { logDevSms_(phone, "", "QUEUE_DRAIN_ADVANCED row=[" + claimed.nextRow + "] tid=[" + claimed.ticketId + "]"); } catch (_) {}
    } catch (smsErr) {
      try { logDevSms_(phone, "", "QUEUE_ADVANCE_SMS_ERR " + (smsErr && smsErr.message ? smsErr.message : smsErr)); } catch (_) {}
    }

    return claimed;
  }





  function applyTenantAvailability_(sheet, phone, ticketId, preferredWindow, lang, vars) {
    const L = String(lang || "en").toLowerCase();
    const V = vars || {};

    // ===== COLUMN CONSTANTS (1-based, from your header) =====
    const COL_PHONE       = 2;   // Phone
    const COL_TICKET_ID   = 16;  // TicketID
    const COL_PREF_WINDOW = 21;  // PreferredWindow (U)
    const COL_LAST_UPDATE = 20;  // LastUpdateAt (T)

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return {
        ok: false,
        msg: tenantMsg_("TENANT_NO_TICKETS_FOUND", L, V)
      };
    }

    const phoneKey = phoneKey_(phone);
    const targetId = String(ticketId || "").trim().toUpperCase();

    // Read only what we need (fast + safe)
    const data = sheet.getRange(
      2,
      1,
      lastRow - 1,
      Math.max(COL_PREF_WINDOW, COL_LAST_UPDATE)
    ).getValues();

    // Scan bottom-up (most recent tickets first)
    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];

      const rowTicketId = String(row[COL_TICKET_ID - 1] || "").trim().toUpperCase();
      if (rowTicketId !== targetId) continue;

      const rowPhoneKey = phoneKey_(row[COL_PHONE - 1]);
      if (rowPhoneKey !== phoneKey) {
        return {
          ok: false,
          msg: tenantMsg_("TENANT_TICKET_PHONE_MISMATCH", L, V)
        };
      }

      const sheetRow = i + 2; // account for header row

      sheet.getRange(sheetRow, COL_PREF_WINDOW)
        .setValue(String(preferredWindow || "").trim());

      sheet.getRange(sheetRow, COL_LAST_UPDATE)
        .setValue(new Date());

      return {
        ok: true,
        msg: tenantMsg_(
          "TENANT_PREF_WINDOW_UPDATED",
          L,
          Object.assign({}, V, {
            ticketId: String(ticketId || "").trim(),
            window: String(preferredWindow || "").trim()
          })
        )
      };
    }

    return {
      ok: false,
      msg: tenantMsg_("MGR_TICKET_NOT_FOUND", L, {
        ref: String(ticketId || "").trim()
      })
    };
  }






  function upgradeTicketIdIfUnknown_(sheet, row, propertyName) {
    if (!row || row < 2) throw new Error("upgradeTicketIdIfUnknown_: bad row=" + row);

    const prop = String(propertyName || "").trim();
    if (!prop) throw new Error("upgradeTicketIdIfUnknown_: empty propertyName");

    const current = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
    if (!current) throw new Error("upgradeTicketIdIfUnknown_: TicketID blank at row=" + row);

    if (!/^UNK-/i.test(current)) return; // already upgraded

    const createdAt = sheet.getRange(row, COL.CREATED_AT).getValue();
    const when = createdAt instanceof Date ? createdAt : new Date();

    const newId = makeTicketId_(prop, when, row);

    if (!newId || /^UNK-/i.test(newId)) {
      throw new Error("upgradeTicketIdIfUnknown_: makeTicketId_ returned " + newId);
    }

    sheet.getRange(row, COL.TICKET_ID).setValue(newId);
  }




  function sendCancelReceiptForRow_(sheet, row) {
    withWriteLock_("CANCEL_RECEIPT_ROW_" + row, () => {
      const alreadySent = sheet.getRange(row, COL.CANCEL_MSG_SENT).getValue();
      if (alreadySent === true || String(alreadySent).toLowerCase() === "true") return;

      const phone = String(sheet.getRange(row, COL.PHONE).getValue() || "").trim();
      const ticketId = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
      if (!phone || !ticketId) return;

      const props = PropertiesService.getScriptProperties();

      // ✅ Template-driven (no hardcoded tenant strings)
      const msg = tenantMsg_("TICKET_CANCELED_RECEIPT", "en", {
        brandName: BRAND.name,
        teamName: BRAND.team,
        ticketId: ticketId
      });

      sendSms_(
        props.getProperty("TWILIO_SID"),
        props.getProperty("TWILIO_TOKEN"),
        props.getProperty("TWILIO_NUMBER"),
        phone,
        msg
      );

      // ✅ mark ONLY after sending succeeds
      sheet.getRange(row, COL.CANCEL_MSG_SENT).setValue(true);
      sheet.getRange(row, COL.CANCEL_MSG_SENT_AT).setValue(new Date());
    });
  }


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (dependency wave 2)
// emergency row helpers
// ─────────────────────────────────────────────────────────────────


  function ticketIdFromRow_(sheet, row) {
    try {
      return String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();
    } catch (_) {
      return "";
    }
  }




  function looksLikeEmergencyText_(text) {
    return !!detectEmergencyKind_(text);
  }







  function isEmergencyRow_(sheet, row) {
    if (!row || row < 2) return false;
    const v = sheet.getRange(row, COL.EMER).getValue();
    const s = String(v || "").trim().toLowerCase();
    return v === true || s === "yes" || s === "y" || s === "true" || s === "1";
  }
