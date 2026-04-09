/**
 * GATEWAY_WEBHOOK.gs — Propera M1 Webhook (HTTP entry, validation, normalization, outbound intent guards)
 *
 * OWNS:
 *   - debugLogToSheet_, doPost, doGet, Telegram/AppSheet/portal early routes
 *   - Twilio validation, twiml helpers, lane classification, normalizeInboundEvent_
 *   - buildTenantOutboundTarget_, applyTenantOutboundTargetToIntent_, ensureTenantIntentOutboundTarget_, dispatchTenantIntent_
 *   - complianceIntent_, SMS opt-out, tenantCancelTicketCommand_
 *
 * DOES NOT OWN:
 *   - Router branch logic -> ROUTER_ENGINE.gs
 *
 * ENTRY POINTS:
 *   - doPost(e), doGet(e)
 *
 * DEPENDENCIES:
 *   - portalDoPost_, telegramWebhook_, flushDevSmsLogs_, handleSms_ / handleInboundCore_, etc.
 *
 * FUTURE MIGRATION NOTE:
 *   - API gateway / webhook workers; Twilio signature validation at edge
 *
 * SECTIONS IN THIS FILE:
 *   1. Debug log + doPost/doGet
 *   2. Lane dispatch + inbound normalization + tenant outbound target helpers
 *   3. Compliance + opt-out + cancel ticket command
 */

// ===================================================================
// ===== M1 — GATEWAY (Webhook Entry + Validation + Normalization) ====
// @MODULE:M1
// Responsibilities:
// - Twilio/SIM validation
// - Normalize inbound event
// - NO business logic
// ===================================================================

/** Writes one row to DebugLog sheet (script container). Visible even when Executions hide Logger. Never throws. */
function debugLogToSheet_(stage, pathOrPayload, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;
    var sh = ss.getSheetByName("DebugLog");
    if (!sh) {
      sh = ss.insertSheet("DebugLog");
      sh.getRange(1, 1, 1, 4).setValues([["Timestamp", "Stage", "PathOrPayload", "Detail"]]);
    }
    var detailStr = (detail != null && detail !== undefined) ? String(detail).slice(0, 500) : "";
    sh.appendRow([new Date(), stage, String(pathOrPayload || "").slice(0, 200), detailStr]);
  } catch (_) {}
}

