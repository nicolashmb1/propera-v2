/**
 * Lifecycle → `dispatchOutbound` (tenant/staff) with Telegram-first when chat linked.
 */
const { dispatchOutbound } = require("./dispatchOutbound");
const { renderOutboundIntent } = require("./renderOutboundIntent");
const { buildOutboundIntent } = require("./outboundIntent");
const { getLifecycleMessageSpec } = require("./lifecycleMessageSpecs");
const { CHANNEL_TELEGRAM } = require("../signal/inboundSignal");
const { telegramOutboundEnabled } = require("../config/env");
const { getTelegramChatIdForPhoneE164 } = require("../dal/telegramChatLinkLookup");
const { appendEventLog } = require("../dal/appendEventLog");

/**
 * @param {string} phoneE164
 */
function looksLikeSmsE164(phoneE164) {
  return /^\+[1-9]\d{6,14}$/.test(String(phoneE164 || "").trim());
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} phoneE164
 * @returns {Promise<{ transportChannel: 'telegram'|'sms', telegramSignal?: object, twilioTo?: string } | null>}
 */
async function resolveTransportForPhoneE164(sb, phoneE164) {
  const phone = String(phoneE164 || "").trim();
  if (!phone) return null;

  const chatId = await getTelegramChatIdForPhoneE164(sb, phone);
  if (chatId && telegramOutboundEnabled()) {
    return {
      transportChannel: "telegram",
      telegramSignal: {
        channel: CHANNEL_TELEGRAM,
        transport: { chat_id: chatId },
        body: {},
      },
    };
  }

  if (looksLikeSmsE164(phone)) {
    return {
      transportChannel: "sms",
      twilioTo: phone,
    };
  }

  return null;
}

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.traceId
 * @param {string} o.templateKey — lifecycle template (see lifecycleMessageSpecs)
 * @param {string} o.recipientPhoneE164 — tenant or staff E.164
 * @param {string} [o.replyTextOverride] — optional; else MessageSpec fallback
 * @param {Record<string, string>} [o.correlationIds]
 */
async function dispatchLifecycleOutbound(o) {
  const sb = o.sb;
  const traceId = String(o.traceId || "").trim();
  const templateKey = String(o.templateKey || "").trim();
  const recipient = String(o.recipientPhoneE164 || "").trim();

  const spec = getLifecycleMessageSpec(templateKey);
  const replyText =
    o.replyTextOverride != null && String(o.replyTextOverride).trim()
      ? String(o.replyTextOverride).trim()
      : spec
        ? String(spec.fallbackText || "").trim()
        : "";

  if (!sb || !recipient || !replyText) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "LIFECYCLE_OUTBOUND_SKIP",
      payload: {
        reason: !recipient ? "no_recipient" : "empty_body",
        template_key: templateKey,
      },
    });
    return { ok: false, skipped: true, error: "no_recipient_or_body" };
  }

  const transport = await resolveTransportForPhoneE164(sb, recipient);
  if (!transport) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "LIFECYCLE_OUTBOUND_SKIP",
      payload: {
        reason: "no_transport",
        template_key: templateKey,
        recipient_phone_e164: recipient,
      },
    });
    return { ok: false, skipped: true, error: "no_transport" };
  }

  const audience =
    templateKey.startsWith("STAFF_") || templateKey.startsWith("STAFF")
      ? "staff"
      : templateKey.startsWith("TENANT_")
        ? "tenant"
        : "unknown";

  const intent = buildOutboundIntent({
    intentType: templateKey,
    audience,
    replyText,
    traceId,
    correlationIds: o.correlationIds || {},
  });

  const rendered = renderOutboundIntent({
    intent,
    messageSpec: spec || null,
  });

  const out = await dispatchOutbound({
    traceId,
    transportChannel: transport.transportChannel,
    body: rendered.body,
    telegramSignal: transport.telegramSignal || null,
    twilioTo: transport.twilioTo || "",
    dispatchMeta: {
      intentType: templateKey,
      lifecycle: true,
      outgate: rendered.meta,
    },
  });

  return out;
}

module.exports = {
  dispatchLifecycleOutbound,
  resolveTransportForPhoneE164,
  looksLikeSmsE164,
};
