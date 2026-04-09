/**
 * INTAKE_RUNTIME.gs — Propera Intake Flow Runtime (Pack A)
 *
 * OWNS:
 *   - Stage authority, draft-next-stage, issue buffer, intake turn gates
 *   - Shared schedule parser (parsePreferredWindowShared_*; merged from SCHEDULE_PARSER.gs)
 *
 * DOES NOT OWN (never add these here):
 *   - Canonical semantic package shaping -> PROPERA_INTAKE_PACKAGE.gs
 *   - Staff resolver / lifecycle authority -> STAFF_RESOLVER.gs, LIFECYCLE_ENGINE.gs
 *
 * ENTRY POINTS:
 *   - properaResolveStageAuthority_(), properaCompileTurnContext_(), and helpers in each section
 *
 * DEPENDENCIES (reads from):
 *   - ppGet_, classifyTenantSignals_, properaCommunicationGate_, callers supply sheet/session context
 *
 * FUTURE MIGRATION NOTE:
 *   - Intake flow runtime service; Shared_* schedule helpers become a small time-window library
 *
 * SECTIONS IN THIS FILE:
 *   1. Stage authority & runtime — gates and CIG integration
 *   2. Schedule parser (Shared) — free-text -> { label, start, end, kind }
 */
// ===================================================================
// ===== INTAKE RUNTIME (PACK A: FLOW RUNTIME) =======================
// ===================================================================

function properaStageAuthorityStateType_(stage, pendingRow) {
  var s = String(stage || "").trim().toUpperCase();
  var pr = Number(pendingRow || 0) || 0;
  var continuationStages = ["UNIT", "SCHEDULE", "DETAIL", "EMERGENCY_DONE"];
  var draftStages = ["PROPERTY", "PROPERTY_AND_UNIT", "UNIT", "ISSUE", "FINALIZE_DRAFT", "INTENT_PICK", "SCHEDULE_DRAFT_MULTI", "SCHEDULE_PRETICKET", "ATTACH_CLARIFY"];
  if (!s) return pr > 0 ? "CONTINUATION" : "NEW";
  if (continuationStages.indexOf(s) !== -1) return pr > 0 ? "CONTINUATION" : "DRAFT";
  if (draftStages.indexOf(s) !== -1) return "DRAFT";
  return pr > 0 ? "CONTINUATION" : "DRAFT";
}

function properaResolveStageAuthority_(phone, opts) {
  opts = opts || {};
  var out = {
    stage: "",
    source: "",
    stateType: "NEW",
    pendingRow: 0,
    pendingStage: "",
    canonicalExpected: "",
    canonicalActive: false,
    ctxExpected: "",
    sessionExpected: "",
    note: ""
  };

  var dir = opts.dir || null;
  var dirRow = Number(opts.dirRow || 0) || 0;
  var ctx = (opts.ctx !== undefined) ? opts.ctx : null;
  var session = (opts.session !== undefined) ? opts.session : null;

  try {
    if (!dir && phone) dir = getSheet_(DIRECTORY_SHEET_NAME);
  } catch (_) {}
  try {
    if (!dirRow && dir && phone && typeof findDirectoryRowByPhone_ === "function") {
      dirRow = Number(findDirectoryRowByPhone_(dir, phone) || 0) || 0;
    }
  } catch (_) {}
  try {
    if (ctx === null && phone && typeof ctxGet_ === "function") ctx = ctxGet_(phone) || {};
  } catch (_) { ctx = ctx || {}; }
  try {
    if (session === null && phone && typeof sessionGet_ === "function") session = sessionGet_(phone) || {};
  } catch (_) { session = session || {}; }
  if (!ctx || typeof ctx !== "object") ctx = {};
  if (!session || typeof session !== "object") session = {};

  var pendingRow = 0;
  var pendingStage = "";
  try {
    if (dir && dirRow >= 2) {
      if (typeof dalGetPendingRow_ === "function") pendingRow = Number(dalGetPendingRow_(dir, dirRow) || 0) || 0;
      if (typeof dalGetPendingStage_ === "function") pendingStage = String(dalGetPendingStage_(dir, dirRow) || "").trim().toUpperCase();
    }
  } catch (_) {}
  out.pendingRow = pendingRow;
  out.pendingStage = pendingStage;

  var ctxExp = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();
  var sessionStage = String((session && (session.stage || session.expected)) || "").trim().toUpperCase();
  out.ctxExpected = ctxExp;
  out.sessionExpected = sessionStage;

  var canonicalExpected = "";
  var canonicalActive = false;
  try {
    if (phone) {
      var sh = ensureCanonicalIntakeSheet_();
      var rec = canonicalIntakeLoadNoLock_(sh, phone);
      canonicalActive = !!(rec && rec.activeIntake);
      canonicalExpected = String((rec && rec.expectedNext) || "").trim().toUpperCase();
    }
  } catch (_) {}
  out.canonicalActive = canonicalActive;
  out.canonicalExpected = canonicalExpected;

  var continuationStages = ["UNIT", "SCHEDULE", "DETAIL"];
  var draftStages = ["PROPERTY", "PROPERTY_AND_UNIT", "UNIT", "ISSUE", "FINALIZE_DRAFT", "INTENT_PICK", "SCHEDULE_DRAFT_MULTI", "SCHEDULE_PRETICKET"];

  if (ctxExp === "ATTACH_CLARIFY") {
    out.stage = "ATTACH_CLARIFY";
    out.source = "ctx_latch";
    out.stateType = "DRAFT";
    out.note = "clarify_latch";
    return out;
  }

  if (canonicalActive && canonicalExpected) {
    out.stage = canonicalExpected;
    out.source = "canonical_intake";
    out.stateType = properaStageAuthorityStateType_(canonicalExpected, pendingRow);
    return out;
  }

  if (pendingRow < 2 && continuationStages.indexOf(pendingStage) !== -1) {
    out.stage = "ISSUE";
    out.source = "directory_normalized_from_continuation";
    out.stateType = "DRAFT";
    out.note = "pending_row_missing_for_continuation";
    return out;
  }

  if (pendingRow < 2 && pendingStage === "SCHEDULE_DRAFT_MULTI") {
    out.stage = "SCHEDULE_DRAFT_MULTI";
    out.source = "directory_pending_stage";
    out.stateType = "DRAFT";
    return out;
  }

  if (pendingRow <= 0 && sessionStage) {
    if (draftStages.indexOf(sessionStage) !== -1) {
      out.stage = sessionStage;
      out.source = "session";
      out.stateType = "DRAFT";
      return out;
    }
    if (continuationStages.indexOf(sessionStage) !== -1) {
      out.stage = sessionStage;
      out.source = "session";
      out.stateType = "CONTINUATION";
      return out;
    }
  }

  if (pendingStage === "EMERGENCY_DONE") {
    out.stage = "EMERGENCY_DONE";
    out.source = "directory_pending_stage";
    out.stateType = "CONTINUATION";
    return out;
  }

  if (pendingRow > 0 && continuationStages.indexOf(pendingStage) !== -1) {
    out.stage = pendingStage;
    out.source = "directory_pending_stage";
    out.stateType = "CONTINUATION";
    return out;
  }

  if (pendingRow <= 0 && draftStages.indexOf(pendingStage) !== -1) {
    out.stage = pendingStage;
    out.source = "directory_pending_stage";
    out.stateType = "DRAFT";
    return out;
  }

  if (ctxExp) {
    if (continuationStages.indexOf(ctxExp) !== -1 && pendingRow > 0) {
      out.stage = ctxExp;
      out.source = "ctx";
      out.stateType = "CONTINUATION";
      return out;
    }
    if (draftStages.indexOf(ctxExp) !== -1 && pendingRow <= 0) {
      out.stage = ctxExp;
      out.source = "ctx";
      out.stateType = "DRAFT";
      return out;
    }
  }

  if (pendingRow > 0) {
    var fallbackStage = "";
    if (continuationStages.indexOf(pendingStage) !== -1) fallbackStage = pendingStage;
    else if (continuationStages.indexOf(ctxExp) !== -1) fallbackStage = ctxExp;
    else fallbackStage = "SCHEDULE";
    out.stage = fallbackStage;
    out.source = "active_ticket_fallback";
    out.stateType = "CONTINUATION";
    return out;
  }

  return out;
}

function resolveEffectiveTicketState_(dir, dirRow, ctx, session) {
  var phone = String((ctx && (ctx.phoneE164 || ctx.phone || ctx.actorId)) || (session && (session.phoneE164 || session.phone || session.actorId)) || "").trim();
  var auth = properaResolveStageAuthority_(phone, { dir: dir, dirRow: dirRow, ctx: ctx, session: session });
  if (auth.pendingRow > 0) {
    var emCont = (typeof isEmergencyContinuation_ === "function") ? isEmergencyContinuation_(dir, dirRow, ctx, phone || "") : { isEmergency: false, source: "" };
    if (emCont.isEmergency) return { stateType: "CONTINUATION", stage: "EMERGENCY_DONE" };
  }
  return { stateType: String(auth.stateType || "NEW"), stage: String(auth.stage || "") };
}

function draftDecideNextStage_(phone, dir, dirRow) {
  if (!dirRow || dirRow < 2) return "PROPERTY";

  var propCode = dalGetPendingProperty_(dir, dirRow).code;
  var issue = dalGetPendingIssue_(dir, dirRow);

  if (!propCode) return "PROPERTY";

  var buf = getIssueBuffer_(dir, dirRow);
  var hasIssue = Boolean(issue) || (buf && buf.length >= 1);

  if (!hasIssue && phone && typeof sessionGet_ === "function") {
    try {
      var sess = sessionGet_(phone) || {};
      var sessIssue = sess.draftIssue ? String(sess.draftIssue || "").trim() : "";
      var sessBuf = sess.issueBuf;
      hasIssue = Boolean(sessIssue) || (Array.isArray(sessBuf) && sessBuf.length >= 1);
    } catch (_) {}
  }

  if (!hasIssue) return "ISSUE";
  return "READY";
}

function singleLine_(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+/g, " | ").trim();
}