function doPost(e) {
  // Sheet log first (Logger often not visible for Web App executions — check DebugLog sheet)
  try {
    var hasE = !!e;
    var hasPostData = !!(e && e.postData);
    var contentLen = (e && e.postData && e.postData.contents != null) ? String(e.postData.contents).length : 0;
    debugLogToSheet_("DOPOST_TOP", "hasE=" + hasE + " hasPostData=" + hasPostData, "contentLen=" + contentLen);
  } catch (_) {}

  // --- Telegram webhook: HARD GUARD first (stop retry loop; Telegram requires 200 + JSON) ---
  try {
    var raw = (e && e.postData && e.postData.contents != null) ? String(e.postData.contents) : "";
    if (raw && raw.length > 0) {
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) {}
      var isTelegram = false;
      if (parsed && parsed.update_id != null &&
          (parsed.message || parsed.edited_message || parsed.callback_query)) {
        isTelegram = true;
      }
      // Fallback: body looks like Telegram even if parse failed (e.g. encoding)
      if (!isTelegram && raw.indexOf("update_id") !== -1 &&
          (raw.indexOf("message") !== -1 || raw.indexOf("edited_message") !== -1 || raw.indexOf("callback_query") !== -1)) {
        isTelegram = true;
      }
      if (isTelegram) {
        try { debugLogToSheet_("TELEGRAM_DETECTED", "update_id=" + (parsed ? parsed.update_id : "parse_fail"), ""); } catch (_) {}
        return telegramWebhook_(e);
      }
      try { debugLogToSheet_("DOPOST_NOT_TELEGRAM", "len=" + raw.length, "parsed=" + !!parsed + " update_id=" + (parsed ? parsed.update_id : "n/a")); } catch (_) {}
    }
  } catch (err) {
    try { debugLogToSheet_("TELEGRAM_DET_ERROR", "", (err && err.message ? err.message : String(err)).slice(0, 200)); } catch (_) {}
  }

  const OK = ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
  var pathVal = (e && e.parameter && e.parameter.path) ? String(e.parameter.path).trim() : "(none)";
  var postLen = (e && e.postData && e.postData.contents) ? String(e.postData.contents).length : 0;
  try { Logger.log("DOPOST_ENTER path=" + pathVal); } catch (_) {}
  debugLogToSheet_("DOPOST_ENTER", pathVal, "postLen=" + postLen);

  // --- Portal API route: single doPost gateway; path in query → delegate to ProperaPortalAPI ---
  try {
    const path = (e && e.parameter && e.parameter.path) ? String(e.parameter.path).trim() : "";
    if (path) {
      try { Logger.log("GATEWAY_POST route=PORTAL path=" + path); } catch (_) {}
      debugLogToSheet_("PORTAL_ENTER", path, "");
      var portalOut = (typeof portalDoPost_ === "function") ? portalDoPost_(e) : OK;
      try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
      debugLogToSheet_("PORTAL_DONE", path, "ok");
      return portalOut;
    }
  } catch (portalErr) {
    var errStr = (portalErr && portalErr.message) ? portalErr.message : String(portalErr);
    if (portalErr && portalErr.stack) errStr += " " + String(portalErr.stack).slice(0, 300);
    try { Logger.log("GATEWAY_POST PORTAL_ERR " + errStr); } catch (_) {}
    debugLogToSheet_("PORTAL_ERR", pathVal, errStr);
    try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
    // Return JSON so Portal API clients (e.g. Next.js upload route) can parse; do not return plain "OK".
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "portal_error", message: errStr })).setMimeType(ContentService.MimeType.JSON);
  }

  // --- AppSheet early route (must be BEFORE Twilio gate) ---
  try {
    const ct  = String((e && e.postData && e.postData.type) ? e.postData.type : "").toLowerCase();
    const raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";

    // Always log something visible (does not depend on From/Body)
    try { Logger.log("APPSHEET_GATE ct=" + ct + " rawLen=" + raw.length); } catch (_) {}

    // Heuristic: if raw looks like JSON, attempt parse even if ct is missing
    const looksJson = raw && raw.charAt(0) === "{";
    if ((ct.indexOf("application/json") >= 0 || looksJson) && raw) {
      let data = null;
      try { data = JSON.parse(raw); } catch (parseErr) {
        // IMPORTANT: Do not fall through into Twilio logic.
        // Return OK so AppSheet doesn't show "doPost failed".
        try { Logger.log("APPSHEET_JSON_PARSE_FAIL " + String(parseErr)); } catch (_) {}
        return OK;
      }

      // ---- Alexa gate ----
      if (data && data.alexaRequest === true) {
        try {
          var alexaOut = handleAlexaWebhook_(data);
          try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
          return ContentService.createTextOutput(JSON.stringify(alexaOut))
            .setMimeType(ContentService.MimeType.JSON);
        } catch (err) {
          Logger.log("ALEXA_HANDLER_CRASH " + String(err));
          try { if (typeof flushDevSmsLogs_ === "function") flushDevSmsLogs_(); } catch (_) {}
          return ContentService.createTextOutput(
            JSON.stringify(alexaBuildErrorResponse_("System error. Please try again."))
          ).setMimeType(ContentService.MimeType.JSON);
        }
      }

      // If payload has ownership keys, route it
      if (data && (data.action || data.ticketId || data.ticketRow || data.tenantPhone || data.to || data.message)) {
        try { Logger.log("GATEWAY_POST route=APPSHEET"); } catch (_) {}
        try {
          // This is the DevLog equivalent for AppSheet
          logDevSms_("(appsheet)", "", "APPSHEET_HIT action=" + String(data.action || "") + " row=" + String(data.ticketRow || ""));
        } catch (_) {}

        // Wrap handler so we ALWAYS return OK even if handler crashes
        try {
          const out = handleAppSheetWebhook(e);
          return out || OK;
        } catch (err) {
          try { Logger.log("APPSHEET_HANDLER_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
          return OK;
        }
      }

      // JSON but not for us — still return OK (avoid Twilio path)
      return OK;
    }
  } catch (err) {
    try { Logger.log("APPSHEET_GATE_CRASH " + String(err && err.stack ? err.stack : err)); } catch (_) {}
    return OK; // safest for AppSheet callers
  }

  // --- Twilio path continues below exactly as you already have it ---
  let out;

  // Always have request-scoped TwiML outbox
  var twimlOutbox = [];
  TWIML_OUTBOX_ = twimlOutbox;

  function devEmitTwiML_(msg) {
    var s = String(msg || "").trim();
    if (!s) return;
    twimlOutbox.push(s);
  }
  DEV_EMIT_TWIML_ = devEmitTwiML_;

  // Snapshot params once (avoid repeated e.parameter reads)
  const p = (e && e.parameter) ? e.parameter : {};
  const from0   = String(p.From || "").trim();
  const body0   = String(p.Body || "").trim();
  const action0 = String(p.action || "").trim();
  const sid0    = String(p.MessageSid || p.SmsMessageSid || "").trim();

  // If media-only message, inject a harmless marker so downstream never sees empty body.
  try {
    const numMediaN0 = parseInt(String(p.NumMedia || "0"), 10) || 0;
    if (!body0 && numMediaN0 > 0) {
      globalThis.__bodyOverride = "ATTACHMENT_ONLY";
    } else {
      globalThis.__bodyOverride = "";
    }
  } catch (_) { globalThis.__bodyOverride = ""; }

  // Request-scoped inbound channel (reply_ uses this to choose sendSms_ vs sendWhatsApp_)
  try {
    var fromRaw0 = String(e && e.parameter && e.parameter.From ? e.parameter.From : "");
    globalThis.__fromRaw = fromRaw0;
    try {
      globalThis.__traceAdapter = (/^whatsapp:/i.test(fromRaw0)) ? "WA" : "SMS";
      globalThis.__traceId = sid0 ? String(sid0).trim() : "";
      globalThis.__traceEventEid = sid0 ? ("TWILIO_SID:" + String(sid0).trim()) : "";
    } catch (_) {}
  } catch (_) {
    // no-op: channel is threaded explicitly via event params
  }

  // 🔴 HARD PROOF: visible in Executions regardless of dev log buffer/flush
  try {
    Logger.log(
      "DOPOST_ENTRY from=" + (from0 || "(no-from)") +
      " sid=" + (sid0 || "(no-sid)") +
      (action0 ? (" action=" + action0) : "") +
      " body=" + (body0 ? body0.slice(0, 80) : "(no-body)")
    );
  } catch (_) {}

  try {
    // Buffered dev log (sheet) — may be suppressed by chaos rules; still keep it
    try {
      logDevSms_(
        from0 || "(no-from)",
        body0 || "(no-body)",
        "DOPOST_HIT" + (sid0 ? (" sid=" + sid0) : "") + (action0 ? (" action=" + action0) : "")
      );
    } catch (_) {}

    // --------------------------------------------
    // REQUEST-SCOPED DEV MODE (emulator / demos)
    // Same as PROPERA_MAIN_BACKUP: _dryrun=1 or _dev=true AND SIM + allowlist → devReqOn_
    // (sendSms_ mirrors into TWIML_OUTBOX_ so doPost can return <Message> TwiML.)
    // --------------------------------------------
    try {
      const dry = String(p._dryrun || p._dev || "").trim();
      if (dry === "1" || dry.toLowerCase() === "true") {
        const fromKey = phoneKey_(String(p.From || "").trim());
        if (simEnabled_() && fromKey && isSimAllowedPhone_(fromKey)) devReqOn_();
      }
    } catch (_) {}

    const action = String(p.action || "").trim().toLowerCase();

    // -------------------------------------------------
    // COMM ROUTER (AppSheet/webhook) — returns JSON
    // -------------------------------------------------
    const isBuild = (action === "comm_build" || action === "build");
    const isQueue = (action === "comm_queue" || action === "queue");

    if (isBuild || isQueue) {
      try {
        const commId = String(p.commId || "").trim();
        const secret = String(p.secret || "").trim();
        var commSecret = commWebhookSecret_();
        if (secret !== commSecret || !commId) {
          out = ContentService
            .createTextOutput(JSON.stringify({ ok: false, error: "Forbidden or missing commId" }))
            .setMimeType(ContentService.MimeType.JSON);
        } else {
          const res = isBuild ? buildRecipients(commId) : queueCommunication(commId);
          out = ContentService
            .createTextOutput(JSON.stringify(res))
            .setMimeType(ContentService.MimeType.JSON);
        }
      } catch (err) {
        out = ContentService
          .createTextOutput(JSON.stringify({
            ok: false,
            error: String(err && err.message ? err.message : err)
          }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return out;
    }

    // -------------------------------------------------
    // TELEGRAM WEBHOOK (JSON, action=telegram_webhook)
    // -------------------------------------------------
    if (action === "telegram_webhook") {
      try {
        return telegramWebhook_(e);
      } catch (tgErr) {
        try {
          if (typeof dbg_ === "function") {
            dbg_("TELEGRAM_WEBHOOK_ERR_TOP", { error: String(tgErr && tgErr.stack ? tgErr.stack : tgErr) });
          }
        } catch (_) {}
        return ContentService
          .createTextOutput(JSON.stringify({ ok: false }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // -------------------------------------------------
    // TWILIO WEBHOOK GATE (Propera Compass – Phase A)
    // Runs ONLY for SMS webhooks (no action param)
    // -------------------------------------------------
    // Non-Twilio request fallback (AppSheet / other webhooks)
    // If it somehow bypassed the JSON router, do NOT run Twilio validation.
    // Always return OK so AppSheet doesn't show "doPost failed".
    if (!from0 && !body0) {
      try {
        const raw1 = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";
        logDevSms_("(appsheet)", raw1.slice(0, 80), "APPSHEET_FALLBACK_OK rawLen=" + String(raw1.length));
      } catch (_) {}
      return OK;
    }
    try { Logger.log("GATEWAY_POST route=TWILIO"); } catch (_) {}
    try {
      const gate = validateTwilioWebhookGate_(e);
      if (!gate.ok) {
        try {
          logDevSms_(from0 || "(no-from)", body0 || "(no-body)", "WEBHOOK_DENY why=" + gate.why);
        } catch (_) {}
        try {
          var _eid = String((e && e.parameter && (e.parameter.MessageSid || e.parameter.SmsMessageSid || e.parameter.sid)) || "");
          logInvariantFail_(from0 || "(no-from)", _eid, "WEBHOOK_DENY", "why=" + (gate.why || ""));
        } catch (_) {}
        out = twimlEmpty_();
        return out;
      }
    } catch (gateErr) {
      try {
        logDevSms_(
          from0 || "(no-from)",
          body0 || "(no-body)",
          "WEBHOOK_GATE_CRASH " + String(gateErr && gateErr.stack ? gateErr.stack : gateErr)
        );
      } catch (_) {}
      out = twimlEmpty_();
      return out;
    }

    // -------------------------------------------------
    // SMS ROUTER (always returns TwiML)
    // -------------------------------------------------
    try {
      // ✅ FRAG REMOVED (2026-02-17): All messages pass straight through.
      // Carrier splits handled by state machine (compileTurn_ + context accumulation).
      handleInboundRouter_(e);
    } catch (err) {
      try {
        const fromKey = phoneKey_(String(p.From || "").trim());
        try {
          if (typeof debugLogToSheet_ === "function") {
            debugLogToSheet_(
              "ROUTER_CRASH_TRACE",
              String((typeof globalThis !== "undefined" && globalThis.__traceId) ? globalThis.__traceId : fromKey || ""),
              "adapter=" + String((typeof globalThis !== "undefined" && globalThis.__traceAdapter) ? globalThis.__traceAdapter : "") +
                " err=" + String(err && err.stack ? err.stack : err).slice(0, 200)
            );
          }
        } catch (_) {}
        logDevSms_(
          from0 || "(no-from)",
          body0 || "(no-body)",
          "ROUTER_CRASH " + String(err && err.stack ? err.stack : err)
        );

        // Compass-safe fallback message (no state mutation) — via Outgate when available
        if (fromKey) {
          var _ogCrashChannel = (typeof getResolvedInboundChannel_ === "function") ? String(getResolvedInboundChannel_(e) || "SMS").trim().toUpperCase() : "SMS";
          var _ogCrash = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_({ intentType: "ERROR_CRASH_FALLBACK", recipientType: "TENANT", recipientRef: fromKey, lang: "en", channel: _ogCrashChannel, deliveryPolicy: "NO_HEADER", vars: {}, meta: { source: "doPost", stage: "ROUTER_CRASH", flow: "FALLBACK" } }) : { ok: false };
          if (!(_ogCrash && _ogCrash.ok)) sendRouterSms_(fromKey, renderTenantKey_("ERR_CRASH_FALLBACK", "en", {}), "CRASH_FALLBACK", _ogCrashChannel);
        }
      } catch (_) {}
    }

    if (TWIML_OUTBOX_ && TWIML_OUTBOX_.length >= 1) {
      out = twimlWithMessage_(TWIML_OUTBOX_[TWIML_OUTBOX_.length - 1]);
    } else {
      out = twimlEmpty_();
    }
    return out;

  } finally {
    // Cleanup: never let request-scoped globals bleed across executions
    try { clearExecutionSheetCaches_(); } catch (_) {}
    try { __FINDROW_CACHE__ = {}; } catch (_) {}
    try { __CTX_CACHE__ = {}; } catch (_) {}
    try { TWIML_OUTBOX_ = null; DEV_EMIT_TWIML_ = null; } catch (_) {}
    try { globalThis.__bodyOverride = ""; } catch (_) {}
    try { SIM_PHONE_SCOPE_ = ""; } catch (_) {}
    try { globalThis.__traceAdapter = ""; } catch (_) {}
    try { globalThis.__traceId = ""; } catch (_) {}
    try { globalThis.__traceEventEid = ""; } catch (_) {}
    try { devReqOff_(); } catch (_) {}

    // ✅ Always flush dev logs, even on early returns
    try {
      flushDevSmsLogs_();
    } catch (err) {
      // Do NOT swallow — if dev logs don't appear, we need this in Executions
      try { Logger.log("DEVLOG_FLUSH_DOPOST_ERR " + (err && err.stack ? err.stack : err)); } catch (_) {}
    }
  }
}

function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const path = (p.path) ? String(p.path).trim() : "";
  if (path) {
    try { Logger.log("GATEWAY_GET route=PORTAL path=" + path); } catch (_) {}
    try {
      return (typeof portalDoGet_ === "function") ? portalDoGet_(e) : ContentService.createTextOutput(JSON.stringify({ error: "portal_unavailable" })).setMimeType(ContentService.MimeType.JSON);
    } catch (portalErr) {
      try { Logger.log("GATEWAY_GET PORTAL_ERR " + String(portalErr && portalErr.stack ? portalErr.stack : portalErr)); } catch (_) {}
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "portal_error" })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  try {
    const action = String(p.action || "").trim();

    if (action === "sim_read_last_outbound") {
      const secret = String(p.secret || "").trim();
      const simSecret = PropertiesService.getScriptProperties().getProperty("SIM_READ_SECRET") || "";
      if (!secret || secret !== simSecret) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, why: "bad_secret" }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const phoneRaw = String(p.phone || "").trim();
      const phone = (typeof phoneKey_ === "function") ? phoneKey_(phoneRaw) : phoneRaw;
      try { SIM_PHONE_SCOPE_ = phone || ""; } catch (_) {}

      const result = simReadLastOutboundFromLog_(phone);
      const payload = { ok: true, found: result.found };
      if (result.found) {
        payload.ts = result.ts;
        payload.message = result.message;
        payload.status = result.status;
        payload.extra = result.extra;
      }
      return ContentService.createTextOutput(JSON.stringify(payload))
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (_) {}
  return ContentService.createTextOutput(JSON.stringify({ ok: false }))
    .setMimeType(ContentService.MimeType.JSON);
}

function twimlEmpty_() {
  return ContentService
    .createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Response/>')
    .setMimeType(ContentService.MimeType.XML);
}

/** Returns TwiML <Response><Message>escaped(text)</Message></Response> for chaosRunner (DEV_MODE). */
function twimlWithMessage_(text) {
  var s = String(text || "");
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return ContentService
    .createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + s + '</Message></Response>')
    .setMimeType(ContentService.MimeType.XML);
}

//Router Helpers


// -------------------------
// RouterDecision v1 (shared)
// -------------------------
function makeRouterDecision_(patch) {
  const P = patch || {};
  return {
    v: 1,

    lane: String(P.lane || "tenantLane"),          // tenantLane/managerLane/vendorLane/systemLane
    reason: String(P.reason || "default"),         // why chosen

    mode: String(P.mode || ""),                    // "TENANT" | "MANAGER" | "VENDOR" | "SYSTEM"
    confidence: (P.confidence === undefined ? "" : Number(P.confidence)),

    // optional routing hints
    routeKey: String(P.routeKey || ""),
    workItemType: String(P.workItemType || ""),
    expected: String(P.expected || ""),

    tags: Array.isArray(P.tags) ? P.tags : [],

    // debug
    trace: String(P.trace || "")
  };
}

// -------------------------
// Normalize inbound events
// -------------------------
function normalizeInboundEvent_(source, opts) {
  const O = opts || {};

  const body = String(O.body || "");
  const bodyTrim = body.trim();

  // normalize channel into a simple, lowercased discriminator
  const channel = String(O.channel || "").toLowerCase();

  // normalize media into a stable array of { url, contentType, source }
  // IMPORTANT (media contract):
  // - `opts.media` must already be the canonical media list for the inbound event.
  // - For Twilio/WhatsApp and Telegram, that canonical list is derived from `_mediaJson`
  //   via `parseCanonicalMediaArrayFromEvent_()` (which prefers `_mediaJson` and falls back
  //   to legacy `NumMedia`/`MediaUrl*` only for compatibility).
  let media = [];
  try {
    if (Array.isArray(O.media)) {
      media = O.media.map(function(m) {
        return {
          url: String(m && m.url || ""),
          contentType: String(m && (m.contentType || m.mimeType) || ""),
          source: String(m && m.source || "")
        };
      }).filter(function(m) {
        return m.url;
      });
    }
  } catch (_) {
    media = [];
  }

  // keep meta always a plain object
  let meta = {};
  try {
    meta = (O.meta && typeof O.meta === "object") ? O.meta : {};
  } catch (_) {
    meta = {};
  }

  return {
    v: 1,
    source: String(source || "unknown").toLowerCase(),

    channel: channel,

    actorType: String(O.actorType || "unknown").toLowerCase(),
    actorId: String(O.actorId || ""),

    body: body,
    bodyTrim: bodyTrim,
    bodyLower: bodyTrim.toLowerCase(),

    media: media,

    eventId: String(O.eventId || Utilities.getUuid()),
    timestamp: O.timestamp || new Date(),

    meta: meta
  };
}

// -------------------------
// Lane classification (ONE source of truth)
// -------------------------
function classifyLane_(inbound) {
  let lane = "tenantLane";
  let reason = "default";

  try {
    if (isVendor_(inbound.actorId)) {
      lane = "vendorLane";
      reason = "isVendor_";
    } else if (isManager_(inbound.actorId)) {
      lane = "managerLane";
      reason = "isManager_";
    } else if (String(inbound.source || "") === "aiq") {
      lane = "systemLane";
      reason = "aiq_source";
    }
  } catch (_) {}

  const mode =
    (lane === "vendorLane")  ? "VENDOR"  :
    (lane === "managerLane") ? "MANAGER" :
    (lane === "systemLane")  ? "SYSTEM"  :
                              "TENANT";

  return { lane: lane, reason: reason, mode: mode };
}

// -------------------------
// Decide lane ONCE (REAL decision object)
// -------------------------
function decideLane_(inbound) {
  const c = classifyLane_(inbound);
  return makeRouterDecision_({
    lane: c.lane,
    reason: c.reason,
    mode: c.mode,
    trace: "lane_v1"
  });
}

// -------------------------
// Shadow route log (no behavior change)
// -------------------------
function shadowRouteLog_(decision, inbound) {
  try { } catch (_) {}
}

// -------------------------
// Shadow lane-enter log (optional)
// -------------------------
function shadowLaneDispatch_(decision, inbound) {
  const lane = String((decision && decision.lane) || "tenantLane");

  try {
    if (lane === "vendorLane") return vendorLaneShadow_(inbound, decision);
    if (lane === "managerLane") return managerLaneShadow_(inbound, decision);
    if (lane === "systemLane") return systemLaneShadow_(inbound, decision);
    return tenantLaneShadow_(inbound, decision);
  } catch (_) {}
}

function tenantLaneShadow_(inbound, decision) {
  try { } catch (_) {}
}
function managerLaneShadow_(inbound, decision) {
  try { } catch (_) {}
}
function vendorLaneShadow_(inbound, decision) {
  try { } catch (_) {}
}
function systemLaneShadow_(inbound, decision) {
  try { } catch (_) {}
}

// -------------------------
// Real dispatch (behavior lives in lane handlers)
// -------------------------
function laneDispatch_(decision, inbound) {
  const lane = String((decision && decision.lane) || "tenantLane");

  // Always log lane-enter (deterministic)
  try {
    logDevSms_(
      inbound.actorId,
      inbound.bodyTrim,
      "LANE_ENTER lane=[" + lane + "] reason=[" + String(decision.reason || "") + "] eid=[" + inbound.eventId + "]"
    );
  } catch (_) {}

  if (lane === "vendorLane")  return handleVendorLane_(inbound, decision);
  if (lane === "managerLane") return handleManagerLane_(inbound, decision);
  if (lane === "systemLane")  return handleSystemLane_(inbound, decision);
  return handleTenantLane_(inbound, decision);
}

// -------------------------
// Lane handlers v1 (THIN WRAPPERS)
// -------------------------
function handleTenantLane_(inbound, decision) {
  try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE TENANT eid=[" + inbound.eventId + "]"); } catch (_) {}
  return handleTenantInbound_(inbound, decision);
}
function handleManagerLane_(inbound, decision) {
  try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE MANAGER eid=[" + inbound.eventId + "]"); } catch (_) {}
  return handleManagerInbound_(inbound, decision);
}
function handleVendorLane_(inbound, decision) {
  try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE VENDOR eid=[" + inbound.eventId + "]"); } catch (_) {}
  return handleVendorInbound_(inbound, decision);
}
function handleSystemLane_(inbound, decision) {
  try { logDevSms_(inbound.actorId, inbound.bodyTrim, "LANE SYSTEM eid=[" + inbound.eventId + "]"); } catch (_) {}
  return handleSystemInbound_(inbound, decision);
}

// -------------------------
// Optional: event logging
// -------------------------
function logEvent_(type, data) {
  try {
    withWriteLock_("LOG_EVENT_" + type, () => {
      const ss = SpreadsheetApp.getActive();
      const sh = ss.getSheetByName("EventLog") || ss.insertSheet("EventLog");
      sh.appendRow([ new Date(), String(type), JSON.stringify(data || {}) ]);
    });
  } catch (_) {}
}


// =====================================================
// PROPERA COMPASS: Router → Safe → Core (never bypass)
// =====================================================

function routeToCoreSafe_(e, opts) {
  opts = opts || {};

  // Make sure parameter object exists
  e = e || {};
  e.parameter = e.parameter || {};

  // Mode support (you already have)
  if (opts.mode) e.parameter._mode = String(opts.mode);

  // ✅ ONLY mark internal injections (Core replays, synthetic calls, etc.)
  if (opts.internal === true) e.parameter._internal = "1";

  // Thread explicit channel from router into core when provided
  if (opts.channel) e.parameter._channel = String(opts.channel);

  return handleInboundCore_(e);
}

/**
 * Lane dispatch → core (shadow path). Monolith referenced these but had no definitions.
 * Builds a minimal synthetic Twilio-shaped event and enters the same spine as routeToCoreSafe_.
 */
function channelFromLaneInbound_(inbound) {
  var ch = String((inbound && inbound.channel) || "").toLowerCase();
  if (ch === "whatsapp") return "WA";
  if (ch === "telegram") return "TELEGRAM";
  return "SMS";
}

function laneInboundToSyntheticEvent_(inbound, decision, modeFallback) {
  inbound = inbound || {};
  var body = String(
    inbound.body !== undefined && inbound.body !== null ? inbound.body : inbound.bodyTrim || ""
  );
  var from = String(inbound.actorId || "").trim();
  var e = { parameter: {} };
  e.parameter.From = from;
  e.parameter.Body = body;
  e.parameter.MessageSid =
    String(inbound.eventId || "").trim() || "LANE_" + String(Date.now());
  try {
    if (inbound.meta && inbound.meta.numMedia != null) {
      e.parameter.NumMedia = String(inbound.meta.numMedia);
    }
  } catch (_) {}
  var fromNorm = from.replace(/^whatsapp:/i, "");
  var phone =
    (typeof normalizePhone_ === "function") ? normalizePhone_(fromNorm) : "";
  if (phone) e.parameter._phoneE164 = phone;
  var dmode = (decision && decision.mode) ? String(decision.mode).trim().toUpperCase() : "";
  if (!dmode) dmode = String(modeFallback || "TENANT").toUpperCase();
  e.parameter._mode = dmode;
  return e;
}

function handleTenantInbound_(inbound, decision) {
  var e = laneInboundToSyntheticEvent_(inbound, decision, "TENANT");
  return routeToCoreSafe_(e, {
    mode: "TENANT",
    channel: channelFromLaneInbound_(inbound)
  });
}

function handleManagerInbound_(inbound, decision) {
  var e = laneInboundToSyntheticEvent_(inbound, decision, "MANAGER");
  return routeToCoreSafe_(e, {
    mode: "MANAGER",
    channel: channelFromLaneInbound_(inbound)
  });
}

function handleVendorInbound_(inbound, decision) {
  var e = laneInboundToSyntheticEvent_(inbound, decision, "VENDOR");
  return routeToCoreSafe_(e, {
    mode: "VENDOR",
    channel: channelFromLaneInbound_(inbound)
  });
}

function handleSystemInbound_(inbound, decision) {
  var e = laneInboundToSyntheticEvent_(inbound, decision, "SYSTEM");
  return routeToCoreSafe_(e, {
    mode: "SYSTEM",
    channel: channelFromLaneInbound_(inbound)
  });
}

/**
 * Outbound-compatible channel: explicit event channel only.
 * Values: SMS | WA | TELEGRAM (matches OUTGATE).
 */
function getResolvedInboundChannel_(e) {
  try {
    var p = (e && e.parameter) ? e.parameter : {};
    var ch = String(p._channel || "").trim().toUpperCase();
    if (ch === "WA" || ch === "SMS" || ch === "TELEGRAM") return ch;
  } catch (_) {}
  return "SMS";
}

/**
 * Canonical tenant outbound delivery target + channel-correct inbound dedupe identity.
 * All facts come from the inbound envelope (e.parameter); no globals.
 * TELEGRAM: ok=false if _telegramChatId missing (do not pretend SMS).
 * @param {Object} e
 * @param {string} recipientRef - Tenant key (E.164 or TG:userId)
 * @param {Object} [opts] - { bodyForNosid?: string, channel?: string, telegramChatId?: string }
 * @returns {{ ok: boolean, channel: string, recipientRef: string, telegramChatId: string, dedupeChannel: string, dedupeId: string, inboundDedupeKey: string, error: string }}
 */
function buildTenantOutboundTarget_(e, recipientRef, opts) {
  opts = opts || {};
  var out = {
    ok: false,
    channel: "SMS",
    recipientRef: String(recipientRef || "").trim(),
    telegramChatId: "",
    dedupeChannel: "SMS",
    dedupeId: "",
    inboundDedupeKey: "",
    error: ""
  };
  var p = (e && e.parameter) ? e.parameter : {};
  var fromRaw = String(p.From || "").trim();
  var fromDed = fromRaw.toLowerCase();
  var bodyForNosid = String(opts.bodyForNosid != null ? opts.bodyForNosid : (p.Body || "")).trim();

  var channel = String(opts.channel || "").trim().toUpperCase();
  if (!channel || (channel !== "SMS" && channel !== "WA" && channel !== "TELEGRAM")) {
    channel = (typeof getResolvedInboundChannel_ === "function") ? getResolvedInboundChannel_(e) : "SMS";
  }
  if (channel !== "SMS" && channel !== "WA" && channel !== "TELEGRAM") {
    if (fromDed.indexOf("whatsapp:") === 0) channel = "WA";
    else if (/^tg:/i.test(fromRaw) || String(p._channel || "").toUpperCase() === "TELEGRAM") channel = "TELEGRAM";
    else channel = "SMS";
  }
  out.channel = channel;
  out.dedupeChannel = channel;

  var sidTw = String(p.MessageSid || p.SmsMessageSid || "").trim();
  var tgUp = String(p._telegramUpdateId || "").trim();
  out.dedupeId = sidTw || tgUp;
  if (!out.dedupeId) {
    out.dedupeId = "NOSID:" + (typeof _nosidDigest_ === "function" ? _nosidDigest_(fromDed, bodyForNosid) : String(bodyForNosid.length));
  }
  out.inboundDedupeKey = "SID:" + out.dedupeChannel + ":" + out.dedupeId;

  if (!out.recipientRef) {
    out.error = "recipient_ref_empty";
    try { logDevSms_("", "", "OUTBOUND_TARGET_BUILD_FAIL reason=" + out.error); } catch (_) {}
    return out;
  }

  out.telegramChatId = String(opts.telegramChatId != null ? opts.telegramChatId : (p._telegramChatId || "")).trim();

  if (channel === "TELEGRAM") {
    if (!out.telegramChatId) {
      out.error = "missing_telegram_chat_id";
      try { logDevSms_(out.recipientRef, "", "OUTBOUND_TARGET_MISSING_TELEGRAM_CHAT dedupeKey=" + out.inboundDedupeKey); } catch (_) {}
      try { logDevSms_(out.recipientRef, "", "OUTBOUND_TARGET_BUILD_FAIL reason=" + out.error + " OUTBOUND_TARGET_DEDUPE_ID=" + String(out.dedupeId).slice(0, 48)); } catch (_) {}
      return out;
    }
  }

  out.ok = true;
  out.error = "";
  try {
    logDevSms_(
      out.recipientRef,
      "",
      "OUTBOUND_TARGET_BUILD_OK OUTBOUND_TARGET_CHANNEL=[" + out.channel + "] OUTBOUND_TARGET_DEDUPE_ID=[" + String(out.dedupeId).slice(0, 64) + "]"
    );
  } catch (_) {}
  return out;
}

/**
 * Merge canonical target onto intent before dispatchOutboundIntent_. No-op if target.ok is false.
 */
function applyTenantOutboundTargetToIntent_(intent, target) {
  if (!intent || typeof intent !== "object" || !target || !target.ok) return intent;
  intent.channel = target.channel;
  intent.recipientRef = target.recipientRef;
  if (target.channel === "TELEGRAM" && target.telegramChatId) intent.telegramChatId = target.telegramChatId;
  if (!intent.meta || typeof intent.meta !== "object") intent.meta = {};
  intent.meta.inboundDedupeKey = target.inboundDedupeKey;
  intent.meta.outboundDedupeChannel = target.dedupeChannel;
  intent.meta.outboundDedupeId = target.dedupeId;
  intent.meta.outboundTargetExplicit = true;
  return intent;
}

/**
 * Build + apply explicit outbound target. Returns false if target cannot be built (caller must not dispatch).
 */
function ensureTenantIntentOutboundTarget_(e, intent, phone, bodyForNosid) {
  if (!intent || typeof intent !== "object") return false;
  var t = buildTenantOutboundTarget_(e, phone, { bodyForNosid: bodyForNosid });
  if (!t.ok) {
    try {
      logDevSms_(
        String(phone || ""),
        "",
        "OUTBOUND_TARGET_BUILD_FAIL intentType=" + String(intent.intentType || "") + " reason=" + String(t.error || "")
      );
    } catch (_) {}
    return false;
  }
  applyTenantOutboundTargetToIntent_(intent, t);
  try {
    logDevSms_(String(phone || ""), "", "OUTBOUND_TARGET_EXPLICIT_USED intentType=" + String(intent.intentType || ""));
  } catch (_) {}
  return true;
}

/**
 * Tenant outbound: always ensureTenantIntentOutboundTarget_ then dispatchOutboundIntent_ only.
 * No direct send, no render. Returns structured result.
 * @returns {{ ok: boolean, ensured: boolean, error: string, dispatch: Object|null }}
 */
function dispatchTenantIntent_(e, phone, bodyTrim, intent) {
  var out = { ok: false, ensured: false, error: "", dispatch: null };
  if (!intent || typeof intent !== "object") {
    out.error = "intent_invalid";
    try { logDevSms_(String(phone || ""), "", "DISPATCH_TENANT_INTENT_FAIL reason=" + out.error); } catch (_) {}
    return out;
  }
  if (typeof ensureTenantIntentOutboundTarget_ !== "function" || !ensureTenantIntentOutboundTarget_(e, intent, phone, bodyTrim)) {
    out.error = "ensure_outbound_target_failed";
    try {
      logDevSms_(
        String(phone || ""),
        "",
        "DISPATCH_TENANT_INTENT_FAIL reason=" + out.error + " intentType=" + String(intent.intentType || "")
      );
    } catch (_) {}
    return out;
  }
  out.ensured = true;
  if (typeof dispatchOutboundIntent_ !== "function") {
    out.error = "dispatchOutboundIntent_unavailable";
    try { logDevSms_(String(phone || ""), "", "DISPATCH_TENANT_INTENT_FAIL reason=" + out.error); } catch (_) {}
    return out;
  }
  var d = dispatchOutboundIntent_(intent);
  out.dispatch = d;
  out.ok = !!(d && d.ok);
  if (!out.ok) {
    out.error = String((d && d.error) || "dispatch_not_ok");
    try {
      logDevSms_(
        String(phone || ""),
        "",
        "DISPATCH_TENANT_INTENT_FAIL reason=" + out.error + " intentType=" + String(intent.intentType || "")
      );
    } catch (_) {}
  }
  return out;
}


function validateTwilioWebhookGate_(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const from = phoneKey_(String(p.From || "").trim());
  const body = String(p.Body || "").trim();
  const sec  = String(p.twhsec || "").trim();
  const acct = String(p.AccountSid || "").trim();

  // ✅ Allow attachment-only messages (Body may be empty when NumMedia > 0)
  const numMediaN = parseInt(String(p.NumMedia || "0"), 10) || 0;
  const hasBody  = body.length > 0;
  const hasMedia = numMediaN > 0;

  if (!from || (!hasBody && !hasMedia)) return { ok:false, why:"missing_from_or_body" };

  try {
    const simSec = String(PropertiesService.getScriptProperties().getProperty("SIM_WEBHOOK_SECRET") || "");
    const allowRaw = String(PropertiesService.getScriptProperties().getProperty("SIM_ALLOW_PHONES") || "");
    const simModeRaw = String(PropertiesService.getScriptProperties().getProperty("SIM_MODE") || "");
    const killedRaw = String(PropertiesService.getScriptProperties().getProperty("SIM_KILL") || "");

    function mask_(s) {
      s = String(s || "");
      if (s.length <= 8) return "len=" + s.length;
      return s.slice(0, 4) + "..." + s.slice(-4) + " (len=" + s.length + ")";
    }

    logDevSms_(
      String(p.From || ""),
      String(p.Body || ""),
      "SIM_GATE_DEBUG",
      "sec=" + mask_(String(p.twhsec || "")) +
      " simSec=" + mask_(simSec) +
      " SIM_MODE=" + simModeRaw +
      " SIM_KILL=" + killedRaw +
      " allowRaw=" + allowRaw +
      " NumMedia=" + String(numMediaN)
    );

  } catch (_) {}

  // SIM path (must run BEFORE production checks)
  try {
    const simSec = String(PropertiesService.getScriptProperties().getProperty("SIM_WEBHOOK_SECRET") || "").trim();
    if (simEnabled_() && from && isSimAllowedPhone_(from) && simSec && sec === simSec) {
      if (simKilled_()) return { ok:false, why:"sim_killed" };
      return { ok:true, sim:true };
    }
  } catch (_) {}

  // PROD path
  if (!sec || sec !== String(TWILIO_WEBHOOK_SECRET || "").trim()) return { ok:false, why:"bad_secret" };
  if (!acct || acct !== String(TWILIO_SID || "").trim()) return { ok:false, why:"bad_accountsid" };
  return { ok:true };
}

function normMsg_(s) {
  return String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
}
function normNoSpace_(s) {
  return normMsg_(s).replace(/\s+/g, "");
}

/*******************************************************
* COMPLIANCE INTENT (EXACT-ONLY)
* - Returns: "STOP" | "START" | "HELP" | ""
* - Exact match only (after normalization)
* - STOP includes carrier synonyms + STOPALL
*******************************************************/
function complianceIntent_(rawAny) {
  const s0 = String(rawAny || "");
  if (!s0) return "";

  // Normalize: trim, uppercase, remove common punctuation, collapse spaces
  // Keep behavior deterministic and "exact-only".
  const s = s0
    .trim()
    .toUpperCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width junk
    .replace(/[.,!?:;'"`(){}\[\]<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";

  // STOP-class (opt-out). Treat all as STOP.
  // Carrier common set + user list:
  // STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE
  const STOP_WORDS = {
    "STOP": 1,
    "STOPALL": 1,
    "UNSUBSCRIBE": 1,
    "CANCEL": 1,
    "END": 1,
    "QUIT": 1,
    "OPTOUT": 1,
    "OPT OUT": 1,        // allow split version
    "REVOKE": 1
  };

  if (STOP_WORDS[s]) return "STOP";

  // START-class (opt back in) — exact only
  const START_WORDS = {
    "START": 1,
    "UNSTOP": 1
  };

  if (START_WORDS[s]) return "START";

  // HELP-class — exact only
  const HELP_WORDS = {
    "HELP": 1,
    "INFO": 1
  };

  if (HELP_WORDS[s]) return "HELP";

  return "";
}

/** SMS opt-out storage tab on the main log workbook (Twilio compliance). */
var SMS_OPTOUT_SHEET_NAME = "OptOuts";

/**
 * Returns the OptOuts sheet, creating it with headers if missing.
 * Must stay in sync with setSmsOptOut_ columns: PhoneE164, OptedOut, UpdatedAt, Keyword.
 */
function getOptOutSheet_() {
  var ss = null;
  try {
    if (typeof LOG_SHEET_ID !== "undefined" && LOG_SHEET_ID) {
      ss = SpreadsheetApp.openById(LOG_SHEET_ID);
    }
  } catch (_) {}
  if (!ss) {
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (_) {}
  }
  if (!ss) {
    throw new Error("getOptOutSheet_: no spreadsheet (LOG_SHEET_ID unset and no active ss)");
  }
  var sh = ss.getSheetByName(SMS_OPTOUT_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SMS_OPTOUT_SHEET_NAME);
    sh.getRange(1, 1, 1, 4).setValues([["PhoneE164", "OptedOut", "UpdatedAt", "Keyword"]]);
  }
  return sh;
}

function isSmsOptedOut_(phoneAny) {
  const sh = getOptOutSheet_();
  const last = sh.getLastRow();
  if (last < 2) return false;

  const key = phoneKey_(phoneAny);
  if (!key) return false;

  const vals = sh.getRange(2, 1, last, 2).getValues(); // phone, optedOut (rows 2..last)
  for (let i = 0; i < vals.length; i++) {
    const rowKey = phoneKey_(vals[i][0]);
    if (rowKey === key) {
      const v = vals[i][1];
      // ✅ handle boolean TRUE/FALSE and string "TRUE"/"FALSE"
      if (v === true) return true;
      return String(v).toUpperCase() === "TRUE";
    }
  }
  return false;
}

function setSmsOptOut_(phoneAny, optedOut, keyword) {
  return withWriteLock_("OPTOUT_UPDATE", () => {
    const sh = getOptOutSheet_();
    const key = phoneKey_(phoneAny);
    if (!key) return;

    const last = sh.getLastRow();

    if (last >= 2) {
      const phones = sh.getRange(2, 1, last, 1).getValues();
      for (let i = 0; i < phones.length; i++) {
        const rowKey = phoneKey_(phones[i][0]);
        if (rowKey === key) {
          sh.getRange(i + 2, 1).setValue(key); // force canonical
          sh.getRange(i + 2, 2, 1, 3).setValues([[!!optedOut, new Date(), String(keyword || "")]]);
          return;
        }
      }
    }

    sh.appendRow([key, !!optedOut, new Date(), String(keyword || "")]);
  });
}


function tenantCancelTicketCommand_(sheet, dir, digits, phone, bodyTrim, lang, baseVars) {
  const raw = String(bodyTrim || "").trim();
  const norm = raw.toLowerCase().replace(/\s+/g, " ").trim();

  const L = String(lang || "en").toLowerCase();
  const vars = baseVars || {}; // { brandName, teamName } etc

  // Extract ticket id if present: "cancel ticket PENN-2026..." or "cancel PENN-..."
  let ticketId = "";
  const m = norm.match(/^(cancel(\s+ticket)?|cancel\s+request)\s+([a-z0-9\-]{6,})$/i);
  if (m && m[3]) ticketId = String(m[3] || "").trim();

  // Load all rows (scan from bottom for most recent)
  const data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) {
    return { ok: false, msg: tenantMsg_("CANCEL_NONE_TICKETS", L, vars) };
  }

  const headers = data[0].map(h => String(h || "").trim().toLowerCase());

  // Flexible header matching (works across your versions)
  const idxTicketId =
    headers.indexOf("ticketid") >= 0 ? headers.indexOf("ticketid") :
    headers.indexOf("ticket id") >= 0 ? headers.indexOf("ticket id") :
    headers.indexOf("ticket") >= 0 ? headers.indexOf("ticket") : -1;

  const idxPhone =
    headers.indexOf("phone") >= 0 ? headers.indexOf("phone") :
    headers.indexOf("from") >= 0 ? headers.indexOf("from") :
    headers.indexOf("tenantphone") >= 0 ? headers.indexOf("tenantphone") : -1;

  const idxStatus =
    headers.indexOf("status") >= 0 ? headers.indexOf("status") :
    headers.indexOf("ticketstatus") >= 0 ? headers.indexOf("ticketstatus") : -1;

  const idxLastUpdate =
    headers.indexOf("last_update") >= 0 ? headers.indexOf("last_update") :
    headers.indexOf("last update") >= 0 ? headers.indexOf("last update") :
    headers.indexOf("updatedat") >= 0 ? headers.indexOf("updatedat") : -1;

  if (idxPhone < 0) {
    return { ok: false, msg: tenantMsg_("CANCEL_SHEET_MISSING_PHONE", L, vars) };
  }
  if (idxStatus < 0) {
    return { ok: false, msg: tenantMsg_("CANCEL_SHEET_MISSING_STATUS", L, vars) };
  }

  const phoneKey = phoneKey_(phone || digits || "");

  // Helper: is this status cancelable?
  function isCancelableStatus_(s) {
    const v = String(s || "").toLowerCase().trim();
    if (!v) return true; // blank -> treat as open
    if (v.includes("completed") || v.includes("closed") || v.includes("done")) return false;
    if (v.includes("canceled") || v.includes("cancelled")) return false;
    return true;
  }

  // Find row to cancel
  let targetRowIndex = 0; // 1-based sheet row index
  let targetTicketId = "";

  if (ticketId && idxTicketId >= 0) {
    // Cancel specific ticket
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      const rid = String(r[idxTicketId] || "").trim();
      if (rid && rid.toLowerCase() === ticketId.toLowerCase()) {
        const rPhoneKey = phoneKey_(r[idxPhone]);
        if (rPhoneKey !== phoneKey) {
          return { ok: false, msg: tenantMsg_("CANCEL_TICKET_NOT_YOURS", L, vars) };
        }
        if (!isCancelableStatus_(r[idxStatus])) {
          return { ok: false, msg: tenantMsg_("CANCEL_TICKET_NOT_CANCELABLE", L, vars) };
        }
        targetRowIndex = i + 1; // + header row
        targetTicketId = rid;
        break;
      }
    }

    if (!targetRowIndex) {
      return {
        ok: false,
        msg: tenantMsg_("CANCEL_TICKET_NOT_FOUND", L, Object.assign({}, vars, { ticketId: ticketId }))
      };
    }
  } else {
    // Cancel most recent cancelable ticket for this phone (scan bottom-up)
    for (let i = data.length - 1; i >= 1; i--) {
      const r = data[i];
      const rPhoneKey = phoneKey_(r[idxPhone]);
      if (rPhoneKey !== phoneKey) continue;
      if (!isCancelableStatus_(r[idxStatus])) continue;

      targetRowIndex = i + 1;
      targetTicketId = (idxTicketId >= 0) ? String(r[idxTicketId] || "").trim() : "";
      break;
    }

    if (!targetRowIndex) {
      return { ok: false, msg: tenantMsg_("CANCEL_NONE_OPEN", L, vars) };
    }
  }

  // Perform cancel + optional Directory clear (ALL under lock)
  const CANCEL_STATUS = "Canceled";

  withWriteLock_("TENANT_CANCEL_TICKET", function () {
    sheet.getRange(targetRowIndex, idxStatus + 1).setValue(CANCEL_STATUS);
    if (idxLastUpdate >= 0) {
      sheet.getRange(targetRowIndex, idxLastUpdate + 1).setValue(new Date());
    }
  });
  try {
    if (dir && typeof findDirectoryRowByPhone_ === "function") {
      var dr = findDirectoryRowByPhone_(dir, phone);
      if (dr > 0) {
        dalWithLock_("TENANT_CANCEL_DIR", function () {
          dalSetPendingIssueNoLock_(dir, dr, "");
          try { logDevSms_(phone, "", "ISSUE_WRITE site=[TENANT_CANCEL_TICKET] val=[CLEAR_CANCEL]"); } catch (_) {}
          dalSetPendingUnitNoLock_(dir, dr, "");
          dalSetPendingRowNoLock_(dir, dr, "");
          dalSetPendingStageNoLock_(dir, dr, "");
          dalSetLastUpdatedNoLock_(dir, dr);
          try { logDevSms_(phone || "", "", "DAL_WRITE TENANT_CANCEL_DIR row=" + dr); } catch (_) {}
        });
      }
    }
  } catch (_) {}

  // ✅ Send cancellation receipt immediately (do NOT rely on onEdit)
  try {
    sendCancelReceiptForRow_(sheet, targetRowIndex, { mode: "SMS", lang: L, vars: vars });
  } catch (_) {}

  // Return template-based success
  if (targetTicketId) {
    return {
      ok: true,
      msg: tenantMsg_("CANCEL_SUCCESS_WITH_ID", L, Object.assign({}, vars, { ticketId: targetTicketId }))
    };
  }
  return { ok: true, msg: tenantMsg_("CANCEL_SUCCESS_NO_ID", L, vars) };
}


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (post-split restore)
// SMS opt-out bypass
// ─────────────────────────────────────────────────────────────────



  function allowOptOutBypass_(toAny, seconds) {
    const key = bypassOptOutKey_(toAny);
    CacheService.getScriptCache().put(key, "1", Math.max(1, Number(seconds || 10)));
  }




  function isOptOutBypassActive_(toAny) {
    const key = bypassOptOutKey_(toAny);
    return CacheService.getScriptCache().get(key) === "1";
  }


// ─────────────────────────────────────────────────────────────────
// RECOVERED FROM PROPERA_MAIN_BACKUP.gs (dependency wave 2)
// bypassOptOutKey_
// ─────────────────────────────────────────────────────────────────





  function bypassOptOutKey_(toAny) {
    return "BYPASS_OPTOUT_" + phoneKey_(toAny);
  }
