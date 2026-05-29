const { getSupabase } = require("../db/supabase");
const { buildOutboundIntent } = require("../outgate/outboundIntent");
const { renderOutboundIntent } = require("../outgate/renderOutboundIntent");
const { renderForChannel } = require("../outgate/renderForChannel");
const { dispatchOutbound } = require("../outgate/dispatchOutbound");
const { getAccessMessageSpec, buildAccessMessageText } = require("../outgate/accessMessageSpecs");
const { appendEventLog } = require("../dal/appendEventLog");
const { telegramOutboundEnabled, properaTimezone } = require("../config/env");
const { getTelegramChatIdForPhoneE164 } = require("../dal/telegramChatLinkLookup");
const {
  isFirstTenantOutboundToday,
  markTenantOutboundToday,
} = require("../dal/tenantOutboundDayMark");
const { CHANNEL_TELEGRAM } = require("../signal/inboundSignal");

async function resolvePropertyDisplayName(sb, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!sb || !code) return code;
  const { data } = await sb
    .from("properties")
    .select("display_name_short, display_name")
    .eq("code", code)
    .maybeSingle();
  return (
    String(data?.display_name_short || "").trim() ||
    String(data?.display_name || "").trim() ||
    code
  );
}

async function resolveAccessTransport(sb, phoneE164, preferredChannel) {
  const phone = String(phoneE164 || "").trim();
  const preferred = String(preferredChannel || "").trim().toLowerCase();
  if (!phone) return null;

  const chatId = await getTelegramChatIdForPhoneE164(sb, phone);
  if (preferred === "telegram" && chatId && telegramOutboundEnabled()) {
    return {
      transportChannel: "telegram",
      telegramSignal: {
        channel: CHANNEL_TELEGRAM,
        transport: { chat_id: chatId },
        body: {},
      },
    };
  }

  if (preferred === "whatsapp") {
    return { transportChannel: "whatsapp", twilioTo: phone };
  }

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

  return { transportChannel: "sms", twilioTo: phone };
}

async function dispatchAccessNotification(o) {
  const sb = o.sb || getSupabase();
  const templateKey = String(o.templateKey || "").trim();
  const recipientPhoneE164 = String(o.recipientPhoneE164 || "").trim();
  const audience = String(o.audience || "tenant").trim().toLowerCase();
  if (!sb || !templateKey || !recipientPhoneE164) {
    return { ok: false, skipped: true, error: "missing_access_notification_fields" };
  }

  const spec = getAccessMessageSpec(templateKey);
  if (!spec) return { ok: false, skipped: true, error: "unknown_access_template" };

  const bodyText = buildAccessMessageText(templateKey, {
    ...o.context,
    timeZone: o.context?.timeZone || properaTimezone(),
  });
  if (!bodyText) return { ok: false, skipped: true, error: "empty_access_body" };

  const transport = await resolveAccessTransport(sb, recipientPhoneE164, o.preferredChannel);
  if (!transport) {
    await appendEventLog({
      traceId: String(o.traceId || "").trim(),
      log_kind: "access_outgate",
      event: "ACCESS_OUTBOUND_SKIP",
      payload: {
        template_key: templateKey,
        reason: "no_transport",
        recipient_phone_e164: recipientPhoneE164,
      },
    });
    return { ok: false, skipped: true, error: "no_transport" };
  }

  const intent = buildOutboundIntent({
    intentType: templateKey,
    audience: audience === "staff" ? "staff" : "tenant",
    replyText: bodyText,
    traceId: String(o.traceId || "").trim(),
    correlationIds: {
      reservation_id: String(o.reservationId || "").trim(),
    },
  });
  const rendered = renderOutboundIntent({ intent, messageSpec: spec });

  const tenantActorKey = String(o.tenantActorKey || recipientPhoneE164).trim();
  const includeFirstContactExtras =
    audience === "tenant" && tenantActorKey ? await isFirstTenantOutboundToday(tenantActorKey) : false;
  const propertyDisplayName =
    audience === "tenant" ? await resolvePropertyDisplayName(sb, o.context?.propertyCode) : "";

  const channelRender = renderForChannel({
    transportChannel: transport.transportChannel,
    body: rendered.body,
    audience,
    includeFirstContactExtras,
    propertyDisplayName,
    contextLabel: "access",
  });

  const out = await dispatchOutbound({
    traceId: String(o.traceId || "").trim(),
    transportChannel: transport.transportChannel,
    body: channelRender.body,
    telegramSignal: transport.telegramSignal || null,
    twilioTo: transport.twilioTo || "",
    telegramParseMode: channelRender.parseMode,
    dispatchMeta: {
      intentType: templateKey,
      access: true,
      reservationId: String(o.reservationId || "").trim(),
      outgate: {
        ...(rendered.meta || {}),
        ...(channelRender.meta || {}),
      },
    },
  });

  if (
    out.ok &&
    includeFirstContactExtras &&
    audience === "tenant" &&
    tenantActorKey &&
    (channelRender.meta?.propertyHeader || channelRender.meta?.smsComplianceFooter)
  ) {
    await markTenantOutboundToday(tenantActorKey);
  }

  return out;
}

module.exports = {
  dispatchAccessNotification,
  resolveAccessTransport,
  resolvePropertyDisplayName,
};
