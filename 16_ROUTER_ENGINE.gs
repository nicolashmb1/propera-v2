/**
 * ROUTER_ENGINE.gs — Propera M2 Router (lanes, compliance hooks, inbound router)
 *
 * OWNS:
 *   - detectTenantCommand_, routerInboundStrongStageMatch_, listMyTickets_, handleTenantCommandGlobal_
 *   - handleInboundRouter_ (continuation fast-path, staff #capture handoff, default routeToCoreSafe_)
 *
 * DOES NOT OWN:
 *   - doPost/doGet webhook transport -> GATEWAY_WEBHOOK.gs
 *   - Core orchestrator -> CORE_ORCHESTRATOR.gs (handleInboundCore_)
 *
 * ENTRY POINTS:
 *   - handleInboundRouter_(e) — primary M2 entry from gateway
 *
 * DEPENDENCIES:
 *   - Globals and helpers in other modules (ctx, session, dispatchTenantIntent_, routeToCoreSafe_, etc.)
 *
 * FUTURE MIGRATION NOTE:
 *   - Edge router service in front of core orchestration
 *
 * SECTIONS IN THIS FILE:
 *   1. Tenant command detection + global command handler
 *   2. handleInboundRouter_ — full branch tree
 */

/************************************
* ENTRY POINTS
************************************/

// ===================================================================
// ===== M2 — ROUTER (Lane + Compliance + Intent Gate) ===============
// @MODULE:M2
// Responsibilities:
// - STOP/START/HELP compliance
// - Lane decision
// - Intent gate handling
// Forbidden:
// - Ticket writes
// - Stage handling
// ===================================================================

// ===================================================================
// GLOBAL TENANT COMMAND LAYER (Propera Compass)
// Runs BEFORE pendingExpected, router branches, and state machine.
// ===================================================================

function detectTenantCommand_(text) {
  if (!text) return null;

  var t = String(text).trim().toLowerCase();

  if (t === "my tickets" || t === "my ticket" || t === "tickets" || t === "requests")
    return "CMD_MY_TICKETS";

  if (t === "status" || t === "ticket status")
    return "CMD_STATUS";

  if (t === "change time" || t === "update time" || t === "reschedule")
    return "CMD_CHANGE_TIME";

  if (t === "cancel" || t === "cancel ticket" || t === "cancel tickets" || t === "cancel request")
    return "CMD_CANCEL";

  if (t === "start over" || t === "startover" || t === "reset" || t === "restart")
    return "CMD_START_OVER";

  if (t === "options" || t === "menu")
    return "CMD_OPTIONS";

  if (t === "help")
    return "CMD_HELP";

  return null;
}

/**
 * Stage-shaped continuation: true when inbound message strongly looks like an answer for the expected stage.
 * Used to bypass pending expiration so valid replies (e.g. "unit 304" when exp=UNIT) are not dropped into INTENT_PICK.
 * @returns {{ match: boolean, subtype?: string, value?: string }}
 */
function routerInboundStrongStageMatch_(expectedStage, bodyTrim) {
  var exp = String(expectedStage || "").trim().toUpperCase();
  var t = String(bodyTrim || "").trim();
  if (!t) return { match: false };

  if (exp === "UNIT") {
    if (typeof extractUnit_ === "function") {
      var u = extractUnit_(t);
      if (u && String(u).trim().length > 0) return { match: true, subtype: "extractUnit", value: String(u).trim() };
    }
    if (/\b(?:unit|apt|apartment|suite|#)\s*[\d]{1,5}\b/i.test(t)) return { match: true, subtype: "unit_pattern" };
    if (/^\d{2,5}$/.test(t) && !/^20\d{2}$/.test(t) && !/^\d{5}$/.test(t)) return { match: true, subtype: "unit_digits" };
    return { match: false };
  }

  if (exp === "PROPERTY") {
    // Only numeric menu choice 1–9 (or 1..N if property list available). No broad short-string acceptance.
    var n = parseInt(t, 10);
    if (/^[1-9]\d*$/.test(t) && !isNaN(n)) {
      var max = 9;
      if (typeof getActiveProperties_ === "function") {
        try {
          var list = getActiveProperties_() || [];
          if (list.length > 0) max = list.length;
        } catch (_) {}
      }
      if (n >= 1 && n <= max) return { match: true, subtype: "property_choice", value: String(n) };
    }
    return { match: false };
  }

  if (exp === "ISSUE" || exp === "DETAIL") {
    var lower = t.toLowerCase();
    if (t.length < 2) return { match: false };
    if (/^(yes|no|ok|help|stop|start|menu|options)$/i.test(t)) return { match: false };
    if (/^(maintenance|leasing|amenities)$/i.test(lower)) return { match: false };
    return { match: true, subtype: exp === "ISSUE" ? "issue" : "detail" };
  }

  return { match: false };
}

function listMyTickets_(sheet, phone, limit) {
  var rows = findTenantTicketRows_(sheet, phone, { includeClosed: false });
  if (!rows || !rows.length) return { msg: "", ids: [] };

  var cap = Math.min(rows.length, limit || 5);
  var lines = [];
  var ids = [];
  for (var i = 0; i < cap; i++) {
    var t = readTicketForTenant_(sheet, rows[i]);
    var tid = t.ticketId || ("Row " + rows[i]);
    ids.push(tid);
    lines.push((i + 1) + ") " + tid + " — " + (t.status || "Open") + (t.prefWindow ? " | " + t.prefWindow : ""));
  }
  var header = "Your open tickets (" + rows.length + "):";
  return { msg: header + "\n" + lines.join("\n"), ids: ids };
}

function handleTenantCommandGlobal_(cmd, ctx, phone, lang, outboundCh) {
  try { logDevSms_(phone, "", "CMD_EXEC " + cmd); } catch (_) {}

  var _routerCh = "SMS";
  try {
    _routerCh = String(outboundCh || "SMS").trim().toUpperCase();
    if (_routerCh !== "WA" && _routerCh !== "TELEGRAM") _routerCh = "SMS";
  } catch (_) { _routerCh = "SMS"; }

  var L = String(lang || "en").toLowerCase();
  var sheet, dir;
  try { sheet = getSheet_(SHEET_NAME); } catch (_) { sheet = null; }
  try { dir = getSheet_(DIRECTORY_SHEET_NAME); } catch (_) { dir = null; }
  var digits = (typeof normalizePhoneDigits_ === "function") ? normalizePhoneDigits_(phone) : String(phone || "").replace(/\D/g, "");

  switch (cmd) {

    case "CMD_MY_TICKETS": {
      if (!sheet) return sendRouterSms_(phone, tenantMsg_("TENANT_MY_TICKETS_EMPTY_FALLBACK", L, {}), "CMD_MY_TICKETS", _routerCh);
      var out = listMyTickets_(sheet, phone, 5);
      return sendRouterSms_(phone, String(out && out.msg ? out.msg : tenantMsg_("TENANT_MY_TICKETS_EMPTY_FALLBACK", L, {})), "CMD_MY_TICKETS", _routerCh);
    }

    case "CMD_STATUS": {
      if (!sheet) return sendRouterSms_(phone, tenantMsg_("TENANT_STATUS_FALLBACK", L, {}), "CMD_STATUS", _routerCh);
      var out2 = tenantStatusCommand_(sheet, phone, "", L);
      return sendRouterSms_(phone, String(out2 && out2.msg ? out2.msg : tenantMsg_("TENANT_STATUS_FALLBACK", L, {})), "CMD_STATUS", _routerCh);
    }

    case "CMD_CANCEL": {
      if (!sheet || !dir) return sendRouterSms_(phone, tenantMsg_("TENANT_CANCEL_FALLBACK", L, {}), "CMD_CANCEL", _routerCh);
      var out3 = tenantCancelTicketCommand_(sheet, dir, digits, phone, "cancel", L, { brandName: BRAND.name, teamName: BRAND.team });
      return sendRouterSms_(phone, String(out3 && out3.msg ? out3.msg : tenantMsg_("TENANT_CANCEL_FALLBACK", L, {})), "CMD_CANCEL", _routerCh);
    }

    case "CMD_CHANGE_TIME": {
      if (!sheet) return sendRouterSms_(phone, tenantMsg_("TENANT_NO_TICKETS_TO_CHANGE", L, {}), "CMD_CHANGE_TIME", _routerCh);
      var my = listMyTickets_(sheet, phone, 5);
      var ids = (my && my.ids) ? my.ids : [];
      if (!ids.length) return sendRouterSms_(phone, tenantMsg_("TENANT_NO_TICKETS_TO_CHANGE", L, {}), "CMD_CHANGE_TIME", _routerCh);
      try { setAwaiting_(digits, "CHANGE_TIME_PICK", { ids: ids }, 900); } catch (_) {}
      return sendRouterSms_(phone, tenantMsg_("TENANT_CHANGE_TIME_PICK_PROMPT", L, { ticketsText: String(my.msg || "") }), "CMD_CHANGE_TIME", _routerCh);
    }

    case "CMD_START_OVER": {
      try {
        if (dir) {
          var dirRow = ensureDirectoryRowForPhone_(dir, phone);
          if (dirRow >= 2) {
            dalWithLock_("DIR_RESET_TENANT", function () {
              dalSetPendingIssueNoLock_(dir, dirRow, "");
              try { logDevSms_(phone, "", "ISSUE_WRITE site=[CMD_GLOBAL_RESET] val=[CLEAR_RESET]"); } catch (_) {}
              dalSetPendingUnitNoLock_(dir, dirRow, "");
              dalSetPendingRowNoLock_(dir, dirRow, "");
              dalSetPendingStageNoLock_(dir, dirRow, "");
              dalSetLastUpdatedNoLock_(dir, dirRow);
              try { logDevSms_(phone, "", "DAL_WRITE DIR_RESET_TENANT row=" + dirRow); } catch (_) {}
            });
          }
        }
      } catch (err) {
        try { logDevSms_(phone, "", "CMD_GLOBAL_RESET_ERR " + String(err)); } catch (_) {}
      }
      try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "", pendingWorkItemId: "", activeWorkItemId: "", lastIntent: "" }, "CMD_GLOBAL_RESET"); } catch (_) {}
      return sendRouterSms_(phone, renderTenantKey_("TENANT_RESET_OK", L, {}), "CMD_START_OVER", _routerCh);
    }

    case "CMD_OPTIONS":
      return sendRouterSms_(phone, renderTenantKey_("TENANT_OPTIONS_MENU", L, {}), "CMD_OPTIONS", _routerCh);

    case "CMD_HELP":
      return sendRouterSms_(phone, renderTenantKey_("SMS_HELP", L, {}), "CMD_HELP", _routerCh);
  }
}