function getIssueBuffer_(dir, dirRow) {
  if (!dir || !dirRow || dirRow < 2) return [];
  try {
    var raw = String(dir.getRange(dirRow, DIR_COL.ISSUE_BUF_JSON).getValue() || "").trim();
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function setIssueBuffer_(dir, dirRow, arr) {
  if (!dir || !dirRow || dirRow < 2) return;
  var val = Array.isArray(arr) ? JSON.stringify(arr) : "[]";
  val = singleLine_(val);
  dir.getRange(dirRow, DIR_COL.ISSUE_BUF_JSON).setValue(val);
}

function issueTextKey_(s) {
  var t = String(s || "").toLowerCase().trim();
  if (!t) return "";
  t = t.replace(/^[\s\-\,\.\|:;]+/, "");
  t = t.replace(/^(and|also|plus)\s+/i, "");
  t = t.replace(/[^\w\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Deterministic bag-of-words fingerprint: strips common function words and sorts tokens.
 * Collapses paraphrases that issueTextKey_ would keep distinct (e.g. word-order / filler differences),
 * so finalize dedupe and ticket grouping do not split one symptom into multiple tickets.
 */
function issueTextStableKey_(s) {
  var t = issueTextKey_(s);
  if (!t) return "";
  var parts = t.split(/\s+/).filter(Boolean);
  var STOP = {
    a: 1, an: 1, the: 1, in: 1, on: 1, at: 1, to: 1, for: 1, of: 1, with: 1, by: 1,
    is: 1, are: 1, was: 1, were: 1, be: 1, been: 1, being: 1, am: 1,
    and: 1, or: 1, but: 1, not: 1,
    my: 1, your: 1, our: 1, their: 1, its: 1,
    this: 1, that: 1, these: 1, those: 1, it: 1,
    as: 1, from: 1, into: 1
  };
  var kept = [];
  for (var i = 0; i < parts.length; i++) {
    var w = parts[i];
    if (!w || STOP[w]) continue;
    kept.push(w);
  }
  if (!kept.length) return t;
  kept.sort();
  return kept.join(" ");
}

function mergedIssueFromBuffer_(issue, buf, maxLen) {
  var collect = [];
  var hi = String(issue || "").trim();
  if (hi) {
    var headerParts = hi.split(/\s*\|\s*/);
    for (var hp = 0; hp < headerParts.length; hp++) {
      var seg = String(headerParts[hp] || "").trim();
      if (seg.length >= 4) collect.push(seg);
    }
  }
  for (var j = 0; j < Math.min(5, (buf || []).length); j++) {
    var part = (buf[j] && buf[j].rawText) ? String(buf[j].rawText).trim().slice(0, 120) : "";
    if (part.length >= 4) collect.push(part);
  }
  var seen = {};
  var uniq = [];
  for (var u = 0; u < collect.length; u++) {
    var k = issueTextKey_(collect[u]);
    if (!k || seen[k]) continue;
    seen[k] = 1;
    uniq.push(collect[u]);
  }
  if (uniq.length === 0) return "";
  var rankMerge = function (tx) {
    if (typeof properaInferCanonicalLocationPack_ === "function") {
      var pk = properaInferCanonicalLocationPack_(tx, "");
      var lt = String(pk && pk.locationType || "UNIT").toUpperCase();
      if (lt === "UNIT") return 0;
      if (lt === "COMMON_AREA" || lt === "BUILDING_SYSTEM" || lt === "EXTERIOR") return 2;
      return 1;
    }
    var loc = inferLocationTypeOnClause_(tx);
    if (loc && loc.ok && loc.locationType === "UNIT") return 0;
    if (loc && loc.ok && loc.locationType === "COMMON_AREA") return 2;
    return 1;
  };
  uniq.sort(function (a, b) { return rankMerge(a) - rankMerge(b); });
  var merged = uniq[0];
  if (uniq.length > 1) {
    merged += "\n\nAdditional items:";
    for (var s = 1; s < uniq.length; s++) {
      merged += "\n- " + uniq[s];
    }
  }
  var cap = (typeof maxLen === "number" && maxLen > 0) ? maxLen : 900;
  if (merged.length > cap) merged = merged.slice(0, cap);
  return merged;
}

/** Append one item with fragment coalescing; call inside withWriteLock_. */
function appendIssueBufferItem_(dir, dirRow, rawText, sourceStage) {
  if (!dir || !dirRow || dirRow < 2) return;
  var normalized = String(rawText || "").trim();
  if (!normalized) return;
  var buf = getIssueBuffer_(dir, dirRow);
  // Deterministic de-dupe: same normalized text should not exist twice.
  // This prevents double-append from draftUpsert + SCHEDULE_ADD in the same inbound.
  for (var i = buf.length - 1; i >= 0; i--) {
    var rt = String((buf[i] && buf[i].rawText) || "").trim();
    if (rt && rt === normalized) {
      try { logDevSms_("", "", "ISSUEBUF_DEDUP_SKIP match=1"); } catch (_) {}
      return;
    }
  }
  var st = String(sourceStage || "").trim().toUpperCase();
  var now = new Date();
  var merge = false;
  if (!merge && buf.length > 0) {
    // If this is clearly a continuation fragment for the last item, merge into last rawText instead of appending.
    var last = buf[buf.length - 1];
    var lastText = String(last.rawText || "").trim();
    if (lastText) {
      var lastWords = lastText.toLowerCase().split(/\s+/).filter(Boolean);
      var newWords = normalized.toLowerCase().split(/\s+/).filter(Boolean);
      // overlap detection: last tail matches new head on >=2 words
      var overlap = 0;
      var maxCheck = Math.min(5, lastWords.length, newWords.length);
      for (var ow = 1; ow <= maxCheck; ow++) {
        var a = lastWords.slice(lastWords.length - ow).join(" ");
        var b2 = newWords.slice(0, ow).join(" ");
        if (a === b2) overlap = ow;
      }
      if (overlap >= 2) {
        last.rawText = (String(last.rawText || "").trim() + " " + normalized).replace(/\s+/g, " ").trim().slice(0, 500);
        merge = true;
      }
    }
  }
  if (!merge) {
    var clauseType = (typeof classifyIssueClauseType_ === "function") ? classifyIssueClauseType_(normalized) : "";
    var clauseScore = (typeof scoreIssueClause_ === "function") ? scoreIssueClause_(normalized, clauseType) : -999;
    if (st !== "SCHEDULE_ADD" && st !== "SCHEMA" && clauseType === "request") {
      try { logDevSms_("", "", "CLAUSE_SKIPPED_REQUEST text=[" + normalized.slice(0, 40) + "]"); } catch (_) {}
      try { logDevSms_("", "", "ISSUEBUF_APPEND type=[" + clauseType + "] score=[" + clauseScore + "] text=[" + (normalized.slice(0, 40) || "") + "] SKIP non-problem"); } catch (_) {}
      return;
    }
    if (st !== "SCHEDULE_ADD" && st !== "SCHEMA" && (clauseType !== "problem" || clauseScore < PROBLEM_THRESHOLD)) {
      try { logDevSms_("", "", "ISSUEBUF_APPEND type=[" + clauseType + "] score=[" + clauseScore + "] text=[" + (normalized.slice(0, 40) || "") + "] SKIP non-problem"); } catch (_) {}
      return;
    }
    buf.push({
      rawText: normalized.slice(0, 500),
      createdAt: now.toISOString(),
      sourceStage: st
    });
    if (buf.length > 50) buf = buf.slice(-50);
    try { logDevSms_("", "", "ISSUEBUF_APPEND type=[" + clauseType + "] text=[" + (normalized.slice(0, 40) || "") + "]"); } catch (_) {}
  }
  setIssueBuffer_(dir, dirRow, buf);
  var countBefore = merge ? buf.length : buf.length - 1;
  var countAfter = buf.length;
  try { logDevSms_("", "", "ISSUEBUF_UPDATE action=" + (merge ? "MERGE" : "APPEND") + " count_before=" + countBefore + " count_after=" + countAfter + " reason=" + st); } catch (_) {}
}

function migrateDirIssueBufFromHandoff_() {
  var dir;
  try { dir = getSheet_(DIRECTORY_SHEET_NAME); } catch (_) { return; }
  if (!dir || typeof DIR_COL === "undefined") return;
  var lastRow = dir.getLastRow();
  if (lastRow < 2) return;
  var migrated = 0;
  var skipped = 0;
  for (var r = 2; r <= lastRow; r++) {
    var raw = String(dir.getRange(r, DIR_COL.HANDOFF_SENT).getValue() || "").trim();
    if (raw.charAt(0) !== "[" && raw.charAt(0) !== "{") continue;
    var existingBuf = String(dir.getRange(r, DIR_COL.ISSUE_BUF_JSON).getValue() || "").trim();
    if (existingBuf) { skipped++; continue; }
    var arr = [];
    try { arr = JSON.parse(singleLine_(raw)); } catch (_) {}
    if (!Array.isArray(arr)) arr = [];
    dalWithLock_("MIGRATE_ISSUE_BUF", function () {
      setIssueBuffer_(dir, r, arr);
      dir.getRange(r, DIR_COL.HANDOFF_SENT).setValue(true);
      dalSetLastUpdatedNoLock_(dir, r);
      try { logDevSms_("", "", "DAL_WRITE MIGRATE_ISSUE_BUF row=" + r); } catch (_) {}
    });
    migrated++;
  }
  try { logDevSms_("", "", "migrateDirIssueBufFromHandoff_ migrated=" + migrated + " skipped=" + skipped); } catch (_) {}
}

function runIntakePreGates_(opts) {
  opts = opts || {};
  var mode = String(opts.mode || "");
  var e = opts.e || {};
  var dir = opts.dir || null;
  var dirRow = Number(opts.dirRow || 0);
  var bodyTrim = String(opts.bodyTrim || "");
  var resolverCtx = opts.resolverCtx || {};
  var effectiveStage = String(opts.effectiveStage || "");
  var pendingStage = String(opts.pendingStage || "");
  var phone = String(opts.phone || "");
  var lang = String(opts.lang || "en");
  var channel = String(opts.channel || "SMS");
  var baseVars = opts.baseVars || {};
  var turnFacts = opts.turnFacts || {};
  var replyNoHeaderFn = opts.replyNoHeaderFn;

  if (mode === "TENANT" && dirRow > 0 && bodyTrim) {
    var dirStage = String(getDirPendingStage_(dir, dirRow) || "").trim().toUpperCase();
    var ctxExp = "";
    try {
      if (resolverCtx && resolverCtx.pendingExpected) {
        ctxExp = String(resolverCtx.pendingExpected || "");
      }
    } catch (_) {}
    ctxExp = String(ctxExp || "").trim().toUpperCase();
    var expectSchedule = (dirStage === "SCHEDULE") || (ctxExp === "SCHEDULE") || (String(ctxExp || "").indexOf("SCHEDULE") >= 0);
    if (expectSchedule && (typeof isScheduleLike_ === "function") && isScheduleLike_(bodyTrim)) {
      var stForce = String(effectiveStage || "").toUpperCase();
      var prForce = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
      if (stForce === "SCHEDULE_DRAFT_MULTI" || stForce === "SCHEDULE_DRAFT_SINGLE") {
        try { logDevSms_(phone, bodyTrim, "SCHEDULE_FORCE_SKIP stage=" + stForce + " pr=" + prForce); } catch (_) {}
      } else if (prForce < 2) {
        try { logDevSms_(phone, bodyTrim, "SCHEDULE_FORCE_SKIP_NO_ROW stage=" + stForce + " pr=" + prForce); } catch (_) {}
      } else {
        effectiveStage = "SCHEDULE";
        pendingStage = "SCHEDULE";
        try {
          dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "SCHEDULE_FORCE_STAGE");
          try { logDevSms_(phone, bodyTrim, "SCHEDULE_FORCE_ROUTE schedule_like"); } catch (_) {}
        } catch (_) {}
      }
    }
  }

  try {
    var modeNow = String((e && e.parameter && e.parameter._mode) || "TENANT").toUpperCase();
    var stageNow2 = String(getDirPendingStage_(dir, dirRow) || "").trim();
    var effStageUp = String(effectiveStage || "").toUpperCase();
    if (modeNow === "TENANT" && dirRow > 0 && !stageNow2 && effStageUp !== "SCHEDULE") {
      var draftStages = ["PROPERTY", "UNIT", "ISSUE", "FINALIZE_DRAFT", "INTENT_PICK", "SCHEDULE_DRAFT_MULTI", "SCHEDULE_PRETICKET"];
      if (effStageUp && draftStages.indexOf(effStageUp) >= 0) {
        try { logDevSms_(phone, bodyTrim, "PRE_GATE_SKIP draft_stage=" + effStageUp + " (no generic menu)"); } catch (_) {}
      } else {
        var rawTrim = String(bodyTrim || "").trim();
        var lower = rawTrim.toLowerCase();
        var isGreeting = (typeof looksLikeGreetingOnly_ === "function") && looksLikeGreetingOnly_(lower);
        var isAck = looksLikeAckOnly_(lower);
        var actionable = !!String((turnFacts && turnFacts.issue) || "").trim();
        var hasDraftData = false;
        try {
          var dirProp = String(dir.getRange(dirRow, 2).getValue() || "").trim();
          var dirIssue = String(dir.getRange(dirRow, 5).getValue() || "").trim();
          var dirUnit = String(dir.getRange(dirRow, 6).getValue() || "").trim();
          hasDraftData = !!(dirProp || dirIssue || dirUnit);
        } catch (_) {}
        if ((isGreeting || isAck || !actionable) && !hasDraftData) {
          var ogH = (typeof dispatchOutboundIntent_ === "function")
            ? dispatchOutboundIntent_({
                intentType: "SHOW_HELP",
                recipientType: "TENANT",
                recipientRef: phone,
                lang: lang,
                channel: channel,
                deliveryPolicy: "NO_HEADER",
                vars: baseVars || {},
                meta: { source: "HANDLE_SMS_CORE", stage: "CONFIRM_GATE", flow: "MAINTENANCE_INTAKE" }
              })
            : { ok: false };
          if (!(ogH && ogH.ok) && typeof replyNoHeaderFn === "function") replyNoHeaderFn(renderTenantKey_("HELP_INTRO", lang, baseVars));
          try { logDevSms_(phone, bodyTrim, "SKIP_CONFIRM_GATE non_issue greeting=" + String(!!isGreeting) + " ack=" + String(!!isAck) + " actionable=" + String(!!actionable), "CONFIRM_GATE_SKIP"); } catch (_) {}
          return { handled: true, effectiveStage: effectiveStage, pendingStage: pendingStage };
        }
      }
    }
  } catch (_) {}

  return { handled: false, effectiveStage: effectiveStage, pendingStage: pendingStage };
}

function handleTenantCommandsAndAwaiting_(opts) {
  opts = opts || {};
  var sheet = opts.sheet || null;
  var dir = opts.dir || null;
  var dirRow = Number(opts.dirRow || 0);
  var digits = String(opts.digits || "");
  var phone = String(opts.phone || "");
  var bodyTrim = String(opts.bodyTrim || "");
  var dayWord = String(opts.dayWord || "");
  var lang = String(opts.lang || "en");
  var dayLine = String(opts.dayLine || "");
  var replyFn = opts.replyFn;

  function tmsg_(key, vars) {
    return tenantMsg_(key, lang, vars || {});
  }

  function normalizeTenantCmd_(s) {
    var t = String(s || "").toLowerCase().trim();
    t = t.replace(/^[^a-z0-9]+/g, "");
    t = t.replace(/[^a-z0-9\-\s]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/^(hey|hi|hello|yo|pls|please|can you|could you|i want to|i need to)\s+/g, "");
    return t.trim();
  }

  function hasTicketIdInline_(s) {
    return /[a-z]{3,8}\-\d{6,}\-\d{3,6}/i.test(String(s || ""));
  }

  function isCommandOverride_(cmdNow) {
    return /^(help|info|stop|start|options|menu|my\s+tickets|my\s+ticket|tickets?|requests?|status|ticket\s+status|cancel|cancel\s+ticket|cancel\s+request|change\s+time|update\s+time|change\s+availability|update\s+availability|reschedule|start\s+over|startover|reset|restart|clear|clear\s+chat)\b/.test(
      String(cmdNow || "")
    );
  }

  var cmdLocal = normalizeTenantCmd_(bodyTrim);
  var awaitingLocal = getAwaiting_(digits);
  var isCmdOverrideLocal = isCommandOverride_(cmdLocal);

  if (awaitingLocal && isCmdOverrideLocal) {
    try { clearAwaiting_(digits); } catch (err) {
      Logger.log("AWAIT_CLEAR_ON_OVERRIDE err=" + err);
      try { logDevSms_(phone, bodyTrim, "AWAIT_CLEAR_ON_OVERRIDE", String(err)); } catch (_) {}
    }
  }

  if (cmdLocal === "start over" || cmdLocal === "startover" || cmdLocal === "reset" || cmdLocal === "restart") {
    try {
      dalWithLock_("DIR_RESET_TENANT", function () {
        dalSetPendingIssueNoLock_(dir, dirRow, "");
        try { logDevSms_(phone, bodyTrim, "ISSUE_WRITE site=[TENANT_RESET_CMD] val=[CLEAR_RESET]"); } catch (_) {}
        dalSetPendingUnitNoLock_(dir, dirRow, "");
        dalSetPendingRowNoLock_(dir, dirRow, "");
        dalSetPendingStageNoLock_(dir, dirRow, "");
        dalSetLastUpdatedNoLock_(dir, dirRow);
        try { logDevSms_(phone || "", "", "DAL_WRITE DIR_RESET_TENANT row=" + dirRow); } catch (_) {}
      });
    } catch (err) {
      Logger.log("CMD_RESET_LOCK_ERR " + err);
      try { logDevSms_(phone, bodyTrim, "CMD_RESET_LOCK_ERR", String(err)); } catch (_) {}
    }
    if (typeof replyFn === "function") replyFn(tmsg_("TENANT_RESET_OK", {}));
    return { handled: true };
  }

  if (cmdLocal === "options" || cmdLocal === "menu" || cmdLocal === "options menu") {
    if (typeof replyFn === "function") replyFn(tmsg_("TENANT_OPTIONS_MENU", {}));
    return { handled: true };
  }

  if (/^(my\s+)?tickets?\b/.test(cmdLocal) || /^(my\s+)?requests?\b/.test(cmdLocal)) {
    var outTickets = listMyTickets_(sheet, phone, 5);
    if (typeof replyFn === "function") replyFn(String(outTickets && outTickets.msg ? outTickets.msg : tmsg_("TENANT_MY_TICKETS_EMPTY_FALLBACK", {})));
    return { handled: true };
  }

  if (/^status\b/.test(cmdLocal) || /^ticket\s+status\b/.test(cmdLocal)) {
    var outStatus = tenantStatusCommand_(sheet, phone, bodyTrim);
    if (typeof replyFn === "function") replyFn(String(outStatus && outStatus.msg ? outStatus.msg : tmsg_("TENANT_STATUS_FALLBACK", {})));
    return { handled: true };
  }

  if (/^(cancel\s+ticket|cancel\s+request|cancel)\b/.test(cmdLocal)) {
    var outCancel = tenantCancelTicketCommand_(sheet, dir, digits, phone, bodyTrim);
    if (typeof replyFn === "function") replyFn(String(outCancel && outCancel.msg ? outCancel.msg : tmsg_("TENANT_CANCEL_FALLBACK", {})));
    return { handled: true };
  }

  if (/^(change|update)\s+time\b/.test(cmdLocal) || /^(change|update)\s+availability\b/.test(cmdLocal) || /^reschedule\b/.test(cmdLocal)) {
    if (hasTicketIdInline_(bodyTrim)) {
      var outChange = tenantChangeTimeCommand_(sheet, dir, dirRow, phone, bodyTrim, dayWord, lang);
      if (typeof replyFn === "function") replyFn(String(outChange && outChange.msg ? outChange.msg : tmsg_("TENANT_CHANGE_TIME_FALLBACK", {})));
      return { handled: true };
    }
    var my = listMyTickets_(sheet, phone, 5);
    var ids = (my && my.ids) ? my.ids : [];
    if (!ids.length) {
      if (typeof replyFn === "function") replyFn(tmsg_("TENANT_NO_TICKETS_TO_CHANGE", {}));
      return { handled: true };
    }
    try {
      setAwaiting_(digits, "CHANGE_TIME_PICK", { ids: ids }, 900);
    } catch (err) {
      Logger.log("AWAIT_SET_PICK_ERR " + err);
      try { logDevSms_(phone, bodyTrim, "AWAIT_SET_PICK_ERR", String(err)); } catch (_) {}
      if (typeof replyFn === "function") replyFn(tmsg_("TENANT_TEMP_ERROR_TRY_AGAIN", {}));
      return { handled: true };
    }
    if (typeof replyFn === "function") replyFn(tmsg_("TENANT_CHANGE_TIME_PICK_PROMPT", { ticketsText: String(my.msg || "") }));
    return { handled: true };
  }

  if (awaitingLocal && awaitingLocal.v === "CHANGE_TIME_PICK" && !isCmdOverrideLocal) {
    var ansRaw = String(bodyTrim || "").trim();
    var idsPick = (awaitingLocal.p && awaitingLocal.p.ids) ? awaitingLocal.p.ids : [];
    var chosen = "";
    if (/^\d{1,2}$/.test(ansRaw)) {
      var n = parseInt(ansRaw, 10);
      if (n >= 1 && n <= idsPick.length) chosen = idsPick[n - 1];
    }
    if (!chosen && /^\d{1,4}$/.test(ansRaw)) {
      var suf4 = ansRaw.padStart(4, "0");
      for (var i = 0; i < idsPick.length; i++) {
        var id = String(idsPick[i] || "");
        if (id.endsWith(suf4) || id.endsWith(ansRaw)) { chosen = idsPick[i]; break; }
      }
    }
    if (!chosen) {
      var ansUp = ansRaw.toUpperCase();
      for (var j = 0; j < idsPick.length; j++) {
        if (String(idsPick[j] || "").toUpperCase() === ansUp) { chosen = idsPick[j]; break; }
      }
    }
    if (!chosen) {
      var listLines = idsPick.slice(0, 5).map(function (id2, k) {
        var s = String(id2 || "");
        return (k + 1) + ") " + s + " (" + s.slice(-4) + ")";
      }).join("\n");
      if (typeof replyFn === "function") replyFn(tmsg_("TENANT_CHANGE_TIME_PICK_REASK", { listLines: listLines }));
      return { handled: true };
    }
    try {
      setAwaiting_(digits, "CHANGE_TIME_AVAIL", { ticketId: chosen }, 900);
    } catch (err2) {
      Logger.log("AWAIT_SET_AVAIL_ERR " + err2);
      try { logDevSms_(phone, bodyTrim, "AWAIT_SET_AVAIL_ERR", String(err2)); } catch (_) {}
      if (typeof replyFn === "function") replyFn(tmsg_("TENANT_TEMP_ERROR_TRY_AGAIN", {}));
      return { handled: true };
    }
    if (typeof replyFn === "function") replyFn(tmsg_("TENANT_CHANGE_TIME_ASK_AVAIL", { ticketId: chosen, dayLine: dayLine }));
    return { handled: true };
  }

  if (awaitingLocal && awaitingLocal.v === "CHANGE_TIME_AVAIL" && !isCmdOverrideLocal) {
    var availability = String(bodyTrim || "").trim();
    var ticketId = awaitingLocal.p ? String(awaitingLocal.p.ticketId || "") : "";
    var outAvail = applyTenantAvailability_(sheet, phone, ticketId, availability);
    try { clearAwaiting_(digits); } catch (err3) {
      Logger.log("AWAIT_CLEAR_AFTER_APPLY_ERR " + err3);
      try { logDevSms_(phone, bodyTrim, "AWAIT_CLEAR_AFTER_APPLY_ERR", String(err3)); } catch (_) {}
    }
    if (typeof replyFn === "function") replyFn(String(outAvail && outAvail.msg ? outAvail.msg : tmsg_("TENANT_CHANGE_TIME_APPLIED_FALLBACK", { ticketId: ticketId })));
    return { handled: true };
  }

  return { handled: false };
}

function compileTurn_(bodyTrim, phone, lang, baseVars, cigContext) {
  var interpreted = null;
  if (bodyTrim && typeof bodyTrim === "object" && (bodyTrim.__openerInterpreted || bodyTrim.__properaIntakePackage)) {
    interpreted = bodyTrim;
  } else if (typeof properaBuildIntakePackage_ === "function") {
    interpreted = properaBuildIntakePackage_({
      bodyTrim: String(bodyTrim || ""),
      mergedBodyTrim: String(bodyTrim || ""),
      phone: phone,
      lang: lang,
      baseVarsRef: (baseVars && typeof baseVars === "object") ? baseVars : null,
      cigContext: cigContext || null
    });
    if (!interpreted || typeof interpreted !== "object") interpreted = {};
  } else {
    interpreted = {};
  }
  var safety = interpreted.safety || { isEmergency: false, emergencyType: "", skipScheduling: false, requiresImmediateInstructions: false };
  var _lc = Number(interpreted.langConfidence);
  if (!isFinite(_lc)) _lc = 0;
  if (_lc > 1) _lc = 1;
  if (_lc < 0) _lc = 0;
  var _renderLang = String(interpreted.lang || lang || "en").toLowerCase().replace(/_/g, "-");
  if (_renderLang.indexOf("-") > 0) _renderLang = _renderLang.split("-")[0];
  if (!_renderLang || _renderLang.length < 2) _renderLang = "en";
  var _semEn = "";
  try {
    _semEn = interpreted.semanticTextEnglish != null ? String(interpreted.semanticTextEnglish).trim() : "";
  } catch (_) {}
  return {
    __openerInterpreted: !!interpreted.__openerInterpreted,
    __properaIntakePackage: !!interpreted.__properaIntakePackage,
    packageVersion: interpreted.packageVersion || 1,
    lang: _renderLang,
    langSource: String(interpreted.langSource || ""),
    langConfidence: _lc,
    semanticTextEnglish: _semEn,
    issueHint: String(interpreted.issueHint != null ? interpreted.issueHint : interpreted.issue || "").trim(),
    originalText: interpreted.originalText != null ? String(interpreted.originalText) : (typeof bodyTrim === "string" ? String(bodyTrim || "") : ""),
    property: interpreted.property || null,
    unit: interpreted.unit != null ? String(interpreted.unit || "") : "",
    issue: interpreted.issue != null ? String(interpreted.issue || "") : "",
    issueMeta: interpreted.issueMeta || null,
    schedule: interpreted.schedule || null,
    safety: {
      isEmergency: !!safety.isEmergency,
      emergencyType: String(safety.emergencyType || "").trim(),
      skipScheduling: !!safety.skipScheduling,
      requiresImmediateInstructions: !!safety.requiresImmediateInstructions
    },
    location: interpreted.location || {
      locationType: "UNIT",
      locationArea: "",
      locationDetail: "",
      locationScopeBroad: "UNIT",
      locationScopeRefined: "UNIT",
      locationSource: "opener_default",
      locationConfidence: 0.5,
      locationText: (typeof bodyTrim === "string" ? String(bodyTrim || "") : String((interpreted && (interpreted.semanticTextEnglish || interpreted.issue)) || ""))
    },
    missingSlots: interpreted.missingSlots || null,
    domainHint: (typeof properaNormalizeDomainHint_ === "function")
      ? properaNormalizeDomainHint_(interpreted.domainHint)
      : String(interpreted.domainHint != null ? interpreted.domainHint : "UNKNOWN").toUpperCase().trim(),
    media: Array.isArray(interpreted.media) ? interpreted.media : [],
    assetHint: String(interpreted.assetHint != null ? interpreted.assetHint : "").trim(),
    mediaVisionInterpreted: !!interpreted.mediaVisionInterpreted,
    mediaVisionConfidence: (function () {
      var c = Number(interpreted.mediaVisionConfidence);
      return isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
    })(),
    turnType: (function () {
      var fromPkg = String(interpreted.turnType || "").trim().toUpperCase();
      var fromSig = String((interpreted.structuredSignal && interpreted.structuredSignal.turnType) || "").trim().toUpperCase();
      if (fromPkg === "OPERATIONAL_ONLY" || fromSig === "OPERATIONAL_ONLY") return "OPERATIONAL_ONLY";
      if (fromPkg && fromPkg !== "UNKNOWN") return fromPkg;
      if (fromSig && fromSig !== "UNKNOWN") return fromSig;
      return String(fromPkg || fromSig || "UNKNOWN").toUpperCase().trim();
    })(),
    conversationMove: String(interpreted.conversationMove || (interpreted.structuredSignal && interpreted.structuredSignal.conversationMove) || "NONE").toUpperCase().trim(),
    statusQueryType: String(interpreted.statusQueryType || (interpreted.structuredSignal && interpreted.structuredSignal.statusQueryType) || "NONE").toUpperCase().trim(),
    conversationalReply: String(interpreted.conversationalReply || (interpreted.structuredSignal && interpreted.structuredSignal.conversationalReply) || "").trim().slice(0, 600),
    structuredSignal: interpreted.structuredSignal && typeof interpreted.structuredSignal === "object" ? interpreted.structuredSignal : null
  };
}

function properaBuildCIGContext_(phone, ctx, dir, dirRow) {
  try {
    var props = null;
    try { props = PropertiesService.getScriptProperties(); } catch (_) {}
    var killRaw = "";
    try {
      killRaw = String((props && typeof props.getProperty === "function") ? props.getProperty("CIG_CONTEXT_ENABLED") : "").trim().toLowerCase();
    } catch (_) { killRaw = ""; }
    const enabled = !(killRaw === "0" || killRaw === "false" || killRaw === "off" || killRaw === "no");
    if (!enabled) return {};
  } catch (_) {}

  var ctxSnap = (ctx && typeof ctx === "object") ? ctx : ((typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {});
  var sessionSnap = (typeof sessionGet_ === "function") ? (sessionGet_(phone) || {}) : {};

  var pendingExpected = "";
  try {
    var authCtx = properaResolveStageAuthority_(phone, { dir: dir, dirRow: dirRow, ctx: ctxSnap, session: sessionSnap });
    pendingExpected = String((authCtx && authCtx.stage) || "").trim().toUpperCase();
  } catch (_) {}
  if (!pendingExpected) pendingExpected = String(ctxSnap.pendingExpected || "").trim().toUpperCase();
  var activeDraftStage = "";
  try {
    if (dir && dirRow && dirRow >= 2 && typeof dalGetPendingStage_ === "function") {
      activeDraftStage = String(dalGetPendingStage_(dir, dirRow) || "").trim().toUpperCase();
    }
  } catch (_) {}
  if (!activeDraftStage) activeDraftStage = String(sessionSnap.stage || "").trim().toUpperCase();

  var knownProperty = "";
  var knownUnit = "";
  var knownSchedule = null;
  var hasOpenWorkItems = false;

  try {
    if (dir && dirRow && dirRow >= 2) {
      if (typeof dalGetPendingProperty_ === "function") {
        var p = dalGetPendingProperty_(dir, dirRow) || {};
        var pCode = String(p.code || "").trim();
        var pName = String(p.name || "").trim();
        knownProperty = pName || pCode || "";
      }
      if (typeof dalGetPendingUnit_ === "function") {
        knownUnit = String(dalGetPendingUnit_(dir, dirRow) || "").trim();
      }
      if (typeof dalGetPendingRow_ === "function") {
        hasOpenWorkItems = Number(dalGetPendingRow_(dir, dirRow) || 0) >= 2;
      }
      try {
        if (typeof DIR_COL !== "undefined" && DIR_COL && typeof DIR_COL.DRAFT_SCHEDULE_RAW !== "undefined") {
          knownSchedule = String(dir.getRange(dirRow, DIR_COL.DRAFT_SCHEDULE_RAW).getValue() || "").trim() || null;
        }
      } catch (_) {}
    }
  } catch (_) {}

  var ticketSummary = "";
  try {
    if (dir && dirRow && dirRow >= 2 && typeof dalGetPendingIssue_ === "function") {
      var iss = String(dalGetPendingIssue_(dir, dirRow) || "").trim();
      if (hasOpenWorkItems && iss) ticketSummary = iss.slice(0, 220);
    }
  } catch (_) {}

  var lastOutboundType = String(ctxSnap.lastOutboundIntentType || ctxSnap.lastOutboundType || "").trim().toUpperCase();

  function cap_(s, n) {
    s = String(s || "").trim();
    return s.length > n ? s.slice(0, n).trim() : s;
  }

  return {
    activeExpectedSlot: cap_(pendingExpected, 60),
    activeDraftStage: cap_(activeDraftStage, 60),
    knownProperty: cap_(knownProperty, 120),
    knownUnit: cap_(knownUnit, 40),
    knownSchedule: (typeof knownSchedule === "string" && knownSchedule) ? cap_(knownSchedule, 220) : null,
    hasOpenWorkItems: !!hasOpenWorkItems,
    lastOutboundType: cap_(lastOutboundType, 60),
    ticketSummary: cap_(ticketSummary, 240)
  };
}

// -------------------------------------------------------------------
// PACK A ADDITIONS (moved from INTAKE_ORCHESTRATOR.gs)
// -------------------------------------------------------------------

function runIntakeOrchestration_(opts) {
  opts = opts || {};

  var e = opts.e || {};
  var mode = String(opts.mode || "");
  var dir = opts.dir || null;
  var dirRow = Number(opts.dirRow || 0);
  var phone = String(opts.phone || "");
  var originPhone = String(opts.originPhone || phone);
  var bodyTrim = String(opts.bodyTrim || "");
  var OPENAI_API_KEY = String(opts.OPENAI_API_KEY || "");
  var baseVars = opts.baseVars || {};
  var propertyCode = String(opts.propertyCode || "");
  var propertyName = String(opts.propertyName || "");
  var pendingUnit = String(opts.pendingUnit || "");
  var pendingStage = String(opts.pendingStage || "");
  var pendingRow = Number(opts.pendingRow || 0);
  var lang = String(opts.lang || "en");
  var welcomeLine = String(opts.welcomeLine || "");
  var compassNoReopenIntake = !!opts.compassNoReopenIntake;
  var _channel = String(opts.channel || "SMS");
  var OPS_CLEANING_LIVE_DIVERT_ENABLED = !!opts.OPS_CLEANING_LIVE_DIVERT_ENABLED;

  var mediaFacts = { hasMedia: false, syntheticBody: "" };
  var mergedBodyTrim = bodyTrim;
  var turnFacts = { property: null, unit: "", schedule: null, issue: "", isGreeting: false, isAck: false };
  var domainDecision = null;
  var earlyCleaningHandled = false;

  if (compassNoReopenIntake && mode === "TENANT" && dirRow > 0) {
    try {
      logDevSms_(phone, String(bodyTrim || "").slice(0, 24), "SHORT_REPLY_COMPILE_BYPASS expected=[" + String(safeParam_(e, "_compassShortReplyExpected") || "") + "]");
    } catch (_) {}
    var _sessCr = (typeof sessionGet_ === "function") ? sessionGet_(phone) || {} : {};
    if (typeof compassBuildTurnFactsFromDraftNoCompile_ === "function") {
      turnFacts = compassBuildTurnFactsFromDraftNoCompile_(dir, dirRow, phone, _sessCr, lang, bodyTrim, e);
    }
    turnFacts.lang = lang;
    try {
      logDevSms_(originPhone, "",
        "COMPILE_TURN_SKIP short_reply_lane prop=[" + (turnFacts.property ? turnFacts.property.code : "") + "]" +
        " unit=[" + String(turnFacts.unit || "") + "] issue=[" + String(!!turnFacts.issue) + "]"
      );
    } catch (_) {}
    try {
      turnFacts.meta = turnFacts.meta || {};
      turnFacts.meta.hasMediaOnly = false;
      turnFacts.meta.mediaUrls = [];
    } catch (_) {}
  } else {
    var _canonPackageMedia = (typeof parseCanonicalMediaArrayFromEvent_ === "function") ? parseCanonicalMediaArrayFromEvent_(e) : [];
    var _packageOwnsVision = _canonPackageMedia.length > 0 && typeof properaBuildIntakePackage_ === "function" && String(OPENAI_API_KEY || "").trim();
    if (_packageOwnsVision) {
      mediaFacts = { hasMedia: false, syntheticBody: "" };
      mergedBodyTrim = bodyTrim;
    } else {
      mediaFacts = (typeof imageSignalAdapter_ === "function") ? imageSignalAdapter_(e, bodyTrim, originPhone) : { hasMedia: false, syntheticBody: "" };
      mergedBodyTrim = (typeof mergeMediaIntoBody_ === "function") ? mergeMediaIntoBody_(bodyTrim, mediaFacts) : bodyTrim;
      if (mergedBodyTrim !== bodyTrim && mediaFacts.syntheticBody) {
        try { logDevSms_(originPhone, (mergedBodyTrim || "").slice(0, 80), "MEDIA_SYNTHETIC_BODY text=[" + (mergedBodyTrim || "").slice(0, 60) + "]"); } catch (_) {}
      }
    }

    try {
      var cigContext = {};
      try {
        if (typeof properaBuildCIGContext_ === "function") {
          var ctxNow = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
          cigContext = properaBuildCIGContext_(phone, ctxNow, dir, dirRow) || {};
        }
      } catch (_) {
        cigContext = {};
      }

      var compiled = compileTurn_(mergedBodyTrim, phone, lang, baseVars, cigContext);
      if (compiled) {
        turnFacts = Object.assign({}, turnFacts, {
          property: compiled.property || null,
          unit: compiled.unit != null ? compiled.unit : "",
          issue: compiled.issue != null ? compiled.issue : "",
          schedule: compiled.schedule != null ? compiled.schedule : null,
          safety: compiled.safety || turnFacts.safety || { isEmergency: false, emergencyType: "", skipScheduling: false, requiresImmediateInstructions: false },
          location: compiled.location || turnFacts.location || null,
          missingSlots: compiled.missingSlots || null,
          issueMeta: compiled.issueMeta || null,
          lang: compiled.lang != null ? compiled.lang : turnFacts.lang,
          langSource: compiled.langSource != null ? compiled.langSource : turnFacts.langSource,
          langConfidence: compiled.langConfidence != null ? compiled.langConfidence : turnFacts.langConfidence,
          issueHint: compiled.issueHint != null ? compiled.issueHint : turnFacts.issueHint,
          originalText: compiled.originalText != null ? compiled.originalText : turnFacts.originalText,
          semanticTextEnglish: compiled.semanticTextEnglish != null ? compiled.semanticTextEnglish : turnFacts.semanticTextEnglish,
          packageVersion: compiled.packageVersion != null ? compiled.packageVersion : turnFacts.packageVersion,
          __openerInterpreted: compiled.__openerInterpreted != null ? compiled.__openerInterpreted : turnFacts.__openerInterpreted,
          __properaIntakePackage: compiled.__properaIntakePackage != null ? compiled.__properaIntakePackage : turnFacts.__properaIntakePackage,
          turnType: compiled.turnType != null ? compiled.turnType : turnFacts.turnType,
          conversationMove: compiled.conversationMove != null ? compiled.conversationMove : turnFacts.conversationMove,
          statusQueryType: compiled.statusQueryType != null ? compiled.statusQueryType : turnFacts.statusQueryType,
          conversationalReply: compiled.conversationalReply != null ? compiled.conversationalReply : turnFacts.conversationalReply,
          domainHint: compiled.domainHint != null ? compiled.domainHint : turnFacts.domainHint,
          media: compiled.media != null ? compiled.media : turnFacts.media,
          assetHint: compiled.assetHint != null ? compiled.assetHint : turnFacts.assetHint,
          mediaVisionInterpreted: compiled.mediaVisionInterpreted != null ? compiled.mediaVisionInterpreted : turnFacts.mediaVisionInterpreted,
          mediaVisionConfidence: compiled.mediaVisionConfidence != null ? compiled.mediaVisionConfidence : turnFacts.mediaVisionConfidence,
          structuredSignal: compiled.structuredSignal != null ? compiled.structuredSignal : turnFacts.structuredSignal
        });
        if (turnFacts.mediaVisionInterpreted && String(turnFacts.semanticTextEnglish || "").trim()) {
          mergedBodyTrim = String(turnFacts.semanticTextEnglish).trim();
        }
      }
      try {
        if (!compassNoReopenIntake && turnFacts && turnFacts.lang) {
          var __pkgLang = String(turnFacts.lang || "").toLowerCase().replace(/_/g, "-");
          if (__pkgLang.indexOf("-") > 0) __pkgLang = __pkgLang.split("-")[0];
          if (__pkgLang && __pkgLang.length === 2) lang = __pkgLang;
        }
      } catch (_) {}
      if (!turnFacts.missingSlots) {
        turnFacts.missingSlots = {
          propertyMissing: !(turnFacts.property && turnFacts.property.code),
          unitMissing: !String(turnFacts.unit || "").trim(),
          issueMissing: !String(turnFacts.issue || "").trim(),
          scheduleMissing: !(turnFacts.schedule && String(turnFacts.schedule.raw || "").trim())
        };
      }
      try {
        var _ms = turnFacts.missingSlots || {};
        var _next = _ms.propertyMissing ? ((_ms.unitMissing && !_ms.issueMissing) ? "PROPERTY_AND_UNIT" : "PROPERTY")
          : (_ms.unitMissing ? "UNIT" : (_ms.issueMissing ? "ISSUE" : (_ms.scheduleMissing ? "SCHEDULE" : "FINALIZE_READY")));
        logDevSms_(originPhone, "",
          "OPENER_AUTH_PROGRESS property=[" + (turnFacts.property && turnFacts.property.code ? turnFacts.property.code : "") + "]" +
          " unit=[" + String(turnFacts.unit || "") + "] issue=[" + (turnFacts.issue ? "1" : "0") + "] schedule=[" + ((turnFacts.schedule && turnFacts.schedule.raw) ? "1" : "0") + "]");
        logDevSms_(originPhone, "", "OPENER_MISSING_SLOTS p=" + (_ms.propertyMissing ? "1" : "0") + " u=" + (_ms.unitMissing ? "1" : "0") + " i=" + (_ms.issueMissing ? "1" : "0") + " s=" + (_ms.scheduleMissing ? "1" : "0"));
        logDevSms_(originPhone, "", "OPENER_PROGRESS_NEXT next=[" + _next + "]");
      } catch (_) {}
      try {
        logDevSms_(originPhone, String(mergedBodyTrim || ""),
          "COMPILE_TURN prop=[" + (turnFacts.property ? turnFacts.property.code : "") + "]" +
          " unit=[" + String(turnFacts.unit || "") + "]" +
          " issue=[" + String(!!turnFacts.issue) + "]"
        );
      } catch (_) {}
    } catch (err) {
      try {
        logDevSms_(originPhone, String(mergedBodyTrim || ""),
          "COMPILE_TURN_ERR " + String(err && (err.stack || err.message) ? (err.stack || err.message) : err)
        );
      } catch (_) {}
    }

    try {
      var _canonArr = (typeof parseCanonicalMediaArrayFromEvent_ === "function") ? parseCanonicalMediaArrayFromEvent_(e) : [];
      var _numMedia = _canonArr.length || (parseInt(String(safeParam_(e, "NumMedia") || "0"), 10) || 0);
      var weakBody = (!bodyTrim) || (bodyTrim.length <= 2) || (typeof isWeakIssue_ === "function" && isWeakIssue_(bodyTrim));
      turnFacts.meta = turnFacts.meta || {};
      turnFacts.meta.hasMediaOnly = (_numMedia > 0) && weakBody;
      var _fromDed = String(safeParam_(e, "From") || "").trim().toLowerCase();
      var _chMeta = String(safeParam_(e, "_channel") || "").trim().toUpperCase();
      if (_chMeta === "TELEGRAM") turnFacts.meta.channel = "telegram";
      else turnFacts.meta.channel = (_fromDed.indexOf("whatsapp:") === 0) ? "whatsapp" : "sms";
      var _mediaUrls = _canonArr.length
        ? _canonArr.map(function (x) { return x.url; })
        : (function () {
            var o = [];
            for (var _i = 0; _i < _numMedia; _i++) {
              var _url = String(safeParam_(e, "MediaUrl" + _i) || "").trim();
              if (_url) o.push(_url);
            }
            return o;
          })();
      turnFacts.meta.mediaUrls = _mediaUrls;
      if (typeof maybeAttachMediaFactsToTurn_ === "function") maybeAttachMediaFactsToTurn_(turnFacts, mediaFacts);
      if (turnFacts.mediaVisionInterpreted && typeof properaShimMediaFactsFromPackage_ === "function") {
        maybeAttachMediaFactsToTurn_(turnFacts, properaShimMediaFactsFromPackage_(turnFacts));
      }
      if (_canonArr.length) {
        var _m0c = _canonArr[0];
        if (!turnFacts.meta.mediaFirstType || !String(turnFacts.meta.mediaFirstType).trim()) {
          var _ctCanon = _m0c && String(_m0c.contentType || _m0c.mimeType || "").trim();
          if (_ctCanon) turnFacts.meta.mediaFirstType = _ctCanon;
        }
        if (!turnFacts.meta.mediaFirstSource || !String(turnFacts.meta.mediaFirstSource).trim()) {
          var _srcCanon = _m0c && String(_m0c.source || "").trim().toLowerCase();
          if (_srcCanon) turnFacts.meta.mediaFirstSource = _srcCanon;
        }
      }
      if (mediaFacts.syntheticBody && (typeof isWeakIssue_ === "function" && !isWeakIssue_(mediaFacts.syntheticBody)) && (!bodyTrim || (typeof isWeakIssue_ === "function" && isWeakIssue_(bodyTrim)))) {
        turnFacts.meta.hasMediaOnly = false;
      }
      if (turnFacts.mediaVisionInterpreted && String(turnFacts.issueHint || turnFacts.issue || "").trim().length >= 4) {
        turnFacts.meta.hasMediaOnly = false;
      }
    } catch (_) {}
    if (turnFacts && turnFacts.lang && String(turnFacts.lang).trim()) {
      var _pkgLangR = String(turnFacts.lang).toLowerCase().replace(/_/g, "-");
      if (_pkgLangR.indexOf("-") > 0) _pkgLangR = _pkgLangR.split("-")[0];
      if (_pkgLangR.length >= 2 && _pkgLangR !== lang) {
        lang = _pkgLangR;
        welcomeLine = getWelcomeLineOnce_(dir, dirRow, lang);
        try {
          if (typeof ctxUpsert_ === "function") ctxUpsert_(phone, { lang: lang }, "package_render_lang");
        } catch (_) {}
      }
    } else {
      turnFacts.lang = lang;
    }
    try { writeTimeline_("TURN", { issue: (turnFacts.issue || "").slice(0, 80), property: turnFacts.property ? turnFacts.property.code : "", unit: (turnFacts.unit || "").slice(0, 40), schedule: (turnFacts.schedule && turnFacts.schedule.raw) ? "1" : "" }, null); } catch (_) {}

    try {
      var domainSignal = buildDomainSignal_({
        bodyTrim: bodyTrim,
        mergedBodyTrim: mergedBodyTrim,
        turnFacts: turnFacts,
        mediaFacts: mediaFacts,
        phone: phone,
        lang: lang,
        mode: mode,
        propertyCode: propertyCode,
        propertyName: propertyName,
        pendingUnit: pendingUnit,
        dirRow: dirRow,
        pendingStage: pendingStage,
        ticketStateType: "",
        OPENAI_API_KEY: OPENAI_API_KEY
      });
      domainDecision = routeOperationalDomain_(domainSignal, { mode: mode });
    } catch (_) {}
  }

  if (mode === "TENANT" && dirRow > 0 && domainDecision && domainDecision.detectedDomain === OPS_DOMAIN.CLEANING &&
      domainDecision.confidence >= 0.75 && !domainDecision.reviewOnly && OPS_CLEANING_LIVE_DIVERT_ENABLED &&
      (pendingRow <= 0 || !String(pendingStage || "").trim())) {
    try {
      var earlyResult = dispatchOperationalDomain_(domainDecision, {
        phone: phone,
        originPhone: originPhone,
        lang: lang,
        baseVars: baseVars,
        mode: mode,
        propertyCode: propertyCode,
        propertyName: propertyName,
        pendingUnit: pendingUnit,
        bodyTrim: bodyTrim,
        mergedBodyTrim: mergedBodyTrim,
        mediaFacts: mediaFacts,
        turnFacts: turnFacts,
        channel: (turnFacts.meta && turnFacts.meta.channel) ? String(turnFacts.meta.channel || "").toUpperCase() : "SMS"
      });
      if (earlyResult && earlyResult.handled) {
        earlyCleaningHandled = true;
        if (typeof clearMaintenanceDraftResidue_ === "function") clearMaintenanceDraftResidue_(dir, dirRow, phone);
        try {
          var _ogC0 = (typeof dispatchOutboundIntent_ === "function")
            ? dispatchOutboundIntent_({
                intentType: "CLEANING_WORKITEM_ACK",
                recipientType: "TENANT",
                recipientRef: phone,
                lang: lang,
                channel: _channel,
                deliveryPolicy: "NO_HEADER",
                vars: baseVars || {},
                meta: { source: "HANDLE_SMS_CORE", stage: "CLEANING_EARLY", flow: "MAINTENANCE_INTAKE" }
              })
            : { ok: false };
          if (!(_ogC0 && _ogC0.ok)) replyNoHeader_(renderTenantKey_("CLEANING_WORKITEM_ACK", lang, baseVars));
        } catch (_) {}
      }
    } catch (_) {}
  }

  return {
    mediaFacts: mediaFacts,
    mergedBodyTrim: mergedBodyTrim,
    turnFacts: turnFacts,
    lang: lang,
    welcomeLine: welcomeLine,
    domainDecision: domainDecision,
    earlyCleaningHandled: earlyCleaningHandled
  };
}

function buildIntakePromptContext_(turnFacts) {
  var tf = turnFacts || {};
  var issueHintCap = (tf && tf.issueHint) ? String(tf.issueHint).trim() : "";
  var issueBodyCap = (tf && tf.issue) ? String(tf.issue).trim() : "";
  var cap = {
    hasProp: !!(tf && tf.property && tf.property.code),
    propCode: (tf && tf.property && tf.property.code) ? String(tf.property.code) : "",
    propName: (tf && tf.property && tf.property.name) ? String(tf.property.name) : "",
    hasUnit: !!(tf && tf.unit && String(tf.unit).trim()),
    unit: (tf && tf.unit) ? String(tf.unit).trim() : "",
    hasIssue: !!(issueHintCap || issueBodyCap),
    issue: issueHintCap || issueBodyCap,
    issueHint: issueHintCap || issueBodyCap,
    hasSchedule: !!(tf && tf.schedule && tf.schedule.raw)
  };

  var openerNextStage = "";
  try {
    var msInit = tf && tf.missingSlots ? tf.missingSlots : null;
    if (msInit) {
      openerNextStage = msInit.propertyMissing ? ((msInit.unitMissing && !msInit.issueMissing) ? "PROPERTY_AND_UNIT" : "PROPERTY")
        : (msInit.unitMissing ? "UNIT" : (msInit.issueMissing ? "ISSUE" : (msInit.scheduleMissing ? "SCHEDULE" : "FINALIZE_READY")));
    }
  } catch (_) {}

  return { cap: cap, openerNextStage: openerNextStage };
}

function intakePackagedAskVars_(baseVars, turnFacts, hint) {
  var o = Object.assign({}, baseVars || {}, { issueHint: String(hint || "").trim() });
  try {
    if (typeof properaPackagedPropertyAskSupplement_ === "function") {
      Object.assign(o, properaPackagedPropertyAskSupplement_({
        structuredSignal: turnFacts && turnFacts.structuredSignal,
        issueMeta: turnFacts && turnFacts.issueMeta
      }));
    }
  } catch (_) {}
  return o;
}

// -------------------------------------------------------------------
// PACK A ADDITIONS (moved from COMPASS_SHORT_REPLY_LANE.gs)
// -------------------------------------------------------------------

function compassMergeMaintenanceExpected_(phone, ctx, dir, dirRow) {
  var parts = [];
  try {
    if (ctx && ctx.pendingExpected) parts.push(String(ctx.pendingExpected || "").trim().toUpperCase());
  } catch (_) {}
  try {
    if (typeof sessionGet_ === "function") {
      var s = sessionGet_(phone);
      if (s) {
        if (s.expected) parts.push(String(s.expected || "").trim().toUpperCase());
        if (s.stage) parts.push(String(s.stage || "").trim().toUpperCase());
      }
    }
  } catch (_) {}
  try {
    if (dir && dirRow >= 2 && typeof getDirPendingStage_ === "function") {
      var d = String(getDirPendingStage_(dir, dirRow) || "").trim().toUpperCase();
      if (d) parts.push(d);
    }
  } catch (_) {}
  var i;
  for (i = 0; i < parts.length; i++) {
    if (parts[i] === "SCHEDULE_DRAFT_MULTI" || parts[i] === "SCHEDULE_DRAFT_SINGLE") return parts[i];
  }
  for (i = 0; i < parts.length; i++) {
    if (parts[i] === "CONFIRM_CONTEXT") return parts[i];
  }
  return parts.length ? parts[0] : "";
}

function compassClassifyMaintenanceShortReply_(bodyTrim) {
  var t = String(bodyTrim || "").trim();
  var lower = t.toLowerCase();
  if (!t || t.length > 36) return null;
  if (/^\d{1,2}$/.test(t)) return null;
  // Pure gratitude / closure — must not reopen intake or re-enter finalize (align with cigNoOpFastLane_).
  var tNorm = lower.replace(/\s+/g, " ").replace(/^[\s\.\,\!\?\:\;]+|[\s\.\,\!\?\:\;]+$/g, "");
  if (/^(thanks|thank\s*you|thx|ty|tysm)\s*[!\.\?,]*$/i.test(tNorm)) return "thanks";
  if (lower === "yes" || lower === "y" || lower === "yeah" || lower === "yep") return "affirm";
  if (lower === "confirm" || lower === "confirmed" || lower === "ok" || lower === "okay" || lower === "k") return "affirm";
  if (lower.indexOf("yes ") === 0 && lower.length < 28) return "affirm";
  if (lower === "no" || lower === "n" || lower === "nope") return "reject";
  if (lower.indexOf("no ") === 0 && lower.length < 28) return "reject";
  return null;
}

function compassShortReplyStageAllowsNoReopen_(mergedExp, cls) {
  if (!cls || !mergedExp) return false;
  var exp = String(mergedExp || "").trim().toUpperCase();
  if (exp === "SCHEDULE_DRAFT_MULTI" || exp === "SCHEDULE_DRAFT_SINGLE") return cls === "affirm" || cls === "reject";
  if (exp === "CONFIRM_CONTEXT") return cls === "affirm" || cls === "reject";
  // Post-finalize / stale expected: social reply only, no second ticket.
  if (cls === "thanks" && (exp === "FINALIZE_DRAFT" || exp === "FINALIZE_READY")) return true;
  return false;
}

function compassBuildTurnFactsFromDraftNoCompile_(dir, dirRow, phone, session, lang, bodyTrim, e) {
  var tf = { property: null, unit: "", schedule: null, issue: "", isGreeting: false, isAck: false, issueMeta: null };
  try {
    if (dir && dirRow >= 2) {
      var po = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
      if (po && po.code) tf.property = { code: String(po.code || "").trim(), name: String(po.name || "").trim() };
      tf.unit = String((typeof dalGetPendingUnit_ === "function") ? dalGetPendingUnit_(dir, dirRow) || "" : "").trim();
      if (!tf.unit) tf.unit = String((typeof dalGetUnit_ === "function") ? dalGetUnit_(dir, dirRow) || "" : "").trim();
      var iss = (typeof dalGetPendingIssue_ === "function") ? String(dalGetPendingIssue_(dir, dirRow) || "").trim() : "";
      if (iss) tf.issue = iss;
      var schedCol = (typeof DIR_COL !== "undefined" && DIR_COL.DRAFT_SCHEDULE_RAW) ? DIR_COL.DRAFT_SCHEDULE_RAW : 13;
      var schedRaw = String(dir.getRange(dirRow, schedCol).getValue() || "").trim();
      if (schedRaw) tf.schedule = { raw: schedRaw };
    }
  } catch (_) {}
  session = session || {};
  if (!tf.issue && session.draftIssue) tf.issue = String(session.draftIssue || "").trim();
  if ((!tf.property || !tf.property.code) && session.draftProperty) {
    var c = String(session.draftProperty || "").trim();
    if (c) tf.property = tf.property || { code: "", name: "" };
    if (c && !tf.property.code) tf.property.code = c;
  }
  if (!tf.unit && session.draftUnit) tf.unit = String(session.draftUnit || "").trim();
  if ((!tf.schedule || !tf.schedule.raw) && session.draftScheduleRaw) tf.schedule = { raw: String(session.draftScheduleRaw || "").trim() };

  tf.meta = { hasMediaOnly: false, mediaUrls: [] };
  try {
    var _fromDed = (e && e.parameter && e.parameter.From) ? String(e.parameter.From || "").trim().toLowerCase() : "";
    tf.meta.channel = (_fromDed.indexOf("whatsapp:") === 0) ? "whatsapp" : "sms";
  } catch (_) {
    tf.meta.channel = "sms";
  }
  tf.lang = lang || "en";
  return tf;
}

function compassApplyMaintenanceShortReplyNoReopen_(e, phone, bodyTrim, ctx, dir, dirRow, numMedia) {
  var nm = Number(numMedia) || 0;
  if (nm > 0) {
    try { logDevSms_(phone || "", String(bodyTrim || "").slice(0, 24), "SHORT_REPLY_GATE_SKIP reason=[media]"); } catch (_) {}
    return false;
  }
  if (!phone || !dir || dirRow < 2) {
    try { logDevSms_(phone || "", "", "SHORT_REPLY_GATE_SKIP reason=[no_dir_row]"); } catch (_) {}
    return false;
  }
  try {
    if (typeof evaluateEmergencySignal_ === "function") {
      var em = evaluateEmergencySignal_(String(bodyTrim || ""), { phone: phone });
      if (em && em.isEmergency) {
        try { logDevSms_(phone, bodyTrim, "SHORT_REPLY_GATE_SKIP reason=[emergency_signal]"); } catch (_) {}
        return false;
      }
    }
  } catch (_) {}

  var merged = compassMergeMaintenanceExpected_(phone, ctx, dir, dirRow);
  var cls = compassClassifyMaintenanceShortReply_(bodyTrim);
  if (!merged) {
    try { logDevSms_(phone, String(bodyTrim || "").slice(0, 20), "SHORT_REPLY_GATE_SKIP reason=[no_expected]"); } catch (_) {}
    return false;
  }
  if (!cls) {
    try { logDevSms_(phone, String(bodyTrim || "").slice(0, 20), "SHORT_REPLY_GATE_SKIP reason=[not_short_token] exp=[" + merged + "]"); } catch (_) {}
    return false;
  }
  if (!compassShortReplyStageAllowsNoReopen_(merged, cls)) {
    try { logDevSms_(phone, String(bodyTrim || "").slice(0, 20), "SHORT_REPLY_GATE_SKIP reason=[stage_not_allowed] exp=[" + merged + "]"); } catch (_) {}
    return false;
  }

  e = e || {};
  e.parameter = e.parameter || {};
  e.parameter._compassNoReopenIntake = "1";
  e.parameter._compassShortReplyExpected = merged;
  e.parameter._compassShortReplyClass = cls;
  try {
    logDevSms_(phone, String(bodyTrim || "").slice(0, 24), "SHORT_REPLY_GATE_HIT expected=[" + merged + "] body=[" + String(bodyTrim || "").slice(0, 16) + "] class=[" + cls + "]");
    logDevSms_(phone, "", "SHORT_REPLY_LANE_ENTER expected=[" + merged + "]");
    logDevSms_(phone, "", "SHORT_REPLY_NO_REOPEN enforced=1");
  } catch (_) {}
  return true;
}

function runDraftStageAuthority_(opts) {
  opts = opts || {};
  var mode = String(opts.mode || "");
  var dir = opts.dir || null;
  var dirRow = Number(opts.dirRow || 0);
  var pendingRow = Number(opts.pendingRow || 0);
  var phone = String(opts.phone || "");
  var compassNoReopenIntake = !!opts.compassNoReopenIntake;
  var turnFacts = opts.turnFacts || {};
  var mergedBodyTrim = String(opts.mergedBodyTrim || "");
  var openerNextStage = String(opts.openerNextStage || "");
  var resolverCtx = opts.resolverCtx || {};
  var session = opts.session || {};

  var prevStageBeforeRecompute = "";
  var didAppendIssueThisTurn = false;
  var openerCommittedStage = "";
  var canonicalStageForAuthority = "";

  if (mode === "TENANT" && dirRow > 0) {
    if (pendingRow <= 0) {
      prevStageBeforeRecompute = (session && session.stage) ? String(session.stage).toUpperCase().trim() : "";
    } else {
      prevStageBeforeRecompute = String(dalGetPendingStage_(dir, dirRow) || "").toUpperCase();
    }
    try {
      if (!(compassNoReopenIntake && mode === "TENANT" && dirRow > 0)) {
        var draftWroteIssue = draftUpsertFromTurn_(dir, dirRow, turnFacts, mergedBodyTrim, phone, session);
        if (draftWroteIssue) didAppendIssueThisTurn = true;
      } else {
        try { logDevSms_(phone, "", "DRAFT_UPSERT_SKIP reason=[short_reply_lane]"); } catch (_) {}
      }
    } catch (_) {}
    try {
      if (typeof sessionGet_ === "function") {
        session = sessionGet_(phone) || {};
      }
    } catch (_) {}
    var brainFromPkg = { ok: false };
    try {
      if (typeof properaBrainConsumeIntakePackage_ === "function") {
        brainFromPkg = properaBrainConsumeIntakePackage_(phone, dir, dirRow, turnFacts, pendingRow);
      }
    } catch (_) {}
    if (!brainFromPkg || !brainFromPkg.ok) {
      try {
        recomputeDraftExpected_(dir, dirRow, phone, session, {
          issueMeta: (turnFacts && turnFacts.issueMeta) ? turnFacts.issueMeta : null,
          checkpoint: null,
          openerNext: openerNextStage
        });
      } catch (_) {}
    }
    if (brainFromPkg && brainFromPkg.ok && brainFromPkg.stage) {
      try {
        logDevSms_(phone, "", "PACKAGE_BRAIN_COMMIT stage=[" + String(brainFromPkg.stage || "").trim() + "] progress=[" + String(brainFromPkg.progress || "") + "]");
      } catch (_) {}
      var _brainSt = String(brainFromPkg.stage || "").trim().toUpperCase();
      var _promptOnly = { PROPERTY: 1, UNIT: 1, ISSUE: 1, SCHEDULE: 1, SCHEDULE_PRETICKET: 1 };
      if (_brainSt !== "FINALIZE_DRAFT" && _brainSt !== "EMERGENCY_DONE" && _promptOnly[_brainSt]) {
        openerCommittedStage = _brainSt;
      }
    }
    if (mode === "TENANT" && typeof sessionGet_ === "function") {
      session = sessionGet_(phone) || {};
      try {
        logDevSms_(phone, "", "SESSION_RELOAD_BEFORE_RESOLVER stage=[" + String(session.stage || "").trim() + "] exp=[" + String(session.expected || "").trim() + "] pr=" + String(pendingRow || "0"));
      } catch (_) {}
      var _resolverAuth = null;
      try {
        _resolverAuth = properaResolveStageAuthority_(phone, { dir: dir, dirRow: dirRow, ctx: resolverCtx, session: session });
      } catch (_) {}
      var _resolverCanonNext = String((_resolverAuth && _resolverAuth.source === "canonical_intake" && _resolverAuth.stage) ? _resolverAuth.stage : "").trim().toUpperCase();
      if (_resolverCanonNext) {
        canonicalStageForAuthority = _resolverCanonNext;
        if (session && session.expected !== undefined && String(session.expected || "").trim().toUpperCase() !== _resolverCanonNext) {
          try { logDevSms_(phone, "", "MIRROR_IGNORED_CANONICAL_WINS mirror=[" + String(session.expected || "").trim().toUpperCase() + "] canonical=[" + _resolverCanonNext + "]"); } catch (_) {}
        }
        resolverCtx.pendingExpected = _resolverCanonNext;
      } else if (_resolverAuth && _resolverAuth.stage) {
        resolverCtx.pendingExpected = _resolverAuth.stage;
      } else if (session && session.expected !== undefined) {
        resolverCtx.pendingExpected = session.expected;
      }
    }
  }
  try { writeTimeline_("DRAFT", { set: "prop,unit,issue,sched", appendIssue: "-", issues: (typeof getIssueBuffer_ === "function" && dirRow) ? (getIssueBuffer_(dir, dirRow) || []).length : 0, missing: "-" }, null); } catch (_) {}

  try {
    if (canonicalStageForAuthority) {
      var _openerMirrorStage = String(openerCommittedStage || "").trim().toUpperCase();
      if (_openerMirrorStage && _openerMirrorStage !== canonicalStageForAuthority) {
        try {
          logDevSms_(phone, "", "STAGE_AUTH_CANONICAL_OVERRIDE prevStage=[" + _openerMirrorStage + "] newStage=[" + canonicalStageForAuthority + "]");
        } catch (_) {}
        if (canonicalStageForAuthority === "FINALIZE_DRAFT" || canonicalStageForAuthority === "EMERGENCY_DONE") {
          openerCommittedStage = "";
        } else {
          openerCommittedStage = canonicalStageForAuthority;
        }
      }
    }
  } catch (_) {}

  return {
    prevStageBeforeRecompute: prevStageBeforeRecompute,
    didAppendIssueThisTurn: didAppendIssueThisTurn,
    openerCommittedStage: openerCommittedStage,
    canonicalStageForAuthority: canonicalStageForAuthority,
    resolverCtx: resolverCtx,
    session: session
  };
}

function runOpenerDirectPrompt_(opts) {
  opts = opts || {};
  var mode = String(opts.mode || "");
  var openerCommittedStage = String(opts.openerCommittedStage || "");
  if (!(mode === "TENANT" && openerCommittedStage)) return { handled: false };

  var phone = String(opts.phone || "");
  var sidSafe = String(opts.sidSafe || "");
  var pendingRow = Number(opts.pendingRow || 0);
  var resolverCtx = opts.resolverCtx || {};
  var e = opts.e || {};
  var bodyTrim = String(opts.bodyTrim || "");
  var lang = String(opts.lang || "en");
  var channel = String(opts.channel || "SMS");
  var baseVars = opts.baseVars || {};
  var cap = opts.cap || {};
  var packagedAskVarsForTurn = opts.packagedAskVarsForTurn;

  var openerStageUp = String(openerCommittedStage || "").toUpperCase();
  try { logDevSms_(phone, "", "OPENER_AUTH_DIRECT_PROMPT stage=[" + openerStageUp + "]"); } catch (_) {}
  try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", "DRAFT", openerStageUp, String(pendingRow || ""), String((resolverCtx && resolverCtx.pendingExpected) || ""), "OPENER_DIRECT_PROMPT"); } catch (_) {}

  var openerAuthFastPropDup =
    String((e && e.parameter && e.parameter._fastReplySent) || "") === "1" &&
    String((e && e.parameter && e.parameter._fastReplyType) || "").toUpperCase() === "ASK_PROPERTY_AND_UNIT";

  if (openerStageUp === "SCHEDULE_PRETICKET" || openerStageUp === "SCHEDULE") {
    var askSchedN = askCountBumpAndGet_(phone, "schedule");
    var intSchedDirect = {
      intentType: "TICKET_CREATED_ASK_SCHEDULE",
      recipientType: "TENANT",
      recipientRef: phone,
      lang: lang,
      channel: channel,
      deliveryPolicy: "NO_HEADER",
      vars: Object.assign({}, baseVars || {}, { askAttempt: askSchedN }),
      meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" }
    };
    if (typeof dispatchTenantIntent_ === "function") dispatchTenantIntent_(e, phone, bodyTrim, intSchedDirect);
    return { handled: true };
  }

  if (openerStageUp === "UNIT") {
    var askUnitN = askCountBumpAndGet_(phone, "unit");
    var intUnitDirect = {
      intentType: "ASK_FOR_MISSING_UNIT",
      recipientType: "TENANT",
      recipientRef: phone,
      lang: lang,
      channel: channel,
      deliveryPolicy: "DIRECT_SEND",
      vars: Object.assign({}, baseVars || {}, { askAttempt: askUnitN }),
      meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" }
    };
    if (typeof dispatchTenantIntent_ === "function") dispatchTenantIntent_(e, phone, bodyTrim, intUnitDirect);
    return { handled: true };
  }

  if (openerStageUp === "PROPERTY_AND_UNIT") {
    if (openerAuthFastPropDup) {
      try { logDevSms_(phone, "", "FAST_REPLY_DUP_SUPPRESS type=ASK_PROPERTY_AND_UNIT source=OPENER_AUTH_DIRECT_PROPERTY_AND_UNIT note=[ok_tenant_already_got_router_packaged_ask_same_request]"); } catch (_) {}
      return { handled: true };
    }
    var askPropN2 = askCountBumpAndGet_(phone, "property");
    var issueHintDirect = String((cap && cap.issue) || bodyTrim || "").trim();
    var intPropUnitDirect = {
      intentType: "ASK_PROPERTY_AND_UNIT_PACKAGED",
      recipientType: "TENANT",
      recipientRef: phone,
      lang: lang,
      channel: channel,
      deliveryPolicy: "NO_HEADER",
      vars: Object.assign({}, (typeof packagedAskVarsForTurn === "function" ? packagedAskVarsForTurn(issueHintDirect) : { issueHint: issueHintDirect }), { askAttempt: askPropN2 }),
      meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MISSING_SLOT_PACKAGING" }
    };
    if (typeof dispatchTenantIntent_ === "function") dispatchTenantIntent_(e, phone, bodyTrim, intPropUnitDirect);
    return { handled: true };
  }

  if (openerStageUp === "PROPERTY") {
    var askPropN = askCountBumpAndGet_(phone, "property");
    if (cap.hasIssue && !cap.hasProp && !cap.hasUnit) {
      if (openerAuthFastPropDup) {
        try { logDevSms_(phone, "", "FAST_REPLY_DUP_SUPPRESS type=ASK_PROPERTY_AND_UNIT source=OPENER_AUTH_DIRECT_PROMPT_PROPERTY note=[ok_tenant_already_got_router_packaged_ask_same_request]"); } catch (_) {}
        return { handled: true };
      }
      var issueHintP = String((cap && cap.issue) || bodyTrim || "").trim();
      var intPboth = {
        intentType: "ASK_PROPERTY_AND_UNIT_PACKAGED",
        recipientType: "TENANT",
        recipientRef: phone,
        lang: lang,
        channel: channel,
        deliveryPolicy: "NO_HEADER",
        vars: Object.assign({}, (typeof packagedAskVarsForTurn === "function" ? packagedAskVarsForTurn(issueHintP) : { issueHint: issueHintP }), { askAttempt: askPropN }),
        meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MISSING_SLOT_PACKAGING" }
      };
      if (typeof dispatchTenantIntent_ === "function") dispatchTenantIntent_(e, phone, bodyTrim, intPboth);
      return { handled: true };
    }
    if (cap.hasUnit && !cap.hasProp) {
      reply_(replyAskPropertyMenu_(lang, Object.assign({}, baseVars || {}, { unit: cap.unit }), { prefixKey: "ASK_PROPERTY_GOT_UNIT", askAttempt: askPropN }));
      return { handled: true };
    }
    reply_(replyAskPropertyMenu_(lang, baseVars, { askAttempt: askPropN }));
    return { handled: true };
  }

  if (openerStageUp === "ISSUE") {
    var askIssueN = askCountBumpAndGet_(phone, "issue");
    var intIssueDirect = {
      intentType: "ASK_FOR_ISSUE",
      recipientType: "TENANT",
      recipientRef: phone,
      lang: lang,
      channel: channel,
      deliveryPolicy: "DIRECT_SEND",
      vars: Object.assign({}, baseVars || {}, { askAttempt: askIssueN }),
      meta: { source: "HANDLE_SMS_CORE", stage: "ISSUE", flow: "MAINTENANCE_INTAKE" }
    };
    if (typeof dispatchTenantIntent_ === "function") dispatchTenantIntent_(e, phone, bodyTrim, intIssueDirect);
    return { handled: true };
  }

  return { handled: false };
}

function intakeSelectPromptPackaging_(opts) {
  opts = opts || {};
  var stage = String(opts.stage || "").trim().toUpperCase();
  var cap = opts.cap || {};
  var baseVars = opts.baseVars || {};
  var lang = String(opts.lang || "en");
  var bodyText = String(opts.bodyText || "");
  var phone = String(opts.phone || "");
  var channel = String(opts.channel || "SMS");
  var packagedAskVarsForTurn = opts.packagedAskVarsForTurn;

  var out = { handled: false, mode: "", replyKey: "", text: "", intent: null };
  var hasIssue = !!cap.hasIssue;
  var hasProp = !!cap.hasProp;
  var hasUnit = !!cap.hasUnit;
  if (stage === "PROPERTY") {
    if (hasIssue && hasProp && hasUnit) {
      out.handled = true;
      out.mode = "intent";
      out.replyKey = "ASK_WINDOW_SIMPLE_PACKAGED";
      out.intent = {
        intentType: "TICKET_CREATED_ASK_SCHEDULE",
        recipientType: "TENANT",
        recipientRef: phone,
        lang: lang,
        channel: channel,
        deliveryPolicy: "NO_HEADER",
        vars: baseVars || {},
        meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MISSING_SLOT_PACKAGING" }
      };
      return out;
    }
    if (hasUnit && !hasProp) {
      out.handled = true;
      out.mode = "reply_text";
      out.replyKey = "ASK_PROPERTY_GOT_UNIT";
      out.text = replyAskPropertyMenu_(lang, Object.assign({}, baseVars || {}, { unit: cap.unit }), { prefixKey: "ASK_PROPERTY_GOT_UNIT" });
      return out;
    }
    if (hasIssue && !hasProp && !hasUnit) {
      out.handled = true;
      out.mode = "intent";
      out.replyKey = "ASK_PROPERTY_AND_UNIT";
      var issueHint = String((cap && cap.issueText) || bodyText || "").trim();
      out.intent = {
        intentType: "ASK_PROPERTY_AND_UNIT_PACKAGED",
        recipientType: "TENANT",
        recipientRef: phone,
        lang: lang,
        channel: channel,
        deliveryPolicy: "NO_HEADER",
        vars: (typeof packagedAskVarsForTurn === "function") ? packagedAskVarsForTurn(issueHint) : { issueHint: issueHint },
        meta: { source: "HANDLE_SMS_CORE", stage: "PROPERTY", flow: "MISSING_SLOT_PACKAGING" }
      };
      return out;
    }
    return out;
  }

  if (stage === "UNIT") {
    if (hasProp && !hasUnit) {
      out.handled = true;
      out.mode = "intent";
      out.replyKey = "ASK_UNIT_GOT_PROPERTY";
      out.intent = {
        intentType: "ASK_FOR_MISSING_UNIT",
        recipientType: "TENANT",
        recipientRef: phone,
        lang: lang,
        channel: channel,
        deliveryPolicy: "DIRECT_SEND",
        vars: Object.assign({}, baseVars || {}, { propertyName: cap.propName || cap.propCode }),
        meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" }
      };
      return out;
    }
  }

  return out;
}

function runStageAdvanceGuard_(opts) {
  opts = opts || {};
  var mode = String(opts.mode || "");
  var dirRow = Number(opts.dirRow || 0);
  var prevStageBeforeRecompute = String(opts.prevStageBeforeRecompute || "");
  var effectiveStage = String(opts.effectiveStage || "");
  var phone = String(opts.phone || "");
  var sidSafe = String(opts.sidSafe || "");
  var e = opts.e || {};
  var bodyTrim = String(opts.bodyTrim || "");
  var cap = opts.cap || {};
  var baseVars = opts.baseVars || {};
  var lang = String(opts.lang || "en");
  var channel = String(opts.channel || "SMS");
  var ticketState = opts.ticketState || {};
  var pendingRow = Number(opts.pendingRow || 0);
  var resolverCtx = opts.resolverCtx || {};
  var turnFacts = opts.turnFacts || {};
  var packagedAskVarsForTurn = opts.packagedAskVarsForTurn;
  var replyFn = opts.replyFn;

  var prevUp = String(prevStageBeforeRecompute || "").toUpperCase();
  var nextUp = String(effectiveStage || "").toUpperCase();
  if (!(mode === "TENANT" && dirRow > 0 && nextUp && prevUp !== nextUp)) {
    return { handled: false, markReplied: false };
  }

  try { logStageDecision_(phone, sidSafe || "", prevStageBeforeRecompute, effectiveStage, "resolver"); } catch (_) {}
  var conversational = { PROPERTY: 1, UNIT: 1, SCHEDULE: 1, SCHEDULE_PRETICKET: 1 };
  if (!conversational[nextUp]) {
    try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_SKIP next=[" + nextUp + "]"); } catch (_) {}
    return { handled: false, markReplied: false };
  }
  try { logDevSms_(phone, (bodyTrim || "").slice(0, 40), "STAGE_ADVANCE_GUARD prev=[" + prevUp + "] next=[" + nextUp + "] action=[PROMPT_ONLY]"); } catch (_) {}

  if (effectiveStage === "PROPERTY") {
    var fastPropertyAskAlreadySent =
      String((e && e.parameter && e.parameter._fastReplySent) || "") === "1" &&
      String((e && e.parameter && e.parameter._fastReplyType) || "").toUpperCase() === "ASK_PROPERTY_AND_UNIT";
    if (fastPropertyAskAlreadySent) {
      try { logDevSms_(phone, "", "FAST_REPLY_DUP_SUPPRESS type=ASK_PROPERTY_AND_UNIT source=STAGE_ADVANCE_GUARD_PROPERTY_STAGE note=[ok_tenant_already_got_router_packaged_ask_same_request]"); } catch (_) {}
      return { handled: true, markReplied: true };
    }
    var openerPropAnswered = !!(turnFacts && turnFacts.property && turnFacts.property.code);
    if (!openerPropAnswered) {
      var pkg = intakeSelectPromptPackaging_({
        stage: effectiveStage,
        cap: cap,
        baseVars: baseVars,
        lang: lang,
        bodyText: bodyTrim,
        phone: phone,
        channel: channel,
        packagedAskVarsForTurn: packagedAskVarsForTurn
      });
      if (pkg && pkg.handled) {
        var sameMeaningFastAsk =
          String((e && e.parameter && e.parameter._fastReplySent) || "") === "1" &&
          String((e && e.parameter && e.parameter._fastReplyType) || "").toUpperCase() === "ASK_PROPERTY_AND_UNIT" &&
          String(pkg.replyKey || "").toUpperCase() === "ASK_PROPERTY_AND_UNIT";
        if (sameMeaningFastAsk) {
          try { logDevSms_(phone, "", "FAST_REPLY_DUP_SUPPRESS type=ASK_PROPERTY_AND_UNIT source=STAGE_ADVANCE_GUARD_PROPERTY note=[ok_tenant_already_got_router_packaged_ask_same_request]"); } catch (_) {}
          return { handled: true, markReplied: true };
        }
        try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((resolverCtx && resolverCtx.pendingExpected) || ""), String(pkg.replyKey || "")); } catch (_) {}
        try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=" + String(pkg.replyKey || "")); } catch (_) {}
        if (pkg.mode === "intent") {
          var dpkg = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, pkg.intent || {}) : { ok: false };
          if (!dpkg.ok) {
            try { logDevSms_(phone, "", "STAGE_GUARD_OUTBOUND_SKIPPED reason=" + String(dpkg.error || "dispatch_fail") + " replyKey=" + String(pkg.replyKey || "")); } catch (_) {}
          } else {
            return { handled: true, markReplied: true };
          }
        } else if (pkg.mode === "reply_text") {
          if (typeof replyFn === "function") replyFn(String(pkg.text || ""));
          return { handled: true, markReplied: true };
        }
        return { handled: true, markReplied: false };
      }
      try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((resolverCtx && resolverCtx.pendingExpected) || ""), "ASK_PROPERTY"); } catch (_) {}
      try { logDevSms_(phone, "", "STAGE_GUARD_PROMPT prev=[" + prevUp + "] next=[" + nextUp + "] replyKey=[ASK_PROPERTY]"); } catch (_) {}
      if (typeof replyFn === "function") replyFn(replyAskPropertyMenu_(lang, baseVars));
      return { handled: true, markReplied: true };
    }
  }

  if (effectiveStage === "UNIT") {
    var pkgU = intakeSelectPromptPackaging_({
      stage: effectiveStage,
      cap: cap,
      baseVars: baseVars,
      lang: lang,
      bodyText: bodyTrim,
      phone: phone,
      channel: channel,
      packagedAskVarsForTurn: packagedAskVarsForTurn
    });
    if (pkgU && pkgU.handled) {
      try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((resolverCtx && resolverCtx.pendingExpected) || ""), String(pkgU.replyKey || "")); } catch (_) {}
      try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=" + String(pkgU.replyKey || "")); } catch (_) {}
      if (pkgU.mode === "intent") {
        var dpkgU = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, pkgU.intent || {}) : { ok: false };
        if (!dpkgU.ok) {
          try { logDevSms_(phone, "", "STAGE_GUARD_OUTBOUND_SKIPPED reason=" + String(dpkgU.error || "dispatch_fail") + " replyKey=" + String(pkgU.replyKey || "")); } catch (_) {}
        } else {
          return { handled: true, markReplied: true };
        }
      } else if (pkgU.mode === "reply_text") {
        if (typeof replyFn === "function") replyFn(String(pkgU.text || ""));
        return { handled: true, markReplied: true };
      }
      return { handled: true, markReplied: false };
    }
    try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((resolverCtx && resolverCtx.pendingExpected) || ""), "ASK_UNIT"); } catch (_) {}
    try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=ASK_UNIT"); } catch (_) {}
    var sgUnitN = askCountBumpAndGet_(phone, "unit");
    var intUnit = { intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: channel, deliveryPolicy: "DIRECT_SEND", vars: Object.assign({}, baseVars || {}, { askAttempt: sgUnitN }), meta: { source: "HANDLE_SMS_CORE", stage: "UNIT", flow: "MAINTENANCE_INTAKE" } };
    var dUnit = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, intUnit) : { ok: false };
    return { handled: true, markReplied: !!(dUnit && dUnit.ok) };
  }

  if (effectiveStage === "SCHEDULE" || effectiveStage === "SCHEDULE_PRETICKET") {
    try { logTurnSummary_(phone, sidSafe || "", mode || "", mode || "", ticketState.stateType || "", effectiveStage || "", String(pendingRow || ""), String((resolverCtx && resolverCtx.pendingExpected) || ""), "ASK_WINDOW_SIMPLE"); } catch (_) {}
    try { logDevSms_(phone, "", "STAGE_ADVANCE_GUARD_OK prev=" + prevUp + " next=" + nextUp + " replyKey=ASK_WINDOW_SIMPLE"); } catch (_) {}
    var sgSchedN = askCountBumpAndGet_(phone, "schedule");
    var intSched = { intentType: "TICKET_CREATED_ASK_SCHEDULE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: channel, deliveryPolicy: "NO_HEADER", vars: Object.assign({}, baseVars || {}, { askAttempt: sgSchedN }), meta: { source: "HANDLE_SMS_CORE", stage: "SCHEDULE", flow: "MAINTENANCE_INTAKE" } };
    if (typeof dispatchTenantIntent_ === "function") dispatchTenantIntent_(e, phone, bodyTrim, intSched);
    return { handled: true, markReplied: true };
  }

  return { handled: false, markReplied: false };
}

