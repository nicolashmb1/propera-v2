/**
 * OUTGATE.gs — Propera Phase 3A Outbound Intent Layer (V1)
 * Layer 2: Brain produces outbound intents; core logic must not call sendSms_/sendWhatsApp_/sendRouterSms_ directly for migrated paths.
 * All outbound for migrated paths goes through dispatchOutboundIntent_().
 * Contract broad; implementation narrow. No second messaging stack. Templates remain the renderer for V1.
 * Phase 0: intent–template map; templateKey optional when intentType is in OG_INTENT_TEMPLATE_MAP_; templateSource logging (explicit | semantic_map | dynamic_logic).
 * Phase 7: preRenderedBody (legacy bridge only) — allowlisted intent types only; still require intentType, recipientType, recipientRef.
 * Phase 7 (split): CIG pipeline lives in this file — properaRenderReply_, properaCommunicationGate_,
 *   sanitizeConversationalReply_, properaComposeDeterministic_, resolveStatusQuery_, etc.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SEMANTIC INTENT → TEMPLATE MAP (Phase 0: foundation for intent-first outbound)
// Brain sends intentType + vars; Outgate resolves template when templateKey missing.
// If templateKey is provided, it is used (explicit). Else intentType is looked up here.
// ─────────────────────────────────────────────────────────────────────────────
var OG_INTENT_TEMPLATE_MAP_ = {
  "TICKET_CREATED_ASK_SCHEDULE": "ASK_WINDOW_SIMPLE",
  "CONFIRM_RECORDED_SCHEDULE": "CONF_WINDOW_SET",
  "ASK_FOR_MISSING_UNIT": "ASK_UNIT",
  "CONFIRM_CONTEXT_MISMATCH": "CONFIRM_CONTEXT_MISMATCH",
  "CONFIRM_CONTEXT_NEEDS_CONFIRM": "CONFIRM_CONTEXT_NEEDS_CONFIRM",
  "CONFIRM_CONTEXT_YESNO_REPROMPT": "CONFIRM_CONTEXT_YESNO_REPROMPT",
  "TICKET_CREATED_COMMON_AREA": "TICKET_CREATED_COMMON_AREA",
  "ASK_FOR_ISSUE": "ASK_ISSUE_GENERIC",
  "ASK_PROPERTY_CHOICE": "ASK_PROPERTY_MENU",
  "MULTI_CREATED_CONFIRM": "MULTI_CREATED_CONFIRM",
  "MULTI_SPLIT_TICKETS_CREATED": "MULTI_CREATED_CONFIRM",
  "SCHEDULE_DRAFT_REASK": "ASK_WINDOW_SIMPLE",
  "SCHEDULE_DRAFT_FAIL": "ASK_WINDOW_SIMPLE",
  "ERROR_TRY_AGAIN": "ERR_GENERIC_TRY_AGAIN",
  "ERROR_NO_PROPERTIES": "ERR_NO_PROPERTIES_CONFIGURED",
  "ERROR_LOST_REQUEST": "ERR_LOST_OPEN_REQUEST",
  "ERROR_CRASH_FALLBACK": "ERR_CRASH_FALLBACK",
  "ERROR_DRAFT_FINALIZE_FAILED": "ERR_DRAFT_FINALIZE_FAILED",
  "EMERGENCY_CONFIRMED": "EMERGENCY_CONFIRMED_DISPATCHED",
  "EMERGENCY_CONFIRMED_WITH_TICKET": "EMERGENCY_CONFIRMED_DISPATCHED_WITH_TID",
  "EMERGENCY_UPDATE_ACK": "EMERGENCY_UPDATE_ACK",
  "TENANT_ACK_NO_PENDING": "TENANT_ACK_NO_PENDING",
  // Keep fast-path acknowledgements intent-specific (copy lives in Templates sheet by key).
  // Phase 0: CIG No-Op Fast Lane (deterministic social templates)
  "THANKS": "THANKS",
  "ACK": "ACK",
  "GREETING": "GREETING",
  "GOODBYE": "GOODBYE",
  "FAST_ACK_SCHEDULE_REVIEW": "FAST_ACK_SCHEDULE_REVIEW",
  "FAST_ACK_CREATE_IN_PROGRESS": "FAST_ACK_CREATE_IN_PROGRESS",
  "ASK_PROPERTY_AND_UNIT_PACKAGED": "ASK_PROPERTY_MENU",
  "SHOW_HELP": "HELP_INTRO",
  "SHOW_OPTIONS": "INTENT_PICK",
  "DUPLICATE_REQUEST_ACK": "DUPLICATE_REQUEST_ACK",
  "CLEANING_WORKITEM_ACK": "CLEANING_WORKITEM_ACK",
  "VISIT_CONFIRM": "VISIT_CONFIRM_MULTI",
  "STAFF_CLARIFICATION": "STAFF_CLARIFICATION",
  "STAFF_UPDATE_ACK": "STAFF_UPDATE_ACK",
  "STAFF_SCHEDULE_ACK": "STAFF_SCHEDULE_ACK",
  "REQUEST_UNSCHEDULED_UPDATE": "STAFF_UNSCHEDULED_REMINDER",
  "STAFF_CAPTURE_TICKET_CREATED": "STAFF_CAPTURE_TICKET_CREATED",
  "STAFF_CAPTURE_DRAFT_PROGRESS": "STAFF_CAPTURE_DRAFT_PROGRESS",
  "STAFF_CAPTURE_VISION_QUEUED": "STAFF_CAPTURE_VISION_QUEUED",
  "STAFF_CAPTURE_DRAFT_STATUS": "STAFF_CAPTURE_DRAFT_STATUS",
  "STAFF_CAPTURE_ALREADY_FINAL": "STAFF_CAPTURE_ALREADY_FINAL",
  "STAFF_CAPTURE_INGEST_ERROR": "STAFF_CAPTURE_INGEST_ERROR"
};

// M8 renderer primitives (sanitizeTenantText_, shouldAppendCompliance_, shouldPrependWelcome_, renderTenantKey_) — see MESSAGING_ENGINE.gs

function ogIntentInSemanticMap_(intentType) {
  if (!intentType || typeof OG_INTENT_TEMPLATE_MAP_ !== "object") return false;
  return Object.prototype.hasOwnProperty.call(OG_INTENT_TEMPLATE_MAP_, String(intentType).trim());
}

/**
 * Resolve template key from intent. Phase 0: explicit templateKey wins; else semantic map.
 * @param {Object} intent - intentType, templateKey, vars (for future dynamic_logic)
 * @returns {{ templateKey: string, templateSource: string }} templateSource: "explicit" | "semantic_map" | "dynamic_logic"
 */
function ogResolveTemplateKey_(intent) {
  var out = { templateKey: "", templateSource: "" };
  if (!intent || typeof intent !== "object") return out;
  var explicit = String(intent.templateKey || "").trim();
  if (explicit) {
    out.templateKey = explicit;
    out.templateSource = "explicit";
    return out;
  }
  var it = String(intent.intentType || "").trim();
  if (ogIntentInSemanticMap_(it)) {
    var vars = (intent.vars && typeof intent.vars === "object") ? intent.vars : {};
    // Phase 1: CONFIRM_RECORDED_SCHEDULE — upstream may pass vars.confirmKey (legacy bridge) for tone variant
    if (it === "CONFIRM_RECORDED_SCHEDULE") {
      var confirmKey = String(vars.confirmKey || "").trim();
      if (confirmKey) {
        out.templateKey = confirmKey;
        out.templateSource = "dynamic_logic";
        return out;
      }
    }
    // Phase 2a/2b: TICKET_CREATED_ASK_SCHEDULE — afterCreate, dayLine, dayWord, or default
    if (it === "TICKET_CREATED_ASK_SCHEDULE") {
      if (vars.afterCreate) {
        out.templateKey = "ASK_WINDOW_AFTER_CREATE";
        out.templateSource = "dynamic_logic";
        return out;
      }
      var dayLine = (vars.dayLine != null && String(vars.dayLine).trim() !== "") ? String(vars.dayLine).trim() : "";
      var dayWord = (vars.dayWord != null && String(vars.dayWord).trim() !== "") ? String(vars.dayWord).trim() : "";
      var deliveryPolicy = String(intent.deliveryPolicy || "DIRECT_SEND").trim();
      if (dayLine) {
        out.templateKey = (deliveryPolicy === "NO_HEADER") ? "ASK_WINDOW_SIMPLE" : "ASK_WINDOW";
        out.templateSource = "dynamic_logic";
        return out;
      }
      if (dayWord) {
        out.templateKey = (deliveryPolicy === "NO_HEADER") ? "ASK_WINDOW_SIMPLE_WITH_DAYHINT" : "ASK_WINDOW_WITH_DAYHINT";
        out.templateSource = "dynamic_logic";
        return out;
      }
      out.templateKey = (deliveryPolicy === "NO_HEADER") ? "ASK_WINDOW_SIMPLE" : "ASK_WINDOW";
      out.templateSource = "semantic_map";
      return out;
    }
    // Phase 6: SCHEDULE_DRAFT_REASK / SCHEDULE_DRAFT_FAIL — if vars.accessNotes present, use CONFIRM_WINDOW_FROM_NOTE
    if (it === "SCHEDULE_DRAFT_REASK" || it === "SCHEDULE_DRAFT_FAIL") {
      var accessNotes = (vars.accessNotes != null && String(vars.accessNotes).trim() !== "") ? String(vars.accessNotes).trim() : "";
      if (accessNotes) {
        out.templateKey = "CONFIRM_WINDOW_FROM_NOTE";
        out.templateSource = "dynamic_logic";
        return out;
      }
    }
    // Phase 3: ASK_FOR_MISSING_UNIT — if vars.propertyName or propertyCode present, use ASK_UNIT_GOT_PROPERTY
    if (it === "ASK_FOR_MISSING_UNIT") {
      var propName = (vars.propertyName != null && String(vars.propertyName).trim() !== "") ? String(vars.propertyName).trim() : "";
      var propCode = (vars.propertyCode != null && String(vars.propertyCode).trim() !== "") ? String(vars.propertyCode).trim() : "";
      if (propName || propCode) {
        out.templateKey = "ASK_UNIT_GOT_PROPERTY";
        out.templateSource = "dynamic_logic";
        return out;
      }
      out.templateKey = "ASK_UNIT";
      out.templateSource = "semantic_map";
      return out;
    }      
    out.templateKey = OG_INTENT_TEMPLATE_MAP_[it];
    out.templateSource = "semantic_map";
    return out;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-RENDERED BODY — Phase 7 legacy bridge (allowlist only). Phase 6: migrated intents removed; no callers use preRenderedBody for them.
// ─────────────────────────────────────────────────────────────────────────────
var OG_PRE_RENDERED_ALLOWLIST_ = ["CORE_TEXT_REPLY", "CORE_TEXT_REPLY_NO_HEADER", "CORE_TEXT_REPLY_TO", "CORE_TEXT_FASTPATH", "CONVERSATIONAL_REPLY", "STATUS_REPLY", "SAFE_CLARIFY"];

function ogPreRenderedAllowlisted_(intentType) {
  if (!intentType || typeof OG_PRE_RENDERED_ALLOWLIST_ !== "object") return false;
  return OG_PRE_RENDERED_ALLOWLIST_.indexOf(String(intentType).trim()) >= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable channel + Telegram reply-target resolution helpers (bridge-hardening)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide outbound channel from durable context first.
 *
 * Priority:
 * 1) explicit intent.channel
 * 2) persisted ctx.preferredChannel
 * 3) safe default fallbackChannel
 *
 * Note: preferredChannel is durable reply-channel memory (not transport detail).
 */
function resolvePreferredOutboundChannel_(ctx, intent, fallbackChannel) {
  var explicit = intent && intent.channel != null ? String(intent.channel || "").trim().toUpperCase() : "";
  if (explicit === "WA" || explicit === "TELEGRAM" || explicit === "SMS") return explicit;

  var pref = ctx && ctx.preferredChannel != null ? String(ctx.preferredChannel || "").trim().toUpperCase() : "";
  if (pref === "WA" || pref === "SMS") return pref;
  if (pref === "TELEGRAM") {
    // Backward/compat: only route to TELEGRAM when a chat target exists somewhere.
    var tgFromCtx = ctx && ctx.telegramChatId != null ? String(ctx.telegramChatId || "").trim() : "";
    if (tgFromCtx) return "TELEGRAM";
  }

  var def = String(fallbackChannel || "SMS").trim().toUpperCase();
  if (def !== "WA" && def !== "TELEGRAM" && def !== "SMS") def = "SMS";
  return def;
}

/**
 * Resolve Telegram reply target (chat id) from durable context.
 *
 * Priority:
 * 1) explicit intent.telegramChatId
 * 2) persisted ctx.telegramChatId
 * 3) fallbackChatId
 *
 * Fail-closed: when empty, TELEGRAM delivery should not proceed.
 */
