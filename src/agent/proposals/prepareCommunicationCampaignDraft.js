/**
 * Shared Jarvis → Communication Engine draft builder (create + compose + preview).
 */
const { communicationEngineEnabled, communicationOrgId, jarvisCommDefaultDeliveryMode } = require("../../config/env");
const {
  createCampaign,
  updateCampaignDraft,
  resolveCampaignAudiencePreview,
  previewCampaignMessage,
} = require("../../communication/campaignService");
const { inferCommTypeFromBrief } = require("./inferCommTypeFromBrief");

/**
 * @param {string} brief
 * @param {string} [titleOverride]
 */
function buildCampaignTitle(brief, titleOverride) {
  const title = String(titleOverride || "").trim();
  if (title) return title.slice(0, 120);
  const b = String(brief || "").trim();
  if (!b) return "Tenant notice";
  const first = b.split(/[.!?\n]/)[0].trim();
  if (first.length <= 80) return first;
  return `${first.slice(0, 77).trim()}…`;
}

/**
 * @param {object} opts
 * @param {string} opts.brief
 * @param {string} opts.audienceKind
 * @param {object} opts.audienceFilter
 * @param {string} [opts.commType]
 * @param {string} [opts.title]
 * @param {string} [opts.traceId]
 * @param {string} [opts.createdBy]
 */
async function prepareCommunicationCampaignDraft(opts) {
  if (!communicationEngineEnabled()) {
    return {
      ok: false,
      error: "communication_engine_disabled",
      message:
        "Communication Engine is not enabled. Set PROPERA_COMMUNICATION_ENGINE_ENABLED=1 on propera-v2.",
    };
  }

  const brief = String(opts?.brief || "").trim();
  if (brief.length < 5) {
    return {
      ok: false,
      error: "missing_brief",
      message: "Need a message brief — what should tenants be told?",
    };
  }

  const audienceKind = String(opts?.audienceKind || opts?.audience_kind || "PROPERTY").trim();
  const rawFilter =
    opts?.audienceFilter && typeof opts.audienceFilter === "object" ? opts.audienceFilter : {};
  const deliveryMode = String(
    rawFilter.delivery_mode || opts?.deliveryMode || opts?.delivery_mode || jarvisCommDefaultDeliveryMode()
  )
    .trim()
    .toLowerCase();
  const audienceFilter = {
    ...rawFilter,
    delivery_mode:
      deliveryMode === "portal_only" || deliveryMode === "sms_and_portal"
        ? deliveryMode
        : "sms_only",
    include_tenant_portal:
      deliveryMode === "portal_only" || deliveryMode === "sms_and_portal",
  };
  const commType = inferCommTypeFromBrief(brief, opts?.commType || opts?.comm_type);
  const title = buildCampaignTitle(brief, opts?.title);
  const traceId = String(opts?.traceId || "").trim();
  const createdBy = String(opts?.createdBy || opts?.created_by || "JARVIS").trim() || "JARVIS";

  const created = await createCampaign(
    {
      title,
      commType,
      audienceKind,
      audienceFilter,
      agentInitiated: true,
      aiAssisted: true,
      createdBy,
      orgId: communicationOrgId(),
    },
    { traceId }
  );
  if (!created.ok || !created.campaign?.id) {
    return {
      ok: false,
      error: created.error || "campaign_create_failed",
      message: "Could not create the broadcast draft.",
    };
  }

  const campaignId = String(created.campaign.id).trim();

  const drafted = await updateCampaignDraft(
    { campaignId, brief, aiAssisted: true },
    { traceId }
  );
  if (!drafted.ok) {
    return {
      ok: false,
      error: drafted.error || "draft_failed",
      message: "Could not compose the tenant message.",
      campaignId,
    };
  }

  const audiencePreview = await resolveCampaignAudiencePreview(campaignId, { traceId });
  if (!audiencePreview.ok) {
    return {
      ok: false,
      error: audiencePreview.error || "audience_preview_failed",
      message: "Could not preview the recipient list.",
      campaignId,
    };
  }

  const preview = audiencePreview.preview || {};
  if (!preview.willSend) {
    return {
      ok: false,
      error: "no_sendable_recipients",
      message:
        "No tenants would receive this message (all opted out, missing phones, or no matches). Adjust the audience or roster.",
      campaignId,
      preview,
    };
  }

  const messagePreview = await previewCampaignMessage(campaignId, {
    messageBody: drafted.campaign?.messageBody || drafted.draft?.body || "",
  });
  if (!messagePreview.ok) {
    return {
      ok: false,
      error: messagePreview.error || "message_preview_failed",
      message: "Could not build the final SMS preview.",
      campaignId,
    };
  }

  const pm = messagePreview.previewMessage || {};
  const messageBody = String(pm.baseBody || drafted.draft?.body || "").trim();
  const audienceLabel = String(preview.audienceLabel || drafted.draft?.audienceLabel || "").trim();

  const summaryParts = [
    `Send tenant broadcast — ${audienceLabel || audienceKind}`,
    `${preview.willSend} recipient${preview.willSend === 1 ? "" : "s"}`,
  ];
  if (preview.skippedOptOut) summaryParts.push(`${preview.skippedOptOut} opted out`);
  if (preview.skippedNoPhone) summaryParts.push(`${preview.skippedNoPhone} no phone`);

  return {
    ok: true,
    campaignId,
    title,
    commType,
    brief,
    audienceKind,
    audienceFilter,
    messageBody,
    audienceLabel,
    willSend: preview.willSend,
    skippedNoPhone: preview.skippedNoPhone || 0,
    skippedOptOut: preview.skippedOptOut || 0,
    finalMessagePreview: String(pm.body || "").trim(),
    smsSegments: Number(pm.smsEstimate?.segments || pm.smsEstimate || 1) || 1,
    recipientsSample: (preview.recipientsSample || []).slice(0, 5),
    summary: summaryParts.join(" · "),
  };
}

module.exports = {
  buildCampaignTitle,
  prepareCommunicationCampaignDraft,
};
