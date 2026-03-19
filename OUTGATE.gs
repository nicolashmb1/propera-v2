/**
 * OUTGATE.gs — Propera Phase 3A Outbound Intent Layer (V1)
 * Layer 2: Brain produces outbound intents; core logic must not call sendSms_/sendWhatsApp_/sendRouterSms_ directly for migrated paths.
 * All outbound for migrated paths goes through dispatchOutboundIntent_().
 * Contract broad; implementation narrow. No second messaging stack. Templates remain the renderer for V1.
 * Phase 0: intent–template map; templateKey optional when intentType is in OG_INTENT_TEMPLATE_MAP_; templateSource logging (explicit | semantic_map | dynamic_logic).
 * Phase 7: preRenderedBody (legacy bridge only) — allowlisted intent types only; still require intentType, recipientType, recipientRef.
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
  "SHOW_HELP": "HELP_INTRO",
  "SHOW_OPTIONS": "INTENT_PICK",
  "DUPLICATE_REQUEST_ACK": "DUPLICATE_REQUEST_ACK",
  "CLEANING_WORKITEM_ACK": "CLEANING_WORKITEM_ACK",
  "VISIT_CONFIRM": "VISIT_CONFIRM_MULTI",
  "STAFF_CLARIFICATION": "STAFF_CLARIFICATION",
  "STAFF_UPDATE_ACK": "STAFF_UPDATE_ACK",
  "STAFF_SCHEDULE_ACK": "STAFF_SCHEDULE_ACK",
  "REQUEST_UNSCHEDULED_UPDATE": "STAFF_UNSCHEDULED_REMINDER"
};

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
var OG_PRE_RENDERED_ALLOWLIST_ = [];

function ogPreRenderedAllowlisted_(intentType) {
  if (!intentType || typeof OG_PRE_RENDERED_ALLOWLIST_ !== "object") return false;
  return OG_PRE_RENDERED_ALLOWLIST_.indexOf(String(intentType).trim()) >= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH — Single entry for outbound intents (migrated paths)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate intent, resolve recipient, resolve language, render message, deliver via sendRouterSms_.
 * Fails safely; never throws uncontrolled into production flows.
 * V1 intent: intentType, templateKey (optional when intentType in semantic map), recipientType, recipientRef, vars?, channel?, deliveryPolicy?, lang?, meta?
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
  // Channel: intent.channel only (must be explicit). Used for both render and delivery. TELEGRAM preserved for reply-via-Telegram.
  var channel = String(intent.channel || "").trim().toUpperCase();
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
 * When channel is TELEGRAM, TENANT uses telegramChatId (from intent or global __telegramChatId) for delivery; phoneE164 kept for logging.
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
    // Telegram: use telegramChatId for delivery; set by adapter via globalThis.__telegramChatId or intent.telegramChatId
    if (ch === "TELEGRAM") {
      var telegramChatId = (intent.telegramChatId != null && String(intent.telegramChatId).trim()) ? String(intent.telegramChatId).trim()
        : (typeof globalThis !== "undefined" && globalThis.__telegramChatId) ? String(globalThis.__telegramChatId).trim() : "";
      if (!telegramChatId) return { ok: false, error: "telegramChatId missing for TELEGRAM channel" };
      var ctx = typeof ctxGet_ === "function" ? ctxGet_(ref) : null;
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
    if (!contact) return { ok: false, error: "staff contact not found" };
    var staffPhone = (contact.phoneE164 && String(contact.phoneE164).trim()) ? String(contact.phoneE164).trim() : "";
    if (!staffPhone) return { ok: false, error: "staff phone empty" };
    var staffLang = (contact.lang && String(contact.lang).trim()) ? String(contact.lang).trim().toLowerCase() : "en";
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
  // Phase 6: TICKET_CREATED_ASK_SCHEDULE with legacy-bridge vars — Outgate owns composition from bounded vars (no preRenderedBody from brain)
  if (intentType === "TICKET_CREATED_ASK_SCHEDULE") {
    if (vars.summaryText != null && String(vars.summaryText).trim() !== "") return String(vars.summaryText).trim();
    if (vars.managerIntro != null && String(vars.managerIntro).trim() !== "") return String(vars.managerIntro).trim();
  }
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
 * Deliver rendered message. Channel: intent.channel → request global → default SMS.
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
  sendRouterSms_(recipient.phoneE164, message, tag || "OUTGATE", ch);
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
