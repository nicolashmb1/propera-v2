const {
  postCreateAskOptionalSchedule,
  postCreateNone,
} = require("../../contracts/postCreateContract");
const { MIN_SCHEDULE_LEN } = require("../../dal/ticketPreferredWindow");
const { normalizePhoneE164 } = require("../../utils/phone");
const { resolveHandoffCategory } = require("./resolveHandoffCategory");
const { isCommonAreaGatherPartial } = require("./resolveGatherLocation");
const { getGatherSafety } = require("./detectGatherSafety");

/**
 * @param {object} o
 * @param {object} o.partialPackage
 * @param {string} o.tenantActorKey
 * @param {'sms'|'whatsapp'|'telegram'} o.transportChannel
 * @param {string} o.conversationId
 * @param {string} o.traceId
 * @param {string} [o.mediaJson]
 * @param {Record<string, string>} [o.inboundRouterParameter]
 * @returns {Record<string, string>}
 */
function buildHandoffRouterParameterFromAgent(o) {
  const pkg = o.partialPackage || {};
  const inbound = o.inboundRouterParameter || {};
  const property = String(pkg.property || pkg.property_code || "")
    .trim()
    .toUpperCase();
  const issue = String(pkg.issue || pkg.message || "").trim();
  const locationKind = String(pkg.location_kind || "unit").trim().toLowerCase();
  const commonArea = isCommonAreaGatherPartial(pkg) || locationKind === "common_area";
  const unit = String(pkg.unit || pkg.unit_label || "").trim();
  const reportSourceUnit = String(
    pkg.report_source_unit || pkg.reportSourceUnit || ""
  ).trim();
  const category =
    String(pkg.category || "").trim() ||
    (getGatherSafety(pkg) ? "Safety" : resolveHandoffCategory(pkg));
  const safety = getGatherSafety(pkg);
  const preferredWindow =
    commonArea || safety?.skipScheduling
      ? ""
      : String(pkg.preferredWindow || "").trim();
  const transport = String(o.transportChannel || "sms").toLowerCase();
  const channelUpper =
    transport === "telegram"
      ? "TELEGRAM"
      : transport === "whatsapp"
        ? "WHATSAPP"
        : "SMS";

  const payload = {
    action: "create_ticket",
    channel: "tenant_agent",
    actor_type: "TENANT",
    property,
    property_code: property,
    unit: commonArea ? "" : locationKind === "unit" ? unit : "",
    unit_label: commonArea ? "" : locationKind === "unit" ? unit : "",
    location_kind: commonArea ? "common_area" : locationKind,
    message: issue,
    description: issue,
    category,
    preferredWindow,
    tenant_locale: String(pkg.tenant_locale || "en").trim() || "en",
    conversation_id: String(o.conversationId || "").trim(),
    postCreate:
      commonArea || safety?.skipScheduling || preferredWindow.length >= MIN_SCHEDULE_LEN
        ? postCreateNone()
        : postCreateAskOptionalSchedule(),
  };

  if (safety && safety.isEmergency) {
    payload.emergency = "Yes";
    payload.emergency_type = String(safety.emergencyType || "SAFETY").trim();
    payload.urgency = "URGENT";
    payload.category = payload.category || "Safety";
    payload.preferredWindow = "";
  }

  if (commonArea) {
    payload.location_label_snapshot = String(
      pkg.location_label_snapshot || pkg.location_label || ""
    ).trim();
    if (reportSourceUnit) payload.report_source_unit = reportSourceUnit;
  }

  const canonical = String(
    inbound._canonicalBrainActorKey || o.tenantActorKey || inbound.From || ""
  ).trim();
  const linkedPhone = String(inbound._phoneE164 || "").trim();
  const phoneE164 =
    linkedPhone && normalizePhoneE164(linkedPhone)
      ? normalizePhoneE164(linkedPhone)
      : /^TG:/i.test(canonical)
        ? ""
        : normalizePhoneE164(canonical) || "";

  const rp = {
    From: canonical || String(inbound.From || "").trim(),
    Body: "noop",
    _phoneE164: phoneE164,
    _canonicalBrainActorKey: canonical,
    _channel: channelUpper,
    _mediaJson: String(o.mediaJson || inbound._mediaJson || ""),
    _portalAction: "create_ticket",
    _portalChannel: "tenant_agent",
    _portalActorType: "TENANT",
    _portalPayloadJson: JSON.stringify(payload),
    _tenantAgentConversationId: String(o.conversationId || "").trim(),
    _tenantAgentHandoffTraceId: String(o.traceId || "").trim(),
  };

  if (inbound._telegramChatId) rp._telegramChatId = String(inbound._telegramChatId).trim();
  if (inbound._telegramUpdateId) rp._telegramUpdateId = String(inbound._telegramUpdateId).trim();
  if (inbound._telegramUserId) rp._telegramUserId = String(inbound._telegramUserId).trim();

  return rp;
}

module.exports = {
  buildHandoffRouterParameterFromAgent,
};