function runIntakeCommunicationGate_(opts) {
  opts = opts || {};
  var phone = String(opts.phone || "");
  var mode = String(opts.mode || "");
  var dirRow = Number(opts.dirRow || 0);
  var bodyTrim = String(opts.bodyTrim || "");
  var mergedBodyTrim = String(opts.mergedBodyTrim || "");
  var turnFacts = opts.turnFacts || {};
  var resolverCtx = opts.resolverCtx || {};
  var session = opts.session || {};
  var channel = String(opts.channel || "SMS");
  var props = opts.props || null;

  var ctxCigGuard = resolverCtx;
  try {
    if (typeof properaCanonicalIntakeHydrateCtx_ === "function") {
      ctxCigGuard = properaCanonicalIntakeHydrateCtx_(phone, Object.assign({}, resolverCtx)) || resolverCtx;
    }
  } catch (_) {
    ctxCigGuard = resolverCtx;
  }

  var signals = { priorRef: "", tone: "" };
  try {
    signals = (typeof classifyTenantSignals_ === "function") ? classifyTenantSignals_(bodyTrim, resolverCtx) : signals;
  } catch (_) {}

  var handled = false;
  try {
    var killRawGate = String((props && typeof props.getProperty === "function") ? props.getProperty("CIG_GATE_ENABLED") : "").trim().toLowerCase();
    var gateEnabled = !(killRawGate === "0" || killRawGate === "false" || killRawGate === "off" || killRawGate === "no");
    var killGuard = String((props && typeof props.getProperty === "function") ? props.getProperty("CIG_CONTINUATION_GUARD_ENABLED") : "").trim().toLowerCase();
    var guardOff = killGuard === "0" || killGuard === "false" || killGuard === "off" || killGuard === "no";
    var activeWorkflow = !guardOff && mode === "TENANT" && dirRow > 0 && typeof isActiveWorkflow_ === "function" && isActiveWorkflow_(ctxCigGuard, session, null, phone);
    if (gateEnabled && mode === "TENANT" && dirRow > 0 && typeof properaCommunicationGate_ === "function") {
      if (activeWorkflow) {
        try {
          logDevSms_(
            phone,
            String(mergedBodyTrim || "").slice(0, 80),
            "CIG_SKIPPED_ACTIVE_WORKFLOW pendingExp=[" + String((ctxCigGuard && ctxCigGuard.pendingExpected) || "") + "]" +
              " sessionExp=[" + String((session && session.expected) || "") + "]" +
              " sessionStage=[" + String((session && session.stage) || "") + "]" +
              " wi=[" + String((ctxCigGuard && ctxCigGuard.activeWorkItemId) || "") + "]"
          );
        } catch (_) {}
      } else {
        try { logDevSms_(phone, "", "CIG_EXECUTED_NEW_CONVERSATION"); } catch (_) {}
        var gateRes = properaCommunicationGate_(phone, turnFacts, resolverCtx, channel);
        if (gateRes && gateRes.handled) handled = true;
      }
    }
  } catch (_) {}

  return {
    resolverCtx: resolverCtx,
    session: session,
    handled: handled,
    priorRef: String((signals && signals.priorRef) || ""),
    tone: String((signals && signals.tone) || "")
  };
}