function handleInboundRouter_(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  let bodyRaw = String(globalThis.__bodyOverride || p.Body || "").trim();
  if (String(globalThis.__bodyOverride || "").toUpperCase() === "ATTACHMENT_ONLY") {
    bodyRaw = ""; // ✅ never let marker become "text"
  }
  const bodyTrim = bodyRaw;

  // ============================================================
  // STAFF CAPTURE ADAPTER (Signal Layer Phase 1)
  // ============================================================
  if (bodyTrim && bodyTrim.charAt(0) === "#") {

    const stripped = bodyTrim.replace(/^#\s*/, "").trim();

    const e2 = cloneEventWithBody_(e, stripped, {});
    e2.parameter = e2.parameter || {};
    e2.parameter._staffCapture = "1";
    var _fromSc = String((e && e.parameter && e.parameter.From) || "").trim();
    var _waSc = _fromSc.toLowerCase().indexOf("whatsapp:") === 0;
    var _chHintSc = String((e && e.parameter && e.parameter._channel) || "").trim().toUpperCase();
    var _isTgSc = /^TG:/i.test(_fromSc) || _chHintSc === "TELEGRAM";
    // Keep channel explicit for staff-capture re-entry so delivery does not fall back to SMS.
    e2.parameter._channel = _isTgSc ? "TELEGRAM" : (_waSc ? "WA" : "SMS");

    return routeToCoreSafe_(e2, { mode: "MANAGER" });
  }

  const fromRaw = String(p.From || "").trim();
  const isWa = fromRaw.toLowerCase().indexOf("whatsapp:") === 0;
  const chHint = String(p._channel || "").trim().toUpperCase();
  const isTgActor = /^TG:/i.test(fromRaw) || chHint === "TELEGRAM";
  let phone = String(p._phoneE164 || "").trim();
  if (!phone) {
    const fromForNormalize = isWa ? fromRaw.replace(/^whatsapp:/i, "") : fromRaw;
    phone = normalizePhone_(fromForNormalize);
  }
  if (!phone) {
    if (isTgActor && typeof debugLogToSheet_ === "function") {
      try {
        debugLogToSheet_("ROUTER_SKIP_TG_NO_PHONE", "from=" + String(fromRaw).slice(0, 48), "_phoneE164=" + String(p._phoneE164 || "").slice(0, 48));
      } catch (_) {}
    }
    return;
  }

  try {
    ensureCanonicalMediaJsonOnParameters_(p);
  } catch (_canon) {}

  // Telegram fallback identity key: some deployments map staff by Telegram chat id.
  // Prefer user-id key, but allow chat-id key for staff detection/lifecycle routing.
  var staffActorKey = phone;
  var _tgChatDigits = "";
  if (isTgActor) {
    try { _tgChatDigits = String(p._telegramChatId || "").replace(/\D/g, ""); } catch (_) { _tgChatDigits = ""; }
  }
  if (isTgActor && _tgChatDigits && typeof isStaffSender_ === "function") {
    try {
      if (!isStaffSender_(staffActorKey)) {
        var _tgChatKey = "TG:" + _tgChatDigits;
        if (isStaffSender_(_tgChatKey)) staffActorKey = _tgChatKey;
      }
    } catch (_) {}
  }

  // STAFF_CHECK: always log for non-# so we see why staff path is taken or skipped (unconditional).
  if (bodyTrim && bodyTrim.charAt(0) !== "#") {
    var _hasIsStaff = typeof isStaffSender_ === "function";
    var _hasRoute = typeof staffHandleLifecycleCommand_ === "function";
    var _isStaff = _hasIsStaff ? isStaffSender_(staffActorKey) : false;
    var _lifecycleOn = (typeof lifecycleEnabled_ !== "function") ? true : lifecycleEnabled_("GLOBAL");
    try {
      logDevSms_(phone, bodyTrim,
        "STAFF_CHECK phone=[" + String(phone || "") + "] staffKey=[" + String(staffActorKey || "") + "] hasIsStaff=[" + _hasIsStaff + "] hasRoute=[" + _hasRoute + "] isStaff=[" + _isStaff + "] lifecycleOn=[" + _lifecycleOn + "]");
    } catch (_) {}
  }

  // Inbound channel for staff lifecycle replies (must be set before staff intercept; scopeChannel is assigned later for core).
  var _staffScopeChannel = "SMS";
  try {
    if (isWa) _staffScopeChannel = "WA";
    else if (isTgActor) _staffScopeChannel = "TELEGRAM";
  } catch (_) { _staffScopeChannel = "SMS"; }

  // Non-# staff operational: shared-front deterministic intercept.
  // Phase 2 hardening: do not leak staff operational updates into tenant draft flow.
  // This remains the same architecture backbone: router -> staff lifecycle command resolver -> lifecycle engine.
  if (bodyTrim && bodyTrim.charAt(0) !== "#" && typeof isStaffSender_ === "function" && typeof staffHandleLifecycleCommand_ === "function" &&
      isStaffSender_(staffActorKey)) {
    try { logDevSms_(phone, bodyTrim, "STAFF_FRONT_DOOR_INTERCEPT staffKey=[" + String(staffActorKey || "") + "]"); } catch (_) {}
    var _tgReplyChat = "";
    if (isTgActor) {
      try { _tgReplyChat = String(p._telegramChatId || "").trim(); } catch (_tgr) { _tgReplyChat = ""; }
    }
    var handled = staffHandleLifecycleCommand_(staffActorKey, bodyTrim, _staffScopeChannel, _tgReplyChat);
    if (handled) return;
  }

  try { SIM_PHONE_SCOPE_ = phone || ""; } catch (_) {}
  try { if (e && e.parameter) e.parameter._phoneE164 = phone; } catch (_) {}

  var mediaArr = parseCanonicalMediaArrayFromEvent_(e);
  var numMediaN = mediaArr.length;
  var mediaUrls = mediaArr.map(function (m) { return m.url; });
  var mediaTypes = mediaArr.map(function (m) { return m.contentType || ""; });
  const media = mediaArr.map(function (m) {
    return {
      url: m.url,
      contentType: String(m.contentType || ""),
      source: String(m.source || "")
    };
  });
  const weak = (!bodyTrim) || ((typeof isWeakIssue_ === "function") && isWeakIssue_(bodyTrim));
  const hasMediaOnly = (numMediaN > 0) && weak;

  const bodyLower = bodyTrim.toLowerCase().trim();

  const messageSid = String(p.MessageSid || p.SmsMessageSid || "").trim();

  chaosInit_(e, phone, messageSid);
  try { writeTimeline_("IN", { msg: bodyTrim, len: bodyTrim.length }, null); } catch (_) {}

  var channelNorm = "sms";
  if (isWa) channelNorm = "whatsapp";
  else if (isTgActor) channelNorm = "telegram";

  var scopeChannel = "SMS";
  if (isWa) scopeChannel = "WA";
  else if (isTgActor) scopeChannel = "TELEGRAM";
  try {
    if (e && e.parameter) e.parameter._channel = scopeChannel;
  } catch (_) {}

  const inbound = normalizeInboundEvent_(channelNorm, {
    actorType: "unknown",
    actorId: phone,
    body: bodyRaw,
    eventId: messageSid,
    channel: channelNorm,
    media: media,
    meta: {
      to: String(p.To || "").trim(),
      numMedia: String(numMediaN),
      mediaUrls: mediaUrls,
      mediaTypes: mediaTypes,
      hasMediaOnly: hasMediaOnly,
      channel: channelNorm
    }
  });

  // LANE DECISION (single source of truth)
  const decision = decideLane_(inbound);

  try { writeTimeline_("LANE", { lane: (decision && decision.lane) || "", reason: (decision && decision.reason) || "" }, null); } catch (_) {}

  // optional shadow logs during rollout (NO re-decision)
  try { shadowRouteLog_(decision, inbound); } catch (_) {}
  try { shadowLaneDispatch_(decision, inbound); } catch (_) {}

  const norm = normMsg_(bodyTrim);

  // ROUTER TRACE (always)
  try {
    logDevSms_(phone, bodyTrim, "ROUTER_IN lower=[" + bodyLower + "] norm=[" + norm + "]");
  } catch (_) {}

  // 1) COMPLIANCE OVERRIDE (exact-only)
  const comp = complianceIntent_(bodyTrim);
  var _routerInboundCh = (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS";
  if (comp === "STOP") {
    withWriteLock_("SMS_OPTOUT_STOP", () => setSmsOptOut_(phone, true, norm));
    sendRouterSms_(phone, renderTenantKey_("SMS_STOP_CONFIRM", "en", {}), "ROUTER_SMSCOMPLIANCE", _routerInboundCh);
    return;
  }
  if (comp === "START") {
    withWriteLock_("SMS_OPTOUT_START", () => setSmsOptOut_(phone, false, norm));
    sendRouterSms_(phone, renderTenantKey_("SMS_START_CONFIRM", "en", {}), "ROUTER_SMSCOMPLIANCE", _routerInboundCh);
    return;
  }
  if (comp === "HELP") {
    sendRouterSms_(phone, renderTenantKey_("SMS_HELP", "en", {}), "ROUTER_SMSCOMPLIANCE", _routerInboundCh);
    return;
  }

  // 2) OPT-OUT SUPPRESSION (everything else)
  if (isSmsOptedOut_(phone)) {
    try { logDevSms_(phone, bodyTrim, "ROUTER_SUPPRESS opted_out=true"); } catch (_) {}
    return;
  }

  // -------------------------------------------------
  // 2.4) LANE ROUTING (single decision)
  // -------------------------------------------------
  try {
    const lane = String((decision && decision.lane) || "tenantLane");

    if (lane === "vendorLane") {
      try { logDevSms_(phone, bodyTrim, "ROUTER_LANE VENDOR reason=[" + String(decision.reason || "") + "]"); } catch (_) {}
      return routeToCoreSafe_(e, { mode: "VENDOR", channel: scopeChannel });
    }

    if (lane === "managerLane") {
      try { logDevSms_(phone, bodyTrim, "ROUTER_LANE MANAGER reason=[" + String(decision.reason || "") + "]"); } catch (_) {}
      return routeToCoreSafe_(e, { mode: "MANAGER", channel: scopeChannel });
    }

    if (lane === "systemLane") {
      try { logDevSms_(phone, bodyTrim, "ROUTER_LANE SYSTEM reason=[" + String(decision.reason || "") + "]"); } catch (_) {}
      return routeToCoreSafe_(e, { mode: "SYSTEM", channel: scopeChannel });
    }

    try { logDevSms_(phone, bodyTrim, "ROUTER_LANE TENANT reason=[" + String(decision.reason || "") + "]"); } catch (_) {}

  } catch (err) {
    try { logDevSms_(phone, bodyTrim, "ROUTER_LANE_ERR " + (err && err.message ? err.message : err)); } catch (_) {}
  }

  // 2.5) WORK ENGINE CONTEXT (read-only)
  let ctx = null;
  try {
    ensureWorkBackbone_();
    ctx = ctxGet_(phone);

    try {
      logDevSms_(
        phone,
        bodyTrim,
        "ROUTER_CTX lang=[" + String((ctx && ctx.lang) || "en") + "]" +
        " active=[" + String((ctx && ctx.activeWorkItemId) || "") + "]" +
        " pending=[" + String((ctx && ctx.pendingWorkItemId) || "") + "]" +
        " exp=[" + String((ctx && ctx.pendingExpected) || "") + "]"
      );
    } catch (_) {}

  } catch (err) {
    try { logDevSms_(phone, bodyTrim, "ROUTER_CTX_ERR " + (err && err.message ? err.message : err)); } catch (_) {}
    ctx = null;
  }
  try {
    ctx = properaCanonicalIntakeHydrateCtx_(phone, ctx);
  } catch (_) {}

  // -------------------------------------------------
  // 2.55b) ATTACH_CLARIFY hard conversational guard
  // Clarification state is non-bypassable: no intent gate, no fallback logic.
  // -------------------------------------------------
  try {
    var _pExp = ctx && ctx.pendingExpected ? String(ctx.pendingExpected || "").trim().toUpperCase() : "";
    if (_pExp === "ATTACH_CLARIFY") {
      var _lastIntent = ctx && ctx.lastIntent ? String(ctx.lastIntent || "").trim().toUpperCase() : "";
      var _bTrim = String(bodyTrim || "").trim();
      var _bLc = _bTrim.toLowerCase();
      var _outcome = "";

      // Numeric choices
      if (/^\s*1\s*$/.test(_bTrim)) _outcome = "attach";
      else if (/^\s*2\s*$/.test(_bTrim)) _outcome = "start_new";

      // Natural language choices (supports leading markers; residual may remain)
      if (!_outcome) {
        var mSame = _bLc.match(/^\s*(same request|same one|this one|this request)\b[\s,.\-:]*/i);
        if (mSame) _outcome = "attach";
      }
      if (!_outcome) {
        var mNew = _bLc.match(/^\s*(new one|another|different apartment|different unit|other apartment|other unit)\b[\s,.\-:]*/i);
        if (mNew) _outcome = "start_new";
      }

      // If user resolved this turn, NEVER re-send the prompt.
      // If user did not resolve, prompt only if we haven't yet in this cycle.
      if (!_outcome) {
        if (_lastIntent !== "ATTACH_CLARIFY_PROMPT_SENT") {
          try { logDevSms_(phone, _bTrim, "ATTACH_CLARIFY_PROMPT_SENT reason=[clarify_guard_prompt]"); } catch (_) {}
          try {
            if (typeof ctxUpsert_ === "function") {
              var _clarMsP = Date.now() + 3 * 60 * 1000;
              ctxUpsert_(phone, { pendingExpected: "ATTACH_CLARIFY", pendingExpiresAt: new Date(_clarMsP).toISOString(), lastIntent: "ATTACH_CLARIFY_PROMPT_SENT" }, "ATTACH_CLARIFY_PROMPT_SENT");
            }
          } catch (_) {}

          // Deterministic prompt text (template-driven)
          var _canonShP = ensureCanonicalIntakeSheet_();
          var _canonRecP = canonicalIntakeLoadNoLock_(_canonShP, phone);
          var _expectedUnitP = (_canonRecP && _canonRecP.unit) ? String(_canonRecP.unit || "").trim() : "";
          var _txtP =
            "Is this for the same maintenance request or a new one?\n" +
            "1) Same request\n" +
            "2) New request";
          if (_expectedUnitP) _txtP += "\nIf you choose 2, what is the unit number? (Expected: " + _expectedUnitP + ")";
          var _langP = String((ctx && ctx.lang) || "en").toLowerCase();
          if (_langP.indexOf("-") > 0) _langP = _langP.split("-")[0];
          var _intentP = {
            intentType: "CORE_TEXT_REPLY",
            recipientType: "TENANT",
            recipientRef: phone,
            lang: _langP,
            channel: (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : scopeChannel,
            deliveryPolicy: "DIRECT_SEND",
            preRenderedBody: _txtP,
            vars: {},
            meta: { source: "ATTACH_CLARIFY", stage: "ATTACH_CLARIFY", flow: "MAINT_INTAKE" }
          };
          try { dispatchTenantIntent_(e, phone, _bTrim, _intentP); } catch (_) {}
        }
        return;
      }

      // Resolution: clear latch and route deterministically to core.
      try { logDevSms_(phone, _bTrim, "ATTACH_CLARIFY_RESOLVED outcome=[" + _outcome + "]"); } catch (_) {}
      try {
        if (typeof ctxUpsert_ === "function") {
          ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "", pendingWorkItemId: "" }, "ATTACH_CLARIFY_RESOLUTION_CLEAR");
        }
      } catch (_) {}
      if (ctx) {
        try { ctx.pendingExpected = ""; } catch (_) {}
        try { ctx.pendingExpiresAt = ""; } catch (_) {}
      }
      try { logDevSms_(phone, _bTrim, "ATTACH_CLARIFY_ROUTE_ONCE routeToCoreSafe_after_clear"); } catch (_) {}
      // Request-scoped guard: resolved clarify must not re-enter clarify handling later.
      try {
        if (typeof globalThis !== "undefined") {
          globalThis.__attachClarifyResolvedThisTurn = "1";
          globalThis.__attachClarifyResolvedOutcome = String(_outcome || "").trim().toLowerCase();
        }
      } catch (_) {}
      try {
        return routeToCoreSafe_(e);
      } finally {
        try {
          if (typeof globalThis !== "undefined") {
            globalThis.__attachClarifyResolvedThisTurn = "";
            globalThis.__attachClarifyResolvedOutcome = "";
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // 2.55) GLOBAL TENANT COMMAND INTERCEPTOR (Propera Compass)
  // Must run BEFORE pendingExpected and all router branches.
  var cmd = detectTenantCommand_(bodyTrim);
  if (cmd) {
    try { logDevSms_(phone, bodyTrim, "CMD_INTERCEPT " + cmd); } catch (_) {}
    var cmdLang = String((ctx && ctx.lang) || "en").toLowerCase();
    handleTenantCommandGlobal_(cmd, ctx, phone, cmdLang, (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS");
    return;
  }

  // 2.6) PENDING EXPECTED OVERRIDE (deterministic)
  // Stage-shaped continuation beats expiration: if inbound strongly matches expected stage, do NOT clear.
  try {
    if (ctx && ctx.pendingExpected) {
      const exp = String(ctx.pendingExpected || "").trim();
      let expiresMs = 0;

      const pe = ctx.pendingExpiresAt;
      if (pe instanceof Date) {
        expiresMs = pe.getTime();
      } else {
        const parsed = Date.parse(String(pe || ""));
        expiresMs = isNaN(parsed) ? 0 : parsed;
      }

      const nowMs = Date.now();
      const isExpired = (expiresMs > 0 && nowMs > expiresMs);

      if (isExpired) {
        var bypassResult = (typeof routerInboundStrongStageMatch_ === "function") ? routerInboundStrongStageMatch_(exp, bodyTrim) : { match: false };
        if (bypassResult && bypassResult.match) {
          var bypassLog = "ROUTER_PENDING_EXPIRED_BYPASS expected=" + exp + " reason=strong_stage_match";
          if (bypassResult.subtype) bypassLog += " subtype=" + bypassResult.subtype;
          if (bypassResult.value !== undefined && bypassResult.value !== "") bypassLog += " value=" + String(bypassResult.value).slice(0, 32);
          try { logDevSms_(phone, bodyTrim, bypassLog); } catch (_) {}
          const extendMs = nowMs + 10 * 60 * 1000;
          try {
            ctxUpsert_(phone, { pendingExpiresAt: new Date(extendMs) });
            if (ctx) ctx.pendingExpiresAt = new Date(extendMs);
          } catch (_) {}
          // Do NOT clear pendingExpected; fall through so core runs with continuation
        } else {
          try {
            if (typeof properaCanonicalIntakeIsActive_ === "function" && properaCanonicalIntakeIsActive_(phone)) {
              try { logDevSms_(phone, bodyTrim, "CONT_STATE_BLOCKED reason=[canonical_active_prevent_expiry_clear]"); } catch (_) {}
              if (typeof properaCanonicalIntakeHydrateCtx_ === "function") {
                ctx = properaCanonicalIntakeHydrateCtx_(phone, ctx);
              }
              return routeToCoreSafe_(e);
            }
            ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "", pendingWorkItemId: "" });

            // IMPORTANT: also clear the in-memory ctx so downstream gates can run this same inbound
            try {
              ctx.pendingExpected = "";
              ctx.pendingExpiresAt = "";
              ctx.pendingWorkItemId = "";
            } catch (_) {}

            try { logDevSms_(phone, bodyTrim, "ROUTER_PENDING_EXPIRED cleared exp=[" + exp + "]"); } catch (_) {}
          } catch (_) {}
        }
      } else {
        if (!isGlobalResetCommand_(bodyLower)) {
          const expMirror = String(exp || "").toUpperCase();
          var expUp = expMirror;
          try {
            var _authStage = properaResolveStageAuthority_(phone, { ctx: ctx });
            var _canonNextStage = String((_authStage && _authStage.source === "canonical_intake" && _authStage.stage) ? _authStage.stage : "").trim().toUpperCase();
            if (_canonNextStage) {
              if (expMirror && expMirror !== _canonNextStage) {
                try { logDevSms_(phone, bodyTrim, "MIRROR_IGNORED_CANONICAL_WINS mirror=[" + expMirror + "] canonical=[" + _canonNextStage + "]"); } catch (_) {}
              }
              expUp = _canonNextStage;
              try { logDevSms_(phone, bodyTrim, "CANONICAL_STAGE_USED expected=[" + expUp + "] source=[router_pending_override]"); } catch (_) {}
            }
          } catch (_) {}

const isMaintExpected =
            expUp === "PROPERTY" || expUp === "PROPERTY_AND_UNIT" || expUp === "UNIT" || expUp === "ISSUE" || expUp === "DETAIL" ||
            expUp === "SCHEDULE" || expUp === "EMERGENCY_DONE" || expUp === "FINALIZE_DRAFT" ||
            expUp === "SCHEDULE_UNKNOWN" || expUp.indexOf("SCHEDULE_") === 0;

          const isAmenityExpected = (expUp.indexOf("AMENITY_") === 0);
          const isIntentExpected  = (expUp === "INTENT_PICK");
          const isUnknownGateExpected = (expUp === "UNKNOWN_GATE");

          if ((isMaintExpected || isAmenityExpected || isIntentExpected || isUnknownGateExpected) && !isManagerPhone_(phone) && !isVendorPhone_(phone)) {
            try { logDevSms_(phone, bodyTrim, "ROUTER_PENDING_OVERRIDE exp=[" + expUp + "]"); } catch (_) {}

            if (isUnknownGateExpected) {
              var choice = String(bodyTrim || "").trim();
              var expiresAtIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

              if (choice === "1") {
                try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "unknown_gate_service"); } catch (_) {}
                return routeToCoreSafe_(e);
              }

              if (choice === "2") {
                try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "unknown_gate_leasing"); } catch (_) {}
                // Force the leasing branch deterministically WITHOUT changing leasing lane internals
                e.parameter = e.parameter || {};
                e.parameter.Body = "leasing";
                return handleInboundRouter_(e);
              }

              // Invalid reply → re-ask, keep expectation
              try { ctxUpsert_(phone, { pendingExpected: "UNKNOWN_GATE", pendingExpiresAt: expiresAtIso }, "unknown_gate_retry"); } catch (_) {}

              var msg =
                "Are you a resident requesting service, or looking to rent?\n" +
                "Reply 1) Service  2) Leasing";
              return sendRouterSms_(phone, msg, "UNKNOWN_GATE", _routerInboundCh);
            }

            if (isIntentExpected) {
              var choice = String(bodyTrim || "").trim();
              var choiceLower = choice.toLowerCase();

              // extend expiry only on invalid
              var expiresAtIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

              // Word picks (accept synonyms)
              var isMaintWord =
                (choiceLower.indexOf("maint") >= 0) ||
                (choiceLower.indexOf("service") >= 0) ||
                (choiceLower.indexOf("repair") >= 0) ||
                (choiceLower.indexOf("fix") >= 0);

              var isLeasingWord =
                (choiceLower.indexOf("leas") >= 0) ||
                (choiceLower.indexOf("avail") >= 0) ||
                (choiceLower.indexOf("rent") >= 0) ||
                (choiceLower.indexOf("apply") >= 0);

              var isAmenityWord =
                (choiceLower.indexOf("amen") >= 0) ||
                (choiceLower.indexOf("pool") >= 0) ||
                (choiceLower.indexOf("gym") >= 0) ||
                (choiceLower.indexOf("parking") >= 0) ||
                (choiceLower.indexOf("reservation") >= 0);

              if (isDigitReply_(choice, 1)) {
                // 1) Maintenance — DO NOT inject "service" into core (it becomes an issue).
                // Move deterministically to ISSUE prompt.
                try {
                  ctxUpsert_(phone, {
                    pendingExpected: "ISSUE",
                    pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                    lastIntent: "MAINT"
                  }, "intent_pick_1_to_issue");
                } catch (_) {}
                return sendRouterSms_(
                  phone,
                  renderTenantKey_("ASK_ISSUE_GENERIC", String((ctx && ctx.lang) || "en"), {}),
                  "ASK_ISSUE_GENERIC",
                  _routerInboundCh
                );
              }

              if (isDigitReply_(choice, 2)) {
                try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_2"); } catch (_) {}
                // 2) Leasing — re-enter router with internal hint
                return handleInboundRouter_(cloneEventWithBody_(e, "leasing", { internal: true, allowInternal: true }));
              }

              if (isDigitReply_(choice, 3)) {
                try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_3"); } catch (_) {}
                // 3) Amenity — re-enter router with internal hint
                return handleInboundRouter_(cloneEventWithBody_(e, "reservation", { internal: true, allowInternal: true }));
              }

              // Word choices (same behavior as digits)
              if (isMaintWord) {
                try {
                  ctxUpsert_(phone, {
                    pendingExpected: "ISSUE",
                    pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                    lastIntent: "MAINT"
                  }, "intent_pick_word_maint_to_issue");
                } catch (_) {}
                return sendRouterSms_(
                  phone,
                  renderTenantKey_("ASK_ISSUE_GENERIC", String((ctx && ctx.lang) || "en"), {}),
                  "ASK_ISSUE_GENERIC",
                  _routerInboundCh
                );
              }

              if (isLeasingWord) {
                try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_word_leasing"); } catch (_) {}
                return handleInboundRouter_(cloneEventWithBody_(e, "leasing", { internal: true, allowInternal: true }));
              }

              if (isAmenityWord) {
                try { ctxUpsert_(phone, { pendingExpected: "", pendingExpiresAt: "" }, "intent_pick_word_amenity"); } catch (_) {}
                return handleInboundRouter_(cloneEventWithBody_(e, "reservation", { internal: true, allowInternal: true }));
              }

              // Invalid → keep expectation + template reprompt
              try { ctxUpsert_(phone, { pendingExpected: "INTENT_PICK", pendingExpiresAt: expiresAtIso }, "intent_pick_retry"); } catch (_) {}
              try { if (typeof sessionUpsert_ === "function") sessionUpsert_(phone, { expected: "INTENT_PICK", stage: "INTENT_PICK", expiresAtIso: expiresAtIso }, "intent_pick_retry"); } catch (_) {}
              return sendRouterSms_(
                phone,
                renderTenantKey_("INTENT_PICK", String((ctx && ctx.lang) || "en"), {}),
                "INTENT_PICK",
                _routerInboundCh
              );
            }

            if (isMaintExpected) {
              var fastHandled = tryHandleContinuationFastPath_(phone, bodyTrim, ctx, expUp, e);
              if (fastHandled) {
                try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "FAST_PATH_HANDLED_TRUE exp=[" + String(expUp || "") + "]"); } catch (_) {}
                try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "FAST_PATH_BLOCK_CORE exp=[" + String(expUp || "") + "]"); } catch (_) {}
                try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "ROUTER_FAST_CONT_RETURN handled=1 exp=[" + String(expUp || "") + "]"); } catch (_) {}
                return;
              }
              try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "FAST_PATH_HANDLED_FALSE exp=[" + String(expUp || "") + "] reason=[no_fast_match]"); } catch (_) {}
              try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "ROUTER_FAST_CONT_RETURN handled=0 exp=[" + String(expUp || "") + "] routingCore=1"); } catch (_) {}
              // Ambiguous attach vs new-ticket: do not let core silently merge.
              try {
                var _dirSr2 = getSheet_(DIRECTORY_SHEET_NAME);
                var _dirRowSr2 = (typeof findDirectoryRowByPhone_ === "function") ? findDirectoryRowByPhone_(_dirSr2, phone) : 0;
                var _attachDecAmb = (typeof properaIntakeAttachClassify_ === "function")
                  ? properaIntakeAttachClassify_({
                      phone: phone,
                      bodyTrim: bodyTrim,
                      turnFacts: {},
                      collectStage: expUp,
                      dir: _dirSr2,
                      dirRow: _dirRowSr2
                    })
                  : null;
                if (_attachDecAmb && _attachDecAmb.attachmentDecision === "clarify_attach_vs_new") {
                  try { logDevSms_(phone, bodyTrim, "ATTACH_CLARIFY_REQUIRED reason=[clarify_attach_vs_new_from_core_entry]"); } catch (_) {}
                  try { logDevSms_(phone, bodyTrim, "ATTACH_CLARIFY_PROMPT_SENT reason=[clarify_attach_vs_new]"); } catch (_) {}
                  // Latch for clarification: keep TTL bounded.
                  try {
                    if (typeof ctxUpsert_ === "function") {
                      var _clarMs2 = Date.now() + 3 * 60 * 1000;
                      ctxUpsert_(phone, { pendingExpected: "ATTACH_CLARIFY", pendingExpiresAt: new Date(_clarMs2).toISOString(), lastIntent: "ATTACH_CLARIFY" }, "ATTACH_CLARIFY_PROMPT_SENT");
                    }
                  } catch (_) {}
                  // Deterministic prompt (works for Telegram via dispatchTenantIntent_).
                  var _canonSh2 = ensureCanonicalIntakeSheet_();
                  var _canonRec2 = canonicalIntakeLoadNoLock_(_canonSh2, phone);
                  var _expectedUnit2 = (_canonRec2 && _canonRec2.unit) ? String(_canonRec2.unit || "").trim() : "";
                  var _txtC =
                    "Is this for the same maintenance request or a new one?\n" +
                    "1) Same request\n" +
                    "2) New request";
                  if (_expectedUnit2) _txtC += "\nIf you choose 2, what is the unit number? (Expected: " + _expectedUnit2 + ")";
                  var _langC = String((ctx && ctx.lang) || "en").toLowerCase();
                  if (_langC.indexOf("-") > 0) _langC = _langC.split("-")[0];
                  var _intentC = {
                    intentType: "CORE_TEXT_REPLY",
                    recipientType: "TENANT",
                    recipientRef: phone,
                    lang: _langC,
                    channel: (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : scopeChannel,
                    deliveryPolicy: "DIRECT_SEND",
                    preRenderedBody: _txtC,
                    vars: {},
                    meta: { source: "ATTACH_CLARIFY", stage: "ATTACH_CLARIFY", flow: "MAINT_INTAKE" }
                  };
                  try { dispatchTenantIntent_(e, phone, bodyTrim, _intentC); } catch (_) {}
                  return;
                }
              } catch (_) {}
              try {
                var dirSr = getSheet_(DIRECTORY_SHEET_NAME);
                var dirRowSr = (typeof findDirectoryRowByPhone_ === "function") ? findDirectoryRowByPhone_(dirSr, phone) : 0;
                var nmSr = (typeof parseCanonicalMediaArrayFromEvent_ === "function") ? parseCanonicalMediaArrayFromEvent_(e).length : (parseInt(String((p && p.NumMedia) || "0"), 10) || 0);
                if (typeof compassApplyMaintenanceShortReplyNoReopen_ === "function") {
                  compassApplyMaintenanceShortReplyNoReopen_(e, phone, bodyTrim, ctx, dirSr, dirRowSr, nmSr);
                }
              } catch (_sr0) {}
              return routeToCoreSafe_(e, { channel: scopeChannel });
            }
            if (isAmenityExpected) return handleAmenitySms_(e);
          }
        }
      }
    }
  } catch (pendingOverrideErr) {
    // ✅ FIX B: Log pending override errors (was silently swallowed)
    try { logDevSms_(phone, bodyTrim, "PENDING_OVERRIDE_ERR " + String(pendingOverrideErr && pendingOverrideErr.message ? pendingOverrideErr.message : pendingOverrideErr)); } catch (_) {}
  }

  // 3) GLOBAL COMMANDS (router-only)
  if (isGlobalResetCommand_(bodyLower)) {
    try { logDevSms_(phone, bodyTrim, "ROUTER_BRANCH GLOBAL_RESET"); } catch (_) {}
    return handleGlobalReset_(e);
  }

  // 4) AMENITY (single deterministic branch)
  try {
    // Amenity lane is closed by default for now (opt-in only).
    var amenityLaneEnabled = false;
    try {
      var _alRaw = String(PropertiesService.getScriptProperties().getProperty("AMENITY_LANE_ENABLED") || "").trim().toLowerCase();
      amenityLaneEnabled = (_alRaw === "1" || _alRaw === "true" || _alRaw === "on" || _alRaw === "yes");
    } catch (_) { amenityLaneEnabled = false; }
    if (!amenityLaneEnabled) {
      try { logDevSms_(phone, bodyTrim, "AMENITY_LANE_DISABLED default=core"); } catch (_) {}
    }
    const amenityCmd = isAmenityCommand_(bodyLower);
    const amenityStage = isAmenityExpected_(ctx);
    const amenitySticky = hasActiveAmenityFlow_(phone);

    if (amenityLaneEnabled && (amenityCmd || amenityStage || amenitySticky)) {
      try {
        logDevSms_(
          phone,
          bodyTrim,
          "ROUTER_BRANCH AMENITY single cmd=" + amenityCmd + " stage=" + amenityStage + " sticky=" + amenitySticky
        );
      } catch (_) {}

      return handleAmenitySms_(e);
    }
  } catch (_) {}

  // 5) LEASING LANE (availability, tours)
