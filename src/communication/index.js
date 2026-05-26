const { registerCommunicationRoutes } = require("./registerCommunicationRoutes");
const { getBrandContext, getAudienceLabel } = require("./brandContextService");
const {
  normalizeAudienceKind,
  normalizeAudienceFilter,
  buildAudiencePreview,
  resolveAudience,
  getAudiencePreview,
} = require("./audienceResolver");
const {
  createCampaign,
  listCampaigns,
  getCampaignDetail,
  updateCampaignDraft,
  resolveCampaignAudiencePreview,
  previewCampaignMessage,
  prepareCampaign,
  sendCampaignNow,
} = require("./campaignService");
const { draftMessage, appendFooter, fallbackDraftMessage, estimateSmsSegments } = require("./messageComposer");
const { sendCampaign } = require("./commOutgate");
const { classifyReply, buildAutoResponse, handleBroadcastReply } = require("./replyHandler");
const {
  mapTwilioRecipientStatus,
  shouldReplaceRecipientStatus,
  recomputeCampaignDeliveryTotals,
  handleDeliveryCallback,
} = require("./deliveryTracker");

module.exports = {
  registerCommunicationRoutes,
  getBrandContext,
  getAudienceLabel,
  normalizeAudienceKind,
  normalizeAudienceFilter,
  buildAudiencePreview,
  resolveAudience,
  getAudiencePreview,
  createCampaign,
  listCampaigns,
  getCampaignDetail,
  updateCampaignDraft,
  resolveCampaignAudiencePreview,
  previewCampaignMessage,
  prepareCampaign,
  sendCampaignNow,
  draftMessage,
  appendFooter,
  fallbackDraftMessage,
  estimateSmsSegments,
  sendCampaign,
  classifyReply,
  buildAutoResponse,
  handleBroadcastReply,
  mapTwilioRecipientStatus,
  shouldReplaceRecipientStatus,
  recomputeCampaignDeliveryTotals,
  handleDeliveryCallback,
};