// ─────────────────────────────────────────────────────────────────
// SCHEDULE PARSER (Shared) — free-text schedule windows into
// { label, start, end, kind }. Merged from SCHEDULE_PARSER.gs.
// Uses Shared-suffixed names to avoid collisions with MAIN parsers.
// ─────────────────────────────────────────────────────────────────

function parsePreferredWindowShared_(text, stageDay) {
  const s0 = String(text || "").trim();
  if (!s0) return null;

  // Normalize common unicode separators so downstream regex can be simpler.
  // - en-dash/emdash/minus variants used by formatRangeLabelShared_.
  const s = s0
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const tz = Session.getScriptTimeZone(); // eslint/unused: preserved from original parser
  const now = new Date();

  // Quick rejects
  if (s.length < 2) return null;

  // "anytime"
  if (/\b(any ?time|whenever|all day|any time)\b/.test(s)) {
    // Prefer explicit date/day in the text (e.g., "Feb 18 anytime", "Friday anytime")
    const baseFromText = parseDayTargetShared_(s, stageDay, now);
    const base = baseFromText || resolveDayBaseShared_(stageDay, now);
    if (!base) return null;

    const label = formatDayShared_(base) + " anytime";
    return { label, start: null, end: null, kind: "ANYTIME" };
  }

  // "now" / "asap" / "urgent" (ASAP window)
  if (/\b(now|asap|a\s*s\s*a\s*p|immediately|right now|urgent|emergency)\b/.test(s)) {
    // Prefer explicit date/day if present (rare, but allow "tomorrow asap")
    const baseFromText = parseDayTargetShared_(s, stageDay, now);
    const base = baseFromText || resolveDayBaseShared_(stageDay, now) || now;

    // Label: "Today ASAP" (or the resolved date)
    const label = formatDayShared_(base) + " ASAP";
    return { label, start: null, end: null, kind: "ASAP" };
  }

  // Day target (today/tomorrow/weekday/date)
  let baseDay = parseDayTargetShared_(s, stageDay, now);
  const dayPartTry = parseDayPartShared_(s);
  // Guard: numeric date-only like "1/15" can look time-ish ("1" hour) to the time regex.
  // When it's purely a date, treat it as day-only (default window later) rather than "at 1pm".
  const isNumericDateOnly =
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(s) ||
    /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(s);
  // Guard: relative day-only phrases like "in 3 days" include a number that can match
  // the time regex; skip time parsing when there are no explicit time tokens.
  const hasExplicitTimeTokens =
    /\b(am|pm)\b/.test(s) ||
    /:\d{2}/.test(s) ||
    looksRangeishShared_(s) ||
    /\b(after|afterwards|before|between)\b/.test(s);
  const isInDaysOnly = /\bin\s+\d+\s+days?\b/.test(s) && !hasExplicitTimeTokens;
  const hasTimeSpec =
    (!isNumericDateOnly && !isInDaysOnly && looksTimeishShared_(s)) ||
    looksRangeishShared_(s) ||
    /\b(after|afterwards|before|between)\b/.test(s);
  if (!baseDay) {
    // If they only said "9-11" / "morning" / "after 3" with no explicit day,
    // assume "today" (or stageDay if provided).
    const fallback = resolveDayBaseShared_(stageDay, now);
    if (dayPartTry || hasTimeSpec || fallback) {
      baseDay = fallback || startOfDayShared_(now);
    } else {
      return null;
    }
  }

  // "morning/afternoon/evening"
  const dayPart = parseDayPartShared_(s);
  if (dayPart) {
    const range = dayPartRangeShared_(baseDay, dayPart);
    const label = formatRangeLabelShared_(range.start, range.end, dayPart);
    return { label, start: range.start, end: range.end, kind: "DAYPART" };
  }

  // After / Before
  const after = s.match(/\b(after|afterwards)\s+(.+)$/);
  if (after) {
    const t = parseTimeShared_(after[2], baseDay);
    if (!t) return null;
    // AFTER is treated as a bounded availability window:
    // start=parsed time, end=same-day latest scheduling hour.
    const latestHour = getScheduleLatestHourShared_();
    const end = new Date(t);
    end.setHours(latestHour, 0, 0, 0);
    if (end.getTime() < t.getTime()) end.setTime(t.getTime()); // clamp; never earlier than start
    const label = formatDayShared_(baseDay) + " after " + formatTimeShared_(t);
    try {
      if (typeof logDevSms_ === "function") {
        logDevSms_("", "", "SCHED_AFTER_RESOLVE_END start=" + t.toISOString() + " end=" + end.toISOString() + " latestHour=" + latestHour);
      }
    } catch (_) {}
    return { label, start: t, end: end, kind: "AFTER" };
  }

  const before = s.match(/\b(before)\s+(.+)$/);
  if (before) {
    const t = parseTimeShared_(before[2], baseDay);
    if (!t) return null;
    const label = formatDayShared_(baseDay) + " before " + formatTimeShared_(t);
    return { label, start: null, end: t, kind: "BEFORE" };
  }

  // Between X and Y
  const between = s.match(/\b(between)\s+(.+?)\s+(and|to)\s+(.+)$/);
  if (between) {
    const t1 = parseTimeShared_(between[2], baseDay);
    const t2 = parseTimeShared_(between[4], baseDay);
    if (!t1 || !t2) return null;
    const range = orderRangeShared_(t1, t2);
    const label = formatRangeLabelShared_(range.start, range.end);
    return { label, start: range.start, end: range.end, kind: "RANGE" };
  }

  // Explicit "X-Y" or "X to Y"
  if (looksRangeishShared_(s)) {
    const r = parseTimeRangeShared_(s, baseDay);
    if (!r) return null;
    const label = formatRangeLabelShared_(r.start, r.end);
    return { label, start: r.start, end: r.end, kind: "RANGE" };
  }

  // Single time: "at 10", "10am"
  if (!isNumericDateOnly && !isInDaysOnly) {
    const single = parseTimeShared_(s, baseDay);
    if (single) {
      const label = formatDayShared_(baseDay) + " at " + formatTimeShared_(single);
      return { label, start: single, end: null, kind: "AT" };
    }
  }

  // Day-only inputs (e.g. "tomorrow", "friday") without any explicit time spec.
  // Default to an "afternoon" window so lifecycle can always schedule an end time.
  if (baseDay) {
    const hasDayToken =
      /\btoday\b/.test(s) ||
      /\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s) ||
      /\bnext\s+week\b/.test(s) ||
      /\bin\s+\d+\s+days?\b/.test(s) ||
      /\b(this\s+)?weekend\b/.test(s) ||
      !!parseWeekdayShared_(s, now) ||
      !!parseExplicitDateShared_(s, now);
    if (hasDayToken && !dayPartTry && !hasTimeSpec && !looksRangeishShared_(s)) {
      const range = dayPartRangeShared_(baseDay, "afternoon");
      const label = formatRangeLabelShared_(range.start, range.end, "afternoon");
      return { label, start: range.start, end: range.end, kind: "DAYDEFAULT" };
    }
  }

  return null;
}

