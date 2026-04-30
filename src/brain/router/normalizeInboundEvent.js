/**
 * @see 15_GATEWAY_WEBHOOK.gs — normalizeInboundEvent_
 */
const crypto = require("crypto");
const { parseMediaJson } = require("../shared/mediaPayload");

/**
 * @param {Record<string, string | undefined>} parameter — RouterParameter
 * @param {object} [extra]
 * @param {object} [extra.meta]
 */
function normalizeInboundEventFromRouterParameter(parameter, extra) {
  const p = parameter || {};
  const body = String(p.Body || "");
  const fromRaw = String(p.From || "").trim();
  const isWa = fromRaw.toLowerCase().indexOf("whatsapp:") === 0;
  const chHint = String(p._channel || "").trim().toUpperCase();
  const isTgActor = /^TG:/i.test(fromRaw) || chHint === "TELEGRAM";
  const isPortal = chHint === "PORTAL";

  let phone = String(p._phoneE164 || "").trim();
  if (!phone) phone = fromRaw;

  /** Transport-side actor string (adapter). Brain uses `canonicalBrainActorKey` when set. */
  const transportActorKey = phone;
  const canonicalBrainActorKey = String(p._canonicalBrainActorKey || "").trim();
  const actorForBrain = canonicalBrainActorKey || phone;

  let channelNorm = "sms";
  if (isPortal) channelNorm = "portal";
  else if (isWa) channelNorm = "whatsapp";
  else if (isTgActor) channelNorm = "telegram";

  const bodyTrim = body.trim();
  const media = parseMediaJson(p._mediaJson);
  const messageSid = String(p.MessageSid || p.SmsMessageSid || "").trim();
  const eventId =
    String(p._telegramUpdateId || "").trim() ||
    messageSid ||
    crypto.randomUUID();

  const meta = Object.assign(
    {
      channel: channelNorm,
      numMedia: String(media.length),
      portal: isPortal ? "1" : "",
      transportActorKey,
      canonicalBrainActorKey: canonicalBrainActorKey || "",
    },
    (extra && extra.meta) || {}
  );

  return {
    v: 1,
    source: channelNorm,
    channel: channelNorm,
    actorType: "unknown",
    /** Brain / lane: canonical identity when resolved at signal layer; else same as transport. */
    canonicalBrainActorKey: canonicalBrainActorKey || "",
    actorId: actorForBrain,
    body,
    bodyTrim,
    bodyLower: bodyTrim.toLowerCase(),
    media,
    eventId,
    timestamp: new Date(),
    meta,
  };
}

module.exports = { normalizeInboundEventFromRouterParameter };
