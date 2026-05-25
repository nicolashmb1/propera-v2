/**
 * Tenant agent → brain append_to_ticket handoff (Phase 4+).
 */
const { extractAttachmentUrlsFromMediaJson } = require("./extractAttachmentUrls");

/**
 * @param {object} o
 * @param {string} o.ticketKey
 * @param {string} o.tenantActorKey
 * @param {string} o.message
 * @param {string} [o.mediaJson]
 * @param {'sms'|'whatsapp'|'telegram'} o.transportChannel
 * @param {string} o.conversationId
 * @param {string} o.traceId
 * @returns {Record<string, string>}
 */
function buildAppendHandoffRouterParameter(o) {
  const ticketKey = String(o.ticketKey || "").trim();
  const message = String(o.message || "").trim();
  const mediaJson = String(o.mediaJson || "");
  const attachmentUrls = extractAttachmentUrlsFromMediaJson(mediaJson);
  const transport = String(o.transportChannel || "sms").toLowerCase();
  const channelUpper =
    transport === "telegram"
      ? "TELEGRAM"
      : transport === "whatsapp"
        ? "WHATSAPP"
        : "SMS";

  const payload = {
    operation: "append_to_ticket",
    channel: "tenant_agent",
    actor_type: "TENANT",
    ticket_key: ticketKey,
    message: message || (attachmentUrls.length ? "Tenant sent a photo." : ""),
    attachmentUrls,
  };

  const tenantActorKey = String(o.tenantActorKey || "").trim();

  return {
    From: tenantActorKey,
    Body: "noop",
    _phoneE164: tenantActorKey,
    _canonicalBrainActorKey: tenantActorKey,
    _channel: channelUpper,
    _mediaJson: mediaJson,
    _portalAction: "append_to_ticket",
    _portalChannel: "tenant_agent",
    _portalActorType: "TENANT",
    _portalPayloadJson: JSON.stringify(payload),
    _tenantAgentConversationId: String(o.conversationId || "").trim(),
    _tenantAgentHandoffTraceId: String(o.traceId || "").trim(),
  };
}

module.exports = { buildAppendHandoffRouterParameter };