function resolveDayBaseShared_(stageDay, now) {
  const d = String(stageDay || "").toLowerCase();
  if (d.includes("today")) return startOfDayShared_(now);
  if (/tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr/.test(d)) return startOfDayShared_(addDaysShared_(now, 1));
  return null;
}

function parseDayTargetShared_(s, stageDay, now) {
  // If message includes a date or weekday, use that
  const explicit = parseExplicitDateShared_(s, now);
  if (explicit) return startOfDayShared_(explicit);

  const wd = parseWeekdayShared_(s, now);
  if (wd) return startOfDayShared_(wd);

  // Relative windows
  if (/\bnext\s+week\b/.test(s)) return startOfDayShared_(addDaysShared_(now, 7));
  const inDays = s.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays && inDays[1]) {
    const n = parseInt(inDays[1], 10);
    if (isFinite(n) && n >= 0) return startOfDayShared_(addDaysShared_(now, n));
  }
  if (/\b(this\s+)?weekend\b/.test(s)) {
    // Default to upcoming Saturday
    const start = startOfDayShared_(now);
    const curDay = start.getDay(); // 0=Sun..6=Sat
    let delta = 6 - curDay;
    if (delta <= 0) delta += 7;
    return startOfDayShared_(addDaysShared_(start, delta));
  }

  if (/\btoday\b/.test(s)) return startOfDayShared_(now);
  if (/\b(tomorrow|tomorow|tommorow|tomrrow|tmrw|tmr)\b/.test(s)) return startOfDayShared_(addDaysShared_(now, 1));

  // If no explicit day but stageDay exists (SCHEDULE_TODAY / TOMORROW)
  const fallback = resolveDayBaseShared_(stageDay, now);
  if (fallback) return fallback;

  return null;
}

