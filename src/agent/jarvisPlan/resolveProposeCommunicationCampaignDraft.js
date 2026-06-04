/**
 * Resolve portal typed broadcast → Communication Engine draft + proposal.
 */

const { jarvisCommPortfolioEnabled } = require("../../config/env");
const { readPortalPageContext } = require("../contextEnvelope");
const { compileOperationalScope } = require("../operationalScope/compileOperationalScope");
const { resolveCommunicationAudience } = require("../proposals/resolveCommunicationAudience");
const { prepareCommunicationCampaignDraft } = require("../proposals/prepareCommunicationCampaignDraft");
const {
  buildSendCommunicationCampaignProposal,
} = require("../proposals/sendCommunicationCampaign");

/**
 * @param {object} parsed — from parseProposeCommunicationCampaign
 * @param {object} opts
 * @param {string} opts.traceId
 * @param {Record<string, string | undefined>} opts.routerParameter
 * @param {string} opts.staffActorKey
 * @param {string} [opts.staffId]
 */
async function resolveProposeCommunicationCampaignDraft(parsed, opts) {
  const p = parsed || {};
  if (String(p.audienceScope || "").trim().toLowerCase() === "portfolio" && !jarvisCommPortfolioEnabled()) {
    return {
      ok: false,
      message:
        "Portfolio-wide broadcasts are disabled. Name a property, floor, unit, or tenant — e.g. all tenants at Penn.",
    };
  }

  const routerParameter = opts?.routerParameter || {};
  const pageContext = readPortalPageContext(routerParameter);

  const scope = await compileOperationalScope({
    routerParameter,
    actorRole: "staff",
    staffId: String(opts?.staffId || "").trim(),
    actorKey: String(opts?.staffActorKey || "").trim(),
    transportChannel: "portal",
  });

  const audienceOut = await resolveCommunicationAudience({
    audienceScope: p.audienceScope,
    propertyHint: p.propertyHint,
    floor: p.floor,
    unitLabel: p.unitLabel,
    tenantName: p.tenantName,
    scope,
    pageContext,
    traceId: opts?.traceId,
  });
  if (!audienceOut.ok) {
    return {
      ok: false,
      message: audienceOut.message || "Could not resolve the message audience.",
    };
  }

  const prepared = await prepareCommunicationCampaignDraft({
    brief: p.brief,
    audienceKind: audienceOut.audienceKind,
    audienceFilter: audienceOut.audienceFilter,
    traceId: opts?.traceId,
    createdBy: "JARVIS_PORTAL",
  });
  if (!prepared.ok) {
    return {
      ok: false,
      message: prepared.message || "Could not prepare the tenant broadcast.",
      campaignId: prepared.campaignId,
    };
  }

  const draftPayload = {
    ...prepared,
    propertyCode: audienceOut.propertyCode || "",
    unitLabel: audienceOut.unitLabel || p.unitLabel || "",
    tenantName: audienceOut.tenantName || p.tenantName || "",
  };

  const built = buildSendCommunicationCampaignProposal(draftPayload, prepared.summary);
  return {
    ok: true,
    summary: prepared.summary,
    confirmToken: built.confirmToken,
    proposal: built.proposal,
    scopeSnapshot: scope,
    speakHint:
      `${prepared.willSend} tenants at ${prepared.audienceLabel}. ` +
      `${String(prepared.messageBody || "").slice(0, 100)}…`,
  };
}

module.exports = { resolveProposeCommunicationCampaignDraft };