function resolveTelegramReplyTarget_(ctx, intent, fallbackChatId) {
  var explicit = intent && intent.telegramChatId != null ? String(intent.telegramChatId || "").trim() : "";
  if (explicit) return explicit;

  var fromCtx = ctx && ctx.telegramChatId != null ? String(ctx.telegramChatId || "").trim() : "";
  if (fromCtx) return fromCtx;

  return String(fallbackChatId || "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH — Single entry for outbound intents (migrated paths)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate intent, resolve recipient, resolve language, render message, deliver via sendRouterSms_.
 * Fails safely; never throws uncontrolled into production flows.
 * V1 intent: intentType, templateKey (optional when intentType in semantic map), recipientType, recipientRef, vars?, channel?, deliveryPolicy?, lang?, meta?
 * Channel defaulting: TENANT may inherit PreferredChannel + TelegramChatId from ConversationContext; STAFF with TelegramID only (no PhoneE164) defaults to TELEGRAM.
 * @param {Object} intent - Outbound intent per V1 schema
 * @returns {Object} { ok, recipientType?, recipientPhone?, lang?, intentType?, templateKey?, templateSource?, channel?, deliveryPolicy?, error? }
 */
function dispatchOutboundIntent_(intent) {
  var out = { ok: false, recipientType: "", recipientPhone: "", lang: "", intentType: "", templateKey: "", templateSource: "", channel: "", deliveryPolicy: "", error: "" };
  if (!intent || typeof intent !== "object") {
    out.error = "intent missing or invalid";
    if (typeof dbg_ === "function") try { dbg_("OUTGATE_INTENT_BAD", { error: out.error }); } catch (_) {}
    return out;
  }
  var intentType = String(intent.intentType || "").trim();
  var templateKey = String(intent.templateKey || "").trim();
  var recipientType = String(intent.recipientType || "").trim().toUpperCase();
  var recipientRef = intent.recipientRef != null ? String(intent.recipientRef).trim() : "";
  var usePreRendered = !!(intent.preRenderedBody != null && String(intent.preRenderedBody).trim() && (typeof ogPreRenderedAllowlisted_ === "function") && ogPreRenderedAllowlisted_(intentType));
  if (usePreRendered) templateKey = templateKey || intentType;
  if (!intentType || !recipientType || !recipientRef) {
    out.error = "intent missing required field (intentType, recipientType, recipientRef)";
    out.intentType = intentType || "";
    out.templateKey = templateKey || "";
    if (typeof dbg_ === "function") try { dbg_("OUTGATE_INTENT_BAD", { error: out.error }); } catch (_) {}
    return out;
  }
  if (!usePreRendered && !templateKey && !(typeof ogIntentInSemanticMap_ === "function" && ogIntentInSemanticMap_(intentType))) {
    out.error = "intent missing templateKey (required when not using allowlisted preRenderedBody or semantic intent in map)";
    out.intentType = intentType;
    if (typeof dbg_ === "function") try { dbg_("OUTGATE_INTENT_BAD", { error: out.error }); } catch (_) {}
    return out;
  }
  if (recipientType !== "TENANT" && recipientType !== "STAFF") {
    out.error = "recipientType must be TENANT or STAFF";
    out.recipientType = recipientType;
    if (typeof dbg_ === "function") try { dbg_("OUTGATE_INTENT_BAD", { error: out.error }); } catch (_) {}
    return out;
  }
  out.intentType = intentType;
  out.templateKey = templateKey;

  // Phase 7 bridge: when the renderer knows how to express a tenant intent,
  // route through the single reply renderer instead of maintaining a second text path.
  if (
    recipientType === "TENANT" &&
    !usePreRendered &&
    typeof cigRendererEnabled_ === "function" &&
    cigRendererEnabled_() &&
    typeof properaIntentToReplyEnvelope_ === "function" &&
    typeof properaRenderReply_ === "function"
  ) {
    try {
      var replyEnvelope = properaIntentToReplyEnvelope_(intent);
      if (replyEnvelope) {
        var renderRes = properaRenderReply_(
          replyEnvelope,
          replyEnvelope.replyLang || intent.lang || "en",
          replyEnvelope.channel || intent.channel || "SMS",
          replyEnvelope.recipientRef || recipientRef
        );
        if (renderRes && renderRes.ok) {
          out.ok = true;
          out.recipientType = recipientType;
          out.recipientPhone = recipientRef;
          out.lang = String(replyEnvelope.replyLang || intent.lang || "en").trim();
          out.channel = String(replyEnvelope.channel || intent.channel || "SMS").trim().toUpperCase();
          out.deliveryPolicy = String(intent.deliveryPolicy || "NO_HEADER").trim();
          out.templateSource = "cig_renderer";
          return out;
        }
      }
    } catch (_) {}
  }

  var ctxPin = null;
  // Channel: explicit intent.channel wins, else resolve via durable ConversationContext (TENANT).
  var channel = resolvePreferredOutboundChannel_(
    (recipientType === "TENANT" && typeof ctxGet_ === "function") ? ctxGet_(recipientRef) : null,
    intent,
    "SMS"
  );

  // STAFF channel behavior stays special-cased to staff contact identity.
  if (recipientType === "STAFF") {
    channel = String(intent.channel || "").trim().toUpperCase();
    if (!channel && typeof srLoadStaffContact_ === "function") {
      var sc0 = srLoadStaffContact_(recipientRef);
      if (!sc0 && typeof srResolveStaffOutboundFromActorRef_ === "function") {
        sc0 = srResolveStaffOutboundFromActorRef_(recipientRef);
      }
      if (sc0) {
        var prefCh = String(sc0.preferredChannel || "").trim().toUpperCase();
        if (prefCh === "TELEGRAM" || prefCh === "WA" || prefCh === "SMS") {
          channel = prefCh;
        } else if (String(sc0.telegramChatId || "").trim() && !String(sc0.phoneE164 || "").trim()) {
          channel = "TELEGRAM";
        }
      }
    }
  }

  if (recipientType === "TENANT" && channel === "TELEGRAM" && typeof ctxGet_ === "function") {
    ctxPin = ctxGet_(recipientRef);
    var tidResolved = resolveTelegramReplyTarget_(ctxPin, intent, "");
    intent.telegramChatId = String(tidResolved || "").trim();
  }

  if (channel !== "WA" && channel !== "TELEGRAM") channel = "SMS";
  out.channel = channel;
  out.deliveryPolicy = String(intent.deliveryPolicy || "DIRECT_SEND").trim();
  if (out.deliveryPolicy !== "NO_HEADER") out.deliveryPolicy = "DIRECT_SEND";
  // Ensure render and delivery use the same resolved channel and policy
  intent.channel = channel;
  intent.deliveryPolicy = out.deliveryPolicy;

  var recipient = ogResolveRecipient_(intent);
  if (!recipient || !recipient.ok || !recipient.phoneE164) {
    out.error = recipient && recipient.error ? recipient.error : "recipient resolve failed";
    out.recipientType = recipientType;
    if (typeof dbg_ === "function") try { dbg_("OUTGATE_RECIPIENT_FAIL", { intentType: intentType, error: out.error }); } catch (_) {}
    return out;
  }
  if (recipientType === "TENANT" && intent.meta && intent.meta.outboundTargetExplicit && typeof logDevSms_ === "function") {
    try {
      logDevSms_(
        String(recipient.phoneE164 || ""),
        "",
        "OUTBOUND_TARGET_RESOLVED explicit=1 channel=[" + String(out.channel || "") + "] tgChat=" + (recipient.telegramChatId ? "1" : "0")
      );
    } catch (_) {}
  }
  out.recipientType = recipientType;
  out.recipientPhone = recipient.phoneE164;
  var lang = ogResolveLang_(intent, recipient);
  out.lang = lang;

  // Phase 0: resolve template from intent (explicit templateKey or semantic map)
  var resolved = (typeof ogResolveTemplateKey_ === "function") ? ogResolveTemplateKey_(intent) : { templateKey: templateKey, templateSource: "explicit" };
  if (!String(intent.templateKey || "").trim()) intent.templateKey = resolved.templateKey;
  out.templateKey = String(intent.templateKey || "").trim();
  out.templateSource = String(resolved.templateSource || "explicit").trim();

  var message = ogRenderIntent_(intent, lang);
  if (!message || !String(message).trim()) {
    out.error = "render returned empty or missing";
    if (typeof dbg_ === "function") try { dbg_("OUTGATE_RENDER_FAIL", { intentType: intentType, templateKey: out.templateKey }); } catch (_) {}
    return out;
  }
  // Outbound proof logging: exactly-one correlation by adapter/brain trace id.
  try {
    var eid = (typeof globalThis !== "undefined" && globalThis.__properaTurnEid) ? String(globalThis.__properaTurnEid) : "";
    var meta = (intent.meta && typeof intent.meta === "object") ? intent.meta : {};
    var metaSource = meta.source != null ? String(meta.source) : "";
    var metaStage = meta.stage != null ? String(meta.stage) : "";
    var metaFlow = meta.flow != null ? String(meta.flow) : "";
    if (typeof logDevSms_ === "function") {
      try {
        logDevSms_(
          String(out.recipientPhone || ""),
          "",
          "OUTBOUND_INTENT_EMIT eid=[" + eid + "] intentType=[" + String(intentType || "") + "] source=[" + String(metaSource || "dispatchOutboundIntent_") + "] stage=[" + String(metaStage || "") + "] flow=[" + String(metaFlow || "") + "] channel=[" + String(out.channel || "") + "] deliveryPolicy=[" + String(out.deliveryPolicy || "") + "] templateKey=[" + String(out.templateKey || "") + "] templateSource=[" + String(out.templateSource || "") + "]"
        );
      } catch (_) {}
    }
  } catch (_) {}
  ogDeliver_(intent, recipient, message);
  out.ok = true;
  if (typeof dbg_ === "function") {
    try {
      dbg_("OUTGATE_DISPATCH_OK", {
        intentType: out.intentType,
        resolvedTemplateKey: out.templateKey,
        templateSource: out.templateSource,
        channel: out.channel,
        deliveryPolicy: out.deliveryPolicy,
        recipientType: out.recipientType,
        lang: out.lang
      });
    } catch (_) {}
  }
  // Log templateSource to same stream as OUT_SMS (logDevSms_) so you can confirm semantic vs explicit
  if (typeof logDevSms_ === "function") {
    try {
      logDevSms_("", "", "OUTGATE_TEMPLATE_SOURCE intentType=[" + out.intentType + "] resolvedTemplateKey=[" + out.templateKey + "] templateSource=[" + out.templateSource + "]");
    } catch (_) {}
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE RECIPIENT — TENANT (phone) or STAFF (staffId)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve recipient to phone and optional lang. TENANT: recipientRef = phone (or TG:userId). STAFF: recipientRef = staffId.
 * When channel is TELEGRAM, TENANT uses telegramChatId resolved from durable ctx (with global bridge fallback).
 * @param {Object} intent - Must have recipientType, recipientRef; channel, telegramChatId optional
 * @returns {Object} { ok: true, phoneE164, lang?, telegramChatId? } or { ok: false, error }
 */
function ogResolveRecipient_(intent) {
  if (!intent) return { ok: false, error: "intent missing" };
  var recipientType = String(intent.recipientType || "").trim().toUpperCase();
  var ref = intent.recipientRef != null ? String(intent.recipientRef).trim() : "";
  if (!ref) return { ok: false, error: "recipientRef empty" };
  var ch = String(intent.channel || "").trim().toUpperCase();
  if (recipientType === "TENANT") {
    // Telegram: use telegramChatId for delivery resolved from durable ctx (with global bridge fallback).
    if (ch === "TELEGRAM") {
      var ctx = typeof ctxGet_ === "function" ? ctxGet_(ref) : null;
      var telegramChatId = (typeof resolveTelegramReplyTarget_ === "function")
        ? resolveTelegramReplyTarget_(ctx, intent, "")
        : String(intent.telegramChatId || "").trim();
      if (!telegramChatId) return { ok: false, error: "telegramChatId missing for TELEGRAM channel" };
      var lang = (ctx && ctx.lang) ? String(ctx.lang).trim().toLowerCase() : "en";
      return { ok: true, phoneE164: ref, lang: lang || "en", telegramChatId: telegramChatId };
    }
    var phone = typeof phoneKey_ === "function" ? phoneKey_(ref) : ref;
    if (!phone || !String(phone).trim()) return { ok: false, error: "tenant phone normalize failed" };
    var ctx = typeof ctxGet_ === "function" ? ctxGet_(ref) : null;
    var lang = (ctx && ctx.lang) ? String(ctx.lang).trim().toLowerCase() : "";
    return { ok: true, phoneE164: String(phone).trim(), lang: lang || "en" };
  }
  if (recipientType === "STAFF") {
    if (typeof srLoadStaffContact_ !== "function") return { ok: false, error: "srLoadStaffContact_ not available" };
    var contact = srLoadStaffContact_(ref);
    if (!contact && typeof srResolveStaffOutboundFromActorRef_ === "function") {
      contact = srResolveStaffOutboundFromActorRef_(ref);
    }
    if (!contact) return { ok: false, error: "staff contact not found" };
    var staffPhone = (contact.phoneE164 && String(contact.phoneE164).trim()) ? String(contact.phoneE164).trim() : "";
    var staffLang = (contact.lang && String(contact.lang).trim()) ? String(contact.lang).trim().toLowerCase() : "en";
    var staffTg = (contact.telegramChatId && String(contact.telegramChatId).trim()) ? String(contact.telegramChatId).trim() : "";
    if (ch === "TELEGRAM") {
      var intentTg = intent.telegramChatId != null ? String(intent.telegramChatId).trim() : "";
      var tid = intentTg || staffTg;
      if (!tid && staffPhone && /^TG:/i.test(staffPhone)) {
        tid = String(staffPhone.replace(/^TG:\s*/i, "").replace(/\D/g, "") || "").trim();
      }
      if (!tid) return { ok: false, error: "staff telegramChatId empty" };
      return { ok: true, phoneE164: staffPhone || ("STAFF:" + ref), lang: staffLang || "en", telegramChatId: tid };
    }
    if (!staffPhone) return { ok: false, error: "staff phone empty" };
    return { ok: true, phoneE164: staffPhone, lang: staffLang || "en" };
  }
  return { ok: false, error: "recipientType must be TENANT or STAFF" };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE LANGUAGE — recipient.lang or "en"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve language for rendering. Priority: intent.lang → recipient.lang → "en".
 * @param {Object} intent - May have lang override
 * @param {Object} recipient - { lang?: string }
 * @returns {string}
 */
function ogResolveLang_(intent, recipient) {
  if (intent && intent.lang && String(intent.lang).trim()) return String(intent.lang).trim().toLowerCase();
  if (recipient && recipient.lang && String(recipient.lang).trim()) return String(recipient.lang).trim().toLowerCase();
  return "en";
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — V1: templateKey + lang + vars via renderTenantKey_
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build staff clarification message from suggested reply options (Phase 4).
 * Resolver passes vars.options or vars.suggestedPrompts (e.g. ["403 sink done", "403 refrigerator done"]).
 * Dedupes options so duplicate prompts (e.g. two "403 done") don't produce "Reply with: '403 done' or '403 done'".
 * @param {string[]} options - Suggested reply prompts
 * @param {string} lang - Language code (reserved for future i18n)
 * @returns {string} Short operational message, e.g. "Which one? Reply with: '403 sink done' or '403 refrigerator done'."
 */
function ogBuildStaffClarificationMessage_(options, lang) {
  if (!Array.isArray(options) || options.length === 0) return "";
  var list = [];
  var seen = {};
  for (var i = 0; i < options.length; i++) {
    var o = String(options[i] || "").trim();
    if (!o) continue;
    var key = o.toLowerCase();
    if (seen[key]) continue;
    seen[key] = 1;
    list.push("'" + o + "'");
  }
  if (list.length === 0) return "";
  var intro = "Which one? Reply with: ";
  if (list.length === 1) return "Reply with: " + list[0] + " to confirm.";
  var last = list.pop();
  return intro + list.join(", ") + " or " + last + ".";
}

/**
 * Render intent to message body. V1: templateKey + vars; channel- and deliveryPolicy-aware.
 * Phase 7: If intent.preRenderedBody is set and intentType is allowlisted, return trimmed preRenderedBody (legacy bridge; no footer).
 * SMS: template + (welcome if deliveryPolicy !== "NO_HEADER" and key allowlisted) + compliance footer per allowlist.
 * WA: same template body, no compliance footer; welcome only if deliveryPolicy !== "NO_HEADER".
 * @param {Object} intent - Must have templateKey (or preRenderedBody when allowlisted); vars, channel, deliveryPolicy optional
 * @param {string} lang - Language code
 * @returns {string} Rendered message or empty on failure
 */
function ogRenderIntent_(intent, lang) {
  if (!intent || typeof intent !== "object") return "";
  var intentType = String(intent.intentType || "").trim();
  var vars = (intent.vars && typeof intent.vars === "object") ? intent.vars : {};
  // Phase 4: STAFF_CLARIFICATION — outcome-aware: transition rejected vs multi-candidate options vs generic
  if (intentType === "STAFF_CLARIFICATION") {
    if (vars.transitionRejected || String(vars.reasonCode || "").trim().toUpperCase() === "REJECTED") {
      return "I found the item, but it cannot be marked done from its current state.";
    }
    var options = vars.options || vars.suggestedPrompts;
    if (Array.isArray(options) && options.length > 0) {
      var built = ogBuildStaffClarificationMessage_(options, lang || "en");
      if (built && String(built).trim()) return String(built).trim();
    }
  }
  // Staff scheduling confirmations are status-aware; keep deterministic messaging here
  // so resolver/lifecycle can pass bounded status without requiring new template keys.
  if (intentType === "STAFF_SCHEDULE_ACK") {
    var schedLabel = String(vars.scheduleLabel || "").trim();
    var schedStatus = String(vars.scheduleStatus || "SET").trim().toUpperCase();
    if (schedStatus === "ALREADY_SET") {
      return schedLabel ? ("Already scheduled for " + schedLabel + ".") : "Already scheduled for that time window.";
    }
    if (schedStatus === "UPDATED") {
      return schedLabel ? ("Schedule updated to " + schedLabel + ".") : "Schedule updated.";
    }
    return schedLabel ? ("Scheduled for " + schedLabel + ".") : "Schedule set.";
  }
  // ASK_FOR_MISSING_UNIT — askAttempt ladder
  if (intentType === "ASK_FOR_MISSING_UNIT") {
    var uAttempt = Number(vars.askAttempt) || 1;
    var uPropName = String(vars.propertyName || vars.propertyCode || "").trim();
    var uIssueBrief = String(vars.issueSummary || vars.issue || "").trim();
    if (uAttempt >= 3) return "Reply with just the unit number, for example: 205.";
    if (uAttempt === 2) return "I still need your unit number to place the request.";
    if (uPropName && uIssueBrief) return uPropName + " — what unit are you in?";
    if (uPropName) return uPropName + " — what's your unit number?";
    return "What's your unit number?";
  }

  // ASK_FOR_ISSUE — askAttempt ladder
  if (intentType === "ASK_FOR_ISSUE") {
    var iAttempt = Number(vars.askAttempt) || 1;
    var iPropName = String(vars.propertyName || vars.propertyCode || "").trim();
    var iUnit = String(vars.unit || "").trim();
    var iSlotLine = (iPropName && iUnit) ? (iPropName + ", unit " + iUnit) : (iPropName || (iUnit ? ("Unit " + iUnit) : ""));
    if (iAttempt >= 3) return "Reply with the problem only, for example: sink leak.";
    if (iAttempt === 2) return "I still need a short description of the problem.";
    if (iSlotLine) return iSlotLine + " — what issue are you having?";
    return "What issue are you having?";
  }

  // TICKET_CREATED_ASK_SCHEDULE — askAttempt ladder
  if (intentType === "TICKET_CREATED_ASK_SCHEDULE") {
    if (vars.summaryText != null && String(vars.summaryText).trim() !== "") return String(vars.summaryText).trim();
    if (vars.managerIntro != null && String(vars.managerIntro).trim() !== "") return String(vars.managerIntro).trim();
    var sAttempt = Number(vars.askAttempt) || 1;
    var sIssueBrief = String(vars.issueSummary || vars.issue || "").trim();
    var sPropName = String(vars.propertyName || vars.propertyCode || "").trim();
    var sUnit = String(vars.unit || "").trim();
    if (sAttempt >= 3) return "Reply with a day/time only, for example: tomorrow after 3 PM.";
    if (sAttempt === 2) return "I still need a time window for the visit. What day or time works best?";
    if (sIssueBrief) {
      var sCtx = sIssueBrief;
      if (sPropName && sUnit) sCtx = sPropName + " " + sUnit + " — " + sIssueBrief;
      else if (sPropName) sCtx = sPropName + " — " + sIssueBrief;
      return sCtx + ". When is a good time for us to come by?";
    }
    return "When is a good time for us to come by?";
  }

  // CONFIRM_RECORDED_SCHEDULE — prove understanding with issue
  if (intentType === "CONFIRM_RECORDED_SCHEDULE") {
    var cLabel = String(vars.scheduleLabel || vars.label || vars.when || vars.window || "").trim();
    var cIssue = String(vars.issueSummary || vars.issue || "").trim();
    var cConfirmKey = String(vars.confirmKey || "").trim();
    if (cConfirmKey && typeof renderTenantKey_ === "function") {
      try {
        var cCustom = renderTenantKey_(cConfirmKey, lang || "en", vars, { channel: String(intent.channel || "SMS").trim().toUpperCase(), deliveryPolicy: String(intent.deliveryPolicy || "NO_HEADER").trim() });
        if (cCustom && String(cCustom).trim()) return String(cCustom).trim();
      } catch (_) {}
    }
    if (cIssue && cLabel) return "Your " + cIssue + " is set for " + cLabel + ". We'll be in touch.";
    if (cLabel) return "Your request is set for " + cLabel + ". We'll be in touch.";
    if (cIssue) return "Your " + cIssue + " request has been recorded. We'll be in touch.";
    return "Your request has been recorded. We'll be in touch.";
  }

  // Fast-lane acknowledgments and packaged asks
  if (intentType === "ASK_PROPERTY_AND_UNIT_PACKAGED") {
    var pci = parseInt(String(vars.packagedIssueCount != null ? vars.packagedIssueCount : "1"), 10);
    if (!isFinite(pci) || pci < 1) pci = 1;
    var pairLine = String(vars.packagedIssuePairLine || "").trim();
    var issueHintRaw = String(vars.issueHint || "").trim();
    var issueHint = issueHintRaw;
    try {
      issueHint = issueHintRaw
        .replace(/\s+/g, " ")
        .replace(/^[,.\-:; ]+|[,.\-:; ]+$/g, "")
        .replace(/^(hey|hi|hello)\b[\s,]*/i, "")
        .replace(/\b(i\s*)?(need|want)\s+(service|maintenance)\b[:\s,.-]*/i, "")
        .replace(/^(it'?s|its)\s+/i, "")
        .replace(/^[,.\-:; ]+|[,.\-:; ]+$/g, "");
      if (issueHint.indexOf(".") >= 0) {
        var parts = issueHint.split(".");
        var tail = String(parts[parts.length - 1] || "").trim();
        if (tail) issueHint = tail;
      }
      if (!issueHint) issueHint = issueHintRaw;
    } catch (_) {
      issueHint = issueHintRaw;
    }
    var pkgAskAttempt = Number(vars.askAttempt) || 1;
    if (pkgAskAttempt >= 3) return "Reply with your property name and unit number, for example: Penn 205.";
    if (pkgAskAttempt === 2) return "I need your building name and unit number to place this request — for example: Penn 205.";
    if (pci >= 2) {
      if (pairLine) return pairLine + " — what is your property and unit number?";
      return "I noted multiple maintenance issues. What is your property and unit number?";
    }
    if (issueHint) return issueHint.charAt(0).toUpperCase() + issueHint.slice(1) + " — what is your property and unit number?";
    return "What is your property and unit number?";
  }

  // Deterministic no-op conversational templates
  if (intentType === "THANKS") return "You're welcome! We're here if you need anything.";
  if (intentType === "ACK") return "We're here if you need anything else.";
  if (intentType === "GREETING") return "Hi there! How can we help?";
  if (intentType === "GOODBYE") return "Have a great day!";

  if (intent.preRenderedBody != null && String(intent.preRenderedBody).trim() && (typeof ogPreRenderedAllowlisted_ === "function") && ogPreRenderedAllowlisted_(intentType)) {
    return String(intent.preRenderedBody).trim();
  }
  var templateKey = String(intent.templateKey || "").trim();
  if (!templateKey) return "";
  if (typeof renderTenantKey_ !== "function") return "";
  var channel = String(intent.channel || "SMS").trim().toUpperCase();
  // TELEGRAM and WA: no SMS compliance footer
  if (channel !== "WA" && channel !== "TELEGRAM") channel = "SMS";
  var deliveryPolicy = String(intent.deliveryPolicy || "DIRECT_SEND").trim();
  if (deliveryPolicy !== "NO_HEADER") deliveryPolicy = "DIRECT_SEND";
  try {
    var msg = renderTenantKey_(templateKey, lang || "en", vars, { channel: channel, deliveryPolicy: deliveryPolicy });
    return (msg != null && String(msg).trim()) ? String(msg).trim() : "";
  } catch (e) {
    if (typeof dbg_ === "function") try { dbg_("OUTGATE_RENDER_ERR", { templateKey: templateKey, err: String(e && e.message ? e.message : e) }); } catch (_) {}
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVER — V1: sendRouterSms_(phone, message, intentType as tag)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deliver rendered message. Channel: intent.channel → default SMS.
 * TELEGRAM: send via sendTelegramMessage_(telegramChatId, message); otherwise SMS/WA via sendRouterSms_.
 * @param {Object} intent - intentType as tag; channel for delivery
 * @param {Object} recipient - { phoneE164: string, telegramChatId?: string }
 * @param {string} message - Rendered body
 */
function ogDeliver_(intent, recipient, message) {
  if (!recipient || !message) return;
  var tag = (intent && intent.intentType) ? String(intent.intentType).trim() : "";
  var ch = (intent && intent.channel && String(intent.channel).trim()) ? String(intent.channel).trim().toUpperCase() : "";
  if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";
  if (ch === "TELEGRAM" && recipient.telegramChatId) {
    if (typeof sendTelegramMessage_ === "function") sendTelegramMessage_(recipient.telegramChatId, message, tag || "OUTGATE");
    return;
  }
  if (!recipient.phoneE164) return;
  if (typeof sendRouterSms_ !== "function") return;
  sendRouterSms_(recipient.phoneE164, message, tag || "OUTGATE", ch, { fromOutgate: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// ALEXA REPLY BUILDER — content only, no delivery (Compass: outbound via Outgate)
// Used by ALEXA_ADAPTER.gs to get user-facing speech from canonical outbound layer.
// Template keys (Templates sheet): ALEXA_TICKET_CREATED, ALEXA_NO_MAINTENANCE,
// ALEXA_DEVICE_NOT_LINKED, ALEXA_PROCESSED, ALEXA_ERROR, ALEXA_LAUNCH.
// Fallbacks below used only when template missing or render returns empty.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build Alexa reply content from pipeline/context. No SMS/WA send; adapter wraps result in Alexa JSON.
 * @param {Object} ctx - { channel: "ALEXA", phone?, propertyCode?, unitId?, lang?, rawText?, turnFacts?, finalizeResult?, nextMissing?, deviceNotLinked?, error? }
 * @returns {{ text: string, shouldEndSession: boolean }}
 */
function outgateBuildAlexaReply_(ctx) {
  var out = { text: "", shouldEndSession: true };
  if (!ctx || typeof ctx !== "object") {
    out.text = "Propera could not process the request.";
    return out;
  }
  var lang = String(ctx.lang || "en").trim().toLowerCase();
  var vars = (ctx.vars && typeof ctx.vars === "object") ? ctx.vars : {};
  if (ctx.ticketId) vars.ticketId = String(ctx.ticketId);
  var t;

  // Device not linked — prefer template ALEXA_DEVICE_NOT_LINKED
  if (ctx.deviceNotLinked === true) {
    t = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ALEXA_DEVICE_NOT_LINKED", lang, vars) : "";
    out.text = (t && String(t).trim()) ? String(t).trim() : "This Alexa device is not linked to a Propera account.";
    return out;
  }

  // Error/crash fallback
  if (ctx.error === true) {
    t = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ALEXA_ERROR", lang, vars) : "";
    out.text = (t && String(t).trim()) ? String(t).trim() : "Propera could not process the request.";
    return out;
  }

  // Launch / empty — optional template ALEXA_LAUNCH
  if (ctx.launch === true) {
    t = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ALEXA_LAUNCH", lang, vars) : "";
    out.text = (t && String(t).trim()) ? String(t).trim() : "What can I help you with? You can report a maintenance issue or reserve an amenity.";
    out.shouldEndSession = false;
    return out;
  }

  // Ticket created
  if (ctx.finalizeResult && ctx.finalizeResult.ok === true) {
    vars.ticketId = ctx.finalizeResult.ticketId || "";
    t = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ALEXA_TICKET_CREATED", lang, vars) : "";
    out.text = (t && String(t).trim()) ? String(t).trim() : "Propera created the maintenance ticket.";
    return out;
  }

  // No maintenance detected / not READY
  if (ctx.nextMissing && String(ctx.nextMissing).toUpperCase() !== "READY") {
    t = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ALEXA_NO_MAINTENANCE", lang, vars) : "";
    out.text = (t && String(t).trim()) ? String(t).trim() : "I did not detect a maintenance request.";
    return out;
  }

  // Generic processed (Outgate-empty fallback)
  t = (typeof renderTenantKey_ === "function") ? renderTenantKey_("ALEXA_PROCESSED", lang, vars) : "";
  out.text = (t && String(t).trim()) ? String(t).trim() : "Propera processed the request.";
  return out;
}

/**
 * Core outbound/reply helper factory used by handleInboundCore_.
 * Consolidated into OUTGATE owner module to reduce file sprawl.
 */
function buildCoreReplyFns_(opts) {
  opts = opts || {};
  var e = opts.e || {};
  var channel = String(opts.channel || "SMS");
  var lang = String(opts.lang || "en");
  var effectiveStage = String(opts.effectiveStage || "");
  var phone = String(opts.phone || "");
  var safeTrunc = opts.safeTrunc;

  var replied = false;

  function tenantReplyChannelThisTurn_() {
    var ch = String(channel || "SMS").trim().toUpperCase();
    try {
      if (typeof getResolvedInboundChannel_ === "function" && e) {
        var r = String(getResolvedInboundChannel_(e) || "").trim().toUpperCase();
        if (r === "WA" || r === "SMS" || r === "TELEGRAM") ch = r;
      }
    } catch (_) {}
    if (ch !== "WA" && ch !== "TELEGRAM") ch = "SMS";
    return ch;
  }

  function dispatchOperationalText_(recipientType, recipientRef, text, policy, intentType) {
    try {
      var msg = String(text || "").trim();
      if (!msg) return false;
      var rType = String(recipientType || "TENANT").trim().toUpperCase();
      if (
        rType === "TENANT" &&
        typeof cigRendererEnabled_ === "function" &&
        cigRendererEnabled_() &&
        typeof properaLegacyTextReplyEnvelope_ === "function" &&
        typeof properaRenderReply_ === "function"
      ) {
        var legacyEnv = properaLegacyTextReplyEnvelope_(
          String(recipientRef || ""),
          msg,
          lang,
          tenantReplyChannelThisTurn_(),
          String(policy || "DIRECT_SEND"),
          String(intentType || "CORE_TEXT_REPLY")
        );
        if (legacyEnv) {
          var rendered = properaRenderReply_(legacyEnv, legacyEnv.replyLang, legacyEnv.channel, legacyEnv.recipientRef);
          if (rendered && rendered.ok) return true;
        }
      }
      var intent = {
        intentType: String(intentType || "CORE_TEXT_REPLY"),
        recipientType: rType,
        recipientRef: String(recipientRef || ""),
        lang: lang,
        deliveryPolicy: String(policy || "DIRECT_SEND"),
        preRenderedBody: msg,
        vars: {},
        meta: { source: "handleInboundCore_", stage: String(effectiveStage || ""), flow: "CORE_REPLY" }
      };
      if (rType === "TENANT") intent.channel = tenantReplyChannelThisTurn_();
      var out = (typeof dispatchOutboundIntent_ === "function") ? dispatchOutboundIntent_(intent) : { ok: false };
      return !!(out && out.ok);
    } catch (_) {}
    return false;
  }

  function replyTo_(toPhone, text) {
    try {
      var msg = String(text || "").trim();
      if (!msg) return;
      if (dispatchOperationalText_("STAFF", toPhone, msg, "DIRECT_SEND", "CORE_TEXT_REPLY_TO")) return;
      var ref = String(toPhone || "").trim();
      var looksDirectRef = (/^\+\d{10,15}$/.test(ref) || /^TG:\d{5,}$/.test(ref));
      if (looksDirectRef) {
        if (dispatchOperationalText_("TENANT", ref, msg, "DIRECT_SEND", "CORE_TEXT_REPLY_TO_FALLBACK")) {
          try { logDevSms_(ref, msg.slice(0, 50), "REPLY_TO_STAFF_FALLBACK_OK direct_ref=1"); } catch (_) {}
          return;
        }
      }
      try {
        logDevSms_(String(toPhone || ""), msg.slice(0, 50), "REPLY_TO_STAFF_FAIL outgate returned false (check staff SMS/Telegram in resolver)");
      } catch (_) {}
    } catch (_) {}
  }

  function reply_(text) {
    replied = true;
    try {
      if (globalThis.__chaos && globalThis.__chaos.enabled) {
        writeTimeline_("OUT", {
          replyKey: "",
          tag: "",
          outLen: String(text || "").length,
          msg: (typeof safeTrunc === "function" ? safeTrunc(text, 140) : String(text || "").slice(0, 140))
        }, null);
      }
    } catch (_) {}

    try {
      var msg = String(text || "").trim();
      if (!msg) {
        Logger.log("REPLY_SKIP_EMPTY");
        try { logDevSms_(phone, String(text || ""), "REPLY_SKIP_EMPTY"); } catch (_) {}
        return;
      }
      try {
        var eid = (typeof globalThis !== "undefined" && globalThis.__properaTurnEid) ? String(globalThis.__properaTurnEid) : "";
        if (typeof logDevSms_ === "function") {
          try {
            logDevSms_(phone, "", "OUTBOUND_INTENT_REPLY eid=[" + eid + "] source=[reply_] channel=[" + String(tenantReplyChannelThisTurn_() || "") + "]");
          } catch (_) {}
        }
      } catch (_) {}
      dispatchOperationalText_("TENANT", phone, msg, "DIRECT_SEND", "CORE_TEXT_REPLY");
    } catch (err) {
      Logger.log("REPLY_CRASH " + err);
      try { logDevSms_(phone, String(text || ""), "REPLY_CRASH", String(err)); } catch (_) {}
    }
  }

  function replyNoHeader_(text) {
    replied = true;
    try {
      if (globalThis.__chaos && globalThis.__chaos.enabled) {
        writeTimeline_("OUT", {
          replyKey: "",
          tag: "",
          outLen: String(text || "").length,
          msg: (typeof safeTrunc === "function" ? safeTrunc(text, 140) : String(text || "").slice(0, 140))
        }, null);
      }
    } catch (_) {}
    try {
      var msg = String(text || "").trim();
      if (!msg) {
        Logger.log("REPLY_NOHEADER_SKIP_EMPTY");
        try { logDevSms_(phone, String(text || ""), "REPLY_NOHEADER_SKIP_EMPTY"); } catch (_) {}
        return;
      }
      try {
        var eid = (typeof globalThis !== "undefined" && globalThis.__properaTurnEid) ? String(globalThis.__properaTurnEid) : "";
        if (typeof logDevSms_ === "function") {
          try {
            logDevSms_(phone, "", "OUTBOUND_INTENT_REPLY eid=[" + eid + "] source=[replyNoHeader_] channel=[" + String(tenantReplyChannelThisTurn_() || "") + "]");
          } catch (_) {}
        }
      } catch (_) {}
      dispatchOperationalText_("TENANT", phone, msg, "NO_HEADER", "CORE_TEXT_REPLY_NO_HEADER");
    } catch (err) {
      Logger.log("REPLY_NOHEADER_CRASH " + err);
      try { logDevSms_(phone, String(text || ""), "REPLY_NOHEADER_CRASH", String(err)); } catch (_) {}
    }
  }

  return {
    tenantReplyChannelThisTurn_: tenantReplyChannelThisTurn_,
    dispatchOperationalText_: dispatchOperationalText_,
    replyTo_: replyTo_,
    reply_: reply_,
    replyNoHeader_: replyNoHeader_,
    isReplied_: function () { return replied; }
  };
}

// =============================================================================
// CIG RENDER PIPELINE (Phase 7 — from PROPERA MAIN)
// sanitizeConversationalReply_, properaRenderReply_, properaCommunicationGate_,
// deterministic composition, translation, validation, status resolution.
// =============================================================================
/**
 * Phase 0 — Communication Intelligence (CIG) No-Op Fast Lane.
 * Fires only for obvious conversational tokens when there is no active pending slot.
 * Expression only: deterministic match (no parsing of operational intent).
 */
// Phase 5 — Reply Authorization + Conversational Reply Sanitizer
// Contract: deterministic only; clamps any LLM conversational candidate to allowed canonicalFacts.
function sanitizeConversationalReply_(reply, canonicalFacts, allowedReplyModes) {
  try {
    const r = String(reply || "").trim();
    const cf = (canonicalFacts && typeof canonicalFacts === "object") ? canonicalFacts : {};
    const allowed = Array.isArray(allowedReplyModes) ? allowedReplyModes : [];
    const allowedSet = {};
    for (var ai = 0; ai < allowed.length; ai++) {
      var allowedKey = String(allowed[ai] || "").trim().toUpperCase();
      if (allowedKey) allowedSet[allowedKey] = true;
    }

    function truncateToMax_(s, maxChars) {
      s = String(s || "").trim();
      if (!s) return "";
      if (s.length <= maxChars) return s;
      return s.slice(0, maxChars).trim();
    }

    function truncateToTwoSentences_(s) {
      s = String(s || "").trim();
      if (!s) return "";
      // Split on common sentence terminators; keep the first 2.
      const parts = s.split(/(?<=[.!?])\s+/);
      if (parts.length <= 2) return s;
      return (parts.slice(0, 2).join(" ").trim() || truncateToMax_(s, 200));
    }

    function containsAny_(s, re) {
      return re.test(String(s || "").toLowerCase());
    }

    function safeFallbackFromReply_(s) {
      const x = String(s || "").toLowerCase();
      if (/\b(thank|ty|appreciate)\b/.test(x)) return "You're welcome! We're here if you need anything.";
      if (/\b(got it|ack|okay|ok)\b/.test(x)) return "Got it — we're here if you need anything else.";
      if (/\b(hi|hello|hey|good\s+(morning|afternoon|evening))\b/.test(x)) return "Hi there! How can we help?";
      if (/\b(frustrat|ridiculous|upset|annoy|sorry)\b/.test(x)) return "We understand your frustration. We're on it.";
      return "Thanks for reaching out.";
    }

    const schedule = (cf.schedule != null) ? String(cf.schedule || "").trim() : "";
    const assignedStaff = (cf.assignedStaff != null) ? (cf.assignedStaff ? String(cf.assignedStaff) : "") : "";
    const completionState = (cf.completionState != null) ? (cf.completionState ? String(cf.completionState) : "") : "";
    const tickets = Array.isArray(cf.tickets) ? cf.tickets : [];
    const ticketIds = tickets
      .map(t => (t && t.id != null) ? String(t.id || "").trim() : "")
      .filter(Boolean);

    if (!r) {
      return { safe: false, sanitized: safeFallbackFromReply_(r), fallbackUsed: true };
    }

    // Hard bounds: max length & max 2 sentences (sanitizer is fail-safe even when patterns match).
    const trimmed = truncateToTwoSentences_(r);
    const trimmed200 = truncateToMax_(trimmed, 200);

    // 1) Strip time claims unless canonicalFacts.schedule exists and matches time tokens.
    const timeRelativeRe = /\b(today|tomorrow|tonight|next\s+(week|month|year)|after|before)\b/i;
    const timeTokenRe = /\b(\d{1,2})(:\d{2})?\s*(am|pm)\b/i;
    const hasRelativeTime = containsAny_(trimmed200, timeRelativeRe);
    const replyTimeTokens = [];
    // Extract explicit hour+am/pm tokens.
    let m;
    const tokenRe = new RegExp(timeTokenRe, "ig");
    while ((m = tokenRe.exec(trimmed200)) !== null) {
      replyTimeTokens.push(String(m[1] || "").trim().toLowerCase() + String(m[3] || "").trim().toLowerCase());
    }

    if ((hasRelativeTime || replyTimeTokens.length > 0) && !schedule) {
      return { safe: false, sanitized: safeFallbackFromReply_(trimmed200), fallbackUsed: true };
    }
    if (replyTimeTokens.length > 0 && schedule) {
      // If reply mentions explicit times, require matching hour+am/pm in canonical schedule.
      const scheduleLower = String(schedule || "").toLowerCase();
      const scheduleTimeTokens = [];
      tokenRe.lastIndex = 0;
      while ((m = tokenRe.exec(scheduleLower)) !== null) {
        scheduleTimeTokens.push(String(m[1] || "").trim().toLowerCase() + String(m[3] || "").trim().toLowerCase());
      }
      const anyMissing = replyTimeTokens.some(t => scheduleTimeTokens.indexOf(t) < 0);
      if (anyMissing) {
        return { safe: false, sanitized: safeFallbackFromReply_(trimmed200), fallbackUsed: true };
      }
    }

    // 2) Strip staff/owner claims unless canonicalFacts has assignedStaff.
    const staffClaimRe = /\b(technician|plumber|electrician|someone|staff|our\s+team|maintenance\s+team)\b/i;
    if (containsAny_(trimmed200, staffClaimRe) && !assignedStaff) {
      return { safe: false, sanitized: safeFallbackFromReply_(trimmed200), fallbackUsed: true };
    }

    // 3) Strip completion claims unless completionState exists.
    const completionClaimRe = /\b(done|completed|fixed|resolved|it'?s\s+fixed|problem\s+solved)\b/i;
    if (containsAny_(trimmed200, completionClaimRe) && !completionState) {
      return { safe: false, sanitized: safeFallbackFromReply_(trimmed200), fallbackUsed: true };
    }

    // 4) If the brain did not authorize question-asking, clamp any question-shaped reply.
    if (/\?/.test(trimmed200) && allowed.length && !allowedSet.ASK_FOR_SLOT && !allowedSet.SAFE_CLARIFY && !allowedSet.STATUS_SUMMARY) {
      return { safe: false, sanitized: safeFallbackFromReply_(trimmed200), fallbackUsed: true };
    }

    // 5) Strip promises unless canonical facts are echoed (schedule or ticket ids).
    const promiseRe = /\b(we will|we'll|going to|expect|should be|should)\b/i;
    if (containsAny_(trimmed200, promiseRe)) {
      const echoedTicket = ticketIds.some(id => id && trimmed200.indexOf(id) >= 0);
      const echoedSchedule = schedule && trimmed200.toLowerCase().indexOf(String(schedule).toLowerCase().slice(0, 8)) >= 0;
      if (!echoedTicket && !echoedSchedule) {
        return { safe: false, sanitized: safeFallbackFromReply_(trimmed200), fallbackUsed: true };
      }
    }

    // 6) Ensure reply does not exceed hard bounds after sanitization.
    return { safe: true, sanitized: trimmed200, fallbackUsed: false };
  } catch (e) {
    try { logDevSms_((typeof phone !== "undefined" ? phone : "") || "", "", "CIG_SANITIZER_CRASH " + String(e && e.message ? e.message : e)); } catch (_) {}
    return { safe: false, sanitized: "Thanks for reaching out.", fallbackUsed: true };
  }
}

function cigRendererEnabled_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = String((props && typeof props.getProperty === "function") ? props.getProperty("CIG_RENDERER_ENABLED") : "").trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
  } catch (_) {
    return true;
  }
}

function properaErrorSafeReply_(lang) {
  var target = String(lang || "en").toLowerCase().replace(/_/g, "-");
  if (target.indexOf("-") > 0) target = target.split("-")[0];
  if (target === "es") return "Hemos recibido su mensaje. Un miembro de nuestro equipo le dara seguimiento pronto.";
  return "We've received your message. A team member will follow up shortly.";
}

function properaTranslateRenderedReply_(text, lang, canonicalFacts) {
  var out = String(text || "").trim();
  var target = String(lang || "en").toLowerCase().replace(/_/g, "-");
  if (target.indexOf("-") > 0) target = target.split("-")[0];
  if (!out || !target || target === "en") return { ok: true, text: out, translated: false };
  try {
    var facts = (canonicalFacts && typeof canonicalFacts === "object") ? canonicalFacts : {};
    var protectedText = out;
    var placeholders = [];
    function protect_(v) {
      var raw = String(v || "").trim();
      if (!raw) return;
      if (protectedText.indexOf(raw) < 0) return;
      var key = "__CIGID_" + placeholders.length + "__";
      placeholders.push({ key: key, value: raw });
      protectedText = protectedText.split(raw).join(key);
    }
    if (Array.isArray(facts.ticketIds)) {
      for (var ti = 0; ti < facts.ticketIds.length; ti++) protect_(facts.ticketIds[ti]);
    }
    if (Array.isArray(facts.tickets)) {
      for (var tj = 0; tj < facts.tickets.length; tj++) protect_(facts.tickets[tj] && facts.tickets[tj].id);
    }
    protect_(facts.propertyCode);
    protect_(facts.unit);
    if (typeof LanguageApp === "undefined" || !LanguageApp.translate) {
      return { ok: false, text: properaErrorSafeReply_(target), translated: false, reason: "translation_unavailable" };
    }
    var translated = LanguageApp.translate(protectedText, "en", target);
    translated = String(translated || "").trim();
    if (!translated) return { ok: false, text: properaErrorSafeReply_(target), translated: false, reason: "translation_empty" };
    for (var pi = 0; pi < placeholders.length; pi++) {
      translated = translated.split(placeholders[pi].key).join(placeholders[pi].value);
    }
    return { ok: true, text: translated, translated: true };
  } catch (_) {
    return { ok: false, text: properaErrorSafeReply_(target), translated: false, reason: "translation_error" };
  }
}

function properaApplySuppressionPolicy_(text, envelope) {
  var msg = String(text || "").trim();
  var env = (envelope && typeof envelope === "object") ? envelope : {};
  var mode = String(env.replyMode || "").trim().toUpperCase();
  if (!msg) return "";
  if (mode === "ACK_ONLY" || mode === "GREETING_REPLY" || mode === "FRUSTRATION_ACK" || mode === "SAFE_CLARIFY") {
    msg = msg.replace(/\b[A-Z]{2,}(?:-[A-Z0-9]{2,})+\b/g, "").replace(/\(\s*\)/g, "");
  }
  if (mode !== "TICKET_CREATED" && mode !== "FINAL_CONFIRM" && mode !== "MULTI_TICKETS_CREATED" && mode !== "SCHEDULE_CONFIRMED") {
    msg = msg.replace(/\s*(we'?ll be in touch|we are here if you need anything else|have a great day)\.?$/i, "");
  }
  msg = msg.replace(/\b(FINALIZE_DRAFT|SCHEDULE_PRETICKET|INTAKE_OPEN|PENDING_SPLIT|WAITING TENANT|MAINTENANCE_INTAKE)\b/gi, "");
  msg = msg.replace(/\s{2,}/g, " ").replace(/\s+\./g, ".").trim();
  return msg;
}

function properaEnforceRenderStructure_(text, envelope) {
  var msg = String(text || "").trim();
  var env = (envelope && typeof envelope === "object") ? envelope : {};
  var mode = String(env.replyMode || "").trim().toUpperCase();
  if (!msg) return "";
  function sentences_(s) {
    return String(s || "").trim().split(/(?<=[.!?])\s+/).filter(function (x) { return !!String(x || "").trim(); });
  }
  function firstSentence_(s) {
    var parts = sentences_(s);
    return parts.length ? String(parts[0] || "").trim() : String(s || "").trim();
  }
  if (mode === "ACK_ONLY" || mode === "GREETING_REPLY" || mode === "FRUSTRATION_ACK") {
    msg = firstSentence_(msg);
  } else if (mode === "ASK_FOR_SLOT" || mode === "SAFE_CLARIFY") {
    var qm = msg.indexOf("?");
    if (qm >= 0) msg = msg.slice(0, qm + 1).trim();
    if (msg.indexOf("?") < 0) msg = msg.replace(/[.!]+$/g, "").trim() + "?";
    msg = msg.replace(/\?+/g, "?");
  } else if (mode === "STATUS_SUMMARY" || mode === "STATUS_REPLY") {
    msg = sentences_(msg).slice(0, 2).join(" ").trim();
  } else if (mode === "FINAL_CONFIRM") {
    var partsF = sentences_(msg);
    if (partsF.length === 1 && msg) msg = msg.replace(/[.!]+$/g, "").trim() + ". We're here if you need anything else.";
  } else if (mode === "TICKET_CREATED") {
    var partsT = sentences_(msg);
    if (!/we'?ll be in touch/i.test(msg)) msg = partsT.slice(0, 2).join(" ").trim().replace(/[.!]+$/g, "").trim() + ". We'll be in touch.";
  }
  msg = msg.replace(/\s{2,}/g, " ").trim();
  return msg;
}

function properaApplyChannelPolicy_(text, envelope) {
  var msg = String(text || "").trim();
  var env = (envelope && typeof envelope === "object") ? envelope : {};
  var ch = String(env.channel || "SMS").trim().toUpperCase();
  var mode = String(env.replyMode || "").trim().toUpperCase();
  var facts = (env.canonicalFacts && typeof env.canonicalFacts === "object") ? env.canonicalFacts : {};
  if (!msg) return "";
  if (ch === "SMS") {
    msg = msg.replace(/[•\-\*]\s*/g, "").replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
    if ((mode === "ACK_ONLY" || mode === "GREETING_REPLY" || mode === "FRUSTRATION_ACK") && /\?/.test(msg)) {
      msg = msg.split("?")[0].trim().replace(/[.!]+$/g, "").trim() + ".";
    }
  } else if (ch === "TELEGRAM" || ch === "WA" || ch === "WHATSAPP") {
    msg = msg.replace(/\n{3,}/g, "\n\n").trim();
  } else if (ch === "VOICE" || ch === "ALEXA") {
    msg = msg.replace(/[•*_`]/g, "").replace(/[()]/g, "").replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (mode === "STATUS_SUMMARY" || mode === "STATUS_REPLY") {
      msg = msg.replace(/\b[A-Z]{2,}(?:-[A-Z0-9]{2,})+\b/g, "").replace(/\s{2,}/g, " ").trim();
    }
    if (mode === "FINAL_CONFIRM" && Array.isArray(facts.ticketIds) && facts.ticketIds.length <= 1) {
      msg = msg.replace(/\b[A-Z]{2,}(?:-[A-Z0-9]{2,})+\b/g, "").replace(/\s{2,}/g, " ").trim();
    }
  }
  return msg;
}

function properaLooksLanguageMatched_(text, lang) {
  var msg = String(text || "").trim().toLowerCase();
  var target = String(lang || "en").toLowerCase().replace(/_/g, "-");
  if (target.indexOf("-") > 0) target = target.split("-")[0];
  if (!msg) return true;
  if (target === "es") {
    var hasSpanish = /(\b(el|la|los|las|su|sus|para|mensaje|solicitud|equipo|hemos|recibido|confirmad[oa])\b|[áéíóúñ])/i.test(msg);
    var englishHeavy = /\b(the|your|request|team|we've|received|scheduled)\b/i.test(msg);
    return hasSpanish || !englishHeavy;
  }
  if (target === "en") {
    var hasEnglish = /\b(the|your|request|team|received|confirmed|scheduled|message)\b/i.test(msg);
    var spanishHeavy = /(\b(el|la|los|las|su|sus|mensaje|solicitud|equipo|hemos|recibido)\b|[áéíóúñ])/i.test(msg);
    return hasEnglish || !spanishHeavy;
  }
  return true;
}

function properaValidateRenderOutput_(text, envelope) {
  var msg = String(text || "").trim();
  var env = (envelope && typeof envelope === "object") ? envelope : {};
  var ch = String(env.channel || "SMS").trim().toUpperCase();
  var replyLang = String(env.replyLang || env.lang || "en").toLowerCase();
  var phone = String(env.recipientRef || "").trim();
  var facts = (env.canonicalFacts && typeof env.canonicalFacts === "object") ? env.canonicalFacts : {};
  if (!msg) return { ok: false, reason: "empty", text: "" };
  if (/\{[A-Z0-9_]+\}/i.test(msg)) return { ok: false, reason: "placeholder_leak", text: "" };
  if (/\n{2,}/.test(msg)) {
    msg = msg.replace(/\n{2,}/g, "\n");
    try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "CIG_RENDER_SINGLE_MESSAGE_CLAMP"); } catch (_) {}
  }
  if (/\b(FINALIZE_DRAFT|SCHEDULE_PRETICKET|PROPERTY_AND_UNIT|MAINTENANCE_INTAKE|WAITING TENANT|INTAKE_OPEN|PENDING_SPLIT)\b/i.test(msg)) {
    msg = msg.replace(/\b(FINALIZE_DRAFT|SCHEDULE_PRETICKET|PROPERTY_AND_UNIT|MAINTENANCE_INTAKE|WAITING TENANT|INTAKE_OPEN|PENDING_SPLIT)\b/gi, "").replace(/\s{2,}/g, " ").trim();
    try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "CIG_RENDER_STAGE_LEAK"); } catch (_) {}
  }
  var seenIds = {};
  msg = msg.replace(/\b[A-Z]{2,}(?:-[A-Z0-9]{2,})+\b/g, function (m) {
    var key = String(m || "").trim();
    if (!key) return m;
    if (seenIds[key]) {
      try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "CIG_RENDER_DUP_ID"); } catch (_) {}
      return "";
    }
    seenIds[key] = true;
    return key;
  }).replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
  var promiseRe = /\b(we will|we'll|going to|expect|should be)\b/i;
  var hasBackingFact = !!(facts.schedule || (Array.isArray(facts.ticketIds) && facts.ticketIds.length) || (Array.isArray(facts.tickets) && facts.tickets.length));
  if (promiseRe.test(msg) && !hasBackingFact) {
    msg = msg.replace(/\b(we will|we'll|going to|expect|should be)\b[^.!?]*/i, "").replace(/\s{2,}/g, " ").trim();
    try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "CIG_RENDER_PROMISE_LEAK"); } catch (_) {}
  }
  if (!properaLooksLanguageMatched_(msg, replyLang)) {
    try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "CIG_RENDER_LANG_MISMATCH"); } catch (_) {}
    return { ok: false, reason: "lang_mismatch", text: msg };
  }
  var maxLen = 900;
  if (ch === "SMS") maxLen = 320;
  else if (ch === "TELEGRAM" || ch === "WA" || ch === "WHATSAPP") maxLen = 500;
  else if (ch === "VOICE" || ch === "ALEXA") maxLen = 300;
  if (msg.length > maxLen) {
    var truncated = msg.slice(0, maxLen);
    var cut = Math.max(truncated.lastIndexOf(". "), truncated.lastIndexOf("? "), truncated.lastIndexOf("! "));
    msg = (cut > 40 ? truncated.slice(0, cut + 1) : truncated).trim();
    try { if (typeof logDevSms_ === "function") logDevSms_(phone, "", "CIG_RENDER_LENGTH_CLAMP"); } catch (_) {}
  }
  return { ok: !!msg, reason: msg ? "" : "empty_after_validation", text: msg };
}

function resolveStatusQuery_(statusQueryType, phone, ctx, lang) {
  var replyLang = String(lang || "en").toLowerCase();
  var facts = {
    found: false,
    queryType: String(statusQueryType || "NONE").trim().toUpperCase(),
    ticketIds: [],
    tickets: [],
    schedule: "",
    currentStage: ""
  };
  var fallback = "We couldn't find your current status. Please try again.";
  try { fallback = tenantMsg_("TENANT_STATUS_FALLBACK", replyLang, {}); } catch (_) {}
  try {
    var sheet = getSheet_(SHEET_NAME);
    if (!sheet || typeof findTenantTicketRows_ !== "function") {
      return { found: false, facts: facts, replyTemplate: fallback };
    }
    var rows = findTenantTicketRows_(sheet, phone, { includeClosed: false });
    if (!rows.length) {
      return {
        found: false,
        facts: facts,
        replyTemplate: "We don't see an active request. Would you like to submit one?"
      };
    }
    if (rows.length === 1 && typeof readTicketForTenant_ === "function") {
      var t = readTicketForTenant_(sheet, rows[0]) || {};
      var ticketId = String(t.ticketId || "").trim();
      var schedule = String(t.prefWindow || "").trim();
      var stage = String(t.status || "").trim();
      facts.found = true;
      facts.schedule = schedule;
      facts.currentStage = stage;
      if (ticketId) {
        facts.ticketIds = [ticketId];
        facts.tickets = [{ id: ticketId, status: stage, schedule: schedule }];
      }
      if (schedule) {
        return { found: true, facts: facts, replyTemplate: "Your visit is scheduled for " + schedule + "." };
      }
      if (ticketId) {
        return { found: true, facts: facts, replyTemplate: "Your request (" + ticketId + ") is currently being handled." };
      }
      return { found: true, facts: facts, replyTemplate: "Your request is currently being handled." };
    }
    var multi = null;
    if (typeof tenantStatusCommand_ === "function") {
      try { multi = tenantStatusCommand_(sheet, phone, "", replyLang); } catch (_) { multi = null; }
    }
    for (var ri = 0; ri < Math.min(rows.length, 5); ri++) {
      try {
        var tk = readTicketForTenant_(sheet, rows[ri]) || {};
        var tkId = String(tk.ticketId || "").trim();
        if (tkId) facts.ticketIds.push(tkId);
        facts.tickets.push({
          id: tkId,
          status: String(tk.status || "").trim(),
          schedule: String(tk.prefWindow || "").trim()
        });
      } catch (_) {}
    }
    facts.found = true;
    return {
      found: true,
      facts: facts,
      replyTemplate: (multi && String(multi.msg || "").trim()) ? String(multi.msg || "").trim() : fallback
    };
  } catch (_) {
    return { found: false, facts: facts, replyTemplate: fallback };
  }
}

function properaIntentToReplyEnvelope_(intent) {
  var inIntent = (intent && typeof intent === "object") ? intent : null;
  if (!inIntent) return null;
  var intentType = String(inIntent.intentType || "").trim().toUpperCase();
  var recipientType = String(inIntent.recipientType || "").trim().toUpperCase();
  var recipientRef = String(inIntent.recipientRef || "").trim();
  var vars = (inIntent.vars && typeof inIntent.vars === "object") ? inIntent.vars : {};
  if (recipientType !== "TENANT" || !recipientRef) return null;
  if (!intentType || intentType === "CORE_TEXT_REPLY" || intentType === "CONVERSATIONAL_REPLY" || intentType === "STATUS_REPLY" || intentType === "SAFE_CLARIFY") return null;
  if (inIntent.meta && String(inIntent.meta.source || "").trim().toUpperCase() === "CIG_RENDERER") return null;

  function scheduleFromVars_() {
    return String(vars.scheduleLabel || vars.label || vars.preferredWindow || vars.scheduleWindow || vars.when || vars.window || "").trim();
  }

  var base = {
    source: "brain",
    channel: inIntent.channel || "SMS",
    recipientRef: recipientRef,
    replyLang: inIntent.lang || "en",
    conversationMove: String(vars.conversationMove || "NONE").trim().toUpperCase()
  };

  if (intentType === "ASK_FOR_MISSING_UNIT") {
    return Object.assign({}, base, {
      replyMode: "ASK_FOR_SLOT",
      slotType: "UNIT",
      askAttempt: Number(vars.askAttempt) || 1,
      allowedReplyModes: ["ASK_FOR_SLOT"],
      canonicalFacts: {
        propertyName: String(vars.propertyName || "").trim(),
        propertyCode: String(vars.propertyCode || "").trim(),
        unit: String(vars.unit || "").trim(),
        issueSummary: String(vars.issueSummary || vars.issue || "").trim()
      }
    });
  }
  if (intentType === "ASK_FOR_ISSUE") {
    return Object.assign({}, base, {
      replyMode: "ASK_FOR_SLOT",
      slotType: "ISSUE",
      askAttempt: Number(vars.askAttempt) || 1,
      allowedReplyModes: ["ASK_FOR_SLOT"],
      canonicalFacts: {
        propertyName: String(vars.propertyName || "").trim(),
        unit: String(vars.unit || "").trim()
      }
    });
  }
  if (intentType === "ASK_PROPERTY_AND_UNIT_PACKAGED") {
    return Object.assign({}, base, {
      replyMode: "ASK_FOR_SLOT",
      slotType: "PROPERTY_AND_UNIT",
      askAttempt: Number(vars.askAttempt) || 1,
      allowedReplyModes: ["ASK_FOR_SLOT"],
      canonicalFacts: {
        issueHint: String(vars.issueHint || "").trim(),
        packagedIssueCount: Number(vars.packagedIssueCount) || 1,
        packagedIssuePairLine: String(vars.packagedIssuePairLine || vars.pairLine || "").trim()
      }
    });
  }
  if (intentType === "TICKET_CREATED_ASK_SCHEDULE") {
    return Object.assign({}, base, {
      replyMode: "ASK_FOR_SLOT",
      slotType: "SCHEDULE",
      askAttempt: Number(vars.askAttempt) || 1,
      allowedReplyModes: ["ASK_FOR_SLOT"],
      preRenderedBody: String(vars.summaryText || "").trim(),
      canonicalFacts: {
        schedule: scheduleFromVars_(),
        issueSummary: String(vars.issueSummary || vars.issueShort || vars.issue || "").trim(),
        propertyName: String(vars.propertyName || vars.propertyCode || "").trim(),
        unit: String(vars.unit || "").trim()
      }
    });
  }
  if (intentType === "TICKET_CREATED_COMMON_AREA") {
    var ticketId = String(vars.ticketId || "").trim();
    return Object.assign({}, base, {
      replyMode: "TICKET_CREATED",
      allowedReplyModes: ["TICKET_CREATED"],
      canonicalFacts: {
        ticketIds: ticketId ? [ticketId] : [],
        tickets: ticketId ? [{ id: ticketId }] : []
      }
    });
  }
  if (intentType === "MULTI_SPLIT_TICKETS_CREATED") {
    return Object.assign({}, base, {
      replyMode: "MULTI_TICKETS_CREATED",
      allowedReplyModes: ["MULTI_TICKETS_CREATED"],
      canonicalFacts: {
        count: Number(vars.count || vars.splitCount) || 2,
        ticketIds: [],
        tickets: []
      }
    });
  }
  if (intentType === "CONFIRM_RECORDED_SCHEDULE") {
    return Object.assign({}, base, {
      replyMode: "SCHEDULE_CONFIRMED",
      allowedReplyModes: ["SCHEDULE_CONFIRMED"],
      canonicalFacts: {
        schedule: scheduleFromVars_(),
        issueSummary: String(vars.issueSummary || vars.issuesSummary || vars.issue || "").trim()
      }
    });
  }
  return null;
}

function properaLegacyTextReplyEnvelope_(recipientRef, text, lang, channel, deliveryPolicy, intentType) {
  var msg = String(text || "").trim();
  if (!msg) return null;
  var inferredMode = "LEGACY_TEXT";
  if (/can you clarify/i.test(msg)) inferredMode = "SAFE_CLARIFY";
  else if (/scheduled for|currently being handled|active request/i.test(msg)) inferredMode = "STATUS_SUMMARY";
  else if (/we understand your frustration/i.test(msg)) inferredMode = "FRUSTRATION_ACK";
  else if (/^hi there|^hello|^hey/i.test(msg)) inferredMode = "GREETING_REPLY";
  else if (/\?$/.test(msg)) inferredMode = "ASK_FOR_SLOT";
  return {
    source: "legacy_text",
    replyMode: inferredMode,
    replyLang: String(lang || "en").trim().toLowerCase(),
    channel: String(channel || "SMS").trim().toUpperCase(),
    recipientRef: String(recipientRef || "").trim(),
    preRenderedBody: msg,
    canonicalFacts: {},
    allowedReplyModes: [inferredMode, "LEGACY_TEXT"],
    deliveryPolicy: String(deliveryPolicy || "DIRECT_SEND").trim(),
    legacyIntentType: String(intentType || "CORE_TEXT_REPLY").trim().toUpperCase()
  };
}

/**
 * Phase 7 — Agent 2: Core Rendering Engine.
 * Unified deterministic renderer for tenant-facing text.
 *
 * NOTE: This is intentionally conservative: when facts are not present,
 * it falls back to safe templates / bounded clarifications.
 */
function properaRenderReply_(envelope, lang, channel, phone) {
  envelope = envelope && typeof envelope === "object" ? envelope : {};
  const replyMode = String(envelope.replyMode || "").trim().toUpperCase();
  const convMove = String(envelope.conversationMove || envelope.move || "ACK").trim().toUpperCase();
  const safeLang = String(lang || envelope.replyLang || envelope.lang || "en").toLowerCase().replace(/_/g, "-").split("-")[0] || "en";
  const safeChannel = String(channel || envelope.channel || "SMS").trim().toUpperCase();
  const recipientRef = String(phone || envelope.recipientRef || "").trim();
  if (!recipientRef) return { ok: false, err: "missing_recipientRef" };

  function emitPreRenderedCoreText_(text, stage) {
    const msg = String(text || "").trim();
    if (!msg) return false;
    var intentType = "CORE_TEXT_REPLY";
    if (stage === "CONVERSATIONAL_REPLY" || stage === "STATUS_REPLY" || stage === "SAFE_CLARIFY") intentType = stage;
    var deliveryPolicy = String(envelope.deliveryPolicy || "NO_HEADER").trim();
    if (deliveryPolicy !== "DIRECT_SEND") deliveryPolicy = "NO_HEADER";
    const _og = (typeof dispatchOutboundIntent_ === "function")
      ? dispatchOutboundIntent_({
          intentType: intentType,
          templateKey: intentType,
          recipientType: "TENANT",
          recipientRef: recipientRef,
          lang: safeLang,
          channel: safeChannel,
          deliveryPolicy: deliveryPolicy,
          preRenderedBody: msg,
          vars: {},
          meta: { source: "CIG_RENDERER", stage: stage || "CIG_RENDERER", flow: "MAINTENANCE_INTAKE" }
        })
      : { ok: false };
    return !!(_og && _og.ok);
  }

  function emitMoveTemplate_(move) {
    const mt = String(move || "").trim().toUpperCase();
    let intentType = "ACK";
    if (mt === "THANKS" || mt === "ACK" || mt === "GREETING" || mt === "GOODBYE") intentType = mt;
    // For unknown moves, safest bounded fallback is ACK.
    const _og = (typeof dispatchOutboundIntent_ === "function")
      ? dispatchOutboundIntent_({
          intentType: intentType,
          templateKey: intentType,
          recipientType: "TENANT",
          recipientRef: recipientRef,
          lang: safeLang,
          channel: safeChannel,
          deliveryPolicy: "NO_HEADER",
          vars: {},
          meta: { source: "CIG_RENDERER", stage: "CIG_RENDERER_MOVE", flow: "MAINTENANCE_INTAKE" }
        })
      : { ok: false };
    return !!(_og && _og.ok);
  }

  function maybeSanitizeCandidate_(cand, facts, allowedModes) {
    if (cand == null) return { used: false, text: "" };
    const c = String(cand || "").trim();
    if (!c) return { used: false, text: "" };
    const sr = sanitizeConversationalReply_(c, facts || {}, allowedModes || ["ACK_ONLY"]);
    if (sr && sr.safe && String(sr.sanitized || "").trim()) return { used: true, text: String(sr.sanitized || "").trim() };
    return { used: false, text: "" };
  }

  function applyConversationPrefix_(mode, move, text) {
    var prefix = "";
    if (mode === "ASK_FOR_SLOT" || mode === "TICKET_CREATED" || mode === "MULTI_TICKETS_CREATED" || mode === "SCHEDULE_CONFIRMED" || mode === "FINAL_CONFIRM") {
      if (move === "THANKS") prefix = "Thanks!";
      else if (move === "GREETING") prefix = "Hi!";
      else if (move === "APOLOGY") prefix = "No worries.";
      else if (move === "FRUSTRATION") prefix = "We hear you.";
    }
    var body = String(text || "").trim();
    if (!prefix || !body) return body;
    if (body.indexOf(prefix) === 0) return body;
    return prefix + " " + body;
  }

  function buildAskForSlotText_(slotType) {
    var slot = String(slotType || "").trim().toUpperCase();
    var attempt = Number(envelope.askAttempt) || 1;
    if (slot === "PROPERTY_AND_UNIT") {
      if (attempt >= 3) return "Reply with your property name and unit number, for example: Penn 205.";
      if (attempt === 2) return "I need your building name and unit number to place this request — for example: Penn 205.";
      var pairLine = String(canonicalFacts.packagedIssuePairLine || "").trim();
      var issueHint = String(canonicalFacts.issueHint || envelope.issueHint || "").trim();
      var packagedIssueCount = Number(canonicalFacts.packagedIssueCount) || 1;
      if (packagedIssueCount >= 2 && pairLine) return pairLine + " — what is your property and unit number?";
      if (packagedIssueCount >= 2) return "I noted multiple maintenance issues. What is your property and unit number?";
      if (issueHint) return issueHint.charAt(0).toUpperCase() + issueHint.slice(1) + " — what is your property and unit number?";
      return "What is your property and unit number?";
    }
    if (slot === "UNIT") {
      var propName = String(canonicalFacts.propertyName || canonicalFacts.propertyCode || "").trim();
      var issueBrief = String(canonicalFacts.issueSummary || "").trim();
      if (attempt >= 3) return "Reply with just the unit number, for example: 205.";
      if (attempt === 2) return "I still need your unit number to place the request.";
      if (propName && issueBrief) return propName + " — what unit are you in?";
      if (propName) return propName + " — what's your unit number?";
      return "What's your unit number?";
    }
    if (slot === "ISSUE") {
      var propI = String(canonicalFacts.propertyName || canonicalFacts.propertyCode || "").trim();
      var unitI = String(canonicalFacts.unit || "").trim();
      var slotLine = (propI && unitI) ? (propI + ", unit " + unitI) : (propI || (unitI ? ("Unit " + unitI) : ""));
      if (attempt >= 3) return "Reply with the problem only, for example: sink leak.";
      if (attempt === 2) return "I still need a short description of the problem.";
      if (slotLine) return slotLine + " — what issue are you having?";
      return "What issue are you having?";
    }
    if (slot === "DETAIL") return "Can you share a little more detail?";
    if (slot === "SCHEDULE") {
      var issueS = String(canonicalFacts.issueSummary || "").trim();
      if (attempt >= 3) return "Reply with a day/time only, for example: tomorrow after 3 PM.";
      if (attempt === 2) return "I still need a time window for the visit. What day or time works best?";
      if (issueS) return issueS + ". When is a good time for us to come by?";
      return "When is a good time for us to come by?";
    }
    return "When is a good time for us to come by?";
  }

  function finalizeAndEmit_(rawText, stage, fallbackText) {
    var text = String(rawText || "").trim();
    if (!text) text = String(fallbackText || "").trim();
    text = applyConversationPrefix_(replyMode, convMove, text);
    text = properaApplySuppressionPolicy_(text, {
      replyMode: replyMode,
      channel: safeChannel,
      canonicalFacts: canonicalFacts,
      recipientRef: recipientRef
    });
    text = properaEnforceRenderStructure_(text, {
      replyMode: replyMode,
      channel: safeChannel,
      canonicalFacts: canonicalFacts
    });
    var sanitized = sanitizeConversationalReply_(text, canonicalFacts, Array.isArray(envelope.allowedReplyModes) ? envelope.allowedReplyModes : [replyMode || "ACK_ONLY"]);
    if (sanitized && String(sanitized.sanitized || "").trim()) text = String(sanitized.sanitized || "").trim();
    text = properaApplyChannelPolicy_(text, {
      replyMode: replyMode,
      channel: safeChannel,
      canonicalFacts: canonicalFacts
    });
    var translated = properaTranslateRenderedReply_(text, safeLang, canonicalFacts);
    if (!translated.ok) {
      try { if (typeof logDevSms_ === "function") logDevSms_(recipientRef, "", "CIG_RENDER_ERROR reason=[" + String(translated.reason || "translation_error") + "] replyMode=[" + replyMode + "] replyLang=[" + safeLang + "]"); } catch (_) {}
      text = properaErrorSafeReply_(safeLang);
    } else {
      text = String(translated.text || "").trim();
    }
    var valid = properaValidateRenderOutput_(text, {
      replyMode: replyMode,
      channel: safeChannel,
      canonicalFacts: canonicalFacts,
      recipientRef: recipientRef,
      replyLang: safeLang
    });
    if (!valid.ok) {
      try { if (typeof logDevSms_ === "function") logDevSms_(recipientRef, "", "CIG_RENDER_ERROR reason=[" + String(valid.reason || "validation_fail") + "] replyMode=[" + replyMode + "] replyLang=[" + safeLang + "]"); } catch (_) {}
      text = properaErrorSafeReply_(safeLang);
    } else {
      text = String(valid.text || text).trim();
    }
    return { ok: emitPreRenderedCoreText_(text, stage || "CIG_RENDERER") };
  }

  // Normalize text inputs.
  const preRendered = (envelope.preRenderedBody != null) ? envelope.preRenderedBody : envelope.text;
  const candidate = envelope.conversationalReply != null ? envelope.conversationalReply : envelope.candidateReply;
  const canonicalFacts = (envelope.canonicalFacts && typeof envelope.canonicalFacts === "object") ? envelope.canonicalFacts : {};
  const rendererEnabled = cigRendererEnabled_();

  // Reply mode dispatch.
  if (replyMode === "ACK_ONLY" || replyMode === "" || replyMode === "ACK") {
    const ss = maybeSanitizeCandidate_(candidate, canonicalFacts, Array.isArray(envelope.allowedReplyModes) ? envelope.allowedReplyModes : ["ACK_ONLY"]);
    if (ss.used) return finalizeAndEmit_(ss.text, "CONVERSATIONAL_REPLY", "Thanks for reaching out.");
    emitMoveTemplate_(convMove);
    return { ok: true };
  }

  if (replyMode === "GREETING_REPLY") {
    return finalizeAndEmit_(preRendered, "CONVERSATIONAL_REPLY", "Hi there! How can we help?");
  }

  if (replyMode === "FRUSTRATION_ACK") {
    return finalizeAndEmit_(preRendered, "CONVERSATIONAL_REPLY", "We understand your frustration. We're on it.");
  }

  if (replyMode === "SAFE_CLARIFY") {
    const text = String(preRendered || envelope.replyText || "Can you clarify what you need help with?").trim();
    return finalizeAndEmit_(text, "SAFE_CLARIFY", "Can you clarify what you need help with?");
  }

  if (replyMode === "LEGACY_TEXT") {
    return finalizeAndEmit_(String(preRendered || "").trim(), "CORE_TEXT_REPLY", "Thanks for reaching out.");
  }

  if (replyMode === "STATUS_SUMMARY" || replyMode === "STATUS_REPLY") {
    if (String(preRendered || "").trim()) return finalizeAndEmit_(preRendered, "STATUS_REPLY", "We couldn't find your current status. Please try again.");
    // Deterministic fallbacks if resolver didn't pass text.
    const found = !!canonicalFacts.found;
    const schedule = canonicalFacts.schedule ? String(canonicalFacts.schedule || "").trim() : "";
    const ticketIds = Array.isArray(canonicalFacts.ticketIds) ? canonicalFacts.ticketIds : [];
    if (!found) return finalizeAndEmit_("We don't see an active request. Would you like to submit one?", "STATUS_REPLY", "We don't see an active request. Would you like to submit one?");
    if (schedule) return finalizeAndEmit_("Your visit is scheduled for " + schedule + ".", "STATUS_REPLY", "Your request is currently being handled.");
    if (ticketIds.length) return finalizeAndEmit_("Your request is currently being handled.", "STATUS_REPLY", "Your request is currently being handled.");
    return finalizeAndEmit_("We couldn't find your current status. Please try again.", "STATUS_REPLY", "We couldn't find your current status. Please try again.");
  }

  // Minimal support for future brain-driven modes (safe fallbacks).
  if (replyMode === "ASK_FOR_SLOT") {
    const text = String(preRendered || envelope.replyText || buildAskForSlotText_(envelope.slotType || canonicalFacts.slotType || "")).trim();
    return finalizeAndEmit_(text, "CORE_TEXT_REPLY", buildAskForSlotText_(envelope.slotType || canonicalFacts.slotType || ""));
  }
  if (replyMode === "TICKET_CREATED" || replyMode === "MULTI_TICKETS_CREATED" || replyMode === "SCHEDULE_CONFIRMED" || replyMode === "FINAL_CONFIRM") {
    if (String(preRendered || "").trim()) return finalizeAndEmit_(preRendered, "CORE_TEXT_REPLY", "All set.");
    // If not provided, attempt deterministic template from canonicalFacts.
    try {
      const tickets = Array.isArray(canonicalFacts.tickets) ? canonicalFacts.tickets : [];
      const ticketIds = Array.isArray(canonicalFacts.ticketIds) ? canonicalFacts.ticketIds : tickets.map(t => t && t.id ? t.id : null).filter(Boolean);
      const schedule = canonicalFacts.schedule ? String(canonicalFacts.schedule || "").trim() : "";
      if (replyMode === "TICKET_CREATED") {
        var tcIssue = String(canonicalFacts.issueSummary || "").trim();
        if (tcIssue && schedule) return finalizeAndEmit_("Your " + tcIssue + " request is set for " + schedule + ". We'll be in touch.", "CORE_TEXT_REPLY", "Your request has been created. We'll be in touch.");
        if (tcIssue) return finalizeAndEmit_("Your " + tcIssue + " request has been recorded. We'll be in touch.", "CORE_TEXT_REPLY", "Your request has been created. We'll be in touch.");
        if (schedule) return finalizeAndEmit_("Your request is set for " + schedule + ". We'll be in touch.", "CORE_TEXT_REPLY", "Your request has been created. We'll be in touch.");
        return finalizeAndEmit_("Your request has been recorded. We'll be in touch.", "CORE_TEXT_REPLY", "Your request has been created. We'll be in touch.");
      }
      if (replyMode === "MULTI_TICKETS_CREATED") {
        const n = Math.max(2, Number(canonicalFacts.count) || ticketIds.length || 2);
        var mtIssue = String(canonicalFacts.issueSummary || "").trim();
        if (mtIssue && schedule) return finalizeAndEmit_("We've recorded " + n + " requests including your " + mtIssue + ". Schedule: " + schedule + ". We'll be in touch.", "CORE_TEXT_REPLY", "We've created your requests. We'll be in touch.");
        return finalizeAndEmit_("We've recorded " + n + " maintenance requests." + (schedule ? (" Schedule: " + schedule + ".") : "") + " We'll be in touch.", "CORE_TEXT_REPLY", "We've created your requests. We'll be in touch.");
      }
      if (replyMode === "SCHEDULE_CONFIRMED") {
        var cIssue = String(canonicalFacts.issueSummary || "").trim();
        if (cIssue && schedule) return finalizeAndEmit_("Your " + cIssue + " is set for " + schedule + ". We'll be in touch.", "CORE_TEXT_REPLY", "Your request is set for " + schedule + ".");
        if (schedule) return finalizeAndEmit_("Your request is set for " + schedule + ". We'll be in touch.", "CORE_TEXT_REPLY", "Schedule confirmed.");
      }
      if (replyMode === "FINAL_CONFIRM") {
        const ids = ticketIds.length ? ticketIds.join(" and ") : "";
        const sc = schedule ? (" for " + schedule) : "";
        if (ids) return finalizeAndEmit_("All set! Your requests " + ids + sc + ". We're here if you need anything else.", "CORE_TEXT_REPLY", "All set. We're here if you need anything else.");
      }
    } catch (_) {}
    return finalizeAndEmit_("All set.", "CORE_TEXT_REPLY", "All set.");
  }

  // Unknown replyMode: safe fallback.
  if (String(preRendered || "").trim()) return finalizeAndEmit_(preRendered, "CORE_TEXT_REPLY", "Thanks for reaching out.");
  if (!rendererEnabled) {
    emitMoveTemplate_(convMove);
    return { ok: true };
  }
  emitMoveTemplate_(convMove);
  return { ok: true };
}

/**
 * Phase 8 — Agent 2: Outbound Composition (Deterministic-First).
 * Compose known event combinations into one coherent tenant-facing message.
 * No facts are invented; templates only stitch values already present.
 */
function properaComposeDeterministic_(events) {
  const list = Array.isArray(events) ? events : [];
  const byType = {};
  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    const it = String(ev.intentType || "").trim().toUpperCase();
    if (!it) continue;
    if (!byType[it]) byType[it] = [];
    byType[it].push(ev.vars && typeof ev.vars === "object" ? ev.vars : {});
  }

  const hasMulti = !!byType["MULTI_SPLIT_TICKETS_CREATED"];
  const hasConfirm = !!byType["CONFIRM_RECORDED_SCHEDULE"];
  if (hasMulti && hasConfirm) {
    const multiVars = (byType["MULTI_SPLIT_TICKETS_CREATED"][0] || {});
    const confirmVars = (byType["CONFIRM_RECORDED_SCHEDULE"][0] || {});
    const nRaw = multiVars.count != null ? String(multiVars.count || "") : (multiVars.splitCount != null ? String(multiVars.splitCount || "") : "");
    const n = Number(nRaw) || 2;
    const schedule =
      (confirmVars && confirmVars.scheduleLabel != null ? String(confirmVars.scheduleLabel || "") : "") ||
      (confirmVars && confirmVars.label != null ? String(confirmVars.label || "") : "") ||
      (multiVars && multiVars.scheduleLabel != null ? String(multiVars.scheduleLabel || "") : "") ||
      "";
    const scheduleTrim = schedule.trim();
    const composed = "We've created " + n + " requests and recorded your preferred window for " + scheduleTrim + ". We'll be in touch.";
    return { composed: composed, matched: !!scheduleTrim };
  }

  const hasCreated = !!byType["TICKET_CREATED_COMMON_AREA"];
  if (hasCreated && hasConfirm) {
    const createdVars = (byType["TICKET_CREATED_COMMON_AREA"][0] || {});
    const confirmVars2 = (byType["CONFIRM_RECORDED_SCHEDULE"][0] || {});
    const ticketId = String(createdVars.ticketId || "").trim();
    const schedule2 =
      (confirmVars2 && confirmVars2.scheduleLabel != null ? String(confirmVars2.scheduleLabel || "") : "") ||
      (confirmVars2 && confirmVars2.label != null ? String(confirmVars2.label || "") : "") ||
      "";
    if (ticketId && String(schedule2 || "").trim()) {
      return {
        composed: "We've created your request (" + ticketId + ") and recorded your preferred window for " + String(schedule2 || "").trim() + ". We'll be in touch.",
        matched: true
      };
    }
  }

  return { composed: null, matched: false };
}

function properaComposeAiPolish_(events, facts) {
  var enabled = false;
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = String((props && typeof props.getProperty === "function") ? props.getProperty("CIG_COMPOSE_AI_POLISH_ENABLED") : "").trim().toLowerCase();
    enabled = !(raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "");
  } catch (_) {
    enabled = false;
  }
  if (!enabled) return { composed: null, matched: false, aiPolishUsed: false };
  // Phase 8 contract: optional only. Keep deterministic fail-safe until Phase 9 test coverage exists.
  return { composed: null, matched: false, aiPolishUsed: false };
}

function cigNoOpFastLane_(phone, bodyTrim, ctx) {
  const raw = String(bodyTrim || "").trim();
  if (!raw) return { handled: false };

  // Contract constraint: length < 30 characters.
  if (raw.length >= 30) return { handled: false };

  // PendingExpected guard: if a slot is active, we must not hijack.
  const peRaw = ctx && ctx.pendingExpected != null ? String(ctx.pendingExpected || "").trim() : "";
  const pendingExpected = peRaw ? peRaw.toUpperCase() : "";
  if (pendingExpected) {
    let expiresMs = 0;
    const peExp = ctx && ctx.pendingExpiresAt != null ? ctx.pendingExpiresAt : "";
    if (peExp instanceof Date) {
      expiresMs = peExp.getTime();
    } else {
      const parsed = Date.parse(String(peExp || ""));
      expiresMs = isNaN(parsed) ? 0 : parsed;
    }
    const nowMs = Date.now();
    const isExpired = expiresMs > 0 ? (nowMs > expiresMs) : false;
    if (!isExpired) return { handled: false };
  }

  // Normalize for deterministic matching.
  const t = raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    // Trim common edge punctuation so "thanks!" matches.
    .replace(/^[\s\.\,\!\?\:\;]+|[\s\.\,\!\?\:\;]+$/g, "");

  // Emoji-only acknowledgements → ACK.
  if (/^[\s👍👌🙏✅🙂😊😀😅😂❤️💯🙌]+$/u.test(raw)) return { handled: true, move: "ACK" };

  // THANKS
  if (/^(thanks|thank\s*you|thx|ty|tysm)\s*[!\.\?,]*$/i.test(t)) return { handled: true, move: "THANKS" };

  // ACK
  if (/^(ok|okay|k|kk|got\s*it|sounds\s*good|perfect|cool|alright|great|awesome|nice|bet|word)\s*[!\.\?,]*$/i.test(t)) {
    return { handled: true, move: "ACK" };
  }

  // GREETING
  if (/^(hi|hello|hey|good\s*morning|good\s*afternoon|good\s*evening)\s*[!\.\?,]*$/i.test(t)) {
    return { handled: true, move: "GREETING" };
  }

  // GOODBYE
  if (/^(bye|goodbye|have\s*a\s*good\s*day|talk\s*later|gn|good\s*night)\s*[!\.\?,]*$/i.test(t)) {
    return { handled: true, move: "GOODBYE" };
  }

  // lol/haha/lmao → ACK
  if (/^(lol|haha|lmao)\s*[!\.\?,]*$/i.test(t)) return { handled: true, move: "ACK" };

  return { handled: false };
}

/**
 * Continuation guard for CIG: when intake/workflow is active, do not re-classify inbound
 * as conversational/UNKNOWN — the brain owns stage + slot collection (North Compass).
 * @param {Object} ctx — ConversationContext row object (use canonical-hydrated copy when possible)
 * @param {Object} session — Session snapshot
 * @param {Object|null} draft — Optional { finalized: boolean } if caller tracks draft object
 * @param {string} phone — E.164 for canonical intake lookup
 * @returns {boolean}
 */
function isActiveWorkflow_(ctx, session, draft, phone) {
  ctx = ctx || {};
  session = session || {};
  phone = String(phone || "").trim();

  try {
    if (draft && typeof draft === "object") {
      if (draft.finalized === false || draft.finalized === 0) return true;
    }
  } catch (_) {}

  function pendingCtxAlive_(c) {
    try {
      var pe0 = String((c && c.pendingExpected) || "").trim();
      if (!pe0) return true;
      var exp = c && c.pendingExpiresAt;
      if (exp == null || exp === "") return true;
      var ms = exp instanceof Date ? exp.getTime() : Date.parse(String(exp));
      if (isNaN(ms) || ms <= 0) return true;
      return Date.now() <= ms;
    } catch (_) {
      return true;
    }
  }

  var pe = String(ctx.pendingExpected || "").trim().toUpperCase();
  if (pe && !pendingCtxAlive_(ctx)) pe = "";
  if (pe) return true;

  var wi = String(ctx.activeWorkItemId || ctx.pendingWorkItemId || "").trim();
  if (wi && wi.length >= 4) return true;

  var draftStages = {
    PROPERTY: 1,
    PROPERTY_AND_UNIT: 1,
    UNIT: 1,
    ISSUE: 1,
    DETAIL: 1,
    FINALIZE_DRAFT: 1,
    INTENT_PICK: 1,
    SCHEDULE_DRAFT_MULTI: 1,
    SCHEDULE_PRETICKET: 1,
    SCHEDULE: 1,
    ATTACH_CLARIFY: 1,
    EMERGENCY_DONE: 1
  };

  var sx = String(session.expected || session.stage || "").trim().toUpperCase();
  if (sx && sx !== "DONE" && sx !== "CLOSE" && sx !== "CLOSED" && sx !== "IDLE" && draftStages[sx]) return true;

  if (phone && typeof properaCanonicalIntakeIsActive_ === "function") {
    try {
      if (properaCanonicalIntakeIsActive_(phone)) return true;
    } catch (_) {}
  }

  return false;
}

// Phase 4 — Communication Gate (deterministic routing by turnType)
function properaCommunicationGate_(phone, pkg, ctx, channel) {
  try {
    var turnType = (pkg && pkg.turnType) ? String(pkg.turnType || "").trim().toUpperCase() : "";
    if (!turnType && pkg && pkg.structuredSignal && typeof pkg.structuredSignal === "object") {
      turnType = String(pkg.structuredSignal.turnType || "").trim().toUpperCase();
    }
    if (!turnType) turnType = "UNKNOWN";

    // Slot-fill rescue can set structuredSignal.turnType after top-level UNKNOWN; don't ACK those turns.
    try {
      var sigGate = pkg && pkg.structuredSignal && typeof pkg.structuredSignal === "object" ? pkg.structuredSignal : null;
      var pendingFill = sigGate && String(sigGate.intentType || "").trim().toUpperCase() === "PENDING_SLOT_FILL";
      var sigOp = sigGate && String(sigGate.turnType || "").trim().toUpperCase() === "OPERATIONAL_ONLY";
      if ((turnType === "UNKNOWN" || !turnType) && (pendingFill || sigOp)) {
        turnType = "OPERATIONAL_ONLY";
        try {
          if (sigGate) sigGate.turnType = "OPERATIONAL_ONLY";
        } catch (_) {}
      }
    } catch (_) {}

    var conversationMove = "";
    if (pkg && pkg.structuredSignal && typeof pkg.structuredSignal === "object") {
      conversationMove = String(pkg.structuredSignal.conversationMove || "").trim().toUpperCase();
    } else {
      conversationMove = String(pkg && pkg.conversationMove ? pkg.conversationMove : "").trim().toUpperCase();
    }
    if (!conversationMove) conversationMove = "NONE";

    var lang = String((pkg && pkg.lang) || (ctx && ctx.lang) || "en").toLowerCase();
    if (lang.indexOf("-") > 0) lang = lang.split("-")[0];
    if (!lang || lang.length < 2) lang = "en";

    function emitCoreText_(text, stage) {
      var msg = String(text || "").trim();
      if (!msg) return false;
      var _og = (typeof dispatchOutboundIntent_ === "function")
        ? dispatchOutboundIntent_({
            intentType: "CORE_TEXT_REPLY",
            recipientType: "TENANT",
            recipientRef: phone,
            lang: lang,
            channel: String(channel || "SMS").trim().toUpperCase(),
            deliveryPolicy: "NO_HEADER",
            preRenderedBody: msg,
            vars: {},
            meta: { source: "CIG_GATE", stage: stage || "CIG_GATE", flow: "MAINTENANCE_INTAKE" }
          })
        : { ok: false };
      return !!(_og && _og.ok);
    }

    function emitMoveTemplate_(move) {
      var mt = String(move || "").trim().toUpperCase();
      var intentType = "ACK";
      if (mt === "THANKS" || mt === "ACK" || mt === "GREETING" || mt === "GOODBYE") intentType = mt;
      if (mt === "NONE" || !mt) intentType = "ACK";

      var _og = (typeof dispatchOutboundIntent_ === "function")
        ? dispatchOutboundIntent_({
            intentType: intentType,
            templateKey: intentType,
            recipientType: "TENANT",
            recipientRef: phone,
            lang: lang,
            channel: String(channel || "SMS").trim().toUpperCase(),
            deliveryPolicy: "NO_HEADER",
            vars: {},
            meta: { source: "CIG_GATE", stage: "CIG_NOOP_TEMPLATE", flow: "MAINTENANCE_INTAKE" }
          })
        : { ok: false };
      return !!(_og && _og.ok);
    }

    function extractOperationalPayload_() {
      var stripped = [];
      var issue = pkg && pkg.issue != null ? String(pkg.issue || "").trim() : "";
      if (!issue) return { cleanPkg: pkg, stripped: stripped };

      var PURE_RE = /^(thanks?|thank\s*you|ok(ay)?|hi|hello|hey|lol|haha|got\s*it|sounds?\s*good|perfect|cool|alright|great|awesome|nice|bet|word|alright|appreciate\s*(it|that)?|no\s*problem|np|sure|yep|yeah|ya)\s*[.!]*$/i;
      var PREFIX_RE = /^(thanks?|thank\s*you|ok(ay)?|hi|hello|hey|lol|haha|got\s*it|sounds?\s*good|perfect|cool|alright|great|awesome|nice|bet|word|alright|appreciate\s*(it|that)?|no\s*problem|np|sure|yep|yeah|ya)\s*[,\-:;]*\s*/i;

      if (PURE_RE.test(issue)) {
        stripped.push(issue);
        pkg.issue = "";
        pkg.issueHint = "";
        try { if (pkg.issueMeta) pkg.issueMeta = null; } catch (_) {}
        try { if (pkg.missingSlots) pkg.missingSlots.issueMissing = true; } catch (_) {}
        if (pkg.structuredSignal && Array.isArray(pkg.structuredSignal.issues)) pkg.structuredSignal.issues = [];
      } else {
        var strippedIssue = issue.replace(PREFIX_RE, "");
        if (strippedIssue && strippedIssue.trim() !== issue) {
          stripped.push(issue);
          pkg.issue = String(strippedIssue || "").trim();
          pkg.issueHint = String(pkg.issue || "").trim();
          if (pkg.structuredSignal && Array.isArray(pkg.structuredSignal.issues) && pkg.structuredSignal.issues.length >= 1) {
            try {
              pkg.structuredSignal.issues[0].title = String(pkg.issue || "").trim().slice(0, 280);
              pkg.structuredSignal.issues[0].summary = String(pkg.issue || "").trim().slice(0, 500);
            } catch (_) {}
          }
        }
      }

      var hasOp =
        (pkg && pkg.property && pkg.property.code) ||
        String(pkg && pkg.unit ? pkg.unit : "").trim() ||
        String(pkg && pkg.issue ? pkg.issue : "").trim() ||
        (pkg && pkg.schedule && String(pkg.schedule.raw || "").trim());

      if (!hasOp) {
        try {
          if (pkg.structuredSignal && typeof pkg.structuredSignal === "object") {
            pkg.structuredSignal.turnType = "CONVERSATIONAL_ONLY";
            pkg.structuredSignal.statusQueryType = "NONE";
          }
        } catch (_) {}
      }

      return { cleanPkg: pkg, stripped: stripped };
    }

    try { logDevSms_(phone, "", "CIG_GATE path=[" + turnType + "] move=[" + conversationMove + "] turnType=[" + turnType + "]"); } catch (_) {}

    if (turnType === "CONVERSATIONAL_ONLY") {
      // Phase 7: unified rendering.
      var killRawC = "";
      try {
        var cigPropsC = PropertiesService.getScriptProperties();
        killRawC = String((cigPropsC && typeof cigPropsC.getProperty === "function") ? cigPropsC.getProperty("CIG_CONVERSATIONAL_REPLY_ENABLED") : "").trim().toLowerCase();
      } catch (_) { killRawC = ""; }
      var enabledC = !(killRawC === "0" || killRawC === "false" || killRawC === "off" || killRawC === "no");
      var cand = String((pkg && (pkg.conversationalReply != null ? pkg.conversationalReply : (pkg.structuredSignal && pkg.structuredSignal.conversationalReply))) || "").trim();
      properaRenderReply_(
        {
          replyMode: "ACK_ONLY",
          conversationMove: conversationMove,
          conversationalReply: (enabledC && cand) ? cand : ""
        },
        lang,
        channel,
        phone
      );
      return { handled: true };
    }

    if (turnType === "STATUS_QUERY") {
      var statusResolved = (typeof resolveStatusQuery_ === "function")
        ? resolveStatusQuery_(pkg && pkg.statusQueryType ? pkg.statusQueryType : "NONE", phone, ctx || null, lang)
        : { found: false, facts: { found: false, ticketIds: [], tickets: [], schedule: "" }, replyTemplate: "We couldn't find your current status. Please try again." };
      properaRenderReply_(
        {
          replyMode: "STATUS_SUMMARY",
          preRenderedBody: statusResolved && statusResolved.replyTemplate ? statusResolved.replyTemplate : "",
          canonicalFacts: statusResolved && statusResolved.facts ? statusResolved.facts : { found: false },
          allowedReplyModes: ["STATUS_SUMMARY"]
        },
        lang,
        channel,
        phone
      );
      return { handled: true };
    }

    if (turnType === "MIXED") {
      extractOperationalPayload_();
      var ttAfter = (pkg && pkg.structuredSignal && pkg.structuredSignal.turnType) ? String(pkg.structuredSignal.turnType || "").toUpperCase().trim() : "";
      if (ttAfter === "CONVERSATIONAL_ONLY") {
        var killRawC2 = "";
        try {
          var cigPropsC2 = PropertiesService.getScriptProperties();
          killRawC2 = String((cigPropsC2 && typeof cigPropsC2.getProperty === "function") ? cigPropsC2.getProperty("CIG_CONVERSATIONAL_REPLY_ENABLED") : "").trim().toLowerCase();
        } catch (_) { killRawC2 = ""; }
        var enabledC2 = !(killRawC2 === "0" || killRawC2 === "false" || killRawC2 === "off" || killRawC2 === "no");
        var cand2 = String((pkg && (pkg.conversationalReply != null ? pkg.conversationalReply : (pkg.structuredSignal && pkg.structuredSignal.conversationalReply))) || "").trim();
        properaRenderReply_(
          {
            replyMode: "ACK_ONLY",
            conversationMove: conversationMove,
            conversationalReply: (enabledC2 && cand2) ? cand2 : ""
          },
          lang,
          channel,
          phone
        );
        return { handled: true };
      }
      return { handled: false };
    }

    if (turnType === "OPERATIONAL_ONLY") return { handled: false };

    if (turnType === "UNKNOWN") {
      var raw = String((pkg && pkg.originalText) ? pkg.originalText : pkg && pkg.semanticTextEnglish ? pkg.semanticTextEnglish : "").trim();
      var lower = raw.toLowerCase();
      var isChit = (typeof isPureChitchat_ === "function") ? !!isPureChitchat_(raw) : false;
      var isShort = raw.length < 10;
      var hasScheduleSignal =
        !!(pkg && pkg.schedule && String(pkg.schedule.raw || "").trim()) ||
        !!(pkg && pkg.structuredSignal && pkg.structuredSignal.schedule && String(pkg.structuredSignal.schedule.raw || "").trim());
      var maintenanceKeys = /\b(leak|water|sink|toilet|tub|shower|clog|broken|no heat|heat|heater|hot water|ac|a\/c|air|smoke|fire|alarm|lock|door|key|mold|gas|noise|electric|power|outlet|light)\b/i;

      if (hasScheduleSignal) {
        try { logDevSms_(phone, raw.slice(0, 80), "CIG_GATE path=[UNKNOWN] resolved=[OPERATIONAL] reason=[schedule_signal]"); } catch (_) {}
        return { handled: false };
      }
      if (isChit || isShort) {
        properaRenderReply_(
          { replyMode: "ACK_ONLY", conversationMove: "ACK" },
          lang,
          channel,
          phone
        );
        try { logDevSms_(phone, raw.slice(0, 80), "CIG_GATE path=[UNKNOWN] resolved=[CONVERSATIONAL] reason=[short_no_keywords]"); } catch (_) {}
        return { handled: true };
      }
      if (maintenanceKeys.test(lower)) {
        try { logDevSms_(phone, raw.slice(0, 80), "CIG_GATE path=[UNKNOWN] resolved=[OPERATIONAL] reason=[keyword_match]"); } catch (_) {}
        return { handled: false };
      }

      properaRenderReply_(
        { replyMode: "SAFE_CLARIFY" },
        lang,
        channel,
        phone
      );
      try { logDevSms_(phone, raw.slice(0, 80), "CIG_GATE path=[UNKNOWN] resolved=[SAFE_CLARIFY] reason=[no_signal]"); } catch (_) {}
      return { handled: true };
    }

    return { handled: false };
  } catch (e) {
    try { logDevSms_(phone, "", "CIG_GATE_ERR " + String(e && e.message ? e.message : e)); } catch (_) {}
    return { handled: false };
  }
}