function parseExplicitDateShared_(s, now) {
  // formats: 1/15, 01/15, 1/15/2026, 2026-01-15
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const y = +m[1], mo = +m[2], da = +m[3];
    return new Date(y, mo - 1, da);
  }

  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const mo = +m[1], da = +m[2];
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y = 2000 + y;
    return new Date(y, mo - 1, da);
  }

  // Month name date (handles both abbreviations and full names):
  // e.g. "Thu Mar 19, 9:00 AM–12:00 PM" or "Mar 19, 2026"
  const monthMap = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };
  const monthTokenRe = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const mon = new RegExp("\\b(" + monthTokenRe + ")\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b", "i").exec(s);
  if (mon) {
    const token = String(mon[1] || "").toLowerCase();
    const midx = monthMap[token] != null ? monthMap[token] : monthMap[token.slice(0, 3)];
    if (midx == null) return null;
    const day = parseInt(mon[2], 10);
    const hasYear = !!mon[3];
    const year = hasYear ? parseInt(mon[3], 10) : now.getFullYear();
    const d = new Date(year, midx, day);
    if (isFinite(d.getTime())) {
      // If no year was provided and the computed date is in the past, assume next year.
      if (!hasYear && d.getTime() < startOfDayShared_(now).getTime()) {
        const d2 = new Date(year + 1, midx, day);
        if (isFinite(d2.getTime())) return d2;
      }
      return d;
    }
  }

  return null;
}