// Long-term rule:
// - Leasing may run if (a) explicit leasing keywords OR (b) already in leasing stage.
// - Leasing must NOT hijack known maintenance conversations or numeric/unit replies.
// - ctx must be null-safe.
let leasingIntent = null;
const hasStrongLeasing = (typeof isLeasingIntentStrong_ === "function") && isLeasingIntentStrong_(bodyTrim);
const maintVeto = (typeof isMaintenanceVeto_ === "function") && isMaintenanceVeto_(bodyTrim);
// Leasing lane is closed by default for now (opt-in only).
var leasingLaneEnabled = false;
try {
  var _llRaw = String(PropertiesService.getScriptProperties().getProperty("LEASING_LANE_ENABLED") || "").trim().toLowerCase();
  leasingLaneEnabled = (_llRaw === "1" || _llRaw === "true" || _llRaw === "on" || _llRaw === "yes");
} catch (_) { leasingLaneEnabled = false; }

// Null-safe leasing stage flag
const leasingPending = String((ctx && ctx.leasingPendingExpected) || "");
let isLeasingStage = (leasingPending.indexOf("LEASING_") === 0);
if (!leasingLaneEnabled) {
  leasingIntent = null;
  isLeasingStage = false;
  try { logDevSms_(phone, bodyTrim, "LEASING_LANE_DISABLED default=core"); } catch (_) {}
}

// Guard A: Never hijack maintenance conversations (pendingExpected)
const maintExpectedForLeasing = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();
const isMaintBusy = (
  maintExpectedForLeasing === "PROPERTY" ||
  maintExpectedForLeasing === "UNIT" ||
  maintExpectedForLeasing === "ISSUE" ||
  maintExpectedForLeasing === "DETAIL" ||
  maintExpectedForLeasing === "SCHEDULE" ||
  maintExpectedForLeasing === "EMERGENCY_DONE" ||
  maintExpectedForLeasing.indexOf("SCHEDULE_") === 0
);

if (isMaintBusy) {
  try { logDevSms_(phone, bodyTrim, "LEASING_GUARD_SKIP maintExpected=[" + maintExpectedForLeasing + "]"); } catch (_) {}
  isLeasingStage = false; // prevent leasing stage from stealing it
} else if (leasingLaneEnabled) {

  // Guard B: Bare numbers are never leasing
  const trimmedForLeasing = String(bodyTrim || "").trim();
  if (/^\d{1,6}$/.test(trimmedForLeasing)) {
    try { logDevSms_(phone, bodyTrim, "LEASING_GUARD_BARE_NUMBER rejected=[" + trimmedForLeasing + "]"); } catch (_) {}
    leasingIntent = null;
  } else {
    var _detectLeasing = (typeof detectLeasingIntent_ === "function") && detectLeasingIntent_(bodyLower, ctx);
    if (maintVeto && (_detectLeasing || isLeasingStage)) {
      try { logDevSms_(phone, bodyTrim.slice(0, 60), "ROUTER_VETO leasing_blocked_by_maint maint=1 leasingStrong=" + (hasStrongLeasing ? 1 : 0)); } catch (_) {}
    }
    leasingIntent = (_detectLeasing && hasStrongLeasing && !maintVeto) ? _detectLeasing : null;
    if (maintVeto) isLeasingStage = false;
  }

  // OPTIONAL Guard C (recommended): Known tenants default to CORE unless explicit leasing intent
  // If you don't have isKnownTenantPhone_ yet, comment this block out.
  try {
    if (!isLeasingStage && !leasingIntent && typeof isKnownTenantPhone_ === "function") {
      if (isKnownTenantPhone_(phone)) {
        try { logDevSms_(phone, bodyTrim, "LEASING_GUARD_KNOWN_TENANT default=CORE"); } catch (_) {}
        leasingIntent = null;
        isLeasingStage = false;
      }
    }
  } catch (_) {}
}

// =====================================================
// Phase 3 — Continuation fast-path (shared front only)
// Conservative scope:
// - PROPERTY / UNIT / ISSUE / DETAIL: directory + prompt via resolveEffectiveTicketState_
// - UNIT → FINALIZE_DRAFT: same finalizeDraftAndCreateTicket_ + post-finalize intents as core (no compileTurn replay)
// - SCHEDULE (ticket row present): shared handleScheduleSingleTicket_ (same as core SCHEDULE stage)
// All ambiguous/other paths fall through to canonical core.
// =====================================================
function continuationFastPathEnabled_() {
  try {
    var v = String(PropertiesService.getScriptProperties().getProperty("CONTINUATION_FASTPATH_ENABLED") || "").trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    return true; // default ON for Phase 3 rollout
  } catch (_) { return true; }
}

