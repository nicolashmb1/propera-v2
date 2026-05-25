/**
 * Tenant agent → brain find_related_ticket handoff (Phase 6).
 */
const { resolveHandoffCategory } = require("./resolveHandoffCategory");

/**
 * @param {object} o
 * @param {string} o.tenantActorKey
 * @param {object} [o.partialPackage]
 * @param {string} [o.bodyText]
 * @param {'sms'|'whatsapp'|'telegram'} o.transportChannel
 * @param {string} o.conversationId
 * @param {string} o.traceId
 * @returns {Record<string, string>}
 */
function buildFindRelatedRouterParameter(o) {
  const partial = o.partialPackage && typeof o.partialPackage === "object" ? o.partialPackage : {};
  const bodyText = String(o.bodyText || "").trim();
  const issueText = String(partial.issue || bodyText || "").trim();
  const transport = String(o.transportChannel || "sms").toLowerCase();
  const channelUpper =
    transport === "telegram"
      ? "TELEGRAM"
      : transport === "whatsapp"
        ? "WHATSAPP"
        : "SMS";

  const payload = {
    operation: "find_related_ticket",
    channel: "tenant_agent",
    actor_type: "TENANT",
    actor: {
      type: "TENANT",
      phone_e164: String(o.tenantActorKey || "").trim(),
    },
    hints: {
      issueText,
      categoryHint: resolveHandoffCategory(partial) || undefined,
      unitHint: String(partial.unit || "").trim() || undefined,
      property_code: String(partial.property || "").trim().toUpperCase() || undefined,
    },
  };

  const tenantActorKey = String(o.tenantActorKey || "").trim();

  return {
    From: tenantActorKey,
    Body: "noop",
    _phoneE164: tenantActorKey,
    _canonicalBrainActorKey: tenantActorKey,
    _channel: channelUpper,
    _mediaJson: "",
    _portalAction: "find_related_ticket",
    _portalChannel: "tenant_agent",
    _portalActorType: "TENANT",
    _portalPayloadJson: JSON.stringify(payload),
    _tenantAgentConversationId: String(o.conversationId || "").trim(),
    _tenantAgentHandoffTraceId: String(o.traceId || "").trim(),
  };
}

module.exports = { buildFindRelatedRouterParameter };