function parseWeekdayShared_(s, now) {
  const days = [
    ["sun", "sunday"],
    ["mon", "monday"],
    ["tue", "tues", "tuesday"],
    ["wed", "wednesday"],
    ["thu", "thurs", "thursday"],
    ["fri", "friday"],
    ["sat", "saturday"]
  ];

  let target = -1;
  for (let i = 0; i < days.length; i++) {
    for (const name of days[i]) {
      if (new RegExp("\\b" + name + "\\b").test(s)) {
        target = i;
        break;
      }
    }
    if (target >= 0) break;
  }
  if (target < 0) return null;

  const start = startOfDayShared_(now);
  const cur = start.getDay();
  let delta = target - cur;
  if (delta < 0) delta += 7;
  if (delta === 0) delta = 7; // if they say "Friday" on Friday, assume next Friday
  return addDaysShared_(start, delta);
}

function parseDayPartShared_(s) {
  if (/\bmorning\b/.test(s)) return "morning";
  if (/\bafternoon\b/.test(s)) return "afternoon";
  if (/\bevening\b/.test(s) || /\bnight\b/.test(s)) return "evening";
  return null;
}

function dayPartRangeShared_(baseDay, part) {
  const start = new Date(baseDay);
  const end = new Date(baseDay);
  if (part === "morning") { start.setHours(9,0,0,0); end.setHours(12,0,0,0); }
  if (part === "afternoon") { start.setHours(12,0,0,0); end.setHours(17,0,0,0); }
  if (part === "evening") { start.setHours(17,0,0,0); end.setHours(20,0,0,0); }
  return { start, end };
}