function tryHandleContinuationFastPath_(phone, bodyTrim, ctx, expUp, e) {
  try {
    var _fastStartMs = Date.now();
    var _fcBody = String(bodyTrim || "").slice(0, 80);
    if (!continuationFastPathEnabled_()) {
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=disabled"); } catch (_) {}
      return false;
    }
    if (!phone || !bodyTrim) {
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=no_phone_or_body"); } catch (_) {}
      return false;
    }
    if (expUp !== "PROPERTY" && expUp !== "UNIT" && expUp !== "ISSUE" && expUp !== "DETAIL" && expUp !== "SCHEDULE" && expUp !== "SCHEDULE_PRETICKET") {
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=exp_not_eligible exp=[" + String(expUp || "") + "]"); } catch (_) {}
      return false;
    }

    var dir = getSheet_(DIRECTORY_SHEET_NAME);
    var dirRow = ensureDirectoryRowForPhone_(dir, phone);
    if (!dir || !dirRow || dirRow < 2) {
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=no_dir_row row=[" + String(dirRow || 0) + "]"); } catch (_) {}
      return false;
    }
    try {
      logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_ENTER exp=[" + String(expUp || "") + "] dirRow=[" + String(dirRow) + "] note=no_core_if_handled");
    } catch (_) {}

    var _fastPkgCtx = {};
    if (expUp === "PROPERTY" || expUp === "PROPERTY_AND_UNIT") {
      _fastPkgCtx.__pendingCollectStage = expUp;
      try {
        if (typeof dalGetPendingIssue_ === "function") {
          _fastPkgCtx.__priorPendingIssue = String(dalGetPendingIssue_(dir, dirRow) || "").trim();
        }
      } catch (_) {}
    }

    // Canonical opener/package interpretation for fast-path decisions.
    var openerFacts = null;
    try {
      if (typeof properaBuildIntakePackage_ === "function") {
        openerFacts = properaBuildIntakePackage_({
          bodyTrim: bodyTrim,
          mergedBodyTrim: bodyTrim,
          phone: phone,
          lang: String((ctx && ctx.lang) || "en"),
          baseVarsRef: _fastPkgCtx,
          cigContext: (typeof properaBuildCIGContext_ === "function")
            ? (properaBuildCIGContext_(phone, ctx || null, (typeof dir !== "undefined" ? dir : null), (typeof dirRow !== "undefined" ? dirRow : 0)) || null)
            : null
        });
      }
    } catch (_) {}
    try {
      var _fcp = (openerFacts && openerFacts.property && openerFacts.property.code) ? String(openerFacts.property.code || "").trim() : "";
      var _fcu = (openerFacts && openerFacts.unit != null) ? String(openerFacts.unit || "").trim() : "";
      var _fci = !!(openerFacts && String(openerFacts.issue || "").trim());
      var _fcs = !!(openerFacts && openerFacts.schedule && String(openerFacts.schedule.raw || "").trim());
      var _fcSig = (openerFacts && openerFacts.structuredSignal && openerFacts.structuredSignal.extractionSource) ? String(openerFacts.structuredSignal.extractionSource || "").trim() : "";
      logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_PACKAGE exp=[" + String(expUp || "") + "] prop=[" + (_fcp || "-") + "] unit=[" + (_fcu || "-") + "] hasIssue=[" + (_fci ? "1" : "0") + "] hasSched=[" + (_fcs ? "1" : "0") + "] sigSrc=[" + (_fcSig || "-") + "]");
    } catch (_) {}
    var _openerFactsPreAttach = openerFacts;
    try {
      var _expUpSt = String(expUp || "").trim().toUpperCase();
      var _adFc = null;
      var _tfFc = openerFacts || {};
      if (typeof properaIntakeAttachClassify_ === "function" && typeof properaApplyAttachDecisionToTurnFacts_ === "function") {
        _adFc = properaIntakeAttachClassify_({
          phone: phone,
          bodyTrim: String(bodyTrim || ""),
          turnFacts: _tfFc,
          collectStage: _expUpSt,
          dir: dir,
          dirRow: dirRow
        });
        _tfFc = properaApplyAttachDecisionToTurnFacts_(_tfFc, _adFc);
      }
      openerFacts = _tfFc;
      var _cmrFast = properaCanonicalIntakeMergeCommit_({
        phone: phone,
        dir: dir,
        dirRow: dirRow,
        turnFacts: _tfFc,
        writerTag: "FAST_CONT_CANONICAL_COMMIT",
        mirrorWrites: true,
        collectStage: _expUpSt,
        attachDecision: _adFc,
        inboundBodyTrim: String(bodyTrim || "")
      });
      if (_cmrFast && !_cmrFast.ok && _cmrFast.reason === "clarify_blocked") {
        var __reqClarifyResolved = (typeof globalThis !== "undefined" && String(globalThis.__attachClarifyResolvedThisTurn || "") === "1");
        if (__reqClarifyResolved) {
          try { logDevSms_(phone, _fcBody, "ATTACH_CLARIFY_REENTRY_SUPPRESSED reason=[fast_prompt_block_guard]"); } catch (_) {}
          return true;
        }
        try { logDevSms_(phone, _fcBody, "ATTACH_CLARIFY_REQUIRED reason=[clarify_blocked_from_fast]"); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ATTACH_CLARIFY_PROMPT_SENT reason=[clarify_blocked]"); } catch (_) {}
        try {
          if (typeof ctxUpsert_ === "function") {
            var _clarMs = Date.now() + 3 * 60 * 1000;
            ctxUpsert_(phone, { pendingExpected: "ATTACH_CLARIFY", pendingExpiresAt: new Date(_clarMs).toISOString(), lastIntent: "ATTACH_CLARIFY" }, "ATTACH_CLARIFY_PROMPT_SENT");
          }
        } catch (_) {}
        var _canonSh3 = ensureCanonicalIntakeSheet_();
        var _canonRec3 = canonicalIntakeLoadNoLock_(_canonSh3, phone);
        var _expectedUnit3 = (_canonRec3 && _canonRec3.unit) ? String(_canonRec3.unit || "").trim() : "";
        var _txtFastC =
          "Is this for the same maintenance request or a new one?\n" +
          "1) Same request\n" +
          "2) New request";
        if (_expectedUnit3) _txtFastC += "\nIf you choose 2, what is the unit number? (Expected: " + _expectedUnit3 + ")";
        var _langFastC = String((openerFacts && openerFacts.lang) || "en").toLowerCase();
        if (_langFastC.indexOf("-") > 0) _langFastC = _langFastC.split("-")[0];
        var _intentFastC = {
          intentType: "CORE_TEXT_REPLY",
          recipientType: "TENANT",
          recipientRef: phone,
          lang: _langFastC,
          channel: (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS",
          deliveryPolicy: "DIRECT_SEND",
          preRenderedBody: _txtFastC,
          vars: {},
          meta: { source: "ATTACH_CLARIFY", stage: "ATTACH_CLARIFY", flow: "FAST_CONTINUATION" }
        };
        try { dispatchTenantIntent_(e, phone, bodyTrim, _intentFastC); } catch (_) {}
        return true;
      }
    } catch (_) {}
    // Universal emergency interrupt: consume opener safety facts (pre-attach package preserves safety signal).
    var em = (_openerFactsPreAttach && _openerFactsPreAttach.safety) ? _openerFactsPreAttach.safety : { isEmergency: false };
    if (em && em.isEmergency) {
      try {
        logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=emergency exp=[" + String(expUp || "") + "]");
        if (expUp === "SCHEDULE") logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_EMERGENCY_FALLBACK");
        else if (expUp === "UNIT") logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_UNIT_TO_FINALIZE_EMERGENCY_FALLBACK");
      } catch (_) {}
      return false;
    }

    var lang = String((openerFacts && openerFacts.lang) || "en").toLowerCase();
    if (lang.indexOf("-") > 0) lang = lang.split("-")[0];
    var FAST_MEANING_REGISTRY_ = {
      SCHEDULE_RECORDED_ACK: { family: "ACK" },
      TICKET_CREATE_ACK: { family: "ACK" },
      ASK_PROPERTY_AND_UNIT: { family: "ASK_NEXT_SLOT" },
      ASK_NEXT_SLOT_UNIT: { family: "ASK_NEXT_SLOT", stage: "UNIT", defaultText: function () { return renderTenantKey_("ASK_UNIT", lang, {}); } },
      ASK_NEXT_SLOT_ISSUE: { family: "ASK_NEXT_SLOT", stage: "ISSUE", defaultText: function () { return renderTenantKey_("ASK_ISSUE_GENERIC", lang, {}); } },
      ASK_NEXT_SLOT_DETAIL: { family: "ASK_NEXT_SLOT", stage: "DETAIL", defaultText: function () { return renderTenantKey_("ASK_DETAIL", lang, {}); } },
      ASK_NEXT_SLOT_SCHEDULE: { family: "ASK_NEXT_SLOT", stage: "SCHEDULE", defaultText: function () { return renderTenantKey_("ASK_WINDOW_SIMPLE", lang, {}); } }
    };
    function fastMeaningMeta_(type) {
      var t = String(type || "").trim().toUpperCase();
      return FAST_MEANING_REGISTRY_[t] || null;
    }
    function fastMeaningFamily_(type) {
      var m = fastMeaningMeta_(type);
      return m && m.family ? String(m.family) : "";
    }
    function fastShouldSuppressEquivalent_(fastReplyCtx, meaningType) {
      if (!fastReplyCtx || !fastReplyCtx.sent) return false;
      var a = fastMeaningFamily_(fastReplyCtx.type);
      var b = fastMeaningFamily_(meaningType);
      return !!(a && b && a === b && String(fastReplyCtx.type || "") === String(meaningType || ""));
    }
    function fastStageToMeaningType_(stage) {
      var s = String(stage || "").trim().toUpperCase();
      if (s === "UNIT") return "ASK_NEXT_SLOT_UNIT";
      if (s === "ISSUE") return "ASK_NEXT_SLOT_ISSUE";
      if (s === "DETAIL") return "ASK_NEXT_SLOT_DETAIL";
      if (s === "SCHEDULE" || s === "SCHEDULE_PRETICKET") return "ASK_NEXT_SLOT_SCHEDULE";
      return "";
    }
    function fastBuildStagePromptText_(stage) {
      var meaning = fastStageToMeaningType_(stage);
      var m = fastMeaningMeta_(meaning);
      if (m && typeof m.defaultText === "function") return String(m.defaultText() || "");
      return "";
    }
    function fastContinuationResponseFirst_(meaningBucket, textOrIntent, sourceTag) {
      var sent = false;
      var ch = (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS";
      var bucket = String(meaningBucket || "").trim().toUpperCase();
      var src = String(sourceTag || "").trim();
      try {
        var _intentPayload = null;
        if (textOrIntent && typeof textOrIntent === "object") {
          _intentPayload = Object.assign({}, textOrIntent, {
            recipientType: "TENANT",
            recipientRef: phone,
            lang: lang,
            channel: ch,
            deliveryPolicy: String(textOrIntent.deliveryPolicy || "NO_HEADER").trim()
          });
        } else {
          _intentPayload = {
            intentType: "CORE_TEXT_FASTPATH",
            recipientType: "TENANT",
            recipientRef: phone,
            lang: lang,
            channel: ch,
            deliveryPolicy: "NO_HEADER",
            preRenderedBody: String(textOrIntent || "").trim(),
            vars: {}
          };
        }
        if (!_intentPayload.meta || typeof _intentPayload.meta !== "object") _intentPayload.meta = {};
        _intentPayload.meta = Object.assign({}, _intentPayload.meta, {
          source: "handleInboundRouter_",
          stage: String(expUp || ""),
          flow: "FAST_CONTINUATION_RESPONSE_FIRST",
          fastReplySent: true,
          fastReplyType: bucket,
          fastReplySource: src
        });
        var _dispCont = (typeof dispatchTenantIntent_ === "function")
          ? dispatchTenantIntent_(e, phone, bodyTrim, _intentPayload)
          : { ok: false, error: "dispatchTenantIntent_missing" };
        sent = !!_dispCont.ok;
      } catch (_) { sent = false; }
      if (sent) {
        try {
          logDevSms_(
            phone,
            String(bodyTrim || "").slice(0, 60),
            "FAST_REPLY_SENT type=[" + bucket + "] source=[" + src + "] ch=[" + String(ch) + "]"
          );
        } catch (_) {}
        try {
          var _lat = Date.now() - _fastStartMs;
          logDevSms_(phone, "", "FAST_REPLY_LATENCY_MS value=[" + String(_lat) + "] type=[" + bucket + "]");
        } catch (_) {}
        try { logDevSms_(phone, "", "FAST_REPLY_DEDUPE_MARK type=[" + bucket + "] source=[" + src + "]"); } catch (_) {}
      }
      return {
        sent: sent,
        type: bucket,
        source: src,
        channel: ch,
        sentAtMs: sent ? Date.now() : 0
      };
    }
    function fastReplySummaryLog_(flowTag, fastReplyCtx, writeAfterStartMs) {
      try {
        var nowMs = Date.now();
        var firstReplyMs = (fastReplyCtx && fastReplyCtx.sentAtMs) ? Math.max(0, fastReplyCtx.sentAtMs - _fastStartMs) : -1;
        var writeAfterMs = writeAfterStartMs ? Math.max(0, nowMs - writeAfterStartMs) : -1;
        var totalMs = Math.max(0, nowMs - _fastStartMs);
        logDevSms_(
          phone,
          "",
          "FAST_REPLY_SUMMARY flow=[" + String(flowTag || "") + "] first_reply_ms=[" + String(firstReplyMs) + "] write_after_ms=[" + String(writeAfterMs) + "] total_ms=[" + String(totalMs) + "]"
        );
      } catch (_) {}
    }
    function resolveNextContinuationStage_() {
      try { recomputeDraftExpected_(dir, dirRow, phone, null); } catch (_) {}
      try {
        var authFast = properaResolveStageAuthority_(phone, { dir: dir, dirRow: dirRow });
        var nextFast = String((authFast && authFast.stage) || "").trim().toUpperCase();
        if (nextFast) {
          try { logDevSms_(phone, "", "CANONICAL_STAGE_USED expected=[" + nextFast + "] source=[" + String((authFast && authFast.source) || "fast_continuation") + "]"); } catch (_) {}
          return nextFast;
        }
      } catch (_) {}
      var ctxNow = null;
      try { ctxNow = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null; } catch (_) {}
      try { ctxNow = properaCanonicalIntakeHydrateCtx_(phone, ctxNow); } catch (_) {}
      var st = String((ctxNow && ctxNow.pendingExpected) || "").trim().toUpperCase();
      if (!st) {
        try {
          if (dir && dirRow && dirRow >= 2 && typeof dalGetPendingStage_ === "function") {
            st = String(dalGetPendingStage_(dir, dirRow) || "").trim().toUpperCase();
          }
        } catch (_) {}
      }
      return st;
    }
    function emitPromptForStage_(stage, logTag, fastReplyCtx) {
      var _meaning = fastStageToMeaningType_(stage);
      if (_meaning && fastShouldSuppressEquivalent_(fastReplyCtx, _meaning)) {
        try { logDevSms_(phone, "", "FAST_REPLY_DUP_SUPPRESS bucket=[" + _meaning + "] source=[" + String((fastReplyCtx && fastReplyCtx.source) || "") + "] branch=[emitPromptForStage_] handled=1"); } catch (_) {}
        try { logDevSms_(phone, "", "FAST_PATH_BLOCK_CORE reason=[duplicate_equivalent_prompt] branch=[emitPromptForStage_]"); } catch (_) {}
        return true;
      }
      if (_meaning) {
        try { logDevSms_(phone, "", "FAST_REPLY_DUP_ALLOW bucket=[" + _meaning + "] branch=[emitPromptForStage_]"); } catch (_) {}
      }
      if (stage === "UNIT") {
        var _ifu = { intentType: "ASK_FOR_MISSING_UNIT", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: getResolvedInboundChannel_(e), deliveryPolicy: "DIRECT_SEND", vars: {}, meta: { source: "handleInboundRouter_", stage: "UNIT", flow: "FAST_CONTINUATION" } };
        var _rU = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, _ifu) : { ok: false };
        try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "ROUTER_FAST_CONT_PROMPT intent=ASK_FOR_MISSING_UNIT ok=[" + (_rU && _rU.ok ? "1" : "0") + "] tag=[" + String(logTag || "") + "]"); } catch (_) {}
        return !!_rU.ok;
      }
      if (stage === "ISSUE") {
        var _ifi = { intentType: "ASK_FOR_ISSUE", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: getResolvedInboundChannel_(e), deliveryPolicy: "DIRECT_SEND", vars: {}, meta: { source: "handleInboundRouter_", stage: "ISSUE", flow: "FAST_CONTINUATION" } };
        var _rI = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, _ifi) : { ok: false };
        try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "ROUTER_FAST_CONT_PROMPT intent=ASK_FOR_ISSUE ok=[" + (_rI && _rI.ok ? "1" : "0") + "] tag=[" + String(logTag || "") + "]"); } catch (_) {}
        return !!_rI.ok;
      }
      if (stage === "DETAIL") {
        var _txtD = renderTenantKey_("ASK_DETAIL", lang, {});
        var _ifd = { intentType: "CORE_TEXT_REPLY", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: getResolvedInboundChannel_(e), deliveryPolicy: "DIRECT_SEND", preRenderedBody: _txtD, vars: {}, meta: { source: "handleInboundRouter_", stage: "DETAIL", flow: "FAST_CONTINUATION" } };
        var _rD = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, _ifd) : { ok: false };
        try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "ROUTER_FAST_CONT_PROMPT intent=ASK_DETAIL ok=[" + (_rD && _rD.ok ? "1" : "0") + "] tag=[" + String(logTag || "") + "]"); } catch (_) {}
        return !!_rD.ok;
      }
      if (stage === "SCHEDULE" || stage === "SCHEDULE_PRETICKET") {
        var _txtS = renderTenantKey_("ASK_WINDOW_SIMPLE", lang, {});
        var _ifs = { intentType: "CORE_TEXT_REPLY", recipientType: "TENANT", recipientRef: phone, lang: lang, channel: getResolvedInboundChannel_(e), deliveryPolicy: "DIRECT_SEND", preRenderedBody: _txtS, vars: {}, meta: { source: "handleInboundRouter_", stage: "SCHEDULE", flow: "FAST_CONTINUATION" } };
        var _rS = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, _ifs) : { ok: false };
        try { logDevSms_(phone, String(bodyTrim || "").slice(0, 80), "ROUTER_FAST_CONT_PROMPT intent=ASK_WINDOW_SIMPLE stage=[" + String(stage || "") + "] ok=[" + (_rS && _rS.ok ? "1" : "0") + "] tag=[" + String(logTag || "") + "]"); } catch (_) {}
        return !!_rS.ok;
      }
      return false;
    }

    function fastPathFinalizeDraft_(sourceTag, fastReplyCtx) {
      try { logDevSms_(phone, bodyTrim, "FAST_PATH_FINALIZE_TRY source=" + sourceTag); } catch (_) {}
      var _writeStartFin = Date.now();
      try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_START tag=[" + sourceTag + "]"); } catch (_) {}
      var prFin = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
      if (prFin >= 2) {
        try { logDevSms_(phone, bodyTrim, "FAST_PATH_FINALIZE_SKIP reason=pending_row_exists pr=" + prFin + " source=" + sourceTag); } catch (_) {}
        return false;
      }
      var _fdPropFin = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
      var propCodeFin = String(_fdPropFin.code || "").trim();
      var propNameFin = String(_fdPropFin.name || "").trim();
      var issueFin = (typeof dalGetPendingIssue_ === "function") ? String(dalGetPendingIssue_(dir, dirRow) || "").trim() : "";
      var unitSnapFin = String((typeof dalGetPendingUnit_ === "function" ? dalGetPendingUnit_(dir, dirRow) : "") || "").trim();
      if (!issueFin && openerFacts && openerFacts.issue) issueFin = String(openerFacts.issue || "").trim();
      if (!propCodeFin && openerFacts && openerFacts.property && openerFacts.property.code) {
        propCodeFin = String(openerFacts.property.code || "").trim();
        propNameFin = String(openerFacts.property.name || "").trim();
      }
      if (!unitSnapFin && openerFacts && openerFacts.unit) unitSnapFin = String(openerFacts.unit || "").trim();
      var hasIssueFin = Boolean(issueFin) || (typeof getIssueBuffer_ === "function" && getIssueBuffer_(dir, dirRow) && getIssueBuffer_(dir, dirRow).length >= 1);
      if (typeof sessionGet_ === "function") {
        var sFin = sessionGet_(phone) || {};
        if (sFin.draftIssue && !issueFin) issueFin = String(sFin.draftIssue || "").trim();
        if (sFin.issueBuf && sFin.issueBuf.length >= 1) hasIssueFin = true;
        if (sFin.draftProperty && !propCodeFin) propCodeFin = String(sFin.draftProperty || "").trim();
        if (sFin.draftUnit && !unitSnapFin) unitSnapFin = String(sFin.draftUnit || "").trim();
        if (!propNameFin && propCodeFin && typeof getPropertyByCode_ === "function") {
          var pFin = getPropertyByCode_(propCodeFin);
          if (pFin && pFin.name) propNameFin = String(pFin.name || "").trim();
        }
      }
      if (!propCodeFin || !unitSnapFin || !hasIssueFin) {
        try {
          logDevSms_(phone, bodyTrim, "FAST_PATH_FINALIZE_SKIP reason=missing_draft_fields propCode=[" + propCodeFin + "] unit=[" + unitSnapFin + "] hasIssue=[" + (hasIssueFin ? "1" : "0") + "] source=" + sourceTag);
        } catch (_) {}
        return false;
      }
      try {
        logDevSms_(phone, bodyTrim, "FAST_PATH_FINALIZE_ENTER prop=[" + propCodeFin + "] unit=[" + unitSnapFin + "] issue=[" + (issueFin ? "1" : "0") + "] source=" + sourceTag);
      } catch (_) {}
      var sheetFin = getSheet_(SHEET_NAME);
      var baseVarsFin = { brandName: BRAND.name, teamName: BRAND.team };
      var spFin = PropertiesService.getScriptProperties();
      var pEvF = (e && e.parameter) ? e.parameter : {};
      var sidFin = String(pEvF.MessageSid || pEvF.SmsMessageSid || (typeof safeParam_ === "function" ? safeParam_(e, "MessageSid") : "") || (typeof safeParam_ === "function" ? safeParam_(e, "SmsMessageSid") : "") || "").trim();
      var fromDedFin = String(pEvF.From || (typeof safeParam_ === "function" ? safeParam_(e, "From") : "") || "").trim().toLowerCase();
      var chMetaFin = String(pEvF._channel || (typeof safeParam_ === "function" ? safeParam_(e, "_channel") : "") || "").trim().toUpperCase();
      var sidSafeFin = sidFin ? String(sidFin) : ("NOSID:" + (typeof _nosidDigest_ === "function" ? _nosidDigest_(fromDedFin, bodyTrim) : String((bodyTrim || "").length)));
      var chFin = (fromDedFin.indexOf("whatsapp:") === 0) ? "WA" : "SMS";
      if (chMetaFin === "TELEGRAM" || /^tg:/i.test(String(pEvF.From || ""))) chFin = "TELEGRAM";
      var inboundKeyFin = "SID:" + chFin + ":" + sidSafeFin;
      var finResult = finalizeDraftAndCreateTicket_(sheetFin, dir, dirRow, phone, phone, {
        inboundKey: inboundKeyFin,
        lang: lang,
        baseVars: baseVarsFin,
        locationText: bodyTrim,
        locationType: (openerFacts && openerFacts.location && openerFacts.location.locationType) ? String(openerFacts.location.locationType || "") : "",
        turnIssueMeta: (openerFacts && openerFacts.issueMeta) ? openerFacts.issueMeta : null,
        semanticTextEnglish: (openerFacts && openerFacts.semanticTextEnglish != null) ? String(openerFacts.semanticTextEnglish || "").trim() : "",
        firstMediaUrl: "",
        mediaType: "",
        mediaCategoryHint: "",
        mediaSubcategoryHint: "",
        mediaUnitHint: "",
        OPENAI_API_KEY: String(spFin.getProperty("OPENAI_API_KEY") || "")
      });
      try {
        logDevSms_(phone, bodyTrim, "FINALIZE_RESULT ok=[" + (finResult && finResult.ok ? "1" : "0") + "] reason=[" + String((finResult && finResult.reason) || "") + "] multi=[" + (finResult && finResult.multiIssuePending ? "1" : "0") + "] ticketId=[" + String((finResult && finResult.ticketId) || "") + "] source=" + sourceTag);
      } catch (_) {}
      if (finResult && finResult.ok && finResult.loggedRow >= 2) {
        try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_CREATED pendingRow=[" + finResult.loggedRow + "] source=" + sourceTag); } catch (_) {}
      }
      applyFinalizeDraftResultOutcomesForRouter_(e, phone, bodyTrim, sheetFin, dir, dirRow, lang, baseVarsFin, finResult, issueFin, unitSnapFin, propNameFin, (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS", fastReplyCtx);
      fastReplySummaryLog_(sourceTag, fastReplyCtx, _writeStartFin);
      try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_DONE tag=[" + sourceTag + "] ok=[" + (finResult && finResult.ok ? "1" : "0") + "]"); } catch (_) {}
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=" + sourceTag + " finalizeAttempted=1"); } catch (_) {}
      return !!(finResult && finResult.ok);
    }

    if (expUp === "PROPERTY") {
      var p = (openerFacts && openerFacts.property && openerFacts.property.code) ? openerFacts.property : null;
      if (!(p && p.code)) {
        var _issueLikeWhenPropMissing = !!String((openerFacts && openerFacts.issue) || "").trim();
        var _sentPackagedPropAsk = false;
        if (_issueLikeWhenPropMissing) {
          var _frPack = fastContinuationResponseFirst_(
            "ASK_PROPERTY_AND_UNIT",
            (function () {
              var _hintC = String((openerFacts && openerFacts.issue) || bodyTrim || "").trim();
              var _varsC = Object.assign({ issueHint: _hintC }, (typeof properaPackagedPropertyAskSupplement_ === "function")
                ? properaPackagedPropertyAskSupplement_(openerFacts)
                : {});
              return {
                intentType: "ASK_PROPERTY_AND_UNIT_PACKAGED",
                vars: _varsC,
                deliveryPolicy: "NO_HEADER"
              };
            })(),
            "FAST_CONTINUATION_PROPERTY_MISSING_BOTH"
          );
          _sentPackagedPropAsk = !!(_frPack && _frPack.sent);
        }
        try {
          logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_END exp=PROPERTY return_core=1 noPropInPackage=1 sentPackagedAsk=[" + (_sentPackagedPropAsk ? "1" : "0") + "]");
        } catch (_) {}
        return false;
      }
      var _writeStartProperty = Date.now();

      dalWithLock_("FAST_CONT_PROPERTY", function () {
        dalSetPendingPropertyNoLock_(dir, dirRow, { code: String(p.code || "").trim(), name: String(p.name || "").trim() });
        var uFast = String((openerFacts && openerFacts.unit) || "").trim();
        if (uFast && typeof normalizeUnit_ === "function") {
          try { uFast = normalizeUnit_(uFast) || uFast; } catch (_) {}
        }
        if (uFast && typeof dalSetPendingUnitNoLock_ === "function") {
          var exu = "";
          try { exu = String(dalGetPendingUnit_(dir, dirRow) || "").trim(); } catch (_) {}
          if (!exu) {
            dalSetPendingUnitNoLock_(dir, dirRow, uFast);
            try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_DAL unit=[" + uFast + "] with_prop=1"); } catch (_) {}
          }
        }
        dalSetLastUpdatedNoLock_(dir, dirRow);
      });
      var nextAfterProperty = resolveNextContinuationStage_();
      if (nextAfterProperty === "FINALIZE_DRAFT") {
        var _fastReplyPropFin = fastContinuationResponseFirst_(
          "TICKET_CREATE_ACK",
          { intentType: "FAST_ACK_CREATE_IN_PROGRESS", vars: {}, deliveryPolicy: "NO_HEADER" },
          "FAST_CONT_PROPERTY_TO_FINALIZE"
        );
        if (fastPathFinalizeDraft_("FAST_CONT_PROPERTY_FINALIZE", _fastReplyPropFin)) {
          try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_HANDLED exp=PROPERTY next=FINALIZE_DRAFT"); } catch (_) {}
          try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=PROPERTY_TO_FINALIZE finalizeAttempted=1"); } catch (_) {}
          return true;
        }
      }
      if (emitPromptForStage_(nextAfterProperty, "FAST_CONT_PROPERTY_PROMPT", null)) {
        fastReplySummaryLog_("FAST_CONT_PROPERTY", { sent: false, sentAtMs: 0, type: "", source: "" }, _writeStartProperty);
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_HANDLED exp=PROPERTY next=" + nextAfterProperty); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=PROPERTY wroteProp=1 next=[" + String(nextAfterProperty || "") + "]"); } catch (_) {}
        return true;
      }
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_FALLBACK exp=PROPERTY next=" + nextAfterProperty); } catch (_) {}
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=property_prompt_failed next=[" + String(nextAfterProperty || "") + "]"); } catch (_) {}
      return false;
    }

    if (expUp === "UNIT") {
      var unitVal = String((openerFacts && openerFacts.unit) || "").trim();
      if (unitVal && typeof normalizeUnit_ === "function") unitVal = normalizeUnit_(unitVal);
      if (!unitVal) {
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=no_unit_in_package exp=UNIT"); } catch (_) {}
        return false;
      }

      dalWithLock_("FAST_CONT_UNIT", function () {
        dalSetPendingUnitNoLock_(dir, dirRow, unitVal);
        dalSetLastUpdatedNoLock_(dir, dirRow);
      });
      var nextAfterUnit = resolveNextContinuationStage_();

      if (nextAfterUnit === "FINALIZE_DRAFT") {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_UNIT_TO_FINALIZE_TRY next=" + nextAfterUnit); } catch (_) {}
        // RESPONSE-FIRST MODEL: acknowledge immediately; expensive finalize/write path continues after reply dispatch.
        var _fastReplyFinalize = fastContinuationResponseFirst_(
          "TICKET_CREATE_ACK",
          { intentType: "FAST_ACK_CREATE_IN_PROGRESS", vars: {}, deliveryPolicy: "NO_HEADER" },
          "FAST_CONTINUATION_UNIT_TO_FINALIZE"
        );
        var _writeStartFinalize = Date.now();
        try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_START tag=[FAST_CONT_UNIT_FINALIZE]"); } catch (_) {}
        var btFinalize = String(bodyTrim || "").trim().replace(/\s+/g, " ");
        if (!!String((openerFacts && openerFacts.issue) || "").trim()) {
          if (!/^(#|(apt\.?|unit)\s+)?[\w\-]+\s*$/i.test(btFinalize)) {
            try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_UNIT_TO_FINALIZE_FALLBACK reason=actionable_multi_token_body"); } catch (_) {}
            return false;
          }
        }
        var prU = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
        if (prU >= 2) {
          try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_UNIT_TO_FINALIZE_FALLBACK reason=pending_row_exists pr=" + prU); } catch (_) {}
          return false;
        }
        var _fdPropU = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
        var propCodeU = String(_fdPropU.code || "").trim();
        var propNameU = String(_fdPropU.name || "").trim();
        var issueU = (typeof dalGetPendingIssue_ === "function") ? String(dalGetPendingIssue_(dir, dirRow) || "").trim() : "";
        var unitSnapU = String((typeof dalGetPendingUnit_ === "function" ? dalGetPendingUnit_(dir, dirRow) : "") || "").trim();
        if (!unitSnapU) unitSnapU = unitVal;
        if (!issueU && openerFacts && openerFacts.issue) issueU = String(openerFacts.issue || "").trim();
        if (!propCodeU && openerFacts && openerFacts.property && openerFacts.property.code) {
          propCodeU = String(openerFacts.property.code || "").trim();
          propNameU = String(openerFacts.property.name || "").trim();
        }
        var hasIssueU = Boolean(issueU) || (typeof getIssueBuffer_ === "function" && getIssueBuffer_(dir, dirRow) && getIssueBuffer_(dir, dirRow).length >= 1);
        if (prU <= 0 && typeof sessionGet_ === "function") {
          var sU = sessionGet_(phone) || {};
          if (sU.draftIssue) issueU = String(sU.draftIssue || "").trim();
          if (sU.issueBuf && sU.issueBuf.length >= 1) hasIssueU = true;
          if (sU.draftProperty && !propCodeU) propCodeU = String(sU.draftProperty || "").trim();
          if (sU.draftUnit && !unitSnapU) unitSnapU = String(sU.draftUnit || "").trim();
          if (!propNameU && propCodeU && typeof getPropertyByCode_ === "function") {
            var pU = getPropertyByCode_(propCodeU);
            if (pU && pU.name) propNameU = String(pU.name || "").trim();
          }
        }
        if (!propCodeU || !hasIssueU) {
          try {
            logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_STATE_MERGE prop=[" + propCodeU + "] unit=[" + unitSnapU + "] issue=[" + (issueU ? "1" : "0") + "] src=[dir_session_opener]");
          } catch (_) {}
          try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_UNIT_TO_FINALIZE_FALLBACK reason=missing_draft_fields propCode=[" + propCodeU + "] hasIssue=[" + (hasIssueU ? "1" : "0") + "]"); } catch (_) {}
          try {
            if (typeof ctxUpsert_ === "function") {
              ctxUpsert_(phone, {
                pendingExpected: "UNIT",
                pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
                lastIntent: "MAINT"
              }, "FAST_CONTINUATION_FALLBACK_PRESERVED_STATE");
            }
            logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_FALLBACK_PRESERVED_STATE");
          } catch (_) {}
          return false;
        }
        try {
          logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_STATE_MERGE prop=[" + propCodeU + "] unit=[" + unitSnapU + "] issue=[" + (issueU ? "1" : "0") + "] src=[dir_session_opener]");
        } catch (_) {}
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_UNIT_TO_FINALIZE_ENTER"); } catch (_) {}
        var sheetU = getSheet_(SHEET_NAME);
        var baseVarsU = { brandName: BRAND.name, teamName: BRAND.team };
        var spU = PropertiesService.getScriptProperties();
        var pEv = (e && e.parameter) ? e.parameter : {};
        var sidU = String(pEv.MessageSid || pEv.SmsMessageSid || (typeof safeParam_ === "function" ? safeParam_(e, "MessageSid") : "") || (typeof safeParam_ === "function" ? safeParam_(e, "SmsMessageSid") : "") || "").trim();
        var fromDedU = String(pEv.From || (typeof safeParam_ === "function" ? safeParam_(e, "From") : "") || "").trim().toLowerCase();
        var chMetaU = String(pEv._channel || (typeof safeParam_ === "function" ? safeParam_(e, "_channel") : "") || "").trim().toUpperCase();
        var sidSafeU = sidU ? String(sidU) : ("NOSID:" + (typeof _nosidDigest_ === "function" ? _nosidDigest_(fromDedU, bodyTrim) : String((bodyTrim || "").length)));
        var chU = (fromDedU.indexOf("whatsapp:") === 0) ? "WA" : "SMS";
        if (chMetaU === "TELEGRAM" || /^tg:/i.test(String(pEv.From || ""))) chU = "TELEGRAM";
        var inboundKeyU = "SID:" + chU + ":" + sidSafeU;
        var finResult = finalizeDraftAndCreateTicket_(sheetU, dir, dirRow, phone, phone, {
          inboundKey: inboundKeyU,
          lang: lang,
          baseVars: baseVarsU,
          locationText: bodyTrim,
          locationType: (openerFacts && openerFacts.location && openerFacts.location.locationType) ? String(openerFacts.location.locationType || "") : "",
          turnIssueMeta: (openerFacts && openerFacts.issueMeta) ? openerFacts.issueMeta : null,
          semanticTextEnglish: (openerFacts && openerFacts.semanticTextEnglish != null) ? String(openerFacts.semanticTextEnglish || "").trim() : "",
          firstMediaUrl: "",
          mediaType: "",
          mediaCategoryHint: "",
          mediaSubcategoryHint: "",
          mediaUnitHint: "",
          OPENAI_API_KEY: String(spU.getProperty("OPENAI_API_KEY") || "")
        });
        try {
          logDevSms_(phone, bodyTrim, "FINALIZE_RESULT ok=[" + (finResult && finResult.ok ? "1" : "0") + "] reason=[" + String((finResult && finResult.reason) || "") + "] multi=[" + (finResult && finResult.multiIssuePending ? "1" : "0") + "] ticketId=[" + String((finResult && finResult.ticketId) || "") + "] source=ROUTER_UNIT_FAST");
        } catch (_) {}
        if (finResult && finResult.ok && finResult.loggedRow >= 2) {
          try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_CREATED pendingRow=[" + finResult.loggedRow + "] source=ROUTER_UNIT_FAST"); } catch (_) {}
        }
        applyFinalizeDraftResultOutcomesForRouter_(e, phone, bodyTrim, sheetU, dir, dirRow, lang, baseVarsU, finResult, issueU, unitSnapU, propNameU, (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS", _fastReplyFinalize);
        if (finResult && finResult.ok) {
          try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_UNIT_TO_FINALIZE_OK ticketId=[" + String((finResult && finResult.ticketId) || "") + "]"); } catch (_) {}
        }
        fastReplySummaryLog_("FAST_CONT_UNIT_FINALIZE", _fastReplyFinalize, _writeStartFinalize);
        try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_DONE tag=[FAST_CONT_UNIT_FINALIZE] ok=[" + (finResult && finResult.ok ? "1" : "0") + "]"); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=UNIT_TO_FINALIZE finalizeAttempted=1"); } catch (_) {}
        return true;
      }

      var _fastReplyUnitPrompt = null;
      var _unitMeaning = fastStageToMeaningType_(nextAfterUnit);
      if (_unitMeaning) {
        _fastReplyUnitPrompt = fastContinuationResponseFirst_(
          _unitMeaning,
          fastBuildStagePromptText_(nextAfterUnit),
          "FAST_CONTINUATION_UNIT_PROMPT"
        );
      }
      var _writeStartUnitPrompt = Date.now();
      if (emitPromptForStage_(nextAfterUnit, "FAST_CONT_UNIT_PROMPT", _fastReplyUnitPrompt)) {
        fastReplySummaryLog_("FAST_CONT_UNIT_PROMPT", _fastReplyUnitPrompt, _writeStartUnitPrompt);
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_HANDLED exp=UNIT next=" + nextAfterUnit); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=UNIT wroteUnit=1 next=[" + String(nextAfterUnit || "") + "]"); } catch (_) {}
        return true;
      }
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_FALLBACK exp=UNIT next=" + nextAfterUnit); } catch (_) {}
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=unit_prompt_or_path_failed next=[" + String(nextAfterUnit || "") + "]"); } catch (_) {}
      return false;
    }

    if (expUp === "ISSUE") {
      var issueText = String(bodyTrim || "").trim();
      if (issueText.length < 4) {
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=issue_text_short exp=ISSUE"); } catch (_) {}
        return false;
      }
      var issueActionable = !!String((openerFacts && openerFacts.issue) || "").trim();
      if (!issueActionable && (openerFacts && openerFacts.schedule && String(openerFacts.schedule.raw || "").trim())) {
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=issue_branch_schedule_only exp=ISSUE"); } catch (_) {}
        return false;
      }

      var nextFromIssue = ((typeof issueIsClear_ === "function") && issueIsClear_("", 0, issueText)) || issueActionable
        ? "SCHEDULE"
        : "DETAIL";

      dalWithLock_("FAST_CONT_ISSUE", function () {
        dalSetPendingIssueNoLock_(dir, dirRow, issueText);
        dalSetLastUpdatedNoLock_(dir, dirRow);
      });
      var nextAfterIssue = resolveNextContinuationStage_();
      if (nextAfterIssue === "FINALIZE_DRAFT") {
        var _fastReplyIssueFin = fastContinuationResponseFirst_(
          "TICKET_CREATE_ACK",
          { intentType: "FAST_ACK_CREATE_IN_PROGRESS", vars: {}, deliveryPolicy: "NO_HEADER" },
          "FAST_CONT_ISSUE_TO_FINALIZE"
        );
        if (fastPathFinalizeDraft_("FAST_CONT_ISSUE_FINALIZE", _fastReplyIssueFin)) {
          try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_HANDLED exp=ISSUE next=FINALIZE_DRAFT"); } catch (_) {}
          try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=ISSUE_TO_FINALIZE finalizeAttempted=1"); } catch (_) {}
          return true;
        }
      }
      var _fastReplyIssuePrompt = null;
      var _issueMeaning = fastStageToMeaningType_(nextAfterIssue);
      if (_issueMeaning) {
        _fastReplyIssuePrompt = fastContinuationResponseFirst_(
          _issueMeaning,
          fastBuildStagePromptText_(nextAfterIssue),
          "FAST_CONTINUATION_ISSUE_PROMPT"
        );
      }
      var _writeStartIssuePrompt = Date.now();
      if (emitPromptForStage_(nextAfterIssue, "FAST_CONT_ISSUE_PROMPT", _fastReplyIssuePrompt)) {
        fastReplySummaryLog_("FAST_CONT_ISSUE_PROMPT", _fastReplyIssuePrompt, _writeStartIssuePrompt);
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_HANDLED exp=ISSUE next=" + nextAfterIssue); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=ISSUE wroteIssue=1 next=[" + String(nextAfterIssue || "") + "]"); } catch (_) {}
        return true;
      }
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_FALLBACK exp=ISSUE next=" + nextAfterIssue); } catch (_) {}
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=issue_prompt_failed next=[" + String(nextAfterIssue || "") + "]"); } catch (_) {}
      return false;
    }

    if (expUp === "DETAIL") {
      var detailText = String(bodyTrim || "").trim();
      if (detailText.length < 2) {
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=detail_short exp=DETAIL"); } catch (_) {}
        return false;
      }
      if ((typeof isScheduleWindowLike_ === "function") && isScheduleWindowLike_(detailText)) {
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=detail_schedule_like exp=DETAIL"); } catch (_) {}
        return false;
      }

      dalWithLock_("FAST_CONT_DETAIL", function () {
        var priorIssue = (typeof dalGetPendingIssue_ === "function") ? String(dalGetPendingIssue_(dir, dirRow) || "").trim() : "";
        var mergedIssue = priorIssue;
        if (!mergedIssue) {
          mergedIssue = detailText;
        } else if (mergedIssue.toLowerCase().indexOf(detailText.toLowerCase()) === -1) {
          mergedIssue = mergedIssue + "; " + detailText;
        }
        dalSetPendingIssueNoLock_(dir, dirRow, mergedIssue);
        dalSetLastUpdatedNoLock_(dir, dirRow);
      });
      var nextAfterDetail = resolveNextContinuationStage_();
      if (nextAfterDetail === "FINALIZE_DRAFT") {
        var _fastReplyDetailFin = fastContinuationResponseFirst_(
          "TICKET_CREATE_ACK",
          { intentType: "FAST_ACK_CREATE_IN_PROGRESS", vars: {}, deliveryPolicy: "NO_HEADER" },
          "FAST_CONT_DETAIL_TO_FINALIZE"
        );
        if (fastPathFinalizeDraft_("FAST_CONT_DETAIL_FINALIZE", _fastReplyDetailFin)) {
          try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_HANDLED exp=DETAIL next=FINALIZE_DRAFT"); } catch (_) {}
          try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=DETAIL_TO_FINALIZE finalizeAttempted=1"); } catch (_) {}
          return true;
        }
      }
      var _fastReplyDetailPrompt = null;
      var _detailMeaning = fastStageToMeaningType_(nextAfterDetail);
      if (_detailMeaning) {
        _fastReplyDetailPrompt = fastContinuationResponseFirst_(
          _detailMeaning,
          fastBuildStagePromptText_(nextAfterDetail),
          "FAST_CONTINUATION_DETAIL_PROMPT"
        );
      }
      var _writeStartDetailPrompt = Date.now();
      if (emitPromptForStage_(nextAfterDetail, "FAST_CONT_DETAIL_PROMPT", _fastReplyDetailPrompt)) {
        fastReplySummaryLog_("FAST_CONT_DETAIL_PROMPT", _fastReplyDetailPrompt, _writeStartDetailPrompt);
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_HANDLED exp=DETAIL next=" + nextAfterDetail); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=DETAIL mergedDetail=1 next=[" + String(nextAfterDetail || "") + "]"); } catch (_) {}
        return true;
      }
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_FALLBACK exp=DETAIL next=" + nextAfterDetail); } catch (_) {}
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=detail_prompt_failed next=[" + String(nextAfterDetail || "") + "]"); } catch (_) {}
      return false;
    }

    if (expUp === "SCHEDULE_PRETICKET") {
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_PRETICKET_TRY"); } catch (_) {}
      var nextAfterPreSchedule = resolveNextContinuationStage_();
      if (nextAfterPreSchedule !== "FINALIZE_DRAFT") {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_PRETICKET_FALLBACK reason=next_not_finalize next=" + nextAfterPreSchedule); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=schedule_preticket_next_not_finalize next=[" + String(nextAfterPreSchedule || "") + "]"); } catch (_) {}
        return false;
      }
      var schedRawPre = String((openerFacts && openerFacts.schedule && openerFacts.schedule.raw) || bodyTrim || "").trim();
      if (!schedRawPre) {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_PRETICKET_FALLBACK reason=no_schedule_raw"); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=schedule_preticket_missing_schedule"); } catch (_) {}
        return false;
      }
      var prPre = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
      if (prPre >= 2) {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_PRETICKET_FALLBACK reason=pending_row_exists pr=" + prPre); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=schedule_preticket_pending_row_exists pr=[" + String(prPre) + "]"); } catch (_) {}
        return false;
      }

      var _fastReplyPreFinalize = fastContinuationResponseFirst_(
        "TICKET_CREATE_ACK",
        { intentType: "FAST_ACK_CREATE_IN_PROGRESS", vars: {}, deliveryPolicy: "NO_HEADER" },
        "FAST_CONTINUATION_SCHEDULE_PRETICKET_TO_FINALIZE"
      );
      var _writeStartPreFinalize = Date.now();
      try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_START tag=[FAST_CONT_SCHEDULE_PRETICKET_FINALIZE]"); } catch (_) {}

      var _fdPropPre = (typeof dalGetPendingProperty_ === "function") ? dalGetPendingProperty_(dir, dirRow) : {};
      var propCodePre = String(_fdPropPre.code || "").trim();
      var propNamePre = String(_fdPropPre.name || "").trim();
      var issuePre = (typeof dalGetPendingIssue_ === "function") ? String(dalGetPendingIssue_(dir, dirRow) || "").trim() : "";
      var unitSnapPre = String((typeof dalGetPendingUnit_ === "function" ? dalGetPendingUnit_(dir, dirRow) : "") || "").trim();
      if (!issuePre && openerFacts && openerFacts.issue) issuePre = String(openerFacts.issue || "").trim();
      if (!unitSnapPre && openerFacts && openerFacts.unit) unitSnapPre = String(openerFacts.unit || "").trim();
      if (!propCodePre && openerFacts && openerFacts.property && openerFacts.property.code) {
        propCodePre = String(openerFacts.property.code || "").trim();
        propNamePre = String(openerFacts.property.name || "").trim();
      }
      var hasIssuePre = Boolean(issuePre) || (typeof getIssueBuffer_ === "function" && getIssueBuffer_(dir, dirRow) && getIssueBuffer_(dir, dirRow).length >= 1);
      if (prPre <= 0 && typeof sessionGet_ === "function") {
        var sPre = sessionGet_(phone) || {};
        if (sPre.draftIssue) issuePre = String(sPre.draftIssue || "").trim();
        if (sPre.issueBuf && sPre.issueBuf.length >= 1) hasIssuePre = true;
        if (sPre.draftProperty && !propCodePre) propCodePre = String(sPre.draftProperty || "").trim();
        if (sPre.draftUnit && !unitSnapPre) unitSnapPre = String(sPre.draftUnit || "").trim();
        if (!propNamePre && propCodePre && typeof getPropertyByCode_ === "function") {
          var pPre = getPropertyByCode_(propCodePre);
          if (pPre && pPre.name) propNamePre = String(pPre.name || "").trim();
        }
      }
      if (!propCodePre || !unitSnapPre || !hasIssuePre) {
        try {
          logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_STATE_MERGE prop=[" + propCodePre + "] unit=[" + unitSnapPre + "] issue=[" + (issuePre ? "1" : "0") + "] sched=[" + (schedRawPre ? "1" : "0") + "] src=[dir_session_opener]");
        } catch (_) {}
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_PRETICKET_FALLBACK reason=missing_draft_fields propCode=[" + propCodePre + "] unit=[" + unitSnapPre + "] hasIssue=[" + (hasIssuePre ? "1" : "0") + "]"); } catch (_) {}
        try {
          if (typeof ctxUpsert_ === "function") {
            ctxUpsert_(phone, {
              pendingExpected: "SCHEDULE_PRETICKET",
              pendingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
              lastIntent: "MAINT"
            }, "FAST_CONTINUATION_FALLBACK_PRESERVED_STATE");
          }
          logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_FALLBACK_PRESERVED_STATE");
        } catch (_) {}
        return false;
      }
      try {
        logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_STATE_MERGE prop=[" + propCodePre + "] unit=[" + unitSnapPre + "] issue=[" + (issuePre ? "1" : "0") + "] sched=[" + (schedRawPre ? "1" : "0") + "] src=[dir_session_opener]");
      } catch (_) {}
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_PRETICKET_TO_FINALIZE_ENTER"); } catch (_) {}
      var sheetPre = getSheet_(SHEET_NAME);
      var baseVarsPre = { brandName: BRAND.name, teamName: BRAND.team };
      var spPre = PropertiesService.getScriptProperties();
      var pEvPre = (e && e.parameter) ? e.parameter : {};
      var sidPre = String(pEvPre.MessageSid || pEvPre.SmsMessageSid || (typeof safeParam_ === "function" ? safeParam_(e, "MessageSid") : "") || (typeof safeParam_ === "function" ? safeParam_(e, "SmsMessageSid") : "") || "").trim();
      var fromDedPre = String(pEvPre.From || (typeof safeParam_ === "function" ? safeParam_(e, "From") : "") || "").trim().toLowerCase();
      var chMetaPre = String(pEvPre._channel || (typeof safeParam_ === "function" ? safeParam_(e, "_channel") : "") || "").trim().toUpperCase();
      var sidSafePre = sidPre ? String(sidPre) : ("NOSID:" + (typeof _nosidDigest_ === "function" ? _nosidDigest_(fromDedPre, bodyTrim) : String((bodyTrim || "").length)));
      var chPre = (fromDedPre.indexOf("whatsapp:") === 0) ? "WA" : "SMS";
      if (chMetaPre === "TELEGRAM" || /^tg:/i.test(String(pEvPre.From || ""))) chPre = "TELEGRAM";
      var inboundKeyPre = "SID:" + chPre + ":" + sidSafePre;
      var finResultPre = finalizeDraftAndCreateTicket_(sheetPre, dir, dirRow, phone, phone, {
        inboundKey: inboundKeyPre,
        lang: lang,
        baseVars: baseVarsPre,
        locationText: bodyTrim,
        locationType: (openerFacts && openerFacts.location && openerFacts.location.locationType) ? String(openerFacts.location.locationType || "") : "",
        turnIssueMeta: (openerFacts && openerFacts.issueMeta) ? openerFacts.issueMeta : null,
        semanticTextEnglish: (openerFacts && openerFacts.semanticTextEnglish != null) ? String(openerFacts.semanticTextEnglish || "").trim() : "",
        firstMediaUrl: "",
        mediaType: "",
        mediaCategoryHint: "",
        mediaSubcategoryHint: "",
        mediaUnitHint: "",
        OPENAI_API_KEY: String(spPre.getProperty("OPENAI_API_KEY") || "")
      });
      try {
        logDevSms_(phone, bodyTrim, "FINALIZE_RESULT ok=[" + (finResultPre && finResultPre.ok ? "1" : "0") + "] reason=[" + String((finResultPre && finResultPre.reason) || "") + "] multi=[" + (finResultPre && finResultPre.multiIssuePending ? "1" : "0") + "] ticketId=[" + String((finResultPre && finResultPre.ticketId) || "") + "] source=ROUTER_SCHEDULE_PRETICKET_FAST");
      } catch (_) {}
      if (finResultPre && finResultPre.ok && finResultPre.loggedRow >= 2) {
        try { logDevSms_(phone, bodyTrim, "FINALIZE_DRAFT_CREATED pendingRow=[" + finResultPre.loggedRow + "] source=ROUTER_SCHEDULE_PRETICKET_FAST"); } catch (_) {}
      }
      applyFinalizeDraftResultOutcomesForRouter_(e, phone, bodyTrim, sheetPre, dir, dirRow, lang, baseVarsPre, finResultPre, issuePre, unitSnapPre, propNamePre, (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS", _fastReplyPreFinalize);
      if (finResultPre && finResultPre.ok) {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_PRETICKET_TO_FINALIZE_OK ticketId=[" + String((finResultPre && finResultPre.ticketId) || "") + "]"); } catch (_) {}
      }
      fastReplySummaryLog_("FAST_CONT_SCHEDULE_PRETICKET_FINALIZE", _fastReplyPreFinalize, _writeStartPreFinalize);
      try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_DONE tag=[FAST_CONT_SCHEDULE_PRETICKET_FINALIZE] ok=[" + (finResultPre && finResultPre.ok ? "1" : "0") + "]"); } catch (_) {}
      try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=SCHEDULE_PRETICKET_TO_FINALIZE finalizeAttempted=1"); } catch (_) {}
      return true;
    }

    if (expUp === "SCHEDULE") {
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_TRY"); } catch (_) {}
      var prSched = (typeof dalGetPendingRow_ === "function") ? dalGetPendingRow_(dir, dirRow) : 0;
      if (prSched < 2) {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_FALLBACK reason=pending_row_lt_2 pr=" + prSched); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_SKIP reason=schedule_pending_row_lt_2 pr=[" + String(prSched) + "]"); } catch (_) {}
        return false;
      }
      var dirStSched = String((typeof dalGetPendingStage_ === "function") ? dalGetPendingStage_(dir, dirRow) : "").trim().toUpperCase();
      if (dirStSched === "SCHEDULE_DRAFT_MULTI" || dirStSched === "SCHEDULE_DRAFT_SINGLE") {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_FALLBACK reason=draft_schedule_stage st=" + dirStSched); } catch (_) {}
        return false;
      }
      if (typeof looksLikeManagerCommand_ === "function" && looksLikeManagerCommand_(bodyTrim)) {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_FALLBACK reason=manager_command"); } catch (_) {}
        return false;
      }
      if (typeof isScheduleLike_ === "function" && !isScheduleLike_(bodyTrim)) {
        try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_FALLBACK reason=not_schedule_like"); } catch (_) {}
        return false;
      }
      try {
        if (dirRow > 0 && !dirStSched && String((ctx && ctx.pendingExpected) || "").trim().toUpperCase() === "SCHEDULE") {
          dalSetPendingStage_(dir, dirRow, "SCHEDULE", phone, "FAST_CONT_DIR_RECOVER_STAGE");
        }
      } catch (_) {}
      var sheetFs = getSheet_(SHEET_NAME);
      var baseVarsFs = { brandName: BRAND.name, teamName: BRAND.team };
      var dayW = "";
      try { dayW = String(scheduleDayWord_(new Date()) || "").trim(); } catch (_) {}
      var sigs = (typeof classifyTenantSignals_ === "function") ? classifyTenantSignals_(bodyTrim, ctx) : {};
      var nowFs = new Date();
      // RESPONSE-FIRST MODEL: send immediate confirmation intent before policy/lifecycle/write-heavy schedule handling.
      var _fastReplySchedule = fastContinuationResponseFirst_(
        "SCHEDULE_RECORDED_ACK",
        { intentType: "FAST_ACK_SCHEDULE_REVIEW", vars: {}, deliveryPolicy: "NO_HEADER" },
        "FAST_CONTINUATION_SCHEDULE"
      );
      var _writeStartSchedule = Date.now();
      try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_START tag=[FAST_CONT_SCHEDULE]"); } catch (_) {}
      var hs = handleScheduleSingleTicket_(e, sheetFs, dir, dirRow, phone, prSched, bodyTrim, lang, baseVarsFs, dayW, nowFs, sigs, (typeof getResolvedInboundChannel_ === "function" && e) ? getResolvedInboundChannel_(e) : "", _fastReplySchedule);
      if (hs && hs.handled) {
        try {
          // Do NOT log resolveNextContinuationStage_() here: handleScheduleSingleTicket_ clears ctx
          // schedule expectation, may advance queue, and draft recompute then reflects a *new* draft
          // gap (often ISSUE) — not "next step after confirm". Log durable ctx + session expected only.
          var peAfter = "";
          var seAfter = "";
          try {
            var cxA = (typeof ctxGet_ === "function") ? ctxGet_(phone) : null;
            peAfter = String(cxA && cxA.pendingExpected ? cxA.pendingExpected : "").trim();
          } catch (_) {}
          try {
            var snA = (typeof sessionGet_ === "function") ? sessionGet_(phone) : null;
            seAfter = String(snA && snA.expected ? snA.expected : "").trim();
          } catch (_) {}
          logDevSms_(
            phone,
            bodyTrim,
            "FAST_CONTINUATION_SCHEDULE_OK ctxPendingExpectedAfter=" + (peAfter || "(empty)") +
              " sessionExpectedAfter=" + (seAfter || "(empty)") +
              " fallbackSms=" + (hs.fallbackSms ? "1" : "0") +
              " note=post_confirm_recompute_not_next_stage"
          );
        } catch (_) {}
        fastReplySummaryLog_("FAST_CONT_SCHEDULE", _fastReplySchedule, _writeStartSchedule);
        try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_DONE tag=[FAST_CONT_SCHEDULE] handled=1 fallbackSms=" + (hs.fallbackSms ? "1" : "0")); } catch (_) {}
        try { logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_OK branch=SCHEDULE handleScheduleSingleTicket=1"); } catch (_) {}
        return true;
      }
      try { logDevSms_(phone, bodyTrim, "WRITE_AFTER_REPLY_DONE tag=[FAST_CONT_SCHEDULE] handled=0"); } catch (_) {}
      try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_SCHEDULE_FALLBACK reason=window_parse_or_core_path"); } catch (_) {}
      return false;
    }

    try {
      logDevSms_(phone, _fcBody, "ROUTER_FAST_CONT_FALLTHROUGH exp=[" + String(expUp || "") + "] return_core=1 note=no_matching_branch_or_SCHEDULE_PRETICKET");
    } catch (_) {}
  } catch (err) {
    try { logDevSms_(phone, bodyTrim, "ROUTER_FAST_CONT_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
    try { logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_ERR " + String(err && err.message ? err.message : err)); } catch (_) {}
    try {
      if (typeof ctxUpsert_ === "function") {
        var _ctxNowErr = (typeof ctxGet_ === "function") ? (ctxGet_(phone) || {}) : {};
        ctxUpsert_(phone, {
          pendingExpected: String(_ctxNowErr.pendingExpected || "UNIT"),
          pendingExpiresAt: _ctxNowErr.pendingExpiresAt || new Date(Date.now() + 10 * 60 * 1000),
          lastIntent: "MAINT"
        }, "FAST_CONTINUATION_CRASH_FIX_PATH");
      }
      logDevSms_(phone, bodyTrim, "FAST_CONTINUATION_CRASH_FIX_PATH");
    } catch (_) {}
  }
  return false;
}

if (leasingLaneEnabled && (leasingIntent || isLeasingStage)) {
  try { logDevSms_(phone, bodyTrim, "ROUTER_BRANCH LEASING"); } catch (_) {}

  // Null-safe ctx write
  if (!ctx) ctx = {};
  ctx.leasingPendingExpected = "";

  // Lookup active thread (your existing code, unchanged)
  try {
    const contactKey = phoneKey_(phone);
    const contactSheet = getSheet_(LEASING_SHEETS.CONTACTS);
    const contactRow = findRowByValue_(contactSheet, "PhoneE164", contactKey);

    if (contactRow) {
      const contactMap = getHeaderMap_(contactSheet);
      const contactId = String(contactSheet.getRange(contactRow, contactMap["ContactID"]).getValue());

      const threadSheet = getSheet_(LEASING_SHEETS.THREADS);
      const threadLastRow = threadSheet.getLastRow();

      if (threadLastRow >= 2) {
        const threadMap = getHeaderMap_(threadSheet);
        const threadData = threadSheet.getRange(2, 1, threadLastRow - 1, threadSheet.getLastColumn()).getValues();

        for (let i = 0; i < threadData.length; i++) {
          const rowContact = String(threadData[i][threadMap["ContactID"] - 1] || "");
          const rowStatus = String(threadData[i][threadMap["Status"] - 1] || "");

          if (rowContact === contactId && rowStatus === "ACTIVE") {
            ctx.leasingPendingExpected = String(threadData[i][threadMap["PendingExpected"] - 1] || "");
            break;
          }
        }
      }
    }
  } catch (_) {}

  var leasingStageNow = String(ctx.leasingPendingExpected || "").trim().toUpperCase();
  if ((!leasingStageNow || leasingStageNow === "NONE") && (typeof isMaintenanceVeto_ === "function") && isMaintenanceVeto_(bodyTrim)) {
    try { logDevSms_(phone, bodyTrim.slice(0, 60), "LEASING_FALLBACK_TO_CORE maint_veto"); } catch (_) {}
    return routeToCoreSafe_(e, { channel: (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS" });
  }

  const result = handleLeasingLane_(inbound, ctx, leasingIntent);

  if (result && result.threadId && result.nextStage !== undefined) {
    try {
      leasingDal_().threads.updateStage(result.threadId, {
        pendingExpected: result.nextStage || "",
        pendingJson: result.pendingData || {}
      });
    } catch (_) {}
  }

  sendLeasingKey_(phone, result.replyKey, result.vars || {}, "LEASING_REPLY");
  return;
}


  // 6) ACK-ONLY (no suppression — let CORE decide)
  if (looksLikeAckOnly_(bodyLower) && !isGlobalResetCommand_(bodyLower)) {
    try { logDevSms_(phone, bodyTrim, "ROUTER_ACK_ONLY_PASS_TO_CORE"); } catch (_) {}
  }

  // 7) DOMAIN INTENT GATE (weak/unspecific tenant text)
  // Prevent "hi need help" from entering maintenance core and being committed as ISSUE.
  try {
    var modeUp = String((e && e.parameter && e.parameter._mode) || "TENANT").toUpperCase();
    if (modeUp === "TENANT") {
      var t = String(bodyTrim || "").trim();
      var lower0 = String(bodyLower || "").toLowerCase();

      // Only when no active work + no pendingExpected (router owns the first question)
      var exp0 = String((ctx && ctx.pendingExpected) || "").trim();
      var hasActive = !!String((ctx && ctx.activeWorkItemId) || "").trim();
      var hasPending = !!String((ctx && ctx.pendingWorkItemId) || "").trim();

      if (!exp0 && !hasActive && !hasPending) {
        var weakIntent = (typeof isWeakIssue_ === "function") && isWeakIssue_(t);
        var specific = (typeof looksSpecificIssue_ === "function") && looksSpecificIssue_(t);

        var hasStrongLeasing0 = (typeof isLeasingIntentStrong_ === "function") && isLeasingIntentStrong_(t);
        var maintVeto0 = (typeof isMaintenanceVeto_ === "function") && isMaintenanceVeto_(t);
        // If clearly leasing or amenity, let existing branches handle it (no gate)
        var leasingHit = (typeof detectLeasingIntent_ === "function") && !!detectLeasingIntent_(lower0, ctx) && hasStrongLeasing0 && !maintVeto0;
        var amenityHit =
          ((typeof isAmenityCommand_ === "function") && isAmenityCommand_(lower0)) ||
          ((typeof looksLikeAmenityByKeywords_ === "function") && looksLikeAmenityByKeywords_(lower0));

        // ✅ If media is present, never run INTENT_PICK gating.
        // Photo-only or photo+typo should route to core so it can attach to the active ticket / prompt properly.
        try {
          var _nm = (typeof parseCanonicalMediaArrayFromEvent_ === "function") ? parseCanonicalMediaArrayFromEvent_(e).length : (parseInt(String(p && p.NumMedia ? p.NumMedia : "0"), 10) || 0);
          if (_nm > 0) {
            try { logDevSms_(phone, t, "ROUTER_INTENT_GATE_BYPASS reason=media numMedia=" + _nm); } catch (_) {}
            // fall through to normal core routing (do NOT show menu)
            // Important: do not return here; let the router continue to DEFAULT_TO_CORE branch.
          } else if ((weakIntent || !specific) && !leasingHit && !amenityHit) {
            if (typeof properaCanonicalIntakeIsActive_ === "function" && properaCanonicalIntakeIsActive_(phone)) {
              try { logDevSms_(phone, t, "CONT_STATE_BLOCKED reason=[canonical_active_prevent_intent_pick]"); } catch (_) {}
              return routeToCoreSafe_(e);
            }
            var expiresAtIso2 = new Date(Date.now() + 10 * 60 * 1000).toISOString();
            try { ctxUpsert_(phone, { pendingExpected: "INTENT_PICK", pendingExpiresAt: expiresAtIso2 }, "intent_gate_set"); } catch (_) {}
            try { if (typeof sessionUpsert_ === "function") sessionUpsert_(phone, { expected: "INTENT_PICK", stage: "INTENT_PICK", expiresAtIso: expiresAtIso2 }, "intent_gate_set"); } catch (_) {}
            try { logDevSms_(phone, t, "ROUTER_INTENT_GATE weak=[" + (weakIntent ? 1 : 0) + "] specific=[" + (specific ? 1 : 0) + "]"); } catch (_) {}

            var lang0 = String((ctx && ctx.lang) || "en").toLowerCase();
            var menuMsg2 = renderTenantKey_("INTENT_PICK", lang0, {});
            return sendRouterSms_(phone, menuMsg2, "INTENT_PICK", _routerInboundCh);
          }
        } catch (_) {
          // If anything goes wrong in media detection, keep existing behavior (safe default).
          if ((weakIntent || !specific) && !leasingHit && !amenityHit) {
            if (typeof properaCanonicalIntakeIsActive_ === "function" && properaCanonicalIntakeIsActive_(phone)) {
              try { logDevSms_(phone, t, "CONT_STATE_BLOCKED reason=[canonical_active_prevent_intent_pick_fallback]"); } catch (_) {}
              return routeToCoreSafe_(e);
            }
            var expiresAtIso2b = new Date(Date.now() + 10 * 60 * 1000).toISOString();
            try { ctxUpsert_(phone, { pendingExpected: "INTENT_PICK", pendingExpiresAt: expiresAtIso2b }, "intent_gate_set"); } catch (_) {}
            try { if (typeof sessionUpsert_ === "function") sessionUpsert_(phone, { expected: "INTENT_PICK", stage: "INTENT_PICK", expiresAtIso: expiresAtIso2b }, "intent_gate_set"); } catch (_) {}
            try { logDevSms_(phone, t, "ROUTER_INTENT_GATE weak=[" + (weakIntent ? 1 : 0) + "] specific=[" + (specific ? 1 : 0) + "]"); } catch (_) {}
            var lang0b = String((ctx && ctx.lang) || "en").toLowerCase();
            var menuMsg2b = renderTenantKey_("INTENT_PICK", lang0b, {});
            return sendRouterSms_(phone, menuMsg2b, "INTENT_PICK", _routerInboundCh);
          }
        }
      }
    }
  } catch (_) {}

  // 8) DEFAULT
  // Response-first packaged ask for new maintenance intake:
  // if there is no pending stage and we detect issue-like text without property/unit,
  // send one immediate ask while core continues canonical write/recompute.
  try {
    var _expNow = String((ctx && ctx.pendingExpected) || "").trim().toUpperCase();
    if (!_expNow) {
      var _openerFast = null;
      try {
        if (typeof properaBuildIntakePackage_ === "function") {
          _openerFast = properaBuildIntakePackage_({
            bodyTrim: bodyTrim,
            mergedBodyTrim: bodyTrim,
            phone: phone,
            lang: String((ctx && ctx.lang) || "en"),
            cigContext: (typeof properaBuildCIGContext_ === "function")
              ? (properaBuildCIGContext_(phone, ctx || null, (typeof dir !== "undefined" ? dir : null), (typeof dirRow !== "undefined" ? dirRow : 0)) || null)
              : null
          });
        }
      } catch (_) {}
      var _looksIssue = !!String((_openerFast && _openerFast.issue) || "").trim();
      if (_looksIssue) {
        var _pNow = (_openerFast && _openerFast.property) ? _openerFast.property : { code: "", name: "" };
        var _uNow = String((_openerFast && _openerFast.unit) || "").trim();
        if (!_uNow && !String((_pNow && _pNow.code) || "").trim()) {
          var _issueHintFast = String((_openerFast && (_openerFast.issueHint || _openerFast.issue)) || "").trim();
          // If title came back as "is clogged"/"is leaking", recover fixture noun from English-normalized parse text.
          if (/^is\s+\w+/i.test(_issueHintFast)) {
            var _fixSrc = String((_openerFast && _openerFast.issue) || bodyTrim || "").toLowerCase();
            var _fixM = _fixSrc.match(/\b(sink|toilet|shower|tub|faucet|drain|pipe|stove|oven|washer|dryer|fridge|dishwasher|microwave|door|lock|window|outlet|breaker|thermostat|heater|ac|a\/c|intercom)\b/);
            if (_fixM && _fixM[1]) _issueHintFast = String(_fixM[1]) + " " + _issueHintFast;
          }
          var _fastLang = String((_openerFast && _openerFast.lang) || (ctx && ctx.lang) || "en").toLowerCase();
          if (_fastLang.indexOf("-") > 0) _fastLang = _fastLang.split("-")[0];
          var _fastIntent = {
            intentType: "ASK_PROPERTY_AND_UNIT_PACKAGED",
            recipientType: "TENANT",
            recipientRef: phone,
            channel: scopeChannel || _routerInboundCh,
            lang: _fastLang,
            deliveryPolicy: "NO_HEADER",
            vars: Object.assign({ issueHint: _issueHintFast }, (typeof properaPackagedPropertyAskSupplement_ === "function")
              ? properaPackagedPropertyAskSupplement_(_openerFast)
              : {}),
            meta: { source: "FAST_DEFAULT_PROPERTY_UNIT_PACKAGING", stage: "PROPERTY", meaningType: "ASK_PROPERTY_AND_UNIT" }
          };
          try {
            var _dirFast = getSheet_(DIRECTORY_SHEET_NAME);
            var _dirRowFast = ensureDirectoryRowForPhone_(_dirFast, phone);
            var _adFd = null;
            var _tfFd = _openerFast || {};
            if (typeof properaIntakeAttachClassify_ === "function" && typeof properaApplyAttachDecisionToTurnFacts_ === "function") {
              _adFd = properaIntakeAttachClassify_({
                phone: phone,
                bodyTrim: String(bodyTrim || ""),
                turnFacts: _tfFd,
                collectStage: "PROPERTY",
                dir: _dirFast,
                dirRow: _dirRowFast
              });
              _tfFd = properaApplyAttachDecisionToTurnFacts_(_tfFd, _adFd);
            }
            var _cmrFd = properaCanonicalIntakeMergeCommit_({
              phone: phone,
              dir: _dirFast,
              dirRow: _dirRowFast,
              turnFacts: _tfFd,
              writerTag: "FAST_DEFAULT_CANONICAL_COMMIT",
              mirrorWrites: true,
              collectStage: "PROPERTY",
              attachDecision: _adFd,
              inboundBodyTrim: String(bodyTrim || "")
            });
            if (_cmrFd && !_cmrFd.ok && _cmrFd.reason === "clarify_blocked") {
              var __reqClarifyResolved = (typeof globalThis !== "undefined" && String(globalThis.__attachClarifyResolvedThisTurn || "") === "1");
              if (__reqClarifyResolved) {
                try { logDevSms_(phone, bodyTrim, "ATTACH_CLARIFY_REENTRY_SUPPRESSED reason=[fast_default_prompt_block_guard]"); } catch (_) {}
                return true;
              }
              try { logDevSms_(phone, bodyTrim, "ATTACH_CLARIFY_REQUIRED reason=[clarify_blocked_from_fast_default]"); } catch (_) {}
              try { logDevSms_(phone, bodyTrim, "ATTACH_CLARIFY_PROMPT_SENT reason=[clarify_blocked]"); } catch (_) {}
              try {
                if (typeof ctxUpsert_ === "function") {
                  var _clarMsFd = Date.now() + 3 * 60 * 1000;
                  ctxUpsert_(phone, { pendingExpected: "ATTACH_CLARIFY", pendingExpiresAt: new Date(_clarMsFd).toISOString(), lastIntent: "ATTACH_CLARIFY" }, "ATTACH_CLARIFY_PROMPT_SENT");
                }
              } catch (_) {}
              var _canonShFd = ensureCanonicalIntakeSheet_();
              var _canonRecFd = canonicalIntakeLoadNoLock_(_canonShFd, phone);
              var _expectedUnitFd = (_canonRecFd && _canonRecFd.unit) ? String(_canonRecFd.unit || "").trim() : "";
              var _txtFd =
                "Is this for the same maintenance request or a new one?\n" +
                "1) Same request\n" +
                "2) New request";
              if (_expectedUnitFd) _txtFd += "\nIf you choose 2, what is the unit number? (Expected: " + _expectedUnitFd + ")";
              var _langFd = String((ctx && ctx.lang) || "en").toLowerCase();
              if (_langFd.indexOf("-") > 0) _langFd = _langFd.split("-")[0];
              var _intentFd = {
                intentType: "CORE_TEXT_REPLY",
                recipientType: "TENANT",
                recipientRef: phone,
                lang: _langFd,
                channel: (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : scopeChannel,
                deliveryPolicy: "DIRECT_SEND",
                preRenderedBody: _txtFd,
                vars: {},
                meta: { source: "ATTACH_CLARIFY", stage: "ATTACH_CLARIFY", flow: "FAST_DEFAULT" }
              };
              try { dispatchTenantIntent_(e, phone, bodyTrim, _intentFd); } catch (_) {}
              return true;
            }
          } catch (_) {}
          var _rFast = (typeof dispatchTenantIntent_ === "function") ? dispatchTenantIntent_(e, phone, bodyTrim, _fastIntent) : { ok: false };
          if (_rFast.ok) {
            try {
              if (!e.parameter) e.parameter = {};
              e.parameter._fastReplySent = "1";
              e.parameter._fastReplyType = "ASK_PROPERTY_AND_UNIT";
              e.parameter._fastReplySource = "FAST_DEFAULT_PROPERTY_UNIT_PACKAGING";
            } catch (_) {}
            try { logDevSms_(phone, bodyTrim, "FAST_REPLY_DEDUPE_MARK type=ASK_PROPERTY_AND_UNIT source=FAST_DEFAULT_PROPERTY_UNIT_PACKAGING"); } catch (_) {}
          }
        }
      }
    }
  } catch (_) {}
  try { logDevSms_(phone, bodyTrim, "ROUTER_BRANCH DEFAULT_TO_CORE"); } catch (_) {}
  return routeToCoreSafe_(e);
}


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// Router globals + tenant commands + text helpers
// ─────────────────────────────────────────────────────────────────





  function isGlobalResetCommand_(sLower) {
    const s = String(sLower || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")   // remove punctuation/emojis safely
      .replace(/\s+/g, " ")        // collapse spaces
      .trim();

    return (
      s === "reset" ||
      s === "restart" ||
      s === "start over" ||
      s === "start again" ||
      s === "clear" ||
      s === "clear chat"
    );
  }





  function handleGlobalReset_(e) {
    const p = (e && e.parameter) ? e.parameter : {};
    const from = String(p.From || "").trim();
    if (!from) return;

    // 1) Clear AMENITY state
    try { endAmenityFlow_(from); } catch (_) {}

    // 2) Clear MAINTENANCE pending state (locked)
    try {
      const dir = getSheet_(DIRECTORY_SHEET_NAME);
      const phoneNorm = normalizePhone_(from);
      const dirRow = findDirectoryRowByPhone_(dir, phoneNorm);
      if (dirRow > 0) {
        dalWithLock_("RESET_CLEAR_DIR", function () {
          dalSetPendingStageNoLock_(dir, dirRow, "");
          dalSetLastUpdatedNoLock_(dir, dirRow);
          try { logDevSms_(from || "", "", "DAL_WRITE RESET_CLEAR_DIR row=" + dirRow); } catch (_) {}
        });
      }
    } catch (err) {
      try { logDevSms_(from, "", "RESET_CLEAR_DIR_ERR " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }

    // 3) Send confirmation (router-safe, template-key, GSM-7)
    try {
      const out = tenantMsgSafe_(
        "TENANT_RESET_CONFIRM",
        "en",
        { brandName: BRAND.name, teamName: BRAND.team },
        "ERR_GENERIC_TRY_AGAIN"
      );
      sendRouterSms_(from, out, "ROUTER_GLOBAL_RESET", (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS");
    } catch (err) {
      try { logDevSms_(from, "", "RESET_SEND_ERR " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }




  function looksLikeAckOnly_(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;

    const s = raw.toLowerCase().trim();

    // Fast emoji-only acknowledgements
    if (/^[\s👍👌🙏✅🙂😊😀😅😂❤️💯🙌]+$/u.test(raw)) return true;

    // Normalize: keep letters/numbers/spaces only
    const t = s
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!t) return false;

    // -----------------------------
    // HARD LIMITS (prevents blocking real issues)
    // -----------------------------
    const words = t.split(" ").filter(Boolean);
    const charLen = t.length;

    // Only allow short acknowledgements
    if (words.length > 5) return false;
    if (charLen > 40) return false;

    // If they included ANY maintenance-ish keyword, do NOT treat as ack-only
    // (This is the safety net.)
    const ISSUE_HINTS = [
      "leak","leaking","water","flood","flooding","drip","dripping",
      "sink","toilet","tub","shower","clog","clogged","backed up",
      "broken","broke","not working","doesnt work","won't","wont",
      "no heat","heat","heater","hot water","ac","a/c","air",
      "smoke","fire","alarm","lock","door","key","mold","gas",
      "noise","sparks","electric","power","outlet","light"
    ];
    for (const k of ISSUE_HINTS) {
      if (t.includes(k)) return false;
    }

    // -----------------------------
    // ACK PATTERNS (variants + typos)
    // -----------------------------

    // Common short forms (exact words)
    const EXACT = new Set([
      "ok","okay","k","kk","kk.","ok.","okay.",
      "got it","gotcha","sounds good","all set",
      "cool","great","awesome","perfect","nice",
      "appreciate it","much appreciated","good","good thanks"
    ]);
    if (EXACT.has(t)) return true;

    // Thanks variations (regex covers most typos)
    // e.g. thanks / thx / tnx / thanx / thank u / thankyou / thks / tks / thnks
    if (
      /\b(thx|tnx|tks|thks|thanx|thnx|thnks)\b/.test(t) ||
      /\bthank(s|you)?\b/.test(t) ||
      /\bthank\s*u\b/.test(t) ||
      /\bty\b/.test(t)
    ) {
      // Still require it to be short and not contain other “content”
      if (words.length <= 4) return true;
    }

    // Quick “received/ok” confirmations
    if (/\b(ok|okay|got it|received|noted|understood)\b/.test(t) && words.length <= 4) return true;

    return false;
  }






  function isLeasingIntentStrong_(text) {
    if (!text || typeof text !== "string") return false;
    var lower = String(text).trim().toLowerCase();
    if (/^unit\s*\d*$/.test(lower)) return false;
    var strong = [
      "rent", "renting", "lease", "leasing", "availability", "available", "tour", "showing",
      "schedule a tour", "apply", "application", "move in", "move-in", "pricing", "price",
      "deposit", "requirements", "bedroom", "studio", "1br", "2br", "3br", "pet policy",
      "income", "credit"
    ];
    for (var i = 0; i < strong.length; i++) {
      if (lower.indexOf(strong[i]) !== -1) return true;
    }
    return false;
  }




  function isMaintenanceVeto_(text) {
    if (!text || typeof text !== "string") return false;
    var lower = String(text).trim().toLowerCase();
    if (lower.indexOf("maintenance") !== -1 || lower.indexOf("repair") !== -1) return true;
    var signals = [
      "toilet", "sink", "leak", "water", "backed up", "clogged", "drain", "pipe", "faucet", "shower",
      "heater", "heat", " ac ", "a/c", "hvac", "thermostat", "outlet", "breaker", "electric", "lights",
      "door lock", "lock", "window", "fridge", "refrigerator", "freezer", "dishwasher", "washer", "dryer", "mold", "smell", "smoke",
      "pest", "roach", "mice", "flooded", "not working", "broken", "stopped working", "fix",
      "broke", "doesn't work", "isn't working", "leaking", "no hot water", "no heat", "no ac",
      "not cooling", "cooling properly", "not cooling properly", "stopped cooling",
      "won't start", "won't turn on", "won't flush", "overflow", "smells like gas"
    ];
    for (var j = 0; j < signals.length; j++) {
      if (lower.indexOf(signals[j]) !== -1) return true;
    }
    return false;
  }




  function looksLikeGreetingOnly_(s) {
    const t = String(s || "").toLowerCase().trim();
    if (!t) return false;
    // keep tight: only block pure greetings
    return /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|hola|bonjour|hii+|heyy+)[!.]*$/.test(t);
  }




  function looksLikeManagerCommand_(sLower) {
    // Block anything that could be a manager command / new ticket
    return (
      /^new\s*ticket\b/i.test(sLower) ||
      /^list\s+open\b/i.test(sLower) ||
      /^list\s+waiting\b/i.test(sLower) ||
      /^status\b/i.test(sLower) ||
      /^setstatus\b/i.test(sLower) ||
      /^pick\s+\d+\b/i.test(sLower) ||
      /^phone\s+\+?\d/i.test(sLower)
    );
  }





  function looksLikeWindowReply_(text, stageDay) {
    const s = String(text || "").trim();
    if (!s) return false;

    // Never treat manager commands as schedule replies
    if (looksLikeManagerCommand_(s.toLowerCase())) return false;

    // Long message that clearly describes a problem (e.g. gym AC) — do not treat as schedule even if it contains "morning"
    if (s.length > 75 && (typeof looksActionableIssue_ === "function") && looksActionableIssue_(s)) return false;
    if (s.length > 70 && /\b(gym|lobby|working out|noticed the|check it out|isn'?t working|super hot in there)\b/i.test(s)) return false;

    return !!parsePreferredWindow_(s, stageDay);
  }





  function isPureChitchat_(raw) {
    const s = String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s) return true; // emojis / punctuation only

    // Very short greetings
    if (s.length <= 3) return true; // hi, yo, ok, lol

    // Common greeting / courtesy patterns
    const patterns = [
      /^hi$/,
      /^hi there$/,
      /^hello$/,
      /^hey$/,
      /^hey there$/,
      /^yo$/,
      /^sup$/,
      /^wassup$/,
      /^what'?s up$/,
      /^how are you$/,
      /^how r u$/,
      /^how are u$/,
      /^how are you doing$/,
      /^how'?s it going$/,
      /^good (morning|afternoon|evening)$/,
      /^thanks$/,
      /^thank you$/,
      /^thanks a lot$/,
      /^ok$/,
      /^okay$/,
      /^k$/,
      /^lol$/,
      /^haha$/,
      /^test$/,
      /^just checking$/,
      /^checking$/,
      /^ping$/,
      /^anyone there$/
    ];

    if (patterns.some(rx => rx.test(s))) return true;

    // If message is short AND contains no service-related signal words
    const serviceSignals = /(leak|water|toilet|heat|ac|hvac|broken|not working|repair|maintenance|unit|apt|property|reserve|reservation|book)/;
    if (s.split(" ").length <= 4 && !serviceSignals.test(s)) {
      return true;
    }

    return false;
  }




  function isBlockedAsAddress_(text, numCandidate) {
    const cand = String(numCandidate || "").trim();
    if (!cand) return false;

    // ✅ Guard missing config / wrong type (prevents ReferenceError)
    const list =
      (typeof PROPERTY_ADDRESSES !== "undefined" && Array.isArray(PROPERTY_ADDRESSES))
        ? PROPERTY_ADDRESSES
        : [];

    // ✅ Guard missing helper (prevents next ReferenceError)
    if (typeof isAddressInContext_ !== "function") return false;

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (String(a && a.num || "") === cand && isAddressInContext_(text, a)) {
        return true; // ✅ block only if written like an address here
      }
    }
    return false;
  }




  function clearAwaiting_(digits) {
    try { CacheService.getScriptCache().remove("AWAIT_" + String(digits || "")); } catch (_) {}
  }




  function getAwaiting_(digits) {
    try {
      const raw = CacheService.getScriptCache().get("AWAIT_" + String(digits || ""));
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }







  function setAwaiting_(digits, val, payloadObj, ttlSec) {
    try {
      const obj = { v: String(val || ""), p: payloadObj || {}, t: Date.now() };
      CacheService.getScriptCache().put("AWAIT_" + String(digits || ""), JSON.stringify(obj), ttlSec || 900);
    } catch (_) {}
  }




  function extractPhoneFromText_(text) {
    const s = String(text || "");
    const m = s.match(/(\+1\d{10}|\b1\d{10}\b|\b\d{10}\b)/);
    if (!m) return "";
    return normalizePhone_(m[1]);
  }



  function extractStaffTenantNameHintFromText_(text) {
    var raw = String(text || "").trim();
    if (!raw) return "";

    // Keep the tail segment where staff usually append the tenant name: "... issue text. Ana"
    var parts = raw.split(/[.;,\n]/);
    var tail = String(parts.length ? parts[parts.length - 1] : raw).trim();
    if (!tail) tail = raw;

    // Normalize wrappers/prefixes.
    tail = tail.replace(/^\s*(tenant|name|for|resident)\s*[:\-]?\s*/i, "").trim();
    tail = tail.replace(/^\s*(tenant|resident)\s+is\s+/i, "").trim();
    tail = tail.replace(/[()"'`]/g, "").trim();
    if (!tail) return "";

    // Accept only 1-2 words made of letters/apostrophes/hyphens; reject noisy/issue-like fragments.
    if (tail.length < 2 || tail.length > 40) return "";
    if (/\d/.test(tail)) return "";
    if (!/^[A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*)?$/.test(tail)) return "";
    if (/\b(leak|leaking|broken|not working|flicker|flickering|clog|smell|noise|light|sink|toilet|heater|ac|heat|kitchen|bathroom)\b/i.test(tail)) return "";

    return tail;
  }





  function detectCategoryOverride_(text) {
    const t = String(text || "").toLowerCase();

    // ELECTRICAL
    if (/(outlet|outlets|receptacle|plug|no power|lost power|power is out|breaker|tripped|panel|gfi|gfci|reset button|sparking|spark|burning smell|light switch|switch not working|flicker|flickering|light(s)? not working)/.test(t)) {
      return "Electrical";
    }

    // PLUMBING
    if (/(leak|leaking|drip|dripping|clog|clogged|toilet|sink|faucet|shower|tub|water backup|backing up|drain|sewer)/.test(t)) {
      return "Plumbing";
    }

    // HVAC
    if (/(no heat|heat not working|heater|boiler|radiator|\bac\b|a\/c|air conditioner|not cooling|thermostat)/.test(t)) {
      return "HVAC";
    }

    // APPLIANCE
    if (/(washer|dryer|dishwasher|fridge|refrigerator|stove|oven|microwave|garbage disposal|disposal)/.test(t)) {
      return "Appliance";
    }

    return "";
  }


  /** Human-readable status block for tenant STATUS command (backup had no separate helper). */
  function formatTenantStatus_(t) {
    t = t || {};
    var id = String(t.ticketId || "").trim() || "(unknown)";
    var st = String(t.status || "").trim() || "Open";
    var pw = String(t.prefWindow || "").trim();
    var prop = String(t.property || "").trim();
    var unit = String(t.unit || "").trim();
    var loc = prop ? (prop + (unit ? " — " + unit : "")) : "";
    var lines = ["Ticket: " + id, "Status: " + st];
    if (loc) lines.push("Location: " + loc);
    if (pw) lines.push("Window: " + pw);
    return lines.join("\n");
  }


  
  function tenantStatusCommand_(sheet, phone, bodyTrim, lang) {
    const L = String(lang || "en").toLowerCase();

    const text = String(bodyTrim || "").trim();
    const m = text.match(/^status\s+(.+)$/i);
    const ticketId = m ? String(m[1] || "").trim() : "";

    const rows = findTenantTicketRows_(sheet, phone, { includeClosed: false });

    if (!rows.length) {
      return {
        ok: false,
        msg: tenantMsg_("TENANT_NO_ACTIVE_TICKETS_STATUS", L, {})
      };
    }

    // If ticketId provided, find that one
    if (ticketId) {
      const row = findTicketRowByTicketId_(sheet, ticketId);
      if (!row) {
        return {
          ok: false,
          msg: tenantMsg_("TENANT_TICKET_NOT_FOUND_WITH_HINT", L, { ticketId })
        };
      }

      const t = readTicketForTenant_(sheet, row);
      return { ok: true, msg: formatTenantStatus_(t) };
    }

    // No ticketId: if only one active ticket, show it
    if (rows.length === 1) {
      const t = readTicketForTenant_(sheet, rows[0]);
      return { ok: true, msg: formatTenantStatus_(t) };
    }

    // Multiple active tickets -> show a short list
    const list = rows.slice(0, 5).map(r => {
      const t = readTicketForTenant_(sheet, r);
      return "• " + (t.ticketId || ("Row " + r)) + " — " + (t.status || "(no status)");
    }).join("\n");

    return {
      ok: false,
      msg: tenantMsg_("TENANT_STATUS_PICK_WITH_LIST", L, { list })
    };
  }





  function tenantChangeTimeCommand_(sheet, dir, dirRow, phone, bodyTrim, dayWord, lang) {
    const L = String(lang || "en").toLowerCase();

    const text = String(bodyTrim || "").trim();
    const m = text.match(/^(change time|update time|reschedule)\s+(.+)$/i);
    const ticketId = m ? String(m[2] || "").trim() : "";

    const rows = findTenantTicketRows_(sheet, phone, { includeClosed: false });

    if (!rows.length) {
      return {
        ok: false,
        msg: tenantMsg_("TENANT_NO_ACTIVE_TICKETS_RESCHEDULE", L, {})
      };
    }

    let row = 0;

    // If ticketId provided, use it
    if (ticketId) {
      row = findTicketRowByTicketId_(sheet, ticketId) || 0;
      if (!row) {
        return {
          ok: false,
          msg: tenantMsg_("TENANT_TICKET_NOT_FOUND_WITH_HINT", L, { ticketId })
        };
      }
    } else {
      // No ticketId: if exactly one active ticket, use it; else ask which one
      if (rows.length === 1) {
        row = rows[0];
      } else {
        const list = rows.slice(0, 5).map(r => {
          const t = readTicketForTenant_(sheet, r);
          const win = t.prefWindow ? (" — " + t.prefWindow) : "";
          return "• " + (t.ticketId || ("Row " + r)) + " — " + (t.status || "(no status)") + win;
        }).join("\n");

        return {
          ok: false,
          msg: tenantMsg_("TENANT_CHANGE_TIME_PICK_WITH_LIST", L, { list })
        };
      }
    }

    // Anchor conversation to this ticket row and move to schedule stage
    var schedStageLabel = "SCHEDULE_" + String(dayWord || "Today").toUpperCase();
    dalWithLock_("TENANT_CHANGE_TIME_SET_PTR_STAGE", function () {
      dalSetPendingRowNoLock_(dir, dirRow, row);
      dalSetPendingStageNoLock_(dir, dirRow, schedStageLabel);
      dalSetLastUpdatedNoLock_(dir, dirRow);
      try { logDevSms_("", "", "DAL_WRITE TENANT_CHANGE_TIME_SET_PTR_STAGE row=" + dirRow + " ptr=" + row); } catch (_) {}
    });

    // Optional: mark waiting tenant again
    try { setStatus_(sheet, row, "Waiting Tenant"); } catch (_) {}

    const tid = String(sheet.getRange(row, COL.TICKET_ID).getValue() || "").trim();

    return {
      ok: true,
      msg:
        tenantMsg_("TENANT_CHANGE_TIME_CONFIRM_PREFIX", L, { ticketId: tid }) +
        "\n\n" +
        tenantMsg_("ASK_WINDOW", L, { dayWord })
    };
  }