function looksTimeishShared_(s) {
  return /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bnoon\b)|(\bmidday\b)/i.test(s);
}

function looksRangeishShared_(s) {
  // Support hyphen and the renderer's en-dash/emdash (– / —).
  return /(\b\d{1,2}(:\d{2})?\s*(am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b)|(\bbetween\b.+\b(and|to)\b)/i.test(s);
}

function parseTimeWindowOnDayShared_(s, baseDay) {
  const r = parseTimeRangeShared_(s, baseDay);
  if (r) return { label: formatRangeLabelShared_(r.start, r.end), start: r.start, end: r.end, kind: "RANGE" };

  const t = parseTimeShared_(s, baseDay);
  if (t) return { label: formatDayShared_(baseDay) + " at " + formatTimeShared_(t), start: t, end: null, kind: "AT" };

  return null;
}

function parseTimeRangeShared_(s, baseDay) {
  // "9-11", "9am-11am", "9 to 11", "9:30-11"
  // Support hyphen and the renderer's en-dash/emdash (– / —).
  let m = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (!m) return null;

  const t1 = parseTimeShared_(m[1], baseDay);
  const t2 = parseTimeShared_(m[2], baseDay);
  if (!t1 || !t2) return null;

  // If second time had no am/pm, and first had it, inherit
  return orderRangeShared_(t1, t2);
}

function parseTimeShared_(raw, baseDay) {
  const s = String(raw || "").toLowerCase().trim();

  if (/\bnoon\b/.test(s)) {
    const d = new Date(baseDay); d.setHours(12,0,0,0); return d;
  }

  // "at 10am" -> "10am"
  const clean = s.replace(/\bat\b/g, "").trim();

  // 10, 10am, 10:30, 10:30am
  const m = clean.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;

  let hh = +m[1];
  const mm = m[2] ? +m[2] : 0;
  const ap = m[3] || "";

  if (hh < 0 || hh > 12 || mm < 0 || mm > 59) return null;

  let H = hh;

  if (ap === "pm" && hh !== 12) H = hh + 12;
  if (ap === "am" && hh === 12) H = 0;

  // If no am/pm and hour looks like business time (7-18), accept as-is best guess:
  if (!ap) {
    // interpret 1-6 as pm by default (common tenant behavior)
    if (hh >= 1 && hh <= 6) H = hh + 12;
    else H = hh; // 7-12 stays
  }

  const d = new Date(baseDay);
  d.setHours(H, mm, 0, 0);
  return d;
}

function orderRangeShared_(a, b) {
  if (a.getTime() <= b.getTime()) return { start: a, end: b };
  return { start: b, end: a };
}

function startOfDayShared_(d) {
  const x = new Date(d);
  x.setHours(0,0,0,0);
  return x;
}

function addDaysShared_(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function formatDayShared_(d) {
  // Example: "Fri Jan 15"
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "EEE MMM d");
}

function formatTimeShared_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "h:mm a");
}

function formatRangeLabelShared_(start, end, part) {
  // Example: "Fri Jan 15, 9:00 AM–11:00 AM"
  const day = formatDayShared_(start);
  if (end) return day + ", " + formatTimeShared_(start) + "–" + formatTimeShared_(end);
  return day + ", " + formatTimeShared_(start);
}

function getScheduleLatestHourShared_() {
  var latest = 17; // safe fallback when config missing/invalid
  try {
    if (typeof ppGet_ === "function") {
      var raw = ppGet_("GLOBAL", "SCHED_LATEST_HOUR", 17);
      var n = Number(raw);
      if (isFinite(n) && n >= 0 && n <= 23) latest = Math.floor(n);
    }
  } catch (_) {}
  return latest;
}
